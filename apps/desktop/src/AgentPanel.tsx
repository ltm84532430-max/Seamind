import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentAnalysisMode } from './agent/types';
import type { AgentCapabilities } from './agent/capabilities';
import { estimateTokenCount, runAgentTurn } from './agent/runtime';
import type {
  AgentCallEvent,
  AgentChatMessage,
  AgentTurnDetails,
  AgentTurnUsage,
  ModelContextWindow,
  NodeEditProposal,
} from './agent/types';
import {
  formatContextWindow,
  resolveModelContextWindow,
} from './agent/model-context';

interface AgentTarget {
  nodeId: string | null;
  nodePath: string;
  label: string;
}

interface AgentPanelProps {
  mode: AgentAnalysisMode;
  provider: { baseUrl: string; model: string };
  providerLabel: string;
  capabilities: AgentCapabilities;
  target: AgentTarget | null;
  mapTitle: string;
  mapMarkdown: string;
  currentRevision: number;
  onApplyProposal(proposal: NodeEditProposal): Promise<number | null>;
  onUndoProposal(
    proposal: NodeEditProposal,
    appliedRevision: number,
  ): Promise<boolean>;
}

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  turnDetails?: AgentTurnDetails;
}

interface ActiveAgentTurn {
  providerLabel: string;
  model: string;
  contextWindow: ModelContextWindow | null;
  mode: AgentAnalysisMode;
  targetLabel: string;
  startedAt: number;
  events: AgentCallEvent[];
}

interface AgentConversation {
  messages: DisplayMessage[];
  history: AgentChatMessage[];
  activeTurn: ActiveAgentTurn | null;
  proposal: NodeEditProposal | null;
  lastApplied: { proposal: NodeEditProposal; revision: number } | null;
  error: string;
  lastUsage: AgentTurnUsage | null;
}

const emptyConversation = (): AgentConversation => ({
  messages: [],
  history: [],
  activeTurn: null,
  proposal: null,
  lastApplied: null,
  error: '',
  lastUsage: null,
});

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function markdownChange(before: string, after: string) {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] ===
      newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return {
    removed: oldLines.slice(prefix, oldLines.length - suffix).slice(0, 20),
    added: newLines.slice(prefix, newLines.length - suffix).slice(0, 40),
  };
}

function reportedValue(
  value: number,
  reportedRequests: number,
  requestCount: number,
): string {
  if (!reportedRequests) return '未返回';
  const partial =
    reportedRequests < requestCount
      ? `（${reportedRequests}/${requestCount} 次）`
      : '';
  return `${value.toLocaleString()}${partial}`;
}

function usageFromEvents(events: AgentCallEvent[]): AgentTurnUsage {
  const requests = events.filter(
    (event): event is Extract<AgentCallEvent, { kind: 'model' }> =>
      event.kind === 'model',
  );
  const usage: AgentTurnUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reportedRequests: 0,
    requestCount: requests.length,
    promptReportedRequests: 0,
    completionReportedRequests: 0,
    totalReportedRequests: 0,
    contextTokensEstimate:
      requests[requests.length - 1]?.contextTokensEstimate ?? 0,
  };
  for (const request of requests) {
    const reported = request.usage;
    if (!reported) continue;
    const values = [
      reported.promptTokens,
      reported.completionTokens,
      reported.totalTokens,
    ];
    if (
      values.some(
        (value) => Number.isSafeInteger(value) && (value as number) >= 0,
      )
    )
      usage.reportedRequests += 1;
    if (
      Number.isSafeInteger(reported.promptTokens) &&
      (reported.promptTokens as number) >= 0
    ) {
      usage.promptTokens += reported.promptTokens as number;
      usage.promptReportedRequests += 1;
    }
    if (
      Number.isSafeInteger(reported.completionTokens) &&
      (reported.completionTokens as number) >= 0
    ) {
      usage.completionTokens += reported.completionTokens as number;
      usage.completionReportedRequests += 1;
    }
    if (
      Number.isSafeInteger(reported.totalTokens) &&
      (reported.totalTokens as number) >= 0
    ) {
      usage.totalTokens += reported.totalTokens as number;
      usage.totalReportedRequests += 1;
    }
  }
  return usage;
}

