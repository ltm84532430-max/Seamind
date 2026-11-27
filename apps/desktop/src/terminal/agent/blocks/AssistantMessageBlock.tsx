import { memo, useMemo } from 'react';
import {
  BookProseView,
  type CodeBlockActionCallbacks,
} from '../../TerminalRichContent';

/**
 * Splits markdown into safe top-level segments outside fenced code blocks & display math blocks
 * so streaming updates only re-parse the trailing active chunk while earlier chunks remain memoized.
 */
export function splitStableMarkdownSegments(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return [];
  const lines = normalized.split('\n');
  const segments: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  let inMath = false;

  const flush = () => {
    const chunk = buf.join('\n').trim();
    if (chunk) segments.push(chunk);
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence && trimmed.startsWith('$$')) {
      if (!(trimmed.endsWith('$$') && trimmed.length > 4)) {
        inMath = !inMath;
      }
      buf.push(line);
      continue;
    }
    if (!inFence && !inMath && trimmed === '') {
      if (buf.length >= 6) {
        flush();
      } else {
        buf.push(line);
      }
      continue;
    }
    buf.push(line);
  }
  flush();
  return segments;
}

const MemoizedMarkdownSegment = memo(function MemoizedMarkdownSegment({
  segment,
  actions,
}: {
  segment: string;
  actions?: CodeBlockActionCallbacks;
}) {
  return <BookProseView content={segment} actions={actions} />;
});

export interface AssistantMessageBlockProps {
  content: string;
  isStreaming: boolean;
  actions?: CodeBlockActionCallbacks;
}

export const AssistantMessageBlock = memo(function AssistantMessageBlock({
  content,
  isStreaming,
  actions,
}: AssistantMessageBlockProps) {
  const segments = useMemo(
    () => splitStableMarkdownSegments(content),
    [content],
  );

  return (
    <div className={`ag-assistant-block${isStreaming ? ' is-streaming' : ''}`}>
      {segments.map((seg, idx) => (
        <MemoizedMarkdownSegment key={idx} segment={seg} actions={actions} />
      ))}
      {isStreaming && (
        <div className="ag-streaming-foot" aria-live="polite">
          <span className="ag-streaming-dot" aria-hidden="true" />
          <span>正在增量接收输出…</span>
        </div>
      )}
    </div>
  );
});
