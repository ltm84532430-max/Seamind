import { formatEstimatedRows } from './db-connection-utils';
import { cardinalityEnds } from './db-er-codec';
import { calcErEdgePath } from './db-er-layout';
import {
  ER_CARD_WIDTH,
  ER_HEADER_H,
  ER_ROW_H,
  ER_SUBMETA_H,
  estimateTableCardHeight,
  hasTableSubmeta,
  type ErDiagramState,
  type ErRelation,
  type ErTable,
} from './db-er-model';
import { formatFileSizeCompact } from './terminal-codelab-model';
import type { Theme } from '../app/app-storage';

/* ==========================================================================
   Seamind Database ER Studio — Pixel-Perfect PNG & Lossless PDF Export Engine
   Zero external dependencies. Native high-DPI SVG rasterization + RFC 1950
   FlateDecode PNG-Sub-filtered ISO 32000-1 PDF 1.4 generator with seamless
   strip tiling (bypasses WebView2 canvas height limits for giant schemas).
   ========================================================================== */

export type ErVisualExportFormat = 'png' | 'pdf' | 'svg';
export type ErExportPaletteMode = 'auto' | 'light' | 'dark';
export type ErExportScale = 2 | 3 | 4;
export type ErPdfPageMode = 'single-page' | 'a4-tiled' | 'a3-tiled';
export type ErPdfOrientation = 'auto' | 'portrait' | 'landscape';

export interface ErVisualExportOptions {
  format: ErVisualExportFormat;
  paletteMode: ErExportPaletteMode;
  appTheme: Theme;
  scale: ErExportScale;
  expandAllColumns: boolean;
  includeGrid: boolean;
  includeHeaderLegend: boolean;
  showRelationLabels: boolean;
  pdfPageMode: ErPdfPageMode;
  pdfOrientation: ErPdfOrientation;
}

export interface ErSvgExportDocument {
  svg: string;
  viewBoxX: number;
  viewBoxY: number;
  width: number;
  height: number;
  backgroundHex: string;
  backgroundRgb: [number, number, number];
  tableCount: number;
  relationCount: number;
  areaCount: number;
}

export interface ErExportResolutionPlan {
  worldWidth: number;
  worldHeight: number;
  requestedScale: number;
  effectiveScale: number;
  clamped: boolean;
  pixelWidth: number;
  pixelHeight: number;
  pdfPageCount: number;
  pdfGridCols: number;
  pdfGridRows: number;
  pdfPageWidthPt: number;
  pdfPageHeightPt: number;
  pdfStripCount: number;
}

export interface ErExportProgress {
  stage: 'svg' | 'raster' | 'encode' | 'write';
  label: string;
  current?: number;
  total?: number;
}

interface ExportPalette {
  bg: string;
  bgRgb: [number, number, number];
  cardBg: string;
  cardHeaderBg: string;
  submetaBg: string;
  cardBorder: string;
  rowDivider: string;
  pkRowBg: string;
  ink: string;
  muted: string;
  schemaInk: string;
  gridDot: string;
  edgePhys: string;
  edgeLogic: string;
  edgeInf: string;
  shadowColor: string;
  pkPillBg: string;
  pkPillInk: string;
  fkPillBg: string;
  fkPillInk: string;
  ukPillBg: string;
  ukPillInk: string;
  nullDotStroke: string;
  nnDotFill: string;
  warnDotFill: string;
  noteDotFill: string;
  headerBg: string;
  headerBorder: string;
  badgeBg: string;
  badgeBorder: string;
  isDark: boolean;
}

const MAX_PNG_CANVAS_DIM = 16000;
const MAX_PNG_CANVAS_PIXELS = 96_000_000;
const MAX_PDF_SINGLE_PAGE_PT = 14000;
const MAX_PDF_STRIP_PIXELS_H = 3072;
const MAX_PDF_STRIP_PIXELS_AREA = 24_000_000;
const MAX_PDF_SINGLE_PIXEL_W = 12000;
const PDF_PT_PER_WORLD_PX = 0.75;
const PDF_TILED_MARGIN_PT = 28;
const PDF_TILED_FOOTER_PT = 16;
const PDF_TILED_SCALE_PT_PER_PX = 0.56;

const PAPER_SIZES_PT: Record<'a4-tiled' | 'a3-tiled', [number, number]> = {
  'a4-tiled': [595.28, 841.89],
  'a3-tiled': [841.89, 1190.55],
};

