import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Theme } from '../app/app-storage';
import { systemApi } from '../system/system-api';
import type {
  PythonWorkerRequest,
  PythonWorkerResponse,
  PythonWorkerVarSummary,
} from '../workbench/python.worker';
import { CellOutputList, CodeLabCellRow } from './CodeLabCellRow';
import {
  LabCellsIcon,
  LabCheckIcon,
  LabChevronDownIcon,
  LabCloseIcon,
  LabCodeIcon,
  LabCopyIcon,
  LabFolderIcon,
  LabMoreIcon,
  LabNoteIcon,
  LabPlayAllIcon,
  LabPlayIcon,
  LabPlusIcon,
  LabResetIcon,
  LabSaveIcon,
  LabStopIcon,
  LabTrashIcon,
  LabVarsIcon,
} from './CodeLabIcons';
import { terminalApi, type PythonEnvInfo } from './terminal-api';
import {
  assembleCCellProgram,
  assembleFullScriptSource,
  CODELAB_COLLECTION_EVENT,
  CODELAB_SYNC_VIEW_EVENT,
  createStarterCodeLabCells,
  DEFAULT_C_PROLOGUE,
  DEFAULT_CODELAB_FOLDERS,
  DEFAULT_CPP_PROLOGUE,
  duplicateCodeLabCell,
  exportCodeLabToMarkdown,
  formatCellStudyExportMarkdown,
  formatDurationCompact,
  loadCodeLabCollection,
  makeCodeLabCellId,
  moveCodeLabCell,
  parseIpynbJson,
  serializeIpynbJson,
  stripHeavyOutputsForStorage,
  upsertCodeLabFile,
  type CodeLabCell,
  type CodeLabOutputItem,
  type CodeLabSavedFile,
  type CodeLabSourceOrigin,
  type CodeLabSyncViewPayload,
} from './terminal-codelab-model';
import type {
  TerminalCodeLabLanguage,
  TerminalTab,
  TerminalWorkspaceBridge,
} from './terminal-types';

export type CodeLabCanvasViewMode = 'notebook' | 'script';

export interface TerminalCodeLabViewHandle {
  focus: () => void;
  insertAndRunCell: (
    language: TerminalCodeLabLanguage,
    source: string,
    autoRun?: boolean,
    origin?: CodeLabSourceOrigin,
  ) => void;
  loadSavedFile: (file: CodeLabSavedFile) => void;
  saveCurrentToCollection: (asNew?: boolean) => CodeLabSavedFile | null;
  createNewNotebook: (
    language: TerminalCodeLabLanguage,
    folder?: string,
  ) => void;
  setCanvasViewMode: (mode: CodeLabCanvasViewMode) => void;
  getCanvasViewMode: () => CodeLabCanvasViewMode;
  getActiveFileId: () => string | null;
  hasUnsavedChanges: () => boolean;
  getScreenText: (maxLines?: number) => string;
  getLastErrorText: () => string;
}

interface TerminalCodeLabViewProps {
  tab: TerminalTab;
  theme: Theme;
  active: boolean;
  standalone?: boolean;
  isSplitView?: boolean;
  isFocused?: boolean;
  style?: React.CSSProperties;
  bridge?: TerminalWorkspaceBridge;
  onFocusPane?: () => void;
  onStatusChange?: (status: TerminalTab['status'], message?: string) => void;
  onSendToShellPane?: (command: string, execute?: boolean) => void;
  onSendToAgentPane?: (prompt: string) => void;
  onOpenSyncView?: () => void;
  onDuplicateNotebook?: (file: CodeLabSavedFile) => void;
  onActiveFileChange?: (
    tabId: string,
    info: {
      fileId: string | null;
      title: string;
      folder: string;
      language: TerminalCodeLabLanguage;
      viewMode: CodeLabCanvasViewMode;
      dirty?: boolean;
    },
  ) => void;
}

interface ReplHistoryEntry {
  id: string;
  code: string;
  language: TerminalCodeLabLanguage;
  ok: boolean;
  text: string;
  images?: string[];
  durationMs?: number;
}

const MAX_LIVE_CM_EDITORS = 5;
const CODELAB_DRAFT_PREFIX = 'seamind:codelab-draft:v1:';

interface CodeLabDraft {
  fileId: string | null;
  fileRevision: number | null;
  title: string;
  folder: string;
  language: TerminalCodeLabLanguage;
  starred: boolean;
  cells: CodeLabCell[];
  prologueSource: string;
}

