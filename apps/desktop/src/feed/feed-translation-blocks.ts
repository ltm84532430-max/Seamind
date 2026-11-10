export const FEED_CHANNEL_TRANSLATION_LIMIT = 20;
export const FEED_TRANSLATION_BATCH_SIZE = 10;
const MAX_PIECE_CHARS = 3_500;
const BATCH_CHAR_BUDGET = 12_000;

export interface FeedBlockSource {
  title: string;
  contentHtml: string;
  summary: string;
}

export interface PromptPiece {
  promptId: number;
  blockId: number;
  text: string;
}

interface FeedNode {
  name: string;
  text: string;
  className: string;
  children: FeedNode[];
}

const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'dt',
  'dd',
]);
const SKIP_TAGS = new Set([
  'pre',
  'svg',
  'math',
  'script',
  'style',
  'noscript',
  'iframe',
  'form',
  'button',
]);
const VOID_TAGS = new Set([
  'br',
  'img',
  'hr',
  'wbr',
  'source',
  'meta',
  'link',
  'input',
  'col',
  'area',
  'base',
]);
const SKIP_CLASSES = new Set([
  'highlight',
  'seamind-bilingual-trans',
  'feed-article-placeholder',
  'feed-article-original-link',
]);

export function normalizeBlockText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function isTranslatableText(text: string): boolean {
  const raw = normalizeBlockText(text);
  if (raw.length < 2) return false;
  return !/^[\d\s.\-_~:;#*()[\]{}]+$/u.test(raw);
}

function decodeEntities(text: string): string {
  const fromCode = (raw: string, radix: number) => {
    const value = Number.parseInt(raw, radix);
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return '';
    try {
      return String.fromCodePoint(value);
    } catch {
      return '';
    }
  };
  return text
    .replace(/&#(\d+);/g, (_, digits: string) => fromCode(digits, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => fromCode(hex, 16))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function readClass(tagBody: string): string {
  const match = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
    tagBody,
  );
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function parseFeedHtml(html: string): FeedNode {
  const root: FeedNode = { name: 'div', text: '', className: '', children: [] };
  const stack = [root];
  let index = 0;

  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[index] === '<') {
      const close = html.indexOf('>', index + 1);
      if (close === -1) break;
      const raw = html.slice(index + 1, close).trim();
      index = close + 1;
      if (!raw || raw.startsWith('!') || raw.startsWith('?')) continue;
      if (raw.startsWith('/')) {
        const name = raw.slice(1).trim().split(/\s+/)[0]?.toLowerCase();
        for (let depth = stack.length - 1; depth > 0; depth -= 1) {
          const popped = stack.pop();
          if (popped?.name === name) break;
        }
        continue;
      }
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1).trim() : raw;
      const name = (body.split(/\s+/)[0] ?? '').toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/i.test(name)) continue;
      const node: FeedNode = {
        name,
        text: '',
        className: readClass(body),
        children: [],
      };
      stack[stack.length - 1]?.children.push(node);
      if (!selfClosing && !VOID_TAGS.has(name)) {
        stack.push(node);
        if (name === 'script' || name === 'style') {
          const endTag = new RegExp(`</${name}\\s*>`, 'i');
          const match = endTag.exec(html.slice(index));
          if (match && match.index >= 0) {
            node.text = html.slice(index, index + match.index);
            index += match.index + match[0].length;
            stack.pop();
          }
        }
      }
      continue;
    }

    const next = html.indexOf('<', index);
    const text = html.slice(index, next === -1 ? html.length : next);
    index = next === -1 ? html.length : next;
    if (text) {
      stack[stack.length - 1]?.children.push({
        name: '#text',
        text: decodeEntities(text),
        className: '',
        children: [],
      });
    }
  }
  return root;
}

function classNames(node: FeedNode): string[] {
  return node.className.split(/\s+/).filter(Boolean);
}

function skipped(node: FeedNode): boolean {
  if (node.name === '#text') return false;
  if (SKIP_TAGS.has(node.name)) return true;
  return classNames(node).some((name) => SKIP_CLASSES.has(name));
}

function hasBlockDescendant(node: FeedNode): boolean {
  return node.children.some(
    (child) => BLOCK_TAGS.has(child.name) || hasBlockDescendant(child),
  );
}

function containsBlockedRegion(node: FeedNode): boolean {
  if (node.name === 'pre' || node.name === 'svg' || node.name === 'math') {
    return true;
  }
  return node.children.some(containsBlockedRegion);
}

function plainText(node: FeedNode): string {
  if (node.name === '#text') return node.text;
  if (node.name === 'br' || node.name === 'hr') return '\n';
  if (skipped(node)) return '';
  return node.children.map(plainText).join('');
}

function collectSemantic(node: FeedNode, output: string[]) {
  if (node.name === '#text' || skipped(node)) return;
  if (BLOCK_TAGS.has(node.name) && !hasBlockDescendant(node)) {
    if (!containsBlockedRegion(node)) {
      const text = normalizeBlockText(plainText(node));
      if (isTranslatableText(text)) output.push(text);
    }
  }
  for (const child of node.children) collectSemantic(child, output);
}