function resolveExportPalette(
  mode: ErExportPaletteMode,
  appTheme: Theme,
): ExportPalette {
  const effectiveTheme: Theme =
    mode === 'light'
      ? 'light'
      : mode === 'dark'
        ? appTheme === 'navy' || appTheme === 'purple'
          ? appTheme
          : 'dark'
        : appTheme;

  if (effectiveTheme === 'light') {
    return {
      bg: '#f8fafc',
      bgRgb: [248, 250, 252],
      cardBg: '#ffffff',
      cardHeaderBg: '#f8fafc',
      submetaBg: '#f1f5f9',
      cardBorder: '#cbd5e1',
      rowDivider: '#e8edf3',
      pkRowBg: 'rgba(70, 123, 94, 0.06)',
      ink: '#0f172a',
      muted: '#64748b',
      schemaInk: '#64748b',
      gridDot: 'rgba(100, 116, 139, 0.22)',
      edgePhys: '#3d7458',
      edgeLogic: '#2f6b8f',
      edgeInf: '#94a3b8',
      shadowColor: 'rgba(15, 23, 42, 0.09)',
      pkPillBg: 'rgba(217, 119, 6, 0.14)',
      pkPillInk: '#b45309',
      fkPillBg: 'rgba(37, 99, 235, 0.13)',
      fkPillInk: '#1d4ed8',
      ukPillBg: 'rgba(124, 58, 237, 0.13)',
      ukPillInk: '#6d28d9',
      nullDotStroke: '#94a3b8',
      nnDotFill: '#475569',
      warnDotFill: '#dc2626',
      noteDotFill: '#3d7458',
      headerBg: '#ffffff',
      headerBorder: '#dbe3ec',
      badgeBg: '#f1f5f9',
      badgeBorder: '#cbd5e1',
      isDark: false,
    };
  }

  if (effectiveTheme === 'navy') {
    return {
      bg: '#0f1624',
      bgRgb: [15, 22, 36],
      cardBg: '#162033',
      cardHeaderBg: '#1b2840',
      submetaBg: '#121b2b',
      cardBorder: '#2a3a56',
      rowDivider: '#202e46',
      pkRowBg: 'rgba(109, 179, 143, 0.10)',
      ink: '#e6edf8',
      muted: '#8da2be',
      schemaInk: '#8da2be',
      gridDot: 'rgba(148, 174, 214, 0.17)',
      edgePhys: '#6ec09a',
      edgeLogic: '#69b0e0',
      edgeInf: '#6f84a2',
      shadowColor: 'rgba(0, 0, 0, 0.42)',
      pkPillBg: 'rgba(245, 158, 11, 0.20)',
      pkPillInk: '#fbbf24',
      fkPillBg: 'rgba(96, 165, 250, 0.20)',
      fkPillInk: '#93c5fd',
      ukPillBg: 'rgba(192, 132, 252, 0.20)',
      ukPillInk: '#d8b4fe',
      nullDotStroke: '#647996',
      nnDotFill: '#a6bad6',
      warnDotFill: '#f87171',
      noteDotFill: '#6ec09a',
      headerBg: '#141e30',
      headerBorder: '#273652',
      badgeBg: '#1b2840',
      badgeBorder: '#304363',
      isDark: true,
    };
  }

  if (effectiveTheme === 'purple') {
    return {
      bg: '#151221',
      bgRgb: [21, 18, 33],
      cardBg: '#1d192e',
      cardHeaderBg: '#241f38',
      submetaBg: '#181526',
      cardBorder: '#352e52',
      rowDivider: '#292340',
      pkRowBg: 'rgba(128, 198, 162, 0.10)',
      ink: '#ece8f8',
      muted: '#9e95ba',
      schemaInk: '#9e95ba',
      gridDot: 'rgba(167, 154, 206, 0.18)',
      edgePhys: '#76c59e',
      edgeLogic: '#7ab3e0',
      edgeInf: '#7d749c',
      shadowColor: 'rgba(0, 0, 0, 0.44)',
      pkPillBg: 'rgba(245, 158, 11, 0.20)',
      pkPillInk: '#fbbf24',
      fkPillBg: 'rgba(96, 165, 250, 0.20)',
      fkPillInk: '#93c5fd',
      ukPillBg: 'rgba(192, 132, 252, 0.22)',
      ukPillInk: '#e9d5ff',
      nullDotStroke: '#786f96',
      nnDotFill: '#bcb3d9',
      warnDotFill: '#f87171',
      noteDotFill: '#76c59e',
      headerBg: '#1a1629',
      headerBorder: '#302a4a',
      badgeBg: '#231e38',
      badgeBorder: '#3b335c',
      isDark: true,
    };
  }

  // Default dark theme (matches Seamind dark terminal canvas)
  return {
    bg: '#13171d',
    bgRgb: [19, 23, 29],
    cardBg: '#1b212a',
    cardHeaderBg: '#202833',
    submetaBg: '#171d25',
    cardBorder: '#313b4a',
    rowDivider: '#262f3c',
    pkRowBg: 'rgba(109, 179, 143, 0.09)',
    ink: '#e8eef5',
    muted: '#8d99a8',
    schemaInk: '#8d99a8',
    gridDot: 'rgba(148, 163, 184, 0.18)',
    edgePhys: '#6db38f',
    edgeLogic: '#69a7d1',
    edgeInf: '#707d8e',
    shadowColor: 'rgba(0, 0, 0, 0.38)',
    pkPillBg: 'rgba(245, 158, 11, 0.18)',
    pkPillInk: '#fbbf24',
    fkPillBg: 'rgba(96, 165, 250, 0.18)',
    fkPillInk: '#93c5fd',
    ukPillBg: 'rgba(192, 132, 252, 0.18)',
    ukPillInk: '#d8b4fe',
    nullDotStroke: '#667385',
    nnDotFill: '#a8b4c4',
    warnDotFill: '#f87171',
    noteDotFill: '#6db38f',
    headerBg: '#181e26',
    headerBorder: '#2b3442',
    badgeBg: '#202833',
    badgeBorder: '#354050',
    isDark: true,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isWideCharCode(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

function estimateTextPx(text: string, fontSize: number, mono: boolean): number {
  let units = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isWideCharCode(code)) {
      units += 1.02;
    } else if (mono) {
      units += 0.61;
    } else if (
      code === 105 ||
      code === 108 ||
      code === 73 ||
      code === 46 ||
      code === 44 ||
      code === 58
    ) {
      units += 0.34;
    } else if (code >= 65 && code <= 90) {
      units += 0.68;
    } else {
      units += 0.56;
    }
  }
  return units * fontSize;
}

function fitTextToWidth(
  text: string,
  maxWidthPx: number,
  fontSize: number,
  mono: boolean,
): string {
  if (!text) return '';
  if (estimateTextPx(text, fontSize, mono) <= maxWidthPx) return text;
  const ellipsisW = estimateTextPx('…', fontSize, mono);
  const budget = Math.max(fontSize, maxWidthPx - ellipsisW);
  let acc = 0;
  let end = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const w = estimateTextPx(ch, fontSize, mono);
    if (acc + w > budget) break;
    acc += w;
    end = i + 1;
  }
  return end > 0 ? `${text.slice(0, end)}…` : '…';
}

function wrapNoteLines(
  content: string,
  maxWidthPx: number,
  fontSize: number,
  maxLines: number,
): string[] {
  const out: string[] = [];
  const paragraphs = (content || '').replace(/\r\n/g, '\n').split('\n');
  for (const para of paragraphs) {
    if (out.length >= maxLines) break;
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (let i = 0; i < para.length; i += 1) {
      const ch = para[i];
      const next = line + ch;
      if (
        line.length > 0 &&
        estimateTextPx(next, fontSize, false) > maxWidthPx
      ) {
        out.push(line);
        if (out.length >= maxLines) break;
        line = ch;
      } else {
        line = next;
      }
    }
    if (out.length < maxLines && line) {
      out.push(line);
    }
  }
  if (out.length === maxLines && paragraphs.join('\n').length > 0) {
    const last = out[out.length - 1];
    if (estimateTextPx(last, fontSize, false) > maxWidthPx - fontSize) {
      out[out.length - 1] = fitTextToWidth(last, maxWidthPx, fontSize, false);
    }
  }
  return out;
}

function renderCrowsFootExportSvg(
  pt: { x: number; y: number },
  dir: 1 | -1,
  side: 'one' | 'many' | 'zero-one' | 'zero-many',
  stroke: string,
  hollowFill: string,
): string {
  const ux = dir;
  const x0 = pt.x;
  const y0 = pt.y;
  const x1 = x0 + ux * 12;
  const x2 = x0 + ux * 17;

  if (side === 'one') {
    return (
      `<line x1="${x0 + ux * 7}" y1="${y0 - 6}" x2="${x0 + ux * 7}" y2="${y0 + 6}" stroke="${stroke}" stroke-width="1.65" stroke-linecap="round"/>` +
      `<line x1="${x0 + ux * 12}" y1="${y0 - 6}" x2="${x0 + ux * 12}" y2="${y0 + 6}" stroke="${stroke}" stroke-width="1.65" stroke-linecap="round"/>`
    );
  }
  if (side === 'zero-one') {
    return (
      `<line x1="${x0 + ux * 7}" y1="${y0 - 6}" x2="${x0 + ux * 7}" y2="${y0 + 6}" stroke="${stroke}" stroke-width="1.65" stroke-linecap="round"/>` +
      `<circle cx="${x2}" cy="${y0}" r="4" fill="${hollowFill}" stroke="${stroke}" stroke-width="1.55"/>`
    );
  }
  const prongs =
    `<line x1="${x1}" y1="${y0}" x2="${x0 + ux * 2}" y2="${y0 - 7}" stroke="${stroke}" stroke-width="1.65" stroke-linecap="round"/>` +
    `<line x1="${x1}" y1="${y0}" x2="${x0 + ux * 2}" y2="${y0 + 7}" stroke="${stroke}" stroke-width="1.65" stroke-linecap="round"/>`;
  if (side === 'zero-many') {
    return (
      prongs +
      `<circle cx="${x2 + ux * 2}" cy="${y0}" r="3.8" fill="${hollowFill}" stroke="${stroke}" stroke-width="1.55"/>`
    );
  }
  return (
    prongs +
    `<line x1="${x1 + ux * 2}" y1="${y0 - 6}" x2="${x1 + ux * 2}" y2="${y0 + 6}" stroke="${stroke}" stroke-width="1.65" stroke-linecap="round"/>`
  );
}

/* --------------------------------------------------------------------------
   1. Publication-Grade Pure-Vector SVG Builder (Full Visual Fidelity)
   -------------------------------------------------------------------------- */

