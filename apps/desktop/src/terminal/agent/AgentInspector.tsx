import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { formatContextWindow } from '../../agent/model-context';
import type { TerminalAgentEngineMode } from '../terminal-types';
import { CheckIcon, CloseIcon, PlusIcon, RefreshIcon } from './AgentIcons';
import {
  clampInspectorWidth,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  type InspectorTabId,
} from './agent-workbench-prefs';
import type {
  ActiveModelDisplay,
  AgentRunPhase,
  CliEngineId,
  ContextSourceAvailability,
  LocalEngineConfig,
  McpBridgeSnapshot,
  SessionArtifactItem,
  SessionTelemetrySnapshot,
} from './agent-workbench-types';
import { extractContextTagsFromInput } from './agent-workbench-utils';

export interface AgentInspectorProps {
  width: number;
  activeTab: InspectorTabId;
  engineConfig: LocalEngineConfig;
  activeCliEngine: CliEngineId | null;
  activeModelDisplay: ActiveModelDisplay;
  telemetry: SessionTelemetrySnapshot;
  mcpStatus: McpBridgeSnapshot;
  contextSources: ContextSourceAvailability[];
  artifacts: SessionArtifactItem[];
  composerInputText: string;
  onWidthChange: (nextWidth: number) => void;
  onTabChange: (tab: InspectorTabId) => void;
  onClose: () => void;
  onRefreshMcp: () => void;
  onSelectEngineMode: (mode: TerminalAgentEngineMode) => void;
  onAttachContext: (token: string) => void;
  onRemoveContext: (token: string) => void;
  onOpenModelModal: () => void;
}

const PHASE_LABEL: Record<AgentRunPhase, { label: string; className: string }> =
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

