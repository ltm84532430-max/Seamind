import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import type {
  EpubBookDocument,
  LibrarySnapshot,
  MapDocument,
  PlantUmlDocument,
} from './library';
import {
  buildLibraryFolderTree,
  type LibraryFolderNode,
} from './library-folder-tree';

export interface LibraryPanelProps {
  snapshot: LibrarySnapshot | null;
  documents: MapDocument[];
  selectedPath: string | null;
  /** The .puml file open in the PlantUML canvas, if any. */
  selectedPlantUmlPath?: string | null;
  collapsed: boolean;
  categoryFilter: string;
  query: string;
  busy: boolean;
  summarizeEpubOnImport: boolean;
  currentMarkdown?: string;
  onSearch: (value: string) => void;
  onChooseRoot: () => void;
  onRefresh: () => void;
  onCreateDocument: () => void;
  onCreateWithAi: () => void;
  onImportEpub: () => void;
  onOpenBook: (book: EpubBookDocument) => void;
  onOpenPlantUmlFile: (file: PlantUmlDocument) => void;
  onDeletePlantUmlFile: (file: PlantUmlDocument) => void;
  onToggleEpubSummary: (enabled: boolean) => void;
  onCreateCategory: () => void;
  onRenameFolder: (path: string, newName: string) => Promise<void>;
  onSelectCategory: (category: string) => void;
  onOpenDocument: (document: MapDocument) => void;
  onDeleteDocument: (document: MapDocument) => void;
  onToggleCollapse: () => void;
  onNavigateToLine?: (lineIndex: number) => void;
}

export interface OutlineItem {
  lineIndex: number;
  depth: number;
  text: string;
}

