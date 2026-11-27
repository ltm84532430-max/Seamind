import { memo, useMemo, useState } from 'react';
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  SlashCircleIcon,
  SpinnerIcon,
  TerminalIcon,
  ToolIcon,
  XCircleIcon,
} from '../AgentIcons';
import type { ExecutionBlock } from '../agent-workbench-types';
import { formatDurationCompact } from '../agent-workbench-utils';

type DetailTab = 'args' | 'output' | 'error';

export const ToolCallBlock = memo(function ToolCallBlock({
  block,
}: {
  block: ExecutionBlock;
}) {
  const argsJson = useMemo(() => {
    if (!block.inputArgs || Object.keys(block.inputArgs).length === 0) {
      return '';
    }
    try {
      return JSON.stringify(block.inputArgs, null, 2);
    } catch {
      return '';
    }
  }, [block.inputArgs]);

  const outputText = (block.outputPreview ?? block.detail ?? '').trim();
  const errorText = (block.errorDetail ?? '').trim();

  const availableTabs = useMemo<DetailTab[]>(() => {
    const list: DetailTab[] = [];
    if (argsJson) list.push('args');
    if (outputText) list.push('output');
    if (errorText) list.push('error');
    return list;
  }, [argsJson, errorText, outputText]);

  const defaultTab: DetailTab = errorText
    ? 'error'
    : outputText
      ? 'output'
      : 'args';

  const [open, setOpen] = useState(
    block.status === 'failed' && Boolean(errorText),
  );
  const [activeTab, setActiveTab] = useState<DetailTab>(defaultTab);
  const [copied, setCopied] = useState(false);

  const effectiveTab = availableTabs.includes(activeTab)
    ? activeTab
    : (availableTabs[0] ?? 'output');

  const activeContent =
    effectiveTab === 'args'
      ? argsJson
      : effectiveTab === 'error'
        ? errorText
        : outputText;

  const durationText = formatDurationCompact(block.durationMs);

  const statusIcon =
    block.status === 'running' ? (
      <SpinnerIcon size={13} className="ag-icon-spin" />
    ) : block.status === 'done' ? (
      <CheckIcon size={13} />
    ) : block.status === 'approval' ? (
      <AlertTriangleIcon size={13} />
    ) : block.status === 'cancelled' ? (
      <SlashCircleIcon size={13} />
    ) : (
      <XCircleIcon size={13} />
    );

  const statusText =
    block.status === 'running'
      ? '运行中'
      : block.status === 'done'
        ? '完成'
        : block.status === 'approval'
          ? '待确认'
          : block.status === 'cancelled'
            ? '已取消'
            : '失败';

  const kindLabel =
    block.kind === 'model'
      ? 'MODEL'
      : block.kind === 'cli-tool'
        ? 'CLI'
        : block.kind === 'status'
          ? 'LOG'
          : 'TOOL';

  const canExpand = availableTabs.length > 0;

  const handleCopy = () => {
    const payload =
      activeContent || block.detail || block.summary || block.label;
    void navigator.clipboard?.writeText(payload).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className={`ag-step-card is-${block.status}`}>
      <div className="ag-step-row">
        <span
          className="ag-step-glyph"
          aria-label={statusText}
          title={statusText}
        >
          {statusIcon}
        </span>

        <span className={`ag-step-kind is-kind-${block.kind}`}>
          {block.kind === 'tool' || block.kind === 'cli-tool' ? (
            <ToolIcon size={11} />
          ) : block.kind === 'status' ? (
            <TerminalIcon size={11} />
          ) : null}
          <span>{kindLabel}</span>
        </span>

        <strong className="ag-step-label">{block.label}</strong>

        {block.toolName &&
          block.toolName !== block.label &&
          !block.label.includes(block.toolName) && (
            <code className="ag-step-toolname">{block.toolName}</code>
          )}

        {block.summary && !open && (
          <span className="ag-step-summary" title={block.summary}>
            {block.summary}
          </span>
        )}

        <div className="ag-step-meta">
          <span className="ag-step-status-text">{statusText}</span>
          {durationText && <span className="ag-step-ms">{durationText}</span>}
          {canExpand && (
            <button
              type="button"
              className="ag-step-btn"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? (
                <ChevronDownIcon size={11} />
              ) : (
                <ChevronRightIcon size={11} />
              )}
              <span>{open ? '收起' : '详情'}</span>
            </button>
          )}
          {(canExpand || block.summary) && (
            <button
              type="button"
              className="ag-step-btn"
              onClick={handleCopy}
              title="复制此步骤内容"
            >
              <CopyIcon size={11} />
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          )}
        </div>
      </div>

      {open && canExpand && (
        <div className="ag-step-detail-panel">
          {availableTabs.length > 1 && (
            <div
              className="ag-step-tabs"
              role="tablist"
              aria-label="步骤详情视图"
            >
              {availableTabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={effectiveTab === tab}
                  className={`ag-step-tab${effectiveTab === tab ? ' is-active' : ''}${tab === 'error' ? ' is-error' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === 'args'
                    ? '参数（已脱敏）'
                    : tab === 'error'
                      ? '错误详情'
                      : '返回结果'}
                </button>
              ))}
            </div>
          )}
          <pre
            className={`ag-step-log${effectiveTab === 'error' ? ' is-error' : ''}`}
          >
            <code>{activeContent}</code>
          </pre>
        </div>
      )}
    </div>
  );
});
