import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { CodeLabAppearancePanel } from '../CodeLabAppearancePanel';
import { CodeLabDataPanel } from '../CodeLabDataPanel';
import { CodeLabEnvPanel } from '../CodeLabEnvPanel';
import {
  LabChevronDownIcon,
  LabChevronRightIcon,
  LabCloseIcon,
  LabStarIcon,
} from '../CodeLabIcons';
import type { DataBusInfo, PythonEnvInfo, REnvInfo } from '../terminal-api';
import {
  UNCATEGORIZED_CODELAB_FOLDER,
  type CodeLabSavedFile,
  type DataLabBaseProfile,
  type DataLabCustomEnvPaths,
  type DataLabDbConnection,
  type DataLabMountedFile,
} from '../terminal-codelab-model';
import type { TerminalCodeLabLanguage, TerminalTab } from '../terminal-types';

type EditorSettingsTab = 'data' | 'envs' | 'style';

const NOTE_LANGUAGE_OPTIONS: ReadonlyArray<
  readonly [TerminalCodeLabLanguage, string, string]
> = [
  ['python', 'Python 笔记', 'PY'],
  ['sql', 'SQL 数据笔记', 'SQL'],
  ['r', 'R 统计笔记', 'R'],
  ['c', 'C 语言笔记', 'C'],
  ['cpp', 'C++ 实验笔记', 'C++'],
];

export interface GroupedNotebookFolder {
  folder: string;
  items: CodeLabSavedFile[];
}

export interface EditorWorkspaceSidebarProps {
  groupedFiles: GroupedNotebookFolder[];
  collapsedFolders: Record<string, boolean>;
  onToggleFolder: (folder: string) => void;
  onSetAllFoldersCollapsed: (collapsed: boolean) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  filter: 'all' | TerminalCodeLabLanguage | 'starred';
  onFilterChange: (next: 'all' | TerminalCodeLabLanguage | 'starred') => void;
  activeFileId: string | null;
  tabs: TerminalTab[];
  labInfoByTab: Record<
    string,
    { fileId: string | null; dirty?: boolean } | undefined
  >;
  onCreateNotebook: (lang: TerminalCodeLabLanguage, folder?: string) => void;
  onCreateFolder: (name: string) => boolean;
  onRenameFolder: (oldName: string, newName: string) => boolean;
  onDeleteFolder: (name: string) => void;
  onMoveFileToFolder: (fileId: string, targetFolder: string) => void;
  onOpenFile: (
    file: CodeLabSavedFile,
    placement?: 'tab' | 'right' | 'window',
  ) => void;
  onDuplicateFile: (file: CodeLabSavedFile) => void;
  onToggleStarFile: (fileId: string) => void;
  onDeleteFile: (fileId: string) => void;
  // Data & Env props for unified Settings panel
  mountedDataFiles: DataLabMountedFile[];
  dbConnections: DataLabDbConnection[];
  pythonEnvs: PythonEnvInfo[];
  rEnvs: REnvInfo[];
  baseProfile: DataLabBaseProfile;
  busInfo: DataBusInfo | null;
  selectedPythonRuntime: string;
  selectedRRuntime: string;
  customEnvPaths: DataLabCustomEnvPaths;
  envsLoading: boolean;
  onUpdateDataFiles: (next: DataLabMountedFile[]) => void;
  onUpdateDbConnections: (next: DataLabDbConnection[]) => void;
  onInsertDataCell: (
    language: TerminalCodeLabLanguage,
    source: string,
    autoRun: boolean,
    sqlConnectionId?: string,
  ) => void;
  onRefreshEnvs: () => void;
  onRefreshBus: () => void;
  onSaveBaseProfile: (next: DataLabBaseProfile) => void;
  onSelectPythonRuntime: (runtime: string) => void;
  onSelectRRuntime: (rscriptPath: string) => void;
  onActivateInTerminal: (cmd: string) => void;
  onUpdateCustomEnvPaths: (next: DataLabCustomEnvPaths) => void;
  onNotify: (message: string) => void;
}