export function buildErExportSvgDocument(
  diagram: ErDiagramState,
  options: Pick<
    ErVisualExportOptions,
    | 'paletteMode'
    | 'appTheme'
    | 'expandAllColumns'
    | 'includeGrid'
    | 'includeHeaderLegend'
    | 'showRelationLabels'
  >,
): ErSvgExportDocument {
  const pal = resolveExportPalette(options.paletteMode, options.appTheme);
  const tables: ErTable[] = options.expandAllColumns
    ? diagram.tables.map((t) => (t.collapsed ? { ...t, collapsed: false } : t))
    : diagram.tables;

  const visibleRels: ErRelation[] = diagram.relations.filter(
    (r) => r.kind !== 'inferred' || diagram.showInferred,
  );

  // Build FK column map per table (matches DbErCanvas & DbErTableCard)
  const fkColsByTable = new Map<string, Set<string>>();
  for (const r of visibleRels) {
    let set = fkColsByTable.get(r.sourceTableId);
    if (!set) {
      set = new Set<string>();
      fkColsByTable.set(r.sourceTableId, set);
    }
    set.add(r.sourceColumn.toLowerCase());
  }

  // Compute exact world bounding box
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const t of tables) {
    const w = t.width || ER_CARD_WIDTH;
    const h = estimateTableCardHeight(t, false);
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + w);
    maxY = Math.max(maxY, t.y + h);
  }
  for (const a of diagram.subjectAreas) {
    minX = Math.min(minX, a.x);
    minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, a.x + a.width);
    maxY = Math.max(maxY, a.y + a.height);
  }
  for (const n of diagram.notes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 760;
    maxY = 420;
  }

  const pad = 52;
  const headerH = options.includeHeaderLegend ? 68 : 0;
  const headerGap = options.includeHeaderLegend ? 24 : 0;
  const minWidthForHeader = options.includeHeaderLegend ? 860 : 0;

  const contentW = maxX - minX;
  const extraX = Math.max(0, (minWidthForHeader - contentW) / 2);

  const vbX = Math.floor(minX - pad - extraX);
  const vbY = Math.floor(minY - pad - headerH - headerGap);
  const vbW = Math.ceil(contentW + (pad + extraX) * 2);
  const vbH = Math.ceil(maxY - minY + pad * 2 + headerH + headerGap);

  const uiFont =
    "'Inter', 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif";
  const monoFont = "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace";

  const defs: string[] = [
    `<filter id="erCardShadow" x="-8%" y="-8%" width="116%" height="118%">` +
      `<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="${pal.shadowColor}" flood-opacity="1"/>` +
      `</filter>`,
  ];
  if (options.includeGrid) {
    defs.push(
      `<pattern id="erDotGrid" width="22" height="22" patternUnits="userSpaceOnUse">` +
        `<circle cx="1.5" cy="1.5" r="1.15" fill="${pal.gridDot}"/>` +
        `</pattern>`,
    );
  }

  // Table card clipPaths for clean rounded corners + top accent stripe
  tables.forEach((t, idx) => {
    const w = t.width || ER_CARD_WIDTH;
    const h = estimateTableCardHeight(t, false);
    defs.push(
      `<clipPath id="erCardClip${idx}"><rect x="${t.x}" y="${t.y}" width="${w}" height="${h}" rx="6"/></clipPath>`,
    );
  });

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW}" height="${vbH}" text-rendering="geometricPrecision">`,
    `<defs>${defs.join('')}</defs>`,
    `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${pal.bg}"/>`,
  ];

  if (options.includeGrid) {
    parts.push(
      `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="url(#erDotGrid)"/>`,
    );
  }

  // Optional Crisp Publication Header & Legend Strip
  if (options.includeHeaderLegend) {
    const hx = vbX + 24;
    const hy = vbY + 20;
    const hw = vbW - 48;
    const hh = 56;
    const physCount = visibleRels.filter((r) => r.kind === 'physical').length;
    const logicCount = visibleRels.filter((r) => r.kind === 'logical').length;
    const infCount = visibleRels.filter((r) => r.kind === 'inferred').length;
    const subtitle = [
      diagram.dbType.toUpperCase(),
      `${tables.length} 表`,
      `${visibleRels.length} 关系`,
      diagram.subjectAreas.length > 0
        ? `${diagram.subjectAreas.length} 分区`
        : '',
      new Date().toISOString().slice(0, 10),
    ]
      .filter(Boolean)
      .join('  ·  ');

    parts.push(
      `<g>`,
      `<rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="6" fill="${pal.headerBg}" stroke="${pal.headerBorder}" stroke-width="1"/>`,
      `<rect x="${hx}" y="${hy}" width="4" height="${hh}" rx="2" fill="${pal.edgePhys}"/>`,
      `<text x="${hx + 18}" y="${hy + 25}" font-family="${uiFont}" font-size="15.5" font-weight="700" fill="${pal.ink}">${escapeXml(fitTextToWidth(`ER · ${diagram.title}`, Math.max(240, hw - 440), 15.5, false))}</text>`,
      `<text x="${hx + 18}" y="${hy + 44}" font-family="${monoFont}" font-size="10.5" fill="${pal.muted}">${escapeXml(subtitle)}</text>`,
    );

    // Compact right-aligned visual legend
    const legY = hy + 30;
    let legX = hx + hw - 18;
    const pushLegendLine = (label: string, color: string, dash: string) => {
      const labelW = estimateTextPx(label, 10.5, false);
      const itemW = labelW + 30;
      legX -= itemW;
      parts.push(
        `<line x1="${legX}" y1="${legY - 3}" x2="${legX + 22}" y2="${legY - 3}" stroke="${color}" stroke-width="2"${dash}/>`,
        `<text x="${legX + 27}" y="${legY}" font-family="${uiFont}" font-size="10.5" fill="${pal.muted}">${escapeXml(label)}</text>`,
      );
      legX -= 14;
    };
    const pushLegendPill = (tag: string, bg: string, fg: string) => {
      const w = 24;
      legX -= w;
      parts.push(
        `<rect x="${legX}" y="${legY - 11}" width="${w}" height="15" rx="3" fill="${bg}"/>`,
        `<text x="${legX + w / 2}" y="${legY}" text-anchor="middle" font-family="${monoFont}" font-size="9" font-weight="700" fill="${fg}">${tag}</text>`,
      );
      legX -= 6;
    };

    if (hw >= 680) {
      pushLegendPill('UK', pal.ukPillBg, pal.ukPillInk);
      pushLegendPill('FK', pal.fkPillBg, pal.fkPillInk);
      pushLegendPill('PK', pal.pkPillBg, pal.pkPillInk);
      legX -= 10;
      if (infCount > 0) {
        pushLegendLine(
          `推断(${infCount})`,
          pal.edgeInf,
          ' stroke-dasharray="3 3"',
        );
      }
      if (logicCount > 0) {
        pushLegendLine(
          `逻辑(${logicCount})`,
          pal.edgeLogic,
          ' stroke-dasharray="6 3"',
        );
      }
      pushLegendLine(`物理外键(${physCount})`, pal.edgePhys, '');
    }
    parts.push(`</g>`);
  }

  // 1. Subject Areas (with subtle translucent body + crisp dashed border + header label)
  for (const a of diagram.subjectAreas) {
    const memberCount = tables.filter(
      (t) =>
        t.x >= a.x - 8 &&
        t.x <= a.x + a.width + 8 &&
        t.y >= a.y - 8 &&
        t.y <= a.y + a.height + 8,
    ).length;
    const areaTitle = memberCount > 0 ? `${a.name}  (${memberCount})` : a.name;
    const pillW = Math.min(
      a.width - 24,
      Math.ceil(estimateTextPx(areaTitle, 12, false) + 22),
    );
    parts.push(
      `<g>`,
      `<rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" rx="8" fill="${escapeXml(a.color)}" fill-opacity="${pal.isDark ? '0.075' : '0.055'}" stroke="${escapeXml(a.color)}" stroke-opacity="${pal.isDark ? '0.46' : '0.40'}" stroke-width="1.35" stroke-dasharray="7 4"/>`,
      `<rect x="${a.x + 12}" y="${a.y + 8}" width="${pillW}" height="22" rx="4" fill="${escapeXml(a.color)}" fill-opacity="${pal.isDark ? '0.18' : '0.13'}"/>`,
      `<text x="${a.x + 22}" y="${a.y + 23}" font-family="${uiFont}" font-size="12" font-weight="700" fill="${escapeXml(a.color)}">${escapeXml(fitTextToWidth(areaTitle, pillW - 18, 12, false))}</text>`,
      `</g>`,
    );
  }

  // 2. Relationships (with exact parallel lane offsets + crow's-foot + optional cardinality badges)
  const tableById = new Map(tables.map((t) => [t.id, t]));
  const pairCounters = new Map<string, number>();
  const labelOverlays: string[] = [];

  for (const rel of visibleRels) {
    const src = tableById.get(rel.sourceTableId);
    const tgt = tableById.get(rel.targetTableId);
    if (!src || !tgt) continue;

    const pairKey =
      src.id < tgt.id ? `${src.id}||${tgt.id}` : `${tgt.id}||${src.id}`;
    const lane = pairCounters.get(pairKey) ?? 0;
    pairCounters.set(pairKey, lane + 1);
    const laneOffset =
      lane === 0 ? 0 : (lane % 2 === 1 ? 1 : -1) * Math.ceil(lane / 2);

    const edge = calcErEdgePath(
      src,
      rel.sourceColumn,
      tgt,
      rel.targetColumn,
      diagram.routing,
      false,
      laneOffset,
    );
    const stroke =
      rel.kind === 'physical'
        ? pal.edgePhys
        : rel.kind === 'logical'
          ? pal.edgeLogic
          : pal.edgeInf;
    const dash =
      rel.kind === 'physical'
        ? ''
        : rel.kind === 'logical'
          ? ' stroke-dasharray="7 4"'
          : ' stroke-dasharray="3 4" stroke-opacity="0.72"';
    const ends = cardinalityEnds(rel.cardinality);
    parts.push(
      `<g>`,
      `<path d="${edge.pathD}" fill="none" stroke="${stroke}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"${dash}/>`,
      renderCrowsFootExportSvg(
        edge.sourcePoint,
        edge.sourceDir,
        ends.source,
        stroke,
        pal.bg,
      ),
      renderCrowsFootExportSvg(
        edge.targetPoint,
        edge.targetDir,
        ends.target,
        stroke,
        pal.bg,
      ),
      `</g>`,
    );

    if (options.showRelationLabels) {
      const badgeText =
        rel.kind === 'inferred' ? `推断 ${rel.cardinality}` : rel.cardinality;
      const bw = Math.max(
        34,
        Math.ceil(estimateTextPx(badgeText, 9.5, true) + 12),
      );
      labelOverlays.push(
        `<g transform="translate(${edge.labelPoint.x.toFixed(1)}, ${edge.labelPoint.y.toFixed(1)})">` +
          `<rect x="${(-bw / 2).toFixed(1)}" y="-9" width="${bw}" height="18" rx="9" fill="${pal.cardBg}" stroke="${stroke}" stroke-width="1.1"/>` +
          `<text x="0" y="3.5" text-anchor="middle" font-family="${monoFont}" font-size="9.5" font-weight="600" fill="${stroke}">${escapeXml(badgeText)}</text>` +
          `</g>`,
      );
    }
  }

  // 3. Table Cards (pixel-faithful to DbErTableCard, zero blind slice truncation)
  tables.forEach((t, idx) => {
    const w = t.width || ER_CARD_WIDTH;
    const h = estimateTableCardHeight(t, false);
    const hasSub = hasTableSubmeta(t);
    const subH = hasSub ? ER_SUBMETA_H : 0;
    const fkSet = fkColsByTable.get(t.id) ?? new Set<string>();
    const isLocal = t.sourceKind === 'local-file';
    const isView = t.tableType.toLowerCase().includes('view');

    const schemaPrefix =
      t.schema &&
      t.schema !== 'main' &&
      t.schema !== 'default' &&
      t.schema !== 'local'
        ? `${t.schema}.`
        : '';

    parts.push(`<g filter="url(#erCardShadow)">`);
    parts.push(
      `<rect x="${t.x}" y="${t.y}" width="${w}" height="${h}" rx="6" fill="${pal.cardBg}" stroke="${pal.cardBorder}" stroke-width="1.15"/>`,
    );
    parts.push(`<g clip-path="url(#erCardClip${idx})">`);
    // Header fill + 4px accent bar
    parts.push(
      `<rect x="${t.x}" y="${t.y}" width="${w}" height="${ER_HEADER_H}" fill="${pal.cardHeaderBg}"/>`,
      `<rect x="${t.x}" y="${t.y}" width="${w}" height="4" fill="${escapeXml(t.color)}"/>`,
      `<line x1="${t.x}" y1="${t.y + ER_HEADER_H}" x2="${t.x + w}" y2="${t.y + ER_HEADER_H}" stroke="${pal.cardBorder}" stroke-width="1"/>`,
    );

    // Table header title (schema.name + optional alias)
    const fullTitle = `${schemaPrefix}${t.name}`;
    const aliasText = t.alias?.trim() || '';
    const titleBudget = aliasText ? w - 92 : w - 22;
    const fittedTitle = fitTextToWidth(fullTitle, titleBudget, 12.2, false);
    if (schemaPrefix && fittedTitle.startsWith(schemaPrefix)) {
      const rest = fittedTitle.slice(schemaPrefix.length);
      parts.push(
        `<text x="${t.x + 11}" y="${t.y + 24}" font-family="${uiFont}" font-size="12.2" font-weight="700">` +
          `<tspan fill="${pal.schemaInk}" font-weight="500">${escapeXml(schemaPrefix)}</tspan>` +
          `<tspan fill="${pal.ink}">${escapeXml(rest)}</tspan>` +
          `</text>`,
      );
    } else {
      parts.push(
        `<text x="${t.x + 11}" y="${t.y + 24}" font-family="${uiFont}" font-size="12.2" font-weight="700" fill="${pal.ink}">${escapeXml(fittedTitle)}</text>`,
      );
    }
    if (aliasText) {
      const fittedAlias = fitTextToWidth(aliasText, 76, 10, false);
      parts.push(
        `<text x="${t.x + w - 10}" y="${t.y + 23.5}" text-anchor="end" font-family="${uiFont}" font-size="10" fill="${pal.muted}">${escapeXml(fittedAlias)}</text>`,
      );
    }

    // Submeta strip
    if (hasSub) {
      const subItems = [
        isLocal
          ? `${t.mountedFileFormat?.toUpperCase() || 'FILE'} · 本地联邦`
          : t.missingInLive
            ? '实库已下线'
            : isView
              ? t.tableType
              : '',
        t.estimatedRows != null ? formatEstimatedRows(t.estimatedRows) : '',
        t.totalBytes != null && t.totalBytes > 0
          ? formatFileSizeCompact(t.totalBytes)
          : '',
        `${t.columns.length} 列`,
      ].filter(Boolean);
      const subText = fitTextToWidth(subItems.join(' · '), w - 22, 9.8, true);
      parts.push(
        `<rect x="${t.x}" y="${t.y + ER_HEADER_H}" width="${w}" height="${subH}" fill="${pal.submetaBg}"/>`,
        `<text x="${t.x + 11}" y="${t.y + ER_HEADER_H + 14.5}" font-family="${monoFont}" font-size="9.8" fill="${pal.muted}">${escapeXml(subText)}</text>`,
        `<line x1="${t.x}" y1="${t.y + ER_HEADER_H + subH}" x2="${t.x + w}" y2="${t.y + ER_HEADER_H + subH}" stroke="${pal.cardBorder}" stroke-width="0.9"/>`,
      );
    }

    // Columns
    if (!t.collapsed) {
      const colStartY = t.y + ER_HEADER_H + subH;
      t.columns.forEach((col, cIdx) => {
        const ry = colStartY + cIdx * ER_ROW_H;
        const textY = ry + 17.5;
        const isFk = fkSet.has(col.name.toLowerCase());
        const isUk = Boolean(col.isUnique && !col.isPrimaryKey);
        const highNull = col.nullFraction != null && col.nullFraction >= 0.5;

        if (col.isPrimaryKey) {
          parts.push(
            `<rect x="${t.x}" y="${ry}" width="${w}" height="${ER_ROW_H}" fill="${pal.pkRowBg}"/>`,
          );
        }
        if (cIdx > 0) {
          parts.push(
            `<line x1="${t.x + 1}" y1="${ry}" x2="${t.x + w - 1}" y2="${ry}" stroke="${pal.rowDivider}" stroke-width="0.65"/>`,
          );
        }

        // Key pills or NOT NULL / NULL dot
        let cursorX = t.x + 9;
        const drawPill = (label: string, bg: string, fg: string) => {
          const pw = 19;
          parts.push(
            `<rect x="${cursorX}" y="${ry + 6.5}" width="${pw}" height="13" rx="3" fill="${bg}"/>`,
            `<text x="${cursorX + pw / 2}" y="${ry + 16}" text-anchor="middle" font-family="${monoFont}" font-size="8.2" font-weight="700" fill="${fg}">${label}</text>`,
          );
          cursorX += pw + 3;
        };

        if (col.isPrimaryKey) drawPill('PK', pal.pkPillBg, pal.pkPillInk);
        if (isFk) drawPill('FK', pal.fkPillBg, pal.fkPillInk);
        if (isUk) drawPill('UK', pal.ukPillBg, pal.ukPillInk);
        if (!col.isPrimaryKey && !isFk && !isUk) {
          if (col.nullable) {
            parts.push(
              `<circle cx="${cursorX + 4}" cy="${ry + ER_ROW_H / 2}" r="2.4" fill="none" stroke="${pal.nullDotStroke}" stroke-width="1.1"/>`,
            );
          } else {
            parts.push(
              `<circle cx="${cursorX + 4}" cy="${ry + ER_ROW_H / 2}" r="2.5" fill="${pal.nnDotFill}"/>`,
            );
          }
          cursorX += 12;
        } else {
          cursorX += 2;
        }

        // Dynamic shared budget between column name & data type (NO blind truncation!)
        const rightX = t.x + w - 10;
        const availW = Math.max(60, rightX - cursorX);
        const rawType = (col.dataType || '').trim();
        const rawNameW = estimateTextPx(col.name, 10.8, true);
        const rawTypeW = estimateTextPx(rawType, 9.8, true);
        const gap = 8;

        let nameMaxW: number;
        let typeMaxW: number;
        if (rawNameW + gap + rawTypeW <= availW) {
          nameMaxW = rawNameW + 4;
          typeMaxW = rawTypeW + 4;
        } else {
          // Preserve full name when possible, give type generous room
          const minTypeBudget = Math.min(rawTypeW, availW * 0.44);
          nameMaxW = Math.max(availW * 0.52, availW - minTypeBudget - gap);
          typeMaxW = Math.max(36, availW - Math.min(rawNameW, nameMaxW) - gap);
        }

        const fittedName = fitTextToWidth(col.name, nameMaxW, 10.8, true);
        const fittedType = fitTextToWidth(rawType, typeMaxW, 9.8, true);

        const nameColor = col.isPrimaryKey
          ? pal.isDark
            ? '#f3f7fc'
            : '#0f172a'
          : pal.ink;

        parts.push(
          `<text x="${cursorX}" y="${textY}" font-family="${monoFont}" font-size="10.8" font-weight="${col.isPrimaryKey ? '700' : '400'}" fill="${nameColor}">${escapeXml(fittedName)}</text>`,
        );

        // Optional note / high-null dot indicator right next to column name
        const actualNameEnd = cursorX + estimateTextPx(fittedName, 10.8, true);
        if (
          highNull &&
          actualNameEnd + 8 < rightX - estimateTextPx(fittedType, 9.8, true)
        ) {
          parts.push(
            `<circle cx="${(actualNameEnd + 5).toFixed(1)}" cy="${ry + ER_ROW_H / 2}" r="2.2" fill="${pal.warnDotFill}"/>`,
          );
        } else if (
          col.note &&
          actualNameEnd + 8 < rightX - estimateTextPx(fittedType, 9.8, true)
        ) {
          parts.push(
            `<circle cx="${(actualNameEnd + 5).toFixed(1)}" cy="${ry + ER_ROW_H / 2}" r="2" fill="${pal.noteDotFill}"/>`,
          );
        }

        parts.push(
          `<text x="${rightX}" y="${textY}" text-anchor="end" font-family="${monoFont}" font-size="9.8" fill="${pal.muted}">${escapeXml(fittedType)}</text>`,
        );
      });
    }

    parts.push(`</g></g>`);
  });

  // Render edge cardinality pills above tables so they are never obscured
  if (labelOverlays.length > 0) {
    parts.push(`<g>${labelOverlays.join('')}</g>`);
  }

  // 4. Canvas Notes (with full multi-line wrapping)
  for (const n of diagram.notes) {
    const wrapped = wrapNoteLines(
      n.content || '',
      Math.max(80, n.width - 24),
      11,
      Math.max(1, Math.floor((n.height - 38) / 16)),
    );
    parts.push(
      `<g filter="url(#erCardShadow)">`,
      `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="6" fill="${escapeXml(n.color)}" stroke="#b8a878" stroke-width="1.1"/>`,
      `<text x="${n.x + 12}" y="${n.y + 22}" font-family="${uiFont}" font-size="12" font-weight="700" fill="#2c2a24">${escapeXml(fitTextToWidth(n.title || '研究便签', n.width - 24, 12, false))}</text>`,
      `<line x1="${n.x + 10}" y1="${n.y + 30}" x2="${n.x + n.width - 10}" y2="${n.y + 30}" stroke="rgba(44,42,36,0.16)" stroke-width="0.8"/>`,
    );
    wrapped.forEach((line, lIdx) => {
      if (!line) return;
      parts.push(
        `<text x="${n.x + 12}" y="${n.y + 47 + lIdx * 16}" font-family="${uiFont}" font-size="11" fill="#464236">${escapeXml(line)}</text>`,
      );
    });
    parts.push(`</g>`);
  }

  parts.push('</svg>');

  return {
    svg: parts.join('\n'),
    viewBoxX: vbX,
    viewBoxY: vbY,
    width: vbW,
    height: vbH,
    backgroundHex: pal.bg,
    backgroundRgb: pal.bgRgb,
    tableCount: tables.length,
    relationCount: visibleRels.length,
    areaCount: diagram.subjectAreas.length,
  };
}

