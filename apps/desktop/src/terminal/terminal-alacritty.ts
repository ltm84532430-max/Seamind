/**
 * Alacritty 风格终端增强纯逻辑模块：
 * - Windows verbatim (`\\?\`) 路径清理
 * - 软折行行拼合与可见缓冲 Hints（URL / 文件路径:行号）提取及快捷键标号分配
 * - 纯键盘 Vi Mode 光标与字符/行选区状态机
 */

export function normalizeDisplayPath(path: string | null | undefined): string {
  if (!path) return '';
  if (path.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${path.slice(8)}`;
  }
  if (path.startsWith('\\\\?\\')) {
    return path.slice(4);
  }
  return path;
}

export interface VisibleBufferRow {
  viewportRow: number;
  text: string;
  isWrapped: boolean;
}

export interface HintSegment {
  viewportRow: number;
  col: number;
  length: number;
}

export type TerminalHintKind = 'url' | 'path';

export interface TerminalHintMatch {
  id: string;
  label: string;
  kind: TerminalHintKind;
  value: string;
  segments: HintSegment[];
}

const HINT_ALPHABET = 'asdfghjklqwertyuiopzxcvbnm';

const URL_REGEX = /https?:\/\/[^\s<>'"`\]]+/g;
const WIN_PATH_REGEX = /(?:[A-Za-z]:\\|\\\\)[^\s<>'"`|*?]+(?::\d+(?::\d+)?)?/g;
const UNIX_PATH_REGEX =
  /(?:(?<![A-Za-z0-9_])(?:\/|\.\/|\.\.\/)|(?:[A-Za-z0-9_.-]+\/)+)[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g;

function trimHintMatch(raw: string, kind: TerminalHintKind): string {
  let text = raw;
  const trailingSet = new Set([',', ';', '!', '?', "'", '"', '`', '.', ']']);
  while (text.length > 1) {
    const tail = text[text.length - 1];
    if (tail === ')') {
      const openCount = (text.match(/\(/g) ?? []).length;
      const closeCount = (text.match(/\)/g) ?? []).length;
      if (closeCount > openCount) {
        text = text.slice(0, -1);
        continue;
      }
      break;
    }
    if (trailingSet.has(tail)) {
      if (kind === 'path' && tail === '.' && text.endsWith('..')) break;
      text = text.slice(0, -1);
      continue;
    }
    if (tail === ':' && kind === 'url') {
      text = text.slice(0, -1);
      continue;
    }
    break;
  }
  return text;
}

export function generateHintLabels(count: number): string[] {
  if (count <= 0) return [];
  const alphaLen = HINT_ALPHABET.length;
  if (count <= alphaLen) {
    return Array.from({ length: count }, (_, idx) => HINT_ALPHABET[idx]);
  }
  const labels: string[] = [];
  for (let i = 0; i < alphaLen && labels.length < count; i += 1) {
    for (let j = 0; j < alphaLen && labels.length < count; j += 1) {
      labels.push(`${HINT_ALPHABET[i]}${HINT_ALPHABET[j]}`);
    }
  }
  return labels;
}

interface LogicalLineSlice {
  viewportRow: number;
  offsetStart: number;
  offsetEnd: number;
}

interface LogicalLineGroup {
  text: string;
  slices: LogicalLineSlice[];
}

function buildLogicalLines(
  rows: ReadonlyArray<VisibleBufferRow>,
): LogicalLineGroup[] {
  const groups: LogicalLineGroup[] = [];
  for (const row of rows) {
    const current = groups[groups.length - 1];
    if (row.isWrapped && current) {
      const offsetStart = current.text.length;
      current.text += row.text;
      current.slices.push({
        viewportRow: row.viewportRow,
        offsetStart,
        offsetEnd: current.text.length,
      });
    } else {
      groups.push({
        text: row.text,
        slices: [
          {
            viewportRow: row.viewportRow,
            offsetStart: 0,
            offsetEnd: row.text.length,
          },
        ],
      });
    }
  }
  return groups;
}

function mapSpanToSegments(
  slices: ReadonlyArray<LogicalLineSlice>,
  start: number,
  end: number,
): HintSegment[] {
  const segments: HintSegment[] = [];
  for (const slice of slices) {
    const overlapStart = Math.max(start, slice.offsetStart);
    const overlapEnd = Math.min(end, slice.offsetEnd);
    if (overlapEnd > overlapStart) {
      segments.push({
        viewportRow: slice.viewportRow,
        col: overlapStart - slice.offsetStart,
        length: overlapEnd - overlapStart,
      });
    }
  }
  return segments;
}

export function extractTerminalHints(
  rows: ReadonlyArray<VisibleBufferRow>,
): TerminalHintMatch[] {
  const groups = buildLogicalLines(rows);
  const rawMatches: Array<{
    kind: TerminalHintKind;
    value: string;
    segments: HintSegment[];
  }> = [];

  for (const group of groups) {
    const occupied: Array<{ start: number; end: number }> = [];
    const groupMatches: Array<{
      start: number;
      kind: TerminalHintKind;
      value: string;
      segments: HintSegment[];
    }> = [];
    const addMatches = (regex: RegExp, kind: TerminalHintKind) => {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(group.text)) !== null) {
        const cleaned = trimHintMatch(match[0], kind);
        if (!cleaned) continue;
        const start = match.index;
        const end = start + cleaned.length;
        if (occupied.some((span) => start < span.end && end > span.start)) {
          continue;
        }
        occupied.push({ start, end });
        const segments = mapSpanToSegments(group.slices, start, end);
        if (segments.length > 0) {
          groupMatches.push({ start, kind, value: cleaned, segments });
        }
      }
    };

    addMatches(URL_REGEX, 'url');
    addMatches(WIN_PATH_REGEX, 'path');
    addMatches(UNIX_PATH_REGEX, 'path');
    groupMatches.sort((a, b) => a.start - b.start);
    rawMatches.push(...groupMatches);
  }

  const labels = generateHintLabels(rawMatches.length);
  return rawMatches.map((item, idx) => ({
    id: `hint-${idx}`,
    label: labels[idx] ?? String(idx),
    kind: item.kind,
    value: item.value,
    segments: item.segments,
  }));
}

