export interface MarkdownFootnote {
  id: string;
  index: number;
  content: string;
  plainText: string;
  lineIndex: number;
  endLineIndex: number;
  refLineIndices: number[];
  epubAnnotationId?: string;
}

export interface MarkdownFootnoteSyntaxZoneDef {
  id: string;
  index: number;
  startLine: number;
  endLine: number;
  markerLength: number;
}

export interface MarkdownFootnoteSyntaxZoneRef {
  id: string;
  lineIndex: number;
  fromCol: number;
  toCol: number;
}

export interface MarkdownFootnoteSyntaxZones {
  definitions: MarkdownFootnoteSyntaxZoneDef[];
  references: MarkdownFootnoteSyntaxZoneRef[];
}

export interface ParsedMarkdownFootnotes {
  footnotes: MarkdownFootnote[];
  bodyWithoutDefinitions: string;
}

const DEF_START_RE = /^ {0,3}\[\^([^\s\]\\]+)\]:[ \t]*(.*)$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CONTINUATION_INDENT_RE = /^(?: {4}|\t)(.*)$/;
const EPUB_ANNOTATION_MARKER_RE = /<!--\s*epub:([A-Za-z0-9_-]+)\s*-->/i;

function isSeparatorFenceClose(
  line: string,
  fence: { marker: string; length: number },
): boolean {
  const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return Boolean(
    closing &&
      closing[1][0] === fence.marker &&
      closing[1].length >= fence.length,
  );
}

function skipYamlFrontmatter(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  const end = lines.findIndex(
    (line, idx) => idx > 0 && (line.trim() === '---' || line.trim() === '...'),
  );
  return end > 0 ? end + 1 : 0;
}

export function stripMarkdownToPlainText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^>\s*/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function maskInlineCodeAndEscapes(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\\' && i + 1 < line.length) {
      out += '  ';
      i += 2;
      continue;
    }
    if (line[i] === '`') {
      let tickLen = 1;
      while (i + tickLen < line.length && line[i + tickLen] === '`') {
        tickLen += 1;
      }
      const closer = '`'.repeat(tickLen);
      const closeIdx = line.indexOf(closer, i + tickLen);
      if (closeIdx !== -1) {
        const spanLen = closeIdx + tickLen - i;
        out += ' '.repeat(spanLen);
        i = closeIdx + tickLen;
        continue;
      }
    }
    out += line[i];
    i += 1;
  }
  return out;
}

interface InlineFootnoteRefMatch {
  id: string;
  fromCol: number;
  toCol: number;
}

function extractBodyFootnoteRefMatches(line: string): InlineFootnoteRefMatch[] {
  const masked = maskInlineCodeAndEscapes(line);
  const matches: InlineFootnoteRefMatch[] = [];
  const re = /\[\^([^\s\]\\]+)\](?!:)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked)) !== null) {
    matches.push({
      id: match[1],
      fromCol: match.index,
      toCol: match.index + match[0].length,
    });
  }
  return matches;
}

function consumeFootnoteDefBlock(
  lines: readonly string[],
  defStartLine: number,
  firstLineRemainder: string,
): {
  endLineIndex: number;
  chunks: string[];
} {
  const chunks: string[] = [];
  if (firstLineRemainder.trim()) {
    chunks.push(firstLineRemainder);
  }
  let endLineIndex = defStartLine;
  let cursor = defStartLine + 1;
  let defFence: { marker: string; length: number } | null = null;

  while (cursor < lines.length) {
    const nextLine = lines[cursor];
    const indentMatch = nextLine.match(CONTINUATION_INDENT_RE);

    if (indentMatch) {
      const inner = indentMatch[1];
      if (defFence) {
        if (isSeparatorFenceClose(inner, defFence)) defFence = null;
      } else {
        const innerOpen = inner.match(FENCE_OPEN_RE);
        if (
          innerOpen &&
          !(innerOpen[1][0] === '`' && innerOpen[2].includes('`'))
        ) {
          defFence = {
            marker: innerOpen[1][0],
            length: innerOpen[1].length,
          };
        }
      }
      chunks.push(inner);
      endLineIndex = cursor;
      cursor += 1;
      continue;
    }

    if (!nextLine.trim()) {
      // Only consume blank lines that bridge two indented continuation blocks
      let lookahead = cursor + 1;
      while (lookahead < lines.length && !lines[lookahead].trim()) {
        lookahead += 1;
      }
      if (
        lookahead < lines.length &&
        CONTINUATION_INDENT_RE.test(lines[lookahead])
      ) {
        chunks.push('');
        cursor = lookahead;
        continue;
      }
    }

    break;
  }

  return { endLineIndex, chunks };
}