/* --------------------------------------------------------------------------
   2. Output Resolution & PDF Page Planner
   -------------------------------------------------------------------------- */

export function computeErExportPlan(
  doc: Pick<ErSvgExportDocument, 'width' | 'height'>,
  options: Pick<
    ErVisualExportOptions,
    'format' | 'scale' | 'pdfPageMode' | 'pdfOrientation'
  >,
): ErExportResolutionPlan {
  const worldWidth = Math.max(1, doc.width);
  const worldHeight = Math.max(1, doc.height);
  const requestedScale = options.scale;

  if (options.format === 'svg') {
    return {
      worldWidth,
      worldHeight,
      requestedScale: 1,
      effectiveScale: 1,
      clamped: false,
      pixelWidth: worldWidth,
      pixelHeight: worldHeight,
      pdfPageCount: 1,
      pdfGridCols: 1,
      pdfGridRows: 1,
      pdfPageWidthPt: Math.round(worldWidth * PDF_PT_PER_WORLD_PX),
      pdfPageHeightPt: Math.round(worldHeight * PDF_PT_PER_WORLD_PX),
      pdfStripCount: 1,
    };
  }

  if (options.format === 'png') {
    const dimCapScale =
      MAX_PNG_CANVAS_DIM / Math.max(worldWidth, worldHeight, 1);
    const areaCapScale = Math.sqrt(
      MAX_PNG_CANVAS_PIXELS / Math.max(worldWidth * worldHeight, 1),
    );
    const effectiveScale = Math.max(
      0.5,
      Math.min(requestedScale, dimCapScale, areaCapScale),
    );
    return {
      worldWidth,
      worldHeight,
      requestedScale,
      effectiveScale,
      clamped: effectiveScale < requestedScale - 0.01,
      pixelWidth: Math.max(1, Math.round(worldWidth * effectiveScale)),
      pixelHeight: Math.max(1, Math.round(worldHeight * effectiveScale)),
      pdfPageCount: 1,
      pdfGridCols: 1,
      pdfGridRows: 1,
      pdfPageWidthPt: Math.round(worldWidth * PDF_PT_PER_WORLD_PX),
      pdfPageHeightPt: Math.round(worldHeight * PDF_PT_PER_WORLD_PX),
      pdfStripCount: 1,
    };
  }

  // PDF planning
  if (options.pdfPageMode === 'single-page') {
    const maxWorld = Math.max(worldWidth, worldHeight, 1);
    const ptPerPx = Math.min(
      PDF_PT_PER_WORLD_PX,
      MAX_PDF_SINGLE_PAGE_PT / maxWorld,
    );
    const pageW = Math.max(72, Math.round(worldWidth * ptPerPx * 100) / 100);
    const pageH = Math.max(72, Math.round(worldHeight * ptPerPx * 100) / 100);
    // Horizontal pixel width capped safely; vertical height uses seamless strips (UNCAPPED!)
    const effectiveScale = Math.max(
      1,
      Math.min(requestedScale, MAX_PDF_SINGLE_PIXEL_W / worldWidth),
    );
    const pixelWidth = Math.max(1, Math.round(worldWidth * effectiveScale));
    const pixelHeight = Math.max(1, Math.round(worldHeight * effectiveScale));
    const maxStripH = Math.max(
      256,
      Math.min(
        MAX_PDF_STRIP_PIXELS_H,
        Math.floor(MAX_PDF_STRIP_PIXELS_AREA / Math.max(pixelWidth, 1)),
      ),
    );
    const pdfStripCount = Math.max(1, Math.ceil(pixelHeight / maxStripH));
    return {
      worldWidth,
      worldHeight,
      requestedScale,
      effectiveScale,
      clamped: effectiveScale < requestedScale - 0.01,
      pixelWidth,
      pixelHeight,
      pdfPageCount: 1,
      pdfGridCols: 1,
      pdfGridRows: 1,
      pdfPageWidthPt: pageW,
      pdfPageHeightPt: pageH,
      pdfStripCount,
    };
  }

  // Tiled A4 / A3 printing mode
  const [shortSide, longSide] = PAPER_SIZES_PT[options.pdfPageMode];
  const isLandscape =
    options.pdfOrientation === 'landscape' ||
    (options.pdfOrientation === 'auto' && worldWidth > worldHeight * 1.15);
  const pageW = isLandscape ? longSide : shortSide;
  const pageH = isLandscape ? shortSide : longSide;
  const usableW = pageW - PDF_TILED_MARGIN_PT * 2;
  const usableH = pageH - PDF_TILED_MARGIN_PT * 2 - PDF_TILED_FOOTER_PT;

  const tileWorldW = usableW / PDF_TILED_SCALE_PT_PER_PX;
  const tileWorldH = usableH / PDF_TILED_SCALE_PT_PER_PX;
  const cols = Math.max(1, Math.ceil(worldWidth / tileWorldW));
  const rows = Math.max(1, Math.ceil(worldHeight / tileWorldH));

  const pixelWidth = Math.max(1, Math.round(worldWidth * requestedScale));
  const pixelHeight = Math.max(1, Math.round(worldHeight * requestedScale));

  return {
    worldWidth,
    worldHeight,
    requestedScale,
    effectiveScale: requestedScale,
    clamped: false,
    pixelWidth,
    pixelHeight,
    pdfPageCount: cols * rows,
    pdfGridCols: cols,
    pdfGridRows: rows,
    pdfPageWidthPt: pageW,
    pdfPageHeightPt: pageH,
    pdfStripCount: cols * rows,
  };
}