function collectFlat(node: FeedNode): string[] {
  const parts: string[] = [];
  let buffer = '';
  const flush = () => {
    const text = normalizeBlockText(buffer);
    buffer = '';
    if (isTranslatableText(text)) parts.push(text);
  };
  const walk = (current: FeedNode) => {
    if (current.name === '#text') {
      const chunks = current.text.split(/\n\s*\n/u);
      chunks.forEach((chunk, chunkIndex) => {
        if (chunkIndex > 0) flush();
        buffer += chunk;
      });
      return;
    }
    if (skipped(current)) return;
    if (current.name === 'br' || current.name === 'hr') {
      flush();
      return;
    }
    for (const child of current.children) walk(child);
  };
  walk(node);
  flush();
  return parts;
}

export function extractHtmlBlockTexts(html: string): string[] {
  const root = parseFeedHtml(html);
  const semantic: string[] = [];
  collectSemantic(root, semantic);
  if (semantic.length > 0) return semantic;
  return collectFlat(root);
}

export function extractFeedBlockTexts(source: FeedBlockSource): string[] {
  const blocks: string[] = [];
  const title = normalizeBlockText(source.title);
  if (isTranslatableText(title)) blocks.push(title);
  const html = source.contentHtml.trim();
  if (html) {
    blocks.push(...extractHtmlBlockTexts(html));
    return blocks;
  }
  const summary = normalizeBlockText(source.summary);
  if (isTranslatableText(summary)) blocks.push(summary);
  return blocks;
}

export async function hashFeedBlocks(texts: string[]): Promise<string> {
  const payload = texts.map(normalizeBlockText).join('\u001e');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function splitLongText(text: string, limit = MAX_PIECE_CHARS): string[] {
  const normalized = text.trim();
  if (normalized.length <= limit) return normalized ? [normalized] : [];
  const parts: string[] = [];
  let rest = normalized;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    for (const mark of ['。', '！', '？', '. ', '! ', '? ', '\n']) {
      const at = window.lastIndexOf(mark);
      if (at >= 0) cut = Math.max(cut, at + mark.length);
    }
    if (cut < Math.floor(limit * 0.4)) cut = limit;
    const piece = rest.slice(0, cut).trim();
    if (!piece) break;
    parts.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function buildPromptPieces(texts: string[]): PromptPiece[] {
  const pieces: PromptPiece[] = [];
  texts.forEach((text, blockId) => {
    for (const piece of splitLongText(text)) {
      pieces.push({ promptId: pieces.length, blockId, text: piece });
    }
  });
  return pieces;
}

export function chunkPromptPieces(
  pieces: PromptPiece[],
  batchSize = FEED_TRANSLATION_BATCH_SIZE,
  charBudget = BATCH_CHAR_BUDGET,
): PromptPiece[][] {
  const batches: PromptPiece[][] = [];
  let current: PromptPiece[] = [];
  let chars = 0;
  for (const piece of pieces) {
    const nextChars = chars + piece.text.length;
    if (
      current.length > 0 &&
      (current.length >= batchSize || nextChars > charBudget)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(piece);
    chars += piece.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function mergePieceTranslations(
  pieces: PromptPiece[],
  translated: Array<{ id: number; translation: string }>,
): Array<{ id: number; translation: string }> {
  const byPrompt = new Map(
    translated.map((item) => [item.id, item.translation.trim()]),
  );
  const grouped = new Map<number, string[]>();
  for (const piece of pieces) {
    const text = byPrompt.get(piece.promptId) ?? '';
    const list = grouped.get(piece.blockId) ?? [];
    if (text) list.push(text);
    grouped.set(piece.blockId, list);
  }
  return [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([id, parts]) => ({ id, translation: parts.join('') }));
}

export interface ChannelTranslationCandidate<T> {
  article: T;
  texts: string[];
  hash: string;
}

export async function selectChannelTranslationTargets<
  T extends FeedBlockSource & { id: string },
>(
  articles: T[],
  lookup: (articleId: string) => Promise<{ contentHash: string } | null>,
  limit = FEED_CHANNEL_TRANSLATION_LIMIT,
  isCancelled?: () => boolean,
): Promise<Array<ChannelTranslationCandidate<T>>> {
  const pending: Array<ChannelTranslationCandidate<T>> = [];
  for (const article of articles) {
    if (isCancelled?.()) break;
    const texts = extractFeedBlockTexts(article);
    if (texts.length === 0) continue;
    const hash = await hashFeedBlocks(texts);
    if (isCancelled?.()) break;
    const saved = await lookup(article.id);
    if (saved?.contentHash === hash) continue;
    pending.push({ article, texts, hash });
    if (pending.length >= limit) break;
  }
  return pending;
}
