import { useEffect, useMemo, useState } from 'react';
import type { Theme } from '../app/app-storage';
import { isInternalAssetCategory } from '../knowledge/knowledge-notes';
import { libraryApi } from '../library/library-api';
import type {
  LibrarySnapshot,
  MapDocument,
  OpenedDocument,
} from '../library/library';
import MarkdownPreview from '../workbench/MarkdownPreview';

interface CodeLabKnowledgePanelProps {
  active: boolean;
  theme: Theme;
  activeDocumentPath?: string | null;
  renderMarkdownPreview?: (markdown: string) => {
    html: string;
    source: string;
  };
  onOpenDocument?: (document: MapDocument) => void;
}

const MAX_VISIBLE_NOTES = 150;
const LIST_COLLAPSED_KEY = 'seamind:codelab-knowledge-list-collapsed:v1';

function readListCollapsed(): boolean {
  try {
    return localStorage.getItem(LIST_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function noteSelectionKey(rootPath: string): string {
  return `seamind:codelab-knowledge-note:${rootPath}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CodeLabKnowledgePanel({
  active,
  theme,
  activeDocumentPath,
  renderMarkdownPreview,
  onOpenDocument,
}: CodeLabKnowledgePanelProps) {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedDocument | null>(null);
  const [query, setQuery] = useState('');
  const [listBusy, setListBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [listError, setListError] = useState('');
  const [noteError, setNoteError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [listCollapsed, setListCollapsed] = useState(readListCollapsed);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setListBusy(true);
    setListError('');
    void libraryApi.status().then(
      (next) => {
        if (cancelled) return;
        setSnapshot(next);
        const notes = next.documents.filter(
          (document) =>
            document.kind === 'doc' &&
            !isInternalAssetCategory(document.category),
        );
        let savedPath: string | null = null;
        if (next.rootPath) {
          try {
            savedPath = sessionStorage.getItem(noteSelectionKey(next.rootPath));
          } catch {
            // The note chooser still works when session storage is unavailable.
          }
        }
        setSelectedPath((current) => {
          const candidate = [current, savedPath, activeDocumentPath].find(
            (path) => path && notes.some((note) => note.relativePath === path),
          );
          return (
            candidate ??
            notes.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]
              ?.relativePath ??
            null
          );
        });
        setListBusy(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setListError(errorText(error));
        setListBusy(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, activeDocumentPath, refreshKey]);

  useEffect(() => {
    if (!active || !selectedPath) {
      if (!selectedPath) setOpened(null);
      return;
    }
    let cancelled = false;
    setNoteBusy(true);
    setNoteError('');
    void libraryApi.openDocument({ relativePath: selectedPath }).then(
      (document) => {
        if (cancelled) return;
        setOpened(document);
        setNoteBusy(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setOpened(null);
        setNoteError(errorText(error));
        setNoteBusy(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, refreshKey, selectedPath]);

  const notes = useMemo(
    () =>
      (snapshot?.documents ?? [])
        .filter(
          (document) =>
            document.kind === 'doc' &&
            !isInternalAssetCategory(document.category),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [snapshot?.documents],
  );
  const filteredNotes = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return notes;
    return notes.filter((note) =>
      [note.title, note.category, ...note.tags].some((part) =>
        part.toLocaleLowerCase().includes(term),
      ),
    );
  }, [notes, query]);
  const selectedDocument =
    notes.find((note) => note.relativePath === selectedPath) ?? null;
  const rendered = useMemo(() => {
    if (!opened || !renderMarkdownPreview) return null;
    try {
      return renderMarkdownPreview(opened.markdown);
    } catch {
      return null;
    }
  }, [opened, renderMarkdownPreview]);

  const selectNote = (path: string) => {
    setSelectedPath(path);
    if (snapshot?.rootPath) {
      try {
        sessionStorage.setItem(noteSelectionKey(snapshot.rootPath), path);
      } catch {
        // Selection remains available for the current panel lifetime.
      }
    }
  };

  const toggleList = () => {
    const next = !listCollapsed;
    setListCollapsed(next);
    try {
      localStorage.setItem(LIST_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // The current panel still responds when storage is unavailable.
    }
  };

  return (
    <div
      className={`codelab-knowledge-panel${listCollapsed ? ' is-list-collapsed' : ''}`}
    >
      <div className="codelab-knowledge-list" aria-hidden={listCollapsed}>
        <div className="codelab-knowledge-list-head">
          <strong>知识库笔记</strong>
          <button
            type="button"
            onClick={() => setRefreshKey((value) => value + 1)}
            title="刷新知识库"
          >
            ↻
          </button>
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题 / 分类 / 标签"
          aria-label="搜索知识库笔记"
        />
        <div
          className="codelab-knowledge-list-scroll"
          role="listbox"
          aria-label="知识库笔记"
        >
          {listBusy && !snapshot && (
            <div className="codelab-knowledge-empty">正在读取知识库…</div>
          )}
          {listError && (
            <div className="codelab-knowledge-empty is-error">{listError}</div>
          )}
          {!listBusy && !listError && !snapshot?.rootPath && (
            <div className="codelab-knowledge-empty">
              请先在知识库设置文件库目录
            </div>
          )}
          {!listBusy &&
            !listError &&
            snapshot?.rootPath &&
            filteredNotes.length === 0 && (
              <div className="codelab-knowledge-empty">
                {query ? '没有匹配的笔记' : '知识库暂无笔记'}
              </div>
            )}
          {filteredNotes.slice(0, MAX_VISIBLE_NOTES).map((note) => (
            <button
              key={note.relativePath}
              type="button"
              role="option"
              aria-selected={selectedPath === note.relativePath}
              className={`codelab-knowledge-item${selectedPath === note.relativePath ? ' is-active' : ''}`}
              onClick={() => selectNote(note.relativePath)}
              title={`${note.category || '未分类'} / ${note.title}`}
            >
              <span>{note.title}</span>
              <small>{note.category || '未分类'}</small>
            </button>
          ))}
          {filteredNotes.length > MAX_VISIBLE_NOTES && (
            <div className="codelab-knowledge-empty">
              显示前 {MAX_VISIBLE_NOTES} 条，可继续搜索缩小范围
            </div>
          )}
        </div>
      </div>
      <div className="codelab-knowledge-reader">
        <div className="codelab-knowledge-reader-head">
          <button
            type="button"
            className="codelab-knowledge-list-toggle"
            onClick={toggleList}
            aria-label={
              listCollapsed ? '展开笔记目录' : '收起笔记目录，聚焦正文'
            }
            aria-expanded={!listCollapsed}
            title={listCollapsed ? '展开笔记目录' : '收起笔记目录，聚焦正文'}
          >
            {listCollapsed ? '> 目录' : '< 目录'}
          </button>
          <span title={selectedDocument?.title}>
            {selectedDocument?.title ?? '选择一篇笔记'}
          </span>
          {selectedDocument && onOpenDocument && (
            <button
              type="button"
              onClick={() => onOpenDocument(selectedDocument)}
              title="在知识库中打开此笔记"
            >
              打开 ↗
            </button>
          )}
        </div>
        {noteBusy && (
          <div className="codelab-knowledge-reader-message">正在打开笔记…</div>
        )}
        {!noteBusy && noteError && (
          <div className="codelab-knowledge-reader-message is-error">
            {noteError}
          </div>
        )}
        {!noteBusy &&
          !noteError &&
          opened &&
          selectedPath === opened.document.relativePath &&
          (rendered ? (
            <MarkdownPreview
              html={rendered.html}
              source={rendered.source}
              theme={theme}
              hideMinimap
              mediaDocumentPath={opened.document.relativePath}
            />
          ) : (
            <pre className="codelab-knowledge-raw">{opened.markdown}</pre>
          ))}
        {!noteBusy && !noteError && !opened && (
          <div className="codelab-knowledge-reader-message">
            选中笔记后，可在右侧阅读并继续编辑左侧代码。
          </div>
        )}
      </div>
    </div>
  );
}