interface ScannedFootnoteDocument {
  rawDefs: Array<{
    id: string;
    content: string;
    lineIndex: number;
    endLineIndex: number;
    markerLength: number;
    epubAnnotationId?: string;
  }>;
  defsById: Map<
    string,
    {
      id: string;
      content: string;
      lineIndex: number;
      endLineIndex: number;
      markerLength: number;
      epubAnnotationId?: string;
    }
  >;
  defLineSet: Set<number>;
  allBodyRefs: Array<{
    id: string;
    lineIndex: number;
    fromCol: number;
    toCol: number;
  }>;
  refOrder: string[];
  refLinesById: Map<string, number[]>;
  keptLines: string[];
}

function scanMarkdownFootnoteDocument(
  markdown: string,
): ScannedFootnoteDocument {
  const lines = markdown.split(/\r?\n/);
  const startLine = skipYamlFrontmatter(lines);
  const defLineSet = new Set<number>();

  const rawDefs: ScannedFootnoteDocument['rawDefs'] = [];
  const defsById: ScannedFootnoteDocument['defsById'] = new Map();

  let fence: { marker: string; length: number } | null = null;
  let inComment = false;

  for (let i = startLine; i < lines.length; i += 1) {
    const line = lines[i];

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (fence) {
      if (isSeparatorFenceClose(line, fence)) fence = null;
      continue;
    }

    const opening = line.match(FENCE_OPEN_RE);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }

    if (line.trimStart().startsWith('<!--') && !line.includes('-->')) {
      inComment = true;
      continue;
    }

    const defMatch = line.match(DEF_START_RE);
    if (!defMatch) continue;

    const id = defMatch[1];
    const defStartLine = i;
    const { endLineIndex, chunks } = consumeFootnoteDefBlock(
      lines,
      defStartLine,
      defMatch[2],
    );
    for (let consumed = defStartLine; consumed <= endLineIndex; consumed += 1) {
      defLineSet.add(consumed);
    }

    i = endLineIndex;
    const rawContent = chunks.join('\n').trim();
    const epubMatch = rawContent.match(EPUB_ANNOTATION_MARKER_RE);
    const cleanContent = rawContent
      .replace(EPUB_ANNOTATION_MARKER_RE, '')
      .trim();
    const markerClose = line.indexOf(']:');
    const markerLength = markerClose >= 0 ? markerClose + 2 : line.length;

    if (!defsById.has(id)) {
      const record = {
        id,
        content: cleanContent,
        lineIndex: defStartLine,
        endLineIndex,
        markerLength,
        ...(epubMatch ? { epubAnnotationId: epubMatch[1] } : {}),
      };
      rawDefs.push(record);
      defsById.set(id, record);
    }
  }

  const allBodyRefs: ScannedFootnoteDocument['allBodyRefs'] = [];
  const refOrder: string[] = [];
  const refLinesById = new Map<string, number[]>();
  const keptLines: string[] = [];

  fence = null;
  inComment = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (defLineSet.has(i)) continue;
    const line = lines[i];
    keptLines.push(line);

    if (i < startLine) continue;

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (fence) {
      if (isSeparatorFenceClose(line, fence)) fence = null;
      continue;
    }

    const opening = line.match(FENCE_OPEN_RE);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }

    if (line.trimStart().startsWith('<!--') && !line.includes('-->')) {
      inComment = true;
      continue;
    }

    for (const ref of extractBodyFootnoteRefMatches(line)) {
      if (!defsById.has(ref.id)) continue;
      allBodyRefs.push({
        id: ref.id,
        lineIndex: i,
        fromCol: ref.fromCol,
        toCol: ref.toCol,
      });
      if (!refLinesById.has(ref.id)) {
        refOrder.push(ref.id);
        refLinesById.set(ref.id, []);
      }
      refLinesById.get(ref.id)!.push(i);
    }
  }

  return {
    rawDefs,
    defsById,
    defLineSet,
    allBodyRefs,
    refOrder,
    refLinesById,
    keptLines,
  };
}

