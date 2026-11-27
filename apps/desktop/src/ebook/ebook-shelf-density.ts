import type { CSSProperties } from 'react';

export const MIN_SHELF_COLUMNS = 6;
export const MAX_SHELF_COLUMNS = 11;
export const DEFAULT_SHELF_COLUMNS = 6;
export const SHELF_COLUMNS_STORAGE_KEY = 'seamind:ebook-shelf-columns:v1';

export interface ShelfGridMetrics {
  columns: number;
  t: number; // normalized density in [0, 1]
  gapX: number;
  gapY: number;
  coverRadius: number;
  slipcasePad: number;
  slipcaseGap: number;
  slotRadius: number;
  cardGap: number;
  titleSize: number;
  titleLineHeight: number;
  titleMinHeight: number;
  folderTitleLineHeight: number;
  metaSize: number;
  metaLineHeight: number;
  progressHeight: number;
  footerHeight: number;
  footerGap: number;
  examWidth: number;
  menuWidth: number;
  footerFontSize: number;
  folderActionHeight: number;
  addPlusSize: number;
  badgeSize: number;
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

export function clampShelfColumns(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_SHELF_COLUMNS;
  return Math.min(
    MAX_SHELF_COLUMNS,
    Math.max(MIN_SHELF_COLUMNS, Math.round(raw)),
  );
}

export function loadShelfColumns(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_SHELF_COLUMNS;
  try {
    const raw = localStorage.getItem(SHELF_COLUMNS_STORAGE_KEY);
    if (!raw) return DEFAULT_SHELF_COLUMNS;
    return clampShelfColumns(Number(raw));
  } catch {
    return DEFAULT_SHELF_COLUMNS;
  }
}

export function saveShelfColumns(columns: number): number {
  const clamped = clampShelfColumns(columns);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(SHELF_COLUMNS_STORAGE_KEY, String(clamped));
    } catch {
      // ignore storage quota errors
    }
  }
  return clamped;
}

/**
 * Parametric strict-pixel layout algorithm for bookshelf column counts 6..11.
 * Every column count derives exact integer pixel tracks, gutters, slipcase
 * padding, typography rhythm, and card footer dimensions with zero overflow.
 */
export function computeShelfGridMetrics(
  columnsInput: number,
): ShelfGridMetrics {
  const columns = clampShelfColumns(columnsInput);
  const t =
    (columns - MIN_SHELF_COLUMNS) / (MAX_SHELF_COLUMNS - MIN_SHELF_COLUMNS);

  const gapX = Math.round(20 - 10 * t); // 20 -> 10px
  const gapY = Math.round(24 - 8 * t); // 24 -> 16px
  const coverRadius = columns >= 10 ? 5 : 6;
  const slipcasePad = columns >= 10 ? 4 : columns >= 8 ? 5 : 6;
  const slipcaseGap = columns >= 9 ? 3 : 4;
  const slotRadius = columns >= 9 ? 2 : 3;
  const cardGap = columns >= 10 ? 4 : columns >= 8 ? 5 : 6;

  const titleSize = roundHalf(12.5 - 1.5 * t); // 12.5 -> 11px
  const titleLineHeight = Math.round(18 - 3 * t); // 18 -> 15px
  const titleMinHeight = titleLineHeight * 2; // exact 2-line track
  const folderTitleLineHeight = Math.round(20 - 4 * t); // 20 -> 16px

  const metaSize = roundHalf(11 - 1.5 * t); // 11 -> 9.5px
  const metaLineHeight = columns >= 9 ? 13 : 14;
  const progressHeight = columns >= 9 ? 3 : 4;

  const footerHeight = Math.round(28 - 6 * t); // 28 -> 22px
  const footerGap = columns >= 10 ? 2 : columns >= 8 ? 4 : 6;
  const examWidth = Math.round(52 - 14 * t); // 52 -> 38px
  const menuWidth = Math.round(28 - 8 * t); // 28 -> 20px
  const footerFontSize = roundHalf(11 - 1.5 * t); // 11 -> 9.5px
  const folderActionHeight = Math.round(26 - 6 * t); // 26 -> 20px
  const addPlusSize = Math.round(28 - 8 * t); // 28 -> 20px
  const badgeSize = roundHalf(10 - 1.5 * t); // 10 -> 8.5px

  return {
    columns,
    t,
    gapX,
    gapY,
    coverRadius,
    slipcasePad,
    slipcaseGap,
    slotRadius,
    cardGap,
    titleSize,
    titleLineHeight,
    titleMinHeight,
    folderTitleLineHeight,
    metaSize,
    metaLineHeight,
    progressHeight,
    footerHeight,
    footerGap,
    examWidth,
    menuWidth,
    footerFontSize,
    folderActionHeight,
    addPlusSize,
    badgeSize,
  };
}

export function buildShelfGridCssVars(columnsInput: number): CSSProperties {
  const m = computeShelfGridMetrics(columnsInput);
  const vars: Record<string, string> = {
    '--shelf-cols': String(m.columns),
    '--shelf-gap-x': `${m.gapX}px`,
    '--shelf-gap-y': `${m.gapY}px`,
    '--shelf-cover-radius': `${m.coverRadius}px`,
    '--shelf-slipcase-pad': `${m.slipcasePad}px`,
    '--shelf-slipcase-gap': `${m.slipcaseGap}px`,
    '--shelf-slot-radius': `${m.slotRadius}px`,
    '--shelf-card-gap': `${m.cardGap}px`,
    '--shelf-title-size': `${m.titleSize}px`,
    '--shelf-title-lh': `${m.titleLineHeight}px`,
    '--shelf-title-min-h': `${m.titleMinHeight}px`,
    '--shelf-folder-title-lh': `${m.folderTitleLineHeight}px`,
    '--shelf-meta-size': `${m.metaSize}px`,
    '--shelf-meta-lh': `${m.metaLineHeight}px`,
    '--shelf-progress-h': `${m.progressHeight}px`,
    '--shelf-footer-h': `${m.footerHeight}px`,
    '--shelf-footer-gap': `${m.footerGap}px`,
    '--shelf-exam-w': `${m.examWidth}px`,
    '--shelf-menu-w': `${m.menuWidth}px`,
    '--shelf-footer-font': `${m.footerFontSize}px`,
    '--shelf-folder-action-h': `${m.folderActionHeight}px`,
    '--shelf-add-plus-size': `${m.addPlusSize}px`,
    '--shelf-badge-size': `${m.badgeSize}px`,
  };
  return vars as CSSProperties;
}