/* --------------------------------------------------------------------------
   3. High-DPI Native SVG Region Rasterizer (Zero 1x Upscale Blur!)
   -------------------------------------------------------------------------- */

export function rewriteSvgViewport(
  svgText: string,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
  pixelW: number,
  pixelH: number,
): string {
  return svgText.replace(
    /<svg\b[^>]*>/,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${cropX} ${cropY} ${cropW} ${cropH}" width="${pixelW}" height="${pixelH}" text-rendering="geometricPrecision">`,
  );
}

async function rasterizeSvgRegion(
  svgText: string,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
  pixelW: number,
  pixelH: number,
  backgroundHex: string,
): Promise<HTMLCanvasElement> {
  const regionSvg = rewriteSvgViewport(
    svgText,
    cropX,
    cropY,
    cropW,
    cropH,
    pixelW,
    pixelH,
  );
  const blob = new Blob([regionSvg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.decoding = 'async';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('SVG 高清栅格化失败'));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = pixelW;
    canvas.height = pixelH;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法创建 2D Canvas 渲染上下文');
    ctx.fillStyle = backgroundHex;
    ctx.fillRect(0, 0, pixelW, pixelH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, pixelW, pixelH);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function renderErToPngBytes(
  doc: ErSvgExportDocument,
  plan: ErExportResolutionPlan,
  onProgress?: (p: ErExportProgress) => void,
): Promise<Uint8Array> {
  onProgress?.({
    stage: 'raster',
    label: `正在按 ${plan.pixelWidth} × ${plan.pixelHeight} px 渲染高清 PNG…`,
  });
  const canvas = await rasterizeSvgRegion(
    doc.svg,
    doc.viewBoxX,
    doc.viewBoxY,
    doc.width,
    doc.height,
    plan.pixelWidth,
    plan.pixelHeight,
    doc.backgroundHex,
  );
  onProgress?.({ stage: 'encode', label: '正在无损编码 PNG 图像…' });
  const pngBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error('PNG 编码失败（画布尺寸可能超出当前显卡上限）'));
    }, 'image/png');
  });
  // Release GPU backing buffer promptly
  canvas.width = 0;
  canvas.height = 0;
  const buf = await pngBlob.arrayBuffer();
  return new Uint8Array(buf);
}

