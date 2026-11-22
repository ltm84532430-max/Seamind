export interface ParsedExcelSheet {
  name: string;
  rowCount: number;
  colCount: number;
  truncated: boolean;
  rows: string[][];
}

export interface ParsedExcelWorkbook {
  fileName: string;
  filePath: string;
  format: 'xlsx' | 'xlsm' | 'csv' | 'tsv' | string;
  sheets: ParsedExcelSheet[];
}

export interface ExcelSliceOptions {
  /** 1-based start row index (inclusive). */
  startRow: number;
  /** 1-based end row index (inclusive). */
  endRow: number;
  /** 1-based start column index (inclusive). */
  startCol: number;
  /** 1-based end column index (inclusive). */
  endCol: number;
  /** Whether the first selected row is treated as the header row. */
  firstRowAsHeader: boolean;
}

export interface SlicedExcelTable {
  headers: string[];
  rows: string[][];
  rowCount: number;
  colCount: number;
}

export interface SeamindExcelDescriptor {
  assetId: string;
  title: string;
  fileName: string;
  sheetName: string;
  rowCount: number;
  colCount: number;
  headers: string[];
  previewRows: string[][];
}

export interface DocumentTableAsset {
  assetId: string;
  byteLength: number;
  reused: boolean;
}

export interface StoredExcelTablePayload {
  title: string;
  fileName: string;
  sheetName: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  colCount: number;
}

export const EXCEL_INLINE_MAX_ROWS = 80;
export const EXCEL_INLINE_MAX_COLS = 20;
export const EXCEL_INLINE_MAX_CHARS = 24_000;
export const EXCEL_TREE_MAX_ROWS = 200;

export function isExcelFilePath(filePath: string): boolean {
  return /\.(?:xlsx|xlsm|csv|tsv)$/i.test(filePath.trim());
}

export function stripExcelExtension(fileName: string): string {
  return fileName.replace(/\.(?:xlsx|xlsm|csv|tsv)$/i, '').trim() || fileName;
}

export function columnIndexToLetters(zeroBasedIndex: number): string {
  if (!Number.isInteger(zeroBasedIndex) || zeroBasedIndex < 0) return 'A';
  let value = zeroBasedIndex + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function normalizeCellInline(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line, idx, arr) => line.length > 0 || (idx > 0 && idx < arr.length - 1),
    )
    .join('<br>')
    .trim();
}