export function parseMarkdownFootnotes(
  markdown: string,
): ParsedMarkdownFootnotes {
  if (!markdown) {
    return { footnotes: [], bodyWithoutDefinitions: '' };
  }

  const scanned = scanMarkdownFootnoteDocument(markdown);
  if (scanned.rawDefs.length === 0) {
    return { footnotes: [], bodyWithoutDefinitions: markdown };
  }

  // Order footnotes by first appearance in body, then unreferenced definitions
  const orderedIds: string[] = [...scanned.refOrder];
  for (const def of scanned.rawDefs) {
    if (!scanned.refLinesById.has(def.id)) orderedIds.push(def.id);
  }

  const footnotes: MarkdownFootnote[] = orderedIds.map((id, idx) => {
    const def = scanned.defsById.get(id)!;
    return {
      id,
      index: idx + 1,
      content: def.content,
      plainText: stripMarkdownToPlainText(def.content),
      lineIndex: def.lineIndex,
      endLineIndex: def.endLineIndex,
      refLineIndices: scanned.refLinesById.get(id) ?? [],
      ...(def.epubAnnotationId
        ? { epubAnnotationId: def.epubAnnotationId }
        : {}),
    };
  });

  // Trim excess trailing blank lines created when stripping EOF definitions
  let bodyWithoutDefinitions = scanned.keptLines
    .join('\n')
    .replace(/\n{3,}$/g, '\n\n');
  if (
    scanned.keptLines.length > 0 &&
    scanned.keptLines.every((l) => !l.trim())
  ) {
    bodyWithoutDefinitions = '';
  }

  return { footnotes, bodyWithoutDefinitions };
}

/** Extracts source line ranges and inline token spans for highlighting footnote zones in CodeMirror. */
export function extractMarkdownFootnoteSyntaxZones(
  markdown: string,
): MarkdownFootnoteSyntaxZones {
  if (!markdown) {
    return { definitions: [], references: [] };
  }
  const scanned = scanMarkdownFootnoteDocument(markdown);
  if (scanned.rawDefs.length === 0) {
    return { definitions: [], references: [] };
  }
  const orderedIds: string[] = [...scanned.refOrder];
  for (const def of scanned.rawDefs) {
    if (!scanned.refLinesById.has(def.id)) orderedIds.push(def.id);
  }
  const indexById = new Map<string, number>(
    orderedIds.map((id, idx) => [id, idx + 1]),
  );

  return {
    definitions: scanned.rawDefs.map((def) => ({
      id: def.id,
      index: indexById.get(def.id) ?? 0,
      startLine: def.lineIndex,
      endLine: def.endLineIndex,
      markerLength: def.markerLength,
    })),
    references: scanned.allBodyRefs,
  };
}

export function footnoteAnchorSlug(id: string): string {
  return Array.from(id)
    .map((ch) =>
      /^[A-Za-z0-9_-]$/.test(ch)
        ? ch
        : `_${ch.codePointAt(0)?.toString(16) ?? 'x'}`,
    )
    .join('');
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildFootnotesSectionHtml(
  footnotes: readonly MarkdownFootnote[],
  renderDefinitionHtml: (markdown: string) => string,
  refCountsById?: ReadonlyMap<string, number>,
): string {
  if (footnotes.length === 0) return '';

  const items = footnotes
    .map((fn) => {
      const slug = footnoteAnchorSlug(fn.id);
      const rendered = fn.content.trim()
        ? renderDefinitionHtml(fn.content)
        : '<p><em>（暂无脚注内容）</em></p>';
      const count = refCountsById?.get(fn.id) ?? 0;
      const backrefs =
        count > 0
          ? Array.from({ length: count }, (_, idx) => {
              const occ = idx + 1;
              const targetId = `seamind-fnref-${slug}-${occ}`;
              const label = count > 1 ? `↩${occ}` : '↩';
              return `<a class="seamind-fn-backref" href="#${targetId}" data-footnote-backref="${escapeHtmlAttr(fn.id)}" data-footnote-ref-target="${targetId}" title="返回正文引用位置">${label}</a>`;
            }).join(' ')
          : '';

      return [
        `<li id="seamind-fn-${slug}" class="seamind-fn-item" data-footnote-def-id="${escapeHtmlAttr(fn.id)}" data-footnote-index="${fn.index}">`,
        `<div class="seamind-fn-body">${rendered}</div>`,
        backrefs ? `<div class="seamind-fn-backrefs">${backrefs}</div>` : '',
        '</li>',
      ].join('');
    })
    .join('');

  return [
    '<section class="seamind-footnotes" data-seamind-footnotes="true" aria-label="脚注列表">',
    '<hr class="seamind-footnotes-sep" />',
    `<div class="seamind-footnotes-header"><span>脚注</span><small>${footnotes.length}</small></div>`,
    `<ol class="seamind-footnotes-list">${items}</ol>`,
    '</section>',
  ].join('');
}

export function enhanceMarkdownFootnotesHtml(
  sanitizedBodyHtml: string,
  footnotes: readonly MarkdownFootnote[],
  renderDefinitionHtml: (markdown: string) => string,
): string {
  if (footnotes.length === 0) return sanitizedBodyHtml;

  const byId = new Map<string, MarkdownFootnote>();
  for (const fn of footnotes) {
    byId.set(fn.id, fn);
  }

  const refCounts = new Map<string, number>();

  if (typeof DOMParser === 'undefined') {
    const section = buildFootnotesSectionHtml(footnotes, renderDefinitionHtml);
    return `${sanitizedBodyHtml}${section}`;
  }

  const parsed = new DOMParser().parseFromString(
    sanitizedBodyHtml,
    'text/html',
  );
  const doc = parsed;
  const root = parsed.body;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest(
        'pre, code, a, button, script, style, svg, .katex, .seamind-footnotes',
      )
    ) {
      continue;
    }
    if ((node.nodeValue ?? '').includes('[^')) {
      textNodes.push(node as Text);
    }
  }

  const refPattern = /\[\^([^\s\]\\]+)\]/g;
  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? '';
    let lastIndex = 0;
    let matched = false;
    const fragment = doc.createDocumentFragment();
    refPattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = refPattern.exec(value)) !== null) {
      const id = match[1];
      const fn = byId.get(id);
      if (!fn) continue;
      if (match.index > 0 && value[match.index - 1] === '\\') continue;

      if (match.index > lastIndex) {
        fragment.append(
          doc.createTextNode(value.slice(lastIndex, match.index)),
        );
      }

      const occ = (refCounts.get(id) ?? 0) + 1;
      refCounts.set(id, occ);

      const slug = footnoteAnchorSlug(id);
      const sup = doc.createElement('sup');
      sup.className = 'seamind-fn-ref';
      sup.setAttribute('data-footnote-ref', id);

      const anchor = doc.createElement('a');
      anchor.href = `#seamind-fn-${slug}`;
      anchor.id = `seamind-fnref-${slug}-${occ}`;
      anchor.setAttribute('data-footnote-id', id);
      anchor.setAttribute('data-footnote-index', String(fn.index));
      const preview = fn.plainText || fn.content || `脚注 [${fn.index}]`;
      anchor.setAttribute('data-footnote-preview', preview.slice(0, 320));
      anchor.textContent = String(fn.index);

      sup.append(anchor);
      fragment.append(sup);
      lastIndex = match.index + match[0].length;
      matched = true;
    }

    if (!matched) continue;
    if (lastIndex < value.length) {
      fragment.append(doc.createTextNode(value.slice(lastIndex)));
    }
    textNode.replaceWith(fragment);
  }

  const sectionHtml = buildFootnotesSectionHtml(
    footnotes,
    renderDefinitionHtml,
    refCounts,
  );
  return `${root.innerHTML}${sectionHtml}`;
}