/* --------------------------------------------------------------------------
   4. Pure-TS Lossless ISO 32000-1 PDF 1.4 Generator (FlateDecode + Predictor 15)
   -------------------------------------------------------------------------- */

/**
 * Strips alpha channel from opaque RGBA ImageData and applies PNG Sub filter (type 1)
 * per scanline for PDF `/Filter /FlateDecode /DecodeParms << /Predictor 15 ... >>`.
 */
export function encodeRgbToPngSubScanlines(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const rowBytes = width * 3;
  const stride = rowBytes + 1;
  const out = new Uint8Array(height * stride);

  for (let y = 0; y < height; y += 1) {
    const outRow = y * stride;
    const inRow = y * width * 4;
    out[outRow] = 1; // PNG Sub filter byte

    let prevR = 0;
    let prevG = 0;
    let prevB = 0;
    let dst = outRow + 1;
    let src = inRow;
    for (let x = 0; x < width; x += 1) {
      const r = rgba[src];
      const g = rgba[src + 1];
      const b = rgba[src + 2];
      out[dst] = (r - prevR) & 0xff;
      out[dst + 1] = (g - prevG) & 0xff;
      out[dst + 2] = (b - prevB) & 0xff;
      prevR = r;
      prevG = g;
      prevB = b;
      dst += 3;
      src += 4;
    }
  }
  return out;
}