function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
        <path d="M1.8 4.2a1.2 1.2 0 0 1 1.2-1.2h3.1l1.3 1.5H13a1.2 1.2 0 0 1 1.2 1.2v.8H3.4L2 12.2A1 1 0 0 1 1.8 11.6V4.2Zm1.6 2.3h10.8l-1.2 5.4a1.1 1.1 0 0 1-1.1.9H2.5a.8.8 0 0 1-.8-1l1.7-5.3Z" />
      ) : (
        <path d="M2 4a1.2 1.2 0 0 1 1.2-1.2h3.1l1.4 1.5H12.8A1.2 1.2 0 0 1 14 5.5v6.3a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V4Z" />
      )}
    </svg>
  );
}

function FolderPlusGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4a1.2 1.2 0 0 1 1.2-1.2h3l1.3 1.4h5.3A1.2 1.2 0 0 1 14 5.4v6.4a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V4Z" />
      <path d="M8 7v3.6M6.2 8.8h3.6" />
    </svg>
  );
}

function NotebookGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 2.2h6l2.8 2.8v8.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.2a1 1 0 0 1 1-1Z" />
      <path d="M10 2.2V5h2.8" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}

function PlusNoteGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

function RenameGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.8 2.8 13.2 5.2 5.6 12.8 2.6 13.4l.6-3 7.6-7.6Z" />
    </svg>
  );
}

function CollapseTreeGlyph({ allCollapsed }: { allCollapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {allCollapsed ? (
        <>
          <path d="M4.5 6 8 2.8 11.5 6" />
          <path d="M4.5 10 8 13.2 11.5 10" />
        </>
      ) : (
        <>
          <path d="M4.5 3.2 8 6.4 11.5 3.2" />
          <path d="M4.5 12.8 8 9.6 11.5 12.8" />
        </>
      )}
    </svg>
  );
}

function SettingsGearGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.2" />
      <path d="M13 8c0-.32-.03-.63-.1-.93l1.35-1.02-1.2-2.08-1.56.55a4.85 4.85 0 0 0-1.6-.93L9.6 2H7.2l-.3 1.59a4.85 4.85 0 0 0-1.6.93l-1.56-.55-1.2 2.08 1.35 1.02a4.9 4.9 0 0 0 0 1.86L2.54 9.95l1.2 2.08 1.56-.55c.48.4 1.02.72 1.6.93L7.2 14h2.4l.3-1.59c.58-.21 1.12-.53 1.6-.93l1.56.55 1.2-2.08-1.35-1.02c.07-.3.1-.61.1-.93Z" />
    </svg>
  );
}

function BackArrowGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.8 3.5 5.2 8l4.6 4.5" />
    </svg>
  );
}

function SplitPaneGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.2" />
      <line x1="9.2" y1="2.6" x2="9.2" y2="13.4" />
    </svg>
  );
}

function PopoutGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.5 3.5H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
      <path d="M9 2.5h4.5V7" />
      <path d="M7.5 8.5 13.5 2.5" />
    </svg>
  );
}

