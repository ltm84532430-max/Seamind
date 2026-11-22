import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PureNode } from 'markmap-lib';
import type { Theme } from '../app/app-storage';
import {
  analyzeExportTreeStats,
  type OfflineExportOptions,
} from './offline-export';

interface MindmapExportHtmlDialogProps {
  title: string;
  fullRoot: PureNode | null;
  focusedRoot: PureNode | null;
  hasFocusedBranch: boolean;
  theme: Theme;
  busy: boolean;
  error: string;
  exportedPath: string | null;
  exportedBytes: number;
  onCancel: () => void;
  onOpenInBrowser: (filePath: string) => void;
  onConfirm: (options: OfflineExportOptions) => void;
}

export function MindmapExportHtmlDialog({
  title,
  fullRoot,
  focusedRoot,
  hasFocusedBranch,
  theme,
  busy,
  error,
  exportedPath,
  exportedBytes,
  onCancel,
  onOpenInBrowser,
  onConfirm,
}: MindmapExportHtmlDialogProps) {
  const [scope, setScope] = useState<'full' | 'focused'>(
    hasFocusedBranch ? 'focused' : 'full',
  );
  const [preserveFoldAndView, setPreserveFoldAndView] = useState(true);
  const [includeMediaAndExcel, setIncludeMediaAndExcel] = useState(true);
  const [includeCodeResults, setIncludeCodeResults] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(true);

  const selectedRoot =
    scope === 'focused' && focusedRoot ? focusedRoot : fullRoot;

  const stats = useMemo(() => {
    if (!selectedRoot) {
      return {
        nodeCount: 0,
        mediaCount: 0,
        excelCount: 0,
        noteCount: 0,
        codeCount: 0,
        hasMath: false,
      };
    }
    return analyzeExportTreeStats(selectedRoot, includeNotes);
  }, [selectedRoot, includeNotes]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !selectedRoot) return;
    onConfirm({
      scope,
      preserveFoldAndView,
      includeMediaAndExcel,
      includeCodeResults,
      includeNotes,
    });
  };

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  const dialog = (
    <div
      className="settings-backdrop"
      data-theme={theme}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <form
        className="settings-dialog mm-export-dialog"
        onSubmit={handleSubmit}
      >
        <div className="settings-heading">
          <div>
            <span className="pane-kicker">OFFLINE HTML SHARE</span>
            <h2>导出离线可交互 HTML</h2>
          </div>
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

        <p className="settings-note">
          将「<strong>{title || '当前思维导图'}</strong>
          」打包为单一离线网页文件；对方在浏览器双击即可缩放、搜索、折叠/展开节点、查阅完整备注与表格。
        </p>

        <div className="mm-export-stats-grid">
          <div className="mm-export-stat">
            <strong>{stats.nodeCount}</strong>
            <span>导图节点</span>
          </div>
          <div className="mm-export-stat">
            <strong>{stats.noteCount}</strong>
            <span>节点备注</span>
          </div>
          <div className="mm-export-stat">
            <strong>{stats.mediaCount}</strong>
            <span>内联图片</span>
          </div>
          <div className="mm-export-stat">
            <strong>{stats.excelCount}</strong>
            <span>全量 Excel</span>
          </div>
          <div className="mm-export-stat">
            <strong>{stats.codeCount}</strong>
            <span>代码/图表</span>
          </div>
        </div>

        {hasFocusedBranch && focusedRoot && (
          <div
            className="mm-export-scope-row"
            role="radiogroup"
            aria-label="导出范围"
          >
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'full'}
              className={`mm-excel-sheet-tab${scope === 'full' ? ' is-active' : ''}`}
              onClick={() => setScope('full')}
            >
              导出整张思维导图
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'focused'}
              className={`mm-excel-sheet-tab${scope === 'focused' ? ' is-active' : ''}`}
              onClick={() => setScope('focused')}
            >
              仅导出当前聚焦分支
            </button>
          </div>
        )}

        <div className="mm-export-options">
          <label>
            <input
              type="checkbox"
              checked={preserveFoldAndView}
              onChange={(e) => setPreserveFoldAndView(e.target.checked)}
            />
            <div>
              <strong>保留当前交互与视图状态</strong>
              <span>
                保存当前已折叠/展开的节点、画布缩放视角、卡片/备注折叠状态及图片大小设置
              </span>
            </div>
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeMediaAndExcel}
              onChange={(e) => setIncludeMediaAndExcel(e.target.checked)}
            />
            <div>
              <strong>离线内联本地图片与完整 Excel 数据</strong>
              <span>
                将剪贴板/本地截图编码进 HTML，并附带外链大表的全部行列与分页能力
              </span>
            </div>
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeNotes}
              onChange={(e) => setIncludeNotes(e.target.checked)}
            />
            <div>
              <strong>包含节点 Markdown 备注卡片</strong>
              <span>支持分享页内全文展开、滚轮局部浏览和状态记忆</span>
            </div>
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeCodeResults}
              onChange={(e) => setIncludeCodeResults(e.target.checked)}
            />
            <div>
              <strong>打包最近一次代码运行输出（文本 / 图表）</strong>
              <span>
                分享者本地运行过的 Python / C++ 结果一并嵌入，方便查阅
              </span>
            </div>
          </label>
        </div>

        {exportedPath && (
          <div className="mm-export-success" role="status">
            <div>
              <strong>导出完成（{formatSize(exportedBytes)}）</strong>
              <span>{exportedPath}</span>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => onOpenInBrowser(exportedPath)}
            >
              在浏览器中打开验证
            </button>
          </div>
        )}

        {error && (
          <p className="generation-error" role="alert">
            {error}
          </p>
        )}

        <div className="settings-footer">
          <span>单文件零依赖 · 浏览器离线可用</span>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onCancel}
          >
            {exportedPath ? '完成' : '取消'}
          </button>
          <button
            type="submit"
            className="done-button"
            disabled={busy || !selectedRoot}
          >
            {busy
              ? '正在打包…'
              : exportedPath
                ? '重新导出…'
                : '另存为离线 HTML…'}
          </button>
        </div>
      </form>
    </div>
  );

  return createPortal(dialog, document.body);
}