/**
 * Compresses bytes into an RFC 1950 zlib stream (`/Filter /FlateDecode`) using the
 * native browser / Node 22 `CompressionStream('deflate')` with a stored-block zlib fallback.
 */
export async function compressZlibFlate(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    const writePromise = writer.write(copy).then(() => writer.close());
    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    await writePromise;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged;
  }

  // Fallback: valid RFC 1950 stored-block zlib stream (no compression, 100% spec compliant)
  const MAX_BLOCK = 65535;
  const numBlocks = Math.max(1, Math.ceil(raw.length / MAX_BLOCK));
  const out = new Uint8Array(2 + raw.length + numBlocks * 5 + 4);
  let pos = 0;
  out[pos++] = 0x78;
  out[pos++] = 0x01;

  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < raw.length; i += 1) {
    s1 = (s1 + raw[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }

  let offset = 0;
  for (let b = 0; b < numBlocks; b += 1) {
    const len = Math.min(MAX_BLOCK, raw.length - offset);
    const isFinal = b === numBlocks - 1 ? 1 : 0;
    out[pos++] = isFinal;
    out[pos++] = len & 0xff;
    out[pos++] = (len >> 8) & 0xff;
    const nlen = ~len & 0xffff;
    out[pos++] = nlen & 0xff;
    out[pos++] = (nlen >> 8) & 0xff;
    if (len > 0) {
      out.set(raw.subarray(offset, offset + len), pos);
      pos += len;
      offset += len;
    }
  }
  const adler = ((s2 << 16) | s1) >>> 0;
  out[pos++] = (adler >>> 24) & 0xff;
  out[pos++] = (adler >>> 16) & 0xff;
  out[pos++] = (adler >>> 8) & 0xff;
  out[pos++] = adler & 0xff;
  return out.subarray(0, pos);
}

export interface PdfLosslessImagePlacement {
  pixelWidth: number;
  pixelHeight: number;
  flateSubRgbBytes: Uint8Array;
  drawXPt: number;
  drawYPt: number;
  drawWidthPt: number;
  drawHeightPt: number;
}

export interface PdfPageSpec {
  widthPt: number;
  heightPt: number;
  backgroundRgb: [number, number, number];
  images: PdfLosslessImagePlacement[];
  footerAscii?: string;
}

function encodePdfUtf16BeHex(text: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i += 1) {
    hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return `<${hex}>`;
}

function escapePdfAsciiString(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function pdfNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, '');
}

/**
 * Pure binary ISO 32000-1 PDF 1.4 document assembler.
 * Accepts lossless FlateDecode PNG-Sub-filtered RGB image placements across 1..N pages.
 */