function codeLabDraftKey(tabId: string, standalone: boolean): string {
  if (!standalone) return `${CODELAB_DRAFT_PREFIX}main:${tabId}`;
  try {
    let windowId = sessionStorage.getItem('seamind:codelab-window-id:v1');
    if (!windowId) {
      windowId = `window-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem('seamind:codelab-window-id:v1', windowId);
    }
    return `${CODELAB_DRAFT_PREFIX}${windowId}:${tabId}`;
  } catch {
    return `${CODELAB_DRAFT_PREFIX}standalone:${tabId}`;
  }
}

function readCodeLabDraft(key: string, fileId?: string): CodeLabDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as CodeLabDraft;
    if (!Array.isArray(value.cells) || value.fileId !== (fileId ?? null))
      return null;
    return value;
  } catch {
    return null;
  }
}

function pushHydratedLru(prev: string[], cellId: string): string[] {
  if (!cellId) return prev;
  if (prev[0] === cellId) return prev;
  const filtered = prev.filter((id) => id !== cellId);
  return [cellId, ...filtered].slice(0, MAX_LIVE_CM_EDITORS);
}

export const TerminalCodeLabView = forwardRef<
  TerminalCodeLabViewHandle,
  TerminalCodeLabViewProps
>(function TerminalCodeLabView(
  {
    tab,
    theme,
    active,
    standalone = false,
    isSplitView = false,
    isFocused = false,
    style,
    bridge,
    onFocusPane,
    onStatusChange,
    onSendToShellPane,
    onSendToAgentPane,
    onOpenSyncView,
    onDuplicateNotebook,
    onActiveFileChange,
  },
  ref,
) {
  const initialLang: TerminalCodeLabLanguage = tab.labLanguage ?? 'python';
  const initialFile = useMemo(
    () =>
      tab.labFileId
        ? loadCodeLabCollection().find((file) => file.id === tab.labFileId)
        : null,
    [tab.labFileId],
  );
  const draftKey = useMemo(
    () => codeLabDraftKey(tab.id, standalone),
    [standalone, tab.id],
  );
  const initialDraft = useMemo(
    () => readCodeLabDraft(draftKey, tab.labFileId),
    [draftKey, tab.labFileId],
  );
  const [language, setLanguage] = useState<TerminalCodeLabLanguage>(
    initialDraft?.language ?? initialFile?.language ?? initialLang,
  );
  const [cells, setCells] = useState<CodeLabCell[]>(() =>
    initialDraft?.cells.length || initialFile?.cells.length
      ? (initialDraft?.cells ?? initialFile?.cells ?? []).map((cell) => ({
          ...cell,
          id: cell.id || makeCodeLabCellId(),
        }))
      : createStarterCodeLabCells(initialLang),
  );
  const [activeFileId, setActiveFileId] = useState<string | null>(
    initialDraft?.fileId ?? initialFile?.id ?? null,
  );
  const [activeFileRevision, setActiveFileRevision] = useState<number | null>(
    initialDraft?.fileRevision ?? initialFile?.updatedAt ?? null,
  );
  const [activeFileTitle, setActiveFileTitle] = useState<string>(() => {
    return (
      initialDraft?.title ??
      initialFile?.title ??
      (initialLang === 'c'
        ? 'C 语言步进实验.c'
        : initialLang === 'cpp'
          ? 'C++ 算法验证实验.cpp'
          : 'Python 交互实验本.ipynb')
    );
  });
  const [activeFileFolder, setActiveFileFolder] = useState<string>(
    initialDraft?.folder || initialFile?.folder || '书籍伴读验证',
  );
  const [activeFileStarred, setActiveFileStarred] = useState<boolean>(
    Boolean(initialDraft?.starred ?? initialFile?.starred),
  );
  const [dirty, setDirty] = useState<boolean>(Boolean(initialDraft));
  const [editingTitle, setEditingTitle] = useState<boolean>(false);
  const [canvasViewMode, setCanvasViewMode] =
    useState<CodeLabCanvasViewMode>('notebook');
  const [focusedCellId, setFocusedCellId] = useState<string>(
    () => cells[1]?.id ?? cells[0]?.id ?? '',
  );
  const [interactionMode, setInteractionMode] = useState<'command' | 'edit'>(
    'edit',
  );
  const [editingCellId, setEditingCellId] = useState<string | null>(
    () => cells.find((cell) => cell.kind === 'code')?.id ?? null,
  );
  const [hydratedCellIds, setHydratedCellIds] = useState<string[]>(() => {
    const firstCode = cells.find((c) => c.kind === 'code') ?? cells[0];
    return firstCode ? [firstCode.id] : [];
  });
  const [showPrologue, setShowPrologue] = useState(language !== 'python');
  const [prologueSource, setPrologueSource] = useState(
    () =>
      initialDraft?.prologueSource ??
      initialFile?.prologueSource ??
      (language === 'cpp' ? DEFAULT_CPP_PROLOGUE : DEFAULT_C_PROLOGUE),
  );

  // Popovers & panels
  const [showFolderMenu, setShowFolderMenu] = useState(false);
  const [showKernelMenu, setShowKernelMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showVars, setShowVars] = useState(() => {
    try {
      return localStorage.getItem(`${draftKey}:vars`) === 'true';
    } catch {
      return false;
    }
  });
  const [pinnedCellId, setPinnedCellId] = useState<string | null>(null);
  const [fullWidth, setFullWidth] = useState(() => {
    try {
      return localStorage.getItem('seamind:codelab-full-width:v1') === 'true';
    } catch {
      return false;
    }
  });
  const [replOpen, setReplOpen] = useState(() => {
    try {
      return localStorage.getItem(`${draftKey}:console`) === 'true';
    } catch {
      return false;
    }
  });
  const [bottomDrawerTab, setBottomDrawerTab] = useState<'console' | 'vars'>(
    () => {
      try {
        return localStorage.getItem(`${draftKey}:vars`) === 'true'
          ? 'vars'
          : 'console';
      } catch {
        return 'console';
      }
    },
  );
  const [bottomDrawerHeight, setBottomDrawerHeight] = useState<number>(() => {
    try {
      const saved = Number(
        localStorage.getItem('seamind:codelab-drawer-height:v1'),
      );
      if (Number.isFinite(saved) && saved >= 120 && saved <= 400) return saved;
    } catch {
      // ignore storage errors
    }
    return 192;
  });
  const isApplyingSyncRef = useRef(false);
  const [varFilter, setVarFilter] = useState('');
  const [expandedVarName, setExpandedVarName] = useState<string | null>(null);
  const [variablePreview, setVariablePreview] = useState<{
    name: string;
    text: string;
  } | null>(null);
  const [variablePreviewLoading, setVariablePreviewLoading] = useState(false);
  const [zoomedImageSrc, setZoomedImageSrc] = useState<string | null>(null);

  // Python Kernels: 'pyodide' or local pythonPath
  const [pythonEnvs, setPythonEnvs] = useState<PythonEnvInfo[]>([]);
  const [selectedPyRuntime, setSelectedPyRuntime] = useState<string>('pyodide');
  const [localKernelId, setLocalKernelId] = useState<string | null>(null);
  const [variables, setVariables] = useState<PythonWorkerVarSummary[]>([]);

  // C/C++ compiler status
  const [cCompilerReady, setCCompilerReady] = useState<boolean | null>(null);
  const [cCompilerError, setCCompilerError] = useState<string>('');

  // Bottom quick console REPL
  const [replInput, setReplInput] = useState('');
  const [replBusy, setReplBusy] = useState(false);
  const [replHistory, setReplHistory] = useState<ReplHistoryEntry[]>([]);
  const [replLogCollapsed, setReplLogCollapsed] = useState(false);
  const [notice, setNotice] = useState('');
  const [copiedScript, setCopiedScript] = useState(false);

  const execCounterRef = useRef(0);
  const pyodideWorkerRef = useRef<Worker | null>(null);
  const runAbortRef = useRef(false);
  const workerPendingRef = useRef<
    Map<
      string,
      {
        resolve: (res: PythonWorkerResponse) => void;
        reject: (err: Error) => void;
      }
    >
  >(new Map());
  const localKernelIdRef = useRef<string | null>(null);
  localKernelIdRef.current = localKernelId;
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const liveSourceMapRef = useRef<Map<string, string>>(
    new Map(cells.map((c) => [c.id, c.source])),
  );
  const focusedCellIdRef = useRef(focusedCellId);
  focusedCellIdRef.current = focusedCellId;
  const lastDKeyTimeRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);
  const kernelMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const rootContainerRef = useRef<HTMLDivElement>(null);
  const cellsScrollRef = useRef<HTMLDivElement>(null);
  const replInputRef = useRef<HTMLInputElement>(null);

  const hydratedSet = useMemo(
    () => new Set(hydratedCellIds),
    [hydratedCellIds],
  );

  const isAnyRunning = useMemo(
    () => replBusy || cells.some((c) => c.status === 'running'),
    [cells, replBusy],
  );
  const pinnedCell = cells.find((cell) => cell.id === pinnedCellId) ?? null;

  useEffect(() => {
    try {
      localStorage.setItem('seamind:codelab-full-width:v1', String(fullWidth));
    } catch {
      // View preference is optional when storage is unavailable.
    }
  }, [fullWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(`${draftKey}:vars`, String(showVars));
      localStorage.setItem(`${draftKey}:console`, String(replOpen));
    } catch {
      // Panel visibility is a best-effort view preference.
    }
  }, [draftKey, replOpen, showVars]);

  useEffect(() => {
    const element = cellsScrollRef.current;
    if (!element) return;
    const key = `${draftKey}:scroll`;
    try {
      const saved = Number(localStorage.getItem(key));
      if (Number.isFinite(saved) && saved > 0) element.scrollTop = saved;
    } catch {
      /* optional scroll restoration */
    }
    const onScroll = () => {
      try {
        localStorage.setItem(key, String(element.scrollTop));
      } catch {
        /* optional scroll restoration */
      }
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [draftKey]);

  const getCellsWithLiveSources = useCallback((): CodeLabCell[] => {
    const liveMap = liveSourceMapRef.current;
    return cellsRef.current.map((c) => {
      const live = liveMap.get(c.id);
      return live !== undefined && live !== c.source
        ? { ...c, source: live }
        : c;
    });
  }, []);

  const persistDraft = useCallback(() => {
    if (!dirty) return;
    const draft: CodeLabDraft = {
      fileId: activeFileId,
      fileRevision: activeFileRevision,
      title: activeFileTitle,
      folder: activeFileFolder,
      language,
      starred: activeFileStarred,
      cells: stripHeavyOutputsForStorage(getCellsWithLiveSources()),
      prologueSource,
    };
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      // The explicit save path reports storage failures to the user.
    }
  }, [
    activeFileFolder,
    activeFileId,
    activeFileRevision,
    activeFileStarred,
    activeFileTitle,
    dirty,
    draftKey,
    getCellsWithLiveSources,
    language,
    prologueSource,
  ]);

  useEffect(() => {
    if (!dirty) {
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* optional draft cleanup */
      }
      return;
    }
    const timer = window.setTimeout(persistDraft, 900);
    window.addEventListener('pagehide', persistDraft);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', persistDraft);
    };
  }, [dirty, draftKey, persistDraft]);

  // Dismiss popovers on outside mousedown
  useEffect(() => {
    if (!showFolderMenu && !showKernelMenu && !showExportMenu) return;
    const onDown = (e: MouseEvent) => {
      const node = e.target instanceof Node ? e.target : null;
      if (!node) return;
      if (showFolderMenu && !folderMenuRef.current?.contains(node)) {
        setShowFolderMenu(false);
      }
      if (showKernelMenu && !kernelMenuRef.current?.contains(node)) {
        setShowKernelMenu(false);
      }
      if (showExportMenu && !exportMenuRef.current?.contains(node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showExportMenu, showFolderMenu, showKernelMenu]);

  const showTempNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => {
      setNotice((curr) => (curr === msg ? '' : curr));
    }, 2400);
  }, []);

  useEffect(() => {
    onStatusChange?.('ready', '实验室就绪');
  }, [onStatusChange]);

  useEffect(() => {
    onActiveFileChange?.(tab.id, {
      fileId: activeFileId,
      title: activeFileTitle,
      folder: activeFileFolder,
      language,
      viewMode: canvasViewMode,
      dirty,
    });
  }, [
    activeFileId,
    activeFileTitle,
    activeFileFolder,
    language,
    canvasViewMode,
    dirty,
    tab.id,
    onActiveFileChange,
  ]);

  // Synchronized Views: broadcast live edits, outputs, variables & save state to sibling tabs sharing activeFileId
  useEffect(() => {
    if (!activeFileId || isApplyingSyncRef.current) return;
    const payload: CodeLabSyncViewPayload = {
      sourceTabId: tab.id,
      fileId: activeFileId,
      title: activeFileTitle,
      folder: activeFileFolder,
      language,
      starred: activeFileStarred,
      cells: getCellsWithLiveSources(),
      prologueSource,
      variables,
      dirty,
      revision: activeFileRevision,
    };
    window.dispatchEvent(
      new CustomEvent<CodeLabSyncViewPayload>(CODELAB_SYNC_VIEW_EVENT, {
        detail: payload,
      }),
    );
  }, [
    activeFileFolder,
    activeFileId,
    activeFileRevision,
    activeFileStarred,
    activeFileTitle,
    cells,
    dirty,
    getCellsWithLiveSources,
    language,
    prologueSource,
    tab.id,
    variables,
  ]);

  useEffect(() => {
    if (!activeFileId) return;
    const onSyncView = (event: Event) => {
      const custom = event as CustomEvent<CodeLabSyncViewPayload>;
      const detail = custom.detail;
      if (
        !detail ||
        detail.fileId !== activeFileId ||
        detail.sourceTabId === tab.id
      ) {
        return;
      }
      isApplyingSyncRef.current = true;
      liveSourceMapRef.current = new Map(
        detail.cells.map((c) => [c.id, c.source]),
      );
      setCells(detail.cells);
      setActiveFileTitle(detail.title);
      setActiveFileFolder(detail.folder);
      setActiveFileStarred(detail.starred);
      setLanguage(detail.language);
      setPrologueSource(detail.prologueSource);
      setDirty(detail.dirty);
      setActiveFileRevision(detail.revision);
      if (detail.variables) {
        setVariables(detail.variables);
      }
      queueMicrotask(() => {
        isApplyingSyncRef.current = false;
      });
    };
    const onExternalSaved = () => {
      if (dirty) return;
      const latest = loadCodeLabCollection().find(
        (item) => item.id === activeFileId,
      );
      if (!latest || latest.updatedAt === activeFileRevision) return;
      isApplyingSyncRef.current = true;
      liveSourceMapRef.current = new Map(
        latest.cells.map((c) => [c.id, c.source]),
      );
      setCells(latest.cells);
      setActiveFileTitle(latest.title);
      setActiveFileFolder(latest.folder);
      setActiveFileStarred(Boolean(latest.starred));
      setLanguage(latest.language);
      setActiveFileRevision(latest.updatedAt);
      queueMicrotask(() => {
        isApplyingSyncRef.current = false;
      });
    };
    window.addEventListener(CODELAB_SYNC_VIEW_EVENT, onSyncView);
    window.addEventListener(CODELAB_COLLECTION_EVENT, onExternalSaved);
    return () => {
      window.removeEventListener(CODELAB_SYNC_VIEW_EVENT, onSyncView);
      window.removeEventListener(CODELAB_COLLECTION_EVENT, onExternalSaved);
    };
  }, [activeFileId, activeFileRevision, dirty, tab.id]);

  const handleLoadSavedFile = useCallback(
    (file: CodeLabSavedFile) => {
      setActiveFileId(file.id);
      setActiveFileRevision(file.updatedAt);
      setActiveFileTitle(file.title);
      setActiveFileFolder(file.folder || '未归类代码');
      setActiveFileStarred(Boolean(file.starred));
      setLanguage(file.language);
      const nextCells =
        file.cells.length > 0
          ? file.cells.map((c) => ({ ...c, id: c.id || makeCodeLabCellId() }))
          : createStarterCodeLabCells(file.language);
      liveSourceMapRef.current = new Map(
        nextCells.map((c) => [c.id, c.source]),
      );
      setCells(nextCells);
      setPinnedCellId(null);
      setDirty(false);
      const firstCode =
        nextCells.find((c) => c.kind === 'code') ?? nextCells[0];
      if (firstCode) {
        setFocusedCellId(firstCode.id);
        setEditingCellId(firstCode.id);
        setHydratedCellIds([firstCode.id]);
      }
      if (file.language !== 'python') {
        setShowPrologue(true);
        setPrologueSource(
          file.prologueSource ||
            (file.language === 'cpp'
              ? DEFAULT_CPP_PROLOGUE
              : DEFAULT_C_PROLOGUE),
        );
      }
      showTempNotice(`已加载：${file.title}`);
    },
    [showTempNotice],
  );

  const handleSaveToCollection = useCallback(
    (asNew = false): CodeLabSavedFile | null => {
      const liveCells = getCellsWithLiveSources();
      const ext =
        language === 'cpp' ? '.cpp' : language === 'c' ? '.c' : '.ipynb';
      const rawTitle = activeFileTitle.trim() || `未命名实验${ext}`;
      const id =
        !asNew && activeFileId
          ? activeFileId
          : `codelab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const makeInput = (fileId: string, title: string) => ({
        id: fileId,
        title,
        folder: activeFileFolder || '未归类代码',
        language,
        cells: liveCells,
        prologueSource: language !== 'python' ? prologueSource : undefined,
        tags: [
          language === 'cpp' ? 'C++' : language === 'c' ? 'C' : 'Python',
          activeFileFolder || '实验',
        ],
        starred: activeFileStarred,
      });
      try {
        let saved: CodeLabSavedFile;
        let conflictCopy = false;
        try {
          const list = upsertCodeLabFile(
            makeInput(id, rawTitle),
            !asNew && activeFileId ? activeFileRevision : undefined,
          );
          saved = list.find((item) => item.id === id)!;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== 'CODELAB_REVISION_CONFLICT'
          ) {
            throw error;
          }
          const copyId = `codelab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const copyTitle = `${rawTitle.replace(/(\.ipynb|\.cpp|\.c)$/i, '')}（冲突副本）${ext}`;
          const list = upsertCodeLabFile(makeInput(copyId, copyTitle));
          saved = list.find((item) => item.id === copyId)!;
          conflictCopy = true;
        }
        setActiveFileId(saved.id);
        setActiveFileRevision(saved.updatedAt);
        setActiveFileTitle(saved.title);
        setDirty(false);
        showTempNotice(
          conflictCopy
            ? `另一窗口已修改原文件，已保存为冲突副本：${saved.title}`
            : asNew
              ? `已另存至代码库：${saved.title}`
              : `已归档：${saved.title}`,
        );
        return saved;
      } catch {
        showTempNotice(
          '保存失败：本地空间不足或存储不可用，请导出 .ipynb 备份',
        );
        return null;
      }
    },
    [
      activeFileFolder,
      activeFileId,
      activeFileRevision,
      activeFileStarred,
      activeFileTitle,
      getCellsWithLiveSources,
      language,
      prologueSource,
      showTempNotice,
    ],
  );

  const handleCreateNewNotebook = useCallback(
    (nextLang: TerminalCodeLabLanguage, folder = '未归类代码') => {
      const ext =
        nextLang === 'cpp' ? '.cpp' : nextLang === 'c' ? '.c' : '.ipynb';
      const nextCells = createStarterCodeLabCells(nextLang);
      liveSourceMapRef.current = new Map(
        nextCells.map((c) => [c.id, c.source]),
      );
      setActiveFileId(null);
      setActiveFileRevision(null);
      setPinnedCellId(null);
      setActiveFileTitle(
        `新建_${nextLang.toUpperCase()}_${new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }).replace(':', '')}${ext}`,
      );
      setActiveFileFolder(folder);
      setActiveFileStarred(false);
      setLanguage(nextLang);
      setCells(nextCells);
      setDirty(true);
      setCanvasViewMode('notebook');
      const firstCode =
        nextCells.find((c) => c.kind === 'code') ?? nextCells[0];
      if (firstCode) {
        setFocusedCellId(firstCode.id);
        setEditingCellId(firstCode.id);
        setHydratedCellIds([firstCode.id]);
      }
      if (nextLang !== 'python') {
        setShowPrologue(true);
        setPrologueSource(
          nextLang === 'cpp' ? DEFAULT_CPP_PROLOGUE : DEFAULT_C_PROLOGUE,
        );
      }
      showTempNotice(`已新建 ${nextLang.toUpperCase()} 实验本`);
    },
    [showTempNotice],
  );

  // Idle-scheduled environment detection to keep tab switch 60fps
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const probe = () => {
      if (cancelled) return;
      terminalApi
        .detectPythonEnvs({ cwd: tab.cwd || null })
        .then((envs) => {
          if (!cancelled) setPythonEnvs(envs);
        })
        .catch(() => {
          if (!cancelled) setPythonEnvs([]);
        });

      systemApi
        .checkCEnvironment()
        .then((res) => {
          if (!cancelled) {
            setCCompilerReady(res.available);
            setCCompilerError(res.error ?? '');
          }
        })
        .catch(() => {
          if (!cancelled) setCCompilerReady(false);
        });
    };

    const timer = window.setTimeout(probe, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, tab.cwd]);

  // Terminate worker + close Rust kernel cleanly on unmount
  useEffect(() => {
    const pending = workerPendingRef.current;
    return () => {
      if (pyodideWorkerRef.current) {
        pyodideWorkerRef.current.terminate();
        pyodideWorkerRef.current = null;
      }
      for (const [, waiter] of pending) {
        waiter.reject(new Error('实验本标签已关闭'));
      }
      pending.clear();
      if (localKernelIdRef.current) {
        void terminalApi
          .closePythonKernel({ kernelId: localKernelIdRef.current })
          .catch(() => undefined);
      }
    };
  }, []);

  const ensurePyodideWorker = useCallback(() => {
    if (pyodideWorkerRef.current) return pyodideWorkerRef.current;
    const worker = new Worker(
      new URL('../workbench/python.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (event: MessageEvent<PythonWorkerResponse>) => {
      const reqId = event.data.requestId;
      if (!reqId) return;
      const waiter = workerPendingRef.current.get(reqId);
      if (!waiter) return;
      workerPendingRef.current.delete(reqId);
      waiter.resolve(event.data);
    };
    worker.onerror = (event) => {
      for (const [id, waiter] of workerPendingRef.current) {
        waiter.reject(new Error(event.message || 'Pyodide Worker 崩溃'));
        workerPendingRef.current.delete(id);
      }
      pyodideWorkerRef.current = null;
    };
    pyodideWorkerRef.current = worker;
    return worker;
  }, []);

  const runWorkerRequest = useCallback(
    (action: 'exec' | 'reset' | 'vars', source: string) =>
      new Promise<PythonWorkerResponse>((resolve, reject) => {
        const worker = ensurePyodideWorker();
        const requestId = `pyw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const timer = window.setTimeout(() => {
          workerPendingRef.current.delete(requestId);
          worker.terminate();
          pyodideWorkerRef.current = null;
          reject(new Error('Pyodide 执行超过 25 秒超时，Worker 已重置。'));
        }, 25_000);
        workerPendingRef.current.set(requestId, {
          resolve: (res) => {
            window.clearTimeout(timer);
            resolve(res);
          },
          reject: (err) => {
            window.clearTimeout(timer);
            reject(err);
          },
        });
        const indexURL = new URL('pyodide/', document.baseURI).href;
        const moduleURL = new URL('pyodide/pyodide.mjs', document.baseURI).href;
        const payload: PythonWorkerRequest = {
          requestId,
          action,
          source,
          indexURL,
          moduleURL,
        };
        worker.postMessage(payload);
      }),
    [ensurePyodideWorker],
  );

  const handleInterruptExecution = useCallback(() => {
    runAbortRef.current = true;
    if (pyodideWorkerRef.current) {
      pyodideWorkerRef.current.terminate();
      pyodideWorkerRef.current = null;
    }
    for (const [id, waiter] of workerPendingRef.current) {
      waiter.reject(new Error('已由用户手动中断执行（内核已重置）'));
      workerPendingRef.current.delete(id);
    }
    setCells((prev) =>
      prev.map((c) => (c.status === 'running' ? { ...c, status: 'idle' } : c)),
    );
    setReplBusy(false);
    setVariables([]);
    onStatusChange?.('ready', '执行已中断');
    showTempNotice('已中断当前执行并重置沙盒 Worker');
  }, [onStatusChange, showTempNotice]);

  const ensureLocalPythonKernel = useCallback(async (): Promise<string> => {
    if (localKernelIdRef.current) return localKernelIdRef.current;
    const kernelId = await terminalApi.startPythonKernel({
      pythonPath: selectedPyRuntime === 'pyodide' ? null : selectedPyRuntime,
      cwd: tab.cwd || null,
    });
    localKernelIdRef.current = kernelId;
    setLocalKernelId(kernelId);
    return kernelId;
  }, [selectedPyRuntime, tab.cwd]);

  const executePythonSnippet = useCallback(
    async (
      code: string,
    ): Promise<{
      ok: boolean;
      outputs: CodeLabOutputItem[];
      durationMs: number;
      vars: PythonWorkerVarSummary[];
      plainError: string;
    }> => {
      const started = performance.now();
      const outputs: CodeLabOutputItem[] = [];
      let vars: PythonWorkerVarSummary[] = [];
      let plainError = '';
      let ok = true;

      if (selectedPyRuntime === 'pyodide') {
        const res = await runWorkerRequest('exec', code);
        if (res.output?.trim()) {
          outputs.push({ kind: 'stream', name: 'stdout', text: res.output });
        }
        if (res.stderr?.trim()) {
          outputs.push({ kind: 'stream', name: 'stderr', text: res.stderr });
        }
        for (const img of res.images ?? []) {
          outputs.push({ kind: 'image/png', dataUrl: img });
        }
        for (const svg of res.svgs ?? []) {
          outputs.push({ kind: 'image/svg+xml', svg });
        }
        for (const html of res.htmls ?? []) {
          outputs.push({ kind: 'text/html', html });
        }
        for (const latex of res.latexes ?? []) {
          outputs.push({ kind: 'text/latex', latex });
        }
        if (
          res.resultText?.trim() &&
          (res.htmls?.length ?? 0) === 0 &&
          (res.svgs?.length ?? 0) === 0 &&
          (res.images?.length ?? 0) === 0
        ) {
          outputs.push({ kind: 'text', text: res.resultText });
        }
        if (res.type === 'error' || res.error) {
          ok = false;
          plainError = res.error || 'Python 执行失败';
          outputs.push({ kind: 'error', message: plainError });
        }
        vars = res.variables ?? [];
      } else {
        const kernelId = await ensureLocalPythonKernel();
        const res = await terminalApi.evalPythonKernel({ kernelId, code });
        if (res.stdout.trim()) {
          outputs.push({ kind: 'stream', name: 'stdout', text: res.stdout });
        }
        if (res.stderr.trim()) {
          outputs.push({ kind: 'stream', name: 'stderr', text: res.stderr });
        }
        for (const img of res.images) {
          outputs.push({ kind: 'image/png', dataUrl: img });
        }
        for (const svg of res.svgs) {
          outputs.push({ kind: 'image/svg+xml', svg });
        }
        for (const html of res.htmls) {
          outputs.push({ kind: 'text/html', html });
        }
        for (const latex of res.latexes) {
          outputs.push({ kind: 'text/latex', latex });
        }
        if (
          res.resultText.trim() &&
          res.htmls.length === 0 &&
          res.svgs.length === 0 &&
          res.images.length === 0
        ) {
          outputs.push({ kind: 'text', text: res.resultText });
        }
        if (!res.ok || res.error) {
          ok = false;
          plainError = res.error || res.stderr || '本地 Python 内核报错';
          outputs.push({ kind: 'error', message: plainError });
        }
        vars = res.variables;
      }

      return {
        ok,
        outputs,
        durationMs: Math.round(performance.now() - started),
        vars,
        plainError,
      };
    },
    [ensureLocalPythonKernel, runWorkerRequest, selectedPyRuntime],
  );

  const runCellById = useCallback(
    async (cellId: string, advance = false) => {
      const targetIndex = cellsRef.current.findIndex((c) => c.id === cellId);
      if (targetIndex < 0) return;
      const cell = cellsRef.current[targetIndex];
      const liveSource = liveSourceMapRef.current.get(cellId) ?? cell.source;

      if (cell.kind === 'markdown') {
        setCells((prev) =>
          prev.map((item) =>
            item.id === cellId && item.source !== liveSource
              ? { ...item, source: liveSource }
              : item,
          ),
        );
        setEditingCellId((curr) => (curr === cellId ? null : curr));
        if (advance) {
          const next = cellsRef.current[targetIndex + 1];
          if (next) {
            setFocusedCellId(next.id);
            setHydratedCellIds((prev) => pushHydratedLru(prev, next.id));
          }
        }
        return;
      }

      runAbortRef.current = false;
      execCounterRef.current += 1;
      const runNumber = execCounterRef.current;

      setCells((prev) =>
        prev.map((item) =>
          item.id === cellId
            ? { ...item, source: liveSource, status: 'running' }
            : item,
        ),
      );
      onStatusChange?.('starting', `正在执行 [${runNumber}]`);

      try {
        if (cell.language === 'python') {
          const res = await executePythonSnippet(liveSource);
          setVariables(res.vars);
          setCells((prev) =>
            prev.map((item) =>
              item.id === cellId
                ? {
                    ...item,
                    executionCount: runNumber,
                    status: res.ok ? 'success' : 'error',
                    outputs: res.outputs,
                    lastExecutedSource: liveSource,
                    durationMs: res.durationMs,
                  }
                : item,
            ),
          );
          onStatusChange?.(
            res.ok ? 'ready' : 'error',
            res.ok
              ? `PY [${runNumber}] · ${formatDurationCompact(res.durationMs)}`
              : 'Python 运行出错',
          );
        } else {
          const isCpp = cell.language === 'cpp';
          const assembled = assembleCCellProgram(
            prologueSource,
            liveSource,
            isCpp,
          );
          const res = await systemApi.runCCode({
            source: assembled,
            stdinInput: cell.stdinInput ? cell.stdinInput : null,
            isCpp,
          });
          const outputs: CodeLabOutputItem[] = [];
          if (res.stdout.trim()) {
            outputs.push({ kind: 'stream', name: 'stdout', text: res.stdout });
          }
          if (res.stderr.trim()) {
            if (res.success) {
              outputs.push({
                kind: 'stream',
                name: 'stderr',
                text: res.stderr,
              });
            } else {
              outputs.push({ kind: 'error', message: res.stderr });
            }
          }
          if (!res.success && !res.stderr.trim()) {
            outputs.push({
              kind: 'error',
              message: `${res.stage} 失败，退出码: ${res.exitCode ?? 'unknown'}`,
            });
          }
          setCells((prev) =>
            prev.map((item) =>
              item.id === cellId
                ? {
                    ...item,
                    executionCount: runNumber,
                    status: res.success ? 'success' : 'error',
                    outputs,
                    lastExecutedSource: liveSource,
                    durationMs: res.durationMs,
                    stage: res.stage,
                    exitCode: res.exitCode ?? null,
                  }
                : item,
            ),
          );
          onStatusChange?.(
            res.success ? 'ready' : 'error',
            `${isCpp ? 'C++' : 'C'} [${runNumber}] · ${formatDurationCompact(res.durationMs)}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setCells((prev) =>
          prev.map((item) =>
            item.id === cellId
              ? {
                  ...item,
                  executionCount: runNumber,
                  status: 'error',
                  outputs: [{ kind: 'error', message: msg }],
                  lastExecutedSource: liveSource,
                }
              : item,
          ),
        );
        onStatusChange?.('error', msg);
      }

      setDirty(true);

      if (advance && !runAbortRef.current) {
        const snapshot = cellsRef.current;
        const nextCell = snapshot[targetIndex + 1];
        if (nextCell) {
          setFocusedCellId(nextCell.id);
          if (nextCell.kind === 'code') {
            setEditingCellId(nextCell.id);
            setHydratedCellIds((prev) => pushHydratedLru(prev, nextCell.id));
          }
        } else {
          const added: CodeLabCell = {
            id: makeCodeLabCellId(),
            kind: 'code',
            language: cell.language,
            source: '',
            stdinInput: '',
            executionCount: null,
            status: 'idle',
            outputs: [],
          };
          liveSourceMapRef.current.set(added.id, '');
          setCells((prev) => [...prev, added]);
          setFocusedCellId(added.id);
          setEditingCellId(added.id);
          setHydratedCellIds((prev) => pushHydratedLru(prev, added.id));
        }
      }
    },
    [executePythonSnippet, onStatusChange, prologueSource],
  );

  const insertCell = useCallback(
    (
      relative: 'above' | 'below',
      kind: 'code' | 'markdown' = 'code',
      overrideLang?: TerminalCodeLabLanguage,
    ) => {
      const idx = cellsRef.current.findIndex(
        (c) => c.id === focusedCellIdRef.current,
      );
      const insertAt =
        idx < 0
          ? cellsRef.current.length
          : relative === 'above'
            ? idx
            : idx + 1;
      const newCell: CodeLabCell = {
        id: makeCodeLabCellId(),
        kind,
        language: overrideLang ?? language,
        source: '',
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      };
      liveSourceMapRef.current.set(newCell.id, '');
      setCells((prev) => [
        ...prev.slice(0, insertAt),
        newCell,
        ...prev.slice(insertAt),
      ]);
      setDirty(true);
      setFocusedCellId(newCell.id);
      setEditingCellId(newCell.id);
      setHydratedCellIds((prev) => pushHydratedLru(prev, newCell.id));
      setInteractionMode('edit');
    },
    [language],
  );

  const deleteCellById = useCallback((id: string) => {
    liveSourceMapRef.current.delete(id);
    setCells((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((c) => c.id === id);
      const next = prev.filter((c) => c.id !== id);
      const nextFocus = next[Math.max(0, Math.min(idx, next.length - 1))];
      if (nextFocus) {
        setFocusedCellId(nextFocus.id);
        setHydratedCellIds((h) =>
          pushHydratedLru(
            h.filter((item) => item !== id),
            nextFocus.id,
          ),
        );
      }
      return next;
    });
    setDirty(true);
  }, []);

  const handleMoveCell = useCallback(
    (cellId: string, direction: 'up' | 'down') => {
      setCells((prev) => moveCodeLabCell(prev, cellId, direction));
      setDirty(true);
    },
    [],
  );

  const handleDuplicateCell = useCallback(
    (cellId: string) => {
      const liveCells = getCellsWithLiveSources();
      const { cells: nextCells, duplicatedCellId } = duplicateCodeLabCell(
        liveCells,
        cellId,
      );
      if (!duplicatedCellId) return;
      const cloned = nextCells.find((c) => c.id === duplicatedCellId);
      if (cloned) {
        liveSourceMapRef.current.set(cloned.id, cloned.source);
      }
      setCells(nextCells);
      setDirty(true);
      setFocusedCellId(duplicatedCellId);
      setEditingCellId(duplicatedCellId);
      setHydratedCellIds((prev) => pushHydratedLru(prev, duplicatedCellId));
      setInteractionMode('edit');
    },
    [getCellsWithLiveSources],
  );

  const handleInsertCellBelowById = useCallback(
    (cellId: string, kind: 'code' | 'markdown') => {
      const idx = cellsRef.current.findIndex((c) => c.id === cellId);
      const insertAt = idx < 0 ? cellsRef.current.length : idx + 1;
      const newCell: CodeLabCell = {
        id: makeCodeLabCellId(),
        kind,
        language,
        source: '',
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      };
      liveSourceMapRef.current.set(newCell.id, '');
      setCells((prev) => [
        ...prev.slice(0, insertAt),
        newCell,
        ...prev.slice(insertAt),
      ]);
      setDirty(true);
      setFocusedCellId(newCell.id);
      setEditingCellId(newCell.id);
      setHydratedCellIds((prev) => pushHydratedLru(prev, newCell.id));
      setInteractionMode('edit');
    },
    [language],
  );

  const handleExportCellToStudy = useCallback(
    async (cellId: string, target: 'knowledge' | 'mindmap') => {
      const liveCells = getCellsWithLiveSources();
      const idx = liveCells.findIndex((c) => c.id === cellId);
      if (idx < 0) return;
      const cell = liveCells[idx];
      const docTitle = activeFileTitle.trim() || tab.title;
      const md = formatCellStudyExportMarkdown(docTitle, cell, idx);
      if (target === 'mindmap') {
        if (bridge?.onAppendToMindmap) {
          const ok = await bridge.onAppendToMindmap({
            title: `${docTitle} #${idx + 1}`,
            markdown: md,
          });
          showTempNotice(
            ok ? '已将此格结论与代码追加到思维导图' : '追加思维导图失败',
          );
        } else {
          await navigator.clipboard?.writeText(md);
          showTempNotice('已复制导图分支 Markdown 到剪贴板');
        }
        return;
      }
      if (bridge?.onSaveMarkdownNote) {
        const ok = await bridge.onSaveMarkdownNote({
          title: `${docTitle} · 格 #${idx + 1} 实验记录`,
          category: '代码实验',
          source: `# ${docTitle} · 格 #${idx + 1}\n\n${md}\n`,
        });
        showTempNotice(ok ? '已将此格代码与结果写入知识库' : '保存知识库失败');
      } else {
        await navigator.clipboard?.writeText(md);
        showTempNotice('已复制实验记录 Markdown 到剪贴板');
      }
    },
    [
      activeFileTitle,
      bridge,
      getCellsWithLiveSources,
      showTempNotice,
      tab.title,
    ],
  );

  const handleClearCellOutputs = useCallback((cellId: string) => {
    setCells((prev) =>
      prev.map((c) =>
        c.id === cellId
          ? { ...c, outputs: [], status: 'idle', durationMs: undefined }
          : c,
      ),
    );
  }, []);

  const handleClearAllOutputs = useCallback(() => {
    setCells((prev) =>
      prev.map((c) =>
        c.outputs.length > 0 || c.status !== 'idle'
          ? {
              ...c,
              outputs: [],
              status: 'idle',
              executionCount: null,
              durationMs: undefined,
            }
          : c,
      ),
    );
    showTempNotice('已清空全部单元格输出');
  }, [showTempNotice]);

  const handleResetPythonKernel = useCallback(async () => {
    try {
      if (selectedPyRuntime === 'pyodide') {
        await runWorkerRequest('reset', '');
      } else if (localKernelIdRef.current) {
        await terminalApi.resetPythonKernel({
          kernelId: localKernelIdRef.current,
        });
      }
      setVariables([]);
      setVariablePreview(null);
      showTempNotice('Python 内核变量空间已清空重置');
    } catch (err) {
      showTempNotice(err instanceof Error ? err.message : '内核重置失败');
    }
  }, [runWorkerRequest, selectedPyRuntime, showTempNotice]);

  const handleInspectVariable = useCallback(
    async (name: string) => {
      if (isAnyRunning || variablePreviewLoading) return;
      setVariablePreviewLoading(true);
      try {
        const variableName = JSON.stringify(name);
        const code = `__seamind_inspect_value = globals().get(${variableName})\nif hasattr(__seamind_inspect_value, 'head') and hasattr(__seamind_inspect_value, 'to_string'):\n    print(__seamind_inspect_value.head(20).to_string(max_rows=20, max_cols=12))\nelif hasattr(__seamind_inspect_value, 'shape'):\n    print('shape:', getattr(__seamind_inspect_value, 'shape', None))\n    print(repr(__seamind_inspect_value)[:8000])\nelif isinstance(__seamind_inspect_value, (list, tuple)):\n    print(repr(__seamind_inspect_value[:50])[:8000])\nelse:\n    print(repr(__seamind_inspect_value)[:8000])`;
        const result = await executePythonSnippet(code);
        const text = result.outputs
          .map((item) =>
            item.kind === 'stream' || item.kind === 'text'
              ? item.text
              : item.kind === 'error'
                ? item.message
                : '',
          )
          .filter(Boolean)
          .join('\n');
        setVariablePreview({ name, text: text || '没有可显示的文本预览' });
        setVariables(result.vars);
      } catch (error) {
        setVariablePreview({
          name,
          text: error instanceof Error ? error.message : '预览失败',
        });
      } finally {
        setVariablePreviewLoading(false);
      }
    },
    [executePythonSnippet, isAnyRunning, variablePreviewLoading],
  );

  const handleSwitchPythonRuntime = useCallback(
    async (nextRuntime: string) => {
      if (nextRuntime === selectedPyRuntime) return;
      if (localKernelIdRef.current) {
        const oldId = localKernelIdRef.current;
        localKernelIdRef.current = null;
        setLocalKernelId(null);
        await terminalApi
          .closePythonKernel({ kernelId: oldId })
          .catch(() => undefined);
      }
      setSelectedPyRuntime(nextRuntime);
      setVariables([]);
      showTempNotice(
        nextRuntime === 'pyodide'
          ? '已切换至 Pyodide WebAssembly 沙盒内核'
          : '已切换本地 Python 环境（下次运行自动拉起）',
      );
    },
    [selectedPyRuntime, showTempNotice],
  );

  const handleSwitchLanguage = useCallback(
    (nextLang: TerminalCodeLabLanguage) => {
      setLanguage(nextLang);
      if (nextLang !== 'python') {
        setShowPrologue(true);
        setPrologueSource(
          nextLang === 'cpp' ? DEFAULT_CPP_PROLOGUE : DEFAULT_C_PROLOGUE,
        );
      }
    },
    [],
  );

  const handleSendCellToShellById = useCallback(
    async (cellId: string) => {
      const cell = cellsRef.current.find((c) => c.id === cellId);
      if (!cell) return;
      const source = liveSourceMapRef.current.get(cellId) ?? cell.source;
      if (cell.language === 'python') {
        const stagedPath = await terminalApi
          .stageScript({ source })
          .catch(() => null);
        const cmd =
          selectedPyRuntime !== 'pyodide'
            ? stagedPath
              ? `& '${selectedPyRuntime}' '${stagedPath}'`
              : `${selectedPyRuntime} -i`
            : stagedPath
              ? `python '${stagedPath}'`
              : 'python';
        onSendToShellPane?.(cmd, Boolean(stagedPath));
        return;
      }

      const isCpp = cell.language === 'cpp';
      const assembled = assembleCCellProgram(prologueSource, source, isCpp);
      try {
        const staged = await terminalApi.stageCSource({
          source: assembled,
          suggestedName: `lab_${cell.id.slice(-4)}`,
          workspaceRoot: tab.cwd || null,
          isCpp,
        });
        onSendToShellPane?.(staged.command, true);
        showTempNotice(`已编译并推入终端：${staged.fileName}`);
      } catch (err) {
        showTempNotice(err instanceof Error ? err.message : '导出到终端失败');
      }
    },
    [
      onSendToShellPane,
      prologueSource,
      selectedPyRuntime,
      showTempNotice,
      tab.cwd,
    ],
  );

  const handleSendCellToAgentById = useCallback(
    (cellId: string) => {
      const cell = cellsRef.current.find((c) => c.id === cellId);
      if (!cell || !onSendToAgentPane) return;
      const source = liveSourceMapRef.current.get(cellId) ?? cell.source;
      const err = cell.outputs.find((o) => o.kind === 'error');
      onSendToAgentPane(
        `/code 请诊断这段 ${cell.language.toUpperCase()} 代码的报错并给出修正：\n\`\`\`${cell.language}\n${source}\n\`\`\`\n报错信息：\n${err && err.kind === 'error' ? err.message : ''}`,
      );
    },
    [onSendToAgentPane],
  );

  const handleRunAll = useCallback(async () => {
    runAbortRef.current = false;
    for (const cell of cellsRef.current) {
      if (runAbortRef.current) break;
      if (cell.kind === 'code') {
        await runCellById(cell.id, false);
      }
    }
  }, [runCellById]);

  const handleRunRange = useCallback(
    async (direction: 'through' | 'below') => {
      const snapshot = cellsRef.current;
      const selectedIndex = snapshot.findIndex(
        (cell) => cell.id === focusedCellIdRef.current,
      );
      if (selectedIndex < 0) return;
      runAbortRef.current = false;
      for (let index = 0; index < snapshot.length; index += 1) {
        if (runAbortRef.current) break;
        if (
          direction === 'through'
            ? index > selectedIndex
            : index < selectedIndex
        )
          continue;
        if (snapshot[index].kind === 'code')
          await runCellById(snapshot[index].id, false);
      }
    },
    [runCellById],
  );

  const handleGoToNextError = useCallback(() => {
    const snapshot = cellsRef.current;
    const currentIndex = snapshot.findIndex(
      (cell) => cell.id === focusedCellIdRef.current,
    );
    const next = [
      ...snapshot.slice(currentIndex + 1),
      ...snapshot.slice(0, currentIndex + 1),
    ].find((cell) => cell.status === 'error');
    if (!next) {
      showTempNotice('当前实验本没有运行错误');
      return;
    }
    setFocusedCellId(next.id);
    setHydratedCellIds((previous) => pushHydratedLru(previous, next.id));
    rootContainerRef.current
      ?.querySelector(`[data-cell-id="${next.id}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [showTempNotice]);

  const handleRunQuickRepl = useCallback(
    async (overrideCode?: string) => {
      const code = (overrideCode ?? replInput).trim();
      if (!code || replBusy) return;
      setReplBusy(true);
      setReplLogCollapsed(false);
      try {
        if (language === 'python') {
          const res = await executePythonSnippet(code);
          setVariables(res.vars);
          const lines: string[] = [];
          for (const o of res.outputs) {
            if (o.kind === 'stream' || o.kind === 'text')
              lines.push(o.text.trimEnd());
            if (o.kind === 'error') lines.push(o.message);
          }
          const images = res.outputs
            .filter(
              (o): o is Extract<CodeLabOutputItem, { kind: 'image/png' }> =>
                o.kind === 'image/png',
            )
            .map((o) => o.dataUrl);
          setReplHistory((prev) => [
            ...prev.slice(-14),
            {
              id: `repl-${Date.now()}`,
              code,
              language,
              ok: res.ok,
              text: lines.join('\n') || (res.ok ? '(ok)' : 'error'),
              images,
              durationMs: res.durationMs,
            },
          ]);
        } else {
          const isCpp = language === 'cpp';
          const assembled = assembleCCellProgram(prologueSource, code, isCpp);
          const res = await systemApi.runCCode({
            source: assembled,
            stdinInput: null,
            isCpp,
          });
          setReplHistory((prev) => [
            ...prev.slice(-14),
            {
              id: `repl-${Date.now()}`,
              code,
              language,
              ok: res.success,
              text:
                (res.success ? res.stdout : res.stderr) ||
                `exit ${res.exitCode ?? 0}`,
              durationMs: res.durationMs,
            },
          ]);
        }
        if (overrideCode === undefined) setReplInput('');
      } catch (err) {
        setReplHistory((prev) => [
          ...prev.slice(-14),
          {
            id: `repl-${Date.now()}`,
            code,
            language,
            ok: false,
            text: err instanceof Error ? err.message : String(err),
          },
        ]);
      } finally {
        setReplBusy(false);
      }
    },
    [executePythonSnippet, language, prologueSource, replBusy, replInput],
  );

  // Stable cell callbacks for React.memo isolation
  const handleSelectCell = useCallback((cellId: string) => {
    setFocusedCellId(cellId);
  }, []);

  const handleRequestHydrate = useCallback((cellId: string) => {
    setFocusedCellId(cellId);
    setEditingCellId(cellId);
    setInteractionMode('edit');
    setHydratedCellIds((prev) => pushHydratedLru(prev, cellId));
  }, []);

  const handleCommitCellSource = useCallback((cellId: string, next: string) => {
    const existing = cellsRef.current.find((c) => c.id === cellId);
    if (!existing) return;
    liveSourceMapRef.current.set(cellId, next);
    if (existing.source === next) return;
    setCells((prev) => {
      const target = prev.find((c) => c.id === cellId);
      if (!target || target.source === next) return prev;
      return prev.map((c) => (c.id === cellId ? { ...c, source: next } : c));
    });
    setDirty(true);
  }, []);

  const handleChangeCellLanguage = useCallback(
    (cellId: string, nextLang: TerminalCodeLabLanguage) => {
      setCells((prev) =>
        prev.map((c) => (c.id === cellId ? { ...c, language: nextLang } : c)),
      );
      setDirty(true);
    },
    [],
  );

  const handleChangeCellStdin = useCallback((cellId: string, stdin: string) => {
    setCells((prev) =>
      prev.map((c) => (c.id === cellId ? { ...c, stdinInput: stdin } : c)),
    );
    setDirty(true);
  }, []);

  const handleToggleMarkdownEdit = useCallback((cellId: string) => {
    setEditingCellId((curr) => {
      const next = curr === cellId ? null : cellId;
      if (next) {
        setInteractionMode('edit');
        setHydratedCellIds((prev) => pushHydratedLru(prev, cellId));
      }
      return next;
    });
  }, []);

  const handleStartMarkdownEdit = useCallback((cellId: string) => {
    setFocusedCellId(cellId);
    setEditingCellId(cellId);
    setInteractionMode('edit');
    setHydratedCellIds((prev) => pushHydratedLru(prev, cellId));
  }, []);

  const handleEditorFocus = useCallback((cellId: string) => {
    setFocusedCellId(cellId);
    setEditingCellId(cellId);
    setInteractionMode('edit');
    setHydratedCellIds((prev) => pushHydratedLru(prev, cellId));
  }, []);

  const handleEditorBlur = useCallback((cellId: string) => {
    const cell = cellsRef.current.find((c) => c.id === cellId);
    if (cell?.kind === 'markdown') {
      setEditingCellId((curr) => (curr === cellId ? null : curr));
    }
  }, []);

  const handleEscapeCommandMode = useCallback((cellId: string) => {
    setInteractionMode('command');
    const cell = cellsRef.current.find((c) => c.id === cellId);
    if (cell?.kind === 'markdown') {
      setEditingCellId((curr) => (curr === cellId ? null : curr));
    }
    rootContainerRef.current?.focus();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        rootContainerRef.current?.focus();
      },
      insertAndRunCell: (lang, source, autoRun = true, origin) => {
        setLanguage(lang);
        if (lang !== 'python') setShowPrologue(true);
        const newCell: CodeLabCell = {
          id: makeCodeLabCellId(),
          kind: 'code',
          language: lang,
          source,
          stdinInput: '',
          executionCount: null,
          status: 'idle',
          outputs: [],
          origin,
        };
        liveSourceMapRef.current.set(newCell.id, source);
        setCells((prev) => [...prev, newCell]);
        setDirty(true);
        setFocusedCellId(newCell.id);
        setEditingCellId(newCell.id);
        setHydratedCellIds((prev) => pushHydratedLru(prev, newCell.id));
        if (autoRun) {
          requestAnimationFrame(() => {
            void runCellById(newCell.id, false);
          });
        }
      },
      loadSavedFile: (file) => {
        handleLoadSavedFile(file);
      },
      saveCurrentToCollection: (asNew = false) => {
        return handleSaveToCollection(asNew);
      },
      createNewNotebook: (nextLang, folder) => {
        handleCreateNewNotebook(nextLang, folder);
      },
      setCanvasViewMode: (mode) => {
        if (mode === 'script') {
          const liveCells = getCellsWithLiveSources();
          setCells(liveCells);
        }
        setCanvasViewMode(mode);
      },
      getCanvasViewMode: () => canvasViewMode,
      getActiveFileId: () => activeFileId,
      hasUnsavedChanges: () => dirty,
      getScreenText: (maxLines = 80) => {
        const lines: string[] = [];
        for (const c of getCellsWithLiveSources()) {
          if (c.kind === 'markdown') continue;
          lines.push(
            `[${c.language.toUpperCase()} In[${c.executionCount ?? ' '}]]:`,
          );
          lines.push(c.source);
          for (const out of c.outputs) {
            if (out.kind === 'stream' || out.kind === 'text') {
              lines.push(out.text);
            } else if (out.kind === 'error') {
              lines.push(`[ERROR] ${out.message}`);
            }
          }
        }
        const joined = lines.join('\n').split('\n');
        return joined.slice(-maxLines).join('\n');
      },
      getLastErrorText: () => {
        const snapshot = getCellsWithLiveSources();
        for (let i = snapshot.length - 1; i >= 0; i -= 1) {
          const cell = snapshot[i];
          const errOut = cell.outputs.find((o) => o.kind === 'error');
          if (errOut && errOut.kind === 'error') {
            return `语言: ${cell.language}\n代码:\n${cell.source}\n报错:\n${errOut.message}`;
          }
        }
        return '';
      },
    }),
    [
      activeFileId,
      dirty,
      canvasViewMode,
      getCellsWithLiveSources,
      handleCreateNewNotebook,
      handleLoadSavedFile,
      handleSaveToCollection,
      runCellById,
    ],
  );

  // Command Mode + Ctrl/Cmd+S hotkeys
  const handleContainerKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      handleSaveToCollection(false);
      return;
    }

    if (interactionMode === 'edit') return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.closest('.cm-editor'))
    ) {
      return;
    }

    const idx = cells.findIndex((c) => c.id === focusedCellId);
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      const next = cells[Math.min(cells.length - 1, Math.max(0, idx + 1))];
      if (next) setFocusedCellId(next.id);
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = cells[Math.max(0, idx - 1)];
      if (prev) setFocusedCellId(prev.id);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      setInteractionMode('edit');
      setEditingCellId(focusedCellId);
      setHydratedCellIds((prev) => pushHydratedLru(prev, focusedCellId));
    } else if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      void runCellById(focusedCellId, true);
    } else if (event.key === 'a') {
      event.preventDefault();
      insertCell('above', 'code');
    } else if (event.key === 'b') {
      event.preventDefault();
      insertCell('below', 'code');
    } else if (event.key === 'm') {
      event.preventDefault();
      setCells((prev) =>
        prev.map((c) =>
          c.id === focusedCellId ? { ...c, kind: 'markdown' } : c,
        ),
      );
      setDirty(true);
    } else if (event.key === 'y') {
      event.preventDefault();
      setCells((prev) =>
        prev.map((c) => (c.id === focusedCellId ? { ...c, kind: 'code' } : c)),
      );
      setDirty(true);
    } else if (event.key === 'd') {
      const now = Date.now();
      if (now - lastDKeyTimeRef.current < 450) {
        deleteCellById(focusedCellId);
        lastDKeyTimeRef.current = 0;
      } else {
        lastDKeyTimeRef.current = now;
      }
    }
  };

  const handleExportIpynb = () => {
    const liveCells = getCellsWithLiveSources();
    const docTitle = activeFileTitle.trim() || tab.title;
    const content = serializeIpynbJson(liveCells, language, docTitle);
    const blob = new Blob([content], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${docTitle.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.ipynb`;
    a.click();
    URL.revokeObjectURL(url);
    showTempNotice('已导出标准 .ipynb 文件');
  };

  const handleExportScriptFile = () => {
    const liveCells = getCellsWithLiveSources();
    const ext = language === 'cpp' ? 'cpp' : language === 'c' ? 'c' : 'py';
    const docTitle = activeFileTitle.trim() || tab.title;
    const scriptText = assembleFullScriptSource(
      liveCells,
      language,
      prologueSource,
    );
    const blob = new Blob([scriptText], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${docTitle.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    showTempNotice(`已导出完整 .${ext} 源码文件`);
  };

  const handleExportMarkdownNote = async () => {
    const liveCells = getCellsWithLiveSources();
    const docTitle = activeFileTitle.trim() || tab.title;
    const md = exportCodeLabToMarkdown(docTitle, language, liveCells);
    if (bridge?.onSaveMarkdownNote) {
      const ok = await bridge.onSaveMarkdownNote({
        title: `${docTitle} 实验笔记`,
        category: '代码实验',
        source: md,
      });
      showTempNotice(ok ? '已写入 Seamind 知识库' : '保存知识库失败');
    } else {
      await navigator.clipboard?.writeText(md);
      showTempNotice('已复制 Markdown 实验笔记到剪贴板');
    }
  };

  const handleExportNotebookToMindmap = async () => {
    const liveCells = getCellsWithLiveSources();
    const docTitle = activeFileTitle.trim() || tab.title;
    const md = exportCodeLabToMarkdown(docTitle, language, liveCells);
    if (bridge?.onAppendToMindmap) {
      const ok = await bridge.onAppendToMindmap({
        title: `${docTitle} 实验结论`,
        markdown: md,
      });
      showTempNotice(
        ok ? '已将实验结论与代码追加到思维导图' : '追加思维导图失败',
      );
    } else {
      await navigator.clipboard?.writeText(md);
      showTempNotice('已复制导图分支 Markdown 到剪贴板');
    }
  };

  // Lazy computation: zero cost while editing cells in notebook mode
  const assembledFullScript = useMemo(() => {
    if (canvasViewMode !== 'script') return '';
    return assembleFullScriptSource(cells, language, prologueSource);
  }, [canvasViewMode, cells, language, prologueSource]);

  const activeEnvObj = useMemo(
    () => pythonEnvs.find((e) => e.pythonPath === selectedPyRuntime),
    [pythonEnvs, selectedPyRuntime],
  );

  const filteredVariables = useMemo(() => {
    const q = varFilter.trim().toLowerCase();
    if (!q) return variables;
    return variables.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.typeName.toLowerCase().includes(q) ||
        v.preview.toLowerCase().includes(q),
    );
  }, [varFilter, variables]);

  const kernelSummary = useMemo(() => {
    if (language === 'c') {
      return {
        tag: 'C',
        label: cCompilerReady === false ? 'GCC 不可用' : 'GCC',
        tone: cCompilerReady === false ? 'warn' : 'ready',
      };
    }
    if (language === 'cpp') {
      return {
        tag: 'C++',
        label: cCompilerReady === false ? 'G++ 不可用' : 'G++',
        tone: cCompilerReady === false ? 'warn' : 'ready',
      };
    }
    if (selectedPyRuntime === 'pyodide') {
      return {
        tag: 'Python',
        label: 'Pyodide',
        tone: isAnyRunning ? 'busy' : 'ready',
      };
    }
    return {
      tag: 'Python',
      label: activeEnvObj?.label || 'Local Python',
      tone: isAnyRunning ? 'busy' : localKernelId ? 'ready' : 'idle',
    };
  }, [
    activeEnvObj?.label,
    cCompilerReady,
    isAnyRunning,
    language,
    localKernelId,
    selectedPyRuntime,
  ]);

  const bottomDrawerOpen = replOpen || (showVars && language === 'python');
  const activeBottomTab: 'console' | 'vars' =
    language !== 'python'
      ? 'console'
      : showVars && (!replOpen || bottomDrawerTab === 'vars')
        ? 'vars'
        : 'console';
  const runningCellsCount = useMemo(
    () => cells.filter((c) => c.status === 'running').length,
    [cells],
  );

  return (
    <div
      ref={rootContainerRef}
      tabIndex={0}
      className={`codelab-root${active ? '' : ' is-hidden-pane'}${isFocused ? ' is-focused' : ''}${isSplitView ? ' is-split-view' : ''}`}
      style={style}
      onMouseDown={() => onFocusPane?.()}
      onKeyDown={handleContainerKeyDown}
    >
      {/* Single-Row Document-Centric Notebook Toolbar */}
      <header className="codelab-toolbar" aria-label="代码实验室控制栏">
        {/* File location, title and save state */}
        <div className="codelab-toolbar-left">
          <div className="codelab-popover-wrap" ref={folderMenuRef}>
            <button
              type="button"
              className="codelab-crumb-folder"
              onClick={() => setShowFolderMenu((v) => !v)}
              aria-expanded={showFolderMenu}
              aria-haspopup="menu"
              title="切换归档目录"
            >
              <LabFolderIcon size={12} />
              <span>{activeFileFolder}</span>
              <LabChevronDownIcon size={10} />
            </button>
            {showFolderMenu && (
              <div className="codelab-popover-menu is-left" role="menu">
                <div className="codelab-popover-head">代码归档分类</div>
                {DEFAULT_CODELAB_FOLDERS.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    role="menuitemradio"
                    aria-checked={activeFileFolder === folder}
                    className={activeFileFolder === folder ? 'is-active' : ''}
                    onClick={() => {
                      setActiveFileFolder(folder);
                      setDirty(true);
                      setShowFolderMenu(false);
                    }}
                  >
                    <span>{folder}</span>
                    {activeFileFolder === folder && <LabCheckIcon size={11} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="codelab-crumb-slash" aria-hidden="true">
            /
          </span>

          {editingTitle ? (
            <input
              type="text"
              className="codelab-crumb-input"
              value={activeFileTitle}
              autoFocus
              onChange={(e) => {
                setActiveFileTitle(e.target.value);
                setDirty(true);
              }}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  setEditingTitle(false);
                }
              }}
              placeholder="输入实验文件名…"
              aria-label="当前代码实验文件名"
            />
          ) : (
            <button
              type="button"
              className="codelab-crumb-title"
              onClick={() => setEditingTitle(true)}
              title="点击重命名当前实验文件"
            >
              <span>{activeFileTitle || '未命名实验'}</span>
            </button>
          )}

          <button
            type="button"
            className={`codelab-save-dot-btn${dirty ? ' is-dirty' : ''}`}
            onClick={() => handleSaveToCollection(false)}
            title={
              dirty
                ? '有未归档更改 · 点击存入代码库 (Ctrl+S)'
                : '已归档至代码库 (Ctrl+S 覆盖保存)'
            }
            aria-label="保存当前实验到代码库"
          >
            <LabSaveIcon size={12} />
            <span>保存</span>
          </button>
          <span className="codelab-save-state" role="status">
            {activeFileId ? (dirty ? '未保存' : '已保存') : '未归档'}
          </span>
        </div>

        {/* Primary execution & cell insertion */}
        <div className="codelab-toolbar-center">
          <button
            type="button"
            className="codelab-tool-btn is-primary"
            onClick={() => void runCellById(focusedCellId, false)}
            disabled={isAnyRunning && canvasViewMode === 'notebook'}
            title="运行当前选中格 (Ctrl+Enter)"
          >
            <LabPlayIcon size={12} />
            <span>运行当前格</span>
          </button>
          {isAnyRunning ? (
            <button
              type="button"
              className="codelab-tool-btn is-danger"
              onClick={handleInterruptExecution}
              title="中断当前执行"
            >
              <LabStopIcon size={11} />
              <span>停止</span>
            </button>
          ) : (
            <button
              type="button"
              className="codelab-tool-btn"
              onClick={() => void handleRunAll()}
              title="从上到下依次运行全部代码格"
            >
              <LabPlayAllIcon size={12} />
              <span>运行全部</span>
            </button>
          )}
          <details className="codelab-insert-menu codelab-run-range-menu">
            <summary
              className="codelab-tool-btn"
              title="选择运行范围"
              aria-label="选择运行范围"
            >
              <LabChevronDownIcon size={10} />
            </summary>
            <div className="codelab-insert-options">
              <button
                type="button"
                onClick={(event) => {
                  void handleRunRange('through');
                  event.currentTarget
                    .closest('details')
                    ?.removeAttribute('open');
                }}
              >
                运行至当前格
              </button>
              <button
                type="button"
                onClick={(event) => {
                  void handleRunRange('below');
                  event.currentTarget
                    .closest('details')
                    ?.removeAttribute('open');
                }}
              >
                从当前格运行到末尾
              </button>
              <button
                type="button"
                onClick={(event) => {
                  handleGoToNextError();
                  event.currentTarget
                    .closest('details')
                    ?.removeAttribute('open');
                }}
              >
                跳转下一处错误
              </button>
            </div>
          </details>

          <span className="codelab-tool-sep" aria-hidden="true" />

          <details className="codelab-insert-menu">
            <summary
              className="codelab-tool-btn"
              title="在当前格下方添加单元格"
            >
              <LabPlusIcon size={12} />
              <span>添加单元格</span>
              <LabChevronDownIcon size={10} />
            </summary>
            <div className="codelab-insert-options">
              <button
                type="button"
                onClick={(event) => {
                  insertCell('below', 'code');
                  event.currentTarget
                    .closest('details')
                    ?.removeAttribute('open');
                }}
              >
                <LabCodeIcon size={13} /> 代码单元格
              </button>
              <button
                type="button"
                onClick={(event) => {
                  insertCell('below', 'markdown');
                  event.currentTarget
                    .closest('details')
                    ?.removeAttribute('open');
                }}
              >
                <LabNoteIcon size={13} /> Markdown 笔记
              </button>
            </div>
          </details>
        </div>

        {/* Runtime, width toggle, bottom drawer toggle and More menu */}
        <div className="codelab-toolbar-right">
          <div className="codelab-popover-wrap" ref={kernelMenuRef}>
            <button
              type="button"
              className={`codelab-kernel-trigger is-${kernelSummary.tone}`}
              onClick={() => setShowKernelMenu((v) => !v)}
              aria-expanded={showKernelMenu}
              aria-haspopup="menu"
              title={`切换语言与计算内核环境 · ${kernelSummary.tone === 'busy' ? '运行中' : kernelSummary.tone === 'warn' ? '不可用' : kernelSummary.tone === 'idle' ? '未启动' : '就绪'}`}
              aria-label={`${kernelSummary.tag} ${kernelSummary.label}，切换内核`}
            >
              <span
                className={`codelab-kernel-dot is-${kernelSummary.tone}`}
                aria-hidden="true"
              />
              <span className="codelab-kernel-lang">{kernelSummary.tag}</span>
              <span className="codelab-kernel-name">{kernelSummary.label}</span>
              <span className="codelab-kernel-state">
                {kernelSummary.tone === 'busy'
                  ? '运行中'
                  : kernelSummary.tone === 'warn'
                    ? '不可用'
                    : kernelSummary.tone === 'idle'
                      ? '未启动'
                      : '就绪'}
              </span>
              <LabChevronDownIcon size={10} />
            </button>

            {showKernelMenu && (
              <div
                className="codelab-popover-menu codelab-kernel-menu"
                role="menu"
              >
                <div className="codelab-popover-head">计算语言</div>
                <div className="codelab-kernel-lang-tabs">
                  {(['python', 'c', 'cpp'] as const).map((langOpt) => (
                    <button
                      key={langOpt}
                      type="button"
                      className={language === langOpt ? 'is-active' : ''}
                      onClick={() => handleSwitchLanguage(langOpt)}
                    >
                      {langOpt === 'python'
                        ? 'Python'
                        : langOpt === 'c'
                          ? 'C · GCC'
                          : 'C++ · G++'}
                    </button>
                  ))}
                </div>

                {language === 'python' ? (
                  <>
                    <div className="codelab-popover-head">
                      Python 运行时内核
                    </div>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selectedPyRuntime === 'pyodide'}
                      className={`codelab-kernel-option${selectedPyRuntime === 'pyodide' ? ' is-active' : ''}`}
                      onClick={() => {
                        void handleSwitchPythonRuntime('pyodide');
                        setShowKernelMenu(false);
                      }}
                    >
                      <div className="codelab-kernel-opt-main">
                        <strong>Pyodide · WebAssembly 沙盒</strong>
                        <span>零配置隔离运行 · 支持数值计算</span>
                      </div>
                      {selectedPyRuntime === 'pyodide' && (
                        <LabCheckIcon size={12} />
                      )}
                    </button>
                    {pythonEnvs.map((env) => {
                      const pkgs = [
                        env.hasNumpy ? 'np' : '',
                        env.hasMatplotlib ? 'plt' : '',
                        env.hasPandas ? 'pd' : '',
                      ].filter(Boolean);
                      const isSelected = selectedPyRuntime === env.pythonPath;
                      return (
                        <button
                          key={env.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          className={`codelab-kernel-option${isSelected ? ' is-active' : ''}`}
                          onClick={() => {
                            void handleSwitchPythonRuntime(env.pythonPath);
                            setShowKernelMenu(false);
                          }}
                        >
                          <div className="codelab-kernel-opt-main">
                            <strong>
                              {env.label}
                              {env.version ? ` v${env.version}` : ''}
                            </strong>
                            <span>
                              {pkgs.length > 0
                                ? pkgs.join(' · ')
                                : env.pythonPath}
                            </span>
                          </div>
                          {isSelected && <LabCheckIcon size={12} />}
                        </button>
                      );
                    })}
                    <div className="codelab-popover-sep" />
                    <button
                      type="button"
                      onClick={() => {
                        setShowKernelMenu(false);
                        void handleResetPythonKernel();
                      }}
                    >
                      <LabResetIcon size={12} />
                      <span>重置 Python 内核变量空间</span>
                    </button>
                  </>
                ) : (
                  <>
                    <div className="codelab-popover-head">本地编译工具链</div>
                    <div className="codelab-kernel-info-row">
                      <span
                        className={`codelab-kernel-dot is-${cCompilerReady === false ? 'warn' : 'ready'}`}
                      />
                      <span>
                        {cCompilerReady === false
                          ? cCompilerError || '未检测到本地 GCC/G++'
                          : '本地 GCC / G++ 编译链路就绪'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowPrologue((s) => !s);
                        setShowKernelMenu(false);
                      }}
                    >
                      <LabCodeIcon size={12} />
                      <span>
                        {showPrologue
                          ? '收起 #include 前置格'
                          : '展开 #include 前置格'}
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            className={`codelab-tool-btn codelab-width-toggle${fullWidth ? ' is-active' : ''}`}
            onClick={() => setFullWidth((value) => !value)}
            aria-pressed={fullWidth}
            title={fullWidth ? '切换标准正文宽度' : '使用全宽编辑区'}
          >
            <span>{fullWidth ? '标准宽度' : '全宽'}</span>
          </button>

          {language === 'python' ? (
            <button
              type="button"
              className={`codelab-tool-btn is-tabular${showVars && activeBottomTab === 'vars' ? ' is-active' : ''}`}
              onClick={() => {
                if (bottomDrawerOpen && activeBottomTab === 'vars') {
                  setShowVars(false);
                  setReplOpen(false);
                } else {
                  setBottomDrawerTab('vars');
                  setShowVars(true);
                }
              }}
              title="在底部抽屉打开 / 收起 Python 变量检查器"
              aria-expanded={showVars && activeBottomTab === 'vars'}
            >
              <LabVarsIcon size={12} />
              <span>变量</span>
              {variables.length > 0 && (
                <span className="codelab-vars-badge">{variables.length}</span>
              )}
            </button>
          ) : (
            <button
              type="button"
              className={`codelab-tool-btn${showPrologue ? ' is-active' : ''}`}
              onClick={() => setShowPrologue((s) => !s)}
              title="切换共享头文件与前置定义"
            >
              <span>#include</span>
            </button>
          )}

          <div className="codelab-popover-wrap" ref={exportMenuRef}>
            <button
              type="button"
              className={`codelab-icon-only-btn${showExportMenu ? ' is-active' : ''}`}
              onClick={() => setShowExportMenu((v) => !v)}
              aria-expanded={showExportMenu}
              aria-haspopup="menu"
              aria-label="更多操作与导出"
              title="视图、多开、导入导出与维护"
            >
              <LabMoreIcon size={14} />
            </button>
            {showExportMenu && (
              <div className="codelab-popover-menu" role="menu">
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    const next =
                      canvasViewMode === 'notebook' ? 'script' : 'notebook';
                    if (next === 'script') {
                      setCells(getCellsWithLiveSources());
                    }
                    setCanvasViewMode(next);
                  }}
                >
                  {canvasViewMode === 'notebook'
                    ? '切换至完整源码视图'
                    : '返回交互单元格视图'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    setEditingTitle(true);
                  }}
                >
                  重命名实验本
                </button>
                {onOpenSyncView && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowExportMenu(false);
                      onOpenSyncView();
                    }}
                  >
                    新建同步视图（右侧分屏）
                  </button>
                )}
                {onDuplicateNotebook && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowExportMenu(false);
                      const saved = handleSaveToCollection(false);
                      if (saved) {
                        onDuplicateNotebook(saved);
                      }
                    }}
                  >
                    复制实验本（新文档 · 独立内核）
                  </button>
                )}
                <div className="codelab-popover-sep" />
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    handleSaveToCollection(true);
                  }}
                >
                  另存为代码库新文件
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    fileInputRef.current?.click();
                  }}
                >
                  打开 / 导入 .ipynb
                </button>
                <div className="codelab-popover-sep" />
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    handleExportIpynb();
                  }}
                >
                  导出标准 .ipynb 文件
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    handleExportScriptFile();
                  }}
                >
                  导出完整源码 (.
                  {language === 'cpp' ? 'cpp' : language === 'c' ? 'c' : 'py'})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    void handleExportMarkdownNote();
                  }}
                >
                  写入知识库 Markdown 笔记
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    void handleExportNotebookToMindmap();
                  }}
                >
                  追加实验结论到当前思维导图
                </button>
                <div className="codelab-popover-sep" />
                {language === 'python' && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowExportMenu(false);
                      void handleResetPythonKernel();
                    }}
                  >
                    重置 Python 内核状态
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    handleClearAllOutputs();
                  }}
                >
                  清空全部单元格输出
                </button>
              </div>
            )}
          </div>

          <details className="codelab-help-menu">
            <summary
              className="codelab-icon-only-btn"
              aria-label="实验本快捷键帮助"
              title="实验本快捷键帮助"
            >
              ?
            </summary>
            <div className="codelab-help-content">
              <strong>快捷键</strong>
              <span>
                <kbd>Shift+Enter</kbd> 运行并跳到下一格
              </span>
              <span>
                <kbd>Ctrl+Enter</kbd> 运行当前格
              </span>
              <span>
                <kbd>Esc</kbd> 命令模式 · <kbd>Enter</kbd> 编辑模式
              </span>
              <span>
                <kbd>J / K</kbd> 移动 · <kbd>A / B</kbd> 插格 · <kbd>DD</kbd>{' '}
                删除
              </span>
            </div>
          </details>

          <input
            ref={fileInputRef}
            type="file"
            accept=".ipynb,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                try {
                  const imported = parseIpynbJson(String(reader.result ?? ''));
                  liveSourceMapRef.current = new Map(
                    imported.cells.map((c) => [c.id, c.source]),
                  );
                  setLanguage(imported.language);
                  setCells(imported.cells);
                  setDirty(true);
                  if (imported.cells[0]) {
                    setFocusedCellId(imported.cells[0].id);
                    setHydratedCellIds([imported.cells[0].id]);
                  }
                  showTempNotice(`已导入 ${imported.cells.length} 个实验格`);
                } catch {
                  showTempNotice('解析 .ipynb JSON 失败');
                }
              };
              reader.readAsText(file);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      {notice && (
        <div className="codelab-notice-strip" role="status">
          {notice}
        </div>
      )}

      {/* Main Notebook / Script Stage + Dedicated Right Pinned Output Panel */}
      <div className="codelab-main-area">
        <div className="codelab-cells-scroll" ref={cellsScrollRef}>
          <div
            className={`codelab-paper-column${fullWidth || isSplitView ? ' is-full-width' : ''}`}
          >
            {canvasViewMode === 'script' ? (
              <div className="codelab-script-view">
                <div className="codelab-script-head">
                  <div className="codelab-script-title">
                    <span className="codelab-script-lang-pill">
                      {language.toUpperCase()}
                    </span>
                    <strong>{activeFileTitle}</strong>
                    <span className="codelab-script-meta">
                      {cells.length} 格 ·{' '}
                      {assembledFullScript.split('\n').length} 行
                    </span>
                  </div>
                  <div className="codelab-script-actions">
                    <button
                      type="button"
                      className="codelab-tool-btn"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(assembledFullScript)
                          .then(() => {
                            setCopiedScript(true);
                            showTempNotice('已复制完整汇编源码');
                            window.setTimeout(
                              () => setCopiedScript(false),
                              1400,
                            );
                          });
                      }}
                    >
                      {copiedScript ? (
                        <LabCheckIcon size={12} />
                      ) : (
                        <LabCopyIcon size={12} />
                      )}
                      <span>{copiedScript ? '已复制' : '复制源码'}</span>
                    </button>
                    <button
                      type="button"
                      className="codelab-tool-btn"
                      onClick={handleExportScriptFile}
                    >
                      导出 .
                      {language === 'cpp'
                        ? 'cpp'
                        : language === 'c'
                          ? 'c'
                          : 'py'}
                    </button>
                    <button
                      type="button"
                      className="codelab-tool-btn is-primary"
                      onClick={() => handleSaveToCollection(false)}
                    >
                      <LabSaveIcon size={12} />
                      <span>归档</span>
                    </button>
                    <button
                      type="button"
                      className="codelab-tool-btn"
                      onClick={() => setCanvasViewMode('notebook')}
                    >
                      <LabCellsIcon size={12} />
                      <span>返回实验本</span>
                    </button>
                  </div>
                </div>
                <pre className="codelab-script-pre">
                  <code>{assembledFullScript}</code>
                </pre>
              </div>
            ) : (
              <>
                {/* C/C++ Shared Prologue Header Strip */}
                {showPrologue && language !== 'python' && (
                  <section className="codelab-prologue-box">
                    <div className="codelab-prologue-head">
                      <span>
                        SHARED PROLOGUE · {language === 'cpp' ? 'C++' : 'C'}{' '}
                        公共头文件与辅助声明
                      </span>
                      <button
                        type="button"
                        className="codelab-ghost-icon-btn"
                        onClick={() => setShowPrologue(false)}
                        title="收起前置定义"
                      >
                        <LabCloseIcon size={11} />
                      </button>
                    </div>
                    <textarea
                      className="codelab-prologue-input"
                      rows={4}
                      value={prologueSource}
                      onChange={(e) => {
                        setPrologueSource(e.target.value);
                        setDirty(true);
                      }}
                      spellCheck={false}
                    />
                  </section>
                )}

                {/* Paper-Stream Memoized Cells */}
                <div className="codelab-cell-stream">
                  {cells.map((cell, index) => (
                    <CodeLabCellRow
                      key={cell.id}
                      cell={cell}
                      index={index}
                      totalCells={cells.length}
                      isFocused={cell.id === focusedCellId}
                      isEditing={editingCellId === cell.id}
                      hydrated={
                        cell.id === focusedCellId ||
                        editingCellId === cell.id ||
                        hydratedSet.has(cell.id)
                      }
                      theme={theme}
                      canSendToShell={Boolean(onSendToShellPane)}
                      canSendToAgent={Boolean(onSendToAgentPane)}
                      liveSourceMapRef={liveSourceMapRef}
                      onSelectCell={handleSelectCell}
                      onRequestHydrate={handleRequestHydrate}
                      onCommitSource={handleCommitCellSource}
                      onChangeLanguage={handleChangeCellLanguage}
                      onChangeStdin={handleChangeCellStdin}
                      onToggleMarkdownEdit={handleToggleMarkdownEdit}
                      onStartMarkdownEdit={handleStartMarkdownEdit}
                      onEditorFocus={handleEditorFocus}
                      onEditorBlur={handleEditorBlur}
                      onRunCell={runCellById}
                      onEscapeCommandMode={handleEscapeCommandMode}
                      onSendToShell={handleSendCellToShellById}
                      onSendToAgent={handleSendCellToAgentById}
                      onMoveCell={handleMoveCell}
                      onDeleteCell={deleteCellById}
                      onDuplicateCell={handleDuplicateCell}
                      onInsertCellBelow={handleInsertCellBelowById}
                      onExportCellToStudy={(cellId, target) => {
                        void handleExportCellToStudy(cellId, target);
                      }}
                      onClearOutputs={handleClearCellOutputs}
                      onZoomImage={setZoomedImageSrc}
                      onPinOutput={(cellId) => {
                        setPinnedCellId((current) =>
                          current === cellId ? null : cellId,
                        );
                      }}
                      pinnedOutputCellId={pinnedCellId}
                    />
                  ))}
                </div>

                {/* Quiet bottom append affordance */}
                <div className="codelab-append-strip">
                  <button
                    type="button"
                    className="codelab-append-btn"
                    onClick={() => insertCell('below', 'code')}
                  >
                    <LabPlusIcon size={11} />
                    <span>新增代码格</span>
                  </button>
                  <button
                    type="button"
                    className="codelab-append-btn"
                    onClick={() => insertCell('below', 'markdown')}
                  >
                    <LabNoteIcon size={11} />
                    <span>新增笔记格</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {pinnedCell && pinnedCell.outputs.length > 0 && (
          <aside className="codelab-pinned-panel" aria-label="固定的代码格输出">
            <div className="codelab-pinned-head">
              <div>
                <strong>固定输出</strong>
                <span>
                  {activeFileTitle} · 格{' '}
                  {cells.findIndex((cell) => cell.id === pinnedCell.id) + 1}
                </span>
              </div>
              <button
                type="button"
                className="codelab-ghost-icon-btn"
                onClick={() => setPinnedCellId(null)}
                title="关闭固定输出"
                aria-label="关闭固定输出"
              >
                <LabCloseIcon size={12} />
              </button>
            </div>
            <CellOutputList
              cellId={pinnedCell.id}
              outputs={pinnedCell.outputs}
              durationMs={pinnedCell.durationMs}
              stage={pinnedCell.stage}
              theme={theme}
              onClearOutputs={handleClearCellOutputs}
              onZoomImage={setZoomedImageSrc}
              stale={Boolean(
                pinnedCell.lastExecutedSource !== undefined &&
                pinnedCell.lastExecutedSource !== pinnedCell.source,
              )}
            />
          </aside>
        )}
      </div>

      {/* Unified Resizable Bottom Console & Variables Drawer (Collapsed by Default) */}
      <section
        className={`codelab-bottom-drawer${bottomDrawerOpen ? ' is-open' : ''}`}
        aria-label="控制台与变量抽屉"
      >
        {bottomDrawerOpen && (
          <div
            className="codelab-bottom-drawer-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="拖动调整底部控制台与变量抽屉高度"
            onPointerDown={(event) => {
              event.preventDefault();
              const startY = event.clientY;
              const startHeight = bottomDrawerHeight;
              const onPointerMove = (moveEvent: PointerEvent) => {
                const nextHeight = Math.max(
                  120,
                  Math.min(380, startHeight + (startY - moveEvent.clientY)),
                );
                setBottomDrawerHeight(nextHeight);
              };
              const onPointerUp = (upEvent: PointerEvent) => {
                const finalHeight = Math.max(
                  120,
                  Math.min(380, startHeight + (startY - upEvent.clientY)),
                );
                try {
                  localStorage.setItem(
                    'seamind:codelab-drawer-height:v1',
                    String(finalHeight),
                  );
                } catch {
                  // ignore storage errors
                }
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
              };
              window.addEventListener('pointermove', onPointerMove);
              window.addEventListener('pointerup', onPointerUp, { once: true });
            }}
          />
        )}

        <div className="codelab-bottom-drawer-bar">
          <div className="codelab-bottom-drawer-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={bottomDrawerOpen && activeBottomTab === 'console'}
              className={`codelab-bottom-tab-btn${bottomDrawerOpen && activeBottomTab === 'console' ? ' is-active' : ''}`}
              onClick={() => {
                if (bottomDrawerOpen && activeBottomTab === 'console') {
                  setReplOpen(false);
                  setShowVars(false);
                } else {
                  setBottomDrawerTab('console');
                  setReplOpen(true);
                  requestAnimationFrame(() => replInputRef.current?.focus());
                }
              }}
            >
              <span>
                控制台
                {replHistory.length > 0 ? ` (${replHistory.length})` : ''}
              </span>
            </button>

            {language === 'python' && (
              <button
                type="button"
                role="tab"
                aria-selected={bottomDrawerOpen && activeBottomTab === 'vars'}
                className={`codelab-bottom-tab-btn${bottomDrawerOpen && activeBottomTab === 'vars' ? ' is-active' : ''}`}
                onClick={() => {
                  if (bottomDrawerOpen && activeBottomTab === 'vars') {
                    setShowVars(false);
                    setReplOpen(false);
                  } else {
                    setBottomDrawerTab('vars');
                    setShowVars(true);
                  }
                }}
              >
                <LabVarsIcon size={11} />
                <span>变量 ({variables.length})</span>
              </button>
            )}
          </div>

          <div className="codelab-bottom-drawer-status" role="status">
            <span
              className={`codelab-bottom-status-item${dirty ? ' is-dirty' : ''}`}
            >
              {activeFileTitle || '未命名实验'} ·{' '}
              {activeFileId ? (dirty ? '未保存 ●' : '已保存') : '未归档'}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={`codelab-bottom-status-item${isAnyRunning ? ' is-running' : ''}`}
            >
              {kernelSummary.tag} ({kernelSummary.label}) ·{' '}
              {isAnyRunning
                ? `执行中 (${Math.max(1, runningCellsCount)} 格)`
                : '就绪'}
            </span>
            <span aria-hidden="true">·</span>
            <span className={`codelab-mode-telemetry is-${interactionMode}`}>
              {interactionMode === 'edit' ? '编辑模式' : '命令模式'}
            </span>
            <button
              type="button"
              className="codelab-ghost-icon-btn"
              onClick={() => {
                if (bottomDrawerOpen) {
                  setReplOpen(false);
                  setShowVars(false);
                } else {
                  setReplOpen(true);
                }
              }}
              aria-label={bottomDrawerOpen ? '收起底部抽屉' : '展开底部抽屉'}
              title={bottomDrawerOpen ? '收起底部抽屉' : '展开底部抽屉'}
            >
              {bottomDrawerOpen ? '⌄' : '⌃'}
            </button>
          </div>
        </div>

        {bottomDrawerOpen && (
          <div
            id={`codelab-console-${tab.id}`}
            className="codelab-bottom-drawer-body"
            style={{ height: `${bottomDrawerHeight}px` }}
          >
            {activeBottomTab === 'console' ? (
              <div
                className={`codelab-console-content${replHistory.length === 0 ? ' is-empty' : ''}`}
                style={{ height: '100%', maxHeight: 'none', resize: 'none' }}
              >
                {replHistory.length > 0 && !replLogCollapsed && (
                  <div className="codelab-repl-log">
                    {replHistory.slice(-6).map((entry) => (
                      <div
                        key={entry.id}
                        className={`codelab-repl-entry${entry.ok ? '' : ' is-err'}`}
                      >
                        <div className="codelab-repl-in">
                          <code>
                            {entry.language === 'python'
                              ? '>>> '
                              : `${entry.language}> `}
                            {entry.code}
                          </code>
                          {entry.durationMs !== undefined && (
                            <span>
                              {formatDurationCompact(entry.durationMs)}
                            </span>
                          )}
                        </div>
                        <pre className="codelab-repl-out">{entry.text}</pre>
                        {entry.images?.map((src, idx) => (
                          <img
                            key={idx}
                            src={src}
                            alt="REPL 绘图"
                            className="codelab-repl-img"
                            onClick={() => setZoomedImageSrc(src)}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                <div className="codelab-repl-input-row">
                  <span className="codelab-repl-prompt">
                    {language === 'python' ? '>>>' : `${language}>`}
                  </span>
                  <input
                    ref={replInputRef}
                    type="text"
                    className="codelab-repl-input"
                    value={replInput}
                    onChange={(e) => setReplInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleRunQuickRepl();
                      }
                    }}
                    placeholder={
                      language === 'python'
                        ? '快速求值控制台（共享当前实验本内核变量）· Enter 执行'
                        : `快速执行单行 ${language.toUpperCase()} 语句（共享头文件前置）· Enter 执行`
                    }
                  />
                  {replHistory.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="codelab-repl-action-btn"
                        onClick={() => setReplLogCollapsed((c) => !c)}
                        title={
                          replLogCollapsed ? '展开控制台记录' : '收起控制台记录'
                        }
                      >
                        {replLogCollapsed
                          ? `记录 (${replHistory.length})`
                          : '收起'}
                      </button>
                      <button
                        type="button"
                        className="codelab-ghost-icon-btn"
                        onClick={() => setReplHistory([])}
                        title="清空控制台记录"
                      >
                        <LabTrashIcon size={11} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="codelab-repl-exec-btn"
                    disabled={replBusy || !replInput.trim()}
                    onClick={() => void handleRunQuickRepl()}
                    title="执行控制台表达式 (Enter)"
                  >
                    <LabPlayIcon size={11} />
                    <span>{replBusy ? '运行中' : '求值'}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="codelab-bottom-vars-body"
                aria-label="Python 内存变量监视表"
              >
                <div className="codelab-bottom-vars-toolbar">
                  <input
                    type="search"
                    className="codelab-vars-search"
                    value={varFilter}
                    onChange={(e) => setVarFilter(e.target.value)}
                    placeholder="筛选变量名、类型或值…"
                    aria-label="筛选变量"
                  />
                  <button
                    type="button"
                    className="codelab-float-btn"
                    onClick={() => void handleResetPythonKernel()}
                    title="清空并重置 Python 内核变量"
                  >
                    <LabResetIcon size={11} />
                    <span>重置内核变量</span>
                  </button>
                </div>

                <div className="codelab-vars-table-head" aria-hidden="true">
                  <span>NAME</span>
                  <span>TYPE</span>
                  <span>VALUE</span>
                </div>

                <div className="codelab-vars-list">
                  {filteredVariables.length === 0 ? (
                    <div className="codelab-vars-empty">
                      {variables.length === 0
                        ? '运行 Python 代码格后显示活跃变量'
                        : '无匹配变量'}
                    </div>
                  ) : (
                    filteredVariables.map((v) => {
                      const isExpanded = expandedVarName === v.name;
                      return (
                        <div
                          key={v.name}
                          className={`codelab-var-row${isExpanded ? ' is-expanded' : ''}`}
                          role="button"
                          tabIndex={0}
                          aria-expanded={isExpanded}
                          aria-label={`查看变量 ${v.name} 的详情`}
                          onClick={() =>
                            setExpandedVarName((curr) =>
                              curr === v.name ? null : v.name,
                            )
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setExpandedVarName((curr) =>
                                curr === v.name ? null : v.name,
                              );
                            }
                          }}
                        >
                          <div className="codelab-var-grid">
                            <strong className="codelab-var-name" title={v.name}>
                              {v.name}
                            </strong>
                            <span
                              className="codelab-var-type"
                              title={v.typeName}
                            >
                              {v.typeName}
                            </span>
                            <span className="codelab-var-val" title={v.preview}>
                              {v.preview}
                            </span>
                          </div>
                          {isExpanded && (
                            <div
                              className="codelab-var-detail"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <pre>{v.preview}</pre>
                              {variablePreview?.name === v.name && (
                                <pre className="codelab-var-sample">
                                  {variablePreview.text}
                                </pre>
                              )}
                              <div className="codelab-var-detail-actions">
                                <button
                                  type="button"
                                  className="codelab-float-btn"
                                  disabled={
                                    isAnyRunning || variablePreviewLoading
                                  }
                                  onClick={() =>
                                    void handleInspectVariable(v.name)
                                  }
                                >
                                  {variablePreviewLoading
                                    ? '正在读取…'
                                    : '预览前 20 行 / 元素'}
                                </button>
                                <button
                                  type="button"
                                  className="codelab-float-btn"
                                  onClick={() => {
                                    setReplInput(`print(repr(${v.name}))`);
                                    setBottomDrawerTab('console');
                                    setReplOpen(true);
                                    requestAnimationFrame(() =>
                                      replInputRef.current?.focus(),
                                    );
                                  }}
                                >
                                  在控制台查看
                                </button>
                                <button
                                  type="button"
                                  className="codelab-float-btn"
                                  onClick={() =>
                                    void navigator.clipboard
                                      ?.writeText(v.preview)
                                      .then(() =>
                                        showTempNotice(
                                          `已复制 ${v.name} 预览值`,
                                        ),
                                      )
                                  }
                                >
                                  复制值
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Institutional Chart Lightbox */}
      {zoomedImageSrc && (
        <div
          className="codelab-lightbox-backdrop"
          onClick={() => setZoomedImageSrc(null)}
          role="dialog"
          aria-modal="true"
          aria-label="实验图表放大预览"
        >
          <div
            className="codelab-lightbox-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="codelab-lightbox-head">
              <span>FIGURE INSPECTOR</span>
              <button
                type="button"
                className="codelab-ghost-icon-btn"
                onClick={() => setZoomedImageSrc(null)}
                aria-label="关闭预览"
              >
                <LabCloseIcon size={13} />
              </button>
            </div>
            <img src={zoomedImageSrc} alt="实验图表放大预览" />
          </div>
        </div>
      )}
    </div>
  );
});