export function nextAvailableFootnoteId(markdown: string, prefix = ''): string {
  const used = new Set<string>();
  const { footnotes } = parseMarkdownFootnotes(markdown);
  for (const fn of footnotes) {
    used.add(fn.id);
  }
  const refRe = /\[\^([^\s\]\\]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = refRe.exec(markdown)) !== null) {
    used.add(match[1]);
  }

  if (!prefix) {
    let maxNum = 0;
    for (const id of used) {
      if (/^\d+$/.test(id)) {
        const n = Number(id);
        if (n > maxNum) maxNum = n;
      }
    }
    let next = maxNum + 1;
    while (used.has(String(next))) next += 1;
    return String(next);
  }

  let index = 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

/** Formats arbitrary multi-paragraph Markdown into a valid 4-space indented footnote definition block. */
export function formatFootnoteDefinitionBlock(
  id: string,
  bodyMarkdown: string,
  epubAnnotationId?: string,
): string {
  const normalized = bodyMarkdown.replace(/\r\n?/g, '\n');
  const rawLines = normalized.split('\n');
  let start = 0;
  while (start < rawLines.length && !rawLines[start].trim()) start += 1;
  let end = rawLines.length - 1;
  while (end >= start && !rawLines[end].trim()) end -= 1;

  const lines = start <= end ? rawLines.slice(start, end + 1) : [];
  const epubTag = epubAnnotationId ? `<!-- epub:${epubAnnotationId} -->` : '';

  if (lines.length === 0) {
    return epubTag ? `[^${id}]: ${epubTag}` : `[^${id}]: `;
  }

  const first = lines[0];
  const startsWithFence = /^ {0,3}(`{3,}|~{3,})/.test(first);
  const outLines: string[] = [];

  if (startsWithFence) {
    outLines.push(epubTag ? `[^${id}]: ${epubTag}` : `[^${id}]:`);
    for (const line of lines) {
      outLines.push(line.trim() ? `    ${line}` : '');
    }
  } else {
    const firstText = first.trimStart();
    outLines.push(
      epubTag ? `[^${id}]: ${epubTag} ${firstText}` : `[^${id}]: ${firstText}`,
    );
    for (let idx = 1; idx < lines.length; idx += 1) {
      const line = lines[idx];
      outLines.push(line.trim() ? `    ${line}` : '');
    }
  }

  return outLines.join('\n');
}

function appendDefinitionBlockToMarkdown(
  markdown: string,
  defBlock: string,
): { nextSource: string; prefixLength: number } {
  const trimmedTail = markdown.replace(/\s+$/, '');
  const lastLine = trimmedTail.split(/\r?\n/).pop() ?? '';
  const tailIsFootnoteDef =
    DEF_START_RE.test(lastLine) || CONTINUATION_INDENT_RE.test(lastLine);
  const sep = !trimmedTail ? '' : tailIsFootnoteDef ? '\n' : '\n\n';
  const prefix = `${trimmedTail}${sep}`;
  return {
    nextSource: `${prefix}${defBlock}\n`,
    prefixLength: prefix.length,
  };
}

export function insertFootnoteIntoMarkdown(
  markdown: string,
  selection: { from: number; to: number },
  initialContent = '',
): {
  nextSource: string;
  id: string;
  defLineIndex: number;
  defCursorOffset: number;
} {
  const id = nextAvailableFootnoteId(markdown);
  const anchorPos = Math.max(0, Math.min(selection.to, markdown.length));
  const refToken = `[^${id}]`;

  const withRef =
    markdown.slice(0, anchorPos) + refToken + markdown.slice(anchorPos);
  const defBlock = formatFootnoteDefinitionBlock(id, initialContent);
  const { nextSource, prefixLength } = appendDefinitionBlockToMarkdown(
    withRef,
    defBlock,
  );

  const prefix = nextSource.slice(0, prefixLength);
  const defLineIndex = prefix ? prefix.split('\n').length - 1 : 0;
  const defCursorOffset = prefixLength + defBlock.length;

  return {
    nextSource,
    id,
    defLineIndex,
    defCursorOffset,
  };
}

export function upsertFootnoteInMarkdown(
  markdown: string,
  options: {
    mode: 'create' | 'edit';
    id?: string;
    selection?: { from: number; to: number };
    content: string;
  },
): {
  nextSource: string;
  id: string;
  lineIndex: number;
  cursorOffsetAfterRef?: number;
} {
  if (options.mode === 'create') {
    const id = nextAvailableFootnoteId(markdown);
    const anchorPos = Math.max(
      0,
      Math.min(options.selection?.to ?? markdown.length, markdown.length),
    );
    const refToken = `[^${id}]`;
    const withRef =
      markdown.slice(0, anchorPos) + refToken + markdown.slice(anchorPos);
    const defBlock = formatFootnoteDefinitionBlock(id, options.content);
    const { nextSource, prefixLength } = appendDefinitionBlockToMarkdown(
      withRef,
      defBlock,
    );
    const parsed = parseMarkdownFootnotes(nextSource);
    const created = parsed.footnotes.find((fn) => fn.id === id);
    const lineIndex =
      created?.lineIndex ??
      Math.max(0, nextSource.slice(0, prefixLength).split('\n').length - 1);
    return {
      nextSource,
      id,
      lineIndex,
      cursorOffsetAfterRef: anchorPos + refToken.length,
    };
  }

  const targetId = options.id?.trim() ?? '';
  if (!targetId) {
    return { nextSource: markdown, id: '', lineIndex: 0 };
  }

  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const scanned = scanMarkdownFootnoteDocument(markdown);
  const existing = scanned.defsById.get(targetId);

  if (!existing) {
    const defBlock = formatFootnoteDefinitionBlock(targetId, options.content);
    const { nextSource, prefixLength } = appendDefinitionBlockToMarkdown(
      markdown,
      defBlock,
    );
    const normalized =
      eol === '\r\n' ? nextSource.replace(/\n/g, '\r\n') : nextSource;
    const lineIndex = Math.max(
      0,
      nextSource.slice(0, prefixLength).split('\n').length - 1,
    );
    return { nextSource: normalized, id: targetId, lineIndex };
  }

  const lines = markdown.split(/\r?\n/);
  const replacementLines = formatFootnoteDefinitionBlock(
    targetId,
    options.content,
    existing.epubAnnotationId,
  ).split('\n');
  const updatedLines = [
    ...lines.slice(0, existing.lineIndex),
    ...replacementLines,
    ...lines.slice(existing.endLineIndex + 1),
  ];
  return {
    nextSource: updatedLines.join(eol),
    id: targetId,
    lineIndex: existing.lineIndex,
  };
}

export interface AppendEpubFootnoteInput {
  annotationId: string;
  quote: string;
  note?: string;
  aiAnalysis?: string;
  chapterLabel?: string;
}

export function appendEpubFootnoteToMarkdown(
  markdown: string,
  input: AppendEpubFootnoteInput,
): {
  nextSource: string;
  footnoteId: string;
  lineIndex: number;
  isUpdate: boolean;
} {
  const parts: string[] = [`<!-- epub:${input.annotationId} -->`];
  const chapter = input.chapterLabel?.trim();
  const cleanNote = input.note?.trim();
  const cleanAi = input.aiAnalysis?.trim();
  if (chapter) {
    parts.push(`**${chapter}**`);
  }
  if (cleanNote) {
    parts.push(cleanNote.replace(/\r?\n+/g, ' '));
  }
  if (cleanAi) {
    const aiInline = cleanAi.replace(/\r?\n+/g, ' ');
    parts.push(cleanNote ? `AI 解析：${aiInline}` : aiInline);
  }
  if (!cleanNote && !cleanAi) {
    parts.push('书内标注脚注');
  }
  const definitionBody = parts.join(' · ');

  const { footnotes } = parseMarkdownFootnotes(markdown);
  const existing = footnotes.find(
    (fn) => fn.epubAnnotationId === input.annotationId,
  );

  if (existing) {
    const lines = markdown.split(/\r?\n/);
    const endLine = existing.endLineIndex + 1;
    const replacement = `[^${existing.id}]: ${definitionBody}`;
    const updatedLines = [
      ...lines.slice(0, existing.lineIndex),
      replacement,
      ...lines.slice(endLine),
    ];
    return {
      nextSource: updatedLines.join('\n'),
      footnoteId: existing.id,
      lineIndex: existing.lineIndex,
      isUpdate: true,
    };
  }

  const footnoteId = nextAvailableFootnoteId(markdown, 'epub-');
  const cleanQuote = input.quote.replace(/\s+/g, ' ').trim().slice(0, 180);
  const excerptLine = `> “${cleanQuote || '书内选区'}”[^${footnoteId}]`;
  const defLine = `[^${footnoteId}]: ${definitionBody}`;

  const lines = markdown.split(/\r?\n/);
  let trailingDefStart = -1;
  if (footnotes.length > 0) {
    const defStarts = new Set(footnotes.map((fn) => fn.lineIndex));
    let scan = lines.length - 1;
    while (scan >= 0 && !lines[scan].trim()) scan -= 1;
    let blockStart = -1;
    while (scan >= 0) {
      if (defStarts.has(scan)) {
        blockStart = scan;
        scan -= 1;
        while (scan >= 0 && !lines[scan].trim()) scan -= 1;
        continue;
      }
      if (CONTINUATION_INDENT_RE.test(lines[scan])) {
        scan -= 1;
        continue;
      }
      break;
    }
    if (blockStart >= 0) trailingDefStart = blockStart;
  }

  let bodyPart: string;
  let existingDefsPart = '';

  if (trailingDefStart >= 0) {
    bodyPart = lines.slice(0, trailingDefStart).join('\n').replace(/\s+$/, '');
    existingDefsPart = lines
      .slice(trailingDefStart)
      .join('\n')
      .replace(/\s+$/, '');
  } else {
    bodyPart = markdown.replace(/\s+$/, '');
  }

  if (/^##\s+书内脚注摘录\s*$/m.test(bodyPart)) {
    bodyPart = `${bodyPart}\n\n${excerptLine}`;
  } else {
    const sep = bodyPart ? '\n\n' : '';
    bodyPart = `${bodyPart}${sep}## 书内脚注摘录\n\n${excerptLine}`;
  }

  const allDefs = existingDefsPart
    ? `${existingDefsPart}\n${defLine}`
    : defLine;
  const prefix = `${bodyPart}\n\n`;
  const nextSource = `${prefix}${allDefs}\n`;
  const parsedAfter = parseMarkdownFootnotes(nextSource);
  const inserted = parsedAfter.footnotes.find((fn) => fn.id === footnoteId);

  return {
    nextSource,
    footnoteId,
    lineIndex:
      inserted?.lineIndex ?? Math.max(0, nextSource.split('\n').length - 2),
    isUpdate: false,
  };
}

