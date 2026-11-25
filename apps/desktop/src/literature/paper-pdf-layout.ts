import { Util, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import type { PaperAnnotationRect } from './types';
import { bookmarkKey, preferenceKey } from './paper-reader-keys';
export { bookmarkKey, preferenceKey } from './paper-reader-keys';

export interface RawTextBox {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL?: boolean;
  isVertical?: boolean;
}

export interface PaperParagraphBlock {
  id: number;
  pageNumber: number;
  column: 'full' | 'left' | 'right';
  text: string;
  bbox: PaperAnnotationRect;
  rects: PaperAnnotationRect[];
  isHeading: boolean;
}

interface LineSegment {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rect: PaperAnnotationRect;
}

interface PositionedSegment extends LineSegment {
  column: 'full' | 'left' | 'right';
}

const CJK_CHAR_RE = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;
const PURE_SYMBOL_OR_NUMBER_RE = /^[\d\s.,+\-*/=<>()[\]{}|\\^_~:;'"`·•…]+$/u;
const PAGE_NUMBER_RE =
  /^(?:\d{1,4}|[-—]\s*\d{1,4}\s*[-—]|(?:page|p\.?)\s*\d+(?:\s*\/\s*\d+)?)$/i;
const ARXIV_MARGIN_RE = /^\s*arXiv:\S+/i;
const SENTENCE_END_RE = /[.?!。？！:：]["')\]）]?\s*$/u;
const HEADING_PREFIX_RE =
  /^(?:\d+(?:\.\d+)*\.?\s+\S|[IVX]+\.\s+\S|Abstract\b|Keywords?\b|Introduction\b|Related\s+Work\b|Background\b|Methodology\b|Methods?\b|Experiments?\b|Evaluation\b|Discussion\b|Limitations?\b|Conclusion\b|References\b|Acknowledgments?\b|Appendix\b)/i;

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function median(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function joinTokens(left: string, right: string, gapRatio: number): string {
  const a = left.trimEnd();
  const b = right.trimStart();
  if (!a) return b;
  if (!b) return a;
  if (/[A-Za-z]{2,}-$/u.test(a) && /^[a-z]{2,}/u.test(b) && gapRatio < 0.8) {
    return `${a.slice(0, -1)}${b}`;
  }
  const lastChar = a[a.length - 1];
  const firstChar = b[0];
  if (CJK_CHAR_RE.test(lastChar) && CJK_CHAR_RE.test(firstChar)) {
    return `${a}${b}`;
  }
  if (/^[,.;:!?%)\]]/u.test(b) || /[(["'“‘]$/u.test(a)) {
    return `${a}${b}`;
  }
  if (a.endsWith('-') && gapRatio < 0.2) {
    return `${a}${b}`;
  }
  return `${a} ${b}`;
}

function joinWrappedLines(lines: string[]): string {
  let result = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!result) {
      result = line;
      continue;
    }
    if (/[A-Za-z]{2,}-$/u.test(result) && /^[a-z]{2,}/u.test(line)) {
      result = `${result.slice(0, -1)}${line}`;
      continue;
    }
    const lastChar = result[result.length - 1];
    const firstChar = line[0];
    if (CJK_CHAR_RE.test(lastChar) && CJK_CHAR_RE.test(firstChar)) {
      result = `${result}${line}`;
    } else {
      result = `${result} ${line}`;
    }
  }
  return result.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Cleans academic PDF text copied from a selection (de-hyphenates line-wrap hyphens
 * and flattens soft line breaks while preserving intentional paragraph breaks).
 */
export function cleanPdfSelectionText(raw: string): string {
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim();
  if (!normalized) return '';

  const paragraphs = normalized.split(/\n[ \t]*\n+/);
  return paragraphs
    .map((paragraph) => joinWrappedLines(paragraph.split('\n')))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Returns true when a selection represents a short vocabulary item or technical term
 * suitable for dictionary / terminology lookup rather than passage translation.
 */
export function isShortTermSelection(text: string): boolean {
  const cleaned = cleanPdfSelectionText(text).replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.includes('\n')) return false;
  if (cleaned.length > 42) return false;
  if (/[.?!。？！;；]/.test(cleaned)) return false;
  if (PURE_SYMBOL_OR_NUMBER_RE.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (CJK_CHAR_RE.test(cleaned)) {
    return cleaned.length <= 12;
  }
  return words.length >= 1 && words.length <= 3;
}

function unionRects(rects: PaperAnnotationRect[]): PaperAnnotationRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  const x = clampUnit(minX);
  const y = clampUnit(minY);
  return {
    x,
    y,
    width: clampUnit(maxX - x),
    height: clampUnit(maxY - y),
  };
}

function splitRowIntoSegments(
  row: RawTextBox[],
  medianH: number,
): LineSegment[] {
  const sorted = [...row].sort((a, b) => a.x - b.x);
  const segments: LineSegment[] = [];
  const colGapThreshold = Math.max(0.038, medianH * 2.5);

  let group: RawTextBox[] = [];
  let text = '';

  const flush = () => {
    if (group.length === 0) return;
    const clean = text.replace(/[ \t]{2,}/g, ' ').trim();
    if (!clean) {
      group = [];
      text = '';
      return;
    }
    const rect = unionRects(group);
    segments.push({
      text: clean,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      rect,
    });
    group = [];
    text = '';
  };

  for (const box of sorted) {
    const trimmed = box.str.trim();
    if (!trimmed) {
      if (text && !text.endsWith(' ')) text += ' ';
      continue;
    }
    if (group.length === 0) {
      group.push(box);
      text = trimmed;
      continue;
    }
    const prev = group[group.length - 1];
    const gap = box.x - (prev.x + prev.width);
    if (gap > colGapThreshold) {
      flush();
      group.push(box);
      text = trimmed;
    } else {
      const gapRatio = gap / Math.max(medianH, 0.008);
      text = joinTokens(text, trimmed, gapRatio);
      group.push(box);
    }
  }
  flush();
  return segments;
}

function detectTwoColumnZones(segments: LineSegment[]): PositionedSegment[] {
  const prelim = segments.map((seg) => {
    const rightEdge = seg.x + seg.width;
    let column: 'full' | 'left' | 'right' = 'full';
    if (seg.x < 0.44 && rightEdge > 0.56) {
      column = 'full';
    } else if (rightEdge <= 0.535) {
      column = 'left';
    } else if (seg.x >= 0.465) {
      column = 'right';
    }
    return { ...seg, column };
  });

  const leftItems = prelim.filter((s) => s.column === 'left');
  const rightItems = prelim.filter((s) => s.column === 'right');

  let verticalOverlapCount = 0;
  for (const left of leftItems) {
    for (const right of rightItems) {
      const overlap =
        Math.min(left.y + left.height, right.y + right.height) -
        Math.max(left.y, right.y);
      if (overlap > Math.min(left.height, right.height) * 0.25) {
        verticalOverlapCount += 1;
        break;
      }
    }
  }

  const isTwoColumn =
    leftItems.length >= 2 &&
    rightItems.length >= 2 &&
    (verticalOverlapCount >= 2 || rightItems.length >= 4);

  if (!isTwoColumn) {
    return prelim
      .map((s) => ({ ...s, column: 'full' as const }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }

  // Partition vertically at full-span bands (e.g. centered title/abstract or wide figures)
  // so two-column zones between full-span bands are ordered left-column then right-column.
  const ySorted = [...prelim].sort((a, b) => a.y - b.y || a.x - b.x);
  const ordered: PositionedSegment[] = [];
  let zoneLeft: PositionedSegment[] = [];
  let zoneRight: PositionedSegment[] = [];

  const flushZone = () => {
    zoneLeft.sort((a, b) => a.y - b.y || a.x - b.x);
    zoneRight.sort((a, b) => a.y - b.y || a.x - b.x);
    ordered.push(...zoneLeft, ...zoneRight);
    zoneLeft = [];
    zoneRight = [];
  };

  for (const item of ySorted) {
    if (item.column === 'full') {
      flushZone();
      ordered.push(item);
    } else if (item.column === 'left') {
      zoneLeft.push(item);
    } else {
      zoneRight.push(item);
    }
  }
  flushZone();
  return ordered;
}

function shouldFilterMarginOrNoise(seg: LineSegment): boolean {
  const text = seg.text.trim();
  if (!text) return true;
  if (ARXIV_MARGIN_RE.test(text) && (seg.x < 0.08 || seg.y < 0.06)) {
    return true;
  }
  if (seg.y < 0.062 || seg.y + seg.height > 0.938) {
    if (PAGE_NUMBER_RE.test(text) || text.length <= 72) {
      return true;
    }
  }
  if (PURE_SYMBOL_OR_NUMBER_RE.test(text) && text.length <= 24) {
    return true;
  }
  return false;
}

/**
 * Pure layout grouping helper that reconstructs reading-order paragraphs and
 * normalized highlight rectangles from extracted PDF text boxes.
 */
export function groupTextBoxesIntoParagraphs(
  boxes: RawTextBox[],
  pageNumber: number,
): PaperParagraphBlock[] {
  const usable = boxes
    .filter((b) => !b.isVertical && b.str.trim().length > 0 && b.height > 0.002)
    .map((b) => ({
      ...b,
      x: clampUnit(b.x),
      y: clampUnit(b.y),
      width: clampUnit(b.width),
      height: clampUnit(b.height),
    }));

  if (usable.length === 0) return [];

  const medianH = median(
    usable.map((b) => b.height),
    0.014,
  );

  // Cluster into horizontal visual rows based on vertical center overlap
  const sortedByY = [...usable].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: RawTextBox[][] = [];
  for (const box of sortedByY) {
    const centerY = box.y + box.height * 0.5;
    let matchedRow: RawTextBox[] | null = null;
    for (let i = rows.length - 1; i >= 0 && i >= rows.length - 6; i -= 1) {
      const ref = rows[i][0];
      const refCenterY = ref.y + ref.height * 0.5;
      const tol = Math.max(
        Math.min(box.height, ref.height) * 0.6,
        medianH * 0.45,
      );
      if (Math.abs(centerY - refCenterY) <= tol) {
        matchedRow = rows[i];
        break;
      }
    }
    if (matchedRow) {
      matchedRow.push(box);
    } else {
      rows.push([box]);
    }
  }

  const allSegments: LineSegment[] = [];
  for (const row of rows) {
    for (const seg of splitRowIntoSegments(row, medianH)) {
      if (!shouldFilterMarginOrNoise(seg)) {
        allSegments.push(seg);
      }
    }
  }

  if (allSegments.length === 0) return [];

  const bodyMedianH = median(
    allSegments.map((s) => s.height),
    medianH,
  );
  const ordered = detectTwoColumnZones(allSegments);

  // Measure typical inter-line spacing inside same column
  const positiveGaps: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    if (prev.column !== curr.column) continue;
    const gap = curr.y - (prev.y + prev.height);
    if (gap > -bodyMedianH * 0.25 && gap < bodyMedianH * 1.4) {
      positiveGaps.push(gap);
    }
  }
  const medianGap = median(positiveGaps, bodyMedianH * 0.35);

  const columnLeftX = {
    full: Math.min(
      ...ordered.filter((s) => s.column === 'full').map((s) => s.x),
      1,
    ),
    left: Math.min(
      ...ordered.filter((s) => s.column === 'left').map((s) => s.x),
      1,
    ),
    right: Math.min(
      ...ordered.filter((s) => s.column === 'right').map((s) => s.x),
      1,
    ),
  };
  const columnWidth = {
    full: Math.max(
      ...ordered.filter((s) => s.column === 'full').map((s) => s.width),
      0.7,
    ),
    left: Math.max(
      ...ordered.filter((s) => s.column === 'left').map((s) => s.width),
      0.38,
    ),
    right: Math.max(
      ...ordered.filter((s) => s.column === 'right').map((s) => s.width),
      0.38,
    ),
  };

  const blocks: PaperParagraphBlock[] = [];
  let currentGroup: PositionedSegment[] = [];

  const flushParagraph = () => {
    if (currentGroup.length === 0) return;
    const mergedText = joinWrappedLines(currentGroup.map((s) => s.text));
    if (
      !mergedText ||
      (PURE_SYMBOL_OR_NUMBER_RE.test(mergedText) && mergedText.length <= 28)
    ) {
      currentGroup = [];
      return;
    }
    const avgHeight =
      currentGroup.reduce((sum, s) => sum + s.height, 0) / currentGroup.length;
    const isHeading =
      (avgHeight > bodyMedianH * 1.13 && mergedText.length <= 160) ||
      (currentGroup.length <= 2 &&
        HEADING_PREFIX_RE.test(mergedText) &&
        mergedText.length <= 105 &&
        !SENTENCE_END_RE.test(mergedText));
    const rects = currentGroup.map((s) => s.rect);
    blocks.push({
      id: blocks.length,
      pageNumber,
      column: currentGroup[0].column,
      text: mergedText,
      bbox: unionRects(rects),
      rects,
      isHeading,
    });
    currentGroup = [];
  };

  for (const seg of ordered) {
    if (currentGroup.length === 0) {
      currentGroup.push(seg);
      continue;
    }
    const prev = currentGroup[currentGroup.length - 1];
    const gap = seg.y - (prev.y + prev.height);
    const sameColumn = prev.column === seg.column && seg.y + 0.005 >= prev.y;
    const heightJump = Math.abs(seg.height - prev.height) > bodyMedianH * 0.22;
    const largeVerticalGap =
      gap > Math.max(medianGap + bodyMedianH * 0.42, bodyMedianH * 0.78);
    const colBaseX = columnLeftX[seg.column];
    const colW = Math.max(0.25, columnWidth[seg.column]);
    const isIndented = seg.x - colBaseX > bodyMedianH * 0.95;
    const prevShortTerminal =
      prev.width < colW * 0.8 &&
      SENTENCE_END_RE.test(prev.text) &&
      !/[A-Za-z]-$/u.test(prev.text);
    const newHeadingStart =
      HEADING_PREFIX_RE.test(seg.text) &&
      (prevShortTerminal || gap > bodyMedianH * 0.35);

    if (
      !sameColumn ||
      heightJump ||
      largeVerticalGap ||
      (isIndented && SENTENCE_END_RE.test(prev.text)) ||
      (isIndented && prev.width < colW * 0.88) ||
      prevShortTerminal ||
      newHeadingStart
    ) {
      flushParagraph();
    }
    currentGroup.push(seg);
  }
  flushParagraph();

  return blocks;
}

/**
 * Extracts coordinate-grouped paragraph blocks from a rendered PDF.js page.
 */
export async function extractPageParagraphBlocks(
  page: PDFPageProxy,
): Promise<PaperParagraphBlock[]> {
  const viewport = page.getViewport({ scale: 1 });
  const pageWidth = Math.max(1, viewport.width);
  const pageHeight = Math.max(1, viewport.height);
  const content = await page.getTextContent();
  const boxes: RawTextBox[] = [];

  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue;
    const tx = Util.transform(viewport.transform, item.transform);
    const [a, b, c, d, originX, baselineY] = tx;
    const fontHeight = Math.max(
      Math.hypot(c, d),
      Math.hypot(a, b),
      item.height || 0,
      4,
    );
    const isVertical =
      Math.abs(b) > Math.abs(a) * 1.4 && Math.abs(c) > Math.abs(d) * 1.4;
    const widthPx = Math.max(item.width || 0, 1);
    const topPx = baselineY - fontHeight * 0.84;

    boxes.push({
      str: item.str,
      x: originX / pageWidth,
      y: topPx / pageHeight,
      width: widthPx / pageWidth,
      height: fontHeight / pageHeight,
      hasEOL: item.hasEOL,
      isVertical,
    });
  }

  return groupTextBoxesIntoParagraphs(boxes, page.pageNumber);
}

/**
 * Computes a lowercase 64-character SHA-256 hex digest for a page's paragraph payload.
 */
export async function computePageContentHash(
  blocks: Array<{ id: number; text: string }>,
): Promise<string> {
  const normalized = blocks
    .map((b) => `${b.id}:${b.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  const bytes = new TextEncoder().encode(normalized);

  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  // Deterministic 256-bit fallback digest for environments without WebCrypto
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  for (let i = 0; i < bytes.length; i += 1) {
    const slot = i & 7;
    h[slot] = Math.imul(h[slot] ^ bytes[i], 0x01000193) >>> 0;
    h[(slot + 1) & 7] =
      ((h[(slot + 1) & 7] << 5) | (h[(slot + 1) & 7] >>> 27)) ^ h[slot];
  }
  return Array.from(h)
    .map((word) => (word >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

export type ReaderMode = 'auto' | 'single' | 'spread' | 'scroll';
export type ResolvedReaderMode = Exclude<ReaderMode, 'auto'>;
export type ZoomMode = 'fitPage' | 'fitWidth' | 'manual';
export type SidebarTab =
  'outline' | 'search' | 'annotations' | 'bookmarks' | 'translation';

export interface ReaderPreferences {
  mode: ReaderMode;
  zoomMode: ZoomMode;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
}

interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
}

export interface PdfOutlineEntry {
  title: string;
  pageNumber: number;
  depth: number;
}

export interface PaperBookmark {
  id: string;
  pageNumber: number;
  label: string;
  createdAt: number;
}

export interface PaperSearchResult {
  pageNumber: number;
  excerpt: string;
  matchCount: number;
}

export const ANNOTATION_COLORS = ['#f4d35e', '#8bd3dd', '#b8a1e3', '#f4978e'];
export const MIN_SCALE = 0.35;
export const MAX_SCALE = 3;
export const DEFAULT_PREFERENCES: ReaderPreferences = {
  mode: 'auto',
  zoomMode: 'fitPage',
  sidebarOpen: true,
  sidebarTab: 'annotations',
};

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function readPreferences(
  paperId: string,
  sha256: string,
): ReaderPreferences {
  try {
    const stored = JSON.parse(
      localStorage.getItem(preferenceKey(paperId, sha256)) || 'null',
    );
    if (!stored || typeof stored !== 'object') return DEFAULT_PREFERENCES;
    return {
      mode: ['auto', 'single', 'spread', 'scroll'].includes(stored.mode)
        ? stored.mode
        : DEFAULT_PREFERENCES.mode,
      zoomMode: ['fitPage', 'fitWidth', 'manual'].includes(stored.zoomMode)
        ? stored.zoomMode
        : DEFAULT_PREFERENCES.zoomMode,
      sidebarOpen:
        typeof stored.sidebarOpen === 'boolean'
          ? stored.sidebarOpen
          : DEFAULT_PREFERENCES.sidebarOpen,
      sidebarTab: [
        'outline',
        'search',
        'annotations',
        'bookmarks',
        'translation',
      ].includes(stored.sidebarTab)
        ? stored.sidebarTab
        : DEFAULT_PREFERENCES.sidebarTab,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function readBookmarks(
  paperId: string,
  sha256: string,
): PaperBookmark[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(bookmarkKey(paperId, sha256)) || '[]',
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is PaperBookmark =>
        entry &&
        typeof entry.id === 'string' &&
        Number.isInteger(entry.pageNumber) &&
        typeof entry.label === 'string',
    );
  } catch {
    return [];
  }
}

export function resolvedMode(
  mode: ReaderMode,
  width: number,
  height: number,
): ResolvedReaderMode {
  if (mode === 'scroll') return 'scroll';
  if (mode === 'single') return 'single';
  if (mode === 'spread') return width < 720 ? 'single' : 'spread';
  return width >= 1080 && height >= 470 ? 'spread' : 'single';
}

export function pagesForMode(
  pageNumber: number,
  pageCount: number,
  mode: ResolvedReaderMode,
): number[] {
  if (mode !== 'spread') return [pageNumber];
  const first = pageNumber % 2 === 0 ? pageNumber - 1 : pageNumber;
  return first + 1 <= pageCount ? [first, first + 1] : [first];
}

export function spreadStart(pageNumber: number): number {
  return pageNumber % 2 === 0 ? pageNumber - 1 : pageNumber;
}

export async function fitScaleFor(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  pageCount: number,
  mode: ResolvedReaderMode,
  width: number,
  height: number,
  fit: Exclude<ZoomMode, 'manual'>,
) {
  const pages = pagesForMode(pageNumber, pageCount, mode);
  const viewports = await Promise.all(
    pages.map(async (number) =>
      (await pdf.getPage(number)).getViewport({ scale: 1 }),
    ),
  );
  const pageWidth =
    viewports.reduce((total, viewport) => total + viewport.width, 0) +
    (pages.length > 1 ? 18 : 0);
  const pageHeight = Math.max(...viewports.map((viewport) => viewport.height));
  const availableWidth = Math.max(180, width - 56);
  const availableHeight = Math.max(160, height - 52);
  const scale =
    fit === 'fitWidth'
      ? availableWidth / pageWidth
      : Math.min(availableWidth / pageWidth, availableHeight / pageHeight);
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

export async function readPdfOutline(
  pdf: PDFDocumentProxy,
): Promise<PdfOutlineEntry[]> {
  const nodes = (await pdf.getOutline()) as PdfOutlineNode[];
  const entries: PdfOutlineEntry[] = [];

  const visit = async (items: PdfOutlineNode[], depth: number) => {
    for (const item of items) {
      let destination: unknown[] | null = null;
      if (typeof item.dest === 'string') {
        destination = await pdf.getDestination(item.dest);
      } else if (Array.isArray(item.dest)) {
        destination = item.dest;
      }
      const reference = destination?.[0];
      if (reference) {
        try {
          const pageIndex = await pdf.getPageIndex(reference as never);
          entries.push({
            title: item.title || `第 ${pageIndex + 1} 页`,
            pageNumber: pageIndex + 1,
            depth,
          });
        } catch {
          // Ignore destinations that refer to missing or malformed pages.
        }
      }
      if (item.items?.length) await visit(item.items, depth + 1);
    }
  };

  if (nodes?.length) await visit(nodes, 0);
  return entries;
}
