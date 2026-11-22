import {
  MAX_PASTE_MEDIA_BYTES,
  type PasteMediaCandidate,
} from '../knowledge/knowledge-paste';

export interface ParsedNodeImageInput {
  prefixText: string;
  imageMarkdown: string;
  suffixText: string;
}

export interface ImageEditorPasteResult {
  text: string;
  replaceFrom: number;
  replaceTo: number;
}

const SUPPORTED_CLIPBOARD_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const nodeIdInlineOrFullPattern = /<!--\s*seamind:id=[\w-]{1,128}\s*-->/g;
const standaloneImageLinePattern =
  /^!\[([^\]]*)\]\((seamind-media:[a-f0-9]{64}|https?:\/\/[^\s)]+|\/[^\s)]+)\)$/i;
const dataImageSrcPattern =
  /<img\b[^>]*\bsrc=(["'])(data:image\/(?:png|jpeg|gif|webp);base64,[^"']+)\1/i;
const dataImageAltPattern = /\balt=(["'])([^"']*)\1/i;

function isInsideFencedCodeBlock(docText: string, offset: number): boolean {
  const before = docText.slice(0, offset);
  let activeFence: { char: string; length: number } | null = null;
  for (const line of before.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    const marker = match[1];
    if (!activeFence) {
      activeFence = { char: marker[0], length: marker.length };
    } else if (
      marker[0] === activeFence.char &&
      marker.length >= activeFence.length
    ) {
      activeFence = null;
    }
  }
  return activeFence !== null;
}

export function extractClipboardImageCandidate(
  clipboard: DataTransfer | null | undefined,
): PasteMediaCandidate | { error: string } | null {
  if (!clipboard) return null;

  const collectedFiles: File[] = [];
  for (const file of Array.from(clipboard.files ?? [])) {
    if (file.type.startsWith('image/')) collectedFiles.push(file);
  }
  if (collectedFiles.length === 0 && clipboard.items) {
    for (const item of Array.from(clipboard.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) collectedFiles.push(file);
      }
    }
  }

  for (const [index, file] of collectedFiles.entries()) {
    const mime = file.type.toLowerCase();
    if (!SUPPORTED_CLIPBOARD_IMAGE_TYPES.has(mime)) {
      return {
        error: '粘贴的图片格式不受支持，仅支持 PNG、JPEG、GIF、WebP。',
      };
    }
    if (file.size <= 0 || file.size > MAX_PASTE_MEDIA_BYTES) {
      return { error: '粘贴的本地截图超过 10 MB 限制或内容为空。' };
    }
    return {
      key: `file:${index}:${file.name}:${file.size}`,
      label: file.name?.trim() || '剪贴板截图',
      kind: 'file',
      value: file,
      selected: true,
    };
  }

  const htmlSource = clipboard.getData('text/html');
  if (htmlSource) {
    const imgMatch = htmlSource.match(dataImageSrcPattern);
    if (imgMatch?.[2]) {
      const dataUrl = imgMatch[2];
      if (dataUrl.length > (MAX_PASTE_MEDIA_BYTES * 4) / 3 + 64) {
        return { error: '粘贴的内嵌图片超过 10 MB 限制。' };
      }
      const imgTagMatch = htmlSource.match(/<img\b[^>]*>/i)?.[0] ?? '';
      const altMatch = imgTagMatch.match(dataImageAltPattern);
      return {
        key: 'data:0',
        label: altMatch?.[2]?.trim() || '剪贴板截图',
        kind: 'data',
        value: dataUrl,
        selected: true,
      };
    }
  }

  return null;
}

export function parseNodeImageMarkdownInput(
  rawText: string,
): ParsedNodeImageInput | null {
  const lines = rawText.replace(/\r\n?/g, '\n').split('\n');
  const imageIndex = lines.findIndex((line) =>
    standaloneImageLinePattern.test(line.trim()),
  );
  if (imageIndex < 0) return null;

  return {
    prefixText: lines.slice(0, imageIndex).join('\n').trim(),
    imageMarkdown: lines[imageIndex].trim(),
    suffixText: lines
      .slice(imageIndex + 1)
      .join('\n')
      .trim(),
  };
}

export function formatImagePasteForMarkdownEditor(
  docText: string,
  from: number,
  to: number,
  imageMarkdownLine: string,
): ImageEditorPasteResult {
  const clampedFrom = Math.max(0, Math.min(from, docText.length));
  const clampedTo = Math.max(clampedFrom, Math.min(to, docText.length));
  const imageLine = imageMarkdownLine.trim();

  if (isInsideFencedCodeBlock(docText, clampedFrom)) {
    return {
      text: imageLine,
      replaceFrom: clampedFrom,
      replaceTo: clampedTo,
    };
  }

  const lineStart = docText.lastIndexOf('\n', Math.max(0, clampedFrom - 1)) + 1;
  const lineEndRaw = docText.indexOf('\n', clampedTo);
  const lineEnd = lineEndRaw < 0 ? docText.length : lineEndRaw;

  const beforeOnLine = docText.slice(lineStart, clampedFrom);
  const afterOnLine = docText.slice(clampedTo, lineEnd);
  const markerMatch = afterOnLine.match(
    /^\s*(<!--\s*seamind:id=[\w-]{1,128}\s*-->)\s*$/,
  );
  const isEmptyOrPlaceholderPrefix =
    /^\s*(?:#{1,6}\s*(?:新主题)?|[-+*]\s*(?:\[[ xX]\]\s*)?(?:新主题)?|\d+[.)]\s*(?:\[[ xX]\]\s*)?(?:新主题)?)\s*$/.test(
      beforeOnLine,
    ) &&
    (afterOnLine.trim() === '' || Boolean(markerMatch));

  let replaceFrom = clampedFrom;
  let replaceTo = clampedTo;
  let bodyToInsert = imageLine;

  if (isEmptyOrPlaceholderPrefix) {
    replaceFrom = lineStart;
    replaceTo = lineEnd;
    const preservedMarker = markerMatch?.[1];
    bodyToInsert = preservedMarker
      ? `${preservedMarker}\n${imageLine}`
      : imageLine;
  }

  const beforeText = docText.slice(0, replaceFrom);
  const afterText = docText.slice(replaceTo);

  let leading = '';
  if (beforeText.length > 0) {
    if (beforeText.endsWith('\n\n')) leading = '';
    else if (beforeText.endsWith('\n')) {
      const prevLineStart =
        beforeText.lastIndexOf('\n', beforeText.length - 2) + 1;
      const prevLine = beforeText.slice(prevLineStart, beforeText.length - 1);
      const prevClean = prevLine.replace(nodeIdInlineOrFullPattern, '').trim();
      leading = prevClean ? '\n' : '';
    } else {
      leading = '\n\n';
    }
  }

  let trailing = '';
  if (afterText.length > 0) {
    if (afterText.startsWith('\n\n')) trailing = '';
    else if (afterText.startsWith('\n')) trailing = '\n';
    else trailing = '\n\n';
  }

  return {
    text: `${leading}${bodyToInsert}${trailing}`,
    replaceFrom,
    replaceTo,
  };
}