export function assembleLosslessPdfDocument(
  pages: readonly PdfPageSpec[],
  metadata?: { title?: string; creator?: string },
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let byteOffset = 0;

  const pushStr = (s: string) => {
    const b = encoder.encode(s);
    chunks.push(b);
    byteOffset += b.byteLength;
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b);
    byteOffset += b.byteLength;
  };

  // PDF 1.4 binary header
  chunks.push(
    new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3,
      0xcf, 0xd3, 0x0a,
    ]),
  );
  byteOffset = chunks[0].byteLength;

  // Assign object IDs deterministically:
  // 1 = Catalog, 2 = Pages, 3 = Helvetica Font (for optional page footer)
  // Per page: image objects..., content stream object, page object
  // Final = Info dict
  const offsets: number[] = [0]; // 1-indexed after header
  let nextObjId = 4;

  const pageLayout = pages.map((page) => {
    const imgIds = page.images.map(() => nextObjId++);
    const contentId = nextObjId++;
    const pageId = nextObjId++;
    return { page, imgIds, contentId, pageId };
  });
  const infoId = nextObjId++;

  const startObj = (id: number) => {
    offsets[id] = byteOffset;
    pushStr(`${id} 0 obj\n`);
  };
  const endObj = () => {
    pushStr('\nendobj\n');
  };

  // Obj 1: Catalog
  startObj(1);
  pushStr('<< /Type /Catalog /Pages 2 0 R >>');
  endObj();

  // Obj 2: Pages
  startObj(2);
  pushStr(
    `<< /Type /Pages /Kids [${pageLayout.map((p) => `${p.pageId} 0 R`).join(' ')}] /Count ${pageLayout.length} >>`,
  );
  endObj();

  // Obj 3: Standard Helvetica font (for subtle tiled-page footer)
  startObj(3);
  pushStr('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  endObj();

  // Per-page objects
  for (const entry of pageLayout) {
    const { page, imgIds, contentId, pageId } = entry;
    const xObjRefs: string[] = [];

    // Image XObjects
    page.images.forEach((img, idx) => {
      const objId = imgIds[idx];
      const name = `Im${idx}`;
      xObjRefs.push(`/${name} ${objId} 0 R`);
      startObj(objId);
      pushStr(
        `<< /Type /XObject /Subtype /Image /Width ${img.pixelWidth} /Height ${img.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${img.pixelWidth} >> /Length ${img.flateSubRgbBytes.byteLength} >>\nstream\n`,
      );
      pushBytes(img.flateSubRgbBytes);
      pushStr('\nendstream');
      endObj();
    });

    // Page content stream
    const [br, bg, bb] = page.backgroundRgb;
    const ops: string[] = [
      `${(br / 255).toFixed(4)} ${(bg / 255).toFixed(4)} ${(bb / 255).toFixed(4)} rg`,
      `0 0 ${pdfNum(page.widthPt)} ${pdfNum(page.heightPt)} re f`,
    ];
    page.images.forEach((img, idx) => {
      ops.push(
        `q ${pdfNum(img.drawWidthPt)} 0 0 ${pdfNum(img.drawHeightPt)} ${pdfNum(img.drawXPt)} ${pdfNum(img.drawYPt)} cm /Im${idx} Do Q`,
      );
    });
    if (page.footerAscii) {
      const isDarkBg = br * 0.299 + bg * 0.587 + bb * 0.114 < 128;
      const fg = isDarkBg ? '0.62 0.67 0.74' : '0.42 0.46 0.52';
      ops.push(
        `BT /F1 8 Tf ${fg} rg ${PDF_TILED_MARGIN_PT} 14 Td (${escapePdfAsciiString(page.footerAscii)}) Tj ET`,
      );
    }
    const contentBytes = encoder.encode(ops.join('\n'));
    startObj(contentId);
    pushStr(`<< /Length ${contentBytes.byteLength} >>\nstream\n`);
    pushBytes(contentBytes);
    pushStr('\nendstream');
    endObj();

    // Page dictionary
    startObj(pageId);
    pushStr(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNum(page.widthPt)} ${pdfNum(page.heightPt)}] /Resources << /XObject << ${xObjRefs.join(' ')} >> /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    endObj();
  }

  // Info dictionary
  const now = new Date();
  const pdfDate =
    `D:${now.getUTCFullYear()}` +
    `${String(now.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(now.getUTCDate()).padStart(2, '0')}` +
    `${String(now.getUTCHours()).padStart(2, '0')}` +
    `${String(now.getUTCMinutes()).padStart(2, '0')}` +
    `${String(now.getUTCSeconds()).padStart(2, '0')}Z`;
  startObj(infoId);
  pushStr(
    `<< /Title ${encodePdfUtf16BeHex(metadata?.title || 'Seamind ER Diagram')} /Creator (${escapePdfAsciiString(metadata?.creator || 'Seamind Database ER Studio')}) /Producer (Seamind Lossless Vector-to-PDF Engine) /CreationDate (${pdfDate}) >>`,
  );
  endObj();

  // XRef table
  const xrefOffset = byteOffset;
  const totalObjects = infoId + 1;
  pushStr(`xref\n0 ${totalObjects}\n`);
  pushStr('0000000000 65535 f \n');
  for (let id = 1; id < totalObjects; id += 1) {
    pushStr(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(
    `trailer\n<< /Size ${totalObjects} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  // Merge chunks into a single Uint8Array
  const finalBytes = new Uint8Array(byteOffset);
  let cursor = 0;
  for (const c of chunks) {
    finalBytes.set(c, cursor);
    cursor += c.byteLength;
  }
  return finalBytes;
}

export async function renderErToPdfBytes(
  doc: ErSvgExportDocument,
  plan: ErExportResolutionPlan,
  options: Pick<ErVisualExportOptions, 'pdfPageMode'>,
  title: string,
  onProgress?: (p: ErExportProgress) => void,
): Promise<Uint8Array> {
  const pages: PdfPageSpec[] = [];

  if (options.pdfPageMode === 'single-page') {
    const ptPerWorldPx = plan.pdfPageWidthPt / Math.max(doc.width, 1);
    const maxStripPixH = Math.max(
      256,
      Math.min(
        MAX_PDF_STRIP_PIXELS_H,
        Math.floor(MAX_PDF_STRIP_PIXELS_AREA / Math.max(plan.pixelWidth, 1)),
      ),
    );
    const stripCount = Math.max(1, Math.ceil(plan.pixelHeight / maxStripPixH));
    const placements: PdfLosslessImagePlacement[] = [];

    for (let s = 0; s < stripCount; s += 1) {
      onProgress?.({
        stage: 'raster',
        label:
          stripCount > 1
            ? `正在无损渲染 PDF 分块 ${s + 1}/${stripCount}…`
            : `正在按 ${plan.pixelWidth} × ${plan.pixelHeight} px 渲染无损 PDF…`,
        current: s + 1,
        total: stripCount,
      });

      const pixY0 = s * maxStripPixH;
      const pixY1 = Math.min(plan.pixelHeight, pixY0 + maxStripPixH);
      const stripPixH = pixY1 - pixY0;
      const worldY0 = doc.viewBoxY + (pixY0 / plan.pixelHeight) * doc.height;
      const worldH = (stripPixH / plan.pixelHeight) * doc.height;

      const canvas = await rasterizeSvgRegion(
        doc.svg,
        doc.viewBoxX,
        worldY0,
        doc.width,
        worldH,
        plan.pixelWidth,
        stripPixH,
        doc.backgroundHex,
      );
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('无法读取 PDF 渲染像素');
      const imgData = ctx.getImageData(0, 0, plan.pixelWidth, stripPixH);
      canvas.width = 0;
      canvas.height = 0;

      const filtered = encodeRgbToPngSubScanlines(
        imgData.data,
        plan.pixelWidth,
        stripPixH,
      );
      const compressed = await compressZlibFlate(filtered);

      const baseHeightPt = worldH * ptPerWorldPx;
      // PDF Y=0 is at bottom; worldY0 grows downward from doc.viewBoxY.
      // Add a 0.25pt bleed on non-final strips so fractional PDF viewer zooms never show 1px seam lines.
      const bleedPt = s < stripCount - 1 ? 0.25 : 0;
      const topOffsetPt = (worldY0 - doc.viewBoxY) * ptPerWorldPx;
      const drawHeightPt = baseHeightPt + bleedPt;
      const drawYPt = Math.max(
        0,
        plan.pdfPageHeightPt - topOffsetPt - drawHeightPt,
      );

      placements.push({
        pixelWidth: plan.pixelWidth,
        pixelHeight: stripPixH,
        flateSubRgbBytes: compressed,
        drawXPt: 0,
        drawYPt,
        drawWidthPt: plan.pdfPageWidthPt,
        drawHeightPt,
      });
    }

    pages.push({
      widthPt: plan.pdfPageWidthPt,
      heightPt: plan.pdfPageHeightPt,
      backgroundRgb: doc.backgroundRgb,
      images: placements,
    });
  } else {
    // Tiled A4 / A3 multi-page PDF
    const usableW = plan.pdfPageWidthPt - PDF_TILED_MARGIN_PT * 2;
    const usableH =
      plan.pdfPageHeightPt - PDF_TILED_MARGIN_PT * 2 - PDF_TILED_FOOTER_PT;
    const tileWorldW = usableW / PDF_TILED_SCALE_PT_PER_PX;
    const tileWorldH = usableH / PDF_TILED_SCALE_PT_PER_PX;

    let pageNum = 0;
    const totalPages = plan.pdfGridCols * plan.pdfGridRows;

    for (let r = 0; r < plan.pdfGridRows; r += 1) {
      for (let c = 0; c < plan.pdfGridCols; c += 1) {
        pageNum += 1;
        onProgress?.({
          stage: 'raster',
          label: `正在渲染分页 PDF 第 ${pageNum}/${totalPages} 页…`,
          current: pageNum,
          total: totalPages,
        });

        const cropX = doc.viewBoxX + c * tileWorldW;
        const cropY = doc.viewBoxY + r * tileWorldH;
        const cropW = Math.min(tileWorldW, doc.viewBoxX + doc.width - cropX);
        const cropH = Math.min(tileWorldH, doc.viewBoxY + doc.height - cropY);
        if (cropW <= 0 || cropH <= 0) continue;

        const pixW = Math.max(1, Math.round(cropW * plan.effectiveScale));
        const pixH = Math.max(1, Math.round(cropH * plan.effectiveScale));

        const canvas = await rasterizeSvgRegion(
          doc.svg,
          cropX,
          cropY,
          cropW,
          cropH,
          pixW,
          pixH,
          doc.backgroundHex,
        );
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('无法读取分页 PDF 像素');
        const imgData = ctx.getImageData(0, 0, pixW, pixH);
        canvas.width = 0;
        canvas.height = 0;

        const filtered = encodeRgbToPngSubScanlines(imgData.data, pixW, pixH);
        const compressed = await compressZlibFlate(filtered);

        const drawW = cropW * PDF_TILED_SCALE_PT_PER_PX;
        const drawH = cropH * PDF_TILED_SCALE_PT_PER_PX;
        const drawX = PDF_TILED_MARGIN_PT;
        const drawY = plan.pdfPageHeightPt - PDF_TILED_MARGIN_PT - drawH;

        const safeAsciiTitle =
          title.replace(/[^\x20-\x7E]/g, '').trim() || 'ER Diagram';
        pages.push({
          widthPt: plan.pdfPageWidthPt,
          heightPt: plan.pdfPageHeightPt,
          backgroundRgb: doc.backgroundRgb,
          images: [
            {
              pixelWidth: pixW,
              pixelHeight: pixH,
              flateSubRgbBytes: compressed,
              drawXPt: drawX,
              drawYPt: drawY,
              drawWidthPt: drawW,
              drawHeightPt: drawH,
            },
          ],
          footerAscii: `${safeAsciiTitle}  |  Tile R${r + 1}C${c + 1}  (Page ${pageNum} / ${totalPages})`,
        });
      }
    }
  }

  onProgress?.({ stage: 'encode', label: '正在组装无损 PDF 1.4 文档…' });
  return assembleLosslessPdfDocument(pages, {
    title: `ER · ${title}`,
    creator: 'Seamind Database ER Studio',
  });
}

/* --------------------------------------------------------------------------
   5. Safe Base64 & Browser Fallback Helpers
   -------------------------------------------------------------------------- */

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    let s = '';
    for (let j = 0; j < sub.length; j += 1) {
      s += String.fromCharCode(sub[j]);
    }
    parts.push(s);
  }
  return btoa(parts.join(''));
}

export function utf8ToBase64(text: string): string {
  return uint8ArrayToBase64(new TextEncoder().encode(text));
}

export function triggerBrowserBinaryDownload(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
