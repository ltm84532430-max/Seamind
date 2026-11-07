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
  /** SVG source found in plain text is replaced in place after validation. */
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
const fencedSvgPattern = /(`{3,})svg[^\r\n]*\r?\n([\s\S]*?)\r?\n\1/g;
const rawSvgPattern = /<svg\b[\s\S]*?<\/svg\s*>/gi;

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
    if (parsed.hostname === 'images.openai.com') return true;
    return /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function textFromHtml(html: Document): string {
  const lines: string[] = [];
  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    const name = node.localName.toLowerCase();
    if (name === 'img' || name === 'svg' || name === 'canvas') return '';
    if (name === 'br') return '\n';
    const content = Array.from(node.childNodes).map(visit).join('');
    if (name === 'a') {
      const href = node.getAttribute('href') ?? '';
      return /^https?:\/\//i.test(href) && content.trim()
        ? `[${content.trim()}](${href})`
        : content;
    }
    if (/^h[1-6]$/.test(name))
      return `\n\n${'#'.repeat(Number(name[1]))} ${content.trim()}\n\n`;
    if (name === 'li') return `\n- ${content.trim()}\n`;
    if (
      name === 'p' ||
      name === 'div' ||
      name === 'section' ||
      name === 'blockquote'
    )
      return `\n\n${content.trim()}\n\n`;
    return content;
  };
  lines.push(visit(html.body));
  return lines
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function analyzeKnowledgePaste(
  clipboard: DataTransfer,
): KnowledgePasteDraft {
  const htmlSource = clipboard.getData('text/html');
  const html = htmlSource
    ? new DOMParser().parseFromString(htmlSource, 'text/html')
    : null;
  const text =
    clipboard.getData('text/plain') || (html ? textFromHtml(html) : '');
  const media: PasteMediaCandidate[] = [];
  const byRemoteUrl = new Map<string, PasteMediaCandidate>();
  let linkCount = 0;
  let unsupportedCount = 0;
  const plainSvg = plainSvgCandidates(text);

  for (const match of text.matchAll(markdownLinkPattern)) {
    linkCount += 1;
    const [markdownLink, bang, label, rawUrl] = match;
    const url = rawUrl.replace(/\\&/g, '&');
    if (!isImageLink(url) || byRemoteUrl.has(url)) continue;
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

  if (html) {
    for (const [index, image] of Array.from(
      html.querySelectorAll('img'),
    ).entries()) {
      const src = image.getAttribute('src')?.trim() ?? '';
      const label = image.getAttribute('alt')?.trim() || `图片 ${index + 1}`;
      if (/^https:\/\//i.test(src)) {
        const url = src.replace(/&amp;/g, '&');
        const linked = byRemoteUrl.get(url);
        if (linked) {
          linked.selected = true;
        } else {
          media.push({
            key: `remote:${url}`,
            label,
            kind: 'remote',
            value: url,
            selected: true,
          });
          byRemoteUrl.set(url, media[media.length - 1]);
        }
      } else if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src)) {
        if (src.length > (MAX_PASTE_MEDIA_BYTES * 4) / 3 + 64) {
          unsupportedCount += 1;
        } else {
          media.push({
            key: `data:${index}`,
            label,
            kind: 'data',
            value: src,
            selected: true,
          });
        }
      } else {
        unsupportedCount += 1;
      }
    }
    for (const [index, svg] of Array.from(
      html.querySelectorAll('svg'),
    ).entries()) {
      const source = svg.outerHTML;
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
  const svgCount =
    (html?.querySelectorAll('svg').length ?? 0) + plainSvg.length;
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
  return result;
}
