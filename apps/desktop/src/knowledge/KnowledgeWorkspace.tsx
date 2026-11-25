import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { MapDocument } from '../library/library';
import type { Theme } from '../app/app-storage';
import {
  buildKnowledgeFolderTree,
  isInternalAssetCategory,
  normalizeKnowledgeFolderPath,
  resolveNewKnowledgeCategoryPath,
  UNFILED_FOLDER,
  type KnowledgeFolderTreeNode,
} from './knowledge-notes';
import {
  groupKnowledgeBySource,
  knowledgeOrigin,
  KNOWLEDGE_SOURCE_PAGES,
  type KnowledgeSourcePage,
} from './knowledge-origin';
import DocumentWorkbench, {
  type DocumentWorkbenchProps,
} from '../workbench/DocumentWorkbench';
import { isDirty, type ActiveDocument } from '../workbench/active-document';
import { formatRelativeDate } from './knowledge-completions';
import {
  KNOWLEDGE_NOTE_TEMPLATES,
  type KnowledgeNoteTemplate,
} from './knowledge-markdown';
import {
  normalizeKnowledgePath,
  visibleKnowledgePaneCount,
  type KnowledgePaneDocViewMode,
  type KnowledgeSplitMode,
} from './knowledge-split-model';
import type {
  KnowledgeSplitWorkspaceHandle,
  OpenKnowledgeNoteOptions,
} from './use-knowledge-split';
import {
  RailBookIcon,
  RailFolderIcon,
  RailHomeIcon,
  RailInboxIcon,
  RailNoteIcon,
  RailPlayIcon,
  RailPlusIcon,
  SidebarCollapseButton,
  useSidebarCollapseShortcut,
  WorkspaceSidebarRail,
} from '../components/WorkspaceSidebarRail';
import KnowledgeHeatmap from './KnowledgeHeatmap';
import './knowledge-workspace.css';

export interface KnowledgeWorkspaceProps {
  active?: boolean;
  rootPath: string | null;
  documents: MapDocument[];
  mindmapCount?: number;
  onSwitchToMindmap?(): void;
  categories: string[];
  activeDocument: ActiveDocument | null;
  split: KnowledgeSplitWorkspaceHandle;
  errorMessage?: string;
  busy?: boolean;
  onChooseRoot(): void;
  onRefresh(): void;
  onCreateCategory(category: string): Promise<boolean>;
  onRenameFolder?(path: string, newName: string): Promise<boolean>;
  onOpenNote(note: MapDocument, options?: OpenKnowledgeNoteOptions): void;
  onCreateNote(
    folder: string,
    template?: KnowledgeNoteTemplate,
    targetPaneIndex?: number,
  ): void;
  onDeleteNote(note: MapDocument): void;
  onSidebarLayoutChange?(width: number, collapsed: boolean): void;
  workbench: {
    statusText: string;
    theme: Theme;
    renderMarkdownPreview(markdown: string): { html: string; source: string };
    onOpenWikilink?(target: string, options?: { split?: boolean }): void;
    onOpenYouTubeLink?: DocumentWorkbenchProps['onOpenYouTubeLink'];
    onRunInTerminal?: DocumentWorkbenchProps['onRunInTerminal'];
    onOpenAsMindmap?(path: string): void;
    onConvertToMindmap?(path: string): void;
  };
}

const DOC_VIEW_MODE_STORAGE_KEY = 'seamind.docWorkbench.viewMode';

function readPreferredDocViewMode(): KnowledgePaneDocViewMode {
  try {
    const raw = localStorage.getItem(DOC_VIEW_MODE_STORAGE_KEY);
    if (raw === 'edit' || raw === 'split' || raw === 'read') return raw;
    return 'split';
  } catch {
    return 'split';
  }
}

function defaultCompactPaneViewMode(
  paneIndex: number,
): KnowledgePaneDocViewMode {
  if (paneIndex > 0) return 'read';
  const preferred = readPreferredDocViewMode();
  return preferred === 'split' ? 'edit' : preferred;
}

const COLLAPSED_STORAGE_KEY = 'seamind.knowledge.collapsedFolders';
const SIDEBAR_WIDTH_STORAGE_KEY = 'seamind.knowledge.sidebarWidth';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'seamind.knowledge.sidebarCollapsed';
const SOURCE_PAGE_STORAGE_KEY = 'seamind.knowledge.sourcePage';
const DEFAULT_SIDEBAR_WIDTH = 264;
const MIN_SIDEBAR_WIDTH = 210;
const MAX_SIDEBAR_WIDTH = 440;

function readSourcePage(): KnowledgeSourcePage {
  try {
    const saved = localStorage.getItem(SOURCE_PAGE_STORAGE_KEY);
    return (
      KNOWLEDGE_SOURCE_PAGES.find((page) => page.id === saved)?.id ?? 'manual'
    );
  } catch {
    return 'manual';
  }
}

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

