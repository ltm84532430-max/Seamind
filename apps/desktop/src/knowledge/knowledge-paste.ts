export const MAX_PASTE_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_PASTE_MEDIA_COUNT = 12;
export const MAX_PASTE_SVG_CHARS = 300_000;

export interface PasteMediaCandidate {
  key: string;
  label: string;
  kind: 'file' | 'data' | 'remote' | 'svg';
  value: File | string;
  selected: boolean;
  /** The source link is replaced in place after the image has been imported. */
  markdownLink?: string;
  /** Inline source snippet (SVG markup, fenced SVG, or data placeholder) replaced in place. */
  sourceText?: string;
}

export interface KnowledgePasteDraft {
  text: string;
  media: PasteMediaCandidate[];
  linkCount: number;
  richHtml: boolean;
  svgCount: number;
  canvasCount: number;
  unsupportedCount: number;
  possibleMissingDiagram: boolean;
}

/** 普通网页文字直接交给编辑器粘贴；只有图形或缺失图示需要导入检查。 */
export function needsKnowledgePasteReview(
  draft: KnowledgePasteDraft,
  hasPlainText: boolean,
): boolean {
  return (
    draft.media.length > 0 ||
    draft.svgCount > 0 ||
    draft.canvasCount > 0 ||
    draft.unsupportedCount > 0 ||
    (!hasPlainText && draft.richHtml) ||
    (draft.possibleMissingDiagram && draft.text.length > 800)
  );
}

export type ImportedPasteVisual =
  | { candidate: PasteMediaCandidate; mediaId: string; svgSource?: never }
  | { candidate: PasteMediaCandidate; mediaId?: never; svgSource: string };

const markdownLinkPattern = /(!?)\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/g;
const mediaReferencePattern = /^seamind-media:([a-f0-9]{64})$/i;
const fencedSvgPattern =
  /^[ \t]*(`{3,})svg\b[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*\1(?=[ \t]*(?:\r?\n|$))/gim;
const rawSvgPattern = /<svg\b[\s\S]*?<\/svg\s*>/gi;
const dataPlaceholderPattern = /\n?<!--\s*seamind-paste-data:\d+\s*-->\n?/g;

const TRUSTED_IMAGE_HOSTS = new Set([
  'images.openai.com',
  'files.oaiusercontent.com',
  'oaidalleapiprodscus.blob.core.windows.net',
]);

export function mediaIdFromSource(source: string): string | null {
  return mediaReferencePattern.exec(source.trim())?.[1]?.toLowerCase() ?? null;
}

export function imageMarkdown(label: string, mediaId: string): string {
  const safeLabel = label.replace(/[[\]\\\r\n]/g, ' ').trim() || '图片';
  return `![${safeLabel}](seamind-media:${mediaId})`;
}

export function svgMarkdown(svgSource: string): string {
  let longestBackticks = 0;
  for (const match of svgSource.matchAll(/`+/g))
    longestBackticks = Math.max(longestBackticks, match[0].length);
  const fence = '`'.repeat(Math.max(3, longestBackticks + 1));
  return `${fence}svg\n${svgSource.trim()}\n${fence}`;
}

