import { parseDocument } from 'yaml';
import type { PureNode } from 'markmap-lib';

export const MAX_MARKDOWN_NODE_NOTE_CHARS = 8_000;
export const MAX_AGENT_BRANCH_CHARS = 40_000;

export interface MarkdownNodeSource {
  kind: 'heading' | 'list' | 'block';
  id?: string;
  epubHref?: string;
  lineIndex: number;
  endLineIndex: number;
  prefix: string;
  level?: number;
  indent?: string;
  marker?: string;
  hasCheckbox?: boolean;
  label: string;
}

export type MindmapNodeOperation =
  | 'rename'
  | 'add_child'
  | 'add_sibling'
  | 'delete'
  | 'set_note';

export interface MarkdownCommandResult {
  markdown: string;
  lineIndex: number;
  nodeId?: string;
}

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;
const nodeIdInlinePattern = /<!--\s*seamind:id=([\w-]{1,128})\s*-->\s*$/;
const nodeIdLinePattern = /^\s*<!--\s*seamind:id=([\w-]{1,128})\s*-->\s*$/;
const nodeIdAnywherePattern = /<!--\s*seamind:id=[\w-]{1,128}\s*-->/g;
const epubHrefInlinePattern =
  /<!--\s*seamind:epub-href=([A-Za-z0-9%._~-]{1,4096})\s*-->/;
const epubHrefAnywherePattern =
  /<!--\s*seamind:epub-href=[A-Za-z0-9%._~-]{1,4096}\s*-->/g;

function frontmatterMatch(markdown: string): RegExpExecArray | null {
  return frontmatterPattern.exec(markdown);
}

export function markdownBody(markdown: string): string {
  const match = frontmatterMatch(markdown);
  if (!match) return markdown;
  return markdown.slice(match[0].length);
}

export function markdownForMindmap(markdown: string): string {
  const match = frontmatterMatch(markdown);
  if (!match) return maskNodeIdMarkers(markdown);
  const endIndex = match[0].length;
  return `${markdown.slice(0, endIndex)}${maskNodeIdMarkers(markdown.slice(endIndex))}`;
}

function maskNodeIdMarkers(markdown: string): string {
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  let fenced = '';
  const masked = lines.map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenced) {
      if (
        fence &&
        fence[1][0] === fenced[0] &&
        fence[1].length >= fenced.length
      )
        fenced = '';
      return line;
    }
    if (fence) {
      fenced = fence[1];
      return line;
    }
    if (nodeIdLinePattern.test(line)) return ' '.repeat(line.length);
    if (/^\s{0,3}#{1,6}\s/.test(line) || /^\s*(?:[-+*]|\d+[.)])\s/.test(line)) {
      return line
        .replace(nodeIdAnywherePattern, (marker) => ' '.repeat(marker.length))
        .replace(epubHrefAnywherePattern, (marker) =>
          ' '.repeat(marker.length),
        );
    }
    return line;
  });
  return masked.join(newline);
}