function normalizeCellForNodeText(value: string): string {
  return value
    .replace(/\r\n?/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([\\`*_~])/g, '\\$1')
    .replace(/^(#{1,6})\s/, '\\$1 ')
    .trim();
}

export function sliceExcelSheet(
  sheet: ParsedExcelSheet,
  options: ExcelSliceOptions,
): SlicedExcelTable {
  if (sheet.rowCount <= 0 || sheet.colCount <= 0 || sheet.rows.length === 0) {
    return { headers: [], rows: [], rowCount: 0, colCount: 0 };
  }
  const rStart = Math.max(
    1,
    Math.min(sheet.rows.length, Math.floor(options.startRow)),
  );
  const rEnd = Math.max(
    rStart,
    Math.min(sheet.rows.length, Math.floor(options.endRow)),
  );
  const cStart = Math.max(
    1,
    Math.min(sheet.colCount, Math.floor(options.startCol)),
  );
  const cEnd = Math.max(
    cStart,
    Math.min(sheet.colCount, Math.floor(options.endCol)),
  );

  const colCount = cEnd - cStart + 1;
  const slicedRaw: string[][] = [];
  for (let r = rStart - 1; r < rEnd; r += 1) {
    const sourceRow = sheet.rows[r] ?? [];
    const nextRow: string[] = [];
    for (let c = cStart - 1; c < cEnd; c += 1) {
      nextRow.push((sourceRow[c] ?? '').trim());
    }
    slicedRaw.push(nextRow);
  }

  if (slicedRaw.length === 0) {
    return { headers: [], rows: [], rowCount: 0, colCount: 0 };
  }

  let headers: string[];
  let bodyRows: string[][];
  if (options.firstRowAsHeader) {
    const rawHeaderRow = slicedRaw[0] ?? [];
    headers = Array.from({ length: colCount }, (_, idx) => {
      const label = rawHeaderRow[idx]?.replace(/\r?\n/g, ' ').trim();
      return label || `列 ${columnIndexToLetters(cStart - 1 + idx)}`;
    });
    bodyRows = slicedRaw.slice(1);
  } else {
    headers = Array.from(
      { length: colCount },
      (_, idx) => `列 ${columnIndexToLetters(cStart - 1 + idx)}`,
    );
    bodyRows = slicedRaw;
  }

  return {
    headers,
    rows: bodyRows,
    rowCount: bodyRows.length,
    colCount,
  };
}

export function buildExcelMarkdownTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  if (headers.length === 0) return '';
  const colCount = headers.length;
  const escapePipe = (text: string) =>
    normalizeCellInline(text).replace(/\|/g, '\\|');
  const formatRow = (cells: ReadonlyArray<string>) =>
    `| ${Array.from({ length: colCount }, (_, idx) => escapePipe(cells[idx] ?? '')).join(' | ')} |`;
  const separator = `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`;
  return [formatRow(headers), separator, ...rows.map(formatRow)].join('\n');
}

export function shouldExternalizeExcelTable(sliced: SlicedExcelTable): {
  externalize: boolean;
  reason?: string;
  markdownTable: string;
} {
  const markdownTable = buildExcelMarkdownTable(sliced.headers, sliced.rows);
  if (sliced.rowCount > EXCEL_INLINE_MAX_ROWS) {
    return {
      externalize: true,
      reason: `共 ${sliced.rowCount} 行（超过 ${EXCEL_INLINE_MAX_ROWS} 行），将自动存为工作区表格资源以防止编辑器卡顿`,
      markdownTable,
    };
  }
  if (sliced.colCount > EXCEL_INLINE_MAX_COLS) {
    return {
      externalize: true,
      reason: `共 ${sliced.colCount} 列（超过 ${EXCEL_INLINE_MAX_COLS} 列），将自动存为工作区表格资源`,
      markdownTable,
    };
  }
  if (markdownTable.length > EXCEL_INLINE_MAX_CHARS) {
    return {
      externalize: true,
      reason: '表格字符量较大，将自动存为工作区表格资源以保持画布流畅',
      markdownTable,
    };
  }
  return { externalize: false, markdownTable };
}

export function buildExternalExcelFence(
  descriptor: SeamindExcelDescriptor,
): string {
  const clean: SeamindExcelDescriptor = {
    assetId: descriptor.assetId,
    title: descriptor.title.trim() || descriptor.sheetName || 'Excel 表格',
    fileName: descriptor.fileName,
    sheetName: descriptor.sheetName,
    rowCount: descriptor.rowCount,
    colCount: descriptor.colCount,
    headers: descriptor.headers.slice(0, 64),
    previewRows: descriptor.previewRows.slice(0, 5),
  };
  return `\`\`\`seamind-excel\n${JSON.stringify(clean, null, 2)}\n\`\`\``;
}

export function parseExcelFenceDescriptor(
  rawSource: string,
): SeamindExcelDescriptor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSource.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const assetId = typeof obj.assetId === 'string' ? obj.assetId.trim() : '';
  if (assetId && !/^[a-f0-9]{64}$/i.test(assetId)) return null;
  const headers = Array.isArray(obj.headers)
    ? obj.headers.map((item) => String(item ?? ''))
    : [];
  const previewRows = Array.isArray(obj.previewRows)
    ? obj.previewRows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) => row.map((cell) => String(cell ?? '')))
    : [];
  const title =
    typeof obj.title === 'string' && obj.title.trim()
      ? obj.title.trim()
      : 'Excel 数据表';
  const fileName =
    typeof obj.fileName === 'string' ? obj.fileName.trim() : 'workbook.xlsx';
  const sheetName =
    typeof obj.sheetName === 'string' && obj.sheetName.trim()
      ? obj.sheetName.trim()
      : 'Sheet1';
  const rowCount = Number.isFinite(Number(obj.rowCount))
    ? Math.max(0, Math.floor(Number(obj.rowCount)))
    : previewRows.length;
  const colCount = Number.isFinite(Number(obj.colCount))
    ? Math.max(headers.length, Math.floor(Number(obj.colCount)))
    : headers.length;
  if (!assetId && headers.length === 0 && previewRows.length === 0) {
    return null;
  }
  return {
    assetId,
    title,
    fileName,
    sheetName,
    rowCount,
    colCount,
    headers,
    previewRows,
  };
}

