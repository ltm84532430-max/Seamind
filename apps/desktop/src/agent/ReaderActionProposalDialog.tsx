import type { KnowledgeNoteProposal, ReaderChapterProposal } from './types';

export type ReaderActionProposal =
  | KnowledgeNoteProposal
  | ReaderChapterProposal;

function previewText(value: string): string {
  const limit = 4_000;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n…（还有 ${value.length - limit} 个字符，确认后会完整写入）`;
}

export default function ReaderActionProposalDialog({
  proposal,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  proposal: ReaderActionProposal;
  busy: boolean;
  error: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const title =
    proposal.kind === 'chapter'
      ? '确认跳转章节'
      : proposal.kind === 'excerpt'
        ? '确认沉淀摘录'
        : proposal.mode === 'append'
          ? '确认追加读书笔记'
          : '确认覆盖读书笔记';
  const summary =
    proposal.kind === 'chapter'
      ? `跳转到「${proposal.chapterTarget}」${proposal.reason ? `：${proposal.reason}` : ''}`
      : proposal.kind === 'excerpt'
        ? `把摘录写入${proposal.chapterLabel ? `「${proposal.chapterLabel}」` : '当前章节'}的读书笔记`
        : `${proposal.mode === 'append' ? '追加到' : '覆盖'}${proposal.chapterTarget ? `「${proposal.chapterTarget}」` : '当前章节'}的读书笔记`;
  const detail =
    proposal.kind === 'chapter'
      ? proposal.reason || '（未填写跳转原因）'
      : proposal.kind === 'excerpt'
        ? [
            proposal.chapterLabel ? `章节：${proposal.chapterLabel}` : '',
            previewText(proposal.excerpt),
            proposal.commentary
              ? `\n思考：\n${previewText(proposal.commentary)}`
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : [
            proposal.chapterTarget ? `章节：${proposal.chapterTarget}` : '',
            proposal.rationale ? `说明：${proposal.rationale}` : '',
            previewText(proposal.content),
          ]
            .filter(Boolean)
            .join('\n\n');

  return (
    <div className="settings-backdrop agent-cli-approval-backdrop">
      <section
        className="settings-dialog agent-cli-approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reader-action-approval-title"
      >
        <div className="agent-cli-approval-kicker">CLI · SEAMIND MCP</div>
        <h2 id="reader-action-approval-title">{title}</h2>
        <p>{summary}</p>
        <details open>
          <summary>查看内容</summary>
          <pre>{detail}</pre>
        </details>
        <p className="agent-cli-approval-note">
          {proposal.kind === 'chapter'
            ? '确认后才会翻到该章节，并尝试打开对应笔记。'
            : '确认后才会写入知识库。拒绝则笔记保持原样。'}
        </p>
        {error ? (
          <p className="agent-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="agent-cli-approval-actions">
          <button
            type="button"
            className="agent-cli-reject-button"
            disabled={busy}
            onClick={onCancel}
          >
            拒绝
          </button>
          <button
            type="button"
            className="agent-cli-apply-button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy
              ? '正在应用…'
              : proposal.kind === 'chapter'
                ? '确认并跳转'
                : '确认并写入'}
          </button>
        </div>
      </section>
    </div>
  );
}