function parseMarkdownOutline(markdown: string): OutlineItem[] {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const items: OutlineItem[] = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    // Headings # ~ ######
    const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const cleanText = headingMatch[2]
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_~]/g, '')
        .trim();
      if (cleanText) {
        items.push({ lineIndex: i, depth, text: cleanText });
      }
      continue;
    }

    // Top bullet points when headings are scarce
    const listMatch = rawLine.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const depth = Math.min(6, Math.floor(indent / 2) + 2);
      const cleanText = listMatch[3]
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_~]/g, '')
        .trim();
      if (
        cleanText &&
        !cleanText.startsWith('<!--') &&
        cleanText.length <= 60
      ) {
        items.push({ lineIndex: i, depth, text: cleanText });
      }
    }
  }

  // Fallback to primary list items if no headings were discovered
  if (items.length === 0) {
    let inCodeFallback = false;
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('```')) {
        inCodeFallback = !inCodeFallback;
        continue;
      }
      if (inCodeFallback) continue;
      const listMatch = rawLine.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        const indent = listMatch[1].length;
        const depth = Math.min(6, Math.floor(indent / 2) + 1);
        const cleanText = listMatch[3]
          .replace(/\[(.*?)\]\(.*?\)/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/[*_~]/g, '')
          .trim();
        if (cleanText && !cleanText.startsWith('<!--')) {
          items.push({ lineIndex: i, depth, text: cleanText });
        }
      }
    }
  }

  return items;
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '未知时间';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}天前`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp * 1000));
}

type SortMode = 'updated' | 'title' | 'category';
type DeleteConfirmation =
  | { kind: 'map'; document: MapDocument }
  | { kind: 'plantuml'; document: PlantUmlDocument };
type FolderContextMenu = { path: string; name: string; x: number; y: number };

export default function LibraryPanel({
  snapshot,
  documents,
  selectedPath,
  selectedPlantUmlPath = null,
  collapsed,
  categoryFilter,
  query,
  busy,
  summarizeEpubOnImport,
  currentMarkdown,
  onSearch,
  onChooseRoot,
  onRefresh,
  onCreateDocument,
  onCreateWithAi,
  onImportEpub,
  onOpenBook,
  onOpenPlantUmlFile,
  onDeletePlantUmlFile,
  onToggleEpubSummary,
  onCreateCategory,
  onRenameFolder,
  onSelectCategory,
  onOpenDocument,
  onDeleteDocument,
  onToggleCollapse,
  onNavigateToLine,
}: LibraryPanelProps) {
  const [activeTab, setActiveTab] = useState<'files' | 'outline'>('files');
  const [sortMode, setSortMode] = useState<SortMode>('updated');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] =
    useState<DeleteConfirmation | null>(null);
  const [outlineFilter, setOutlineFilter] = useState('');
  const [folderContextMenu, setFolderContextMenu] =
    useState<FolderContextMenu | null>(null);
  const [renameFolder, setRenameFolder] = useState<Pick<
    FolderContextMenu,
    'path' | 'name'
  > | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renamePending, setRenamePending] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const folderContextMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  // Close create menu when clicking outside
  useEffect(() => {
    if (!createMenuOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    };
    window.addEventListener('click', handleOutsideClick, true);
    return () => window.removeEventListener('click', handleOutsideClick, true);
  }, [createMenuOpen]);

  useEffect(() => {
    if (!folderContextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!folderContextMenuRef.current?.contains(event.target as Node)) {
        setFolderContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFolderContextMenu(null);
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [folderContextMenu]);

  // Reveal the PUML file that was opened: expand its folders and bring its row into view. Only a
  // change of the open file does this, so a later library refresh does not reopen folders the user
  // closed.
  useEffect(() => {
    if (!selectedPlantUmlPath) return undefined;
    const file = snapshot?.plantumlFiles.find(
      (candidate) => candidate.relativePath === selectedPlantUmlPath,
    );
    const folder =
      file?.category ?? selectedPlantUmlPath.split('/').slice(0, -1).join('/');
    const ancestors = folder
      .split('/')
      .filter(Boolean)
      .map((_, index, parts) => parts.slice(0, index + 1).join('/'));
    setCollapsedFolders((previous) =>
      ancestors.some((path) => previous.has(path))
        ? new Set([...previous].filter((path) => !ancestors.includes(path)))
        : previous,
    );
    const frame = window.requestAnimationFrame(() =>
      sidebarRef.current
        ?.querySelector('.library-puml-row.is-selected')
        ?.scrollIntoView({ block: 'nearest' }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [selectedPlantUmlPath]);

  // Root folder label
  const rootName =
    snapshot?.rootPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? '未设置位置';

  // Real-time outline items
  const outlineItems = useMemo(() => {
    return parseMarkdownOutline(currentMarkdown || '');
  }, [currentMarkdown]);

  const filteredOutline = useMemo(() => {
    if (!outlineFilter.trim()) return outlineItems;
    const q = outlineFilter.toLowerCase();
    return outlineItems.filter((item) => item.text.toLowerCase().includes(q));
  }, [outlineItems, outlineFilter]);

  // Sorted documents
  const sortedDocuments = useMemo(() => {
    const list = [...documents];
    if (sortMode === 'updated') {
      return list.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    if (sortMode === 'title') {
      return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    }
    if (sortMode === 'category') {
      return list.sort((a, b) =>
        (a.category || '').localeCompare(b.category || '', 'zh-CN'),
      );
    }
    return list;
  }, [documents, sortMode]);

  const visibleBooks = useMemo(() => {
    const queryText = query.trim().toLocaleLowerCase();
    const categoryText = categoryFilter.trim();
    const list = (snapshot?.books ?? []).filter((book) => {
      const matchesCategory =
        !categoryText ||
        book.category === categoryText ||
        book.category.startsWith(`${categoryText}/`);
      const matchesQuery =
        !queryText ||
        book.title.toLocaleLowerCase().includes(queryText) ||
        book.relativePath.toLocaleLowerCase().includes(queryText);
      return matchesCategory && matchesQuery;
    });
    if (sortMode === 'updated')
      return list.sort((a, b) => b.updatedAt - a.updatedAt);
    if (sortMode === 'title')
      return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    return list.sort((a, b) => a.category.localeCompare(b.category, 'zh-CN'));
  }, [snapshot?.books, categoryFilter, query, sortMode]);

  const visiblePlantUmlFiles = useMemo(() => {
    const queryText = query.trim().toLocaleLowerCase();
    const categoryText = categoryFilter.trim();
    const list = (snapshot?.plantumlFiles ?? []).filter((file) => {
      const matchesCategory =
        !categoryText ||
        file.category === categoryText ||
        file.category.startsWith(`${categoryText}/`);
      const matchesQuery =
        !queryText ||
        file.title.toLocaleLowerCase().includes(queryText) ||
        file.relativePath.toLocaleLowerCase().includes(queryText);
      return matchesCategory && matchesQuery;
    });
    if (sortMode === 'updated')
      return list.sort((a, b) => b.updatedAt - a.updatedAt);
    if (sortMode === 'title')
      return list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    return list.sort((a, b) => a.category.localeCompare(b.category, 'zh-CN'));
  }, [snapshot?.plantumlFiles, categoryFilter, query, sortMode]);

  const folderTree = useMemo(
    () =>
      buildLibraryFolderTree(
        snapshot?.categories ?? [],
        sortedDocuments,
        visibleBooks,
        visiblePlantUmlFiles,
      ),
    [snapshot?.categories, sortedDocuments, visibleBooks, visiblePlantUmlFiles],
  );

  const toggleFolder = (cat: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  const cycleSortMode = () => {
    setSortMode((prev) => {
      if (prev === 'updated') return 'title';
      if (prev === 'title') return 'category';
      return 'updated';
    });
  };

  const sortLabel =
    sortMode === 'updated' ? '最新' : sortMode === 'title' ? '名称' : '分类';

  const submitFolderRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameFolder || renamePending) return;
    const nextName = renameValue.trim();
    if (!nextName) {
      setRenameError('文件夹名称不能为空。');
      return;
    }
    setRenamePending(true);
    setRenameError('');
    try {
      await onRenameFolder(renameFolder.path, nextName);
      const normalizedName = nextName.replace(/\.+$/, '').trimEnd();
      const parent = renameFolder.path.includes('/')
        ? renameFolder.path.slice(0, renameFolder.path.lastIndexOf('/'))
        : '';
      const nextPath = parent ? `${parent}/${normalizedName}` : normalizedName;
      setCollapsedFolders((previous) => {
        const remapped = new Set<string>();
        for (const path of previous) {
          remapped.add(
            path === renameFolder.path
              ? nextPath
              : path.startsWith(`${renameFolder.path}/`)
                ? `${nextPath}${path.slice(renameFolder.path.length)}`
                : path,
          );
        }
        return remapped;
      });
      setRenameFolder(null);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenamePending(false);
    }
  };

  const renderFolder = (folder: LibraryFolderNode) => {
    const isFolderCollapsed = collapsedFolders.has(folder.path);
    const isFiltered = categoryFilter === folder.path;
    const canExpand =
      folder.children.length > 0 ||
      folder.documents.length > 0 ||
      folder.books.length > 0 ||
      folder.plantumlFiles.length > 0;

    return (
      <div className="library-folder-group" key={folder.path}>
        <div
          className={`library-folder-header${isFiltered ? ' is-filtered' : ''}`}
          title={`${folder.path}（${folder.documentCount} 个文件，含子文件夹）`}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!snapshot?.categories.includes(folder.path)) return;
            const menuWidth = 176;
            const menuHeight = 40;
            setFolderContextMenu({
              path: folder.path,
              name: folder.name,
              x: Math.max(
                8,
                Math.min(event.clientX, window.innerWidth - menuWidth - 8),
              ),
              y: Math.max(
                8,
                Math.min(event.clientY, window.innerHeight - menuHeight - 8),
              ),
            });
          }}
        >
          <button
            type="button"
            className={`folder-chevron library-folder-toggle${isFolderCollapsed ? ' is-collapsed' : ''}`}
            aria-label={`${isFolderCollapsed ? '展开' : '收起'}文件夹 ${folder.name}`}
            aria-expanded={!isFolderCollapsed}
            disabled={!canExpand}
            onClick={() => toggleFolder(folder.path)}
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="library-folder-select"
            aria-current={isFiltered ? 'true' : undefined}
            onClick={() => onSelectCategory(isFiltered ? '' : folder.path)}
            title={`筛选文件夹及其子文件夹：${folder.path}`}
          >
            <span className="folder-icon" aria-hidden="true">
              {isFolderCollapsed ? '📁' : '📂'}
            </span>
            <span className="folder-name">{folder.name}</span>
          </button>
          <span className="folder-count" title="包含子文件夹中的文件">
            {folder.documentCount}
          </span>
        </div>

        {!isFolderCollapsed && (
          <div className="library-folder-children">
            {folder.children.map(renderFolder)}
            {folder.documents.map((doc) =>
              renderDocumentRow(doc, selectedPath, onOpenDocument, (document) =>
                setDeleteConfirmation({ kind: 'map', document }),
              ),
            )}
            {folder.books.map((book) => renderEpubRow(book, onOpenBook))}
            {folder.plantumlFiles.map((file) =>
              renderPlantUmlRow(
                file,
                selectedPlantUmlPath,
                onOpenPlantUmlFile,
                (document) =>
                  setDeleteConfirmation({ kind: 'plantuml', document }),
              ),
            )}
            {folder.children.length === 0 &&
              folder.documents.length === 0 &&
              folder.books.length === 0 &&
              folder.plantumlFiles.length === 0 && (
                <div className="folder-empty-hint">暂无文件</div>
              )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      ref={sidebarRef}
      className={`library-sidebar${collapsed ? ' is-collapsed' : ''}`}
      aria-label="思维导图导航与目录"
    >
      {/* 顶栏：Tab 标签页与折叠控制 */}
      <div className="library-header">
        {!collapsed && (
          <div className="library-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'files'}
              className={`library-tab${activeTab === 'files' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('files')}
            >
              <svg viewBox="0 0 16 16" className="tab-icon" aria-hidden="true">
                <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 5H12.5A1.5 1.5 0 0 1 14 6.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-8z" />
              </svg>
              <span>文件库</span>
              <span className="library-tab-badge">
                {documents.length +
                  (snapshot?.books.length ?? 0) +
                  (snapshot?.plantumlFiles.length ?? 0)}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'outline'}
              className={`library-tab${activeTab === 'outline' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('outline')}
            >
              <svg viewBox="0 0 16 16" className="tab-icon" aria-hidden="true">
                <line x1="3" y1="4" x2="6" y2="4" />
                <line x1="8" y1="4" x2="13" y2="4" />
                <line x1="3" y1="8" x2="6" y2="8" />
                <line x1="8" y1="8" x2="13" y2="8" />
                <line x1="3" y1="12" x2="6" y2="12" />
                <line x1="8" y1="12" x2="13" y2="12" />
              </svg>
              <span>大纲</span>
              <span className="library-tab-badge">{outlineItems.length}</span>
            </button>
          </div>
        )}
        <button
          type="button"
          className="pane-collapse-button library-collapse-button"
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-expanded={!collapsed}
          aria-controls="library-content-body"
          onClick={onToggleCollapse}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d={collapsed ? 'M6 3l5 5-5 5' : 'M10 3 5 8l5 5'} />
          </svg>
        </button>
      </div>

      <div className="library-content-body" id="library-content-body">
        {activeTab === 'files' ? (
          <>
            {/* 操作条：新建、阅读 EPUB 与重建索引 */}
            <div className="library-actions-bar">
              <div className="library-new-btn-group" ref={menuRef}>
                <button
                  type="button"
                  className="library-btn-primary"
                  onClick={onCreateDocument}
                  title="新建空白思维导图"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="13"
                    height="13"
                    aria-hidden="true"
                  >
                    <path
                      d="M8 3v10M3 8h10"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                  <span>新建导图</span>
                </button>
                <button
                  type="button"
                  className="library-btn-trigger"
                  aria-expanded={createMenuOpen}
                  aria-label="更多新建选项"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCreateMenuOpen((open) => !open);
                  }}
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="11"
                    height="11"
                    aria-hidden="true"
                  >
                    <path
                      d="M4 6l4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>

                {createMenuOpen && (
                  <div className="library-new-menu" role="menu">
                    <button
                      type="button"
                      className="library-menu-item"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        onCreateDocument();
                      }}
                    >
                      <span className="menu-icon">📄</span>
                      <div>
                        <strong>新建空白思维导图</strong>
                        <small>基于基础 Markdown 模板创建</small>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="library-menu-item"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        onCreateWithAi();
                      }}
                    >
                      <span className="menu-icon">✨</span>
                      <div>
                        <strong>AI 智能构图…</strong>
                        <small>输入主题生成专业思维结构</small>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="library-menu-item"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        onImportEpub();
                      }}
                    >
                      <span className="menu-icon">📖</span>
                      <div>
                        <strong>导入 EPUB 电子书…</strong>
                        <small>自动解析书籍目录树与章节</small>
                      </div>
                    </button>
                    <div className="library-menu-divider" />
                    <button
                      type="button"
                      className="library-menu-item"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        onCreateCategory();
                      }}
                    >
                      <span className="menu-icon">📁</span>
                      <div>
                        <strong>新建分类文件夹…</strong>
                        <small>为导图组织独立分组</small>
                      </div>
                    </button>
                    <label className="library-menu-checkbox">
                      <input
                        type="checkbox"
                        checked={summarizeEpubOnImport}
                        onChange={(e) => onToggleEpubSummary(e.target.checked)}
                      />
                      <span>导入 EPUB 时自动生成 AI 摘要</span>
                    </label>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="library-icon-btn"
                onClick={onRefresh}
                disabled={busy}
                title="扫描文件库并重建索引"
                aria-label="刷新索引"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  className={busy ? 'is-spinning' : ''}
                  aria-hidden="true"
                >
                  <path
                    d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9L13.5 2.5m0 0v4m0-4h-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            {/* 搜索与排序栏 */}
            <div className="library-search-bar">
              <div className="library-search-input-wrap">
                <svg
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  aria-hidden="true"
                >
                  <circle
                    cx="6.5"
                    cy="6.5"
                    r="4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <path
                    d="M9.5 9.5l3.5 3.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => onSearch(e.target.value)}
                  placeholder="搜索标题、内容、标签…"
                  aria-label="搜索思维导图"
                />
                {query && (
                  <button
                    type="button"
                    className="library-search-clear"
                    onClick={() => onSearch('')}
                    aria-label="清空搜索"
                  >
                    ×
                  </button>
                )}
              </div>
              <button
                type="button"
                className="library-sort-btn"
                onClick={cycleSortMode}
                title={`当前排序：${sortLabel}，点击切换`}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  aria-hidden="true"
                >
                  <path
                    d="M4 6l2-2 2 2M6 4v8M12 10l-2 2-2-2M10 12V4"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>{sortLabel}</span>
              </button>
            </div>

            {/* 文件树或搜索结果列表 */}
            <div className="library-tree" role="tree" aria-label="思维导图列表">
              {query ? (
                /* 搜索结果平铺 */
                <div className="library-search-results">
                  <div className="tree-section-title">
                    <span>
                      搜索匹配 (
                      {sortedDocuments.length +
                        visibleBooks.length +
                        visiblePlantUmlFiles.length}
                      )
                    </span>
                  </div>
                  {visibleBooks.map((book) => renderEpubRow(book, onOpenBook))}
                  {visiblePlantUmlFiles.map((file) =>
                    renderPlantUmlRow(
                      file,
                      selectedPlantUmlPath,
                      onOpenPlantUmlFile,
                      (document) =>
                        setDeleteConfirmation({ kind: 'plantuml', document }),
                    ),
                  )}
                  {sortedDocuments.map((doc) =>
                    renderDocumentRow(
                      doc,
                      selectedPath,
                      onOpenDocument,
                      (document) =>
                        setDeleteConfirmation({ kind: 'map', document }),
                    ),
                  )}
                  {sortedDocuments.length === 0 &&
                    visibleBooks.length === 0 &&
                    visiblePlantUmlFiles.length === 0 && (
                      <div className="library-empty">
                        <span>没有找到与 “{query}” 相关的导图</span>
                        <button type="button" onClick={() => onSearch('')}>
                          清除搜索条件
                        </button>
                      </div>
                    )}
                </div>
              ) : (
                /* 文件夹层级折叠树 */
                <div className="library-folder-tree">
                  {folderTree.map(renderFolder)}

                  {documents.length === 0 &&
                    visibleBooks.length === 0 &&
                    visiblePlantUmlFiles.length === 0 &&
                    !busy && (
                      <div className="library-empty">
                        <span>文件库中还没有思维导图</span>
                        <button type="button" onClick={onCreateDocument}>
                          立即新建第一张导图
                        </button>
                      </div>
                    )}
                </div>
              )}
            </div>

            {/* 底部位置状态条 */}
            <div className="library-footer">
              <div
                className="library-storage-info"
                title={snapshot?.rootPath ?? ''}
              >
                <span className="storage-icon" aria-hidden="true">
                  📍
                </span>
                <span className="storage-path">{rootName}</span>
              </div>
              <button
                type="button"
                className="library-change-root-btn"
                onClick={onChooseRoot}
                title="更改导图本地存储目录"
              >
                切换位置
              </button>
            </div>
          </>
        ) : (
          /* 大纲速览 Tab */
          <div className="library-outline-pane">
            <div className="outline-filter-bar">
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                aria-hidden="true"
              >
                <circle
                  cx="6.5"
                  cy="6.5"
                  r="4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M9.5 9.5l3.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
              <input
                type="text"
                value={outlineFilter}
                onChange={(e) => setOutlineFilter(e.target.value)}
                placeholder="筛选大纲节点…"
                aria-label="筛选当前大纲"
              />
              {outlineFilter && (
                <button
                  type="button"
                  className="library-search-clear"
                  onClick={() => setOutlineFilter('')}
                >
                  ×
                </button>
              )}
            </div>

            <div
              className="library-outline-list"
              role="tree"
              aria-label="当前导图大纲结构"
            >
              {filteredOutline.map((item, idx) => (
                <div
                  key={`${item.lineIndex}-${idx}`}
                  className={`outline-row outline-depth-${item.depth}`}
                  style={{
                    paddingLeft: `${Math.max(8, (item.depth - 1) * 14 + 10)}px`,
                  }}
                  onClick={() => onNavigateToLine?.(item.lineIndex)}
                  title={`第 ${item.lineIndex + 1} 行 · 点击跳转定位`}
                  role="treeitem"
                >
                  <span className={`outline-level-tag is-depth-${item.depth}`}>
                    {item.depth === 1
                      ? 'H1'
                      : item.depth === 2
                        ? 'H2'
                        : item.depth === 3
                          ? 'H3'
                          : '•'}
                  </span>
                  <span className="outline-text">{item.text}</span>
                  <span className="outline-line-hint">
                    L{item.lineIndex + 1}
                  </span>
                </div>
              ))}

              {filteredOutline.length === 0 && (
                <div className="library-empty">
                  <span>
                    {outlineFilter
                      ? '未匹配到大纲节点'
                      : '当前导图暂无大纲结构'}
                  </span>
                  <small>输入 # 标题或列表项即可自动解析成大纲树</small>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 删除二次确认弹层 */}
      {deleteConfirmation && (
        <div
          className="library-modal-backdrop"
          onClick={() => setDeleteConfirmation(null)}
        >
          <div
            className="library-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>
                {deleteConfirmation.kind === 'map'
                  ? '确认删除导图？'
                  : '确认删除 PUML 文件？'}
              </h3>
            </div>
            <p className="modal-body">
              确定要删除 <strong>{deleteConfirmation.document.title}</strong>{' '}
              吗？
              <br />
              <small>此操作将移出本地文件库，无法直接撤销。</small>
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-cancel-btn"
                onClick={() => setDeleteConfirmation(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="modal-danger-btn"
                onClick={() => {
                  if (deleteConfirmation.kind === 'map') {
                    onDeleteDocument(deleteConfirmation.document);
                  } else {
                    onDeletePlantUmlFile(deleteConfirmation.document);
                  }
                  setDeleteConfirmation(null);
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
      {renameFolder && (
        <div
          className="library-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !renamePending)
              setRenameFolder(null);
          }}
        >
          <form
            className="library-modal-card library-folder-rename-modal"
            onSubmit={(event) => void submitFolderRename(event)}
          >
            <div className="modal-header">
              <h3>重命名文件夹</h3>
            </div>
            <p className="modal-body">{renameFolder.path}</p>
            <input
              className="library-folder-rename-input"
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !renamePending)
                  setRenameFolder(null);
              }}
              aria-label="新文件夹名称"
              maxLength={255}
            />
            {renameError && (
              <p className="library-folder-rename-error" role="alert">
                {renameError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="modal-cancel-btn"
                disabled={renamePending}
                onClick={() => setRenameFolder(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="library-folder-rename-submit"
                disabled={renamePending || !renameValue.trim()}
              >
                {renamePending ? '正在重命名…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}
      {folderContextMenu &&
        createPortal(
          <div
            ref={folderContextMenuRef}
            className="library-folder-context-menu"
            role="menu"
            style={{ left: folderContextMenu.x, top: folderContextMenu.y }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setRenameFolder({
                  path: folderContextMenu.path,
                  name: folderContextMenu.name,
                });
                setRenameValue(folderContextMenu.name);
                setRenameError('');
                setFolderContextMenu(null);
              }}
            >
              重命名文件夹
            </button>
          </div>,
          document.querySelector('.app-shell') ?? document.body,
        )}
    </aside>
  );
}

function renderPlantUmlRow(
  file: PlantUmlDocument,
  selectedPlantUmlPath: string | null,
  onOpen: (file: PlantUmlDocument) => void,
  onDeleteRequest: (file: PlantUmlDocument) => void,
) {
  const isSelected = selectedPlantUmlPath === file.relativePath;
  const sizeLabel =
    file.fileSize >= 1024 * 1024
      ? `${(file.fileSize / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(file.fileSize / 1024))} KB`;

  return (
    <div
      className={`library-doc-row library-puml-row${isSelected ? ' is-selected' : ''}`}
      key={`puml:${file.relativePath}`}
      onClick={() => onOpen(file)}
      role="treeitem"
      aria-selected={isSelected}
      title={`打开 PUML 图表 ${file.relativePath}`}
    >
      <div className="doc-active-bar" aria-hidden="true" />
      <span className="doc-icon" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 1.8h6l4 4v8.4H3zM9 1.8v4h4M5 9h6M5 11.5h4" />
        </svg>
      </span>
      <div className="doc-info-wrap">
        <span className="doc-title" title={file.title}>
          {file.title}
        </span>
        <div className="doc-meta-row">
          <span className="doc-time">{formatRelativeTime(file.updatedAt)}</span>
          <span className="doc-badge">PUML · {sizeLabel}</span>
        </div>
      </div>
      <button
        type="button"
        className="doc-delete-btn"
        title="删除此 PUML 文件"
        aria-label={`删除 ${file.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onDeleteRequest(file);
        }}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

