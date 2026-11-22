import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../app/app-storage';
import {
  columnIndexToLetters,
  EXCEL_INLINE_MAX_COLS,
  EXCEL_INLINE_MAX_ROWS,
  EXCEL_TREE_MAX_ROWS,
  type ParsedExcelWorkbook,
  shouldExternalizeExcelTable,
  sliceExcelSheet,
  stripExcelExtension,
} from './mindmap-excel';

export type ExcelImportMode = 'table' | 'tree';

export interface ExcelImportConfirmPayload {
  mode: ExcelImportMode;
  sheetName: string;
  fileName: string;
  nodeTitle: string;
  headers: string[];
  rows: string[][];
  colCount: number;
  labelColIndex: number;
  groupColIndex: number | null;
}

interface MindmapExcelImportDialogProps {
  workbook: ParsedExcelWorkbook;
  nodeLabel: string;
  theme: Theme;
  busy: boolean;
  error: string;
  onChooseAnotherFile: () => void;
  onCancel: () => void;
  onConfirm: (payload: ExcelImportConfirmPayload) => void;
}

const PREVIEW_ROW_LIMIT = 40;
const PREVIEW_COL_LIMIT = 24;

export function MindmapExcelImportDialog({
  workbook,
  nodeLabel,
  theme,
  busy,
  error,
  onChooseAnotherFile,
  onCancel,
  onConfirm,
}: MindmapExcelImportDialogProps) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const currentSheet = workbook.sheets[sheetIndex] ?? workbook.sheets[0];

  const [startRow, setStartRow] = useState(1);
  const [endRow, setEndRow] = useState(() =>
    Math.max(1, currentSheet?.rowCount ?? 1),
  );
  const [startCol, setStartCol] = useState(1);
  const [endCol, setEndCol] = useState(() =>
    Math.max(1, currentSheet?.colCount ?? 1),
  );
  const [firstRowAsHeader, setFirstRowAsHeader] = useState(true);
  const [mode, setMode] = useState<ExcelImportMode>('table');
  const [nodeTitle, setNodeTitle] = useState(() => {
    const stem = stripExcelExtension(workbook.fileName);
    const sName = currentSheet?.name ?? '';
    return sName && workbook.sheets.length > 1 ? `${stem} · ${sName}` : stem;
  });
  const [titleDirty, setTitleDirty] = useState(false);
  const [labelColIndex, setLabelColIndex] = useState(0);
  const [groupColIndex, setGroupColIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!currentSheet) return;
    setStartRow(1);
    setEndRow(Math.max(1, currentSheet.rowCount));
    setStartCol(1);
    setEndCol(Math.max(1, currentSheet.colCount));
    setLabelColIndex(0);
    setGroupColIndex(null);
    if (!titleDirty) {
      const stem = stripExcelExtension(workbook.fileName);
      setNodeTitle(
        workbook.sheets.length > 1 ? `${stem} · ${currentSheet.name}` : stem,
      );
    }
  }, [
    sheetIndex,
    currentSheet,
    workbook.fileName,
    workbook.sheets.length,
    titleDirty,
  ]);

  const sliced = useMemo(() => {
    if (!currentSheet) {
      return { headers: [], rows: [], rowCount: 0, colCount: 0 };
    }
    return sliceExcelSheet(currentSheet, {
      startRow,
      endRow,
      startCol,
      endCol,
      firstRowAsHeader,
    });
  }, [currentSheet, startRow, endRow, startCol, endCol, firstRowAsHeader]);

  const storageHint = useMemo(
    () => shouldExternalizeExcelTable(sliced),
    [sliced],
  );

  useEffect(() => {
    if (sliced.headers.length === 0) {
      setLabelColIndex(0);
      setGroupColIndex(null);
      return;
    }
    if (labelColIndex >= sliced.headers.length) {
      setLabelColIndex(0);
    }
    if (
      groupColIndex !== null &&
      (groupColIndex >= sliced.headers.length ||
        groupColIndex === labelColIndex)
    ) {
      setGroupColIndex(null);
    }
  }, [sliced.headers.length, labelColIndex, groupColIndex]);

  const canConfirm =
    !busy &&
    currentSheet !== undefined &&
    sliced.headers.length > 0 &&
    (mode === 'table' || sliced.rows.length > 0);

  const handleResetRange = () => {
    if (!currentSheet) return;
    setStartRow(1);
    setEndRow(Math.max(1, currentSheet.rowCount));
    setStartCol(1);
    setEndCol(Math.max(1, currentSheet.colCount));
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canConfirm || !currentSheet) return;
    onConfirm({
      mode,
      sheetName: currentSheet.name,
      fileName: workbook.fileName,
      nodeTitle: nodeTitle.trim(),
      headers: sliced.headers,
      rows: sliced.rows,
      colCount: sliced.colCount,
      labelColIndex,
      groupColIndex,
    });
  };

  const previewHeaders = sliced.headers.slice(0, PREVIEW_COL_LIMIT);
  const previewRows = sliced.rows.slice(0, PREVIEW_ROW_LIMIT);
  const maxSheetRows = Math.max(1, currentSheet?.rowCount ?? 1);
  const maxSheetCols = Math.max(1, currentSheet?.colCount ?? 1);

  const dialog = (
    <div
      className="settings-backdrop"
      data-theme={theme}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form className="settings-dialog mm-excel-dialog" onSubmit={handleSubmit}>
        <div className="settings-heading">
          <div className="mm-excel-head-meta">
            <span className="pane-kicker">
              EXCEL WORKBOOK · {workbook.format.toUpperCase()}
            </span>
            <h2>导入 Excel 表格到思维导图</h2>
          </div>
          <div className="mm-excel-head-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={onChooseAnotherFile}
            >
              更换文件
            </button>
            <button
              type="button"
              className="dialog-close"
              aria-label="关闭"
              disabled={busy}
              onClick={onCancel}
            >
              ×
            </button>
          </div>
        </div>

        <div className="mm-excel-file-strip">
          <div className="mm-excel-file-name" title={workbook.filePath}>
            <strong>{workbook.fileName}</strong>
            <span>将作为「{nodeLabel || '当前节点'}」的子内容插入</span>
          </div>
          {currentSheet && (
            <span className="mm-excel-file-stats">
              {currentSheet.rowCount} 行 × {currentSheet.colCount} 列
              {currentSheet.truncated ? '（已按安全上限截断）' : ''}
            </span>
          )}
        </div>

        {workbook.sheets.length > 1 && (
          <div
            className="mm-excel-sheet-tabs"
            role="tablist"
            aria-label="工作表列表"
          >
            {workbook.sheets.map((sheet, index) => (
              <button
                key={`${sheet.name}-${index}`}
                type="button"
                role="tab"
                aria-selected={index === sheetIndex}
                className={`mm-excel-sheet-tab${index === sheetIndex ? ' is-active' : ''}`}
                onClick={() => setSheetIndex(index)}
              >
                <span>{sheet.name}</span>
                <em>
                  {sheet.rowCount}×{sheet.colCount}
                </em>
              </button>
            ))}
          </div>
        )}

        <div className="mm-excel-controls-grid">
          <label className="settings-field mm-excel-title-field">
            节点标题（可选，留空直接挂载）
            <input
              type="text"
              value={nodeTitle}
              onChange={(event) => {
                setTitleDirty(true);
                setNodeTitle(event.target.value);
              }}
              placeholder="例如：Q1 销售统计"
            />
          </label>

          <div className="mm-excel-range-box">
            <span className="mm-excel-range-label">导入范围与表头</span>
            <div className="mm-excel-range-inputs">
              <label>
                行
                <input
                  type="number"
                  min={1}
                  max={maxSheetRows}
                  value={startRow}
                  onChange={(e) => setStartRow(Number(e.target.value) || 1)}
                />
                <span>~</span>
                <input
                  type="number"
                  min={1}
                  max={maxSheetRows}
                  value={endRow}
                  onChange={(e) =>
                    setEndRow(Number(e.target.value) || maxSheetRows)
                  }
                />
              </label>
              <label>
                列
                <input
                  type="number"
                  min={1}
                  max={maxSheetCols}
                  value={startCol}
                  onChange={(e) => setStartCol(Number(e.target.value) || 1)}
                />
                <span>~</span>
                <input
                  type="number"
                  min={1}
                  max={maxSheetCols}
                  value={endCol}
                  onChange={(e) =>
                    setEndCol(Number(e.target.value) || maxSheetCols)
                  }
                />
              </label>
              <label className="mm-excel-header-check">
                <input
                  type="checkbox"
                  checked={firstRowAsHeader}
                  onChange={(e) => setFirstRowAsHeader(e.target.checked)}
                />
                <span>首行作表头</span>
              </label>
              <button
                type="button"
                className="mm-excel-reset-range"
                onClick={handleResetRange}
              >
                全表
              </button>
            </div>
          </div>
        </div>

        <div
          className="mm-excel-mode-grid"
          role="radiogroup"
          aria-label="导入模式"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'table'}
            className={`mm-excel-mode-card${mode === 'table' ? ' is-selected' : ''}`}
            onClick={() => setMode('table')}
          >
            <strong>模式 A：网格表格卡片</strong>
            <span>
              保留完整二维行列（表头吸顶、双向滚动、支持一键复制 Markdown /
              CSV）。
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'tree'}
            className={`mm-excel-mode-card${mode === 'tree' ? ' is-selected' : ''}`}
            onClick={() => setMode('tree')}
          >
            <strong>模式 B：拆分为导图分支树</strong>
            <span>
              按行自动展开为可编辑节点树，支持按列分组归纳与属性子节点。
            </span>
          </button>
        </div>

        {mode === 'tree' && sliced.headers.length > 0 && (
          <div className="mm-excel-tree-options">
            <label>
              分支标题列
              <select
                value={labelColIndex}
                onChange={(e) => setLabelColIndex(Number(e.target.value))}
              >
                {sliced.headers.map((header, idx) => (
                  <option key={`${header}-${idx}`} value={idx}>
                    {columnIndexToLetters(startCol - 1 + idx)} · {header}
                  </option>
                ))}
              </select>
            </label>
            <label>
              二级分组列（可选）
              <select
                value={groupColIndex === null ? '' : String(groupColIndex)}
                onChange={(e) =>
                  setGroupColIndex(
                    e.target.value === '' ? null : Number(e.target.value),
                  )
                }
              >
                <option value="">不分组（直接展开每行）</option>
                {sliced.headers.map((header, idx) =>
                  idx === labelColIndex ? null : (
                    <option key={`${header}-${idx}`} value={String(idx)}>
                      {columnIndexToLetters(startCol - 1 + idx)} · {header}
                    </option>
                  ),
                )}
              </select>
            </label>
            <span className="mm-excel-tree-count">
              {sliced.rows.length > EXCEL_TREE_MAX_ROWS
                ? `共 ${sliced.rows.length} 行，分支模式将导入前 ${EXCEL_TREE_MAX_ROWS} 行`
                : `预计生成 ${sliced.rows.length} 条记录节点`}
            </span>
          </div>
        )}

        {mode === 'table' && sliced.rowCount > 0 && (
          <p className="mm-excel-storage-note">
            {storageHint.externalize
              ? `大表优化：${storageHint.reason}（卡片分页流畅浏览，导出仍含全部 ${sliced.rowCount} 行）。`
              : `将直接生成标准 Markdown 表格（当前 ${sliced.rowCount} 行 ≤ ${EXCEL_INLINE_MAX_ROWS} 行 / ${EXCEL_INLINE_MAX_COLS} 列），可在左侧源码直接编辑。`}
          </p>
        )}

        <div className="mm-excel-preview-wrap">
          <div className="mm-excel-preview-bar">
            <span>
              数据预览（已选 {sliced.rowCount} 行 × {sliced.colCount} 列
              {sliced.rowCount > PREVIEW_ROW_LIMIT ||
              sliced.colCount > PREVIEW_COL_LIMIT
                ? `，下方展示前 ${Math.min(PREVIEW_ROW_LIMIT, sliced.rowCount)} 行 × ${Math.min(PREVIEW_COL_LIMIT, sliced.colCount)} 列`
                : ''}
              ）
            </span>
          </div>
          {sliced.headers.length === 0 ? (
            <div className="mm-excel-preview-empty">
              当前工作表或所选范围为空
            </div>
          ) : (
            <div className="mm-excel-preview-scroll">
              <table className="mm-excel-preview-table">
                <thead>
                  <tr>
                    <th className="mm-excel-row-num">#</th>
                    {previewHeaders.map((header, idx) => (
                      <th key={`${header}-${idx}`}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, rowIdx) => (
                    <tr key={rowIdx}>
                      <td className="mm-excel-row-num">{rowIdx + 1}</td>
                      {previewHeaders.map((_, colIdx) => (
                        <td key={colIdx}>{row[colIdx] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {error && (
          <p className="generation-error" role="alert">
            {error}
          </p>
        )}

        <div className="settings-footer">
          <span>支持 .xlsx / .xlsm / .csv / .tsv</span>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button type="submit" className="done-button" disabled={!canConfirm}>
            {busy
              ? '正在写入…'
              : mode === 'table'
                ? '插入表格卡片'
                : '拆分为导图节点'}
          </button>
        </div>
      </form>
    </div>
  );

  return createPortal(dialog, document.body);
}