export interface BuildExcelTreeOptions {
  rootTitle: string;
  headers: ReadonlyArray<string>;
  rows: ReadonlyArray<ReadonlyArray<string>>;
  labelColIndex: number;
  groupColIndex: number | null;
  includeEmptyFields?: boolean;
  maxRows?: number;
}

export function buildExcelTreeBranchMarkdown(options: BuildExcelTreeOptions): {
  markdown: string;
  importedRowCount: number;
  omittedRowCount: number;
} {
  const {
    rootTitle,
    headers,
    rows,
    labelColIndex,
    groupColIndex,
    includeEmptyFields = false,
    maxRows = EXCEL_TREE_MAX_ROWS,
  } = options;
  if (headers.length === 0 || rows.length === 0) {
    throw new Error('所选区域没有可拆分为节点的数据行。');
  }

  const safeRootTitle = normalizeCellForNodeText(rootTitle) || 'Excel 数据';
  const targetRows = rows.slice(0, Math.max(1, maxRows));
  const omittedRowCount = Math.max(0, rows.length - targetRows.length);

  const safeLabelCol =
    labelColIndex >= 0 && labelColIndex < headers.length ? labelColIndex : 0;
  const safeGroupCol =
    groupColIndex !== null &&
    groupColIndex >= 0 &&
    groupColIndex < headers.length &&
    groupColIndex !== safeLabelCol
      ? groupColIndex
      : null;

  const formatRecordLines = (
    row: ReadonlyArray<string>,
    rowIndex: number,
    headingPrefix: string,
  ): string[] => {
    const rawLabel = row[safeLabelCol] ?? '';
    const recordTitle =
      normalizeCellForNodeText(rawLabel) || `第 ${rowIndex + 1} 行`;
    const lines: string[] = [`${headingPrefix} ${recordTitle}`];
    headers.forEach((header, colIdx) => {
      if (colIdx === safeLabelCol || colIdx === safeGroupCol) return;
      const cellValue = normalizeCellForNodeText(row[colIdx] ?? '');
      if (!cellValue && !includeEmptyFields) return;
      const cleanHeader =
        normalizeCellForNodeText(header) || `列 ${colIdx + 1}`;
      const fieldPrefix = headingPrefix === '##' ? '###' : '####';
      lines.push(`${fieldPrefix} ${cleanHeader}: ${cellValue || '（空）'}`);
    });
    return lines;
  };

  const out: string[] = [`# ${safeRootTitle}`];
  if (safeGroupCol !== null) {
    const groups = new Map<
      string,
      Array<{ row: ReadonlyArray<string>; index: number }>
    >();
    targetRows.forEach((row, index) => {
      const groupName =
        normalizeCellForNodeText(row[safeGroupCol] ?? '') || '未分类';
      const bucket = groups.get(groupName);
      if (bucket) bucket.push({ row, index });
      else groups.set(groupName, [{ row, index }]);
    });
    for (const [groupName, items] of groups.entries()) {
      out.push(`## ${groupName}`);
      for (const { row, index } of items) {
        out.push(...formatRecordLines(row, index, '###'));
      }
    }
  } else {
    targetRows.forEach((row, index) => {
      out.push(...formatRecordLines(row, index, '##'));
    });
  }

  return {
    markdown: out.join('\n'),
    importedRowCount: targetRows.length,
    omittedRowCount,
  };
}