export function normalizeMindmapText(value: string): string {
  const decoded = document.createElement('textarea');
  decoded.innerHTML = value;
  return decoded.value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/[\\`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nodeIdAtLine(lines: string[], lineIndex: number): string | undefined {
  const inlineId = lines[lineIndex]?.match(nodeIdInlinePattern)?.[1];
  if (inlineId) return inlineId;
  return lines[lineIndex - 1]?.match(nodeIdLinePattern)?.[1];
}

export function parseMarkdownNodeSource(
  line: string,
  lineIndex: number,
  endLineIndex = lineIndex + 1,
  id?: string,
): MarkdownNodeSource | null {
  const cleanLine = line.replace(nodeIdInlinePattern, '').trimEnd();
  const epubHref = (() => {
    const encoded = line.match(epubHrefInlinePattern)?.[1];
    if (!encoded) return undefined;
    try {
      const value = decodeURIComponent(encoded);
      // An address with control characters or backslashes is never a valid EPUB path.
      // eslint-disable-next-line no-control-regex
      return value && !/[\u0000-\u001f\\]/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  })();
  const heading = cleanLine.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
  if (heading) {
    const content = heading[4].replace(/\s+#+\s*$/, '');
    return {
      kind: 'heading',
      ...(id ? { id } : {}),
      ...(epubHref ? { epubHref } : {}),
      lineIndex,
      endLineIndex,
      prefix: `${heading[1]}${heading[2]}${heading[3]}`,
      level: heading[2].length,
      label: normalizeMindmapText(content),
    };
  }

  const list = cleanLine.match(
    /^(\s*)([-+*]|\d+[.)])(\s+)(?:\[([ xX])\]\s+)?(.*)$/,
  );
  if (!list) return null;
  const indent = list[1];
  const marker = list[2];
  const spacing = list[3];
  const taskPrefix = list[4] ? `[${list[4]}] ` : '';
  return {
    kind: 'list',
    ...(id ? { id } : {}),
    ...(epubHref ? { epubHref } : {}),
    lineIndex,
    endLineIndex,
    prefix: `${indent}${marker}${spacing}${taskPrefix}`,
    indent,
    marker,
    hasCheckbox: Boolean(list[4]),
    label: normalizeMindmapText(list[5]),
  };
}

export function buildMarkdownNodeSourceMap(
  markdown: string,
  root: PureNode,
): Map<string, MarkdownNodeSource> {
  const lines = markdown.split(/\r?\n/);
  const result = new Map<string, MarkdownNodeSource>();
  const usedNodeIds = new Set<string>();
  let nodeId = 0;

  const visit = (node: PureNode, parentPath = '') => {
    nodeId += 1;
    const path = parentPath ? `${parentPath}.${nodeId}` : `${nodeId}`;
    const payload = node.payload as Record<string, unknown> | undefined;
    const lineRange = payload?.lines;
    const lineValues = Array.isArray(lineRange)
      ? lineRange.map(Number)
      : typeof lineRange === 'string'
        ? lineRange.split(',').map(Number)
        : [];
    const lineIndex = lineValues[0];
    const rawEndLineIndex = lineValues[1];
    if (
      Number.isInteger(lineIndex) &&
      lineIndex >= 0 &&
      lineIndex < lines.length
    ) {
      const endLineIndex =
        Number.isInteger(rawEndLineIndex) && rawEndLineIndex > lineIndex
          ? Math.min(rawEndLineIndex, lines.length)
          : lineIndex + 1;
      const candidateId = nodeIdAtLine(lines, lineIndex);
      const uniqueId =
        candidateId && !usedNodeIds.has(candidateId) ? candidateId : undefined;
      const source = parseMarkdownNodeSource(
        lines[lineIndex],
        lineIndex,
        endLineIndex,
        uniqueId,
      );
      if (source) {
        result.set(path, source);
        if (uniqueId) usedNodeIds.add(uniqueId);
      } else if (normalizeMindmapText(node.content)) {
        const blockId =
          candidateId && !usedNodeIds.has(candidateId)
            ? candidateId
            : undefined;
        result.set(path, {
          kind: 'block',
          ...(blockId ? { id: blockId } : {}),
          lineIndex,
          endLineIndex,
          prefix: '',
          label: normalizeMindmapText(node.content),
        });
        if (blockId) usedNodeIds.add(blockId);
      }
    }
    node.children.forEach((child) => visit(child, path));
  };

  visit(root);
  return result;
}

export function findSourcePathForLine(
  lineIndex: number,
  sources: Map<string, MarkdownNodeSource>,
): string | null {
  return (
    [...sources.entries()]
      .filter(
        ([, source]) =>
          lineIndex === source.lineIndex ||
          (lineIndex > source.lineIndex && lineIndex < source.endLineIndex),
      )
      .sort((left, right) => {
        const leftSource = left[1];
        const rightSource = right[1];
        const leftRange = leftSource.endLineIndex - leftSource.lineIndex;
        const rightRange = rightSource.endLineIndex - rightSource.lineIndex;
        if (leftRange !== rightRange) return leftRange - rightRange;
        return right[0].split('.').length - left[0].split('.').length;
      })[0]?.[0] || null
  );
}

export function findMarkmapNodeByPath<
  T extends {
    state?: { path?: string };
    children?: T[];
  },
>(root: T | undefined, path: string): T | null {
  if (!root) return null;
  if (root.state?.path === path) return root;
  for (const child of root.children || []) {
    const match = findMarkmapNodeByPath(child, path);
    if (match) return match;
  }
  return null;
}

function headingSubtreeEnd(
  lines: string[],
  source: MarkdownNodeSource,
): number {
  if (source.kind !== 'heading' || source.level === undefined) {
    return Math.min(
      lines.length,
      Math.max(source.lineIndex + 1, source.endLineIndex),
    );
  }
  for (let index = source.lineIndex + 1; index < lines.length; index += 1) {
    const next = parseMarkdownNodeSource(lines[index], index);
    if (next?.kind === 'heading' && (next.level || 7) <= source.level)
      return index;
  }
  return lines.length;
}

function markdownNodeInsertionIndex(
  markdown: string,
  source: MarkdownNodeSource,
): number {
  const lines = markdown.split(/\r?\n/);
  if (source.kind === 'heading') return headingSubtreeEnd(lines, source);
  if (source.kind === 'list')
    return Math.min(
      lines.length,
      Math.max(source.lineIndex + 1, source.endLineIndex),
    );
  return source.lineIndex + 1;
}

function createNodeId(): string {
  const randomUUID = crypto.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(crypto);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export function ensureMarkdownNodeId(
  markdown: string,
  source: MarkdownNodeSource,
): { markdown: string; nodeId: string; lineIndex: number } {
  if (source.id)
    return { markdown, nodeId: source.id, lineIndex: source.lineIndex };
  const lines = markdown.split(/\r?\n/);
  if (source.lineIndex < 0 || source.lineIndex >= lines.length)
    throw new Error('找不到这个节点的 Markdown 源位置。');
  const nodeId = createNodeId();
  if (source.kind === 'heading' || source.kind === 'list') {
    const cleanLine = lines[source.lineIndex]
      .replace(nodeIdAnywherePattern, '')
      .trimEnd();
    lines[source.lineIndex] = `${cleanLine} <!-- seamind:id=${nodeId} -->`;
    return { markdown: lines.join('\n'), nodeId, lineIndex: source.lineIndex };
  }
  const markerLine = lines[source.lineIndex - 1];
  if (markerLine && nodeIdLinePattern.test(markerLine)) {
    lines[source.lineIndex - 1] = `<!-- seamind:id=${nodeId} -->`;
    return { markdown: lines.join('\n'), nodeId, lineIndex: source.lineIndex };
  }
  lines.splice(source.lineIndex, 0, `<!-- seamind:id=${nodeId} -->`);
  return {
    markdown: lines.join('\n'),
    nodeId,
    lineIndex: source.lineIndex + 1,
  };
}

function parseYamlFrontmatter(markdown: string) {
  const match = frontmatterMatch(markdown);
  const document = parseDocument(match?.[1] || '');
  if (document.errors.length)
    throw new Error(
      'Markdown YAML frontmatter 格式有误，无法安全写入节点备注。',
    );
  return { match, document };
}

export function getMarkdownNodeNote(markdown: string, nodeId: string): string {
  return getMarkdownNodeNotes(markdown).get(nodeId) || '';
}

export function getMarkdownNodeNotes(markdown: string): Map<string, string> {
  try {
    const { document } = parseYamlFrontmatter(markdown);
    const data = document.toJS() as {
      seamind?: { notes?: Record<string, unknown> };
    } | null;
    const notes = data?.seamind?.notes;
    if (!notes || typeof notes !== 'object' || Array.isArray(notes))
      return new Map();
    return new Map(
      Object.entries(notes).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return new Map();
  }
}

export function setMarkdownNodeNote(
  markdown: string,
  nodeId: string,
  note: string,
): string {
  if (note.length > MAX_MARKDOWN_NODE_NOTE_CHARS) {
    throw new Error(
      `节点备注不能超过 ${MAX_MARKDOWN_NODE_NOTE_CHARS.toLocaleString()} 个字符。`,
    );
  }
  const { match, document } = parseYamlFrontmatter(markdown);
  const raw = document.toJS() as Record<string, unknown> | null;
  if (
    raw !== null &&
    raw !== undefined &&
    (typeof raw !== 'object' || Array.isArray(raw))
  ) {
    throw new Error('Markdown YAML frontmatter 根节点必须是对象，未写入备注。');
  }
  const metadata = raw && typeof raw === 'object' ? raw : {};
  const seamindValue = metadata.seamind;
  if (
    seamindValue !== undefined &&
    (!seamindValue ||
      typeof seamindValue !== 'object' ||
      Array.isArray(seamindValue))
  ) {
    throw new Error('YAML frontmatter 中的 seamind 字段不是对象，未写入备注。');
  }
  const seamind = (seamindValue || {}) as Record<string, unknown>;
  const notesValue = seamind.notes;
  if (
    notesValue !== undefined &&
    (!notesValue || typeof notesValue !== 'object' || Array.isArray(notesValue))
  ) {
    throw new Error(
      'YAML frontmatter 中的 seamind.notes 不是对象，未写入备注。',
    );
  }
  const notes = { ...((notesValue || {}) as Record<string, unknown>) };
  if (note.trim()) notes[nodeId] = note;
  else delete notes[nodeId];

  if (Object.keys(notes).length) seamind.notes = notes;
  else delete seamind.notes;
  if (Object.keys(seamind).length) metadata.seamind = seamind;
  else delete metadata.seamind;
  document.set('seamind', metadata.seamind ?? null);
  if (!metadata.seamind) document.delete('seamind');

  const serialized = document.toString().trimEnd();
  if (match) {
    return `---\n${serialized}\n---${markdown.slice(match[0].length)}`;
  }
  if (!metadata.seamind) return markdown;
  return `---\n${serialized}\n---\n\n${markdown}`;
}

function nodeMarker(nodeId: string): string {
  return ` <!-- seamind:id=${nodeId} -->`;
}

function encodeNodeMetadata(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function withNodeMarker(
  line: string,
  nodeId: string,
  epubHref?: string,
): string {
  const cleanLine = line
    .replace(nodeIdInlinePattern, '')
    .replace(epubHrefAnywherePattern, '')
    .trimEnd();
  const chapterMarker = epubHref
    ? ` <!-- seamind:epub-href=${encodeNodeMetadata(epubHref)} -->`
    : '';
  return `${cleanLine}${chapterMarker}${nodeMarker(nodeId)}`;
}

function encodeNodeLineBreaks(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('&#10;')
    .trim();
}

function formatNewNode(
  source: MarkdownNodeSource,
  operation: 'add_child' | 'add_sibling',
  text: string,
): string {
  const nodeId = createNodeId();
  text = encodeNodeLineBreaks(text);
  const label = text.trim() || '新主题';
  if (source.kind === 'heading' && source.level !== undefined) {
    const level = operation === 'add_child' ? source.level + 1 : source.level;
    if (level > 6)
      throw new Error('这个标题已经达到 Markdown 的最大层级，无法添加子标题。');
    return `${'#'.repeat(level)} ${label}${nodeMarker(nodeId)}`;
  }
  if (source.kind === 'list') {
    const indent =
      operation === 'add_child'
        ? `${source.indent || ''}  `
        : source.indent || '';
    const marker = source.marker || '-';
    const taskPrefix = source.hasCheckbox ? '[ ] ' : '';
    return `${indent}${marker} ${taskPrefix}${label}${nodeMarker(nodeId)}`;
  }
  throw new Error('只有标题或列表节点可以添加子节点或同级节点。');
}

export function applyMarkdownNodeCommand(
  markdown: string,
  source: MarkdownNodeSource,
  operation: MindmapNodeOperation,
  text = '',
): MarkdownCommandResult {
  if (operation === 'delete') {
    const lines = markdown.split(/\r?\n/);
    const endLineIndex =
      source.kind === 'heading'
        ? headingSubtreeEnd(lines, source)
        : Math.min(
            lines.length,
            Math.max(source.lineIndex + 1, source.endLineIndex),
          );
    const markerLine = lines[source.lineIndex - 1]?.match(nodeIdLinePattern);
    const removeMarkerLine = source.kind === 'block' && Boolean(markerLine);
    const startLineIndex = source.lineIndex - Number(removeMarkerLine);
    const removed = lines.splice(
      startLineIndex,
      Math.max(1, endLineIndex - source.lineIndex + Number(removeMarkerLine)),
    );
    let nextMarkdown = lines.join('\n');
    const idCounts = new Map<string, number>();
    for (const match of markdownBody(markdown).matchAll(
      /<!--\s*seamind:id=([\w-]{1,128})\s*-->/g,
    )) {
      idCounts.set(match[1], (idCounts.get(match[1]) || 0) + 1);
    }
    const removedIds = [
      ...removed.join('\n').matchAll(/<!--\s*seamind:id=([\w-]{1,128})\s*-->/g),
    ]
      .map((match) => match[1])
      .filter((nodeId) => idCounts.get(nodeId) === 1);
    for (const nodeId of removedIds)
      nextMarkdown = setMarkdownNodeNote(nextMarkdown, nodeId, '');
    return { markdown: nextMarkdown, lineIndex: startLineIndex };
  }

  const ensured = ensureMarkdownNodeId(markdown, source);
  const currentSource = {
    ...source,
    id: ensured.nodeId,
    lineIndex: ensured.lineIndex,
  };
  const lines = ensured.markdown.split(/\r?\n/);

  if (operation === 'set_note') {
    return {
      markdown: setMarkdownNodeNote(ensured.markdown, ensured.nodeId, text),
      lineIndex: ensured.lineIndex,
      nodeId: ensured.nodeId,
    };
  }

  if (operation === 'rename') {
    if (currentSource.kind === 'block')
      throw new Error('目前只能改写标题或列表节点。');
    const encodedLabel = encodeNodeLineBreaks(text);
    lines[currentSource.lineIndex] = withNodeMarker(
      `${currentSource.prefix}${encodedLabel}`,
      ensured.nodeId,
      currentSource.epubHref,
    );
    return {
      markdown: lines.join('\n'),
      lineIndex: currentSource.lineIndex,
      nodeId: ensured.nodeId,
    };
  }

  const insertionIndex = markdownNodeInsertionIndex(
    ensured.markdown,
    currentSource,
  );
  lines.splice(
    insertionIndex,
    0,
    formatNewNode(currentSource, operation, text),
  );
  return {
    markdown: lines.join('\n'),
    lineIndex: insertionIndex,
    nodeId: ensured.nodeId,
  };
}

function branchHeadings(markdown: string) {
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/<!--\s*seamind:id=[\w-]{1,128}\s*-->/g, '')
    .split('\n');
  const headings: Array<{ index: number; level: number; text: string }> = [];
  let fence: { marker: string; length: number } | null = null;
  lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length
      )
        fence = null;
      return;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      return;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading)
      headings.push({
        index,
        level: heading[1].length,
        text: heading[2].trim(),
      });
  });
  return { lines, headings };
}

/** Inserts a generated Markdown outline under a selected heading or list node. */
export function applyMarkdownNodeBranch(
  markdown: string,
  source: MarkdownNodeSource,
  branchMarkdown: string,
): MarkdownCommandResult {
  if (source.kind === 'block') {
    throw new Error(
      '代码或媒体节点暂不支持继续下探，请选择普通标题或列表节点。',
    );
  }
  const normalized = branchMarkdown.trim();
  if (!normalized || normalized.length > MAX_AGENT_BRANCH_CHARS) {
    throw new Error(
      `下探分支必须为 1 到 ${MAX_AGENT_BRANCH_CHARS.toLocaleString()} 个字符。`,
    );
  }
  if (/^---\s*(?:\r?\n|$)/.test(normalized)) {
    throw new Error('下探分支不能包含 Markdown YAML frontmatter。');
  }
  const parsed = branchHeadings(normalized);
  if (!parsed.headings.length) {
    throw new Error('下探结果必须包含 Markdown 标题层级，才能生成节点结构。');
  }
  const firstHeading = parsed.headings[0];
  if (parsed.lines.slice(0, firstHeading.index).some((line) => line.trim())) {
    throw new Error('下探内容必须从标题节点开始。');
  }
  const minimumLevel = Math.min(
    ...parsed.headings.map((heading) => heading.level),
  );
  const ensured = ensureMarkdownNodeId(markdown, source);
  const currentSource = {
    ...source,
    id: ensured.nodeId,
    lineIndex: ensured.lineIndex,
  };
  const insertionIndex = markdownNodeInsertionIndex(
    ensured.markdown,
    currentSource,
  );
  const output: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let currentDepth = 0;

  parsed.lines.forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (!fence) {
      const heading = parsed.headings.find((item) => item.index === index);
      if (heading) {
        const depth = heading.level - minimumLevel;
        const nodeId = createNodeId();
        if (source.kind === 'heading') {
          const level = (source.level || 1) + 1 + depth;
          if (level > 6) {
            throw new Error(
              '下探分支层级超过 Markdown 六级标题上限，请减少层级后重试。',
            );
          }
          output.push(
            `${'#'.repeat(level)} ${heading.text}${nodeMarker(nodeId)}`,
          );
        } else {
          const indent = `${source.indent || ''}  ${'  '.repeat(depth)}`;
          output.push(`${indent}- ${heading.text}${nodeMarker(nodeId)}`);
        }
        currentDepth = depth;
        return;
      }
      if (fenceMatch) {
        fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      }
    } else if (
      fenceMatch &&
      fenceMatch[1][0] === fence.marker &&
      fenceMatch[1].length >= fence.length
    ) {
      fence = null;
    }

    if (source.kind === 'list') {
      const contentIndent = `${source.indent || ''}  ${'  '.repeat(currentDepth + 1)}`;
      output.push(line.trim() ? `${contentIndent}${line.trimStart()}` : '');
    } else {
      output.push(line);
    }
  });

  const lines = ensured.markdown.split(/\r?\n/);
  const before =
    source.kind === 'heading' && lines[insertionIndex - 1]?.trim() ? [''] : [];
  const branch = [...before, ...output];
  const insertionLineIndex = insertionIndex + before.length;
  lines.splice(insertionIndex, 0, ...branch);
  return {
    markdown: lines.join('\n'),
    lineIndex: insertionLineIndex,
    nodeId: ensured.nodeId,
  };
}
