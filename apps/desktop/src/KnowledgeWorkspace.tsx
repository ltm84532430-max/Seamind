import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { MapDocument } from './library';
import { groupKnowledgeNotes, UNFILED_FOLDER } from './knowledge-notes';
import DocumentWorkbench, {
  type DocumentWorkbenchProps,
} from './workbench/DocumentWorkbench';
import type { ActiveDocument } from './workbench/active-document';
import { formatRelativeDate } from './knowledge-completions';
import {
  KNOWLEDGE_NOTE_TEMPLATES,
  type KnowledgeNoteTemplate,
} from './knowledge-markdown';
import './knowledge-workspace.css';

export interface KnowledgeWorkspaceProps {
  rootPath: string | null;
  documents: MapDocument[];
  categories: string[];
  activeDocument: ActiveDocument | null;
  errorMessage?: string;
  busy?: boolean;
  onChooseRoot(): void;
  onRefresh(): void;
  onCreateCategory(category: string): Promise<boolean>;
  onOpenNote(note: MapDocument): void;
  onCloseNote?(): void;
  onCreateNote(folder: string, template?: KnowledgeNoteTemplate): void;
  onDeleteNote(note: MapDocument): void;
  workbench: Omit<DocumentWorkbenchProps, 'document'>;
}

const COLLAPSED_STORAGE_KEY = 'seamind.knowledge.collapsedFolders';
const SIDEBAR_WIDTH_STORAGE_KEY = 'seamind.knowledge.sidebarWidth';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'seamind.knowledge.sidebarCollapsed';
const DEFAULT_SIDEBAR_WIDTH = 264;
const MIN_SIDEBAR_WIDTH = 210;
const MAX_SIDEBAR_WIDTH = 440;

function readCollapsedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function writeCollapsedFolders(folders: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...folders]));
  } catch {
    // Ignore storage errors
  }
}

function clampSidebarWidth(value: number): number {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, Math.round(value)),
  );
}

function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_SIDEBAR_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed)
      : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Ignore storage errors
  }
}

function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Ignore storage errors
  }
}