export function finalizeSkippedPasteMedia(text: string): string {
  return text
    .replace(dataPlaceholderPattern, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

function inlineCodeMarkdown(code: string): string {
  const clean = code.replace(/\r?\n/g, ' ');
  let longest = 0;
  for (const match of clean.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  const ticks = '`'.repeat(longest + 1);
  const needsPadding = clean.startsWith('`') || clean.endsWith('`');
  return needsPadding
    ? `${ticks} ${clean} ${ticks}`
    : `${ticks}${clean}${ticks}`;
}

function fencedCodeMarkdown(language: string, code: string): string {
  const normalized = code.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  let longest = 0;
  for (const match of normalized.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const safeLang = language.replace(/[^\w+-]/g, '').trim();
  return `${fence}${safeLang}\n${normalized}\n${fence}`;
}

function dataPlaceholderToken(index: number): string {
  return `<!-- seamind-paste-data:${index} -->`;
}

function plainSvgCandidates(text: string): PasteMediaCandidate[] {
  const result: PasteMediaCandidate[] = [];
  const fencedRanges: Array<[number, number]> = [];
  for (const match of text.matchAll(fencedSvgPattern)) {
    const index = match.index;
    if (index === undefined) continue;
    fencedRanges.push([index, index + match[0].length]);
    result.push({
      key: `svg:plain:${index}`,
      label: `SVG 图形 ${result.length + 1}`,
      kind: 'svg',
      value: match[2],
      selected: true,
      sourceText: match[0],
    });
  }
  for (const match of text.matchAll(rawSvgPattern)) {
    const index = match.index;
    if (
      index === undefined ||
      fencedRanges.some(([start, end]) => index >= start && index < end)
    )
      continue;
    result.push({
      key: `svg:plain:${index}`,
      label: `SVG 图形 ${result.length + 1}`,
      kind: 'svg',
      value: match[0],
      selected: true,
      sourceText: match[0],
    });
  }
  return result;
}

function isImageLink(url: string): boolean {
  try {
    const parsed = new URL(url.replace(/\\&/g, '&'));
    if (parsed.protocol !== 'https:') return false;
    if (TRUSTED_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) return true;
    if (/\.(?:png|jpe?g|gif|webp|avif)(?:$|[?#])/i.test(parsed.pathname))
      return true;
    const formatParam =
      parsed.searchParams.get('format') ||
      parsed.searchParams.get('fm') ||
      parsed.searchParams.get('ext') ||
      '';
    return /^(?:png|jpe?g|gif|webp|avif)$/i.test(formatParam);
  } catch {
    return false;
  }
}

function svgDimensionNumber(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

export function isContentSvgElement(svg: Element): boolean {
  if (svg.closest('.katex, button, nav, [role="button"], .sr-only')) {
    return false;
  }
  const hasVisibleShape = Boolean(
    svg.querySelector(
      'path,line,circle,rect,ellipse,polyline,polygon,text,tspan,foreignObject,foreignobject',
    ),
  );
  if (!hasVisibleShape) return false;
  const hasText = Boolean(
    svg.querySelector('text, tspan')?.textContent?.trim(),
  );
  if (hasText) return true;

  let width = svgDimensionNumber(svg.getAttribute('width'));
  let height = svgDimensionNumber(svg.getAttribute('height'));
  if (width === null || height === null) {
    const viewBox = svg
      .getAttribute('viewBox')
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
      width = width ?? viewBox[2];
      height = height ?? viewBox[3];
    }
  }
  if (width !== null && height !== null && width <= 32 && height <= 32) {
    return false;
  }
  return true;
}

function serializeInlineSvg(svg: Element): string {
  const html = svg.outerHTML.trim();
  if (!/^<svg\b/i.test(html)) return html;
  return html.replace(/^<svg\b([^>]*)>/i, (full, attrs: string) =>
    /\bxmlns\s*=/i.test(attrs)
      ? full
      : `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>`,
  );
}

interface HtmlConversionContext {
  dataPlaceholders: Map<Element, string>;
  contentSvgs: Set<Element>;
}

function extractCodeLanguage(pre: Element, code: Element | null): string {
  const classText = `${code?.getAttribute('class') ?? ''} ${pre.getAttribute('class') ?? ''}`;
  const classMatch = classText.match(/(?:^|\s)(?:language|lang)-([\w+#-]+)/i);
  if (classMatch?.[1]) return classMatch[1].toLowerCase();

  for (const candidate of Array.from(pre.querySelectorAll('div, span'))) {
    if (code && (code === candidate || code.contains(candidate))) continue;
    const label = (candidate.textContent ?? '').trim().toLowerCase();
    if (
      /^(?:mermaid|pele|svg|plantuml|puml|echarts|echart|python|py|bash|sh|zsh|powershell|pwsh|javascript|js|typescript|ts|tsx|jsx|json|yaml|yml|html|css|sql|rust|rs|c|cpp|c\+\+|cxx|go|java|tex|latex|seamind-math|seamind-viz)$/.test(
        label,
      )
    ) {
      return label;
    }
  }
  return '';
}

function extractRawCodeText(codeRoot: Element): string {
  let out = '';
  const walk = (node: Node) => {
    const nodeType = (node as { nodeType?: number }).nodeType;
    if (nodeType === 3) {
      out += node.textContent ?? '';
      return;
    }
    if (nodeType !== 1) return;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (tag === 'button' || tag === 'style' || tag === 'script') return;
    if (tag === 'br') {
      out += '\n';
      return;
    }
    Array.from(el.childNodes).forEach(walk);
  };
  walk(codeRoot);
  return out.replace(/\u00a0/g, ' ');
}

function looksLikeRawMarkdownSource(text: string): boolean {
  if (!text.trim()) return false;
  return (
    /^\s*```/m.test(text) ||
    /^\s*#{1,6}\s+\S/m.test(text) ||
    /!\[[^\]]*\]\(https:\/\/[^\s)]+\)/.test(text) ||
    /\[[^\]]+\]\(https:\/\/[^\s)]+\)/.test(text) ||
    /^\s*\|.+\|\s*\r?\n\s*\|[\s:|-]+\|/m.test(text) ||
    /(?:^|\n)\s*\$\$[\s\S]+?\$\$/.test(text)
  );
}

export function htmlToKnowledgeMarkdown(
  html: Document,
  context?: HtmlConversionContext,
): string {
  const visit = (node: Node, listDepth = 0): string => {
    const nodeType = (node as { nodeType?: number }).nodeType;
    if (nodeType === 3) {
      return (node.textContent ?? '').replace(/\u00a0/g, ' ');
    }
    if (nodeType !== 1) return '';
    const el = node as Element;
    const name = el.localName.toLowerCase();
    const className = el.getAttribute('class') ?? '';

    if (
      name === 'script' ||
      name === 'style' ||
      name === 'noscript' ||
      name === 'template' ||
      name === 'button' ||
      name === 'canvas' ||
      /\bsr-only\b/.test(className)
    ) {
      return '';
    }

    // ChatGPT / KaTeX rendered equations carry original TeX in <annotation encoding="application/x-tex">
    if (
      /\bkatex-display\b/.test(className) ||
      /\bkatex\b/.test(className) ||
      name === 'math'
    ) {
      const tex = el
        .querySelector('annotation[encoding="application/x-tex"], annotation')
        ?.textContent?.trim();
      if (tex) {
        const isDisplay =
          /\bkatex-display\b/.test(className) ||
          Boolean(el.closest('.katex-display')) ||
          (name === 'math' && el.getAttribute('display') === 'block');
        return isDisplay ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
      }
      if (/\bkatex-html\b/.test(className)) return '';
    }
    if (/\bkatex-html\b/.test(className)) return '';

    if (name === 'img') {
      const placeholder = context?.dataPlaceholders.get(el);
      if (placeholder) return `\n\n${placeholder}\n\n`;
      const src = el.getAttribute('src')?.trim() ?? '';
      if (/^https:\/\//i.test(src)) {
        const alt = (el.getAttribute('alt') ?? '图片')
          .replace(/[[\]\\\r\n]/g, ' ')
          .trim();
        return `\n\n![${alt || '图片'}](${src.replace(/&amp;/g, '&')})\n\n`;
      }
      return '';
    }

    if (name === 'svg') {
      if (context ? context.contentSvgs.has(el) : isContentSvgElement(el)) {
        return `\n\n${svgMarkdown(serializeInlineSvg(el))}\n\n`;
      }
      return '';
    }

    if (name === 'pre') {
      const codeEl = el.querySelector('code');
      const language = extractCodeLanguage(el, codeEl);
      const rawCode = extractRawCodeText(codeEl ?? el);
      if (!rawCode.trim()) return '';
      return `\n\n${fencedCodeMarkdown(language, rawCode)}\n\n`;
    }

    if (name === 'code') {
      const text = extractRawCodeText(el).trim();
      return text ? inlineCodeMarkdown(text) : '';
    }

    if (name === 'br') return '\n';
    if (name === 'hr') return '\n\n---\n\n';

    if (name === 'table') {
      const rows = Array.from(el.querySelectorAll('tr')).filter(
        (tr) => tr.closest('table') === el,
      );
      if (rows.length === 0) return '';
      const matrix = rows
        .map((tr) =>
          Array.from(tr.children)
            .filter((cell) => {
              const tag = cell.localName.toLowerCase();
              return tag === 'th' || tag === 'td';
            })
            .map((cell) =>
              Array.from(cell.childNodes)
                .map((child) => visit(child, listDepth))
                .join('')
                .replace(/\r?\n+/g, ' ')
                .replace(/\|/g, '\\|')
                .replace(/\s+/g, ' ')
                .trim(),
            ),
        )
        .filter((cells) => cells.length > 0);
      if (matrix.length === 0) return '';
      const colCount = Math.max(...matrix.map((row) => row.length));
      const padRow = (row: string[]) =>
        `| ${Array.from({ length: colCount }, (_, idx) => row[idx] ?? '').join(' | ')} |`;
      const separator = `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`;
      const [header, ...body] = matrix;
      return `\n\n${[padRow(header), separator, ...body.map(padRow)].join('\n')}\n\n`;
    }

    if (name === 'ul' || name === 'ol') {
      const items = Array.from(el.children).filter(
        (child) => child.localName.toLowerCase() === 'li',
      );
      if (items.length === 0) return '';
      const startIndex =
        name === 'ol'
          ? Math.max(
              1,
              Number.parseInt(el.getAttribute('start') ?? '1', 10) || 1,
            )
          : 1;
      const indent = '  '.repeat(listDepth);
      const renderedItems = items
        .map((li, index) => {
          const marker = name === 'ol' ? `${startIndex + index}. ` : '- ';
          const inner = Array.from(li.childNodes)
            .map((child) => visit(child, listDepth + 1))
            .join('')
            .replace(/^\n+|\n+$/g, '')
            .replace(/\n{3,}/g, '\n\n');
          if (!inner.trim()) return '';
          const lines = inner.split('\n');
          const [firstLine, ...restLines] = lines;
          const continuation = restLines
            .map((line) => (line.trim() ? `${indent}  ${line}` : ''))
            .join('\n');
          return continuation
            ? `${indent}${marker}${firstLine.trim()}\n${continuation}`
            : `${indent}${marker}${firstLine.trim()}`;
        })
        .filter(Boolean);
      const spacing = listDepth === 0 ? '\n\n' : '\n';
      return renderedItems.length
        ? `${spacing}${renderedItems.join('\n')}${spacing}`
        : '';
    }

    if (name === 'a') {
      const href = el.getAttribute('href')?.trim() ?? '';
      const hasMedia = Boolean(el.querySelector('img, svg'));
      const content = Array.from(el.childNodes)
        .map((child) => visit(child, listDepth))
        .join('')
        .trim();
      const nonMediaText = content
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/<!--\s*seamind-paste-data:\d+\s*-->/g, '')
        .replace(/```svg[\s\S]*?```/gi, '')
        .trim();
      if (hasMedia && !nonMediaText) return `\n\n${content}\n\n`;
      return /^https?:\/\//i.test(href) && content
        ? `[${content}](${href.replace(/&amp;/g, '&')})`
        : content;
    }

    const content = Array.from(el.childNodes)
      .map((child) => visit(child, listDepth))
      .join('');

    if (name === 'strong' || name === 'b') {
      const inner = content.trim();
      if (!inner) return '';
      const lead = /^\s/.test(content) ? ' ' : '';
      const trail = /\s$/.test(content) ? ' ' : '';
      return `${lead}**${inner}**${trail}`;
    }
    if (name === 'em' || name === 'i') {
      const inner = content.trim();
      return inner ? `*${inner}*` : '';
    }
    if (name === 'del' || name === 's') {
      const inner = content.trim();
      return inner ? `~~${inner}~~` : '';
    }
    if (/^h[1-6]$/.test(name)) {
      const heading = content.replace(/\s+/g, ' ').trim();
      return heading ? `\n\n${'#'.repeat(Number(name[1]))} ${heading}\n\n` : '';
    }
    if (name === 'blockquote') {
      const inner = content.replace(/\n{3,}/g, '\n\n').trim();
      if (!inner) return '';
      const quoted = inner
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : '>'))
        .join('\n');
      return `\n\n${quoted}\n\n`;
    }
    if (
      name === 'p' ||
      name === 'div' ||
      name === 'section' ||
      name === 'article'
    ) {
      const trimmed = content.trim();
      return trimmed ? `\n\n${trimmed}\n\n` : '';
    }
    return content;
  };

  return visit(html.body)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectHtmlMedia(html: Document): {
  dataPlaceholders: Map<Element, string>;
  dataCandidates: PasteMediaCandidate[];
  htmlImages: Array<{ label: string; url: string }>;
  contentSvgs: Set<Element>;
  unsupportedCount: number;
} {
  const dataPlaceholders = new Map<Element, string>();
  const dataCandidates: PasteMediaCandidate[] = [];
  const htmlImages: Array<{ label: string; url: string }> = [];
  const contentSvgs = new Set<Element>();
  let unsupportedCount = 0;

  for (const [index, image] of Array.from(
    html.querySelectorAll('img'),
  ).entries()) {
    const src = image.getAttribute('src')?.trim() ?? '';
    const label = image.getAttribute('alt')?.trim() || `图片 ${index + 1}`;
    if (/^https:\/\//i.test(src)) {
      htmlImages.push({ label, url: src.replace(/&amp;/g, '&') });
    } else if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src)) {
      if (src.length > (MAX_PASTE_MEDIA_BYTES * 4) / 3 + 64) {
        unsupportedCount += 1;
      } else {
        const placeholder = dataPlaceholderToken(dataCandidates.length);
        dataPlaceholders.set(image, placeholder);
        dataCandidates.push({
          key: `data:${index}`,
          label,
          kind: 'data',
          value: src,
          selected: true,
          sourceText: placeholder,
        });
      }
    } else {
      unsupportedCount += 1;
    }
  }

  for (const svg of Array.from(html.querySelectorAll('svg'))) {
    if (isContentSvgElement(svg)) {
      contentSvgs.add(svg);
    }
  }

  return {
    dataPlaceholders,
    dataCandidates,
    htmlImages,
    contentSvgs,
    unsupportedCount,
  };
}

export function analyzeKnowledgePaste(
  clipboard: DataTransfer,
): KnowledgePasteDraft {
  const htmlSource = clipboard.getData('text/html');
  const html =
    htmlSource && typeof DOMParser !== 'undefined'
      ? new DOMParser().parseFromString(htmlSource, 'text/html')
      : null;
  const plainClipboardText = clipboard.getData('text/plain');
  const htmlMedia = html ? collectHtmlMedia(html) : null;
  const htmlMarkdown =
    html && htmlMedia
      ? htmlToKnowledgeMarkdown(html, {
          dataPlaceholders: htmlMedia.dataPlaceholders,
          contentSvgs: htmlMedia.contentSvgs,
        })
      : '';

  const hasStructuralHtml = Boolean(
    html &&
    (html.querySelector(
      'pre, table, .katex, math, h1, h2, h3, h4, h5, h6, ul, ol, blockquote',
    ) ||
      (htmlMedia?.htmlImages.length ?? 0) > 0 ||
      (htmlMedia?.dataCandidates.length ?? 0) > 0 ||
      (htmlMedia?.contentSvgs.size ?? 0) > 0),
  );
  const useHtmlMarkdown = Boolean(
    htmlMarkdown &&
    (!plainClipboardText.trim() ||
      (hasStructuralHtml && !looksLikeRawMarkdownSource(plainClipboardText))),
  );
  const text = useHtmlMarkdown ? htmlMarkdown : plainClipboardText;

  const media: PasteMediaCandidate[] = [];
  const byRemoteUrl = new Map<string, PasteMediaCandidate>();
  let linkCount = 0;
  let unsupportedCount = htmlMedia?.unsupportedCount ?? 0;
  const plainSvg = plainSvgCandidates(text);

  for (const match of text.matchAll(markdownLinkPattern)) {
    linkCount += 1;
    const [markdownLink, bang, label, rawUrl] = match;
    const url = rawUrl.replace(/\\&/g, '&');
    if (
      (!isImageLink(url) &&
        !(htmlMedia?.htmlImages.some((entry) => entry.url === url) ?? false)) ||
      byRemoteUrl.has(url)
    )
      continue;
    const candidate: PasteMediaCandidate = {
      key: `remote:${url}`,
      label: label || '图片链接',
      kind: 'remote',
      value: url,
      selected: bang === '!',
      markdownLink,
    };
    byRemoteUrl.set(url, candidate);
    media.push(candidate);
  }

  if (htmlMedia) {
    for (const item of htmlMedia.htmlImages) {
      const linked = byRemoteUrl.get(item.url);
      if (linked) {
        linked.selected = true;
      } else {
        const candidate: PasteMediaCandidate = {
          key: `remote:${item.url}`,
          label: item.label,
          kind: 'remote',
          value: item.url,
          selected: true,
        };
        byRemoteUrl.set(item.url, candidate);
        media.push(candidate);
      }
    }
    media.push(...htmlMedia.dataCandidates);
    if (!useHtmlMarkdown) {
      for (const [index, svg] of Array.from(htmlMedia.contentSvgs).entries()) {
        const source = serializeInlineSvg(svg);
        if (plainSvg.some((candidate) => candidate.value === source)) continue;
        media.push({
          key: `svg:html:${index}`,
          label:
            svg.getAttribute('aria-label')?.trim() ||
            svg.querySelector('title')?.textContent?.trim() ||
            `SVG 图形 ${index + 1}`,
          kind: 'svg',
          value: source,
          selected: true,
        });
      }
    }
  }

  media.push(...plainSvg);

  const files = Array.from(clipboard.files).filter((file) =>
    file.type.startsWith('image/'),
  );
  for (const [index, file] of files.entries()) {
    if (
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
        file.type,
      ) ||
      file.size > MAX_PASTE_MEDIA_BYTES
    ) {
      unsupportedCount += 1;
      continue;
    }
    media.push({
      key: `file:${index}:${file.name}:${file.size}`,
      label: file.name || `剪贴板图片 ${index + 1}`,
      kind: 'file',
      value: file,
      selected: true,
    });
  }

  const oversizedSvg = media.filter(
    (candidate) =>
      candidate.kind === 'svg' &&
      String(candidate.value).length > MAX_PASTE_SVG_CHARS,
  );
  unsupportedCount += oversizedSvg.length;
  const withinLimit = media.filter(
    (candidate) => !oversizedSvg.includes(candidate),
  );
  if (withinLimit.length > MAX_PASTE_MEDIA_COUNT) {
    unsupportedCount += withinLimit.length - MAX_PASTE_MEDIA_COUNT;
    withinLimit.length = MAX_PASTE_MEDIA_COUNT;
  }
  const svgCount = useHtmlMarkdown
    ? plainSvg.length
    : (htmlMedia?.contentSvgs.size ?? 0) + plainSvg.length;
  const canvasCount = html?.querySelectorAll('canvas').length ?? 0;
  const richHtml = !!html?.querySelector(
    'h1,h2,h3,h4,h5,h6,table,pre,blockquote,ul,ol,strong,em',
  );
  return {
    text,
    media: withinLimit,
    linkCount,
    richHtml,
    svgCount,
    canvasCount,
    unsupportedCount,
    possibleMissingDiagram:
      !svgCount &&
      !canvasCount &&
      /(?:流程图|架构图|示意图|场景树示意|flowchart|diagram)/i.test(text),
  };
}

export function pasteTextWithMedia(
  text: string,
  imported: readonly ImportedPasteVisual[],
): string {
  const byUrl = new Map<string, string>();
  const appended: string[] = [];
  let result = text;
  for (const item of imported) {
    const { candidate } = item;
    const markup =
      item.svgSource !== undefined
        ? svgMarkdown(item.svgSource)
        : imageMarkdown(candidate.label, item.mediaId);
    if (candidate.sourceText && result.includes(candidate.sourceText))
      result = result.replace(candidate.sourceText, markup);
    else if (
      candidate.kind === 'remote' &&
      candidate.markdownLink &&
      item.mediaId
    )
      byUrl.set(String(candidate.value), item.mediaId);
    else appended.push(markup);
  }
  result = result.replace(
    markdownLinkPattern,
    (original, _bang: string, label: string, rawUrl: string) => {
      const mediaId = byUrl.get(rawUrl.replace(/\\&/g, '&'));
      return mediaId ? imageMarkdown(label, mediaId) : original;
    },
  );
  if (appended.length)
    result = `${result.trimEnd()}\n\n${appended.join('\n\n')}`;
  return finalizeSkippedPasteMedia(result);
}