/* ---- Vi Mode Pure Cursor & Selection Engine ---- */

export type ViSelectionMode = 'normal' | 'char' | 'line';

export interface ViModeState {
  active: boolean;
  absLine: number;
  col: number;
  selectionMode: ViSelectionMode;
  anchorAbsLine: number;
  anchorCol: number;
}

export type ViMotion =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'line-start'
  | 'line-first-nonblank'
  | 'line-end'
  | 'word-next'
  | 'word-prev'
  | 'word-end'
  | 'top'
  | 'bottom'
  | 'page-up'
  | 'page-down'
  | 'screen-top'
  | 'screen-mid'
  | 'screen-bottom'
  | 'toggle-char'
  | 'toggle-line';

export interface ViMotionContext {
  totalLines: number;
  cols: number;
  viewportRows: number;
  viewportY: number;
  semanticEscapeChars: string;
  getLineText: (absLine: number) => string;
}

export function createViState(absLine: number, col: number): ViModeState {
  const safeLine = Math.max(0, absLine);
  const safeCol = Math.max(0, col);
  return {
    active: true,
    absLine: safeLine,
    col: safeCol,
    selectionMode: 'normal',
    anchorAbsLine: safeLine,
    anchorCol: safeCol,
  };
}

function isSeparatorChar(ch: string, semanticEscapeChars: string): boolean {
  if (!ch || /\s/.test(ch)) return true;
  return semanticEscapeChars.includes(ch);
}

function lineTrimmedEndCol(text: string): number {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) {
    end -= 1;
  }
  return Math.max(0, end - 1);
}