function FolderIcon() {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.9l1.3 1.5h5.4A1.2 1.2 0 0 1 14 5.7v6.1a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V4.2Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.9l1.3 1.5h5.4A1.2 1.2 0 0 1 14 5.7v6.1a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V4.2Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M8 7v3.6M6.2 8.8h3.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.5 2.5h6.3L12.5 5.2v8.3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 2.6v2.8h2.8M5.2 8h5.6M5.2 10.6h3.8"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronRightIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`kb-svg-icon kb-chevron${expanded ? ' is-expanded' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6 4.2 9.8 8 6 11.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4.5 6.3 8 9.8l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 3.2v9.6M3.2 8h9.6"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      className="kb-svg-icon kb-search-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="7.1"
        cy="7.1"
        r="4.3"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="m10.3 10.3 3 3"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="2"
        y="2.5"
        width="12"
        height="11"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path d="M6.2 2.5v11" stroke="currentColor" strokeWidth="1.35" />
      <path
        d={collapsed ? 'm8.8 6.2 1.8 1.8-1.8 1.8' : 'M10.6 6.2 8.8 8l1.8 1.8'}
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CollapseTreeIcon({ allCollapsed }: { allCollapsed: boolean }) {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      {allCollapsed ? (
        <path
          d="m5.2 6 2.8-2.6L10.8 6M5.2 10l2.8 2.6L10.8 10"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="m5.2 3.6 2.8 2.6 2.8-2.6M5.2 12.4 8 9.8l2.8 2.6"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 4.5h10M6.2 4.5V3.2c0-.4.3-.7.7-.7h2.2c.4 0 .7.3.7.7v1.3M4.4 4.5l.5 8.1c0 .6.5 1.1 1.1 1.1h4c.6 0 1.1-.5 1.1-1.1l.5-8.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12.8 5.8A5.1 5.1 0 1 0 13 9.6M13 3.2v2.8h-2.8"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HomeOverviewIcon() {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="2.2"
        y="2.5"
        width="5"
        height="5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <rect
        x="8.8"
        y="2.5"
        width="5"
        height="5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <rect
        x="2.2"
        y="9"
        width="5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <rect
        x="8.8"
        y="9"
        width="5"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.35"
      />
    </svg>
  );
}

/**
 * Clean, architectural Knowledge Base workspace aligned with SeaMind's editorial visual language.
 */
export default function KnowledgeWorkspace({
  rootPath,
  documents,
  categories,
  activeDocument,
  errorMessage,
  busy = false,
  onChooseRoot,
  onRefresh,
  onCreateCategory,
  onOpenNote,
  onCloseNote,
  onCreateNote,
  onDeleteNote,
  workbench,
}: KnowledgeWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [activeFolder, setActiveFolder] = useState(UNFILED_FOLDER);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() =>
    readCollapsedFolders(),
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readSidebarWidth(),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    readSidebarCollapsed(),
  );
  const [isResizing, setIsResizing] = useState(false);
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(
    null,
  );
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [categoryInput, setCategoryInput] = useState('');
  const [categorySubmitting, setCategorySubmitting] = useState(false);

  const splitMenuRef = useRef<HTMLDivElement>(null);
  const categoryInputRef = useRef<HTMLInputElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    latestWidth: number;
  } | null>(null);

  const docNotes = useMemo(
    () =>
      documents
        .filter((doc) => doc.kind === 'doc')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [documents],
  );

  const groups = useMemo(
    () => groupKnowledgeNotes(documents, query, categories),
    [documents, query, categories],
  );

  const allFolderNames = useMemo(() => {
    const names = new Set<string>([UNFILED_FOLDER]);
    for (const raw of categories) {
      const clean = raw.trim();
      if (clean) names.add(clean);
    }
    for (const note of docNotes) {
      const clean = note.category.trim();
      if (clean) names.add(clean);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [categories, docNotes]);

  const effectiveFolder = useMemo(() => {
    if (allFolderNames.includes(activeFolder)) return activeFolder;
    if (activeDocument?.kind === 'doc' && activeDocument.category.trim()) {
      return activeDocument.category.trim();
    }
    return UNFILED_FOLDER;
  }, [activeDocument, activeFolder, allFolderNames]);

  useEffect(() => {
    if (activeDocument?.kind === 'doc') {
      const folder = activeDocument.category.trim() || UNFILED_FOLDER;
      setActiveFolder(folder);
    }
  }, [
    activeDocument?.relativePath,
    activeDocument?.category,
    activeDocument?.kind,
  ]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of docNotes) {
      for (const rawTag of note.tags ?? []) {
        const tag = rawTag.trim();
        if (!tag) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'),
    );
  }, [docNotes]);

  const visibleNoteCount = useMemo(
    () => groups.reduce((sum, group) => sum + group.notes.length, 0),
    [groups],
  );

  // Dismiss template menu on outside click or Escape
  useEffect(() => {
    if (!templateMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        splitMenuRef.current &&
        !splitMenuRef.current.contains(event.target as Node)
      ) {
        setTemplateMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTemplateMenuOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [templateMenuOpen]);

  useEffect(() => {
    if (creatingCategory) {
      window.requestAnimationFrame(() => categoryInputRef.current?.focus());
    }
  }, [creatingCategory]);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  }, []);

  const toggleFolder = useCallback((folderName: string) => {
    setActiveFolder(folderName);
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderName)) next.delete(folderName);
      else next.add(folderName);
      writeCollapsedFolders(next);
      return next;
    });
  }, []);

  const toggleAllFolders = useCallback(() => {
    setCollapsedFolders((prev) => {
      const next =
        prev.size > 0 ? new Set<string>() : new Set(groups.map((g) => g.name));
      writeCollapsedFolders(next);
      return next;
    });
  }, [groups]);

  const openCategoryCreator = useCallback(() => {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      writeSidebarCollapsed(false);
    }
    setCreatingCategory(true);
  }, [sidebarCollapsed]);

  const submitCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = categoryInput
      .trim()
      .replaceAll('\\', '/')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
      .join('/');
    if (!clean || categorySubmitting) return;
    setCategorySubmitting(true);
    try {
      const created = await onCreateCategory(clean);
      if (created) {
        setActiveFolder(clean);
        setCollapsedFolders((prev) => {
          if (!prev.has(clean)) return prev;
          const next = new Set(prev);
          next.delete(clean);
          writeCollapsedFolders(next);
          return next;
        });
        setCategoryInput('');
        setCreatingCategory(false);
      }
    } finally {
      setCategorySubmitting(false);
    }
  };

  // Pointer-capture resize handlers with zero stale closures
  const handleResizerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: sidebarWidth,
        latestWidth: sidebarWidth,
      };
      setIsResizing(true);
    },
    [sidebarWidth],
  );

  const handleResizerPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const nextWidth = clampSidebarWidth(
        drag.startWidth + (event.clientX - drag.startX),
      );
      drag.latestWidth = nextWidth;
      setSidebarWidth(nextWidth);
    },
    [],
  );

  const finishResize = useCallback((pointerId: number) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragStateRef.current = null;
    setIsResizing(false);
    persistSidebarWidth(drag.latestWidth);
  }, []);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    persistSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }, []);

  const isDocOpen = activeDocument?.kind === 'doc';

  return (
    <div
      className={`knowledge-workspace${isResizing ? ' is-resizing' : ''}${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}
      style={{
        gridTemplateColumns: sidebarCollapsed
          ? '42px minmax(0, 1fr)'
          : `${sidebarWidth}px minmax(0, 1fr)`,
      }}
    >
      {sidebarCollapsed ? (
        <aside className="knowledge-rail" aria-label="已收起的知识库侧栏">
          <div className="knowledge-rail-top">
            <button
              type="button"
              className="kb-icon-btn"
              title="展开知识库目录"
              aria-label="展开知识库目录"
              onClick={toggleSidebarCollapsed}
            >
              <SidebarToggleIcon collapsed />
            </button>
          </div>
          <div className="knowledge-rail-actions">
            <button
              type="button"
              className="kb-icon-btn"
              title={
                rootPath
                  ? `在「${effectiveFolder}」中新建笔记`
                  : '请先选择文件库目录'
              }
              aria-label="新建笔记"
              disabled={!rootPath}
              onClick={() => onCreateNote(effectiveFolder)}
            >
              <PlusIcon />
            </button>
            {isDocOpen && onCloseNote && (
              <button
                type="button"
                className="kb-icon-btn"
                title="返回知识库概览"
                aria-label="返回知识库概览"
                onClick={onCloseNote}
              >
                <HomeOverviewIcon />
              </button>
            )}
          </div>
          <span
            className="knowledge-rail-count"
            title={`共 ${docNotes.length} 篇笔记`}
          >
            {docNotes.length}
          </span>
        </aside>
      ) : (
        <aside className="knowledge-sidebar" aria-label="知识库笔记导航">
          <header className="knowledge-sidebar-head">
            <div className="knowledge-sidebar-title">
              <strong>知识库</strong>
              <span className="knowledge-count-pill">
                {query.trim()
                  ? `${visibleNoteCount}/${docNotes.length}`
                  : docNotes.length}
              </span>
            </div>
            <div className="knowledge-head-tools">
              {isDocOpen && onCloseNote && (
                <button
                  type="button"
                  className="kb-icon-btn"
                  title="返回知识库概览与模板页"
                  aria-label="返回知识库概览"
                  onClick={onCloseNote}
                >
                  <HomeOverviewIcon />
                </button>
              )}
              <button
                type="button"
                className="kb-icon-btn"
                title={
                  collapsedFolders.size > 0 ? '展开全部目录' : '折叠全部目录'
                }
                aria-label="展开或折叠全部目录"
                onClick={toggleAllFolders}
              >
                <CollapseTreeIcon allCollapsed={collapsedFolders.size > 0} />
              </button>
              <button
                type="button"
                className="kb-icon-btn"
                title="收起侧边栏"
                aria-label="收起侧边栏"
                onClick={toggleSidebarCollapsed}
              >
                <SidebarToggleIcon collapsed={false} />
              </button>
            </div>
          </header>

          {errorMessage && (
            <div className="knowledge-error-banner" role="alert">
              {errorMessage}
            </div>
          )}

          {rootPath && (
            <div className="knowledge-toolbar">
              <div className="knowledge-action-row">
                <div className="knowledge-new-split" ref={splitMenuRef}>
                  <button
                    type="button"
                    className="knowledge-new-main"
                    title={`在「${effectiveFolder}」中新建空白笔记`}
                    onClick={() => onCreateNote(effectiveFolder)}
                  >
                    <PlusIcon />
                    <span>新建笔记</span>
                  </button>
                  <button
                    type="button"
                    className="knowledge-new-caret"
                    title="从模板新建笔记"
                    aria-label="选择笔记模板"
                    aria-expanded={templateMenuOpen}
                    onClick={() => setTemplateMenuOpen((open) => !open)}
                  >
                    <ChevronDownIcon />
                  </button>

                  {templateMenuOpen && (
                    <div
                      className="knowledge-template-menu"
                      role="menu"
                      aria-label="新建笔记模板"
                    >
                      <div className="knowledge-template-menu-head">
                        目标分类：{effectiveFolder}
                      </div>
                      {KNOWLEDGE_NOTE_TEMPLATES.map((template) => (
                        <button
                          key={template.id}
                          type="button"
                          role="menuitem"
                          className="knowledge-template-option"
                          onClick={() => {
                            setTemplateMenuOpen(false);
                            onCreateNote(effectiveFolder, template);
                          }}
                        >
                          <strong>{template.label}</strong>
                          <span>{template.description}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className={`knowledge-secondary-btn${creatingCategory ? ' is-active' : ''}`}
                  title="新建分类文件夹"
                  aria-label="新建分类文件夹"
                  onClick={() => setCreatingCategory((open) => !open)}
                >
                  <FolderPlusIcon />
                  <span>分类</span>
                </button>
              </div>

              {creatingCategory && (
                <form
                  className="knowledge-category-form"
                  onSubmit={(event) => void submitCategory(event)}
                >
                  <input
                    ref={categoryInputRef}
                    type="text"
                    value={categoryInput}
                    maxLength={80}
                    placeholder="分类名，支持 多级/子目录"
                    aria-label="新分类名称"
                    disabled={categorySubmitting}
                    onChange={(event) => setCategoryInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setCreatingCategory(false);
                        setCategoryInput('');
                      }
                    }}
                  />
                  <div className="knowledge-category-form-actions">
                    <button
                      type="submit"
                      className="kb-mini-btn is-primary"
                      disabled={!categoryInput.trim() || categorySubmitting}
                    >
                      创建
                    </button>
                    <button
                      type="button"
                      className="kb-mini-btn"
                      onClick={() => {
                        setCreatingCategory(false);
                        setCategoryInput('');
                      }}
                    >
                      取消
                    </button>
                  </div>
                </form>
              )}

              <div className="knowledge-search-box">
                <SearchIcon />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索标题、路径或 #标签…"
                  aria-label="搜索知识库笔记"
                />
                {query && (
                  <button
                    type="button"
                    className="knowledge-search-clear"
                    aria-label="清除搜索条件"
                    onClick={() => setQuery('')}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="knowledge-groups">
            {!rootPath ? (
              <div className="knowledge-sidebar-empty">
                <p>尚未绑定本地文件库目录。</p>
                <button
                  type="button"
                  className="knowledge-secondary-btn"
                  disabled={busy}
                  onClick={onChooseRoot}
                >
                  <FolderIcon />
                  <span>选择目录</span>
                </button>
              </div>
            ) : (
              <>
                {groups.map((group) => {
                  const isCollapsed = collapsedFolders.has(group.name);
                  const isSelected = effectiveFolder === group.name;

                  return (
                    <section
                      className={`knowledge-group${isCollapsed ? ' is-collapsed' : ''}`}
                      key={group.name}
                    >
                      <div
                        className={`knowledge-folder-row${isSelected ? ' is-selected' : ''}`}
                      >
                        <button
                          type="button"
                          className="knowledge-folder-toggle"
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleFolder(group.name)}
                        >
                          <ChevronRightIcon expanded={!isCollapsed} />
                          <FolderIcon />
                          <span className="knowledge-folder-name">
                            {group.name}
                          </span>
                          <span className="knowledge-folder-count">
                            {group.notes.length}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="knowledge-folder-add"
                          title={`在「${group.name}」中新建笔记`}
                          aria-label={`在 ${group.name} 中新建笔记`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveFolder(group.name);
                            if (collapsedFolders.has(group.name)) {
                              setCollapsedFolders((prev) => {
                                const next = new Set(prev);
                                next.delete(group.name);
                                writeCollapsedFolders(next);
                                return next;
                              });
                            }
                            onCreateNote(group.name);
                          }}
                        >
                          <PlusIcon />
                        </button>
                      </div>

                      {!isCollapsed && (
                        <div className="knowledge-folder-notes">
                          {group.notes.length === 0 ? (
                            <div className="knowledge-folder-empty">
                              <span>空分类</span>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveFolder(group.name);
                                  onCreateNote(group.name);
                                }}
                              >
                                新建首篇
                              </button>
                            </div>
                          ) : (
                            group.notes.map((note) => {
                              const isActive =
                                activeDocument?.relativePath ===
                                note.relativePath;
                              const isDeleting =
                                pendingDeletePath === note.relativePath;

                              return (
                                <div
                                  className={`knowledge-note-row${isActive ? ' is-active' : ''}${isDeleting ? ' is-confirming' : ''}`}
                                  key={note.relativePath}
                                >
                                  <button
                                    type="button"
                                    className="knowledge-note-main"
                                    title={`${note.title}\n${note.relativePath}`}
                                    onClick={() => onOpenNote(note)}
                                  >
                                    <div className="knowledge-note-line">
                                      <NoteIcon />
                                      <strong className="knowledge-note-title">
                                        {note.title}
                                      </strong>
                                    </div>
                                    <div className="knowledge-note-sub">
                                      {note.updatedAt > 0 && (
                                        <span className="knowledge-note-date">
                                          {formatRelativeDate(note.updatedAt)}
                                        </span>
                                      )}
                                      {note.tags && note.tags.length > 0 && (
                                        <span className="knowledge-note-tags">
                                          {note.tags.slice(0, 2).map((tag) => (
                                            <span
                                              key={tag}
                                              className="knowledge-tag-chip"
                                            >
                                              #{tag}
                                            </span>
                                          ))}
                                          {note.tags.length > 2 && (
                                            <span className="knowledge-tag-overflow">
                                              +{note.tags.length - 2}
                                            </span>
                                          )}
                                        </span>
                                      )}
                                    </div>
                                  </button>

                                  <div className="knowledge-note-actions">
                                    {isDeleting ? (
                                      <div className="knowledge-delete-bar">
                                        <button
                                          type="button"
                                          className="knowledge-delete-confirm-btn"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setPendingDeletePath(null);
                                            onDeleteNote(note);
                                          }}
                                        >
                                          删除
                                        </button>
                                        <button
                                          type="button"
                                          className="knowledge-delete-cancel-btn"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setPendingDeletePath(null);
                                          }}
                                        >
                                          取消
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        className="knowledge-note-trash"
                                        title={`删除「${note.title}」`}
                                        aria-label={`删除笔记 ${note.title}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setPendingDeletePath(
                                            note.relativePath,
                                          );
                                        }}
                                      >
                                        <TrashIcon />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}

                {groups.length === 0 && (
                  <div className="knowledge-sidebar-empty">
                    <p>
                      {query.trim()
                        ? '没有匹配的笔记或分类'
                        : '暂无 Markdown 笔记，点击上方「新建笔记」开始记录'}
                    </p>
                    {query.trim() && (
                      <button
                        type="button"
                        className="kb-mini-btn"
                        onClick={() => setQuery('')}
                      >
                        清除筛选
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div
            className="knowledge-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖拽调整知识库侧边栏宽度"
            title="拖拽调节宽度，双击恢复默认宽度"
            onPointerDown={handleResizerPointerDown}
            onPointerMove={handleResizerPointerMove}
            onPointerUp={(event) => finishResize(event.pointerId)}
            onPointerCancel={(event) => finishResize(event.pointerId)}
            onLostPointerCapture={(event) => finishResize(event.pointerId)}
            onDoubleClick={resetSidebarWidth}
          />
        </aside>
      )}

      <main className="knowledge-main">
        {isDocOpen && activeDocument ? (
          <DocumentWorkbench
            document={activeDocument}
            documents={documents}
            categories={categories}
            {...workbench}
          />
        ) : !rootPath ? (
          <div className="knowledge-setup">
            <div className="knowledge-setup-card">
              <span className="knowledge-kicker">LIBRARY SETUP</span>
              <h2>选择本地文件夹作为知识库</h2>
              <p>
                知识库中的所有笔记、多级分类与双链引用均以标准 Markdown
                文件直接保存在本机目录中，随时可用任意编辑器检视与备份。
              </p>
              <div className="knowledge-setup-actions">
                <button
                  type="button"
                  className="knowledge-cta-btn"
                  disabled={busy}
                  onClick={onChooseRoot}
                >
                  <FolderIcon />
                  <span>{busy ? '正在载入…' : '选择文件库目录'}</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="knowledge-home">
            <div className="knowledge-home-inner">
              <header className="knowledge-home-header">
                <div className="knowledge-home-heading">
                  <div className="knowledge-kicker-row">
                    <span className="knowledge-kicker">KNOWLEDGE BASE</span>
                    <span className="knowledge-root-path" title={rootPath}>
                      {rootPath}
                    </span>
                  </div>
                  <h2>知识库概览</h2>
                  <div className="knowledge-metrics-strip">
                    <span>
                      <strong>{docNotes.length}</strong> 篇笔记
                    </span>
                    <i aria-hidden="true">·</i>
                    <span>
                      <strong>{allFolderNames.length}</strong> 个分类
                    </span>
                    <i aria-hidden="true">·</i>
                    <span>
                      <strong>{tagCounts.length}</strong> 个标签
                    </span>
                    <i aria-hidden="true">·</i>
                    <span className="knowledge-target-hint">
                      当前新建目录：<strong>{effectiveFolder}</strong>
                    </span>
                  </div>
                </div>

                <div className="knowledge-home-actions">
                  <button
                    type="button"
                    className="knowledge-secondary-btn"
                    disabled={busy}
                    title="重新扫描本地知识库目录"
                    onClick={onRefresh}
                  >
                    <RefreshIcon />
                    <span>刷新</span>
                  </button>
                  <button
                    type="button"
                    className="knowledge-secondary-btn"
                    onClick={openCategoryCreator}
                  >
                    <FolderPlusIcon />
                    <span>新建分类</span>
                  </button>
                  <button
                    type="button"
                    className="knowledge-cta-btn"
                    onClick={() => onCreateNote(effectiveFolder)}
                  >
                    <PlusIcon />
                    <span>新建笔记</span>
                  </button>
                </div>
              </header>

              <div className="knowledge-home-grid">
                <section
                  className="knowledge-home-panel"
                  aria-label="最近编辑的笔记"
                >
                  <div className="knowledge-panel-head">
                    <h3>最近编辑</h3>
                    <span>
                      {docNotes.length > 0
                        ? `按更新时间排序 · 共 ${docNotes.length} 篇`
                        : '尚无笔记'}
                    </span>
                  </div>

                  {docNotes.length === 0 ? (
                    <div className="knowledge-recent-empty">
                      <p>
                        当前目录尚无 Markdown
                        笔记。可直接新建空白笔记，或从右侧结构化模板起笔。
                      </p>
                      <button
                        type="button"
                        className="knowledge-secondary-btn"
                        onClick={() => onCreateNote(effectiveFolder)}
                      >
                        <PlusIcon />
                        <span>创建第一篇笔记</span>
                      </button>
                    </div>
                  ) : (
                    <div className="knowledge-recent-list">
                      {docNotes.slice(0, 8).map((note) => (
                        <button
                          key={note.relativePath}
                          type="button"
                          className="knowledge-recent-item"
                          onClick={() => onOpenNote(note)}
                        >
                          <NoteIcon />
                          <div className="knowledge-recent-body">
                            <strong>{note.title}</strong>
                            <div className="knowledge-recent-meta">
                              <span className="knowledge-recent-folder">
                                {note.category || UNFILED_FOLDER}
                              </span>
                              {note.tags?.slice(0, 2).map((tag) => (
                                <span key={tag} className="knowledge-tag-chip">
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          </div>
                          <time className="knowledge-recent-time">
                            {formatRelativeDate(note.updatedAt)}
                          </time>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <div className="knowledge-home-side">
                  <section
                    className="knowledge-home-panel"
                    aria-label="从模板新建"
                  >
                    <div className="knowledge-panel-head">
                      <h3>结构化模板</h3>
                      <span>新建至「{effectiveFolder}」</span>
                    </div>
                    <div className="knowledge-template-list">
                      {KNOWLEDGE_NOTE_TEMPLATES.map((template) => (
                        <button
                          key={template.id}
                          type="button"
                          className="knowledge-template-card"
                          onClick={() =>
                            onCreateNote(effectiveFolder, template)
                          }
                        >
                          <div className="knowledge-template-card-top">
                            <strong>{template.label}</strong>
                            <span aria-hidden="true">→</span>
                          </div>
                          <p>{template.description}</p>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section
                    className="knowledge-home-panel"
                    aria-label="分类与标签索引"
                  >
                    <div className="knowledge-panel-head">
                      <h3>分类与标签</h3>
                      <span>点击设为目标或快速检索</span>
                    </div>

                    <div className="knowledge-chip-cloud">
                      {allFolderNames.map((folder) => (
                        <button
                          key={folder}
                          type="button"
                          className={`knowledge-filter-chip${effectiveFolder === folder ? ' is-selected' : ''}`}
                          title={`将新建目录切换为「${folder}」`}
                          onClick={() => {
                            setActiveFolder(folder);
                            if (sidebarCollapsed) {
                              setSidebarCollapsed(false);
                              writeSidebarCollapsed(false);
                            }
                            setCollapsedFolders((prev) => {
                              if (!prev.has(folder)) return prev;
                              const next = new Set(prev);
                              next.delete(folder);
                              writeCollapsedFolders(next);
                              return next;
                            });
                          }}
                        >
                          <FolderIcon />
                          <span>{folder}</span>
                        </button>
                      ))}

                      {tagCounts.slice(0, 12).map(([tag, count]) => (
                        <button
                          key={tag}
                          type="button"
                          className={`knowledge-filter-chip is-tag${query === `#${tag}` ? ' is-selected' : ''}`}
                          title={`筛选带有 #${tag} 的笔记`}
                          onClick={() => {
                            if (sidebarCollapsed) {
                              setSidebarCollapsed(false);
                              writeSidebarCollapsed(false);
                            }
                            setQuery((prev) =>
                              prev === `#${tag}` ? '' : `#${tag}`,
                            );
                          }}
                        >
                          <span>#{tag}</span>
                          <em>{count}</em>
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              </div>

              <footer
                className="knowledge-syntax-bar"
                aria-label="编辑器快捷语法提示"
              >
                <span>
                  <kbd>[[</kbd> 双链引用与新建
                </span>
                <span>
                  <kbd>/</kbd> 行首快捷块
                </span>
                <span>
                  <kbd>$</kbd> / <kbd>\</kbd> KaTeX 公式补全
                </span>
                <span>
                  <kbd>#</kbd> 标签聚合
                </span>
                <span>
                  <kbd>Ctrl+S</kbd> 立即保存
                </span>
              </footer>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