function stripInlineFootnoteRefFromLine(
  line: string,
  targetId: string,
): { line: string; count: number } {
  const token = `[^${targetId}]`;
  let out = '';
  let i = 0;
  let count = 0;

  while (i < line.length) {
    if (line[i] === '\\' && i + 1 < line.length) {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (line[i] === '`') {
      let tickLen = 1;
      while (i + tickLen < line.length && line[i + tickLen] === '`') {
        tickLen += 1;
      }
      const closer = '`'.repeat(tickLen);
      const closeIdx = line.indexOf(closer, i + tickLen);
      if (closeIdx !== -1) {
        out += line.slice(i, closeIdx + tickLen);
        i = closeIdx + tickLen;
        continue;
      }
    }
    if (line.startsWith(token, i) && line[i + token.length] !== ':') {
      i += token.length;
      count += 1;
      if (out.endsWith(' ') && line[i] === ' ') {
        i += 1;
      } else if (
        out.endsWith(' ') &&
        i >= line.length &&
        out.trimEnd().length > 0
      ) {
        out = out.slice(0, -1);
      }
      continue;
    }
    out += line[i];
    i += 1;
  }

  return { line: out, count };
}

export function removeFootnoteFromMarkdown(
  markdown: string,
  footnoteId: string,
): {
  nextSource: string;
  removed: boolean;
} {
  if (!markdown || !footnoteId) {
    return { nextSource: markdown, removed: false };
  }

  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = /\r?\n$/.test(markdown);
  const lines = markdown.split(/\r?\n/);
  const startLine = skipYamlFrontmatter(lines);
  const removedDefLines = new Set<number>();

  let fence: { marker: string; length: number } | null = null;
  let inComment = false;

  for (let i = startLine; i < lines.length; i += 1) {
    const line = lines[i];

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (fence) {
      if (isSeparatorFenceClose(line, fence)) fence = null;
      continue;
    }

    const opening = line.match(FENCE_OPEN_RE);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { marker: opening[1][0], length: opening[1].length };
      continue;
    }

    if (line.trimStart().startsWith('<!--') && !line.includes('-->')) {
      inComment = true;
      continue;
    }

    const defMatch = line.match(DEF_START_RE);
    if (!defMatch || defMatch[1] !== footnoteId) continue;

    const { endLineIndex } = consumeFootnoteDefBlock(lines, i, defMatch[2]);
    for (let consumed = i; consumed <= endLineIndex; consumed += 1) {
      removedDefLines.add(consumed);
    }
    i = endLineIndex;
  }

  const outLines: string[] = [];
  let removedRefCount = 0;
  let sawRemovedDefSinceLastContent = false;
  fence = null;
  inComment = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (removedDefLines.has(i)) {
      sawRemovedDefSinceLastContent = true;
      continue;
    }

    const line = lines[i];
    let nextLine = line;

    if (i >= startLine) {
      if (inComment) {
        if (line.includes('-->')) inComment = false;
      } else if (fence) {
        if (isSeparatorFenceClose(line, fence)) fence = null;
      } else {
        const opening = line.match(FENCE_OPEN_RE);
        if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
          fence = { marker: opening[1][0], length: opening[1].length };
        } else if (
          line.trimStart().startsWith('<!--') &&
          !line.includes('-->')
        ) {
          inComment = true;
        } else {
          const stripped = stripInlineFootnoteRefFromLine(line, footnoteId);
          nextLine = stripped.line;
          removedRefCount += stripped.count;
        }
      }
    }

    if (sawRemovedDefSinceLastContent) {
      if (!nextLine.trim()) {
        if (outLines.length === 0 || !outLines[outLines.length - 1].trim()) {
          continue;
        }
      } else {
        sawRemovedDefSinceLastContent = false;
      }
    }

    outLines.push(nextLine);
  }

  const removed = removedDefLines.size > 0 || removedRefCount > 0;
  if (!removed) {
    return { nextSource: markdown, removed: false };
  }

  if (sawRemovedDefSinceLastContent) {
    while (outLines.length > 0 && !outLines[outLines.length - 1].trim()) {
      outLines.pop();
    }
    if (hadTrailingNewline && outLines.length > 0) {
      outLines.push('');
    }
  }

  return {
    nextSource: outLines.join(eol),
    removed: true,
  };
}

