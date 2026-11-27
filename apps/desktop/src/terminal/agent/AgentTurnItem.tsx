import { memo, useEffect, useMemo, useState } from 'react';
import type { ActiveWorkspace } from '../../app/app-storage';
import { tokenizePromptEntities } from '../terminal-agent-protocol';
import type { CodeBlockActionCallbacks } from '../TerminalRichContent';
import type { TerminalCodeLabLanguage } from '../terminal-types';
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  RefreshIcon,
  SlashCircleIcon,
  SpinnerIcon,
  XCircleIcon,
} from './AgentIcons';
import { deriveTurnPhase } from './agent-event-adapter';
import type { AgentRunPhase, AgentTurnRecord } from './agent-workbench-types';
import {
  formatDurationCompact,
  formatTurnUsageSummary,
} from './agent-workbench-utils';
import { AssistantMessageBlock } from './blocks/AssistantMessageBlock';
import {
  RegisteredArtifactBlock,
  RegisteredExecutionBlock,
} from './blocks/BlockRendererRegistry';
import { TerminalOutputBlock } from './blocks/TerminalOutputBlock';

export interface AgentTurnItemProps {
  turn: AgentTurnRecord;
  index: number;
  isBusy: boolean;
  traceExpanded: boolean;
  onToggleTrace: (turnId: string, nextExpanded: boolean) => void;
  onRunInCodeLab?: (language: TerminalCodeLabLanguage, code: string) => void;
  onSendToTerminal?: (
    command: string,
    execute?: boolean,
    paneNumber?: number,
  ) => void;
  onSaveTurnNote: (turn: AgentTurnRecord) => Promise<boolean>;
  onRerunPrompt: (prompt: string) => void;
  onResolveTerminalProposal: (
    turnId: string,
    resolution: 'approved' | 'filled' | 'dismissed',
  ) => void;
  onResolveKnowledgeDocumentProposal?: (
    turnId: string,
    action: 'approve' | 'dismiss',
  ) => Promise<void>;
  onNavigateWorkspace?: (workspace: ActiveWorkspace) => void;
  onReconnectCheck?: () => void;
}

const PHASE_META: Record<AgentRunPhase, { label: string; className: string }> =
  {
    idle: { label: '空闲', className: 'is-idle' },
    submitting: { label: '提交中', className: 'is-running' },
    streaming: { label: '流式输出', className: 'is-running' },
    'tool-running': { label: '工具执行中', className: 'is-running' },
    'awaiting-approval': { label: '待确认', className: 'is-paused' },
    completed: { label: '已完成', className: 'is-completed' },
    cancelled: { label: '已取消', className: 'is-cancelled' },
    failed: { label: '异常', className: 'is-failed' },
    disconnected: { label: '连接断开', className: 'is-failed' },
  };

