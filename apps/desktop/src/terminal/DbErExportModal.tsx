import { useEffect, useMemo, useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { Theme } from '../app/app-storage';
import {
  buildErExportSvgDocument,
  computeErExportPlan,
  renderErToPdfBytes,
  renderErToPngBytes,
  triggerBrowserBinaryDownload,
  uint8ArrayToBase64,
  utf8ToBase64,
  type ErExportPaletteMode,
  type ErExportProgress,
  type ErExportScale,
  type ErPdfOrientation,
  type ErPdfPageMode,
  type ErVisualExportFormat,
} from './db-er-export';
import type { ErDiagramState } from './db-er-model';
import { terminalApi } from './terminal-api';

export interface DbErExportModalProps {
  diagram: ErDiagramState;
  theme: Theme;
  onClose: () => void;
  onNotify?: (message: string) => void;
}

interface ExportSuccessState {
  path: string;
  bytes: number;
  format: ErVisualExportFormat;
  summary: string;
  isNativeSaved: boolean;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function sanitizeExportFilename(raw: string): string {
  return (
    raw
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '') || 'er_diagram'
  );
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ??
      (window as unknown as Record<string, unknown>).__TAURI__,
    )
  );
}

export function DbErExportModal({
  diagram,
  theme,
  onClose,
  onNotify,
}: DbErExportModalProps) {
  const [format, setFormat] = useState<ErVisualExportFormat>('png');
  const [scale, setScale] = useState<ErExportScale>(3);
  const [paletteMode, setPaletteMode] = useState<ErExportPaletteMode>('auto');
  const [expandAllColumns, setExpandAllColumns] = useState(true);
  const [includeGrid, setIncludeGrid] = useState(true);
  const [includeHeaderLegend, setIncludeHeaderLegend] = useState(true);
  const [showRelationLabels, setShowRelationLabels] = useState(true);
  const [pdfPageMode, setPdfPageMode] = useState<ErPdfPageMode>('single-page');
  const [pdfOrientation, setPdfOrientation] =
    useState<ErPdfOrientation>('auto');
  const [previewZoomMode, setPreviewZoomMode] = useState<'fit' | 'actual'>(
    'fit',
  );

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ErExportProgress | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<ExportSuccessState | null>(null);

  const svgDoc = useMemo(
    () =>
      buildErExportSvgDocument(diagram, {
        paletteMode,
        appTheme: theme,
        expandAllColumns,
        includeGrid,
        includeHeaderLegend,
        showRelationLabels,
      }),
    [
      diagram,
      expandAllColumns,
      includeGrid,
      includeHeaderLegend,
      paletteMode,
      showRelationLabels,
      theme,
    ],
  );

  const plan = useMemo(
    () =>
      computeErExportPlan(svgDoc, {
        format,
        scale,
        pdfPageMode,
        pdfOrientation,
      }),
    [format, pdfOrientation, pdfPageMode, scale, svgDoc],
  );

  // Build isolated object URL for crisp SVG live preview
  const [previewUrl, setPreviewUrl] = useState<string>('');
  useEffect(() => {
    const blob = new Blob([svgDoc.svg], {
      type: 'image/svg+xml;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [svgDoc.svg]);

  // Escape closes modal unless currently writing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const handleExport = async () => {
    if (busy) return;
    setError('');
    setSuccess(null);

    const baseName = sanitizeExportFilename(diagram.title);
    const scaleTag = format === 'svg' ? '' : `_${scale}x`;
    const defaultFilename = `${baseName}_ER${scaleTag}.${format}`;

    const filterMap: Record<
      ErVisualExportFormat,
      { name: string; extensions: string[]; title: string; mime: string }
    > = {
      png: {
        name: 'PNG 无损超清图片',
        extensions: ['png'],
        title: '选择 PNG 高清 ER 图保存位置',
        mime: 'image/png',
      },
      pdf: {
        name: 'PDF 高清文档',
        extensions: ['pdf'],
        title: '选择 PDF 高清 ER 图保存位置',
        mime: 'application/pdf',
      },
      svg: {
        name: 'SVG 矢量图',
        extensions: ['svg'],
        title: '选择 SVG 矢量 ER 图保存位置',
        mime: 'image/svg+xml;charset=utf-8',
      },
    };
    const meta = filterMap[format];

    const nativeTauri = isTauriRuntime();
    let chosenPath: string | null = null;

    if (nativeTauri) {
      try {
        const selected = await saveDialog({
          title: meta.title,
          defaultPath: defaultFilename,
          filters: [{ name: meta.name, extensions: meta.extensions }],
        });
        if (typeof selected !== 'string' || !selected.trim()) {
          return; // User cancelled save dialog
        }
        chosenPath = selected.trim();
        if (!chosenPath.toLowerCase().endsWith(`.${format}`)) {
          chosenPath = `${chosenPath}.${format}`;
        }
      } catch (dialogErr) {
        setError(
          `打开系统保存对话框失败：${dialogErr instanceof Error ? dialogErr.message : String(dialogErr)}`,
        );
        return;
      }
    }

    setBusy(true);
    try {
      let bytes: Uint8Array;
      let base64Payload: string;

      if (format === 'svg') {
        setProgress({ stage: 'encode', label: '正在准备纯矢量 SVG 文件…' });
        bytes = new TextEncoder().encode(svgDoc.svg);
        base64Payload = utf8ToBase64(svgDoc.svg);
      } else if (format === 'png') {
        bytes = await renderErToPngBytes(svgDoc, plan, setProgress);
        base64Payload = uint8ArrayToBase64(bytes);
      } else {
        bytes = await renderErToPdfBytes(
          svgDoc,
          plan,
          { pdfPageMode },
          diagram.title,
          setProgress,
        );
        base64Payload = uint8ArrayToBase64(bytes);
      }

      const summary =
        format === 'svg'
          ? `纯矢量 ${svgDoc.width} × ${svgDoc.height}`
          : format === 'png'
            ? `${plan.pixelWidth.toLocaleString()} × ${plan.pixelHeight.toLocaleString()} px (${plan.effectiveScale.toFixed(plan.clamped ? 2 : 0)}×)`
            : pdfPageMode === 'single-page'
              ? `单页无损 PDF · ${plan.pixelWidth.toLocaleString()} × ${plan.pixelHeight.toLocaleString()} px`
              : `${pdfPageMode === 'a4-tiled' ? 'A4' : 'A3'} 分页 PDF · ${plan.pdfPageCount} 页 (${plan.pdfGridCols}×${plan.pdfGridRows})`;

      if (nativeTauri && chosenPath) {
        setProgress({ stage: 'write', label: '正在写入磁盘文件…' });
        const written = await terminalApi.writeErExport({
          filePath: chosenPath,
          dataBase64: base64Payload,
        });
        setSuccess({
          path: chosenPath,
          bytes: written,
          format,
          summary,
          isNativeSaved: true,
        });
        onNotify?.(
          `已导出 ${format.toUpperCase()}（${summary} · ${formatByteSize(written)}）`,
        );
      } else {
        triggerBrowserBinaryDownload(bytes, defaultFilename, meta.mime);
        setSuccess({
          path: defaultFilename,
          bytes: bytes.byteLength,
          format,
          summary,
          isNativeSaved: false,
        });
        onNotify?.(`已触发浏览器下载 ${defaultFilename}`);
      }
    } catch (exportErr) {
      setError(
        exportErr instanceof Error
          ? exportErr.message
          : `导出 ${format.toUpperCase()} 失败，请重试。`,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const handleOpenSaved = async (revealInFolder: boolean) => {
    if (!success?.isNativeSaved) return;
    try {
      await terminalApi.openErExport({
        filePath: success.path,
        revealInFolder,
      });
    } catch (openErr) {
      setError(
        openErr instanceof Error ? openErr.message : '无法打开目标文件或目录。',
      );
    }
  };

  return (
    <div
      className="er-codec-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="er-codec-modal er-export-modal"
        role="dialog"
        aria-modal="true"
        aria-label="导出高清 ER 图表 (PNG / PDF / SVG)"
      >
        <div className="er-codec-modal-head">
          <div className="er-export-head-title">
            <h3>导出高清 ER 图表 · {diagram.title}</h3>
            <span className="er-export-head-badge">
              {svgDoc.tableCount} 表 · {svgDoc.relationCount} 关系 ·{' '}
              {svgDoc.areaCount} 分区
            </span>
          </div>
          <button
            type="button"
            className="er-edge-popover-close"
            disabled={busy}
            onClick={onClose}
            aria-label="关闭导出窗口"
          >
            ×
          </button>
        </div>

        <div className="er-export-body">
          {/* Left: Crisp Live SVG Preview Stage */}
          <div className="er-export-preview-col">
            <div className="er-export-preview-bar">
              <span className="er-export-preview-meta">
                画布 {svgDoc.width} × {svgDoc.height} px
                {format !== 'svg' && (
                  <>
                    {' '}
                    → 输出{' '}
                    <strong>
                      {plan.pixelWidth.toLocaleString()} ×{' '}
                      {plan.pixelHeight.toLocaleString()} px
                    </strong>
                  </>
                )}
              </span>
              <div className="er-toolbar-group">
                <button
                  type="button"
                  className={`er-filter-pill${previewZoomMode === 'fit' ? ' is-active' : ''}`}
                  onClick={() => setPreviewZoomMode('fit')}
                >
                  全景预览
                </button>
                <button
                  type="button"
                  className={`er-filter-pill${previewZoomMode === 'actual' ? ' is-active' : ''}`}
                  onClick={() => setPreviewZoomMode('actual')}
                  title="以 100% 原始清晰度滚动检查每个字段名、类型与连线细节"
                >
                  100% 细节检查
                </button>
              </div>
            </div>

            <div
              className={`er-export-preview-stage${previewZoomMode === 'actual' ? ' is-actual' : ''}`}
              style={{ backgroundColor: svgDoc.backgroundHex }}
            >
              {previewUrl && (
                <img
                  src={previewUrl}
                  alt={`ER 图谱导出预览：${diagram.title}`}
                  className={
                    previewZoomMode === 'actual'
                      ? 'er-export-preview-img is-actual'
                      : 'er-export-preview-img'
                  }
                  draggable={false}
                />
              )}
            </div>

            <div className="er-export-preview-foot">
              {format === 'png' && (
                <span>
                  {plan.clamped
                    ? `因画布极大已自动保护性缩放至 ${plan.effectiveScale.toFixed(2)}×（如需完整 ${scale}× 无上限超清，建议切至 PDF 单页无损拼接）`
                    : `无损 PNG · 实际倍率 ${plan.effectiveScale.toFixed(0)}× · 字段、类型与连线箭头全像素清晰`}
                </span>
              )}
              {format === 'pdf' && (
                <span>
                  {pdfPageMode === 'single-page'
                    ? `自适应单页无损 PDF（${Math.round(plan.pdfPageWidthPt)} × ${Math.round(plan.pdfPageHeightPt)} pt · ${plan.pdfStripCount} 块无缝无损编码）· 任意放大 400% 细节不糊`
                    : `${pdfPageMode === 'a4-tiled' ? 'A4' : 'A3'} 自动分页打印（共 ${plan.pdfPageCount} 页：${plan.pdfGridCols} 列 × ${plan.pdfGridRows} 行）· 300 DPI 级无损输出`}
                </span>
              )}
              {format === 'svg' && (
                <span>
                  纯矢量独立 SVG（零 foreignObject）· 无限缩放无锯齿，可导入
                  Figma / 浏览器 / 文档
                </span>
              )}
            </div>
          </div>

          {/* Right: Export Settings */}
          <div className="er-export-controls-col">
            <div className="er-export-section">
              <div className="er-export-section-label">1. 输出格式</div>
              <div className="er-export-format-grid">
                {(
                  [
                    ['png', 'PNG 图片', '无损超清'],
                    ['pdf', 'PDF 文档', '缩放/打印'],
                    ['svg', 'SVG 矢量', '无限缩放'],
                  ] as const
                ).map(([id, title, sub]) => (
                  <button
                    key={id}
                    type="button"
                    disabled={busy}
                    className={`er-export-choice-card${format === id ? ' is-active' : ''}`}
                    onClick={() => {
                      setFormat(id);
                      setSuccess(null);
                      setError('');
                    }}
                  >
                    <strong>{title}</strong>
                    <span>{sub}</span>
                  </button>
                ))}
              </div>
            </div>

            {format !== 'svg' && (
              <div className="er-export-section">
                <div className="er-export-section-label">2. 像素清晰度倍率</div>
                <div className="er-export-seg-row">
                  {(
                    [
                      [2, '2× 高清'],
                      [3, '3× 超清 (推荐)'],
                      [4, '4× 极致像素'],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      disabled={busy}
                      className={`er-export-seg-btn${scale === val ? ' is-active' : ''}`}
                      onClick={() => setScale(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {format === 'pdf' && (
              <div className="er-export-section">
                <div className="er-export-section-label">3. PDF 页面排布</div>
                <div className="er-export-stack">
                  {(
                    [
                      [
                        'single-page',
                        '自适应整图单页（推荐）',
                        '整张 ER 图完整连贯不裁断，在 PDF 阅读器内无限放大查看细节',
                      ],
                      [
                        'a4-tiled',
                        'A4 标准分页平铺',
                        '按可读字号自动切成多页 A4，适合直接打印装订',
                      ],
                      [
                        'a3-tiled',
                        'A3 大幅分页平铺',
                        '更大单页视野，减少跨页切分',
                      ],
                    ] as const
                  ).map(([mode, label, hint]) => (
                    <button
                      key={mode}
                      type="button"
                      disabled={busy}
                      className={`er-export-radio-row${pdfPageMode === mode ? ' is-active' : ''}`}
                      onClick={() => setPdfPageMode(mode)}
                    >
                      <strong>{label}</strong>
                      <span>{hint}</span>
                    </button>
                  ))}
                </div>

                {pdfPageMode !== 'single-page' && (
                  <div className="er-export-seg-row">
                    {(
                      [
                        ['auto', '方向：自动'],
                        ['portrait', '纵向'],
                        ['landscape', '横向'],
                      ] as const
                    ).map(([ori, label]) => (
                      <button
                        key={ori}
                        type="button"
                        disabled={busy}
                        className={`er-export-seg-btn${pdfOrientation === ori ? ' is-active' : ''}`}
                        onClick={() => setPdfOrientation(ori)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="er-export-section">
              <div className="er-export-section-label">画布配色</div>
              <div className="er-export-seg-row">
                {(
                  [
                    ['auto', '跟随当前'],
                    ['light', '纯净浅色'],
                    ['dark', '深邃暗色'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={busy}
                    className={`er-export-seg-btn${paletteMode === mode ? ' is-active' : ''}`}
                    onClick={() => setPaletteMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="er-export-section">
              <div className="er-export-section-label">细节呈现选项</div>
              <div className="er-export-checks">
                <label className="er-export-check">
                  <input
                    type="checkbox"
                    checked={expandAllColumns}
                    disabled={busy}
                    onChange={(e) => setExpandAllColumns(e.target.checked)}
                  />
                  <span>展开所有折叠表（导出全部字段与数据类型）</span>
                </label>
                <label className="er-export-check">
                  <input
                    type="checkbox"
                    checked={showRelationLabels}
                    disabled={busy}
                    onChange={(e) => setShowRelationLabels(e.target.checked)}
                  />
                  <span>显示关系基数标签（1:N / N:1 / 1:1）</span>
                </label>
                <label className="er-export-check">
                  <input
                    type="checkbox"
                    checked={includeHeaderLegend}
                    disabled={busy}
                    onChange={(e) => setIncludeHeaderLegend(e.target.checked)}
                  />
                  <span>顶部附加图谱标题栏与 PK/FK/外键图例</span>
                </label>
                <label className="er-export-check">
                  <input
                    type="checkbox"
                    checked={includeGrid}
                    disabled={busy}
                    onChange={(e) => setIncludeGrid(e.target.checked)}
                  />
                  <span>保留画布背景点阵参考网格</span>
                </label>
              </div>
            </div>

            {progress && (
              <div className="er-export-status" role="status">
                {progress.label}
              </div>
            )}

            {error && (
              <div className="er-export-error" role="alert">
                {error}
              </div>
            )}

            {success && (
              <div className="er-export-success" role="status">
                <div className="er-export-success-head">
                  <strong>导出完成 · {formatByteSize(success.bytes)}</strong>
                  <span>{success.summary}</span>
                </div>
                <div className="er-export-success-path" title={success.path}>
                  {success.path}
                </div>
                {success.isNativeSaved && (
                  <div className="er-export-success-actions">
                    <button
                      type="button"
                      className="er-tool-btn is-active"
                      onClick={() => void handleOpenSaved(false)}
                    >
                      直接打开查看
                    </button>
                    <button
                      type="button"
                      className="er-tool-btn"
                      onClick={() => void handleOpenSaved(true)}
                    >
                      在文件夹中显示
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="er-codec-modal-footer">
          <span className="er-side-card-meta">
            支持系统原生“另存为”选定任意目录 · 本地离线生成，不上传数据库结构
          </span>
          <div className="er-toolbar-group">
            <button
              type="button"
              className="er-tool-btn"
              disabled={busy}
              onClick={onClose}
            >
              {success ? '完成' : '取消'}
            </button>
            <button
              type="button"
              className="er-tool-btn is-primary"
              disabled={busy || diagram.tables.length === 0}
              onClick={() => void handleExport()}
            >
              {busy
                ? '正在高清渲染…'
                : `选择位置并保存 ${format.toUpperCase()}…`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