export const AgentInspector = memo(function AgentInspector({
  width,
  activeTab,
  engineConfig,
  activeCliEngine,
  activeModelDisplay,
  telemetry,
  mcpStatus,
  contextSources,
  artifacts,
  composerInputText,
  onWidthChange,
  onTabChange,
  onClose,
  onRefreshMcp,
  onSelectEngineMode,
  onAttachContext,
  onRemoveContext,
  onOpenModelModal,
}: AgentInspectorProps) {
  const [mcpFilter, setMcpFilter] = useState('');
  const [resizing, setResizing] = useState(false);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  const mountedTags = useMemo(
    () => extractContextTagsFromInput(composerInputText),
    [composerInputText],
  );
  const mountedSet = useMemo(
    () => new Set(mountedTags.map((t) => t.toLowerCase())),
    [mountedTags],
  );

  const sourceByToken = useMemo(() => {
    const map = new Map<string, ContextSourceAvailability>();
    for (const src of contextSources) {
      map.set(src.token.toLowerCase(), src);
    }
    return map;
  }, [contextSources]);

  const filteredTools = useMemo(() => {
    const q = mcpFilter.trim().toLowerCase();
    if (!q) return mcpStatus.toolNames;
    return mcpStatus.toolNames.filter((name) => name.toLowerCase().includes(q));
  }, [mcpFilter, mcpStatus.toolNames]);

  const activeCliInfo = activeCliEngine
    ? telemetry.cliEngines.find((c) => c.id === activeCliEngine)
    : null;

  const phaseMeta = PHASE_LABEL[telemetry.sessionPhase];
  const hasReportedUsage = telemetry.reportedUsage.reportedRequests > 0;
  const contextWindowLabel = telemetry.contextWindow
    ? formatContextWindow(telemetry.contextWindow.tokens)
    : '未提供';

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStartRef.current = { startX: event.clientX, startWidth: width };
      setResizing(true);
    },
    [width],
  );

  const handleResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStartRef.current) return;
      const delta = dragStartRef.current.startX - event.clientX;
      onWidthChange(
        clampInspectorWidth(dragStartRef.current.startWidth + delta),
      );
    },
    [onWidthChange],
  );

  const handleResizePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStartRef.current) return;
      dragStartRef.current = null;
      setResizing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onWidthChange(clampInspectorWidth(width + 16));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        onWidthChange(clampInspectorWidth(width - 16));
      }
    },
    [onWidthChange, width],
  );

  return (
    <aside
      className={`ag-inspector${resizing ? ' is-resizing' : ''}`}
      style={{ width: `${width}px`, flexBasis: `${width}px` }}
      aria-label="会话检查器"
    >
      <div
        className="ag-inspector-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整检查器面板宽度"
        aria-valuemin={INSPECTOR_MIN_WIDTH}
        aria-valuemax={INSPECTOR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
        onKeyDown={handleResizeKeyDown}
      />

      <div className="ag-inspector-inner">
        <div className="ag-inspector-head">
          <div className="ag-insp-tabs" role="tablist" aria-label="检查器分区">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'context'}
              className={`ag-insp-tab${activeTab === 'context' ? ' is-active' : ''}`}
              onClick={() => onTabChange('context')}
            >
              <span>上下文</span>
              {mountedTags.length > 0 && (
                <span className="ag-insp-tab-count">{mountedTags.length}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'runtime'}
              className={`ag-insp-tab${activeTab === 'runtime' ? ' is-active' : ''}`}
              onClick={() => onTabChange('runtime')}
            >
              <span>运行</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'tools'}
              className={`ag-insp-tab${activeTab === 'tools' ? ' is-active' : ''}`}
              onClick={() => onTabChange('tools')}
            >
              <span>工具</span>
              {mcpStatus.toolCount !== null && (
                <span className="ag-insp-tab-count">{mcpStatus.toolCount}</span>
              )}
            </button>
          </div>
          <button
            type="button"
            className="ag-inspector-close"
            onClick={onClose}
            title="收起检查器"
            aria-label="收起检查器"
          >
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="ag-inspector-scroll" role="tabpanel">
          {/* Tab 1: ContextInspector */}
          {activeTab === 'context' && (
            <>
              <section className="ag-insp-section">
                <div className="ag-insp-title">
                  已挂载上下文 ({mountedTags.length})
                </div>
                {mountedTags.length === 0 ? (
                  <p className="ag-insp-empty-text">
                    当前草稿未挂载上下文；可在下方点击资源或输入 `#` 引用。
                  </p>
                ) : (
                  <div className="ag-insp-mounted-list">
                    {mountedTags.map((tag) => {
                      const baseKey = tag.split(':')[0].toLowerCase();
                      const meta =
                        sourceByToken.get(tag.toLowerCase()) ??
                        sourceByToken.get(baseKey);
                      return (
                        <div key={tag} className="ag-insp-mounted-item">
                          <div className="ag-insp-mounted-head">
                            <code className="ag-insp-ctx-token">{tag}</code>
                            <button
                              type="button"
                              className="ag-insp-remove-btn"
                              onClick={() => onRemoveContext(tag)}
                              aria-label={`移除 ${tag}`}
                              title={`移除 ${tag}`}
                            >
                              <CloseIcon size={11} />
                            </button>
                          </div>
                          <span className="ag-insp-mounted-desc">
                            {meta?.detailText ??
                              meta?.hint ??
                              '随下一次提问注入'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="ag-insp-section">
                <div className="ag-insp-title">可用上下文源</div>
                <div className="ag-insp-context-list">
                  {contextSources.map((src) => {
                    const attached = mountedSet.has(src.token.toLowerCase());
                    return (
                      <button
                        key={src.token}
                        type="button"
                        className={`ag-insp-ctx-row${attached ? ' is-attached' : ''}${src.alert ? ' is-alert' : ''}`}
                        onClick={() =>
                          attached
                            ? onRemoveContext(src.token)
                            : onAttachContext(src.token)
                        }
                        title={src.hint}
                        aria-pressed={attached}
                      >
                        <span className="ag-insp-ctx-icon" aria-hidden="true">
                          {attached ? (
                            <CheckIcon size={12} />
                          ) : (
                            <PlusIcon size={12} />
                          )}
                        </span>
                        <span className="ag-insp-ctx-token">{src.token}</span>
                        <span className="ag-insp-ctx-label">{src.label}</span>
                        <span className="ag-insp-ctx-state">
                          {attached
                            ? '已挂'
                            : src.badge || (src.available ? '挂载' : '—')}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="ag-insp-section">
                <div className="ag-insp-title">
                  会话产物索引 ({artifacts.length})
                </div>
                {artifacts.length === 0 ? (
                  <p className="ag-insp-empty-text">
                    暂无代码、表格、文件或命令提案产出。
                  </p>
                ) : (
                  <div className="ag-insp-artifacts">
                    {artifacts.map((art) => (
                      <button
                        key={art.id}
                        type="button"
                        className="ag-insp-artifact-row"
                        onClick={() => {
                          document
                            .getElementById(`agent-turn-${art.turnId}`)
                            ?.scrollIntoView({
                              behavior: 'smooth',
                              block: 'start',
                            });
                        }}
                        title={art.preview}
                      >
                        <span className="ag-insp-art-badge">
                          {art.language}
                        </span>
                        <span className="ag-insp-art-title">{art.title}</span>
                        <span className="ag-insp-art-meta">
                          #{art.turnIndex}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          {/* Tab 2: RuntimeInspector */}
          {activeTab === 'runtime' && (
            <>
              <section className="ag-insp-section">
                <div className="ag-insp-title">任务状态</div>
                <div className="ag-insp-kv">
                  <span>运行阶段</span>
                  <span className={`ag-status-badge ${phaseMeta.className}`}>
                    {phaseMeta.label}
                  </span>
                </div>
                <div className="ag-insp-kv">
                  <span>对话轮次</span>
                  <strong>{telemetry.turnCount}</strong>
                </div>
                <div className="ag-insp-kv">
                  <span>已执行工具步</span>
                  <strong>{telemetry.totalToolCalls}</strong>
                </div>
                <div className="ag-insp-kv">
                  <span>待确认提案</span>
                  <strong
                    className={
                      telemetry.pendingApprovals > 0
                        ? 'is-accent-warn'
                        : undefined
                    }
                  >
                    {telemetry.pendingApprovals}
                  </strong>
                </div>
              </section>

              <section className="ag-insp-section">
                <div className="ag-insp-title-row">
                  <span className="ag-insp-title">模型与内核</span>
                  <button
                    type="button"
                    className="ag-insp-link"
                    onClick={onOpenModelModal}
                  >
                    配置
                  </button>
                </div>
                <div className="ag-insp-kv">
                  <span>调度模式</span>
                  <strong className="is-mono">{engineConfig.mode}</strong>
                </div>
                <div className="ag-insp-kv">
                  <span>当前模型</span>
                  <strong
                    className="is-mono is-truncate"
                    title={activeModelDisplay.id || activeModelDisplay.family}
                  >
                    {activeModelDisplay.family}
                    {activeModelDisplay.tier
                      ? ` (${activeModelDisplay.tier})`
                      : ''}
                  </strong>
                </div>
                <div className="ag-insp-kv">
                  <span>{activeCliEngine ? 'CLI 路径' : 'API 端点'}</span>
                  <strong
                    className="is-mono is-truncate"
                    title={
                      activeCliEngine
                        ? activeCliInfo?.path || '未检测到'
                        : engineConfig.baseUrl
                    }
                  >
                    {activeCliEngine
                      ? activeCliInfo?.path || '未提供'
                      : engineConfig.baseUrl || '未提供'}
                  </strong>
                </div>
                <div className="ag-insp-kv">
                  <span>文档上下文窗口</span>
                  <strong
                    className="is-mono"
                    title={
                      telemetry.contextWindow
                        ? `${telemetry.contextWindow.sourceLabel} (${telemetry.contextWindow.verifiedOn})`
                        : '当前模型未提供官方文档容量'
                    }
                  >
                    {contextWindowLabel}
                  </strong>
                </div>
                <div className="ag-insp-kv">
                  <span>接口上报用量</span>
                  <strong className="is-mono">
                    {hasReportedUsage
                      ? `${telemetry.reportedUsage.totalTokens.toLocaleString()} tok`
                      : '未提供'}
                  </strong>
                </div>
                {hasReportedUsage && (
                  <div className="ag-insp-subkv">
                    <span>
                      In {telemetry.reportedUsage.promptTokens.toLocaleString()}{' '}
                      · Out{' '}
                      {telemetry.reportedUsage.completionTokens.toLocaleString()}
                    </span>
                  </div>
                )}
                <div className="ag-insp-kv">
                  <span>本地历史估算</span>
                  <strong
                    className="is-mono is-muted"
                    title="按字符长度粗略估算，非模型接口计费值"
                  >
                    {telemetry.localEstimatedTokens > 0
                      ? `~${telemetry.localEstimatedTokens.toLocaleString()} tok`
                      : '0'}
                  </strong>
                </div>
              </section>
            </>
          )}

          {/* Tab 3: ToolInspector */}
          {activeTab === 'tools' && (
            <>
              <section className="ag-insp-section">
                <div className="ag-insp-title-row">
                  <span className="ag-insp-title">MCP 通道</span>
                  <button
                    type="button"
                    className="ag-insp-icon-link"
                    onClick={onRefreshMcp}
                    title="刷新本地 MCP 通道状态"
                  >
                    <RefreshIcon size={12} />
                    <span>刷新</span>
                  </button>
                </div>
                <div className="ag-insp-kv">
                  <span>服务状态</span>
                  <strong
                    className={
                      mcpStatus.ready
                        ? 'is-accent-ok'
                        : mcpStatus.state === 'error'
                          ? 'is-accent-err'
                          : 'is-muted'
                    }
                  >
                    {mcpStatus.state === 'loading'
                      ? '检测中…'
                      : mcpStatus.ready
                        ? '已就绪'
                        : mcpStatus.state === 'error'
                          ? '检测异常'
                          : '未提供'}
                  </strong>
                </div>
                <div className="ag-insp-kv">
                  <span>已注册工具</span>
                  <strong className="is-mono">
                    {mcpStatus.toolCount !== null
                      ? `${mcpStatus.toolCount} 个`
                      : '未提供'}
                  </strong>
                </div>
                <div className="ag-insp-kv">
                  <span>本地端点</span>
                  <strong
                    className="is-mono is-truncate"
                    title={mcpStatus.endpoint ?? '未提供'}
                  >
                    {mcpStatus.endpoint ?? '未提供'}
                  </strong>
                </div>

                {mcpStatus.toolNames.length > 0 && (
                  <div className="ag-insp-tool-drawer">
                    <input
                      type="text"
                      className="ag-insp-filter"
                      value={mcpFilter}
                      onChange={(e) => setMcpFilter(e.target.value)}
                      placeholder="筛选 MCP 工具名称…"
                      aria-label="筛选 MCP 工具名称"
                    />
                    <div className="ag-insp-tool-list">
                      {filteredTools.slice(0, 60).map((name) => (
                        <code key={name} className="ag-insp-tool-chip">
                          {name}
                        </code>
                      ))}
                      {filteredTools.length === 0 && (
                        <span className="ag-insp-empty-text">无匹配工具</span>
                      )}
                    </div>
                  </div>
                )}
              </section>

              <section className="ag-insp-section">
                <div className="ag-insp-title">本机 CLI 连接器</div>
                <div className="ag-insp-cli-list">
                  {(['agy', 'gemini', 'claude', 'codex'] as const).map(
                    (cid) => {
                      const stat = telemetry.cliEngines.find(
                        (c) => c.id === cid,
                      );
                      const ok = Boolean(stat?.available);
                      const label =
                        cid === 'agy'
                          ? 'Antigravity CLI'
                          : cid === 'gemini'
                            ? 'Gemini CLI'
                            : cid === 'claude'
                              ? 'Claude CLI'
                              : 'Codex CLI';
                      const selected = engineConfig.mode === `cli:${cid}`;
                      return (
                        <button
                          key={cid}
                          type="button"
                          className={`ag-insp-cli-row${selected ? ' is-selected' : ''}`}
                          onClick={() => onSelectEngineMode(`cli:${cid}`)}
                          title={stat?.hint ?? label}
                        >
                          <span
                            className={`ag-status-dot${ok ? ' is-ready' : ' is-muted'}`}
                            aria-hidden="true"
                          />
                          <span className="ag-insp-cli-name">{label}</span>
                          <span className="ag-insp-cli-state">
                            {stat ? (ok ? '可用' : '未检出') : '未提供'}
                          </span>
                        </button>
                      );
                    },
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </aside>
  );
});
