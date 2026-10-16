import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentCapabilities } from './agent/capabilities';
import { runAgentTurn } from './agent/runtime';
import type {
  AgentChatMessage,
  AgentToolAction,
  NodeEditProposal,
} from './agent/types';

interface AgentPanelProps {
  provider: { baseUrl: string; model: string };
  capabilities: AgentCapabilities;
  currentRevision: number;
  onApplyProposal(proposal: NodeEditProposal): number | null;
  onUndoProposal(proposal: NodeEditProposal, appliedRevision: number): boolean;
}

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

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
    removed: oldLines.slice(prefix, oldLines.length - suffix).slice(0, 12),
    added: newLines.slice(prefix, newLines.length - suffix).slice(0, 12),
  };
}

export default function AgentPanel({
  provider,
  capabilities,
  currentRevision,
  onApplyProposal,
  onUndoProposal,
}: AgentPanelProps) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [history, setHistory] = useState<AgentChatMessage[]>([]);
  const [actions, setActions] = useState<AgentToolAction[]>([]);
  const [proposal, setProposal] = useState<NodeEditProposal | null>(null);
  const [lastApplied, setLastApplied] = useState<{
    proposal: NodeEditProposal;
    revision: number;
  } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || busy || proposal) return;

    setInput('');
    setError('');
    setBusy(true);
    setMessages((current) => [
      ...current,
      { id: makeId(), role: 'user', content: prompt },
    ]);

    try {
      const result = await runAgentTurn({
        history,
        prompt,
        provider,
        capabilities,
        onAction: (action) => {
          setActions((current) => {
            const existing = current.findIndex((item) => item.id === action.id);
            if (existing < 0) return [...current, action].slice(-16);
            const next = [...current];
            next[existing] = action;
            return next;
          });
        },
      });
      setHistory(result.history);
      setProposal(result.proposal);
      setMessages((current) => [
        ...current,
        { id: makeId(), role: 'assistant', content: result.reply },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AI 助手运行失败。');
      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: 'assistant',
          content: '这轮没有完成。请查看下方错误并重试。',
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const applyProposal = () => {
    if (!proposal) return;
    const revision = onApplyProposal(proposal);
    if (revision === null) {
      setError('导图在生成预览后发生了变化。请重新读取当前导图并生成提案。');
      return;
    }
    setLastApplied({ proposal, revision });
    setProposal(null);
    setError('');
    setMessages((current) => [
      ...current,
      {
        id: makeId(),
        role: 'assistant',
        content: '修改已应用，文件库会按当前自动保存设置同步。',
      },
    ]);
    setHistory((current) =>
      [
        ...current,
        { role: 'assistant' as const, content: '用户已确认并应用修改。' },
      ].slice(-12),
    );
  };

  const undoApplied = () => {
    if (!lastApplied) return;
    if (!onUndoProposal(lastApplied.proposal, lastApplied.revision)) {
      setError('导图已在应用修改后继续编辑，无法安全撤销这次 AI 修改。');
      setLastApplied(null);
      return;
    }
    setLastApplied(null);
    setError('');
    setMessages((current) => [
      ...current,
      { id: makeId(), role: 'assistant', content: '已撤销上一次 AI 修改。' },
    ]);
    setHistory((current) =>
      [
        ...current,
        { role: 'assistant' as const, content: '用户撤销了上一次 AI 修改。' },
      ].slice(-12),
    );
  };

  const clearConversation = () => {
    if (busy || proposal) return;
    setMessages([]);
    setHistory([]);
    setActions([]);
    setError('');
  };

  return (
    <section className="agent-panel" aria-label="Seamind AI 助手">
      <div className="agent-panel-heading">
        <div>
          <strong>Seamind 助手</strong>
          <span>可读取导图和文件库；修改需你确认</span>
        </div>
        <button
          type="button"
          className="agent-clear-button"
          disabled={busy || Boolean(proposal) || messages.length === 0}
          onClick={clearConversation}
        >
          新对话
        </button>
      </div>

      <div className="agent-transcript" aria-live="polite">
        {messages.length === 0 ? (
          <div className="agent-empty-state">
            <strong>可以这样开始</strong>
            <span>“读取当前导图，在「主题」下添加一个学习目标子节点。”</span>
            <span>“在文件库中搜索机器学习笔记，概括它们的共同结构。”</span>
          </div>
        ) : (
          messages.map((message) => (
            <article
              className={`agent-message is-${message.role}`}
              key={message.id}
            >
              <span>{message.role === 'user' ? '你' : '助手'}</span>
              <p>{message.content}</p>
            </article>
          ))
        )}
        {busy && <div className="agent-working">正在处理请求…</div>}
      </div>

      {actions.length > 0 && (
        <details className="agent-actions" open>
          <summary>工具执行记录（{actions.length}）</summary>
          <ol>
            {actions.map((action) => (
              <li className={`is-${action.status}`} key={action.id}>
                <span className="agent-action-status" />
                <div>
                  <strong>{action.label}</strong>
                  <small>{action.summary}</small>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}

      {proposal && (
        <section className="agent-proposal" aria-label="待确认的导图修改">
          <div className="agent-proposal-heading">
            <strong>待确认修改</strong>
            <span>不会在确认前写入当前导图</span>
          </div>
          <p>
            {proposal.operation === 'rename'
              ? `将「${proposal.previousLabel}」改为「${proposal.nextLabel}」`
              : proposal.operation === 'add_child'
                ? `在「${proposal.previousLabel}」下添加「${proposal.nextLabel}」`
                : proposal.operation === 'add_sibling'
                  ? `在「${proposal.previousLabel}」旁添加「${proposal.nextLabel}」`
                  : proposal.operation === 'delete'
                    ? `删除「${proposal.previousLabel}」及其子节点`
                    : `更新「${proposal.previousLabel}」的备注`}
          </p>
          {proposal.rationale && <small>{proposal.rationale}</small>}
          <details className="agent-diff">
            <summary>查看 Markdown 变更</summary>
            <pre>
              {markdownChange(proposal.baseMarkdown, proposal.markdown)
                .removed.map((line) => `− ${line}`)
                .concat(
                  markdownChange(
                    proposal.baseMarkdown,
                    proposal.markdown,
                  ).added.map((line) => `+ ${line}`),
                )
                .join('\n') || '没有可显示的文本差异'}
            </pre>
          </details>
          <div className="agent-proposal-actions">
            <button
              type="button"
              className="agent-apply-button"
              onClick={applyProposal}
            >
              应用并自动保存
            </button>
            <button
              type="button"
              className="agent-reject-button"
              onClick={() => {
                setProposal(null);
                setError('');
                const rejection = '用户放弃了这条提案，导图没有变化。';
                setHistory((current) =>
                  [
                    ...current,
                    { role: 'assistant' as const, content: rejection },
                  ].slice(-12),
                );
                setMessages((current) => [
                  ...current,
                  {
                    id: makeId(),
                    role: 'assistant',
                    content: '提案已放弃，导图未变化。',
                  },
                ]);
              }}
            >
              放弃
            </button>
          </div>
        </section>
      )}

      {lastApplied && !proposal && (
        <button
          type="button"
          className="agent-undo-button"
          disabled={currentRevision !== lastApplied.revision}
          onClick={undoApplied}
          title={
            currentRevision === lastApplied.revision
              ? '撤销上次 AI 修改'
              : '导图已继续编辑，撤销已禁用以免覆盖新修改'
          }
        >
          撤销上次 AI 修改
        </button>
      )}

      {error && (
        <div className="agent-error" role="alert">
          {error}
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
          placeholder="描述你要查询或调整的内容…"
          aria-label="AI 助手消息"
          disabled={busy || Boolean(proposal)}
        />
        <button
          className="ai-generate-button"
          type="submit"
          disabled={busy || Boolean(proposal) || !input.trim()}
        >
          {busy ? '处理中…' : '发送给助手'}
        </button>
        <div className="ai-hint-footer">Ctrl + Enter 发送 · 修改需确认</div>
      </form>
    </section>
  );
}