const LiveElapsedTicker = memo(function LiveElapsedTicker({
  startedAt,
}: {
  startedAt: number;
}) {
  const [elapsedMs, setElapsedMs] = useState(() =>
    Math.max(0, Date.now() - startedAt),
  );

  useEffect(() => {
    const tick = () => setElapsedMs(Math.max(0, Date.now() - startedAt));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <span className="ag-live-elapsed">{(elapsedMs / 1000).toFixed(1)}s</span>
  );
});

const PromptHighlightedText = memo(function PromptHighlightedText({
  text,
}: {
  text: string;
}) {
  const segments = useMemo(() => tokenizePromptEntities(text), [text]);
  return (
    <div className="ag-user-prompt-text">
      {segments.map((seg, idx) => {
        if (seg.kind === 'slash') {
          return (
            <span key={idx} className="ag-token-cmd">
              {seg.value}
            </span>
          );
        }
        if (seg.kind === 'mention') {
          return (
            <span key={idx} className="ag-token-ref">
              {seg.value}
            </span>
          );
        }
        return <span key={idx}>{seg.value}</span>;
      })}
    </div>
  );
});

export const AgentTurnItem = memo(function AgentTurnItem({
  turn,
  index,
  isBusy,
  traceExpanded,
  onToggleTrace,
  onRunInCodeLab,
  onSendToTerminal,
  onSaveTurnNote,
  onRerunPrompt,
  onResolveTerminalProposal,
  onResolveKnowledgeDocumentProposal,
  onNavigateWorkspace,
  onReconnectCheck,
}: AgentTurnItemProps) {
  const [copiedReply, setCopiedReply] = useState(false);
  const [copiedError, setCopiedError] = useState(false);
  const [copiedAllLogs, setCopiedAllLogs] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(true);
  const [docPreviewOpen, setDocPreviewOpen] = useState(false);
  const [docApplying, setDocApplying] = useState(false);

  const phase = deriveTurnPhase(turn);
  const phaseMeta = PHASE_META[phase];
  const isRunning = turn.status === 'running';
  const durationLabel = formatDurationCompact(
    turn.durationMs ??
      (turn.finishedAt ? turn.finishedAt - turn.startedAt : undefined),
  );
  const usageLabel = formatTurnUsageSummary(turn.usage);
  const toolBlocksCount = turn.blocks.filter(
    (b) => b.kind === 'tool' || b.kind === 'cli-tool',
  ).length;
  const failedStepsCount = turn.blocks.filter(
    (b) => b.status === 'failed',
  ).length;

  const codeActions = useMemo<CodeBlockActionCallbacks>(
    () => ({
      onRunInCodeLab: onRunInCodeLab
        ? (lang, code) => {
            const mapped: TerminalCodeLabLanguage =
              lang === 'c'
                ? 'c'
                : lang === 'cpp' || lang === 'c++' || lang === 'cxx'
                  ? 'cpp'
                  : lang === 'sql'
                    ? 'sql'
                    : lang === 'r'
                      ? 'r'
                      : 'python';
            onRunInCodeLab(mapped, code);
          }
        : undefined,
      onSendToTerminal: onSendToTerminal
        ? (cmd, execute) => onSendToTerminal(cmd, execute)
        : undefined,
    }),
    [onRunInCodeLab, onSendToTerminal],
  );

  const handleCopyTraceLogs = () => {
    const text = turn.blocks
      .map(
        (b) =>
          `[${b.kind.toUpperCase()}][${b.status}] ${b.label}${b.durationMs !== undefined ? ` (${b.durationMs}ms)` : ''}${b.inputArgs ? `\nArgs: ${JSON.stringify(b.inputArgs)}` : ''}${b.errorDetail ? `\nError: ${b.errorDetail}` : b.outputPreview ? `\nOutput: ${b.outputPreview}` : b.detail ? `\n${b.detail}` : b.summary ? ` — ${b.summary}` : ''}`,
      )
      .join('\n\n');
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedAllLogs(true);
      window.setTimeout(() => setCopiedAllLogs(false), 1400);
    });
  };

  return (
    <article
      id={`agent-turn-${turn.id}`}
      className={`ag-turn is-status-${turn.status}`}
      aria-label={`对话轮次 ${index + 1}`}
    >
      {/* Block 1: User Prompt Block */}
      <div className="ag-turn-user-block">
        <div className="ag-turn-meta-bar">
          <div className="ag-turn-meta-left">
            <span className="ag-turn-idx">#{index + 1}</span>
            <span className={`ag-status-badge ${phaseMeta.className}`}>
              {phaseMeta.label}
            </span>
            <span className="ag-turn-engine">{turn.engineLabel}</span>
            {turn.usedMcp && <span className="ag-turn-tag">MCP</span>}
          </div>
          <div className="ag-turn-meta-right">
            {isRunning ? (
              <LiveElapsedTicker startedAt={turn.startedAt} />
            ) : (
              durationLabel && (
                <span className="ag-turn-duration">{durationLabel}</span>
              )
            )}
            {usageLabel && (
              <span className="ag-turn-usage" title="模型接口实际上报用量">
                {usageLabel}
              </span>
            )}
          </div>
        </div>

        <header className="ag-user-prompt-row">
          <span className="ag-user-glyph" aria-hidden="true">
            &gt;
          </span>
          <PromptHighlightedText text={turn.userText} />
        </header>

        {turn.attachedContexts.length > 0 && (
          <div className="ag-turn-context-row" aria-label="本轮已挂载上下文">
            <span className="ag-turn-context-label">上下文</span>
            {turn.attachedContexts.map((ctx) => (
              <span key={ctx} className="ag-turn-context-pill">
                {ctx}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Block 2: Execution & Tool Calls Drawer via BlockRendererRegistry */}
      {turn.blocks.length > 0 && (
        <section className="ag-exec-block" aria-label="执行与工具调用轨迹">
          <div className="ag-exec-head">
            <button
              type="button"
              className="ag-exec-toggle"
              onClick={() => onToggleTrace(turn.id, !traceExpanded)}
              aria-expanded={traceExpanded}
            >
              {traceExpanded ? (
                <ChevronDownIcon size={13} />
              ) : (
                <ChevronRightIcon size={13} />
              )}
              <span className="ag-exec-title">
                {isRunning
                  ? `执行过程（${turn.blocks.length} 步`
                  : `执行轨迹（${turn.blocks.length} 步`}
                {toolBlocksCount > 0 ? ` · ${toolBlocksCount} 次工具` : ''}
                {failedStepsCount > 0 ? ` · ${failedStepsCount} 异常` : ''}）
              </span>
            </button>
            <button
              type="button"
              className="ag-step-btn"
              onClick={handleCopyTraceLogs}
              title="复制全部执行轨迹日志"
            >
              {copiedAllLogs ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
              <span>{copiedAllLogs ? '已复制' : '复制轨迹'}</span>
            </button>
          </div>

          {traceExpanded && (
            <div className="ag-exec-list">
              {turn.blocks.map((block) => (
                <RegisteredExecutionBlock key={block.id} block={block} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Block 3: Structured Tool Artifacts (Tables / File Refs / Kernel Outputs) */}
      {turn.artifacts && turn.artifacts.length > 0 && (
        <div className="ag-artifacts-stack" aria-label="执行产出">
          {turn.artifacts.map((art, artIdx) => (
            <RegisteredArtifactBlock
              key={`${turn.id}-art-${artIdx}`}
              artifact={art}
            />
          ))}
        </div>
      )}

      {/* Block 4: Submitting / Tool Running Indicator before first text chunk */}
      {isRunning && !turn.reply && (
        <div className="ag-running-block" role="status" aria-live="polite">
          <SpinnerIcon size={14} className="ag-icon-spin" />
          <span>
            {phase === 'tool-running'
              ? '正在执行工具调用…'
              : '正在请求模型与调度工作区…'}{' '}
            <LiveElapsedTicker startedAt={turn.startedAt} />
          </span>
        </div>
      )}

      {/* Block 5: Incremental Memoized Assistant Response */}
      {turn.reply && (
        <AssistantMessageBlock
          content={turn.reply}
          isStreaming={isRunning}
          actions={codeActions}
        />
      )}

      {/* Block 6: CLI Stderr Read-Only Log */}
      {turn.stderr && turn.stderr.trim().length > 0 && (
        <TerminalOutputBlock
          title="CLI 终端 stderr 输出"
          stderr={turn.stderr}
          exitCode={turn.exitCode}
          isError={turn.status === 'failed'}
          defaultExpanded={turn.status === 'failed'}
        />
      )}

      {/* Block 7: Disconnected State (Safe recovery without auto-replay) */}
      {phase === 'disconnected' && (
        <div className="ag-state-card is-failed" role="alert">
          <div className="ag-state-card-head">
            <span className="ag-state-title-group">
              <AlertTriangleIcon size={14} />
              <strong>连接断开</strong>
            </span>
            <div className="ag-state-card-actions">
              {onReconnectCheck && (
                <button
                  type="button"
                  className="ag-inline-btn"
                  onClick={onReconnectCheck}
                >
                  <RefreshIcon size={12} />
                  <span>检测通道</span>
                </button>
              )}
              <button
                type="button"
                className="ag-inline-btn is-danger"
                disabled={isBusy}
                onClick={() => onRerunPrompt(turn.userText)}
                title="仅在确认不会重复产生副作用时手动重试"
              >
                手动重试
              </button>
            </div>
          </div>
          <p className="ag-state-card-body">
            与模型端点或本地桥接的连接中断。为避免重复执行含副作用的命令，系统未自动重放请求。
          </p>
          {turn.error && (
            <pre className="ag-error-pre">
              <code>{turn.error}</code>
            </pre>
          )}
        </div>
      )}

      {/* Block 8: Explicit Cancelled State (Preserves partial output) */}
      {phase === 'cancelled' && (
        <div className="ag-state-card is-cancelled" role="status">
          <div className="ag-state-card-head">
            <span className="ag-state-title-group">
              <SlashCircleIcon size={14} />
              <strong>执行已取消</strong>
            </span>
            <button
              type="button"
              className="ag-inline-btn"
              disabled={isBusy}
              onClick={() => onRerunPrompt(turn.userText)}
            >
              重新执行
            </button>
          </div>
          <p className="ag-state-card-body">
            {turn.reply
              ? '本轮任务已中断，上方已保留中断前接收的部分输出，但未标记为完成。'
              : '本轮任务已由用户中断，未提交为完成结果。'}
          </p>
        </div>
      )}

      {/* Block 9: Explicit Failed State */}
      {phase === 'failed' && turn.error && (
        <div className="ag-state-card is-failed" role="alert">
          <div className="ag-state-card-head">
            <span className="ag-state-title-group">
              <XCircleIcon size={14} />
              <strong>执行异常</strong>
            </span>
            <div className="ag-state-card-actions">
              <button
                type="button"
                className="ag-inline-btn"
                onClick={() => setErrorExpanded((v) => !v)}
                aria-expanded={errorExpanded}
              >
                {errorExpanded ? '收起详情' : '展开详情'}
              </button>
              <button
                type="button"
                className="ag-inline-btn"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(turn.error ?? '')
                    .then(() => {
                      setCopiedError(true);
                      window.setTimeout(() => setCopiedError(false), 1400);
                    });
                }}
              >
                {copiedError ? '已复制' : '复制报错'}
              </button>
              <button
                type="button"
                className="ag-inline-btn is-danger"
                disabled={isBusy}
                onClick={() => onRerunPrompt(turn.userText)}
              >
                重试
              </button>
            </div>
          </div>
          {errorExpanded && (
            <pre className="ag-error-pre">
              <code>{turn.error}</code>
            </pre>
          )}
        </div>
      )}

      {/* Block 10: Permission / Command Approval Card */}
      {turn.terminalProposal && !turn.terminalProposal.resolved && (
        <div
          className="ag-approval-card"
          role="region"
          aria-label="待确认命令提案"
        >
          <div className="ag-approval-head">
            <span className="ag-status-badge is-paused">需要确认</span>
            <strong>
              向终端窗格 #{turn.terminalProposal.paneIndex} 发送命令
            </strong>
          </div>
          <p className="ag-approval-reason">{turn.terminalProposal.reason}</p>
          <pre className="ag-approval-cmd">
            <code>{turn.terminalProposal.command}</code>
          </pre>
          <div className="ag-approval-actions">
            <button
              type="button"
              className="ag-btn-primary"
              onClick={() => {
                const prop = turn.terminalProposal;
                if (!prop) return;
                onSendToTerminal?.(prop.command, true, prop.paneIndex);
                onResolveTerminalProposal(turn.id, 'approved');
              }}
            >
              <CheckIcon size={13} />
              <span>确认并执行</span>
            </button>
            <button
              type="button"
              className="ag-btn-secondary"
              onClick={() => {
                const prop = turn.terminalProposal;
                if (!prop) return;
                onSendToTerminal?.(prop.command, false, prop.paneIndex);
                onResolveTerminalProposal(turn.id, 'filled');
              }}
            >
              仅填入终端
            </button>
            <button
              type="button"
              className="ag-btn-ghost"
              onClick={() => onResolveTerminalProposal(turn.id, 'dismissed')}
            >
              放弃
            </button>
          </div>
        </div>
      )}

      {turn.terminalProposal?.resolved && (
        <div className="ag-approval-resolved">
          {turn.terminalProposal.resolved === 'approved'
            ? `已确认并发送到窗格 #${turn.terminalProposal.paneIndex} 执行`
            : turn.terminalProposal.resolved === 'filled'
              ? `已仅填入窗格 #${turn.terminalProposal.paneIndex}（未自动回车）`
              : '已放弃该命令提案'}
        </div>
      )}

      {/* Block 10b: Inline Knowledge Document Edit Approval Card */}
      {turn.knowledgeDocumentProposal &&
        !turn.knowledgeDocumentProposal.resolved && (
          <div
            className="ag-approval-card"
            role="region"
            aria-label="待确认知识库文档修改提案"
          >
            <div className="ag-approval-head">
              <span className="ag-status-badge is-paused">
                {turn.knowledgeDocumentProposal.mode === 'create_copy'
                  ? '新建副本 · 保留原文'
                  : turn.knowledgeDocumentProposal.mode === 'append'
                    ? '文末追加'
                    : '替换当前文档'}
              </span>
              <strong>
                {turn.knowledgeDocumentProposal.mode === 'create_copy'
                  ? `新建知识库文档：《${turn.knowledgeDocumentProposal.newTitle || `${turn.knowledgeDocumentProposal.targetTitle}（副本）`}》`
                  : `更新知识库文档：《${turn.knowledgeDocumentProposal.targetTitle}》`}
              </strong>
            </div>
            <p className="ag-approval-reason">
              {turn.knowledgeDocumentProposal.rationale}
            </p>
            <div className="ag-approval-doc-meta">
              <span>
                目标分类：{turn.knowledgeDocumentProposal.targetCategory}
              </span>
              {turn.knowledgeDocumentProposal.targetRelativePath && (
                <span>
                  源路径：{turn.knowledgeDocumentProposal.targetRelativePath}
                </span>
              )}
              <span>
                写入规模：
                {turn.knowledgeDocumentProposal.content.length.toLocaleString()}{' '}
                字 ·{' '}
                {turn.knowledgeDocumentProposal.content.split(/\r?\n/).length}{' '}
                行
              </span>
            </div>
            {docPreviewOpen && (
              <pre className="ag-approval-doc-preview">
                <code>
                  {turn.knowledgeDocumentProposal.content.slice(0, 4000)}
                  {turn.knowledgeDocumentProposal.content.length > 4000
                    ? `\n\n…（预览仅展示前 4,000 字，全文共 ${turn.knowledgeDocumentProposal.content.length.toLocaleString()} 字）`
                    : ''}
                </code>
              </pre>
            )}
            {turn.knowledgeDocumentProposal.resultMessage && (
              <p className="ag-approval-doc-error">
                {turn.knowledgeDocumentProposal.resultMessage}
              </p>
            )}
            <div className="ag-approval-actions">
              <button
                type="button"
                className="ag-btn-primary"
                disabled={docApplying}
                onClick={() => {
                  if (!onResolveKnowledgeDocumentProposal) return;
                  setDocApplying(true);
                  void onResolveKnowledgeDocumentProposal(
                    turn.id,
                    'approve',
                  ).finally(() => setDocApplying(false));
                }}
              >
                <CheckIcon size={13} />
                <span>{docApplying ? '正在写入…' : '确认写入知识库'}</span>
              </button>
              <button
                type="button"
                className="ag-btn-secondary"
                onClick={() => setDocPreviewOpen((v) => !v)}
                aria-expanded={docPreviewOpen}
              >
                {docPreviewOpen ? '收起内容预览' : '预览写入内容'}
              </button>
              <button
                type="button"
                className="ag-btn-ghost"
                disabled={docApplying}
                onClick={() => {
                  void onResolveKnowledgeDocumentProposal?.(turn.id, 'dismiss');
                }}
              >
                放弃
              </button>
            </div>
          </div>
        )}

      {turn.knowledgeDocumentProposal?.resolved && (
        <div className="ag-approval-resolved">
          {turn.knowledgeDocumentProposal.resultMessage ||
            (turn.knowledgeDocumentProposal.resolved === 'approved'
              ? `已写入知识库文档《${turn.knowledgeDocumentProposal.newTitle || turn.knowledgeDocumentProposal.targetTitle}》`
              : '已放弃该知识库文档写入提案')}
        </div>
      )}

      {/* Block 11: Cross-Workspace Proposal Card */}
      {turn.workspaceProposal && (
        <div className="ag-approval-card is-cross-workspace">
          <div className="ag-approval-head">
            <span className="ag-status-badge is-paused">待工作区确认</span>
            <strong>{turn.workspaceProposal.title}</strong>
          </div>
          <p className="ag-approval-reason">
            {turn.workspaceProposal.description}
          </p>
          {turn.workspaceProposal.targetWorkspace && onNavigateWorkspace && (
            <div className="ag-approval-actions">
              <button
                type="button"
                className="ag-btn-secondary"
                onClick={() =>
                  onNavigateWorkspace(turn.workspaceProposal!.targetWorkspace!)
                }
              >
                前往 {turn.workspaceProposal.targetLabel ?? '目标工作区'} 审阅 →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Block 12: Turn Action Footer */}
      {!isRunning && turn.reply && (
        <footer className="ag-turn-footer">
          <span className="ag-turn-footer-meta">
            {turn.reply.length.toLocaleString()} 字
            {durationLabel ? ` · ${durationLabel}` : ''}
            {usageLabel ? ` · ${usageLabel}` : ''}
          </span>
          <div className="ag-turn-footer-actions">
            <button
              type="button"
              className="ag-foot-btn"
              onClick={() => {
                void navigator.clipboard?.writeText(turn.reply).then(() => {
                  setCopiedReply(true);
                  window.setTimeout(() => setCopiedReply(false), 1400);
                });
              }}
            >
              {copiedReply ? '已复制' : '复制全文'}
            </button>
            <button
              type="button"
              className="ag-foot-btn"
              onClick={() => {
                void onSaveTurnNote(turn).then((ok) => {
                  if (ok) {
                    setSavedNote(true);
                    window.setTimeout(() => setSavedNote(false), 1800);
                  }
                });
              }}
            >
              {savedNote ? '已存知识库' : '存知识库'}
            </button>
            <button
              type="button"
              className="ag-foot-btn"
              disabled={isBusy}
              onClick={() => onRerunPrompt(turn.userText)}
            >
              重跑
            </button>
          </div>
        </footer>
      )}
    </article>
  );
});