function renderDocumentRow(
  doc: MapDocument,
  selectedPath: string | null,
  onOpen: (doc: MapDocument) => void,
  onDeleteRequest: (doc: MapDocument) => void,
) {
  const isSelected = selectedPath === doc.relativePath;
  const isEpub = doc.mapType === 'EPUB 目录';

  return (
    <div
      className={`library-doc-row${isSelected ? ' is-selected' : ''}`}
      key={doc.relativePath}
      onClick={() => onOpen(doc)}
      role="treeitem"
      aria-selected={isSelected}
    >
      <div className="doc-active-bar" aria-hidden="true" />
      <span className="doc-icon" aria-hidden="true">
        {isEpub ? (
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2H7v12H3.5A1.5 1.5 0 0 1 2 12.5v-9zM14 3.5A1.5 1.5 0 0 0 12.5 2H9v12h3.5a1.5 1.5 0 0 0 1.5-1.5v-9z" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="2.5" width="12" height="11" rx="2" />
            <path d="M5 6h6M5 9h4" />
          </svg>
        )}
      </span>
      <div className="doc-info-wrap">
        <span className="doc-title" title={doc.title}>
          {doc.title}
        </span>
        <div className="doc-meta-row">
          <span className="doc-time">{formatRelativeTime(doc.updatedAt)}</span>
          {doc.category && doc.category !== '未分类' && (
            <span className="doc-badge doc-cat-badge">{doc.category}</span>
          )}
          {doc.tags &&
            doc.tags.slice(0, 1).map((t) => (
              <span className="doc-badge" key={t}>
                {t}
              </span>
            ))}
        </div>
      </div>
      <button
        type="button"
        className="doc-delete-btn"
        title="删除此导图"
        aria-label={`删除 ${doc.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onDeleteRequest(doc);
        }}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

function renderEpubRow(
  book: EpubBookDocument,
  onOpen: (book: EpubBookDocument) => void,
) {
  const sizeLabel =
    book.fileSize >= 1024 * 1024
      ? `${(book.fileSize / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(book.fileSize / 1024))} KB`;

  return (
    <div
      className="library-doc-row library-epub-row"
      key={`epub:${book.relativePath}`}
      onClick={() => onOpen(book)}
      role="treeitem"
      title={`阅读 ${book.relativePath}`}
    >
      <div className="doc-active-bar" aria-hidden="true" />
      <span className="doc-icon epub-doc-icon" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2H7v12H3.5A1.5 1.5 0 0 1 2 12.5v-9zM14 3.5A1.5 1.5 0 0 0 12.5 2H9v12h3.5a1.5 1.5 0 0 0 1.5-1.5v-9z" />
        </svg>
      </span>
      <div className="doc-info-wrap">
        <span className="doc-title" title={book.title}>
          {book.title}
        </span>
        <div className="doc-meta-row">
          <span className="doc-time">{formatRelativeTime(book.updatedAt)}</span>
          <span className="doc-badge">EPUB · {sizeLabel}</span>
        </div>
      </div>
    </div>
  );
}
