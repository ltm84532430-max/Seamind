import { useEffect, useRef, useState } from 'react';
import {
  notifyPlayerDocumentUpdated,
  playerDocumentStorageKey,
  playerLegacyNoteStorageKey,
} from './player-note-storage';

export interface PlayerExportedDocument {
  id?: string;
  title: string;
  category: string;
  markdown: string;
  openKnowledge?: () => void;
  updateMarkdown?: (markdown: string, statusLabel?: string) => Promise<void>;
  pendingManualSync?: boolean;
}

type FormatAction =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'link'
  | 'image'
  | 'code'
  | 'bullet'
  | 'ordered'
  | 'check'
  | 'quote'
  | 'rule';

const FORMAT_BUTTONS: Array<{
  action: FormatAction;
  label: string;
  title: string;
}> = [
  { action: 'heading', label: 'H1', title: '一级标题' },
  { action: 'bold', label: 'B', title: '加粗' },
  { action: 'italic', label: 'I', title: '斜体' },
  { action: 'strike', label: 'S', title: '删除线' },
  { action: 'link', label: '链', title: '插入链接' },
  { action: 'image', label: '图', title: '插入图片链接' },
  { action: 'code', label: '</>', title: '行内代码' },
  { action: 'bullet', label: '•', title: '无序列表' },
  { action: 'ordered', label: '1.', title: '有序列表' },
  { action: 'check', label: '☑', title: '待办事项' },
  { action: 'quote', label: '❞', title: '引用' },
  { action: 'rule', label: '—', title: '分隔线' },
];

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function applyFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  action: FormatAction,
) {
  const selected = value.slice(selectionStart, selectionEnd);
  if (action === 'rule') {
    const insertion = `${selectionStart > 0 && value[selectionStart - 1] !== '\n' ? '\n' : ''}---\n`;
    const next = `${value.slice(0, selectionStart)}${insertion}${value.slice(selectionEnd)}`;
    const cursor = selectionStart + insertion.length;
    return { value: next, selectionStart: cursor, selectionEnd: cursor };
  }

  if (
    action === 'heading' ||
    action === 'bullet' ||
    action === 'ordered' ||
    action === 'check' ||
    action === 'quote'
  ) {
    const lineStart =
      value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
    const nextBreak = value.indexOf('\n', selectionEnd);
    const lineEnd = nextBreak < 0 ? value.length : nextBreak;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split('\n');
    const prefixes: Record<typeof action, string> = {
      heading: '# ',
      bullet: '- ',
      ordered: '',
      check: '- [ ] ',
      quote: '> ',
    };
    const nextBlock = lines
      .map((line, index) => {
        if (action === 'ordered') return `${index + 1}. ${line}`;
        const prefix = prefixes[action];
        if (action === 'heading' && /^#{1,6}\s/.test(line))
          return line.replace(/^#{1,6}\s/, prefix);
        if (action === 'quote' && line.startsWith('> ')) return line.slice(2);
        if (action === 'check' && /^- \[ \] /.test(line)) return line.slice(6);
        return `${prefix}${line}`;
      })
      .join('\n');
    const next = `${value.slice(0, lineStart)}${nextBlock}${value.slice(lineEnd)}`;
    return {
      value: next,
      selectionStart: lineStart,
      selectionEnd: lineStart + nextBlock.length,
    };
  }

  const wrappers: Partial<Record<FormatAction, [string, string, string]>> = {
    bold: ['**', '**', '粗体文本'],
    italic: ['*', '*', '斜体文本'],
    strike: ['~~', '~~', '删除线文本'],
    code: ['`', '`', '代码'],
    link: ['[', '](https://)', '链接文字'],
    image: ['![', '](图片链接)', '图片说明'],
  };
  const [prefix, suffix, placeholder] = wrappers[action] ?? ['', '', ''];
  const content = selected || placeholder;
  const replacement = `${prefix}${content}${suffix}`;
  const next = `${value.slice(0, selectionStart)}${replacement}${value.slice(selectionEnd)}`;
  const contentStart = selectionStart + prefix.length;
  const contentEnd = contentStart + content.length;
  return {
    value: next,
    selectionStart: selected ? contentStart : contentStart,
    selectionEnd: selected ? contentEnd : contentEnd,
  };
}

export function PlayerDocumentEditor({
  videoId,
  videoTitle,
  currentTime,
  document,
  suspendDocumentSave = false,
  onDocumentMarkdownChange,
  onDepositToKnowledge,
}: {
  videoId: string;
  videoTitle: string;
  currentTime: number;
  document?: PlayerExportedDocument | null;
  suspendDocumentSave?: boolean;
  onDocumentMarkdownChange?(markdown: string): void;
  onDepositToKnowledge?(
    markdown: string,
  ): Promise<PlayerExportedDocument | void>;
}) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [saveStatus, setSaveStatus] = useState('保存在本机');
  const [depositing, setDepositing] = useState(false);
  const editedRef = useRef(false);
  const editVersionRef = useRef(0);
  const loadedDocumentKeyRef = useRef<string | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const documentId = document?.id;
  const updateDocumentMarkdown = document?.updateMarkdown;
  const hasExportedDocument = Boolean(document);
  const storageKey = playerDocumentStorageKey(videoId);
  const legacyStorageKey = playerLegacyNoteStorageKey(videoId);

  useEffect(() => {
    const documentKey = document
      ? `${document.id ?? videoId}:${document.title}`
      : null;
    if (document) {
      if (loadedDocumentKeyRef.current !== documentKey) {
        loadedDocumentKeyRef.current = documentKey;
        editedRef.current = Boolean(document.pendingManualSync);
        setMarkdown(document.markdown);
        setSaveStatus(
          document.pendingManualSync ? '正在合并已有笔记…' : '字幕稿已载入',
        );
      } else if (!editedRef.current) {
        setMarkdown(document.markdown);
      }
      return;
    }
    loadedDocumentKeyRef.current = null;
    editedRef.current = false;
    try {
      setMarkdown(
        localStorage.getItem(storageKey) ??
          localStorage.getItem(legacyStorageKey) ??
          '',
      );
      setSaveStatus('保存在本机');
    } catch {
      setMarkdown('');
      setSaveStatus('本机存储不可用');
    }
  }, [
    document?.id,
    document?.title,
    document?.markdown,
    videoId,
    storageKey,
    legacyStorageKey,
  ]);

  useEffect(() => {
    const editVersion = editVersionRef.current;
    const timer = window.setTimeout(async () => {
      try {
        localStorage.setItem(storageKey, markdown);
        if (hasExportedDocument) localStorage.removeItem(legacyStorageKey);
        notifyPlayerDocumentUpdated(videoId, markdown);
      } catch {
        if (editVersion === editVersionRef.current)
          setSaveStatus('本机保存失败');
        return;
      }

      if (!updateDocumentMarkdown || !editedRef.current) {
        if (editVersion === editVersionRef.current)
          setSaveStatus('已保存在本机');
        return;
      }

      if (suspendDocumentSave) {
        if (editVersion === editVersionRef.current)
          setSaveStatus('本机已保存 · 字幕精修后同步');
        return;
      }

      const write = saveQueueRef.current
        .catch(() => undefined)
        .then(() => updateDocumentMarkdown(markdown, '播放器手动编辑'));
      saveQueueRef.current = write;
      setSaveStatus('正在同步到知识库…');
      try {
        await write;
        if (editVersion === editVersionRef.current)
          setSaveStatus('已同步到知识库与本机');
      } catch {
        if (editVersion === editVersionRef.current)
          setSaveStatus('已保存在本机 · 知识库同步失败');
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    documentId,
    updateDocumentMarkdown,
    hasExportedDocument,
    markdown,
    storageKey,
    legacyStorageKey,
    suspendDocumentSave,
  ]);

  const updateMarkdown = (next: string) => {
    editedRef.current = true;
    editVersionRef.current += 1;
    setSaveStatus('保存中…');
    setMarkdown(next);
    onDocumentMarkdownChange?.(next);
  };

  const insert = (action: FormatAction) => {
    const editor = editorRef.current;
    if (!editor) return;
    const result = applyFormat(
      markdown,
      editor.selectionStart,
      editor.selectionEnd,
      action,
    );
    updateMarkdown(result.value);
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };

  const insertTimestamp = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const seconds = Math.max(0, Math.floor(currentTime));
    const timestamp = formatTime(seconds);
    const link = `[${timestamp}](https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${seconds}s) `;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const next = `${markdown.slice(0, start)}${link}${markdown.slice(end)}`;
    updateMarkdown(next);
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(start + link.length, start + link.length);
    });
  };

  const handleDeposit = async () => {
    if (!onDepositToKnowledge || depositing || !markdown.trim()) return;
    setDepositing(true);
    setSaveStatus('正在沉淀至知识库…');
    try {
      const result = await onDepositToKnowledge(markdown);
      if (result) {
        setSaveStatus('已沉淀至知识库');
      }
    } catch {
      setSaveStatus('沉淀失败，已保存在本机');
    } finally {
      setDepositing(false);
    }
  };

  return (
    <section className="player-video-notes" aria-label="字幕稿与视频笔记">
      <div className="player-video-notes-context">
        <div>
          <strong title={document?.title ?? videoTitle}>
            {document?.title ?? videoTitle}
          </strong>
          <span>{document?.category ?? '字幕稿与观看笔记'}</span>
        </div>
        <div className="player-video-notes-context-actions">
          {document?.openKnowledge ? (
            <button
              type="button"
              className="player-open-knowledge-btn"
              onClick={document.openKnowledge}
              title="在知识库中打开此篇笔记"
            >
              知识库打开
            </button>
          ) : onDepositToKnowledge ? (
            <button
              type="button"
              className="player-save-knowledge-btn"
              disabled={depositing || !markdown.trim()}
              onClick={handleDeposit}
              title="将文稿与观看笔记沉淀至知识库"
            >
              {depositing ? '沉淀中…' : '沉淀到知识库'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={insertTimestamp}
            title="在当前光标处插入播放时间"
          >
            + {formatTime(currentTime)}
          </button>
        </div>
      </div>
      <div
        className="player-video-notes-toolbar"
        role="toolbar"
        aria-label="Markdown 笔记格式"
      >
        {FORMAT_BUTTONS.map(({ action, label, title }) => (
          <button
            key={action}
            type="button"
            title={title}
            aria-label={title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insert(action)}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        ref={editorRef}
        className="player-video-notes-editor"
        value={markdown}
        onChange={(event) => {
          updateMarkdown(event.target.value);
        }}
        onKeyDown={(event) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          const key = event.key.toLowerCase();
          const shortcut: Partial<Record<string, FormatAction>> = {
            b: 'bold',
            i: 'italic',
            k: 'link',
          };
          const action = shortcut[key];
          if (!action) return;
          event.preventDefault();
          insert(action);
        }}
        placeholder={
          document
            ? '直接编辑字幕稿，也可以在末尾添加观看笔记。使用工具栏插入格式或播放时间。'
            : '记录要点、问题或行动项…\n\n使用工具栏插入标题、列表、待办和时间戳。'
        }
        spellCheck
      />
      <footer className="player-video-notes-footer">
        <span>{saveStatus}</span>
        <span>Ctrl+B 加粗 · Ctrl+I 斜体 · Ctrl+K 链接</span>
      </footer>
    </section>
  );
}
