export const PDF_SCROLL_GAP = 16;
export const PDF_SCROLL_TOP_PADDING = 20;

export interface PdfScrollWindow {
  start: number;
  end: number;
}

export function buildPdfPageOffsets(
  pageCount: number,
  scale: number,
  defaultHeight: number,
  measuredHeights: Record<number, number>,
): number[] {
  const offsets = [0];
  for (let page = 1; page <= pageCount; page += 1) {
    const height = measuredHeights[page] ?? defaultHeight;
    offsets.push(
      offsets[page - 1] + Math.max(1, height * scale) + PDF_SCROLL_GAP,
    );
  }
  return offsets;
}

export function pdfPageAtOffset(offsets: number[], offset: number): number {
  const pageCount = offsets.length - 1;
  if (pageCount <= 0) return 1;
  let low = 0;
  let high = pageCount - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function pdfWindowAroundPage(
  page: number,
  pageCount: number,
  overscan = 3,
): PdfScrollWindow {
  const safePage = Math.max(1, Math.min(pageCount, page));
  return {
    start: Math.max(1, safePage - overscan),
    end: Math.min(pageCount, safePage + overscan + 1),
  };
}

export function pdfWindowAtScroll(
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 3,
): PdfScrollWindow {
  const pageCount = offsets.length - 1;
  if (pageCount <= 0) return { start: 1, end: 0 };
  const first = pdfPageAtOffset(
    offsets,
    Math.max(0, scrollTop - PDF_SCROLL_TOP_PADDING),
  );
  const last = pdfPageAtOffset(
    offsets,
    Math.max(0, scrollTop - PDF_SCROLL_TOP_PADDING + viewportHeight),
  );
  return {
    start: Math.max(1, first - overscan),
    end: Math.min(pageCount, last + overscan),
  };
}

export function pdfWindowSpacers(
  offsets: number[],
  window: PdfScrollWindow,
): { top: number; bottom: number } {
  const pageCount = offsets.length - 1;
  if (pageCount <= 0 || window.end < window.start) return { top: 0, bottom: 0 };
  const total = offsets[pageCount] - PDF_SCROLL_GAP;
  const lastEnd = offsets[window.end] - PDF_SCROLL_GAP;
  return {
    top: offsets[window.start - 1],
    bottom: Math.max(0, total - lastEnd),
  };
}
