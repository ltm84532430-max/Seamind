import { useMemo, useState } from 'react';
import type { MapDocument } from './library';
import { groupKnowledgeNotes, UNFILED_FOLDER } from './knowledge-notes';
import DocumentWorkbench, {
  type DocumentWorkbenchProps,
} from './workbench/DocumentWorkbench';
import type { ActiveDocument } from './workbench/active-document';
import './knowledge-workspace.css';

export interface KnowledgeWorkspaceProps {
  documents: MapDocument[];
  activeDocument: ActiveDocument | null;
  onOpenNote(note: MapDocument): void;
  onCreateNote(folder: string): void;
  onDeleteNote(note: MapDocument): void;
  workbench: Omit<DocumentWorkbenchProps, 'document'>;
}

/**
 * The knowledge base page: the library's Markdown notes grouped by folder, beside the document
 * workbench that edits and previews the open note.
 */
export default function KnowledgeWorkspace({
  documents,
  activeDocument,
  onOpenNote,
  onCreateNote,
  onDeleteNote,
  workbench,
}: KnowledgeWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState(UNFILED_FOLDER);
  const groups = useMemo(
    () => groupKnowledgeNotes(documents, query),
    [documents, query],
  );
  const noteCount = groups.reduce(
    (total, group) => total + group.notes.length,
    0,
  );

  return (
    <div className="knowledge-workspace">
      <aside className="knowledge-list" aria-label="笔记列表">
        <div className="knowledge-list-head">
          <strong>知识库</strong>
          <span>{noteCount} 篇笔记</span>
        </div>
        <div className="knowledge-list-tools">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、路径或文件夹"
            aria-label="搜索笔记"
          />
          <button type="button" onClick={() => onCreateNote(folder)}>
            新建笔记
          </button>
        </div>
        <p className="knowledge-target">新建到：{folder}</p>
        <div className="knowledge-groups">
          {groups.map((group) => (
            <section className="knowledge-group" key={group.name}>
              <button
                type="button"
                className={`knowledge-folder${folder === group.name ? ' is-target' : ''}`}
                aria-pressed={folder === group.name}
                onClick={() => setFolder(group.name)}
              >
                <span>{group.name}</span>
                <em>{group.notes.length}</em>
              </button>
              {group.notes.map((note) => (
                <div
                  className={`knowledge-note${activeDocument?.relativePath === note.relativePath ? ' is-active' : ''}`}
                  key={note.relativePath}
                >
                  <button
                    type="button"
                    className="knowledge-note-open"
                    title={note.relativePath}
                    onClick={() => onOpenNote(note)}
                  >
                    {note.title}
                  </button>
                  <button
                    type="button"
                    className="knowledge-note-delete"
                    aria-label={`删除笔记 ${note.title}`}
                    onClick={() => onDeleteNote(note)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </section>
          ))}
          {groups.length === 0 && (
            <p className="knowledge-empty">
              {query.trim()
                ? '没有匹配的笔记。'
                : '还没有笔记，点击「新建笔记」开始。'}
            </p>
          )}
        </div>
      </aside>
      <div className="knowledge-editor">
        {activeDocument?.kind === 'doc' ? (
          <DocumentWorkbench document={activeDocument} {...workbench} />
        ) : (
          <div className="knowledge-placeholder">
            <p>选择左侧的笔记，或新建一篇笔记。</p>
            <p>
              支持行内公式 <code>$E=mc^2$</code> 和块级公式 <code>$$…$$</code>
              ，思维导图中也会渲染。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