export function moveViCursor(
  state: ViModeState,
  motion: ViMotion,
  ctx: ViMotionContext,
): ViModeState {
  const maxLine = Math.max(0, ctx.totalLines - 1);
  const maxCol = Math.max(0, ctx.cols - 1);
  const clampLine = (v: number) => Math.max(0, Math.min(maxLine, v));
  const clampCol = (v: number) => Math.max(0, Math.min(maxCol, v));

  if (motion === 'toggle-char') {
    if (state.selectionMode === 'char') {
      return { ...state, selectionMode: 'normal' };
    }
    return {
      ...state,
      selectionMode: 'char',
      anchorAbsLine: state.absLine,
      anchorCol: state.col,
    };
  }
  if (motion === 'toggle-line') {
    if (state.selectionMode === 'line') {
      return { ...state, selectionMode: 'normal' };
    }
    return {
      ...state,
      selectionMode: 'line',
      anchorAbsLine: state.absLine,
      anchorCol: state.col,
    };
  }

  let nextLine = state.absLine;
  let nextCol = state.col;
  const currText = ctx.getLineText(nextLine);

  switch (motion) {
    case 'left':
      nextCol = clampCol(nextCol - 1);
      break;
    case 'right':
      nextCol = clampCol(nextCol + 1);
      break;
    case 'up':
      nextLine = clampLine(nextLine - 1);
      break;
    case 'down':
      nextLine = clampLine(nextLine + 1);
      break;
    case 'line-start':
      nextCol = 0;
      break;
    case 'line-first-nonblank': {
      const idx = currText.search(/\S/);
      nextCol = idx >= 0 ? clampCol(idx) : 0;
      break;
    }
    case 'line-end':
      nextCol = clampCol(lineTrimmedEndCol(currText));
      break;
    case 'top':
      nextLine = 0;
      nextCol = 0;
      break;
    case 'bottom':
      nextLine = maxLine;
      nextCol = 0;
      break;
    case 'page-up':
      nextLine = clampLine(
        nextLine - Math.max(1, Math.floor(ctx.viewportRows / 2)),
      );
      break;
    case 'page-down':
      nextLine = clampLine(
        nextLine + Math.max(1, Math.floor(ctx.viewportRows / 2)),
      );
      break;
    case 'screen-top':
      nextLine = clampLine(ctx.viewportY);
      break;
    case 'screen-mid':
      nextLine = clampLine(ctx.viewportY + Math.floor(ctx.viewportRows / 2));
      break;
    case 'screen-bottom':
      nextLine = clampLine(ctx.viewportY + ctx.viewportRows - 1);
      break;
    case 'word-next': {
      let col = nextCol;
      const esc = ctx.semanticEscapeChars;
      const lineLen = currText.length;
      if (col >= lineLen - 1 && nextLine < maxLine) {
        nextLine += 1;
        const nText = ctx.getLineText(nextLine);
        const firstNonSpace = nText.search(/\S/);
        nextCol = clampCol(firstNonSpace >= 0 ? firstNonSpace : 0);
      } else {
        const startSep = isSeparatorChar(currText[col] ?? ' ', esc);
        while (
          col < lineLen &&
          isSeparatorChar(currText[col] ?? ' ', esc) === startSep
        ) {
          col += 1;
        }
        while (col < lineLen && /\s/.test(currText[col] ?? '')) {
          col += 1;
        }
        if (col >= lineLen && nextLine < maxLine) {
          nextLine += 1;
          const nText = ctx.getLineText(nextLine);
          const firstNonSpace = nText.search(/\S/);
          nextCol = clampCol(firstNonSpace >= 0 ? firstNonSpace : 0);
        } else {
          nextCol = clampCol(Math.min(col, Math.max(0, lineLen - 1)));
        }
      }
      break;
    }
    case 'word-prev': {
      let col = nextCol;
      const esc = ctx.semanticEscapeChars;
      if (col <= 0 && nextLine > 0) {
        nextLine -= 1;
        nextCol = clampCol(lineTrimmedEndCol(ctx.getLineText(nextLine)));
      } else {
        col -= 1;
        while (col > 0 && /\s/.test(currText[col] ?? '')) {
          col -= 1;
        }
        const inWord = !isSeparatorChar(currText[col] ?? ' ', esc);
        while (
          col > 0 &&
          !isSeparatorChar(currText[col - 1] ?? ' ', esc) === inWord &&
          !/\s/.test(currText[col - 1] ?? '')
        ) {
          col -= 1;
        }
        nextCol = clampCol(col);
      }
      break;
    }
    case 'word-end': {
      let col = Math.min(nextCol + 1, Math.max(0, currText.length - 1));
      const esc = ctx.semanticEscapeChars;
      while (col < currText.length - 1 && /\s/.test(currText[col] ?? '')) {
        col += 1;
      }
      const inWord = !isSeparatorChar(currText[col] ?? ' ', esc);
      while (
        col < currText.length - 1 &&
        !isSeparatorChar(currText[col + 1] ?? ' ', esc) === inWord &&
        !/\s/.test(currText[col + 1] ?? '')
      ) {
        col += 1;
      }
      nextCol = clampCol(col);
      break;
    }
  }

  return {
    ...state,
    absLine: nextLine,
    col: nextCol,
  };
}

export interface ViXtermSelectionSpan {
  column: number;
  row: number;
  length: number;
}

export function computeViSelectionSpan(
  state: ViModeState,
  cols: number,
): ViXtermSelectionSpan | null {
  if (state.selectionMode === 'normal') return null;

  const startFirst =
    state.anchorAbsLine < state.absLine ||
    (state.anchorAbsLine === state.absLine && state.anchorCol <= state.col);

  const sLine = startFirst ? state.anchorAbsLine : state.absLine;
  const sCol = startFirst ? state.anchorCol : state.col;
  const eLine = startFirst ? state.absLine : state.anchorAbsLine;
  const eCol = startFirst ? state.col : state.anchorCol;

  if (state.selectionMode === 'line') {
    const lineCount = eLine - sLine + 1;
    return {
      column: 0,
      row: sLine,
      length: lineCount * cols,
    };
  }

  if (sLine === eLine) {
    return {
      column: sCol,
      row: sLine,
      length: eCol - sCol + 1,
    };
  }

  const length = cols - sCol + (eLine - sLine - 1) * cols + (eCol + 1);
  return {
    column: sCol,
    row: sLine,
    length: Math.max(1, length),
  };
}