export type FootnoteRectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type FootnotePopoverGeometry = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

/** Computes bounded popover coordinates so full footnote content stays scrollable inside the preview frame without covering the citation badge. */
export function computeFootnotePopoverGeometry(
  frameRect: FootnoteRectLike,
  contentRect: FootnoteRectLike,
  anchorRect: FootnoteRectLike,
): FootnotePopoverGeometry {
  const safeContentWidth = Math.max(180, contentRect.width);
  const cardWidth = Math.min(380, Math.max(220, safeContentWidth - 24));
  const minLeft = Math.max(10, contentRect.left - frameRect.left + 8);
  const maxLeft = Math.max(
    minLeft,
    contentRect.right - frameRect.left - cardWidth - 12,
  );
  const left = Math.round(
    Math.max(
      minLeft,
      Math.min(maxLeft, anchorRect.left - frameRect.left - cardWidth / 3),
    ),
  );

  const gap = 6;
  const padding = 10;
  const spaceBelow = Math.floor(
    frameRect.bottom - anchorRect.bottom - gap - padding,
  );
  const spaceAbove = Math.floor(anchorRect.top - frameRect.top - gap - padding);
  const preferBelow = spaceBelow >= 180 || spaceBelow >= spaceAbove;

  if (preferBelow) {
    return {
      left,
      width: Math.round(cardWidth),
      top: Math.max(8, Math.round(anchorRect.bottom - frameRect.top + gap)),
      maxHeight: Math.max(140, Math.min(360, spaceBelow)),
    };
  }

  return {
    left,
    width: Math.round(cardWidth),
    bottom: Math.max(8, Math.round(frameRect.bottom - anchorRect.top + gap)),
    maxHeight: Math.max(140, Math.min(360, spaceAbove)),
  };
}