export function readKnowledgeSidebarWidth(): number {
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

export function readKnowledgeSidebarCollapsed(): boolean {
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

function SplitColumnsIcon() {
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
        rx="1"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <line
        x1="8"
        y1="2.5"
        x2="8"
        y2="13.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function SplitLayoutIcon({ mode }: { mode: KnowledgeSplitMode }) {
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
        rx="1"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      {(mode === 'vertical' || mode === 'tri' || mode === 'quad') && (
        <line
          x1="8"
          y1="2.5"
          x2="8"
          y2="13.5"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      )}
      {mode === 'horizontal' && (
        <line
          x1="2"
          y1="8"
          x2="14"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      )}
      {mode === 'tri' && (
        <line
          x1="8"
          y1="8"
          x2="14"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      )}
      {mode === 'quad' && (
        <line
          x1="2"
          y1="8"
          x2="14"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      )}
    </svg>
  );
}

function ZoomPaneIcon({ zoomed }: { zoomed: boolean }) {
  return (
    <svg
      className="kb-svg-icon"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      {zoomed ? (
        <path
          d="M6 2.5v3.5H2.5M10 13.5V10h3.5M13.5 6H10V2.5M2.5 10H6v3.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M2.5 6V2.5H6M13.5 10v3.5H10M10 2.5h3.5V6M6 13.5H2.5V10"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/**
 * Clean, architectural Knowledge Base workspace aligned with SeaMind's editorial visual language.
 */
export default function KnowledgeWorkspace({
  active = true,
  rootPath,
  documents,
  mindmapCount = 0,
  onSwitchToMindmap,
  categories,
  activeDocument,
  split,
  errorMessage,
  busy = false,
  onChooseRoot,
  onRefresh,
  onCreateCategory,
  onRenameFolder,
  onOpenNote,
  onCreateNote,
  onDeleteNote,
  onSidebarLayoutChange,
  workbench,
}: KnowledgeWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [activeSource, setActiveSource] =
    useState<KnowledgeSourcePage>(readSourcePage);
  const [globalSearch, setGlobalSearch] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const setActiveFolder = useCallback((folder: string | null) => {
    const clean = folder ? normalizeKnowledgeFolderPath(folder) : '';
    setSelectedFolder(clean && clean !== UNFILED_FOLDER ? clean : null);
  }, []);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() =>
    readCollapsedFolders(),
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readKnowledgeSidebarWidth(),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    readKnowledgeSidebarCollapsed(),
  );
  useEffect(() => {
    onSidebarLayoutChange?.(sidebarWidth, sidebarCollapsed);
  }, [onSidebarLayoutChange, sidebarWidth, sidebarCollapsed]);
  const [isResizing, setIsResizing] = useState(false);
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(
    null,
  );
  const [fabMenuOpen, setFabMenuOpen] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [categoryInput, setCategoryInput] = useState('');
  const [categorySubmitting, setCategorySubmitting] = useState(false);
  const [folderContextMenu, setFolderContextMenu] = useState<{
    path: string;
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renamePending, setRenamePending] = useState(false);
  const [openSwitcherPane, setOpenSwitcherPane] = useState<number | null>(null);
  const [syncScrollEnabled, setSyncScrollEnabled] = useState(false);
  const [isDraggingSplitRatio, setIsDraggingSplitRatio] = useState(false);

  const fabContainerRef = useRef<HTMLDivElement>(null);
  const folderContextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const switcherMenuRef = useRef<HTMLDivElement>(null);
  const splitStageRef = useRef<HTMLElement>(null);
  const syncingScrollLockRef = useRef(false);
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

  const sourceCounts = useMemo(() => {
    const counts: Record<KnowledgeSourcePage, number> = {
      manual: 0,
      ebook: 0,
      player: 0,
      unknown: 0,
    };
    for (const doc of docNotes) counts[knowledgeOrigin(doc)] += 1;
    return counts;
  }, [docNotes]);

  const manualCategories = useMemo(
    () =>
      categories.filter(
        (category) =>
          category !== '读书笔记' &&
          !category.startsWith('读书笔记/') &&
          category !== '视频笔记' &&
          !category.startsWith('视频笔记/') &&
          !isInternalAssetCategory(category),
      ),
    [categories],
  );

  const groups = useMemo(() => {
    if (globalSearch && query.trim()) {
      return KNOWLEDGE_SOURCE_PAGES.flatMap(({ id, label }) =>
        groupKnowledgeBySource(
          documents,
          id,
          query,
          id === 'manual' ? manualCategories : [],
        ).map((group) => ({ ...group, name: `${label} / ${group.name}` })),
      );
    }
    return groupKnowledgeBySource(
      documents,
      activeSource,
      query,
      activeSource === 'manual' ? manualCategories : [],
    );
  }, [documents, activeSource, query, manualCategories, globalSearch]);

  const folderTree = useMemo(() => buildKnowledgeFolderTree(groups), [groups]);

  // 识别同一视频/同名重复文档，生成去重与版本元数据
  const duplicateNotesMap = useMemo(() => {
    const map = new Map<
      string,
      {
        total: number;
        index: number;
        isLatest: boolean;
        isDuplicate: boolean;
      }
    >();

    for (const group of groups) {
      const clusterMap = new Map<string, MapDocument[]>();
      for (const note of group.notes) {
        const vid = note.sourceRef?.videoId?.trim();
        const baseTitle = note.title
          .trim()
          .replace(/\s*\(\d+\)$/, '')
          .toLowerCase();
        const key = vid ? `vid:${vid}` : `title:${baseTitle}`;
        const list = clusterMap.get(key) ?? [];
        list.push(note);
        clusterMap.set(key, list);
      }

      for (const [, cluster] of clusterMap.entries()) {
        if (cluster.length <= 1) continue;
        const sorted = [...cluster].sort(
          (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0),
        );
        const total = sorted.length;
        sorted.forEach((note, idx) => {
          map.set(note.relativePath, {
            total,
            index: idx + 1,
            isLatest: idx === total - 1,
            isDuplicate: true,
          });
        });
      }
    }
    return map;
  }, [groups]);

  const folderDuplicateCopies = useMemo(() => {
    const map = new Map<string, MapDocument[]>();
    for (const group of groups) {
      const copies: MapDocument[] = [];
      for (const note of group.notes) {
        const meta = duplicateNotesMap.get(note.relativePath);
        if (meta && !meta.isLatest) {
          copies.push(note);
        }
      }
      map.set(group.name, copies);
    }
    return map;
  }, [groups, duplicateNotesMap]);

  const handleCleanFolderDuplicates = useCallback(
    (copies: MapDocument[]) => {
      if (copies.length === 0) return;
      for (const copy of copies) {
        onDeleteNote(copy);
      }
    },
    [onDeleteNote],
  );

  const sourceNotes = useMemo(
    () => docNotes.filter((doc) => knowledgeOrigin(doc) === activeSource),
    [docNotes, activeSource],
  );

  useEffect(() => {
    try {
      localStorage.setItem(SOURCE_PAGE_STORAGE_KEY, activeSource);
    } catch {
      /* 无法写入偏好时继续使用当前视图。 */
    }
  }, [activeSource]);

  const allFolderNames = useMemo(() => {
    const names = new Set<string>([UNFILED_FOLDER]);
    for (const raw of manualCategories) {
      const clean = normalizeKnowledgeFolderPath(raw);
      if (clean && !isInternalAssetCategory(clean)) names.add(clean);
    }
    for (const note of docNotes.filter(
      (doc) => knowledgeOrigin(doc) === 'manual',
    )) {
      const clean = normalizeKnowledgeFolderPath(note.category);
      if (clean && !isInternalAssetCategory(clean)) names.add(clean);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [manualCategories, docNotes]);

  const effectiveSelectedFolder = useMemo(() => {
    if (!selectedFolder) return null;
    const clean = normalizeKnowledgeFolderPath(selectedFolder);
    if (!clean || clean === UNFILED_FOLDER) return null;
    return clean;
  }, [selectedFolder]);

  const effectiveFolder = useMemo(() => {
    if (effectiveSelectedFolder) return effectiveSelectedFolder;
    return UNFILED_FOLDER;
  }, [effectiveSelectedFolder]);

  useEffect(() => {
    if (activeDocument?.kind === 'doc') {
      const folder =
        normalizeKnowledgeFolderPath(activeDocument.category) || UNFILED_FOLDER;
      setSelectedFolder(folder !== UNFILED_FOLDER ? folder : null);
      setActiveSource(
        knowledgeOrigin({
          origin: activeDocument.origin,
          category: activeDocument.category,
          mapType: activeDocument.mapType,
          tags: activeDocument.tags,
        }),
      );
    }
  }, [
    activeDocument?.relativePath,
    activeDocument?.category,
    activeDocument?.kind,
  ]);

  const splitState = split.splitState;
  const visibleCount = visibleKnowledgePaneCount(splitState.splitMode);
  const isStageZoomed = splitState.zoomedPaneIndex !== null && visibleCount > 1;
  const showPaneHeaders = visibleCount > 1 && !isStageZoomed;
  const hasDocStage = Boolean(
    rootPath && splitState.tabs.length > 0 && !splitState.showHomeOverview,
  );

  const activePanePaths = useMemo(
    () =>
      Array.from({ length: visibleCount }, (_, idx) => {
        const raw = splitState.panePaths[idx] ?? null;
        return raw ? normalizeKnowledgePath(raw) : null;
      }),
    [splitState.panePaths, visibleCount],
  );

  const visiblePaneIndices = useMemo(() => {
    if (isStageZoomed && splitState.zoomedPaneIndex !== null) {
      return [splitState.zoomedPaneIndex];
    }
    return Array.from({ length: visibleCount }, (_, idx) => idx);
  }, [isStageZoomed, splitState.zoomedPaneIndex, visibleCount]);

  useEffect(() => {
    const stage = splitStageRef.current;
    if (!stage || !syncScrollEnabled || visibleCount <= 1 || isStageZoomed) {
      return;
    }
    let unlockFrame: number | null = null;
    const onScrollCapture = (event: Event) => {
      if (syncingScrollLockRef.current) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (
        !target.classList.contains('cm-scroller') &&
        !target.classList.contains('markdown-rendered-preview')
      ) {
        return;
      }
      const sourcePane = target.closest('.kb-pane-body');
      if (!sourcePane) return;
      const maxSourceScroll = target.scrollHeight - target.clientHeight;
      if (maxSourceScroll <= 0) return;
      const ratio = Math.max(
        0,
        Math.min(1, target.scrollTop / maxSourceScroll),
      );
      syncingScrollLockRef.current = true;
      const paneBodies = stage.querySelectorAll<HTMLElement>('.kb-pane-body');
      paneBodies.forEach((paneEl) => {
        if (paneEl === sourcePane) return;
        const scrollers = paneEl.querySelectorAll<HTMLElement>(
          '.cm-scroller, .markdown-rendered-preview',
        );
        scrollers.forEach((scroller) => {
          const maxTarget = scroller.scrollHeight - scroller.clientHeight;
          if (maxTarget > 0) {
            scroller.scrollTop = Math.round(ratio * maxTarget);
          }
        });
      });
      if (unlockFrame !== null) window.cancelAnimationFrame(unlockFrame);
      unlockFrame = window.requestAnimationFrame(() => {
        syncingScrollLockRef.current = false;
        unlockFrame = null;
      });
    };
    stage.addEventListener('scroll', onScrollCapture, {
      capture: true,
      passive: true,
    });
    return () => {
      stage.removeEventListener('scroll', onScrollCapture, { capture: true });
      if (unlockFrame !== null) window.cancelAnimationFrame(unlockFrame);
      syncingScrollLockRef.current = false;
    };
  }, [hasDocStage, isStageZoomed, syncScrollEnabled, visibleCount]);

  const selectSource = (source: KnowledgeSourcePage) => {
    if (source === activeSource) return;
    if (splitState.tabs.length > 0) {
      split.showOverview(true);
    }
    setActiveSource(source);
    setSelectedFolder(null);
    setFabMenuOpen(false);
    setCreatingCategory(false);
    setFolderContextMenu(null);
    setQuery('');
    setGlobalSearch(false);
    setPendingDeletePath(null);
  };

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of sourceNotes) {
      for (const rawTag of note.tags ?? []) {
        const tag = rawTag.trim();
        if (!tag) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'),
    );
  }, [sourceNotes]);

  const visibleNoteCount = useMemo(
    () => groups.reduce((sum, group) => sum + group.notes.length, 0),
    [groups],
  );

  // Dismiss FAB menu on outside click or Escape
  useEffect(() => {
    if (!fabMenuOpen && !creatingCategory) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        fabContainerRef.current &&
        !fabContainerRef.current.contains(event.target as Node)
      ) {
        setFabMenuOpen(false);
        setCreatingCategory(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFabMenuOpen(false);
        setCreatingCategory(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [fabMenuOpen, creatingCategory]);

  // Dismiss folder context menu on outside click, scroll, or Escape
  useEffect(() => {
    if (!folderContextMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        folderContextMenuRef.current &&
        !folderContextMenuRef.current.contains(event.target as Node)
      ) {
        setFolderContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFolderContextMenu(null);
      }
    };
    const handleScroll = () => setFolderContextMenu(null);
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [folderContextMenu]);

  useEffect(() => {
    if (creatingCategory) {
      window.requestAnimationFrame(() => categoryInputRef.current?.focus());
    }
  }, [creatingCategory]);

  useEffect(() => {
    if (renamingFolder) {
      window.requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
    }
  }, [renamingFolder]);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  }, []);

  useSidebarCollapseShortcut(toggleSidebarCollapsed, active);

  // Dismiss pane doc switcher menu on outside click or Escape
  useEffect(() => {
    if (openSwitcherPane === null) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        switcherMenuRef.current &&
        !switcherMenuRef.current.contains(event.target as Node)
      ) {
        setOpenSwitcherPane(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpenSwitcherPane(null);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openSwitcherPane]);

  useEffect(() => {
    setOpenSwitcherPane(null);
  }, [splitState.splitMode, splitState.zoomedPaneIndex]);

  // Split & multi-tab keyboard shortcuts (active only when Knowledge workspace is frontmost).
  useEffect(() => {
    if (!active || !rootPath) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (pendingDeletePath || creatingCategory || renamingFolder) return;
      if (
        event.key === 'Escape' &&
        !fabMenuOpen &&
        !folderContextMenu &&
        selectedFolder !== null
      ) {
        setSelectedFolder(null);
        return;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        /^[1-9]$/.test(event.key)
      ) {
        const targetTab = splitState.tabs[Number(event.key) - 1];
        if (!targetTab) return;
        event.preventDefault();
        event.stopPropagation();
        const alreadyPane = activePanePaths.indexOf(targetTab.path);
        if (alreadyPane >= 0) {
          split.focusPane(alreadyPane);
        } else {
          split.assignTab(split.safeFocusedPaneIndex, targetTab.path);
        }
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'm'
      ) {
        if (visibleCount > 1) {
          event.preventDefault();
          event.stopPropagation();
          split.toggleZoom();
        }
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key === '\\'
      ) {
        if (splitState.tabs.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (splitState.splitMode === 'single') {
          split.switchLayout('vertical');
        } else {
          split.splitOutPane(split.safeFocusedPaneIndex, 'next-or-empty');
        }
        return;
      }
      if (event.ctrlKey && event.altKey && !event.shiftKey) {
        if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'l') {
          if (visibleCount > 1) {
            event.preventDefault();
            event.stopPropagation();
            split.moveFocus(1);
          }
          return;
        }
        if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'h') {
          if (visibleCount > 1) {
            event.preventDefault();
            event.stopPropagation();
            split.moveFocus(-1);
          }
          return;
        }
      }
      if (
        hasDocStage &&
        split.focusedPath &&
        !event.shiftKey &&
        ((event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.key.toLowerCase() === 'w') ||
          ((event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            event.key.toLowerCase() === 'w'))
      ) {
        event.preventDefault();
        event.stopPropagation();
        void split.closeTab(split.focusedPath);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    active,
    activePanePaths,
    creatingCategory,
    fabMenuOpen,
    folderContextMenu,
    hasDocStage,
    pendingDeletePath,
    renamingFolder,
    rootPath,
    selectedFolder,
    split,
    splitState.splitMode,
    splitState.tabs,
    visibleCount,
  ]);

  const toggleFolder = useCallback(
    (folderPath: string) => {
      setActiveFolder(folderPath);
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(folderPath)) next.delete(folderPath);
        else next.add(folderPath);
        writeCollapsedFolders(next);
        return next;
      });
    },
    [setActiveFolder],
  );

  const allTreeFolderPaths = useMemo(() => {
    const paths: string[] = [];
    const walk = (nodes: readonly KnowledgeFolderTreeNode<MapDocument>[]) => {
      for (const node of nodes) {
        paths.push(node.path);
        walk(node.children);
      }
    };
    walk(folderTree);
    return paths;
  }, [folderTree]);

  const toggleAllFolders = useCallback(() => {
    setCollapsedFolders((prev) => {
      const next =
        prev.size > 0 ? new Set<string>() : new Set(allTreeFolderPaths);
      writeCollapsedFolders(next);
      return next;
    });
  }, [allTreeFolderPaths]);

  const openCategoryCreator = useCallback(() => {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      writeSidebarCollapsed(false);
    }
    setFabMenuOpen(true);
    setCreatingCategory(true);
  }, [sidebarCollapsed]);

  const submitCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetCategory = resolveNewKnowledgeCategoryPath(
      categoryInput,
      effectiveSelectedFolder,
    );
    if (!targetCategory || categorySubmitting) return;
    setCategorySubmitting(true);
    try {
      if (activeSource !== 'manual') {
        setActiveSource('manual');
      }
      const created = await onCreateCategory(targetCategory);
      if (created) {
        setSelectedFolder(targetCategory);
        setCollapsedFolders((prev) => {
          const next = new Set(prev);
          const segments = targetCategory.split('/');
          let prefix = '';
          for (const seg of segments) {
            prefix = prefix ? `${prefix}/${seg}` : seg;
            next.delete(prefix);
          }
          writeCollapsedFolders(next);
          return next;
        });
        setCategoryInput('');
        setCreatingCategory(false);
        setFabMenuOpen(false);
      }
    } finally {
      setCategorySubmitting(false);
    }
  };

  const openFolderRenameModal = useCallback(
    (folderPath: string, folderName: string) => {
      setFolderContextMenu(null);
      setRenamingFolder({ path: folderPath, name: folderName });
      setRenameValue(folderName);
      setRenameError('');
    },
    [],
  );

  const submitFolderRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renamingFolder || !onRenameFolder || renamePending) return;
    const cleanName = renameValue
      .trim()
      .replaceAll('\\', '/')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('');
    if (!cleanName) {
      setRenameError('文件夹名称不能为空');
      return;
    }
    if (cleanName === renamingFolder.name) {
      setRenamingFolder(null);
      return;
    }
    setRenamePending(true);
    setRenameError('');
    try {
      const oldPath = renamingFolder.path;
      const parentPrefix = oldPath.includes('/')
        ? oldPath.slice(0, oldPath.lastIndexOf('/'))
        : '';
      const newPath = parentPrefix ? `${parentPrefix}/${cleanName}` : cleanName;
      const ok = await onRenameFolder(oldPath, cleanName);
      if (!ok) {
        setRenameError('重命名失败，请检查名称是否冲突或包含非法字符');
        return;
      }
      setSelectedFolder((prev) => {
        if (!prev) return prev;
        if (prev === oldPath) return newPath;
        if (prev.startsWith(`${oldPath}/`)) {
          return `${newPath}${prev.slice(oldPath.length)}`;
        }
        return prev;
      });
      setCollapsedFolders((prev) => {
        const next = new Set<string>();
        for (const item of prev) {
          if (item === oldPath) {
            next.add(newPath);
          } else if (item.startsWith(`${oldPath}/`)) {
            next.add(`${newPath}${item.slice(oldPath.length)}`);
          } else {
            next.add(item);
          }
        }
        writeCollapsedFolders(next);
        return next;
      });
      setRenamingFolder(null);
    } finally {
      setRenamePending(false);
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

  const handleCreateNoteFromFab = useCallback(
    (template?: KnowledgeNoteTemplate) => {
      if (activeSource !== 'manual') {
        setActiveSource('manual');
      }
      setFabMenuOpen(false);
      setCreatingCategory(false);
      onCreateNote(effectiveFolder, template);
    },
    [activeSource, effectiveFolder, onCreateNote],
  );

  const renderFolderNode = (
    node: KnowledgeFolderTreeNode<MapDocument>,
  ): React.ReactNode => {
    const isCollapsed = collapsedFolders.has(node.path);
    const isSelected = selectedFolder === node.path;
    const canManageFolder =
      activeSource === 'manual' &&
      !globalSearch &&
      node.path !== UNFILED_FOLDER;
    const dupCopies = folderDuplicateCopies.get(node.path) ?? [];

    return (
      <section
        className={`knowledge-group${isCollapsed ? ' is-collapsed' : ''}${node.depth > 0 ? ' is-subfolder' : ''}`}
        key={node.path}
      >
        <div
          className={`knowledge-folder-row${isSelected ? ' is-selected' : ''}`}
          style={
            node.depth > 0 ? { paddingLeft: `${node.depth * 14}px` } : undefined
          }
          onContextMenu={(event) => {
            if (!canManageFolder) return;
            event.preventDefault();
            event.stopPropagation();
            setSelectedFolder(node.path);
            setFolderContextMenu({
              path: node.path,
              name: node.name,
              x: Math.min(event.clientX, window.innerWidth - 210),
              y: Math.min(event.clientY, window.innerHeight - 180),
            });
          }}
        >
          <button
            type="button"
            className="knowledge-folder-toggle"
            aria-expanded={!isCollapsed}
            title={
              canManageFolder
                ? `${node.path}（点击选中目录 · 右键重命名或新建子目录）`
                : node.path
            }
            onClick={() => toggleFolder(node.path)}
          >
            <ChevronRightIcon expanded={!isCollapsed} />
            <FolderIcon />
            <span className="knowledge-folder-name">{node.name}</span>
            <span className="knowledge-folder-count">
              {node.totalNotesCount}
            </span>
          </button>
          {dupCopies.length > 0 && (
            <button
              type="button"
              className="knowledge-folder-clean-dup"
              title={`该分类有 ${dupCopies.length} 篇同视频历史副本，点击一键清理，仅保留最新版`}
              onClick={(event) => {
                event.stopPropagation();
                handleCleanFolderDuplicates(dupCopies);
              }}
            >
              清理 {dupCopies.length} 副本
            </button>
          )}
          {activeSource === 'manual' && !globalSearch && (
            <button
              type="button"
              className="knowledge-folder-add"
              title={`在「${node.path}」中新建笔记`}
              aria-label={`在 ${node.path} 中新建笔记`}
              onClick={(event) => {
                event.stopPropagation();
                setActiveFolder(node.path);
                if (collapsedFolders.has(node.path)) {
                  setCollapsedFolders((prev) => {
                    const next = new Set(prev);
                    next.delete(node.path);
                    writeCollapsedFolders(next);
                    return next;
                  });
                }
                onCreateNote(node.path);
              }}
            >
              <PlusIcon />
            </button>
          )}
        </div>

        {!isCollapsed && (
          <div
            className={
              node.depth > 0
                ? 'knowledge-folder-children'
                : 'knowledge-folder-notes'
            }
          >
            {node.children.length > 0 &&
              node.children.map((child) => renderFolderNode(child))}

            {node.notes.length === 0 && node.children.length === 0 ? (
              <div className="knowledge-folder-empty">
                <span>空分类</span>
                {activeSource === 'manual' && (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveFolder(node.path);
                      onCreateNote(node.path);
                    }}
                  >
                    新建首篇
                  </button>
                )}
              </div>
            ) : (
              node.notes.map((note) => {
                const normPath = normalizeKnowledgePath(note.relativePath);
                const paneSlots = activePanePaths.reduce<number[]>(
                  (acc, p, idx) => {
                    if (p === normPath) acc.push(idx);
                    return acc;
                  },
                  [],
                );
                const isFocusedActive =
                  hasDocStage && split.focusedPath === normPath;
                const isSplitVisible =
                  hasDocStage && !isFocusedActive && paneSlots.length > 0;
                const isNoteDirty = split.documentsByPath[normPath]
                  ? isDirty(split.documentsByPath[normPath])
                  : false;
                const isDeleting = pendingDeletePath === note.relativePath;

                return (
                  <div
                    className={`knowledge-note-row${isFocusedActive ? ' is-active' : ''}${isSplitVisible ? ' is-split-visible' : ''}${isDeleting ? ' is-confirming' : ''}`}
                    key={note.relativePath}
                  >
                    <button
                      type="button"
                      className="knowledge-note-main"
                      title={`${note.title}\n${note.relativePath}\n点击打开 · Alt+点击在分栏打开`}
                      onClick={(event) => {
                        setActiveFolder(node.path);
                        onOpenNote(note, {
                          split: event.altKey || event.ctrlKey || event.metaKey,
                        });
                      }}
                    >
                      <div className="knowledge-note-line">
                        <NoteIcon />
                        <strong className="knowledge-note-title">
                          {note.title}
                        </strong>
                        {isNoteDirty && (
                          <span
                            className="knowledge-note-dirty-dot"
                            aria-label="未保存"
                            title="有未保存修改"
                          />
                        )}
                        {hasDocStage &&
                          visibleCount > 1 &&
                          paneSlots.length > 0 && (
                            <span className="knowledge-note-pane-tag">
                              {paneSlots.map((s) => `P${s + 1}`).join('·')}
                            </span>
                          )}
                      </div>
                      <div className="knowledge-note-sub">
                        {note.updatedAt > 0 && (
                          <span className="knowledge-note-date">
                            {formatRelativeDate(note.updatedAt)}
                          </span>
                        )}
                        {duplicateNotesMap.get(note.relativePath)
                          ?.isDuplicate && (
                          <span
                            className={`knowledge-dup-chip ${
                              duplicateNotesMap.get(note.relativePath)!.isLatest
                                ? 'is-latest'
                                : 'is-copy'
                            }`}
                            title={
                              duplicateNotesMap.get(note.relativePath)!.isLatest
                                ? `该视频共有 ${duplicateNotesMap.get(note.relativePath)!.total} 份笔记，此篇为最新版`
                                : `该视频共有 ${duplicateNotesMap.get(note.relativePath)!.total} 份笔记，此篇为历史副本 (${duplicateNotesMap.get(note.relativePath)!.index}/${duplicateNotesMap.get(note.relativePath)!.total})`
                            }
                          >
                            {duplicateNotesMap.get(note.relativePath)!.isLatest
                              ? '最新版'
                              : `副本 ${duplicateNotesMap.get(note.relativePath)!.index}/${duplicateNotesMap.get(note.relativePath)!.total}`}
                          </span>
                        )}
                        {note.tags && note.tags.length > 0 && (
                          <span className="knowledge-note-tags">
                            {note.tags.slice(0, 2).map((tag) => (
                              <span key={tag} className="knowledge-tag-chip">
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
                        <>
                          <button
                            type="button"
                            className="knowledge-note-split"
                            title="在分栏中并排打开 (Alt+点击)"
                            aria-label={`在分栏中打开 ${note.title}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setActiveFolder(node.path);
                              onOpenNote(note, { split: true });
                            }}
                          >
                            <SplitColumnsIcon />
                          </button>
                          <button
                            type="button"
                            className="knowledge-note-trash"
                            title={`删除「${note.title}」`}
                            aria-label={`删除笔记 ${note.title}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setPendingDeletePath(note.relativePath);
                            }}
                          >
                            <TrashIcon />
                          </button>
                        </>
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
  };

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
          <WorkspaceSidebarRail
            ariaLabel="已收起的知识库侧栏"
            expandTitle="展开知识库目录 (快捷键 Ctrl+B)"
            expandAriaLabel="展开知识库目录"
            headerHeight={36}
            onExpand={toggleSidebarCollapsed}
            sections={[
              ...(onSwitchToMindmap
                ? [
                    {
                      key: 'surface-switch',
                      items: [
                        {
                          key: 'surface:doc',
                          label: `文档 (${docNotes.length})`,
                          active: true,
                          thumb: {
                            name: '文',
                            shape: 'square' as const,
                            tone: 'index' as const,
                          },
                          onClick: () => undefined,
                        },
                        {
                          key: 'surface:mindmap',
                          label: `切换到导图 (${mindmapCount})`,
                          active: false,
                          thumb: {
                            name: '导',
                            shape: 'square' as const,
                            tone: 'index' as const,
                          },
                          onClick: onSwitchToMindmap,
                        },
                      ],
                    },
                  ]
                : []),
              {
                key: 'sources',
                items: KNOWLEDGE_SOURCE_PAGES.filter(
                  ({ id }) => id !== 'unknown' || sourceCounts.unknown > 0,
                ).map(({ id, label }) => ({
                  key: `source:${id}`,
                  label: `${label} (${sourceCounts[id]})`,
                  active: activeSource === id,
                  icon:
                    id === 'manual' ? (
                      <RailNoteIcon />
                    ) : id === 'ebook' ? (
                      <RailBookIcon />
                    ) : id === 'player' ? (
                      <RailPlayIcon />
                    ) : (
                      <RailInboxIcon />
                    ),
                  onClick: () => void selectSource(id),
                })),
              },
              {
                key: 'groups',
                items: groups.map((group) => ({
                  key: `group:${group.name}`,
                  label: `${group.name} (${group.notes.length} 篇)`,
                  active: selectedFolder === group.name,
                  thumb: {
                    name: group.name,
                    shape: 'square',
                    tone: 'index',
                  },
                  onClick: () => {
                    setActiveFolder(group.name);
                    setCollapsedFolders((prev) => {
                      if (!prev.has(group.name)) return prev;
                      const next = new Set(prev);
                      next.delete(group.name);
                      writeCollapsedFolders(next);
                      return next;
                    });
                    if (
                      group.notes.length > 0 &&
                      (!activeDocument ||
                        !group.notes.some(
                          (note) =>
                            note.relativePath === activeDocument.relativePath,
                        ))
                    ) {
                      onOpenNote(group.notes[0]);
                    }
                  },
                })),
              },
            ]}
            footerItems={[
              {
                key: 'new-note',
                label: rootPath
                  ? `在「${effectiveFolder}」中新建笔记`
                  : '请先选择文件库目录',
                icon: <RailPlusIcon />,
                disabled: !rootPath,
                onClick: () => handleCreateNoteFromFab(),
              },
              {
                key: 'new-category',
                label: effectiveSelectedFolder
                  ? `在「${effectiveSelectedFolder}」下新建子文件夹`
                  : '新建根目录文件夹',
                icon: <RailFolderIcon />,
                disabled: !rootPath,
                onClick: openCategoryCreator,
              },
              ...(hasDocStage
                ? [
                    {
                      key: 'home',
                      label: '返回知识库概览（保留已打开文档）',
                      icon: <RailHomeIcon />,
                      onClick: () => split.showOverview(true),
                    },
                  ]
                : []),
            ]}
          />
        </aside>
      ) : (
        <aside className="knowledge-sidebar" aria-label="知识库文档导航">
          <header
            className="knowledge-sidebar-head"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setSelectedFolder(null);
              }
            }}
          >
            <div
              className="knowledge-sidebar-mode-tabs"
              role="tablist"
              aria-label="知识库模式切换"
            >
              <button
                type="button"
                role="tab"
                aria-selected={true}
                className="knowledge-sidebar-mode-tab is-active"
              >
                <span>文档</span>
                <small className="knowledge-count-pill">
                  {query.trim()
                    ? `${visibleNoteCount}/${docNotes.length}`
                    : docNotes.length}
                </small>
              </button>
              {onSwitchToMindmap && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={false}
                  className="knowledge-sidebar-mode-tab"
                  title="切换到思维导图工作台"
                  onClick={onSwitchToMindmap}
                >
                  <span>导图</span>
                  <small className="knowledge-count-pill">{mindmapCount}</small>
                </button>
              )}
            </div>
            <div className="knowledge-head-tools">
              {hasDocStage && (
                <button
                  type="button"
                  className="kb-icon-btn"
                  title="返回知识库概览与模板页（后台文档保持打开）"
                  aria-label="返回知识库概览"
                  onClick={() => split.showOverview(true)}
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
              <SidebarCollapseButton
                collapsed={false}
                onClick={toggleSidebarCollapsed}
                title="收起侧边栏 (快捷键 Ctrl+B)"
                ariaLabel="收起侧边栏"
              />
            </div>
          </header>

          {errorMessage && (
            <div className="knowledge-error-banner" role="alert">
              {errorMessage}
            </div>
          )}

          {rootPath && (
            <div
              className="knowledge-toolbar"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  setSelectedFolder(null);
                }
              }}
            >
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
              {query.trim() && (
                <button
                  type="button"
                  className={`knowledge-search-scope${globalSearch ? ' is-active' : ''}`}
                  onClick={() => setGlobalSearch((current) => !current)}
                >
                  {globalSearch ? '搜索范围：全部来源' : '搜索范围：当前分区'}
                </button>
              )}
            </div>
          )}

          <nav className="knowledge-source-nav" aria-label="按笔记来源浏览">
            {KNOWLEDGE_SOURCE_PAGES.filter(
              ({ id }) => id !== 'unknown' || sourceCounts.unknown > 0,
            ).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`knowledge-source-tab${activeSource === id ? ' is-active' : ''}`}
                aria-current={activeSource === id ? 'page' : undefined}
                onClick={() => void selectSource(id)}
              >
                <span>{label}</span>
                <small>{sourceCounts[id]}</small>
              </button>
            ))}
          </nav>

          <div
            className="knowledge-groups"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setSelectedFolder(null);
              }
            }}
          >
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
                {folderTree.map((node) => renderFolderNode(node))}

                {folderTree.length === 0 && (
                  <div
                    className="knowledge-sidebar-empty"
                    onMouseDown={() => setSelectedFolder(null)}
                  >
                    <p>
                      {query.trim()
                        ? '没有匹配的笔记或分类'
                        : activeSource === 'manual'
                          ? '暂无我的笔记，可点击右下角 + 新建笔记或文件夹。'
                          : '当前来源暂无笔记。'}
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

          {rootPath && (
            <div className="knowledge-fab-container" ref={fabContainerRef}>
              {(fabMenuOpen || creatingCategory) && (
                <div
                  className="knowledge-fab-popover"
                  role="dialog"
                  aria-label="新建笔记或文件夹"
                >
                  <div className="knowledge-fab-context-bar">
                    <div className="knowledge-fab-context-main">
                      <span
                        className={`knowledge-fab-context-dot${effectiveSelectedFolder ? ' is-scoped' : ''}`}
                        aria-hidden="true"
                      />
                      <span className="knowledge-fab-context-label">
                        {effectiveSelectedFolder ? (
                          <>
                            目标目录：<strong>{effectiveSelectedFolder}</strong>
                          </>
                        ) : (
                          <>
                            目标位置：<strong>根目录（顶级）</strong>
                          </>
                        )}
                      </span>
                    </div>
                    {effectiveSelectedFolder && (
                      <button
                        type="button"
                        className="knowledge-fab-clear-sel"
                        title="清除目录选中状态，切换为根目录新建"
                        onClick={() => setSelectedFolder(null)}
                      >
                        × 置空
                      </button>
                    )}
                  </div>

                  {creatingCategory ? (
                    <form
                      className="knowledge-fab-folder-form"
                      onSubmit={(event) => void submitCategory(event)}
                    >
                      <div className="knowledge-fab-folder-prefix">
                        <FolderPlusIcon />
                        <span>
                          {effectiveSelectedFolder
                            ? `${effectiveSelectedFolder} /`
                            : '根目录 /'}
                        </span>
                      </div>
                      <input
                        ref={categoryInputRef}
                        type="text"
                        className="knowledge-fab-folder-input"
                        value={categoryInput}
                        maxLength={80}
                        placeholder={
                          effectiveSelectedFolder
                            ? '输入子文件夹名称（支持 a/b）…'
                            : '输入全新根目录名称（支持 a/b）…'
                        }
                        aria-label="新文件夹名称"
                        disabled={categorySubmitting}
                        onChange={(event) =>
                          setCategoryInput(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            setCreatingCategory(false);
                            setCategoryInput('');
                          }
                        }}
                      />
                      <div className="knowledge-category-form-actions">
                        <button
                          type="button"
                          className="kb-mini-btn"
                          onClick={() => {
                            setCreatingCategory(false);
                            setCategoryInput('');
                          }}
                        >
                          返回
                        </button>
                        <button
                          type="submit"
                          className="kb-mini-btn is-primary"
                          disabled={!categoryInput.trim() || categorySubmitting}
                        >
                          {effectiveSelectedFolder
                            ? '创建子目录'
                            : '创建根目录'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="knowledge-fab-actions-list">
                        <button
                          type="button"
                          className="knowledge-fab-action-item"
                          onClick={() => handleCreateNoteFromFab()}
                        >
                          <span className="knowledge-fab-action-icon">
                            <NoteIcon />
                          </span>
                          <span className="knowledge-fab-action-body">
                            <strong>新建笔记</strong>
                            <span>
                              在「{effectiveFolder}」下创建 Markdown 文档
                            </span>
                          </span>
                          <span
                            className="knowledge-fab-action-arrow"
                            aria-hidden="true"
                          >
                            →
                          </span>
                        </button>

                        <button
                          type="button"
                          className="knowledge-fab-action-item"
                          onClick={() => setCreatingCategory(true)}
                        >
                          <span className="knowledge-fab-action-icon is-folder">
                            <FolderPlusIcon />
                          </span>
                          <span className="knowledge-fab-action-body">
                            <strong>
                              {effectiveSelectedFolder
                                ? '新建子文件夹'
                                : '新建根目录文件夹'}
                            </strong>
                            <span>
                              {effectiveSelectedFolder
                                ? `在「${effectiveSelectedFolder}」下生成子目录`
                                : '当前未选中目录，生成全新顶级目录'}
                            </span>
                          </span>
                          <span
                            className="knowledge-fab-action-arrow"
                            aria-hidden="true"
                          >
                            →
                          </span>
                        </button>
                      </div>

                      <div
                        className="knowledge-fab-template-drawer"
                        aria-label="从模板快速新建笔记"
                      >
                        <div className="knowledge-fab-template-head">
                          <span>从模板快速起笔</span>
                          <small>{effectiveFolder}</small>
                        </div>
                        <div className="knowledge-fab-templates">
                          {KNOWLEDGE_NOTE_TEMPLATES.map((template) => (
                            <button
                              key={template.id}
                              type="button"
                              className="knowledge-fab-template-chip"
                              title={`${template.description}（新建至 ${effectiveFolder}）`}
                              onClick={() => handleCreateNoteFromFab(template)}
                            >
                              {template.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="knowledge-fab-trigger-row">
                {effectiveSelectedFolder &&
                  !fabMenuOpen &&
                  !creatingCategory && (
                    <button
                      type="button"
                      className="knowledge-fab-scope-pill"
                      title={`当前已选中「${effectiveSelectedFolder}」，点击取消选中恢复根目录状态`}
                      onClick={() => setSelectedFolder(null)}
                    >
                      <FolderIcon />
                      <span>{effectiveSelectedFolder}</span>
                      <i aria-hidden="true">×</i>
                    </button>
                  )}

                <button
                  type="button"
                  className={`knowledge-fab-btn${fabMenuOpen || creatingCategory ? ' is-open' : ''}${effectiveSelectedFolder ? ' is-scoped' : ''}`}
                  title={
                    effectiveSelectedFolder
                      ? `新建笔记或在「${effectiveSelectedFolder}」下新建子目录`
                      : '新建笔记或全新根目录文件夹'
                  }
                  aria-label="新建笔记或文件夹"
                  aria-expanded={fabMenuOpen || creatingCategory}
                  onClick={() => {
                    if (creatingCategory) {
                      setCreatingCategory(false);
                      setFabMenuOpen(false);
                    } else {
                      setFabMenuOpen((open) => !open);
                    }
                  }}
                >
                  <PlusIcon />
                </button>
              </div>
            </div>
          )}

          {folderContextMenu &&
            createPortal(
              <div
                ref={folderContextMenuRef}
                className="knowledge-folder-context-menu"
                role="menu"
                aria-label={`文件夹 ${folderContextMenu.path} 操作菜单`}
                style={{
                  left: `${folderContextMenu.x}px`,
                  top: `${folderContextMenu.y}px`,
                }}
              >
                <div className="knowledge-folder-context-head">
                  <FolderIcon />
                  <span>{folderContextMenu.path}</span>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const targetPath = folderContextMenu.path;
                    setFolderContextMenu(null);
                    setSelectedFolder(targetPath);
                    onCreateNote(targetPath);
                  }}
                >
                  <NoteIcon />
                  <span>在此新建笔记</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const targetPath = folderContextMenu.path;
                    setFolderContextMenu(null);
                    setSelectedFolder(targetPath);
                    setFabMenuOpen(true);
                    setCreatingCategory(true);
                  }}
                >
                  <FolderPlusIcon />
                  <span>在此新建子文件夹…</span>
                </button>
                {onRenameFolder && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() =>
                      openFolderRenameModal(
                        folderContextMenu.path,
                        folderContextMenu.name,
                      )
                    }
                  >
                    <FolderIcon />
                    <span>重命名文件夹…</span>
                  </button>
                )}
                <div
                  className="knowledge-folder-context-sep"
                  role="separator"
                />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setFolderContextMenu(null);
                    setSelectedFolder(null);
                  }}
                >
                  <span>取消选中（恢复根目录态）</span>
                </button>
              </div>,
              document.body,
            )}

          {renamingFolder &&
            createPortal(
              <div
                className="knowledge-rename-modal-backdrop"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget && !renamePending) {
                    setRenamingFolder(null);
                  }
                }}
              >
                <form
                  className="knowledge-rename-modal-card"
                  onSubmit={(event) => void submitFolderRename(event)}
                >
                  <h3>重命名文件夹</h3>
                  <p className="knowledge-rename-modal-path">
                    当前路径：{renamingFolder.path}
                  </p>
                  <input
                    ref={renameInputRef}
                    type="text"
                    className="knowledge-rename-modal-input"
                    value={renameValue}
                    maxLength={80}
                    disabled={renamePending}
                    placeholder="输入新的文件夹名称"
                    aria-label="新的文件夹名称"
                    onChange={(event) => {
                      setRenameValue(event.target.value);
                      if (renameError) setRenameError('');
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && !renamePending) {
                        event.stopPropagation();
                        setRenamingFolder(null);
                      }
                    }}
                  />
                  {renameError && (
                    <p className="knowledge-rename-modal-error" role="alert">
                      {renameError}
                    </p>
                  )}
                  <div className="knowledge-rename-modal-actions">
                    <button
                      type="button"
                      className="kb-mini-btn"
                      disabled={renamePending}
                      onClick={() => setRenamingFolder(null)}
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="kb-mini-btn is-primary"
                      disabled={!renameValue.trim() || renamePending}
                    >
                      {renamePending ? '重命名中…' : '确认重命名'}
                    </button>
                  </div>
                </form>
              </div>,
              document.body,
            )}

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
            onPointerLeave={() => undefined}
            onLostPointerCapture={(event) => finishResize(event.pointerId)}
            onDoubleClick={resetSidebarWidth}
          />
        </aside>
      )}

      <main className="knowledge-main">
        {rootPath && splitState.tabs.length > 0 && (
          <header
            className="kb-split-topbar"
            aria-label="已打开文档标签与分屏栏"
          >
            <button
              type="button"
              className={`kb-overview-tab-btn${splitState.showHomeOverview ? ' is-active' : ''}`}
              aria-pressed={splitState.showHomeOverview}
              title={
                splitState.showHomeOverview
                  ? '返回已打开的文档阅读区'
                  : '切回知识库概览（已打开文档保持活跃）'
              }
              onClick={() => split.showOverview(!splitState.showHomeOverview)}
            >
              <HomeOverviewIcon />
              <span>概览</span>
            </button>

            <div className="kb-tab-strip" role="tablist" aria-label="文档标签">
              {splitState.tabs.map((tab, idx) => {
                const doc = split.documentsByPath[tab.path] ?? null;
                const dirty = doc ? isDirty(doc) : false;
                const paneSlots = activePanePaths.reduce<number[]>(
                  (acc, p, slotIdx) => {
                    if (p === tab.path) acc.push(slotIdx);
                    return acc;
                  },
                  [],
                );
                const isFocusedTab =
                  !splitState.showHomeOverview &&
                  split.focusedPath === tab.path;
                const isSplitTab =
                  !splitState.showHomeOverview &&
                  !isFocusedTab &&
                  paneSlots.length > 0;
                const shortcutLabel = idx < 9 ? ` · Alt+${idx + 1}` : '';

                return (
                  <div
                    key={tab.path}
                    className={`kb-doc-tab${isFocusedTab ? ' is-focused' : ''}${isSplitTab ? ' is-split-visible' : ''}${dirty ? ' is-dirty' : ''}`}
                    role="tab"
                    aria-selected={isFocusedTab}
                    title={`${tab.title}\n${tab.path}${dirty ? ' (未保存)' : ''}\n点击切换 · Alt+点击分栏打开 · 中键关闭${shortcutLabel}`}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      event.stopPropagation();
                      void split.closeTab(tab.path);
                    }}
                  >
                    <button
                      type="button"
                      className="kb-doc-tab-main"
                      onClick={(event) => {
                        if (event.altKey || event.ctrlKey || event.metaKey) {
                          if (paneSlots.length > 0) {
                            split.focusPane(paneSlots[0]);
                          } else {
                            split.splitOutPane(
                              split.safeFocusedPaneIndex,
                              'next-or-empty',
                            );
                            const nextStateCount = Math.min(
                              4,
                              visibleKnowledgePaneCount(
                                splitState.splitMode,
                              ) === 1
                                ? 2
                                : visibleKnowledgePaneCount(
                                    splitState.splitMode,
                                  ) + 1,
                            );
                            const nextSlot = Math.max(
                              0,
                              Math.min(
                                nextStateCount - 1,
                                activePanePaths.indexOf(null) >= 0
                                  ? activePanePaths.indexOf(null)
                                  : split.safeFocusedPaneIndex + 1,
                              ),
                            );
                            split.assignTab(nextSlot, tab.path);
                          }
                          return;
                        }
                        if (
                          !splitState.showHomeOverview &&
                          paneSlots.length > 0
                        ) {
                          split.focusPane(paneSlots[0]);
                          return;
                        }
                        split.assignTab(split.safeFocusedPaneIndex, tab.path);
                      }}
                    >
                      {dirty && (
                        <span
                          className="kb-tab-dirty-dot"
                          aria-label="未保存"
                        />
                      )}
                      {visibleCount > 1 && paneSlots.length > 0 && (
                        <span className="kb-tab-pane-badge">
                          {paneSlots.map((slot) => `P${slot + 1}`).join('·')}
                        </span>
                      )}
                      <span className="kb-doc-tab-title">
                        {doc?.title ?? tab.title}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="kb-doc-tab-close"
                      aria-label={`关闭文档 ${doc?.title ?? tab.title}`}
                      title="关闭此文档标签（自动保存未落盘内容）"
                      onClick={(event) => {
                        event.stopPropagation();
                        void split.closeTab(tab.path);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="kb-split-controls">
              {split.anyDirty && (
                <button
                  type="button"
                  className="kb-save-all-btn"
                  title="立即保存全部未落盘的已打开文档"
                  onClick={() => void split.saveAll(true)}
                >
                  全部保存
                </button>
              )}

              <div
                className="kb-layout-icons"
                role="group"
                aria-label="多文档分屏布局"
              >
                {(
                  [
                    ['single', '单窗格专注阅读'],
                    ['vertical', '左右并排双开对比'],
                    ['horizontal', '上下并排双开对比'],
                    ['tri', '三窗格布局（左主 + 右上下）'],
                    ['quad', '四宫格多开（同时阅读 4 篇）'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`kb-layout-btn${!isStageZoomed && splitState.splitMode === mode ? ' is-active' : ''}`}
                    title={label}
                    aria-label={label}
                    aria-pressed={
                      !isStageZoomed && splitState.splitMode === mode
                    }
                    onClick={() => split.switchLayout(mode)}
                  >
                    <SplitLayoutIcon mode={mode} />
                  </button>
                ))}
              </div>

              {visibleCount > 1 && (
                <>
                  <button
                    type="button"
                    className={`kb-sync-scroll-btn${syncScrollEnabled ? ' is-active' : ''}`}
                    title={
                      syncScrollEnabled
                        ? '已开启多窗格同步滚动（点击关闭）'
                        : '开启多窗格按比例同步滚动'
                    }
                    aria-label="多窗格同步滚动"
                    aria-pressed={syncScrollEnabled}
                    onClick={() => setSyncScrollEnabled((v) => !v)}
                  >
                    <span>联动滚动</span>
                  </button>
                  <button
                    type="button"
                    className={`kb-layout-btn kb-zoom-btn${isStageZoomed ? ' is-active' : ''}`}
                    title={
                      isStageZoomed
                        ? '还原多窗格分屏 (Ctrl+Shift+M)'
                        : '临时全屏放大当前聚焦窗格 (Ctrl+Shift+M)'
                    }
                    aria-label="放大或还原分屏窗格"
                    aria-pressed={isStageZoomed}
                    onClick={() => split.toggleZoom()}
                  >
                    <ZoomPaneIcon zoomed={isStageZoomed} />
                  </button>
                </>
              )}
            </div>
          </header>
        )}

        {hasDocStage ? (
          <section
            ref={splitStageRef}
            className={`kb-split-stage is-${isStageZoomed ? 'single' : splitState.splitMode}${isStageZoomed ? ' is-zoomed' : ''}${showPaneHeaders ? '' : ' is-headerless'}`}
            aria-label="知识库多文档阅读分屏画布"
            style={
              {
                '--kb-primary-pane-size': `${splitState.splitRatio}fr`,
                '--kb-secondary-pane-size': `${1 - splitState.splitRatio}fr`,
              } as CSSProperties
            }
          >
            {showPaneHeaders &&
              visiblePaneIndices.map((paneIdx) => {
                const panePath = activePanePaths[paneIdx] ?? null;
                const paneDoc = panePath
                  ? (split.documentsByPath[panePath] ?? null)
                  : null;
                const isPaneFocused = paneIdx === split.safeFocusedPaneIndex;
                const paneDirty = paneDoc ? isDirty(paneDoc) : false;
                const switcherOpen = openSwitcherPane === paneIdx;
                const activePaneTitle =
                  paneDoc?.title ??
                  splitState.tabs.find((t) => t.path === panePath)?.title ??
                  '选择文档…';

                return (
                  <div
                    key={`kb-header-${paneIdx}`}
                    className={`kb-pane-header pane-header-${paneIdx}${isPaneFocused ? ' is-focused' : ''}${switcherOpen ? ' has-open-menu' : ''}`}
                    style={{ gridArea: `header${paneIdx}` }}
                    onMouseDown={() => split.focusPane(paneIdx)}
                  >
                    <div className="kb-pane-header-left">
                      <span
                        className={`kb-pane-status-dot${paneDirty ? ' is-dirty' : paneDoc ? ' is-ready' : ''}`}
                        aria-hidden="true"
                      />
                      <span
                        className={`kb-pane-badge${isPaneFocused ? ' is-focused' : ''}`}
                      >
                        P{paneIdx + 1}
                      </span>
                      <div
                        className="kb-pane-switcher"
                        ref={switcherOpen ? switcherMenuRef : undefined}
                      >
                        <button
                          type="button"
                          className={`kb-pane-switcher-trigger${switcherOpen ? ' is-open' : ''}${!panePath ? ' is-placeholder' : ''}`}
                          aria-haspopup="listbox"
                          aria-expanded={switcherOpen}
                          aria-label={`窗格 ${paneIdx + 1} 文档切换`}
                          title={
                            paneDoc
                              ? `${paneDoc.title}\n${paneDoc.relativePath}`
                              : `为窗格 P${paneIdx + 1} 选择文档`
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            split.focusPane(paneIdx);
                            setOpenSwitcherPane((curr) =>
                              curr === paneIdx ? null : paneIdx,
                            );
                          }}
                        >
                          <span className="kb-pane-switcher-label">
                            {activePaneTitle}
                          </span>
                          <ChevronDownIcon />
                        </button>

                        {switcherOpen && (
                          <div
                            className="kb-pane-switcher-menu"
                            role="listbox"
                            aria-label={`选择窗格 P${paneIdx + 1} 的已打开文档`}
                            onMouseDown={(event) => event.stopPropagation()}
                          >
                            <div className="kb-pane-switcher-head">
                              <span>切换窗格 P{paneIdx + 1} 文档</span>
                              <span>{splitState.tabs.length} 篇已开</span>
                            </div>
                            <div className="kb-pane-switcher-list">
                              {splitState.tabs.map((tab) => {
                                const doc = split.documentsByPath[tab.path];
                                const itemDirty = doc ? isDirty(doc) : false;
                                const isCurrent = panePath === tab.path;
                                const otherSlots = activePanePaths.reduce<
                                  number[]
                                >((acc, p, slotIdx) => {
                                  if (slotIdx !== paneIdx && p === tab.path) {
                                    acc.push(slotIdx);
                                  }
                                  return acc;
                                }, []);
                                return (
                                  <button
                                    key={tab.path}
                                    type="button"
                                    role="option"
                                    aria-selected={isCurrent}
                                    className={`kb-pane-switcher-option${isCurrent ? ' is-selected' : ''}`}
                                    onClick={() => {
                                      split.assignTab(paneIdx, tab.path);
                                      setOpenSwitcherPane(null);
                                    }}
                                  >
                                    <span
                                      className={`kb-pane-switcher-dot${itemDirty ? ' is-dirty' : isCurrent ? ' is-selected' : ''}`}
                                      aria-hidden="true"
                                    />
                                    <div className="kb-pane-switcher-text">
                                      <strong>{doc?.title ?? tab.title}</strong>
                                      <span>{tab.path}</span>
                                    </div>
                                    <div className="kb-pane-switcher-tags">
                                      {otherSlots.length > 0 && (
                                        <span className="kb-pane-switcher-slot-tag">
                                          {otherSlots
                                            .map((s) => `P${s + 1}`)
                                            .join('·')}
                                        </span>
                                      )}
                                      {isCurrent && (
                                        <span className="kb-pane-switcher-current">
                                          当前
                                        </span>
                                      )}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                            {panePath && (
                              <div className="kb-pane-switcher-footer">
                                <button
                                  type="button"
                                  className="kb-pane-switcher-clear"
                                  onClick={() => {
                                    split.assignTab(paneIdx, null);
                                    setOpenSwitcherPane(null);
                                  }}
                                >
                                  置空此窗格（重新选文）
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="kb-pane-header-actions">
                      {paneDoc && (
                        <button
                          type="button"
                          className="kb-pane-mini-btn"
                          title="将同一篇文档拆开对照阅读（左编右读 / 上下比对）"
                          aria-label="同篇分栏对照"
                          onClick={(event) => {
                            event.stopPropagation();
                            split.splitOutPane(paneIdx, 'mirror');
                          }}
                        >
                          <SplitColumnsIcon />
                          <span>对照</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="kb-pane-mini-btn"
                        title="放大此窗格 (Ctrl+Shift+M)"
                        aria-label={`放大窗格 ${paneIdx + 1}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          split.toggleZoom(paneIdx);
                        }}
                      >
                        <ZoomPaneIcon zoomed={false} />
                      </button>
                      <button
                        type="button"
                        className="kb-pane-mini-btn is-close"
                        title="关闭此分屏窗格（文档继续保留在顶部标签栏）"
                        aria-label={`关闭窗格 ${paneIdx + 1}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          split.closePaneSlot(paneIdx);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}

            {visiblePaneIndices.map((paneIdx) => {
              const panePath = activePanePaths[paneIdx] ?? null;
              const paneDoc = panePath
                ? (split.documentsByPath[panePath] ?? null)
                : null;
              const isPaneFocused = paneIdx === split.safeFocusedPaneIndex;
              const controlledViewMode = showPaneHeaders
                ? (splitState.paneViewModes[paneIdx] ??
                  defaultCompactPaneViewMode(paneIdx))
                : undefined;

              return (
                <div
                  key={`kb-pane-${paneIdx}`}
                  className={`kb-pane-body kb-pane-${paneIdx}${isPaneFocused ? ' is-focused' : ''}`}
                  style={{
                    gridArea: isStageZoomed ? 'pane0' : `pane${paneIdx}`,
                  }}
                  onMouseDownCapture={() => split.focusPane(paneIdx)}
                >
                  {paneDoc ? (
                    <DocumentWorkbench
                      document={paneDoc}
                      dirty={isDirty(paneDoc)}
                      statusText={workbench.statusText}
                      theme={workbench.theme}
                      documents={documents}
                      categories={categories}
                      paneKey={`kb-pane-${paneIdx}`}
                      compactSplit={showPaneHeaders}
                      controlledViewMode={controlledViewMode}
                      onViewModeChange={
                        showPaneHeaders
                          ? (mode) => split.setPaneViewMode(paneIdx, mode)
                          : undefined
                      }
                      renderMarkdownPreview={workbench.renderMarkdownPreview}
                      onSourceChange={(source) =>
                        split.editDoc(paneDoc.relativePath, source)
                      }
                      onSave={() =>
                        void split.saveDoc(paneDoc.relativePath, true)
                      }
                      onRename={(title) =>
                        split.renameDoc(paneDoc.relativePath, title)
                      }
                      onChangeCategory={(category) =>
                        split.setCategoryDoc(paneDoc.relativePath, category)
                      }
                      onChangeTags={(tags) =>
                        split.setTagsDoc(paneDoc.relativePath, tags)
                      }
                      onOpenWikilink={workbench.onOpenWikilink}
                      onOpenYouTubeLink={workbench.onOpenYouTubeLink}
                      onRunInTerminal={workbench.onRunInTerminal}
                      onOpenAsMindmap={() =>
                        workbench.onOpenAsMindmap?.(paneDoc.relativePath)
                      }
                      onConvertToMindmap={() =>
                        workbench.onConvertToMindmap?.(paneDoc.relativePath)
                      }
                    />
                  ) : (
                    <div className="kb-pane-empty-slot">
                      <div className="kb-pane-empty-card">
                        <span className="knowledge-kicker">
                          SPLIT PANE {paneIdx + 1}
                        </span>
                        <h3>选择要在此窗格阅读的文档</h3>
                        <p>
                          可直接点击左侧目录树中的任意笔记（将自动打开到此聚焦窗格），或从下面快速选取：
                        </p>

                        {splitState.tabs.length > 0 && (
                          <div className="kb-pane-empty-group">
                            <span className="kb-pane-empty-label">
                              已打开文档（支持同篇对照）
                            </span>
                            <div className="kb-pane-empty-chips">
                              {splitState.tabs.map((tab) => (
                                <button
                                  key={tab.path}
                                  type="button"
                                  className="kb-pane-pick-chip"
                                  onClick={() =>
                                    split.assignTab(paneIdx, tab.path)
                                  }
                                >
                                  <span>{tab.title}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {docNotes.length > 0 && (
                          <div className="kb-pane-empty-group">
                            <span className="kb-pane-empty-label">
                              最近文档
                            </span>
                            <div className="kb-pane-empty-list">
                              {docNotes.slice(0, 6).map((note) => (
                                <button
                                  key={note.relativePath}
                                  type="button"
                                  className="kb-pane-recent-btn"
                                  onClick={() =>
                                    onOpenNote(note, {
                                      split: true,
                                      targetPaneIndex: paneIdx,
                                    })
                                  }
                                >
                                  <strong>{note.title}</strong>
                                  <span>
                                    {note.category || UNFILED_FOLDER} ·{' '}
                                    {formatRelativeDate(note.updatedAt)}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="kb-pane-empty-actions">
                          <button
                            type="button"
                            className="knowledge-cta-btn"
                            onClick={() =>
                              onCreateNote(effectiveFolder, undefined, paneIdx)
                            }
                          >
                            <PlusIcon />
                            <span>在此窗格新建笔记</span>
                          </button>
                          <button
                            type="button"
                            className="knowledge-secondary-btn"
                            onClick={() => split.closePaneSlot(paneIdx)}
                          >
                            关闭空窗格
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {!isStageZoomed &&
              (splitState.splitMode === 'vertical' ||
                splitState.splitMode === 'horizontal' ||
                splitState.splitMode === 'tri') && (
                <div
                  className={`kb-pane-divider${isDraggingSplitRatio ? ' is-dragging' : ''}`}
                  role="separator"
                  aria-orientation={
                    splitState.splitMode === 'horizontal'
                      ? 'horizontal'
                      : 'vertical'
                  }
                  onPointerDown={(event) => {
                    const container = event.currentTarget.parentElement;
                    if (!container) return;
                    const rect = container.getBoundingClientRect();
                    const isHorizontal = splitState.splitMode === 'horizontal';
                    setIsDraggingSplitRatio(true);
                    const onPointerMove = (moveEvent: PointerEvent) => {
                      const ratio = isHorizontal
                        ? (moveEvent.clientY - rect.top - 26) /
                          Math.max(1, rect.height - 52)
                        : (moveEvent.clientX - rect.left) /
                          Math.max(1, rect.width);
                      split.setSplitRatio(ratio);
                    };
                    const onPointerUp = () => {
                      setIsDraggingSplitRatio(false);
                      window.removeEventListener('pointermove', onPointerMove);
                      window.removeEventListener('pointerup', onPointerUp);
                    };
                    window.addEventListener('pointermove', onPointerMove);
                    window.addEventListener('pointerup', onPointerUp, {
                      once: true,
                    });
                  }}
                  onDoubleClick={() => split.setSplitRatio(0.5)}
                  title="拖拽调整分屏比例，双击还原 50:50 均分"
                >
                  <span className="kb-divider-handle" />
                  <span className="kb-divider-ratio-badge">
                    {Math.round(splitState.splitRatio * 100)}∶
                    {100 - Math.round(splitState.splitRatio * 100)}
                  </span>
                </div>
              )}
          </section>
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
        ) : query.trim() ? (
          <div className="knowledge-source-home">
            <header className="knowledge-source-home-head">
              <div>
                <span className="knowledge-kicker">
                  SEARCH / {globalSearch ? 'ALL' : activeSource.toUpperCase()}
                </span>
                <h2>
                  {globalSearch
                    ? '全库搜索'
                    : `${KNOWLEDGE_SOURCE_PAGES.find((page) => page.id === activeSource)?.label} · 搜索`}
                </h2>
                <p>关键词：{query.trim()}</p>
              </div>
              <span className="knowledge-source-total">
                {visibleNoteCount} 篇
              </span>
            </header>
            <div className="knowledge-source-home-list">
              {visibleNoteCount === 0 ? (
                <div className="knowledge-source-empty">没有匹配的文档。</div>
              ) : (
                groups.flatMap((group) =>
                  group.notes.map((note) => (
                    <button
                      type="button"
                      className="knowledge-source-recent"
                      key={note.relativePath}
                      onClick={(event) =>
                        onOpenNote(note, {
                          split: event.altKey || event.ctrlKey || event.metaKey,
                        })
                      }
                    >
                      <span className="knowledge-source-recent-title">
                        {note.title}
                      </span>
                      <span className="knowledge-source-recent-meta">
                        {group.name} · {formatRelativeDate(note.updatedAt)}
                      </span>
                    </button>
                  )),
                )
              )}
            </div>
          </div>
        ) : activeSource !== 'manual' ? (
          <div className="knowledge-source-home">
            <header className="knowledge-source-home-head">
              <div>
                <span className="knowledge-kicker">
                  SOURCE / {activeSource.toUpperCase()}
                </span>
                <h2>
                  {
                    KNOWLEDGE_SOURCE_PAGES.find(
                      (page) => page.id === activeSource,
                    )?.label
                  }
                </h2>
                <p>
                  {activeSource === 'ebook'
                    ? '按书籍汇集阅读笔记与章节记录。可从电子书阅读器继续创建。'
                    : activeSource === 'player'
                      ? '按频道汇集字幕文稿与视频笔记。可从播放器导出新文稿。'
                      : '来源信息尚不明确的旧文档保留在原路径，等待核对。'}
                </p>
              </div>
              <span className="knowledge-source-total">
                {sourceNotes.length} 篇
              </span>
            </header>
            <div className="knowledge-source-home-list">
              {sourceNotes.length === 0 ? (
                <div className="knowledge-source-empty">
                  当前分区还没有文档。
                </div>
              ) : (
                sourceNotes.slice(0, 24).map((note) => (
                  <button
                    type="button"
                    className="knowledge-source-recent"
                    key={note.relativePath}
                    onClick={(event) =>
                      onOpenNote(note, {
                        split: event.altKey || event.ctrlKey || event.metaKey,
                      })
                    }
                  >
                    <span className="knowledge-source-recent-title">
                      {note.title}
                    </span>
                    <span className="knowledge-source-recent-meta">
                      {note.category || UNFILED_FOLDER} ·{' '}
                      {formatRelativeDate(note.updatedAt)}
                    </span>
                  </button>
                ))
              )}
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
                  <h2>我的笔记</h2>
                  <div className="knowledge-metrics-strip">
                    <span>
                      <strong>{sourceNotes.length}</strong> 篇笔记
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

              <KnowledgeHeatmap
                rootPath={rootPath}
                documents={documents}
                onOpenNote={onOpenNote}
              />

              <div className="knowledge-home-grid">
                <section
                  className="knowledge-home-panel"
                  aria-label="最近编辑的笔记"
                >
                  <div className="knowledge-panel-head">
                    <h3>最近编辑</h3>
                    <span>
                      {sourceNotes.length > 0
                        ? `按更新时间排序 · 共 ${sourceNotes.length} 篇`
                        : '尚无笔记'}
                    </span>
                  </div>

                  {sourceNotes.length === 0 ? (
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
                      {sourceNotes.slice(0, 8).map((note) => (
                        <button
                          key={note.relativePath}
                          type="button"
                          className="knowledge-recent-item"
                          onClick={(event) =>
                            onOpenNote(note, {
                              split:
                                event.altKey || event.ctrlKey || event.metaKey,
                            })
                          }
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
                <span>
                  <kbd>Alt+点击</kbd> / <kbd>Ctrl+\</kbd> 分栏对比阅读
                </span>
              </footer>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