function formatRuntimeShortLabel(
  selectedPythonRuntime: string,
  pythonEnvs: PythonEnvInfo[],
): string {
  if (!selectedPythonRuntime || selectedPythonRuntime === 'pyodide') {
    return 'Pyodide';
  }
  const matched = pythonEnvs.find(
    (env) => env.pythonPath === selectedPythonRuntime,
  );
  if (matched?.condaEnvName) return matched.condaEnvName;
  const parts = selectedPythonRuntime
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  if (/^python(\.exe)?$/i.test(last) && parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return last || 'Python';
}

interface FileDragState {
  fileId: string;
  title: string;
  language: TerminalCodeLabLanguage;
  sourceFolder: string;
  clientX: number;
  clientY: number;
  hoverFolder: string | null;
}

const LONG_PRESS_DRAG_MS = 220;
const LONG_PRESS_MOVE_CANCEL_PX = 8;
const AUTO_EXPAND_HOVER_MS = 450;

function detectDropFolderAtPoint(
  clientX: number,
  clientY: number,
): string | null {
  if (typeof document === 'undefined' || !document.elementsFromPoint) {
    return null;
  }
  const elements = document.elementsFromPoint(clientX, clientY);
  for (const el of elements) {
    const folderEl = el.closest('[data-drop-folder]');
    if (folderEl instanceof HTMLElement && folderEl.dataset.dropFolder) {
      return folderEl.dataset.dropFolder;
    }
  }
  return null;
}

export const EditorWorkspaceSidebar = memo(function EditorWorkspaceSidebar({
  groupedFiles,
  collapsedFolders,
  onToggleFolder,
  onSetAllFoldersCollapsed,
  searchQuery,
  onSearchChange,
  filter,
  onFilterChange,
  activeFileId,
  tabs,
  labInfoByTab,
  onCreateNotebook,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveFileToFolder,
  onOpenFile,
  onDuplicateFile,
  onToggleStarFile,
  onDeleteFile,
  mountedDataFiles,
  dbConnections,
  pythonEnvs,
  rEnvs,
  baseProfile,
  busInfo,
  selectedPythonRuntime,
  selectedRRuntime,
  customEnvPaths,
  envsLoading,
  onUpdateDataFiles,
  onUpdateDbConnections,
  onInsertDataCell,
  onRefreshEnvs,
  onRefreshBus,
  onSaveBaseProfile,
  onSelectPythonRuntime,
  onSelectRRuntime,
  onActivateInTerminal,
  onUpdateCustomEnvPaths,
  onNotify,
}: EditorWorkspaceSidebarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<EditorSettingsTab>('data');
  const [searchOpen, setSearchOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [folderAddMenu, setFolderAddMenu] = useState<string | null>(null);
  const [dragState, setDragState] = useState<FileDragState | null>(null);
  const [justMovedFileId, setJustMovedFileId] = useState<string | null>(null);

  const sidebarRootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragStateRef = useRef<FileDragState | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const autoExpandTimerRef = useRef<number | null>(null);
  const autoExpandTargetRef = useRef<string | null>(null);
  const justMovedTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const collapsedFoldersRef = useRef(collapsedFolders);
  collapsedFoldersRef.current = collapsedFolders;
  const onToggleFolderRef = useRef(onToggleFolder);
  onToggleFolderRef.current = onToggleFolder;
  const onMoveFileToFolderRef = useRef(onMoveFileToFolder);
  onMoveFileToFolderRef.current = onMoveFileToFolder;

  const clearAutoExpandTimer = useCallback(() => {
    if (autoExpandTimerRef.current !== null) {
      window.clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
    autoExpandTargetRef.current = null;
  }, []);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    dragStateRef.current = dragState;
    if (typeof document !== 'undefined') {
      document.body.classList.toggle(
        'is-obsidian-file-dragging',
        Boolean(dragState),
      );
    }
  }, [dragState]);

  useEffect(() => {
    return () => {
      clearLongPressTimer();
      clearAutoExpandTimer();
      if (justMovedTimerRef.current !== null) {
        window.clearTimeout(justMovedTimerRef.current);
      }
      if (typeof document !== 'undefined') {
        document.body.classList.remove('is-obsidian-file-dragging');
      }
    };
  }, [clearAutoExpandTimer, clearLongPressTimer]);

  const handleFilePointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLButtonElement>,
      file: CodeLabSavedFile,
      sourceFolder: string,
    ) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let latestX = startX;
      let latestY = startY;
      let dragActive = false;

      clearLongPressTimer();
      clearAutoExpandTimer();

      const updateHoverAndAutoExpand = (clientX: number, clientY: number) => {
        const hoverFolder = detectDropFolderAtPoint(clientX, clientY);
        if (
          hoverFolder &&
          hoverFolder !== sourceFolder &&
          collapsedFoldersRef.current[hoverFolder]
        ) {
          if (autoExpandTargetRef.current !== hoverFolder) {
            clearAutoExpandTimer();
            autoExpandTargetRef.current = hoverFolder;
            autoExpandTimerRef.current = window.setTimeout(() => {
              if (
                dragStateRef.current &&
                autoExpandTargetRef.current === hoverFolder &&
                collapsedFoldersRef.current[hoverFolder]
              ) {
                onToggleFolderRef.current(hoverFolder);
              }
              autoExpandTimerRef.current = null;
            }, AUTO_EXPAND_HOVER_MS);
          }
        } else {
          clearAutoExpandTimer();
        }
        return hoverFolder;
      };

      const startDrag = () => {
        dragActive = true;
        suppressClickRef.current = true;
        setNewMenuOpen(false);
        setFolderAddMenu(null);
        const hoverFolder = updateHoverAndAutoExpand(latestX, latestY);
        const nextState: FileDragState = {
          fileId: file.id,
          title: file.title,
          language: file.language,
          sourceFolder,
          clientX: latestX,
          clientY: latestY,
          hoverFolder,
        };
        dragStateRef.current = nextState;
        setDragState(nextState);
      };

      const cleanupListeners = () => {
        clearLongPressTimer();
        clearAutoExpandTimer();
        window.removeEventListener('pointermove', onWindowPointerMove);
        window.removeEventListener('pointerup', onWindowPointerUp);
        window.removeEventListener('pointercancel', onWindowPointerCancel);
        window.removeEventListener('keydown', onWindowKeyDown);
      };

      const finishDrag = (commit: boolean) => {
        cleanupListeners();
        const current = dragStateRef.current;
        dragStateRef.current = null;
        setDragState(null);
        if (commit && current && current.hoverFolder) {
          if (current.hoverFolder !== current.sourceFolder) {
            onMoveFileToFolderRef.current(current.fileId, current.hoverFolder);
            setJustMovedFileId(current.fileId);
            if (justMovedTimerRef.current !== null) {
              window.clearTimeout(justMovedTimerRef.current);
            }
            justMovedTimerRef.current = window.setTimeout(() => {
              setJustMovedFileId(null);
              justMovedTimerRef.current = null;
            }, 1050);
          }
        }
        if (dragActive) {
          requestAnimationFrame(() => {
            suppressClickRef.current = false;
          });
        }
      };

      const onWindowPointerMove = (moveEvent: PointerEvent) => {
        latestX = moveEvent.clientX;
        latestY = moveEvent.clientY;
        if (!dragActive) {
          const dist = Math.hypot(latestX - startX, latestY - startY);
          if (dist > LONG_PRESS_MOVE_CANCEL_PX) {
            cleanupListeners();
          }
          return;
        }
        moveEvent.preventDefault();
        const hoverFolder = updateHoverAndAutoExpand(latestX, latestY);
        const nextState: FileDragState = {
          fileId: file.id,
          title: file.title,
          language: file.language,
          sourceFolder,
          clientX: latestX,
          clientY: latestY,
          hoverFolder,
        };
        dragStateRef.current = nextState;
        setDragState(nextState);
      };

      const onWindowPointerUp = () => {
        finishDrag(dragActive);
      };

      const onWindowPointerCancel = () => {
        finishDrag(false);
      };

      const onWindowKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault();
          finishDrag(false);
        }
      };

      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        startDrag();
      }, LONG_PRESS_DRAG_MS);

      window.addEventListener('pointermove', onWindowPointerMove);
      window.addEventListener('pointerup', onWindowPointerUp);
      window.addEventListener('pointercancel', onWindowPointerCancel);
      window.addEventListener('keydown', onWindowKeyDown);
    },
    [clearAutoExpandTimer, clearLongPressTimer],
  );

  useEffect(() => {
    if (!newMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        newMenuRef.current &&
        !newMenuRef.current.contains(event.target as Node)
      ) {
        setNewMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [newMenuOpen]);

  useEffect(() => {
    if (!folderAddMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-folder-add-anchor="true"]')) {
        setFolderAddMenu(null);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [folderAddMenu]);

  const openCreateFolderInput = () => {
    setNewMenuOpen(false);
    setCreatingFolder(true);
    setNewFolderName('');
    requestAnimationFrame(() => newFolderInputRef.current?.focus());
  };

  const commitCreateFolder = () => {
    const clean = newFolderName.trim();
    if (!clean) {
      setCreatingFolder(false);
      return;
    }
    const ok = onCreateFolder(clean);
    if (ok) {
      setCreatingFolder(false);
      setNewFolderName('');
    }
  };

  const startRenameFolder = (folder: string) => {
    setRenamingFolder(folder);
    setRenameDraft(folder);
    setFolderAddMenu(null);
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  };

  const commitRenameFolder = () => {
    if (!renamingFolder) return;
    const clean = renameDraft.trim();
    if (!clean || clean === renamingFolder) {
      setRenamingFolder(null);
      return;
    }
    const ok = onRenameFolder(renamingFolder, clean);
    if (ok) {
      setRenamingFolder(null);
    }
  };

  const allCollapsed =
    groupedFiles.length > 0 &&
    groupedFiles.every((g) => Boolean(collapsedFolders[g.folder]));

  const activeFileFolder =
    groupedFiles.find((g) => g.items.some((f) => f.id === activeFileId))
      ?.folder ?? undefined;

  const dataTotalCount = mountedDataFiles.length + dbConnections.length;
  const runtimeBadge = formatRuntimeShortLabel(
    selectedPythonRuntime,
    pythonEnvs,
  );
  const showSearchBar = searchOpen || Boolean(searchQuery.trim());

  return (
    <div ref={sidebarRootRef} className="obsidian-editor-sidebar">
      {!settingsOpen ? (
        <>
          {/* Minimal Obsidian Explorer Toolbar: '+' (Note/Notebook) + Folder+ + Filter + Search + Collapse */}
          <div className="obsidian-explorer-toolbar">
            <div className="obsidian-toolbar-left">
              <div className="obsidian-new-wrap" ref={newMenuRef}>
                <button
                  type="button"
                  className={`obsidian-icon-btn obsidian-plus-btn${newMenuOpen ? ' is-active' : ''}`}
                  onClick={() => setNewMenuOpen((v) => !v)}
                  title="新建笔记或笔记本"
                  aria-label="新建笔记或笔记本"
                  aria-expanded={newMenuOpen}
                >
                  <PlusNoteGlyph />
                </button>
                {newMenuOpen && (
                  <div className="obsidian-new-popover" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={openCreateFolderInput}
                    >
                      <span className="obsidian-new-folder-glyph">
                        <FolderPlusGlyph />
                      </span>
                      <span className="obsidian-new-label">新建笔记本</span>
                      <span className="obsidian-new-tag">目录</span>
                    </button>
                    <div className="obsidian-new-divider" role="separator" />
                    {NOTE_LANGUAGE_OPTIONS.map(([lang, label, tag]) => (
                      <button
                        key={lang}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setNewMenuOpen(false);
                          onCreateNotebook(lang, activeFileFolder);
                        }}
                      >
                        <span className={`obsidian-lang-dot is-${lang}`} />
                        <span className="obsidian-new-label">{label}</span>
                        <span className="obsidian-new-tag">{tag}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                className={`obsidian-icon-btn${creatingFolder ? ' is-active' : ''}`}
                onClick={openCreateFolderInput}
                title="新建笔记本（文件夹）"
                aria-label="新建笔记本（文件夹）"
              >
                <FolderPlusGlyph />
              </button>
            </div>

            <div className="obsidian-toolbar-right">
              <select
                className="obsidian-filter-select"
                value={filter}
                aria-label="按语言或收藏筛选笔记"
                onChange={(e) =>
                  onFilterChange(
                    e.target.value as
                      'all' | TerminalCodeLabLanguage | 'starred',
                  )
                }
              >
                <option value="all">全部</option>
                <option value="python">Python</option>
                <option value="sql">SQL</option>
                <option value="r">R</option>
                <option value="c">C</option>
                <option value="cpp">C++</option>
                <option value="starred">已收藏</option>
              </select>

              <button
                type="button"
                className={`obsidian-icon-btn${showSearchBar ? ' is-active' : ''}`}
                onClick={() => {
                  const next = !showSearchBar;
                  setSearchOpen(next);
                  if (!next) onSearchChange('');
                  else
                    requestAnimationFrame(() =>
                      searchInputRef.current?.focus(),
                    );
                }}
                title="搜索笔记"
                aria-label="搜索笔记"
              >
                <SearchGlyph />
              </button>

              <button
                type="button"
                className="obsidian-icon-btn"
                onClick={() => onSetAllFoldersCollapsed(!allCollapsed)}
                title={allCollapsed ? '展开全部笔记本' : '折叠全部笔记本'}
                aria-label={allCollapsed ? '展开全部笔记本' : '折叠全部笔记本'}
              >
                <CollapseTreeGlyph allCollapsed={allCollapsed} />
              </button>
            </div>
          </div>

          {creatingFolder && (
            <form
              className="obsidian-inline-folder-form"
              onSubmit={(e) => {
                e.preventDefault();
                commitCreateFolder();
              }}
            >
              <span className="obsidian-folder-icon">
                <FolderGlyph open={false} />
              </span>
              <input
                ref={newFolderInputRef}
                type="text"
                className="obsidian-inline-folder-input"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setCreatingFolder(false);
                    setNewFolderName('');
                  }
                }}
                placeholder="输入笔记本名称，回车创建…"
                aria-label="新笔记本名称"
              />
              <button
                type="submit"
                className="obsidian-inline-folder-ok"
                title="确认创建笔记本"
              >
                创建
              </button>
              <button
                type="button"
                className="obsidian-inline-folder-cancel"
                onClick={() => {
                  setCreatingFolder(false);
                  setNewFolderName('');
                }}
                title="取消"
                aria-label="取消新建笔记本"
              >
                ×
              </button>
            </form>
          )}

          {showSearchBar && (
            <div className="obsidian-search-wrap">
              <input
                ref={searchInputRef}
                type="search"
                className="obsidian-search-input"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="筛选笔记本、文件名或代码…"
                aria-label="筛选笔记本和笔记"
              />
            </div>
          )}

          <div className="obsidian-tree-scroll">
            {groupedFiles.map((group) => {
              const isCollapsed = Boolean(collapsedFolders[group.folder]);
              const isUncategorized =
                group.folder === UNCATEGORIZED_CODELAB_FOLDER;
              const isRenaming = renamingFolder === group.folder;
              const isAddMenuOpen = folderAddMenu === group.folder;
              const isDropTarget =
                Boolean(dragState) &&
                dragState?.hoverFolder === group.folder &&
                dragState?.sourceFolder !== group.folder;
              return (
                <div
                  key={group.folder}
                  data-drop-folder={group.folder}
                  className={`obsidian-folder-group${isDropTarget ? ' is-drop-target' : ''}`}
                >
                  <div
                    className="obsidian-folder-row-wrap"
                    data-folder-add-anchor={isAddMenuOpen ? 'true' : undefined}
                  >
                    {isRenaming ? (
                      <form
                        className="obsidian-folder-rename-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          commitRenameFolder();
                        }}
                      >
                        <span className="obsidian-folder-icon">
                          <FolderGlyph open={!isCollapsed} />
                        </span>
                        <input
                          ref={renameInputRef}
                          type="text"
                          className="obsidian-folder-rename-input"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={commitRenameFolder}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              setRenamingFolder(null);
                            }
                          }}
                          aria-label="重命名笔记本"
                        />
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="obsidian-folder-row"
                          onClick={() => onToggleFolder(group.folder)}
                          aria-expanded={!isCollapsed}
                        >
                          <span className="obsidian-folder-chevron">
                            {isCollapsed ? (
                              <LabChevronRightIcon size={11} />
                            ) : (
                              <LabChevronDownIcon size={11} />
                            )}
                          </span>
                          <span className="obsidian-folder-icon">
                            <FolderGlyph open={!isCollapsed} />
                          </span>
                          <span className="obsidian-folder-name">
                            {group.folder}
                          </span>
                          {isDropTarget ? (
                            <span className="obsidian-folder-drop-pill">
                              松手放入
                            </span>
                          ) : (
                            <span className="obsidian-folder-count">
                              {group.items.length}
                            </span>
                          )}
                        </button>

                        <div className="obsidian-folder-hover-actions">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFolderAddMenu((curr) =>
                                curr === group.folder ? null : group.folder,
                              );
                            }}
                            title={`在「${group.folder}」中新建笔记`}
                            aria-label={`在 ${group.folder} 中新建笔记`}
                          >
                            <PlusNoteGlyph size={11} />
                          </button>
                          {!isUncategorized && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                startRenameFolder(group.folder);
                              }}
                              title={`重命名笔记本「${group.folder}」`}
                              aria-label={`重命名 ${group.folder}`}
                            >
                              <RenameGlyph />
                            </button>
                          )}
                          {!isUncategorized && (
                            <button
                              type="button"
                              className="is-danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteFolder(group.folder);
                              }}
                              title={`删除笔记本「${group.folder}」（其中笔记保留至${UNCATEGORIZED_CODELAB_FOLDER}）`}
                              aria-label={`删除 ${group.folder}`}
                            >
                              <LabCloseIcon size={10} />
                            </button>
                          )}
                        </div>
                      </>
                    )}

                    {isAddMenuOpen && (
                      <div className="obsidian-folder-add-menu" role="menu">
                        {NOTE_LANGUAGE_OPTIONS.map(([lang, label, tag]) => (
                          <button
                            key={lang}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setFolderAddMenu(null);
                              if (isCollapsed) onToggleFolder(group.folder);
                              onCreateNotebook(lang, group.folder);
                            }}
                          >
                            <span className={`obsidian-lang-dot is-${lang}`} />
                            <span className="obsidian-new-label">{label}</span>
                            <span className="obsidian-new-tag">{tag}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {!isCollapsed && (
                    <div className="obsidian-folder-children">
                      {group.items.length === 0 ? (
                        <div className="obsidian-empty-folder">暂无笔记</div>
                      ) : (
                        group.items.map((file) => {
                          const isCurrent = activeFileId === file.id;
                          const isDirtyInAnyTab = tabs.some(
                            (t) =>
                              t.kind === 'lab' &&
                              (labInfoByTab[t.id]?.fileId ?? t.labFileId) ===
                                file.id &&
                              labInfoByTab[t.id]?.dirty,
                          );
                          const isDraggingSource =
                            dragState?.fileId === file.id;
                          const isJustMoved = justMovedFileId === file.id;
                          return (
                            <div
                              key={file.id}
                              className={`obsidian-file-row${isCurrent ? ' is-active' : ''}${isDraggingSource ? ' is-dragging-source' : ''}${isJustMoved ? ' is-just-moved' : ''}`}
                            >
                              <button
                                type="button"
                                className="obsidian-file-main"
                                onPointerDown={(e) =>
                                  handleFilePointerDown(e, file, group.folder)
                                }
                                onClick={() => {
                                  if (suppressClickRef.current) return;
                                  onOpenFile(file, 'tab');
                                }}
                                title={`${file.title} · ${file.language.toUpperCase()} · ${file.cells.length} 格${isDirtyInAnyTab ? ' · 未保存' : ''}（长按拖动可移入其他笔记本）`}
                              >
                                <span
                                  className={`obsidian-file-icon is-${file.language}`}
                                >
                                  <NotebookGlyph />
                                </span>
                                <span className="obsidian-file-name">
                                  {file.title}
                                </span>
                                {isDirtyInAnyTab && (
                                  <span
                                    className="obsidian-dirty-dot"
                                    title="未保存"
                                  />
                                )}
                                {file.starred && (
                                  <span className="obsidian-starred-mark">
                                    <LabStarIcon size={10} filled />
                                  </span>
                                )}
                              </button>

                              <div className="obsidian-file-hover-actions">
                                <button
                                  type="button"
                                  onClick={() => onOpenFile(file, 'right')}
                                  title={
                                    isCurrent
                                      ? `在右侧分屏打开「${file.title}」同步视图`
                                      : `在右侧分屏打开 ${file.title}`
                                  }
                                  aria-label={`分屏打开 ${file.title}`}
                                >
                                  <SplitPaneGlyph />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onDuplicateFile(file)}
                                  title={`复制 ${file.title}`}
                                  aria-label={`复制 ${file.title}`}
                                >
                                  ⧉
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onOpenFile(file, 'window')}
                                  title={`独立窗口打开 ${file.title}`}
                                  aria-label={`独立窗口打开 ${file.title}`}
                                >
                                  <PopoutGlyph />
                                </button>
                                <button
                                  type="button"
                                  className={file.starred ? 'is-starred' : ''}
                                  onClick={() => onToggleStarFile(file.id)}
                                  title={file.starred ? '取消收藏' : '收藏'}
                                  aria-label={
                                    file.starred ? '取消收藏' : '收藏'
                                  }
                                >
                                  <LabStarIcon
                                    size={11}
                                    filled={file.starred}
                                  />
                                </button>
                                <button
                                  type="button"
                                  className="is-danger"
                                  onClick={() => onDeleteFile(file.id)}
                                  title="从目录移除"
                                  aria-label="从目录移除"
                                >
                                  <LabCloseIcon size={10} />
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="obsidian-settings-view">
          <div className="obsidian-settings-head">
            <button
              type="button"
              className="obsidian-settings-back"
              onClick={() => setSettingsOpen(false)}
              title="返回笔记本文件树"
            >
              <BackArrowGlyph />
              <span>文件</span>
            </button>
            <div
              className="obsidian-settings-tabs"
              role="tablist"
              aria-label="编辑器设置分类"
            >
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === 'data'}
                className={`obsidian-settings-tab${settingsTab === 'data' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('data')}
              >
                数据
                {dataTotalCount > 0 && (
                  <span className="obsidian-settings-count">
                    {dataTotalCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === 'envs'}
                className={`obsidian-settings-tab${settingsTab === 'envs' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('envs')}
              >
                环境
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={settingsTab === 'style'}
                className={`obsidian-settings-tab${settingsTab === 'style' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('style')}
              >
                样式
              </button>
            </div>
          </div>

          <div className="obsidian-settings-body">
            {settingsTab === 'data' && (
              <CodeLabDataPanel
                mountedFiles={mountedDataFiles}
                dbConnections={dbConnections}
                preferredPythonPath={
                  selectedPythonRuntime !== 'pyodide'
                    ? selectedPythonRuntime
                    : null
                }
                onUpdateFiles={onUpdateDataFiles}
                onUpdateConnections={onUpdateDbConnections}
                onInsertCell={onInsertDataCell}
                onNotify={onNotify}
              />
            )}
            {settingsTab === 'envs' && (
              <CodeLabEnvPanel
                pythonEnvs={pythonEnvs}
                rEnvs={rEnvs}
                dbConnections={dbConnections}
                baseProfile={baseProfile}
                busInfo={busInfo}
                selectedPythonPath={selectedPythonRuntime}
                selectedRPath={selectedRRuntime}
                customEnvPaths={customEnvPaths}
                loading={envsLoading}
                onRefresh={onRefreshEnvs}
                onRefreshBus={onRefreshBus}
                onSaveBaseProfile={onSaveBaseProfile}
                onSelectPythonRuntime={onSelectPythonRuntime}
                onSelectRRuntime={onSelectRRuntime}
                onActivateInTerminal={onActivateInTerminal}
                onUpdateCustomEnvPaths={onUpdateCustomEnvPaths}
              />
            )}
            {settingsTab === 'style' && (
              <CodeLabAppearancePanel onNotify={onNotify} />
            )}
          </div>
        </div>
      )}

      {/* Subtle Obsidian-Style Bottom-Left Unified Settings Trigger */}
      <div className="obsidian-bottom-bar">
        <button
          type="button"
          className={`obsidian-settings-trigger${settingsOpen ? ' is-active' : ''}`}
          aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
          title="编辑器设置（数据接入、运行环境、编辑区样式）"
        >
          <SettingsGearGlyph />
          <span>设置</span>
        </button>
        <span
          className="obsidian-bottom-status"
          title={`运行环境：${runtimeBadge}${dataTotalCount > 0 ? ` · ${dataTotalCount} 项数据源` : ''}`}
        >
          {runtimeBadge}
          {dataTotalCount > 0 ? ` · ${dataTotalCount}` : ''}
        </span>
      </div>

      {/* Floating Obsidian-Style Long-Press Drag Ghost */}
      {dragState &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className={`obsidian-drag-ghost${
              dragState.hoverFolder &&
              dragState.hoverFolder !== dragState.sourceFolder
                ? ' is-valid-drop'
                : ''
            }`}
            style={{
              left: Math.min(
                Math.max(8, dragState.clientX + 14),
                window.innerWidth - 252,
              ),
              top: Math.min(
                Math.max(8, dragState.clientY - 18),
                window.innerHeight - 64,
              ),
            }}
            role="status"
            aria-live="polite"
          >
            <div className="obsidian-drag-ghost-file">
              <span className={`obsidian-file-icon is-${dragState.language}`}>
                <NotebookGlyph />
              </span>
              <span>{dragState.title}</span>
            </div>
            <div className="obsidian-drag-ghost-hint">
              {dragState.hoverFolder &&
              dragState.hoverFolder !== dragState.sourceFolder
                ? `↳ 松手移入「${dragState.hoverFolder}」`
                : dragState.hoverFolder === dragState.sourceFolder
                  ? `已在「${dragState.sourceFolder}」中`
                  : '拖到目标笔记本松手放入（Esc 取消）'}
            </div>
          </div>,
          sidebarRootRef.current?.closest('.terminal-workspace') ??
            document.body,
        )}
    </div>
  );
});