interface FootnoteCursorLocation {
  def: MarkdownFootnoteSyntaxZoneDef;
  lineIndex: number;
  lineStart: number;
  lineEnd: number;
  lineText: string;
  col: number;
}

function locateCursorInsideFootnoteZone(
  docText: string,
  offset: number,
): FootnoteCursorLocation | null {
  if (!docText) return null;
  const clamped = Math.max(0, Math.min(offset, docText.length));
  const zones = extractMarkdownFootnoteSyntaxZones(docText);
  if (zones.definitions.length === 0) return null;

  let lineIndex = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (docText[i] === '\n') {
      lineIndex += 1;
      lineStart = i + 1;
    }
  }
  const nextNl = docText.indexOf('\n', lineStart);
  let lineEnd = nextNl < 0 ? docText.length : nextNl;
  if (lineEnd > lineStart && docText[lineEnd - 1] === '\r') {
    lineEnd -= 1;
  }
  const lineText = docText.slice(lineStart, lineEnd);
  const col = Math.max(0, Math.min(clamped - lineStart, lineText.length));

  const def = zones.definitions.find(
    (item) => lineIndex >= item.startLine && lineIndex <= item.endLine,
  );
  if (!def) return null;
  if (lineIndex === def.startLine && col < def.markerLength) {
    return null;
  }

  return { def, lineIndex, lineStart, lineEnd, lineText, col };
}

