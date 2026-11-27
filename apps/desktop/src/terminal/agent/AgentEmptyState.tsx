import { memo } from 'react';
import { METALLIC_BOOK_PIXEL_GRID } from '../terminal-agent-protocol';
import { normalizeDisplayPath } from '../terminal-alacritty';
import { AlertTriangleIcon, SparkCpuIcon } from './AgentIcons';

export interface AgentEmptyStateProps {
  activeEngineTitle: string;
  engineModeLabel: string;
  cwd: string;
  compact?: boolean;
  mcpToolCount: number | null;
  mcpReady: boolean;
  detectedPaneError: boolean;
  onInsertPrompt: (text: string) => void;
  onRunCommand: (command: string) => void;
  onOpenModelModal: () => void;
  onOpenCommandPalette?: () => void;
}

function resolveSmallEmblemColor(code: string): string | null {
  switch (code) {
    case 'C':
      return '#F1F5F9';
    case 'T':
      return '#CBD5E1';
    case 'S':
      return '#94A3B8';
    case 'I':
      return '#64748B';
    case 'G':
      return '#334155';
    case 'B':
      return '#D97757';
    case 'A':
      return '#F59E0B';
    default:
      return null;
  }
}

const CompactBrandMark = memo(function CompactBrandMark() {
  const cell = 2;
  const rows = METALLIC_BOOK_PIXEL_GRID.length;
  const cols = METALLIC_BOOK_PIXEL_GRID[0]?.length ?? 22;
  return (
    <svg
      viewBox={`0 0 ${cols * cell} ${rows * cell}`}
      width={30}
      height={21}
      shapeRendering="crispEdges"
      className="ag-brand-mark"
      aria-hidden="true"
    >
      {METALLIC_BOOK_PIXEL_GRID.map((rowStr, rIdx) =>
        Array.from(rowStr).map((ch, cIdx) => {
          const fill = resolveSmallEmblemColor(ch);
          if (!fill) return null;
          return (
            <rect
              key={`${rIdx}-${cIdx}`}
              x={cIdx * cell}
              y={rIdx * cell}
              width={cell}
              height={cell}
              fill={fill}
            />
          );
        }),
      )}
    </svg>
  );
});

const STARTER_PROMPTS: ReadonlyArray<{
  id: string;
  command: string;
  label: string;
  template: string;
}> = [
  {
    id: 'book',
    command: '/book',
    label: '伴读当前章节推导',
    template: '/book #chapter 提炼核心概念与关键推导步骤',
  },
  {
    id: 'data',
    command: '/data',
    label: '分析已挂载数据与实验本',
    template: '/data #data #lab 概览当前数据字段并给出分析方案',
  },
  {
    id: 'code',
    command: '/code',
    label: '编写并验证实验代码',
    template: '/code python ',
  },
  {
    id: 'exec',
    command: '/exec',
    label: '诊断终端报错',
    template: '/exec #last-error 分析报错原因并给出修复命令',
  },
];

export const AgentEmptyState = memo(function AgentEmptyState({
  activeEngineTitle,
  engineModeLabel,
  cwd,
  compact = false,
  mcpToolCount,
  mcpReady,
  detectedPaneError,
  onInsertPrompt,
  onRunCommand,
  onOpenModelModal,
  onOpenCommandPalette,
}: AgentEmptyStateProps) {
  const displayPath = normalizeDisplayPath(cwd || '.');

  return (
    <section className="ag-empty" aria-label="空白会话引导">
      <div className="ag-empty-head">
        <div className="ag-empty-brand">
          <CompactBrandMark />
          <div className="ag-empty-titles">
            <h2 className="ag-empty-title">SEAMIND Research Workbench</h2>
            <p className="ag-empty-subtitle">
              输入研究问题、`/` 调度命令或 `#`
              挂载书籍、实验本、知识库与终端上下文。
            </p>
          </div>
        </div>

        {!compact && (
          <div className="ag-empty-meta" aria-label="当前工作区状态">
            <button
              type="button"
              className="ag-empty-meta-pill is-interactive"
              onClick={onOpenModelModal}
              title="切换模型与协同内核 (Ctrl+M)"
            >
              <SparkCpuIcon size={13} />
              <span>{activeEngineTitle}</span>
              <span className="ag-empty-meta-dim">{engineModeLabel}</span>
            </button>
            <button
              type="button"
              className="ag-empty-meta-pill is-interactive"
              onClick={() => onRunCommand('/mcp')}
              title="查看当前 MCP 工具通道状态"
            >
              <span
                className={`ag-status-dot${mcpReady ? ' is-ready' : ' is-muted'}`}
                aria-hidden="true"
              />
              <span>
                MCP{' '}
                {mcpToolCount !== null
                  ? `${mcpToolCount} tools`
                  : mcpReady
                    ? '已就绪'
                    : '未提供'}
              </span>
            </button>
            <span className="ag-empty-meta-path" title={cwd || '.'}>
              {displayPath}
            </span>
          </div>
        )}
      </div>

      {detectedPaneError && (
        <div className="ag-empty-alert">
          <span className="ag-empty-alert-text">
            <AlertTriangleIcon size={14} />
            <span>检测到相邻终端或实验本存在报错输出</span>
          </span>
          <button
            type="button"
            className="ag-inline-btn is-warning"
            onClick={() =>
              onInsertPrompt('/exec #last-error 诊断报错并给出修复方案')
            }
          >
            附带 #last-error 诊断
          </button>
        </div>
      )}

      <div className="ag-starter-row" role="group" aria-label="快捷起点">
        {STARTER_PROMPTS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="ag-starter-chip"
            onClick={() => onInsertPrompt(item.template)}
          >
            <span className="ag-starter-cmd">{item.command}</span>
            <span className="ag-starter-label">{item.label}</span>
          </button>
        ))}
      </div>

      {!compact && (
        <div className="ag-empty-hints">
          <button
            type="button"
            className="ag-quiet-link"
            onClick={() => onRunCommand('/help')}
          >
            <code>/help</code> 协议速查
          </button>
          <span className="ag-empty-sep" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            className="ag-quiet-link"
            onClick={onOpenModelModal}
          >
            <kbd>Ctrl+M</kbd> 切换内核
          </button>
          {onOpenCommandPalette && (
            <>
              <span className="ag-empty-sep" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                className="ag-quiet-link"
                onClick={onOpenCommandPalette}
              >
                <kbd>Ctrl+K</kbd> 命令面板
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
});