function completeTurn(
  activeTurn: ActiveAgentTurn,
  usage: AgentTurnUsage,
  status: Exclude<AgentTurnDetails['status'], 'running'>,
): AgentTurnDetails {
  const endedAt = Date.now();
  return {
    providerLabel: activeTurn.providerLabel,
    model: activeTurn.model,
    mode: activeTurn.mode,
    targetLabel: activeTurn.targetLabel,
    status,
    startedAt: activeTurn.startedAt,
    endedAt,
    durationMs: endedAt - activeTurn.startedAt,
    contextWindow: activeTurn.contextWindow,
    usage,
    events: activeTurn.events,
  };
}

function durationLabel(durationMs?: number): string {
  if (durationMs === undefined) return '计时中';
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} 秒`;
}

function eventStatusLabel(status: AgentCallEvent['status']): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'done':
      return '完成';
    case 'approval':
      return '等待确认';
    case 'failed':
      return '失败';
  }
}

function turnStatusLabel(status: AgentTurnDetails['status']): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'completed':
      return '已完成';
    case 'proposal':
      return '待确认';
    case 'failed':
      return '未完成';
  }
}

function requestContextUsage(
  event: Extract<AgentCallEvent, { kind: 'model' }>,
): { tokens: number; label: string } {
  const usage = event.usage;
  if (
    Number.isSafeInteger(usage?.totalTokens) &&
    (usage?.totalTokens ?? -1) >= 0
  ) {
    return { tokens: usage!.totalTokens!, label: '服务统计合计' };
  }
  if (
    Number.isSafeInteger(usage?.promptTokens) &&
    (usage?.promptTokens ?? -1) >= 0 &&
    Number.isSafeInteger(usage?.completionTokens) &&
    (usage?.completionTokens ?? -1) >= 0
  ) {
    return {
      tokens: usage!.promptTokens! + usage!.completionTokens!,
      label: '服务统计输入 + 输出',
    };
  }
  if (
    Number.isSafeInteger(usage?.promptTokens) &&
    (usage?.promptTokens ?? -1) >= 0
  ) {
    return {
      tokens: usage!.promptTokens!,
      label: '服务统计，仅输入',
    };
  }
  return {
    tokens: event.contextTokensEstimate,
    label: '本地估算，请求体输入',
  };
}

function AgentCallDetails({ details }: { details: AgentTurnDetails }) {
  const modeLabel = details.mode === 'drilldown' ? '节点下探' : '可视化分析';
  const modelRequests = details.events.filter(
    (event): event is Extract<AgentCallEvent, { kind: 'model' }> =>
      event.kind === 'model',
  );
  const contextUsage = modelRequests
    .map(requestContextUsage)
    .reduce(
      (largest, current) =>
        current.tokens > largest.tokens ? current : largest,
      {
        tokens: details.usage.contextTokensEstimate,
        label: details.usage.contextTokensEstimate
          ? '本地估算，请求体输入'
          : '上下文估算不可用',
      },
    );
  const contextWindow = details.contextWindow;
  const contextPercent =
    contextWindow && contextUsage.tokens > 0
      ? (contextUsage.tokens / contextWindow.tokens) * 100
      : null;
  const contextSourceTitle = contextWindow
    ? contextWindow.sourceLabel +
      '；核对日期 ' +
      contextWindow.verifiedOn +
      '；' +
      contextWindow.sourceUrl
    : '未核实该模型的官方上下文容量';
  const reportedBreakdown =
    details.usage.promptReportedRequests > 0 ||
    details.usage.completionReportedRequests > 0;
  const breakdownTotal =
    details.usage.promptTokens + details.usage.completionTokens;
  const promptShare =
    breakdownTotal > 0
      ? (details.usage.promptTokens / breakdownTotal) * 100
      : 0;
  const summaryTokenCount =
    details.usage.totalReportedRequests > 0
      ? details.usage.totalTokens
      : breakdownTotal;
  const hasSummaryTokenCount =
    details.usage.totalReportedRequests > 0 || reportedBreakdown;
  const summaryUsageIsPartial =
    details.usage.totalReportedRequests > 0
      ? details.usage.totalReportedRequests < details.usage.requestCount
      : details.usage.promptReportedRequests < details.usage.requestCount ||
        details.usage.completionReportedRequests < details.usage.requestCount;
  return (
    <details
      className={`agent-call-details is-${details.status}`}
      open={details.status === 'running' || details.status === 'failed'}
    >
      <summary className="agent-call-summary">
        <span
          className={'agent-call-icon is-' + details.status}
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16">
            <path d="M9.5 1.5 3 9h4l-.5 5.5L13 7h-4l.5-5.5Z" />
          </svg>
        </span>
        <span className="agent-call-summary-content">
          <span className="agent-call-summary-top">
            <strong>API 调用</strong>
            <span>
              {details.providerLabel} · {details.model}
            </span>
            <span className="agent-call-status">
              {turnStatusLabel(details.status)}
            </span>
          </span>
          <span className="agent-call-summary-bottom">
            {reportedBreakdown && breakdownTotal > 0 ? (
              <span
                className="agent-call-mini-meter"
                role="img"
                aria-label={
                  '输入 ' +
                  details.usage.promptTokens.toLocaleString() +
                  ' tokens，输出 ' +
                  details.usage.completionTokens.toLocaleString() +
                  ' tokens'
                }
                title={
                  '输入 ' +
                  details.usage.promptTokens.toLocaleString() +
                  ' · 输出 ' +
                  details.usage.completionTokens.toLocaleString()
                }
              >
                <span
                  className="is-input"
                  style={{ width: String(promptShare) + '%' }}
                />
                <span
                  className="is-output"
                  style={{ width: String(100 - promptShare) + '%' }}
                />
              </span>
            ) : (
              <span
                className="agent-call-mini-meter is-unavailable"
                aria-hidden="true"
              />
            )}
            <strong>
              {hasSummaryTokenCount
                ? summaryTokenCount.toLocaleString() +
                  ' tokens' +
                  (summaryUsageIsPartial ? ' · 部分返回' : '')
                : '服务未返回用量'}
            </strong>
            <span>
              {details.usage.requestCount} 次请求 ·{' '}
              {durationLabel(details.durationMs)}
            </span>
          </span>
        </span>
        <span className="agent-call-summary-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="agent-call-body">
        <div className="agent-call-meta">
          <span>模式：{modeLabel}</span>
          <span>目标：{details.targetLabel}</span>
          <span>模型：{details.model || '未设置'}</span>
        </div>
        <div className="agent-call-metrics">
          <div>
            <span>输入 tokens</span>
            <strong>
              {reportedValue(
                details.usage.promptTokens,
                details.usage.promptReportedRequests,
                details.usage.requestCount,
              )}
            </strong>
          </div>
          <div>
            <span>输出 tokens</span>
            <strong>
              {reportedValue(
                details.usage.completionTokens,
                details.usage.completionReportedRequests,
                details.usage.requestCount,
              )}
            </strong>
          </div>
          <div>
            <span>合计 tokens</span>
            <strong>
              {reportedValue(
                details.usage.totalTokens,
                details.usage.totalReportedRequests,
                details.usage.requestCount,
              )}
            </strong>
          </div>
        </div>
        <div className="agent-context-meter" title={contextSourceTitle}>
          <div className="agent-context-meter-header">
            <span>
              单次请求最高 · {contextUsage.label} ·{' '}
              {contextUsage.tokens.toLocaleString()} tokens
            </span>
            {contextWindow ? (
              <strong>
                {contextPercent !== null
                  ? contextPercent.toFixed(1) + '%'
                  : '比例不可用'}
                {' / '}
                {formatContextWindow(contextWindow.tokens)} tokens
              </strong>
            ) : (
              <strong>模型容量上限未知</strong>
            )}
          </div>
          {contextWindow && contextPercent !== null && (
            <div
              className="agent-context-meter-track"
              role="progressbar"
              aria-label="模型上下文窗口使用比例"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Math.max(0, contextPercent))}
              aria-valuetext={
                contextPercent.toFixed(1) + '%（' + contextUsage.label + '）'
              }
            >
              <span
                className="agent-context-meter-fill"
                style={{
                  width:
                    String(Math.min(100, Math.max(0, contextPercent))) + '%',
                }}
              />
            </div>
          )}
          <small>
            {contextWindow
              ? '容量依据：' +
                contextWindow.sourceLabel +
                '，' +
                contextWindow.verifiedOn +
                ' 核对'
              : '未知模型容量时不显示占比；自定义兼容端点不会套用其他厂商上限。'}
          </small>
        </div>
        <ol className="agent-call-events">
          {details.events.map((event) =>
            event.kind === 'model' ? (
              <li className={`is-${event.status}`} key={event.id}>
                <span className="agent-call-event-marker" />
                <div className="agent-call-event-main">
                  <strong>
                    第 {event.round} 次模型请求 ·{' '}
                    {details.model || '模型未设置'}
                  </strong>
                  <span>
                    {eventStatusLabel(event.status)} ·{' '}
                    {durationLabel(event.durationMs)}
                  </span>
                  <small>
                    上下文约 {event.contextTokensEstimate.toLocaleString()}{' '}
                    tokens（本地估算）
                    {' · '}
                    {event.usage
                      ? `输入 ${event.usage.promptTokens?.toLocaleString() ?? '未返回'} · 输出 ${event.usage.completionTokens?.toLocaleString() ?? '未返回'} · 合计 ${event.usage.totalTokens?.toLocaleString() ?? '未返回'}`
                      : '服务未返回用量'}
                  </small>
                </div>
              </li>
            ) : (
              <li className={`is-${event.status}`} key={event.id}>
                <span className="agent-call-event-marker" />
                <div className="agent-call-event-main">
                  <strong>工具 · {event.label}</strong>
                  <span>
                    {eventStatusLabel(event.status)} ·{' '}
                    {durationLabel(event.durationMs)}
                  </span>
                  <small>{event.summary}</small>
                </div>
              </li>
            ),
          )}
        </ol>
      </div>
    </details>
  );
}

export default function AgentPanel({
  mode,
  provider,
  providerLabel,
  capabilities,
  target,
  mapTitle,
  mapMarkdown,
  currentRevision,
  onApplyProposal,
  onUndoProposal,
}: AgentPanelProps) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [conversations, setConversations] = useState<
    Record<string, AgentConversation>
  >({});
  const scopeKey = target ? target.nodeId || target.nodePath : 'no-target';
  const conversation = conversations[scopeKey] || emptyConversation();

  const updateConversation = (
    key: string,
    update: (current: AgentConversation) => AgentConversation,
  ) => {
    setConversations((current) => ({
      ...current,
      [key]: update(current[key] || emptyConversation()),
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || busy || conversation.proposal || !target) return;
    const requestScope = scopeKey;
    const startedAt = Date.now();
    const activeTurn: ActiveAgentTurn = {
      providerLabel,
      model: provider.model,
      mode,
      targetLabel: target.label,
      startedAt,
      events: [],
      contextWindow: resolveModelContextWindow(
        provider.baseUrl,
        provider.model,
      ),
    };
    setInput('');
    setBusy(true);
    updateConversation(requestScope, (current) => ({
      ...current,
      error: '',
      activeTurn,
      messages: [
        ...current.messages,
        { id: makeId(), role: 'user', content: prompt },
      ],
    }));

    try {
      const result = await runAgentTurn({
        history: conversation.history,
        prompt,
        provider,
        capabilities,
        mode,
        target,
        mapTitle,
        mapMarkdown,
        onEvent: (callEvent) => {
          updateConversation(requestScope, (current) => {
            if (!current.activeTurn) return current;
            const existing = current.activeTurn.events.findIndex(
              (item) => item.id === callEvent.id,
            );
            const events = [...current.activeTurn.events];
            if (existing < 0) events.push(callEvent);
            else events[existing] = callEvent;
            return {
              ...current,
              activeTurn: { ...current.activeTurn, events },
            };
          });
        },
      });
      updateConversation(requestScope, (current) => ({
        ...current,
        history: result.history,
        proposal: result.proposal,
        lastUsage: result.usage,
        activeTurn: null,
        messages: [
          ...current.messages,
          {
            id: makeId(),
            role: 'assistant',
            content: result.reply,
            turnDetails: completeTurn(
              current.activeTurn ?? activeTurn,
              result.usage,
              result.proposal ? 'proposal' : 'completed',
            ),
          },
        ],
      }));
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'AI 助手运行失败。';
      updateConversation(requestScope, (current) => {
        const failedUsage = current.activeTurn
          ? usageFromEvents(current.activeTurn.events)
          : null;
        return {
          ...current,
          error: message,
          lastUsage: failedUsage?.requestCount
            ? failedUsage
            : current.lastUsage,
          activeTurn: null,
          messages: [
            ...current.messages,
            {
              id: makeId(),
              role: 'assistant',
              content: '这轮没有完成，请检查错误后重试。',
              ...(current.activeTurn && failedUsage
                ? {
                    turnDetails: completeTurn(
                      current.activeTurn,
                      failedUsage,
                      'failed',
                    ),
                  }
                : {}),
            },
          ],
        };
      });
    } finally {
      setBusy(false);
    }
  };

  const applyProposal = async () => {
    const proposal = conversation.proposal;
    if (!proposal) return;
    try {
      const revision = await onApplyProposal(proposal);
      if (revision === null) {
        updateConversation(scopeKey, (current) => ({
          ...current,
          error: '导图在生成预览后发生了变化。请重新生成提案。',
        }));
        return;
      }
      updateConversation(scopeKey, (current) => ({
        ...current,
        lastApplied: { proposal, revision },
        proposal: null,
        error: '',
        messages: [
          ...current.messages,
          {
            id: makeId(),
            role: 'assistant',
            content: '分支已插入，文件库会按当前自动保存设置同步。',
          },
        ],
        history: [
          ...current.history,
          { role: 'assistant' as const, content: '用户已确认并应用下探分支。' },
        ].slice(-12),
      }));
    } catch (caught) {
      updateConversation(scopeKey, (current) => ({
        ...current,
        error: caught instanceof Error ? caught.message : '无法应用该提案。',
      }));
    }
  };

  const undoApplied = async () => {
    const lastApplied = conversation.lastApplied;
    if (!lastApplied) return;
    if (!(await onUndoProposal(lastApplied.proposal, lastApplied.revision))) {
      updateConversation(scopeKey, (current) => ({
        ...current,
        error: '导图已在应用修改后继续编辑，无法安全撤销这次 AI 修改。',
        lastApplied: null,
      }));
      return;
    }
    updateConversation(scopeKey, (current) => ({
      ...current,
      lastApplied: null,
      error: '',
      messages: [
        ...current.messages,
        { id: makeId(), role: 'assistant', content: '已撤销上一次 AI 分支。' },
      ],
      history: [
        ...current.history,
        { role: 'assistant' as const, content: '用户撤销了上一次 AI 分支。' },
      ].slice(-12),
    }));
  };

  const clearConversation = () => {
    if (busy || conversation.proposal) return;
    updateConversation(scopeKey, () => emptyConversation());
  };

  const modeLabel = mode === 'drilldown' ? '节点下探' : '可视化分析';
  const markdownSize = new TextEncoder().encode(mapMarkdown).byteLength;
  const contextEstimate =
    conversation.lastUsage?.contextTokensEstimate ??
    estimateTokenCount(
      JSON.stringify({ mapTitle, target, markdown: mapMarkdown }),
    );
  const contextWindow = resolveModelContextWindow(
    provider.baseUrl,
    provider.model,
  );
  const contextWindowTitle = contextWindow
    ? contextWindow.sourceLabel +
      '；核对日期 ' +
      contextWindow.verifiedOn +
      '；' +
      contextWindow.sourceUrl
    : '未核实该模型的官方上下文容量';

  return (
    <section className="agent-panel" aria-label={`LLM ${modeLabel}`}>
      <div className="agent-panel-heading">
        <div>
          <strong>{modeLabel}</strong>
          <span>
            {target
              ? `目标：${target.label}`
              : '点击思维导图中的节点以设定分析目标'}
          </span>
        </div>
        <button
          type="button"
          className="agent-clear-button"
          disabled={
            busy ||
            Boolean(conversation.proposal) ||
            conversation.messages.length === 0
          }
          onClick={clearConversation}
        >
          新对话
        </button>
      </div>

      <div className="agent-context-strip">
        <span className="agent-context-model">
          API · {providerLabel} · {provider.model || '未设置模型'}
        </span>
        <span title={markdownSize.toLocaleString() + ' 字节 Markdown 原文'}>
          全图上下文 · 约 {contextEstimate.toLocaleString()} tokens（本地估算）
        </span>
        <span title={contextWindowTitle}>
          {contextWindow
            ? '模型窗口 ' +
              formatContextWindow(contextWindow.tokens) +
              ' tokens'
            : '模型窗口未知'}
        </span>
      </div>

      <div className="agent-transcript" aria-live="polite">
        {conversation.messages.length === 0 ? (
          <div className="agent-empty-state">
            <strong>
              {target ? `当前目标：${target.label}` : '先选择一个导图节点'}
            </strong>
            <span>
              {mode === 'drilldown'
                ? '下探会整理定义、起源、工程应用、例子及适用的推导，并提炼可迁移结构。'
                : '可按主题生成图表、代码、SVG、HTML 组件或视频链接等可视化分支。'}
            </span>
            {target && (
              <button
                type="button"
                className="agent-suggestion-button"
                onClick={() =>
                  setInput(
                    mode === 'drilldown'
                      ? '请按标准结构下探当前目标节点，适用时给出完整推导，并提炼可迁移的元认知结构案例。'
                      : '请围绕当前目标做多维度可视化分析，根据内容选择最合适的项目内嵌格式。',
                  )
                }
              >
                填入标准请求
              </button>
            )}
          </div>
        ) : (
          conversation.messages.map((message) => (
            <article
              className={`agent-message is-${message.role}`}
              key={message.id}
            >
              <div className="agent-message-heading">
                <strong>{message.role === 'user' ? '你' : '模型'}</strong>
                {message.role === 'assistant' && (
                  <span>{message.turnDetails?.model || provider.model}</span>
                )}
              </div>
              <p>{message.content}</p>
              {message.turnDetails && (
                <AgentCallDetails details={message.turnDetails} />
              )}
            </article>
          ))
        )}
        {conversation.activeTurn && (
          <article className="agent-message is-assistant is-live">
            <div className="agent-message-heading">
              <strong>模型</strong>
              <span>{conversation.activeTurn.model || '模型未设置'}</span>
            </div>
            <p>正在处理本轮请求…</p>
            <AgentCallDetails
              details={{
                ...conversation.activeTurn,
                status: 'running',
                usage: usageFromEvents(conversation.activeTurn.events),
                durationMs: Date.now() - conversation.activeTurn.startedAt,
              }}
            />
          </article>
        )}
        {busy && !conversation.activeTurn && (
          <div className="agent-working">模型正在分析整张导图…</div>
        )}
      </div>

      {conversation.proposal && (
        <section className="agent-proposal" aria-label="待确认的导图分支">
          <div className="agent-proposal-heading">
            <strong>待确认分支</strong>
            <span>
              版本 {conversation.proposal.baseRevision} · 尚未写入当前导图
            </span>
          </div>
          <p>
            在「{conversation.proposal.previousLabel}」下插入
            {conversation.proposal.analysisMode === 'visualization'
              ? '可视化'
              : '下探'}
            分支「{conversation.proposal.nextLabel}」
          </p>
          {conversation.proposal.rationale && (
            <small>{conversation.proposal.rationale}</small>
          )}
          {conversation.proposal.htmlAssets?.length ? (
            <small className="agent-proposal-assets">
              确认后保存 {conversation.proposal.htmlAssets.length} 个隔离 HTML
              组件。
            </small>
          ) : null}
          <details className="agent-diff">
            <summary>查看 Markdown 分支预览</summary>
            <pre>
              {markdownChange(
                conversation.proposal.baseMarkdown,
                conversation.proposal.markdown,
              )
                .removed.map((line) => `− ${line}`)
                .concat(
                  markdownChange(
                    conversation.proposal.baseMarkdown,
                    conversation.proposal.markdown,
                  ).added.map((line) => `+ ${line}`),
                )
                .join('\n') || '没有可显示的文本差异'}
            </pre>
          </details>
          <div className="agent-proposal-actions">
            <button
              type="button"
              className="agent-apply-button"
              onClick={() => void applyProposal()}
            >
              确认插入并自动保存
            </button>
            <button
              type="button"
              className="agent-reject-button"
              onClick={() => {
                updateConversation(scopeKey, (current) => ({
                  ...current,
                  proposal: null,
                  error: '',
                  history: [
                    ...current.history,
                    {
                      role: 'assistant' as const,
                      content: '用户放弃了分支提案，导图没有变化。',
                    },
                  ].slice(-12),
                  messages: [
                    ...current.messages,
                    {
                      id: makeId(),
                      role: 'assistant',
                      content: '提案已放弃，导图未变化。',
                    },
                  ],
                }));
              }}
            >
              放弃
            </button>
          </div>
        </section>
      )}

      {conversation.lastApplied && !conversation.proposal && (
        <button
          type="button"
          className="agent-undo-button"
          disabled={currentRevision !== conversation.lastApplied.revision}
          onClick={() => void undoApplied()}
          title={
            currentRevision === conversation.lastApplied.revision
              ? '撤销上次 AI 分支'
              : '导图已继续编辑，撤销已禁用以免覆盖新修改'
          }
        >
          撤销上次 AI 分支
        </button>
      )}

      {conversation.error && (
        <div className="agent-error" role="alert">
          {conversation.error}
        </div>
      )}

      <form className="agent-compose" onSubmit={(event) => void submit(event)}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit(event as unknown as FormEvent);
            }
          }}
          maxLength={4000}
          rows={3}
          placeholder={
            target
              ? `补充对「${target.label}」的${modeLabel}要求…`
              : '请先在思维导图中点击一个节点…'
          }
          aria-label={`${modeLabel}消息`}
          disabled={busy || Boolean(conversation.proposal) || !target}
        />
        <button
          className="agent-send-button"
          type="submit"
          aria-label={busy ? '模型正在处理中' : '发送消息'}
          title={busy ? '模型正在处理中' : '发送消息'}
          disabled={
            busy || Boolean(conversation.proposal) || !input.trim() || !target
          }
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 16V4M5 9l5-5 5 5" />
          </svg>
        </button>
        <div className="ai-hint-footer">
          Ctrl + Enter 发送 · 整张导图作为上下文 · 插入前需确认
        </div>
      </form>
    </section>
  );
}