/** Auto-indents multi-line pasted text when the cursor is inside a footnote definition block so paragraphs never leak into body text. */
export function formatTextForFootnotePaste(
  docText: string,
  selectionFrom: number,
  selectionTo: number,
  pastedText: string,
): { text: string; insideFootnote: boolean } {
  const loc = locateCursorInsideFootnoteZone(docText, selectionFrom);
  if (!loc) {
    return { text: pastedText, insideFootnote: false };
  }
  // If selection crosses outside the footnote block onto later lines, keep default paste.
  if (selectionTo > loc.lineEnd) {
    const endLoc = locateCursorInsideFootnoteZone(docText, selectionTo);
    if (!endLoc || endLoc.def.id !== loc.def.id) {
      return { text: pastedText, insideFootnote: false };
    }
  }

  const normalized = pastedText.replace(/\r\n?/g, '\n');
  const pasteLines = normalized.split('\n');
  const beforeCursor = loc.lineText.slice(0, loc.col);
  const needFirstLineIndent =
    loc.lineIndex > loc.def.startLine && beforeCursor.length === 0;

  const formattedLines = pasteLines.map((line, idx) => {
    if (idx === 0) {
      if (
        needFirstLineIndent &&
        line.trim() &&
        !CONTINUATION_INDENT_RE.test(line)
      ) {
        return `    ${line}`;
      }
      return line;
    }
    return line.trim() ? `    ${line}` : '';
  });

  return {
    text: formattedLines.join('\n'),
    insideFootnote: true,
  };
}

/** Keeps Enter inside a footnote definition block indented by 4 spaces, and exits cleanly when Enter is pressed on an empty continuation line. */
export function computeFootnoteEnterContinuation(
  docText: string,
  cursorPos: number,
): { from: number; to: number; insert: string; cursorOffset: number } | null {
  const loc = locateCursorInsideFootnoteZone(docText, cursorPos);
  if (!loc) return null;

  if (
    loc.lineIndex > loc.def.startLine &&
    /^(?: {4}|\t)[ \t]*$/.test(loc.lineText)
  ) {
    return {
      from: loc.lineStart,
      to: loc.lineEnd,
      insert: '\n',
      cursorOffset: loc.lineStart + 1,
    };
  }

  return {
    from: cursorPos,
    to: cursorPos,
    insert: '\n    ',
    cursorOffset: cursorPos + 5,
  };
}

/** Extracts a compact one-line body snippet around the footnote insertion offset for the composer header. */
export function extractFootnoteAnchorContext(
  markdown: string,
  offset: number,
): string {
  const clamped = Math.max(0, Math.min(offset, markdown.length));
  const lineStart = markdown.lastIndexOf('\n', Math.max(0, clamped - 1)) + 1;
  const lineEndRaw = markdown.indexOf('\n', clamped);
  const lineEnd = lineEndRaw < 0 ? markdown.length : lineEndRaw;
  const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, '').trim();
  if (!line) return '';
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}
