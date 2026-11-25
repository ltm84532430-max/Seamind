import {
  memo,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type { Theme } from '../app/app-storage';
import { CodeLabEditor } from './CodeLabEditor';
import {
  LabArrowDownIcon,
  LabArrowUpIcon,
  LabCheckIcon,
  LabChevronDownIcon,
  LabCopyIcon,
  LabEditIcon,
  LabNoteIcon,
  LabPlayIcon,
  LabPlusIcon,
  LabSparkIcon,
  LabTerminalOutIcon,
  LabTrashIcon,
} from './CodeLabIcons';
import {
  formatDurationCompact,
  formatTableToCsv,
  formatTableToMarkdown,
  truncateOutputForDisplay,
  type CodeLabCell,
  type CodeLabOutputItem,
  type CodeLabTableOutput,
  type DataLabDbConnection,
} from './terminal-codelab-model';
import {
  BookProseView,
  KatexOutputBlock,
  SafeSvgOutput,
  SandboxedHtmlTableFrame,
} from './TerminalRichContent';
import type { TerminalCodeLabLanguage } from './terminal-types';

const LANG_LABEL: Record<TerminalCodeLabLanguage, string> = {
  python: 'PY',
  sql: 'SQL',
  r: 'R',
  c: 'C',
  cpp: 'C++',
};

const LANG_FULL: Record<TerminalCodeLabLanguage, string> = {
  python: 'Python',
  sql: 'SQL (数据库/本地文件)',
  r: 'R 语言',
  c: 'C (GCC)',
  cpp: 'C++ (G++)',
};

const DataTableOutput = memo(function DataTableOutput({
  table,
}: {
  table: CodeLabTableOutput;
}) {
  const [copiedMd, setCopiedMd] = useState(false);

  const handleCopyMarkdown = () => {
    const md = formatTableToMarkdown(table.columns, table.rows);
    if (!md) return;
    void navigator.clipboard?.writeText(md).then(() => {
      setCopiedMd(true);
      window.setTimeout(() => setCopiedMd(false), 1400);
    });
  };

  const handleExportCsv = () => {
    const csv = formatTableToCsv(table.columns, table.rows);
    if (!csv) return;
    const blob = new Blob([`\uFEFF${csv}`], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `query_result_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="codelab-data-table-wrap">
      <div className="codelab-data-table-bar">
        <div className="codelab-data-table-meta">
          {table.engine && (
            <span className="codelab-data-engine-pill">{table.engine}</span>
          )}
          <span>
            {table.rows.length} 行 × {table.columns.length} 列
            {table.truncated ? '（已截断预览）' : ''}
          </span>
          {table.boundVar && (
            <span className="codelab-data-bound-pill">
              已注入 → {table.boundVar}
            </span>
          )}
          {table.message && <span>{table.message}</span>}
        </div>
        {table.columns.length > 0 && (
          <div className="codelab-data-table-actions">
            <button
              type="button"
              className="codelab-data-mini-btn"
              onClick={handleCopyMarkdown}
            >
              {copiedMd ? '已复制 MD' : '复制 Markdown'}
            </button>
            <button
              type="button"
              className="codelab-data-mini-btn"
              onClick={handleExportCsv}
            >
              导出 CSV
            </button>
          </div>
        )}
      </div>
      {table.columns.length > 0 ? (
        <div className="codelab-data-table-scroll">
          <table className="codelab-data-table">
            <thead>
              <tr>
                <th className="codelab-data-idx-col">#</th>
                {table.columns.map((col, idx) => (
                  <th key={`${col.name}-${idx}`}>
                    <div className="codelab-data-th-inner">
                      <span>{col.name}</span>
                      <span className="codelab-data-col-type">
                        {col.dataType}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.columns.length + 1}
                    className="codelab-data-empty-cell"
                  >
                    查询返回 0 行结果
                  </td>
                </tr>
              ) : (
                table.rows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    <td className="codelab-data-idx-col">{rIdx + 1}</td>
                    {table.columns.map((_, cIdx) => {
                      const val = row[cIdx];
                      const isNull = val === null || val === undefined;
                      const isNum = typeof val === 'number';
                      return (
                        <td
                          key={cIdx}
                          className={
                            isNull ? 'is-null' : isNum ? 'is-num' : undefined
                          }
                        >
                          {isNull ? 'NULL' : String(val)}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
});

const LEGACY_STARTER_NOTES = new Set([
  '### Python Euporie 交互笔记本\n状态变量在格间持久化保存；按 `Shift+Enter` 运行并跳至下一格，`Esc` 切换命令模式（`j/k` 移动、`a/b` 插格、`dd` 删格）。',
  '### C 语言步进实验格\n上方可展开「共享头文件 / 辅助函数前置格」。每个代码格可独立输入测试 `stdin`，或一键发送给右侧 GDB / 终端交互运行。',
  '### C++ 交互实验本\n支持省略 `int main()` 直接写算法语句段，也可完整编写类与 STL 容器代码并通过 G++ 实时编译运行。',
]);

const GuardedTextOutput = memo(function GuardedTextOutput({
  text,
  className,
}: {
  text: string;
  className: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const slice = truncateOutputForDisplay(text);

  if (!slice.truncated || expanded) {
    return (
      <div className="codelab-text-block">
        <pre className={className}>{text}</pre>
        {slice.truncated && expanded && (
          <button
            type="button"
            className="codelab-output-expand-btn"
            onClick={() => setExpanded(false)}
          >
            收起长输出（共 {slice.totalLines.toLocaleString()} 行）
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="codelab-text-block">
      <pre className={className}>{slice.previewText}</pre>
      <button
        type="button"
        className="codelab-output-expand-btn"
        onClick={() => setExpanded(true)}
      >
        展开全部输出（共 {slice.totalLines.toLocaleString()} 行 ·{' '}
        {(slice.totalChars / 1024).toFixed(1)} KB）
      </button>
    </div>
  );
});

export const CellOutputList = memo(function CellOutputList({
  cellId,
  outputs,
  durationMs,
  stage,
  theme,
  onClearOutputs,
  onZoomImage,
  onPinOutput,
  pinned = false,
  stale = false,
}: {
  cellId: string;
  outputs: CodeLabOutputItem[];
  durationMs?: number;
  stage?: string;
  theme: Theme;
  onClearOutputs: (cellId: string) => void;
  onZoomImage: (src: string) => void;
  onPinOutput?: (cellId: string) => void;
  pinned?: boolean;
  stale?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const plainCopyText = outputs
    .map((o) => {
      if (o.kind === 'stream' || o.kind === 'text') return o.text;
      if (o.kind === 'error') return o.message;
      if (o.kind === 'text/latex') return o.latex;
      if (o.kind === 'table') return formatTableToMarkdown(o.columns, o.rows);
      return '';
    })
    .filter(Boolean)
    .join('\n');

  const handleCopy = () => {
    if (!plainCopyText) return;
    void navigator.clipboard?.writeText(plainCopyText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const durationText = formatDurationCompact(durationMs);

  return (
    <div className={`codelab-outputs${collapsed ? ' is-collapsed' : ''}`}>
      <div className="codelab-outputs-meta">
        <button
          type="button"
          className="codelab-outputs-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <span className="codelab-outputs-label">OUT</span>
          {stage && <span className="codelab-outputs-stage">{stage}</span>}
          {durationText && (
            <span className="codelab-outputs-duration">{durationText}</span>
          )}
          <span className="codelab-outputs-count">
            {outputs.length} 项{collapsed ? ' · 已折叠' : ''}
          </span>
          {stale && <span className="codelab-outputs-stale">需要重新运行</span>}
        </button>
        <div className="codelab-outputs-tools">
          {onPinOutput && (
            <button
              type="button"
              className={`codelab-output-pin-btn${pinned ? ' is-active' : ''}`}
              onClick={() => onPinOutput(cellId)}
              aria-pressed={pinned}
              title={pinned ? '取消固定输出' : '固定输出到右侧'}
            >
              {pinned ? '取消固定' : '固定到右侧'}
            </button>
          )}
          {plainCopyText && (
            <button
              type="button"
              className="codelab-ghost-icon-btn"
              onClick={handleCopy}
              title="复制输出文本"
            >
              {copied ? <LabCheckIcon size={11} /> : <LabCopyIcon size={11} />}
            </button>
          )}
          <button
            type="button"
            className="codelab-ghost-icon-btn"
            onClick={() => onClearOutputs(cellId)}
            title="清空此格输出"
          >
            <LabTrashIcon size={11} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="codelab-outputs-body">
          {outputs.map((out, oIdx) => {
            if (out.kind === 'stream') {
              return (
                <GuardedTextOutput
                  key={oIdx}
                  text={out.text}
                  className={`codelab-stream is-${out.name}`}
                />
              );
            }
            if (out.kind === 'text') {
              return (
                <GuardedTextOutput
                  key={oIdx}
                  text={out.text}
                  className="codelab-text-out"
                />
              );
            }
            if (out.kind === 'image/png') {
              const handleDownloadImage = () => {
                const a = document.createElement('a');
                a.href = out.dataUrl;
                const ext = out.dataUrl.startsWith('data:image/jpeg')
                  ? 'jpg'
                  : out.dataUrl.startsWith('data:image/webp')
                    ? 'webp'
                    : 'png';
                a.download = `seamind_chart_${oIdx + 1}.${ext}`;
                a.click();
              };
              return (
                <div key={oIdx} className="codelab-image-wrap">
                  <div className="codelab-image-toolbar">
                    <button
                      type="button"
                      className="codelab-image-action-btn"
                      onClick={() => onZoomImage(out.dataUrl)}
                    >
                      放大查看
                    </button>
                    <button
                      type="button"
                      className="codelab-image-action-btn"
                      onClick={handleDownloadImage}
                    >
                      下载图片
                    </button>
                  </div>
                  <img
                    src={out.dataUrl}
                    alt="实验绘图输出（点击放大）"
                    title="点击放大查看图表"
                    onClick={() => onZoomImage(out.dataUrl)}
                  />
                </div>
              );
            }
            if (out.kind === 'image/svg+xml') {
              return <SafeSvgOutput key={oIdx} svg={out.svg} />;
            }
            if (out.kind === 'text/html') {
              return (
                <SandboxedHtmlTableFrame
                  key={oIdx}
                  html={out.html}
                  theme={theme}
                />
              );
            }
            if (out.kind === 'text/latex') {
              return <KatexOutputBlock key={oIdx} latex={out.latex} />;
            }
            if (out.kind === 'table') {
              return <DataTableOutput key={oIdx} table={out} />;
            }
            return (
              <GuardedTextOutput
                key={oIdx}
                text={out.message}
                className="codelab-error-out"
              />
            );
          })}
        </div>
      )}
    </div>
  );
});

export interface CodeLabCellRowProps {
  cell: CodeLabCell;
  index: number;
  totalCells: number;
  isFocused: boolean;
  isEditing: boolean;
  hydrated: boolean;
  theme: Theme;
  canSendToShell: boolean;
  canSendToAgent: boolean;
  liveSourceMapRef: MutableRefObject<Map<string, string>>;
  onSelectCell: (cellId: string) => void;
  onRequestHydrate: (cellId: string) => void;
  onCommitSource: (cellId: string, next: string) => void;
  onChangeLanguage: (cellId: string, lang: TerminalCodeLabLanguage) => void;
  onChangeStdin: (cellId: string, stdin: string) => void;
  dbConnections?: DataLabDbConnection[];
  onChangeSqlConfig?: (
    cellId: string,
    patch: { sqlConnectionId?: string; sqlResultVar?: string },
  ) => void;
  onToggleMarkdownEdit: (cellId: string) => void;
  onStartMarkdownEdit: (cellId: string) => void;
  onEditorFocus: (cellId: string) => void;
  onEditorBlur: (cellId: string) => void;
  onRunCell: (cellId: string, advance: boolean) => void;
  onEscapeCommandMode: (cellId: string) => void;
  onSendToShell: (cellId: string) => void;
  onSendToAgent: (cellId: string) => void;
  onMoveCell: (cellId: string, direction: 'up' | 'down') => void;
  onDeleteCell: (cellId: string) => void;
  onDuplicateCell?: (cellId: string) => void;
  onInsertCellBelow?: (cellId: string, kind: 'code' | 'markdown') => void;
  onExportCellToStudy?: (
    cellId: string,
    target: 'knowledge' | 'mindmap',
  ) => void;
  onClearOutputs: (cellId: string) => void;
  onZoomImage: (src: string) => void;
  onPinOutput: (cellId: string) => void;
  pinnedOutputCellId: string | null;
  nested?: boolean;
  hideSource?: boolean;
}

export const CodeLabCellRow = memo(function CodeLabCellRow({
  cell,
  index,
  totalCells,
  isFocused,
  isEditing,
  hydrated,
  theme,
  canSendToShell,
  canSendToAgent,
  liveSourceMapRef,
  onSelectCell,
  onRequestHydrate,
  onCommitSource,
  onChangeLanguage,
  onChangeStdin,
  dbConnections = [],
  onChangeSqlConfig,
  onToggleMarkdownEdit,
  onStartMarkdownEdit,
  onEditorFocus,
  onEditorBlur,
  onRunCell,
  onEscapeCommandMode,
  onSendToShell,
  onSendToAgent,
  onMoveCell,
  onDeleteCell,
  onDuplicateCell,
  onInsertCellBelow,
  onExportCellToStudy,
  onClearOutputs,
  onZoomImage,
  onPinOutput,
  pinnedOutputCellId,
  nested = false,
  hideSource = false,
}: CodeLabCellRowProps) {
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [copiedSource, setCopiedSource] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!langMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        langMenuRef.current &&
        e.target instanceof Node &&
        !langMenuRef.current.contains(e.target)
      ) {
        setLangMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [langMenuOpen]);

  const hasErr = cell.outputs.some((o) => o.kind === 'error');
  const isMarkdown = cell.kind === 'markdown';
  const isMarkdownPreview = isMarkdown && !isEditing;
  const isLegacyStarterNote = LEGACY_STARTER_NOTES.has(cell.source);
  const durationText = formatDurationCompact(cell.durationMs);
  const execLabel = isMarkdown
    ? 'MD'
    : cell.status === 'running'
      ? '[*]'
      : cell.executionCount !== null
        ? `[${cell.executionCount}]`
        : `[${index + 1}]`;

  return (
    <article
      data-cell-id={cell.id}
      className={`codelab-cell is-${cell.kind} is-${cell.status}${isFocused ? ' is-cell-focused' : ''}${isMarkdownPreview ? ' is-md-preview-mode' : ''}${nested ? ` is-nested-subblock is-lang-${isMarkdown ? 'md' : cell.language}` : ''}${hideSource && !isMarkdown ? ' is-source-hidden' : ''}`}
      onMouseDown={() => onSelectCell(cell.id)}
    >
      {cell.status === 'running' && (
        <div className="codelab-cell-progress" aria-hidden="true" />
      )}

      {/* Slim 36px execution rail: [n] + status dot; hover reveals Run button */}
      <div className="codelab-cell-gutter">
        {!isMarkdown ? (
          <button
            type="button"
            className="codelab-gutter-run-btn"
            onClick={(e) => {
              e.stopPropagation();
              onRunCell(cell.id, false);
            }}
            disabled={cell.status === 'running'}
            title={`运行第 ${index + 1} 格 (Ctrl+Enter)`}
            aria-label={`运行第 ${index + 1} 格`}
          >
            <span className="codelab-cell-prompt">{execLabel}</span>
            <span className="codelab-gutter-play-glyph" aria-hidden="true">
              <LabPlayIcon size={12} />
            </span>
          </button>
        ) : (
          <span className="codelab-cell-prompt is-md">MD</span>
        )}
        {!isMarkdown && (
          <span
            className={`codelab-gutter-status-dot is-${cell.status}`}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Main Paper-Stream Content */}
      <div className="codelab-cell-body">
        {/* Cell actions stay above the editor, revealed on hover/selection */}
        <div
          className={`codelab-cell-float-bar${langMenuOpen ? ' is-pinned' : ''}`}
          role="toolbar"
          aria-label="单元格操作"
        >
          {!isMarkdown ? (
            <div className="codelab-cell-lang-wrap" ref={langMenuRef}>
              <button
                type="button"
                className="codelab-float-btn is-lang"
                onClick={(e) => {
                  e.stopPropagation();
                  setLangMenuOpen((o) => !o);
                }}
                aria-expanded={langMenuOpen}
                aria-haspopup="menu"
                title="切换此格语言"
              >
                <span>{LANG_LABEL[cell.language]}</span>
                <LabChevronDownIcon size={10} />
              </button>
              {langMenuOpen && (
                <div className="codelab-cell-lang-menu" role="menu">
                  {(['python', 'sql', 'r', 'c', 'cpp'] as const).map(
                    (langOpt) => (
                      <button
                        key={langOpt}
                        type="button"
                        role="menuitemradio"
                        aria-checked={cell.language === langOpt}
                        className={cell.language === langOpt ? 'is-active' : ''}
                        onClick={(e) => {
                          e.stopPropagation();
                          onChangeLanguage(cell.id, langOpt);
                          setLangMenuOpen(false);
                        }}
                      >
                        <span>{LANG_FULL[langOpt]}</span>
                        {cell.language === langOpt && (
                          <LabCheckIcon size={11} />
                        )}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          ) : (
            <span className="codelab-float-tag">NOTE</span>
          )}

          {!isMarkdown && (
            <span
              className={`codelab-cell-state is-${cell.status}`}
              role="status"
            >
              {cell.status === 'running'
                ? '运行中'
                : cell.status === 'success'
                  ? '已运行'
                  : cell.status === 'error'
                    ? '运行失败'
                    : '待运行'}
            </span>
          )}

          {durationText && !isMarkdown && (
            <span className="codelab-cell-meta">{durationText}</span>
          )}

          <span className="codelab-float-sep" aria-hidden="true" />

          {isMarkdown ? (
            <button
              type="button"
              className="codelab-float-btn"
              onClick={(e) => {
                e.stopPropagation();
                onToggleMarkdownEdit(cell.id);
              }}
              title={isEditing ? '完成预览' : '编辑 Markdown 笔记'}
            >
              <LabEditIcon size={11} />
              <span>{isEditing ? '预览' : '编辑'}</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className="codelab-float-btn is-run"
                onClick={(e) => {
                  e.stopPropagation();
                  onRunCell(cell.id, false);
                }}
                disabled={cell.status === 'running'}
                title="运行此格 (Ctrl+Enter)"
              >
                <LabPlayIcon size={11} />
                <span>运行</span>
              </button>
              {canSendToShell && (
                <button
                  type="button"
                  className="codelab-float-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSendToShell(cell.id);
                  }}
                  title="在右侧终端窗格交互运行 / GDB"
                >
                  <LabTerminalOutIcon size={11} />
                </button>
              )}
              {hasErr && canSendToAgent && (
                <button
                  type="button"
                  className="codelab-float-btn is-debug"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSendToAgent(cell.id);
                  }}
                  title="发送报错给 Agent 诊断"
                >
                  <LabSparkIcon size={11} />
                  <span>诊断</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="codelab-float-btn"
            onClick={(e) => {
              e.stopPropagation();
              const src = liveSourceMapRef.current.get(cell.id) ?? cell.source;
              void navigator.clipboard?.writeText(src).then(() => {
                setCopiedSource(true);
                window.setTimeout(() => setCopiedSource(false), 1200);
              });
            }}
            title="复制单元格源码"
            aria-label="复制单元格源码"
          >
            {copiedSource ? (
              <LabCheckIcon size={11} />
            ) : (
              <LabCopyIcon size={11} />
            )}
          </button>

          {onDuplicateCell && (
            <button
              type="button"
              className="codelab-float-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDuplicateCell(cell.id);
              }}
              title="在下方克隆此单元格"
              aria-label="在下方克隆此单元格"
            >
              <span>克隆</span>
            </button>
          )}

          {onExportCellToStudy &&
            (cell.outputs.length > 0 || Boolean(cell.origin) || isMarkdown) && (
              <>
                <button
                  type="button"
                  className="codelab-float-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExportCellToStudy(cell.id, 'knowledge');
                  }}
                  title="将此格代码、结果与来源保存到知识库笔记"
                >
                  <span>记入知识库</span>
                </button>
                <button
                  type="button"
                  className="codelab-float-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExportCellToStudy(cell.id, 'mindmap');
                  }}
                  title="将此格结论、代码与来源追加到当前思维导图"
                >
                  <span>追加导图</span>
                </button>
              </>
            )}

          {index > 0 && (
            <button
              type="button"
              className="codelab-float-btn"
              onClick={(e) => {
                e.stopPropagation();
                onMoveCell(cell.id, 'up');
              }}
              title="上移单元格"
              aria-label="上移单元格"
            >
              <LabArrowUpIcon size={11} />
            </button>
          )}
          {index < totalCells - 1 && (
            <button
              type="button"
              className="codelab-float-btn"
              onClick={(e) => {
                e.stopPropagation();
                onMoveCell(cell.id, 'down');
              }}
              title="下移单元格"
              aria-label="下移单元格"
            >
              <LabArrowDownIcon size={11} />
            </button>
          )}
          {totalCells > 1 && (
            <button
              type="button"
              className="codelab-float-btn is-danger"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteCell(cell.id);
              }}
              title="删除此格 (命令模式 dd)"
              aria-label="删除此格"
            >
              <LabTrashIcon size={11} />
            </button>
          )}
        </div>

        {/* Cell Editor or Seamless Markdown Research Prose */}
        {cell.origin && (
          <div className="codelab-cell-origin" title={cell.origin.reference}>
            <span>
              {cell.origin.kind === 'epub'
                ? 'EPUB'
                : cell.origin.kind === 'pdf'
                  ? 'PDF'
                  : '思维导图'}
            </span>
            <strong>{cell.origin.title}</strong>
            <span>{cell.origin.locator}</span>
          </div>
        )}
        {isMarkdownPreview ? (
          <div
            className="codelab-md-preview"
            onDoubleClick={() => onStartMarkdownEdit(cell.id)}
          >
            {isLegacyStarterNote ? (
              <details
                className="codelab-legacy-help"
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <summary>旧版上手说明 · 展开查看</summary>
                <BookProseView content={cell.source} />
              </details>
            ) : (
              <BookProseView content={cell.source || '*双击编辑研究笔记…*'} />
            )}
          </div>
        ) : !hideSource ? (
          <CodeLabEditor
            cellId={cell.id}
            value={cell.source}
            language={cell.language}
            kind={cell.kind}
            theme={theme}
            hydrated={hydrated}
            shouldFocus={isEditing && isFocused}
            liveSourceMapRef={liveSourceMapRef}
            onRequestHydrate={onRequestHydrate}
            onCommitChange={onCommitSource}
            onFocus={onEditorFocus}
            onBlur={onEditorBlur}
            onRunAndAdvance={(id) => onRunCell(id, true)}
            onRunInPlace={(id) => onRunCell(id, false)}
            onEscapeToCommandMode={onEscapeCommandMode}
          />
        ) : null}

        {/* SQL Inline DataSource & Variable Injection Strip */}
        {!hideSource &&
          !isMarkdown &&
          cell.language === 'sql' &&
          onChangeSqlConfig && (
            <div className="codelab-sql-bar">
              <label className="codelab-sql-field">
                <span>数据源</span>
                <select
                  value={cell.sqlConnectionId ?? ''}
                  onChange={(e) =>
                    onChangeSqlConfig(cell.id, {
                      sqlConnectionId: e.target.value,
                    })
                  }
                >
                  <option value="">本地文件 (DuckDB / 内存 SQLite)</option>
                  {dbConnections.map((conn) => (
                    <option key={conn.id} value={conn.id}>
                      [{conn.dbType.toUpperCase()}] {conn.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="codelab-sql-field is-var">
                <span>共享表/变量</span>
                <input
                  type="text"
                  value={cell.sqlResultVar ?? ''}
                  onChange={(e) =>
                    onChangeSqlConfig(cell.id, {
                      sqlResultVar: e.target.value,
                    })
                  }
                  placeholder="可选，如 df_res"
                  title="执行成功后自动将全量结果写入共享总线并注入 Python / R（sm_load 可读）"
                />
              </label>
            </div>
          )}

        {/* C / C++ Stdin Input Strip */}
        {!hideSource &&
          !isMarkdown &&
          (cell.language === 'c' || cell.language === 'cpp') && (
            <div className="codelab-stdin-row">
              <span className="codelab-stdin-label">STDIN</span>
              <input
                type="text"
                className="codelab-stdin-input"
                value={cell.stdinInput}
                onChange={(e) => onChangeStdin(cell.id, e.target.value)}
                placeholder="可选：传递给 scanf / cin 的标准输入…"
              />
            </div>
          )}

        {/* Structured Output Well */}
        {cell.outputs.length > 0 &&
          (pinnedOutputCellId === cell.id ? (
            <div className="codelab-output-docked-note">
              <span>
                输出已固定到侧栏 · {cell.outputs.length} 项 ·{' '}
                {formatDurationCompact(cell.durationMs)}
              </span>
              <button type="button" onClick={() => onPinOutput(cell.id)}>
                取消固定
              </button>
            </div>
          ) : (
            <CellOutputList
              cellId={cell.id}
              outputs={cell.outputs}
              durationMs={cell.durationMs}
              stage={cell.stage}
              theme={theme}
              onClearOutputs={onClearOutputs}
              onZoomImage={onZoomImage}
              onPinOutput={onPinOutput}
              stale={Boolean(
                cell.lastExecutedSource !== undefined &&
                cell.lastExecutedSource !== cell.source,
              )}
            />
          ))}

        {/* Quiet hover inter-cell insertion affordance */}
        {onInsertCellBelow && (
          <div
            className="codelab-cell-insert-divider"
            aria-label="在此单元格下方插入"
          >
            <button
              type="button"
              className="codelab-cell-insert-btn"
              onClick={(e) => {
                e.stopPropagation();
                onInsertCellBelow(cell.id, 'code');
              }}
              title="在此格下方插入代码格"
            >
              <LabPlusIcon size={10} />
              <span>代码</span>
            </button>
            <button
              type="button"
              className="codelab-cell-insert-btn"
              onClick={(e) => {
                e.stopPropagation();
                onInsertCellBelow(cell.id, 'markdown');
              }}
              title="在此格下方插入笔记格"
            >
              <LabNoteIcon size={10} />
              <span>笔记</span>
            </button>
          </div>
        )}
      </div>
    </article>
  );
});
