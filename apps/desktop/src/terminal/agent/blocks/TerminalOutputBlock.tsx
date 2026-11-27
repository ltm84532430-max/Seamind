import { memo, useMemo, useState } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  TerminalIcon,
} from '../AgentIcons';

export interface TerminalOutputBlockProps {
  title?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  isError?: boolean;
  defaultExpanded?: boolean;
}

export const TerminalOutputBlock = memo(function TerminalOutputBlock({
  title = '命令终端输出',
  stdout,
  stderr,
  exitCode,
  isError = false,
  defaultExpanded = isError,
}: TerminalOutputBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const combinedText = useMemo(() => {
    const parts: string[] = [];
    if (stdout?.trim()) parts.push(stdout.trim());
    if (stderr?.trim()) {
      parts.push(stdout?.trim() ? `[stderr]\n${stderr.trim()}` : stderr.trim());
    }
    return parts.join('\n\n');
  }, [stderr, stdout]);

  const lineCount = useMemo(
    () =>
      combinedText
        ? combinedText.replace(/\r\n?/g, '\n').split('\n').length
        : 0,
    [combinedText],
  );

  if (!combinedText) return null;

  return (
    <section
      className={`ag-log-block${isError ? ' is-error' : ''}`}
      aria-label={`${title}（只读日志）`}
    >
      <div className="ag-log-block-head">
        <button
          type="button"
          className="ag-log-block-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDownIcon size={13} />
          ) : (
            <ChevronRightIcon size={13} />
          )}
          <TerminalIcon size={13} />
          <span>{title}</span>
          <span className="ag-readonly-badge">只读日志</span>
          <span className="ag-log-block-meta">
            {lineCount} 行
            {exitCode !== undefined && exitCode !== null
              ? ` · exit ${exitCode}`
              : ''}
          </span>
        </button>
        <button
          type="button"
          className="ag-step-btn"
          onClick={() => {
            void navigator.clipboard?.writeText(combinedText).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
          <span>{copied ? '已复制' : '复制日志'}</span>
        </button>
      </div>
      {expanded && (
        <pre className="ag-log-block-pre">
          <code>{combinedText}</code>
        </pre>
      )}
    </section>
  );
});
