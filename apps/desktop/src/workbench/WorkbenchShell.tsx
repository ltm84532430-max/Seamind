import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import './workbench.css';

/** How the panes of a document sit next to each other. Each kind picks the one that suits it. */
export type WorkbenchLayout = 'source-canvas' | 'source-preview-outline';

export interface WorkbenchShellProps {
  /** Short file-type tag next to the title. */
  badge: string;
  /** Names the workbench for assistive technology. */
  label: string;
  title: string;
  path: string;
  dirty: boolean;
  statusText: string;
  /** Optional inline metadata controls shown beside the title (e.g. category & tags). */
  meta?: ReactNode;
  /** Shown at the right end of the status line, e.g. the size of the source. */
  summary?: string;
  layout: WorkbenchLayout;
  /** Buttons that belong to this kind of document, shown at the right of the header. */
  actions?: ReactNode;
  onSave(): void;
  onRename(title: string): Promise<boolean>;
  children: ReactNode;
}

function TitleField({
  title,
  onRename,
}: {
  title: string;
  onRename(title: string): Promise<boolean>;
}) {
  const [draft, setDraft] = useState(title);
  const cancelledRef = useRef(false);

  useEffect(() => setDraft(title), [title]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    const next = draft.trim();
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    void onRename(next).then((renamed) => {
      if (!renamed) setDraft(title);
    });
  };

  return (
    <input
      className="workbench-title"
      value={draft}
      maxLength={120}
      spellCheck={false}
      aria-label="标题（改名会同时改文件名）"
      title="点击修改标题（同时重命名文件）"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          cancelledRef.current = true;
          setDraft(title);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * The frame every document kind shares: a 52px header aligned with the sidebar, the panes in the
 * chosen layout, and a quiet status line.
 */
export default function WorkbenchShell({
  badge,
  label,
  title,
  path,
  dirty,
  statusText,
  meta,
  summary,
  layout,
  actions,
  onSave,
  onRename,
  children,
}: WorkbenchShellProps) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key.toLowerCase() === 's'
    ) {
      event.preventDefault();
      onSave();
    }
  };

  return (
    <section
      className="document-workbench"
      aria-label={label}
      data-layout={layout}
      onKeyDown={onKeyDown}
    >
      <header className="workbench-header">
        <span className="workbench-badge">{badge}</span>
        <TitleField title={title} onRename={onRename} />
        <i
          className={`workbench-dirty${dirty ? ' is-dirty' : ''}`}
          title={dirty ? '有未保存的修改' : '已保存'}
          role="img"
          aria-label={dirty ? '有未保存的修改' : '已保存'}
        />
        {meta ? (
          <div className="workbench-meta-bar">{meta}</div>
        ) : (
          <span className="workbench-path" title={path}>
            {path}
          </span>
        )}
        <div className="workbench-actions">{actions}</div>
      </header>
      <div className="workbench-body">
        <div className="workbench-panes">{children}</div>
      </div>
      <footer className="workbench-status">
        <span>{statusText}</span>
        <span className="workbench-status-right">
          <span className="workbench-status-path" title={path}>
            {path}
          </span>
          {summary && <span>{summary}</span>}
        </span>
      </footer>
    </section>
  );
}
