import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFallbackTerminalCapabilities } from '../agent/tools/terminal-bridge';
import {
  buildSmartFooterHints,
  WORKSPACE_LAYOUT_PRESETS,
  type WorkspacePresetSpec,
} from './terminal-agent-protocol';
import { terminalApi } from './terminal-api';
import type { Theme } from '../app/app-storage';
import type { EpubBookDocument } from '../library/library';
import {
  LINUX_CHEAT_ITEMS,
  KNOWLEDGE_ACTION_ITEMS,
} from './terminal-cheatsheet';
import {
  COMMAND_CATEGORY_FILTERS,
  commandMatchesFocus,
  commandTextForShell,
  filterCommandLibrary,
  moveFocusedCommand,
  shellsWithCommand,
} from './terminal-commands';
import {
  filterKnowledgeActions,
  KNOWLEDGE_TARGET_LABEL,
  knowledgeActionNote,
  knowledgeCommandForShell,
  knowledgeShells,
} from './terminal-knowledge';
import {
  DEFAULT_TERMINAL_PREFERENCES,
  loadTerminalPreferences,
  onTerminalPreferencesChanged,
  saveTerminalPreferences,
} from './terminal-preferences';
import { normalizeDisplayPath } from './terminal-alacritty';
import {
  TerminalAgentView,
  type TerminalAgentViewHandle,
} from './TerminalAgentView';
import {
  TerminalCodeLabView,
  type CodeLabCanvasViewMode,
  type TerminalCodeLabViewHandle,
} from './TerminalCodeLabView';
import {
  LabChevronDownIcon,
  LabChevronRightIcon,
  LabCloseIcon,
  LabPlayIcon,
  LabPlusIcon,
  LabStarIcon,
} from './CodeLabIcons';
import {
  CODELAB_COLLECTION_EVENT,
  DEFAULT_CODELAB_SNIPPETS,
  deleteCodeLabFile,
  groupCodeLabFilesByFolder,
  loadCodeLabCollection,
  toggleStarCodeLabFile,
  type CodeLabSavedFile,
  type CodeLabSnippetItem,
} from './terminal-codelab-model';
import {
  TerminalSessionView,
  type TerminalSessionRuntimeMeta,
  type TerminalSessionViewHandle,
} from './TerminalSessionView';
import type {
  SplitLayoutMode,
  TerminalCliPreset,
  TerminalCodeLabLanguage,
  TerminalPreferences,
  TerminalShellOption,
  TerminalShellType,
  TerminalTab,
  TerminalTabKind,
  TerminalWorkspaceBridge,
} from './terminal-types';
import {
  COMMAND_LIBRARY_SHORTCUT_LABEL,
  isCommandLibraryShortcut,
  LAST_TERMINAL_TOOL_KEY,
  readLastTerminalTool,
  selectTerminalTool,
  TERMINAL_TOOLS,
  terminalEscapeTarget,
  terminalTabShortcutIndex,
  type TerminalToolId,
} from './terminal-tools';
import {
  normalizePaneTabAssignments,
  openStandaloneTerminalWindow,
  visiblePaneCountForMode,
} from './terminal-window';
import './terminal-workspace.css';

interface TerminalWorkspaceProps {
  active: boolean;
  cwd: string;
  theme: Theme;
  books?: EpubBookDocument[];
  onOpenBook?: (book: EpubBookDocument) => void;
  bridge?: TerminalWorkspaceBridge;
  standalone?: boolean;
  initialShell?: TerminalShellType;
  initialCli?: TerminalCliPreset;
  initialKind?: TerminalTabKind;
  initialLabLanguage?: TerminalCodeLabLanguage;
  externalCodeLabPush?: {
    id: number;
    language: TerminalCodeLabLanguage;
    source: string;
    autoRun?: boolean;
  } | null;
  onExternalCodeLabPushConsumed?: (id: number) => void;
}

const DEFAULT_SHELLS: TerminalShellOption[] = [
  {
    id: 'powershell',
    name: 'PowerShell',
    badge: 'PWSH',
    description: 'Windows 宿主终端，已预注入 Seamind MCP 智能体环境',
    available: true,
  },
  {
    id: 'wsl',
    name: 'WSL Linux',
    badge: 'WSL',
    description: 'Windows Subsystem for Linux 原生 Linux 内核环境',
    available: true,
  },
  {
    id: 'bash',
    name: 'Git Bash',
    badge: 'BASH',
    description: 'GNU Bash 环境，内置 Linux 常用工具链',
    available: true,
  },
  {
    id: 'cmd',
    name: 'Command Prompt',
    badge: 'CMD',
    description: 'Windows 经典命令行外壳',
    available: true,
  },
];

const CLI_PRESETS: ReadonlyArray<{
  id: TerminalCliPreset;
  label: string;
  desc: string;
}> = [
  { id: 'agy', label: 'agy', desc: 'Antigravity CLI（含 Seamind 工作区）' },
  { id: 'claude', label: 'claude', desc: 'Claude Code CLI（已注入 MCP）' },
  { id: 'codex', label: 'codex', desc: 'Codex CLI（已注入 MCP）' },
];

const COMMAND_FAVORITES_KEY = 'seamind:terminal-command-favorites:v1';
const COMMAND_RECENTS_KEY = 'seamind:terminal-command-recents:v1';
const MAX_WORKSPACE_TABS = 16;

function readCommandIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function makeTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function LayoutIcon({ mode }: { mode: SplitLayoutMode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="13" height="11" />
      {mode === 'vertical' && <line x1="8" y1="2.5" x2="8" y2="13.5" />}
      {mode === 'horizontal' && <line x1="1.5" y1="8" x2="14.5" y2="8" />}
      {mode === 'tri' && (
        <>
          <line x1="8" y1="2.5" x2="8" y2="13.5" />
          <line x1="8" y1="8" x2="14.5" y2="8" />
        </>
      )}
      {mode === 'quad' && (
        <>
          <line x1="8" y1="2.5" x2="8" y2="13.5" />
          <line x1="1.5" y1="8" x2="14.5" y2="8" />
        </>
      )}
    </svg>
  );
}

function DrawerSplitIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="13" height="11" />
      <line x1="10.5" y1="2.5" x2="10.5" y2="13.5" />
    </svg>
  );
}

function ZoomPaneIcon({ zoomed }: { zoomed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      {zoomed ? (
        <>
          <polyline points="6 2 6 6 2 6" />
          <polyline points="10 14 10 10 14 10" />
          <line x1="2" y1="2" x2="6" y2="6" />
          <line x1="14" y1="14" x2="10" y2="10" />
        </>
      ) : (
        <>
          <polyline points="10 2 14 2 14 6" />
          <polyline points="6 14 2 14 2 10" />
          <line x1="14" y1="2" x2="9.5" y2="6.5" />
          <line x1="2" y1="14" x2="6.5" y2="9.5" />
        </>
      )}
    </svg>
  );
}

function PopoutWindowIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <rect x="1.5" y="4.5" width="9.5" height="9" />
      <polyline points="8.5 2 14 2 14 7.5" />
      <line x1="7" y1="9" x2="13.8" y2="2.2" />
    </svg>
  );
}

export default function TerminalWorkspace({
  active,
  cwd,
  theme,
  books = [],
  onOpenBook,
  bridge,
  standalone = false,
  initialShell = 'powershell',
  initialCli,
  initialKind = 'shell',
  initialLabLanguage = 'python',
  externalCodeLabPush,
  onExternalCodeLabPushConsumed,
}: TerminalWorkspaceProps) {
  const initialCleanCwd = normalizeDisplayPath(cwd);
  const initialTabRef = useRef<TerminalTab>({
    id: 'tab-1',
    title:
      initialKind === 'agent'
        ? 'Seamind Agent'
        : initialKind === 'lab'
          ? initialLabLanguage === 'python'
            ? 'Python 实验本'
            : initialLabLanguage === 'cpp'
              ? 'C++ 实验本'
              : 'C 实验本'
          : initialCli
            ? `${initialCli.toUpperCase()} · ${initialShell.toUpperCase()}`
            : `${initialShell === 'powershell' ? 'PowerShell' : initialShell.toUpperCase()} 1`,
    kind: initialKind,
    shell: initialShell,
    labLanguage: initialKind === 'lab' ? initialLabLanguage : undefined,
    cwd: initialCleanCwd,
    initialCli,
    status: initialKind === 'shell' ? 'starting' : 'ready',
    createdAt: Date.now(),
  });

  const [shells, setShells] = useState<TerminalShellOption[]>(DEFAULT_SHELLS);
  const [tabs, setTabs] = useState<TerminalTab[]>([initialTabRef.current]);
  const [paneTabIds, setPaneTabIds] = useState<string[]>(['tab-1']);
  const [focusedPaneIndex, setFocusedPaneIndex] = useState<number>(0);
  const [splitMode, setSplitMode] = useState<SplitLayoutMode>('single');
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
  const [zoomedPaneIndex, setZoomedPaneIndex] = useState<number | null>(null);
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [sessionMetaById, setSessionMetaById] = useState<
    Record<string, TerminalSessionRuntimeMeta>
  >({});

  const [prefs, setPrefs] = useState<TerminalPreferences>(() =>
    loadTerminalPreferences(),
  );
  const [showPrefsMenu, setShowPrefsMenu] = useState(false);
  const [showPopoutMenu, setShowPopoutMenu] = useState(false);
  const [windowNotice, setWindowNotice] = useState('');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPinned, setDrawerPinned] = useState(false);
  const [drawerTab, setDrawerTab] = useState<TerminalToolId>(() =>
    readLastTerminalTool(
      typeof localStorage === 'undefined' ? null : localStorage,
    ),
  );
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [linuxFilter, setLinuxFilter] = useState<string>('all');
  const [commandQuery, setCommandQuery] = useState('');
  const [focusedCommandId, setFocusedCommandId] = useState<string | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [focusedKnowledgeId, setFocusedKnowledgeId] = useState<string | null>(
    null,
  );
  const [commandView, setCommandView] = useState<
    'all' | 'favorites' | 'recent'
  >('all');
  const [favoriteCommandIds, setFavoriteCommandIds] = useState<string[]>(() =>
    readCommandIds(COMMAND_FAVORITES_KEY),
  );
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>(() =>
    readCommandIds(COMMAND_RECENTS_KEY),
  );
  const [pendingCommand, setPendingCommand] = useState<{
    title: string;
    command: string;
    tabId: string;
    shell: TerminalShellType;
    cwd: string;
  } | null>(null);
  const [showShellMenu, setShowShellMenu] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  // Modular Left Rail (Shell | Agent | Code Lab Collection)
  const [leftRailCollapsed, setLeftRailCollapsed] = useState<boolean>(() => {
    try {
      return (
        localStorage.getItem('seamind:terminal-left-rail-collapsed:v1') === '1'
      );
    } catch {
      return false;
    }
  });
  const [railModule, setRailModule] = useState<TerminalTabKind>(
    initialKind ?? 'shell',
  );
  const [labRailSubTab, setLabRailSubTab] = useState<'files' | 'snippets'>(
    'files',
  );
  const [codeLabFiles, setCodeLabFiles] = useState<CodeLabSavedFile[]>(() =>
    loadCodeLabCollection(),
  );
  const [codeLabSearch, setCodeLabSearch] = useState('');
  const [codeLabFilter, setCodeLabFilter] = useState<
    'all' | TerminalCodeLabLanguage | 'starred'
  >('all');
  const [collapsedLabFolders, setCollapsedLabFolders] = useState<
    Record<string, boolean>
  >({});
  const [activeLabInfo, setActiveLabInfo] = useState<{
    fileId: string | null;
    title: string;
    folder: string;
    language: TerminalCodeLabLanguage;
    viewMode: CodeLabCanvasViewMode;
  }>({
    fileId: null,
    title: 'Python 交互实验本.ipynb',
    folder: '书籍伴读验证',
    language: 'python',
    viewMode: 'notebook',
  });

  useEffect(() => {
    const syncCollection = () => {
      setCodeLabFiles(loadCodeLabCollection());
    };
    window.addEventListener(CODELAB_COLLECTION_EVENT, syncCollection);
    return () =>
      window.removeEventListener(CODELAB_COLLECTION_EVENT, syncCollection);
  }, []);

  const toggleLeftRail = useCallback(() => {
    setLeftRailCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(
          'seamind:terminal-left-rail-collapsed:v1',
          next ? '1' : '0',
        );
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const terminalRefs = useRef<Map<string, TerminalSessionViewHandle>>(
    new Map(),
  );
  const agentRefs = useRef<Map<string, TerminalAgentViewHandle>>(new Map());
  const labRefs = useRef<Map<string, TerminalCodeLabViewHandle>>(new Map());
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const shellMenuRef = useRef<HTMLDivElement>(null);
  const presetMenuRef = useRef<HTMLDivElement>(null);
  const paletteSearchRef = useRef<HTMLInputElement>(null);
  const prefsMenuRef = useRef<HTMLDivElement>(null);
  const popoutMenuRef = useRef<HTMLDivElement>(null);
  const commandSearchRef = useRef<HTMLInputElement>(null);
  const commandPanelRef = useRef<HTMLDivElement>(null);
  const knowledgeSearchRef = useRef<HTMLInputElement>(null);
  const knowledgePanelRef = useRef<HTMLDivElement>(null);

  const visibleCount = visiblePaneCountForMode(splitMode);
  const activePaneIds = useMemo(
    () =>
      normalizePaneTabAssignments(
        paneTabIds,
        tabs.map((t) => t.id),
        visibleCount,
      ),
    [paneTabIds, tabs, visibleCount],
  );
  const safeFocusedPane = Math.min(
    focusedPaneIndex,
    Math.max(0, activePaneIds.length - 1),
  );
  const activeTabId = activePaneIds[safeFocusedPane] ?? tabs[0]?.id ?? '';

  const showTempNotice = (msg: string) => {
    setWindowNotice(msg);
    window.setTimeout(() => {
      setWindowNotice((curr) => (curr === msg ? '' : curr));
    }, 2600);
  };

  useEffect(() => {
    return onTerminalPreferencesChanged(setPrefs);
  }, []);

  const focusTabHandle = useCallback((tabId: string) => {
    terminalRefs.current.get(tabId)?.focus();
    agentRefs.current.get(tabId)?.focus();
    labRefs.current.get(tabId)?.focus();
  }, []);

  const focusActiveTerminal = () => {
    focusTabHandle(activeTabId);
  };

  const applyTool = (next: TerminalToolId) => {
    const result = selectTerminalTool(
      { open: drawerOpen, tool: drawerTab },
      next,
    );
    setDrawerTab(result.tool);
    setDrawerOpen(result.open);
    setToolsMenuOpen(false);
    if (!result.open) focusActiveTerminal();
  };

  useEffect(() => {
    if (!active) return;
    terminalApi
      .detectShells()
      .then((detected) => {
        if (Array.isArray(detected) && detected.length > 0) {
          setShells(detected);
        }
      })
      .catch(() => {
        // Fallback to defaults
      });
  }, [active]);

  useEffect(() => {
    try {
      localStorage.setItem(LAST_TERMINAL_TOOL_KEY, drawerTab);
    } catch {
      // noop
    }
  }, [drawerTab]);

  useEffect(() => {
    if (
      !showShellMenu &&
      !showPresetMenu &&
      !toolsMenuOpen &&
      !showPrefsMenu &&
      !showPopoutMenu
    ) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        showShellMenu &&
        shellMenuRef.current &&
        !shellMenuRef.current.contains(target)
      ) {
        setShowShellMenu(false);
      }
      if (
        showPresetMenu &&
        presetMenuRef.current &&
        !presetMenuRef.current.contains(target)
      ) {
        setShowPresetMenu(false);
      }
      if (
        toolsMenuOpen &&
        toolsMenuRef.current &&
        !toolsMenuRef.current.contains(target)
      ) {
        setToolsMenuOpen(false);
      }
      if (
        showPrefsMenu &&
        prefsMenuRef.current &&
        !prefsMenuRef.current.contains(target)
      ) {
        setShowPrefsMenu(false);
      }
      if (
        showPopoutMenu &&
        popoutMenuRef.current &&
        !popoutMenuRef.current.contains(target)
      ) {
        setShowPopoutMenu(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [
    showShellMenu,
    showPresetMenu,
    toolsMenuOpen,
    showPrefsMenu,
    showPopoutMenu,
  ]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const keyEvent = {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      };
      const tabIndex = terminalTabShortcutIndex(keyEvent);
      if (tabIndex !== null) {
        if (pendingCommand || editingTabId) return;
        const tab = tabs[tabIndex];
        if (!tab) return;
        event.preventDefault();
        event.stopPropagation();
        const alreadyPane = activePaneIds.indexOf(tab.id);
        if (alreadyPane >= 0) {
          setFocusedPaneIndex(alreadyPane);
        } else {
          setPaneTabIds((prev) => {
            const next = [...prev];
            next[safeFocusedPane] = tab.id;
            return next;
          });
        }
        setShowShellMenu(false);
        setToolsMenuOpen(false);
        requestAnimationFrame(() => focusTabHandle(tab.id));
        return;
      }
      if (isCommandLibraryShortcut(keyEvent)) {
        if (pendingCommand || editingTabId) return;
        event.preventDefault();
        event.stopPropagation();
        setDrawerTab('linux');
        setDrawerOpen(true);
        setToolsMenuOpen(false);
        setShowShellMenu(false);
        setShowPresetMenu(false);
        requestAnimationFrame(() => commandSearchRef.current?.focus());
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault();
        event.stopPropagation();
        setPaletteOpen((open) => !open);
        setPaletteQuery('');
        setPaletteIndex(0);
        setShowShellMenu(false);
        setShowPresetMenu(false);
        setShowPrefsMenu(false);
        setShowPopoutMenu(false);
        requestAnimationFrame(() => paletteSearchRef.current?.focus());
        return;
      }
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'm'
      ) {
        if (visibleCount > 1) {
          event.preventDefault();
          event.stopPropagation();
          setZoomedPaneIndex((z) => (z === null ? safeFocusedPane : null));
        }
        return;
      }
      if (event.ctrlKey && event.altKey && !event.shiftKey) {
        if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'l') {
          if (visibleCount > 1) {
            event.preventDefault();
            const nextPane = (safeFocusedPane + 1) % visibleCount;
            setFocusedPaneIndex(nextPane);
            requestAnimationFrame(() =>
              focusTabHandle(activePaneIds[nextPane] ?? ''),
            );
          }
          return;
        }
        if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'h') {
          if (visibleCount > 1) {
            event.preventDefault();
            const prevPane =
              (safeFocusedPane - 1 + visibleCount) % visibleCount;
            setFocusedPaneIndex(prevPane);
            requestAnimationFrame(() =>
              focusTabHandle(activePaneIds[prevPane] ?? ''),
            );
          }
          return;
        }
      }
      if (event.key !== 'Escape') return;
      if (paletteOpen) {
        event.preventDefault();
        setPaletteOpen(false);
        focusActiveTerminal();
        return;
      }
      if (showPresetMenu) {
        event.preventDefault();
        setShowPresetMenu(false);
        return;
      }
      if (showPrefsMenu) {
        event.preventDefault();
        setShowPrefsMenu(false);
        return;
      }
      if (showPopoutMenu) {
        event.preventDefault();
        setShowPopoutMenu(false);
        return;
      }
      const target = terminalEscapeTarget({
        open: drawerOpen,
        tool: drawerTab,
        pinned: drawerPinned,
        toolsMenu: toolsMenuOpen,
        shellMenu: showShellMenu,
        confirmOpen: pendingCommand !== null,
        renaming: editingTabId !== null,
      });
      if (target === 'terminal') return;
      event.preventDefault();
      event.stopPropagation();
      if (target === 'confirm') setPendingCommand(null);
      else if (target === 'shell-menu') setShowShellMenu(false);
      else if (target === 'tools-menu') setToolsMenuOpen(false);
      else if (target === 'rename') setEditingTabId(null);
      else {
        setDrawerOpen(false);
        terminalRefs.current.get(activeTabId)?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    active,
    activePaneIds,
    activeTabId,
    drawerOpen,
    drawerPinned,
    drawerTab,
    editingTabId,
    pendingCommand,
    paletteOpen,
    safeFocusedPane,
    showPopoutMenu,
    showPrefsMenu,
    showPresetMenu,
    showShellMenu,
    tabs,
    toolsMenuOpen,
    visibleCount,
  ]);

  useEffect(() => {
    if (!active || !drawerOpen) return;
    const search =
      drawerTab === 'linux'
        ? commandSearchRef.current
        : drawerTab === 'knowledge'
          ? knowledgeSearchRef.current
          : null;
    if (!search) return;
    const frame = requestAnimationFrame(() => {
      search.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, drawerOpen, drawerTab]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId],
  );

  const focusedLiveCwd =
    terminalRefs.current.get(activeTabId)?.getCwd() ||
    activeTab?.cwd ||
    initialCleanCwd;

  const createNewTab = (
    shell: TerminalShellType = activeTab?.shell ?? 'powershell',
    cliPreset?: TerminalCliPreset,
    targetPaneIdx?: number,
  ): TerminalTab | null => {
    if (tabs.length >= MAX_WORKSPACE_TABS) return null;
    const nextIndex = tabs.length + 1;
    const shellDef = shells.find((s) => s.id === shell);
    const title = cliPreset
      ? `${cliPreset.toUpperCase()} · ${nextIndex}`
      : `${shellDef?.name ?? shell.toUpperCase()} ${nextIndex}`;
    const newTab: TerminalTab = {
      id: makeTabId(),
      title,
      shell,
      cwd: normalizeDisplayPath(focusedLiveCwd),
      initialCli: cliPreset,
      status: 'starting',
      createdAt: Date.now(),
    };
    setTabs((prev) => [...prev, newTab]);
    const slot = targetPaneIdx ?? safeFocusedPane;
    setPaneTabIds((prev) => {
      const next = [...prev];
      next[slot] = newTab.id;
      return next;
    });
    setFocusedPaneIndex(slot);
    setShowShellMenu(false);
    return newTab;
  };

  /**
   * 图二风格的多窗格布局切换：若当前会话数不足目标窗格数，
   * 自动新建并填入干净会话（继承当前真实工作目录），无需手动再配对标签。
   */
  const switchLayoutMode = (nextMode: SplitLayoutMode) => {
    setZoomedPaneIndex(null);
    const needed = visiblePaneCountForMode(nextMode);
    if (tabs.length < needed && tabs.length < MAX_WORKSPACE_TABS) {
      const missingCount = Math.min(
        needed - tabs.length,
        MAX_WORKSPACE_TABS - tabs.length,
      );
      const inheritCwd = normalizeDisplayPath(focusedLiveCwd);
      const inheritShell = activeTab?.shell ?? 'powershell';
      const spawned: TerminalTab[] = [];
      for (let i = 0; i < missingCount; i += 1) {
        const idx = tabs.length + i + 1;
        spawned.push({
          id: makeTabId(),
          title: `${inheritShell === 'powershell' ? 'PowerShell' : inheritShell.toUpperCase()} ${idx}`,
          shell: inheritShell,
          cwd: inheritCwd,
          status: 'starting',
          createdAt: Date.now(),
        });
      }
      const combinedIds = [...tabs, ...spawned].map((t) => t.id);
      setTabs((prev) => [...prev, ...spawned]);
      setPaneTabIds((prev) =>
        normalizePaneTabAssignments(prev, combinedIds, needed),
      );
    }
    setSplitMode(nextMode);
    setFocusedPaneIndex((idx) => Math.min(idx, needed - 1));
  };

  const applyWorkspacePreset = (preset: WorkspacePresetSpec) => {
    setShowPresetMenu(false);
    setZoomedPaneIndex(null);
    const inheritCwd = normalizeDisplayPath(focusedLiveCwd);
    const usedIds = new Set<string>();
    const nextTabs = [...tabs];
    const resolvedSlotIds: string[] = [];

    for (const slot of preset.slots) {
      const existing = nextTabs.find((candidate) => {
        if (usedIds.has(candidate.id)) return false;
        const cKind = candidate.kind ?? 'shell';
        if (slot.kind !== cKind) return false;
        if (slot.kind === 'lab' && slot.labLanguage) {
          return (candidate.labLanguage ?? 'python') === slot.labLanguage;
        }
        if (slot.kind === 'shell' && slot.cliPreset) {
          return candidate.initialCli === slot.cliPreset;
        }
        if (slot.kind === 'shell' && !slot.cliPreset) {
          return !candidate.initialCli;
        }
        return true;
      });

      if (existing) {
        usedIds.add(existing.id);
        resolvedSlotIds.push(existing.id);
        continue;
      }

      if (nextTabs.length < MAX_WORKSPACE_TABS) {
        const created: TerminalTab = {
          id: makeTabId(),
          title: slot.title,
          kind: slot.kind,
          shell: activeTab?.shell ?? 'powershell',
          labLanguage:
            slot.kind === 'lab' ? (slot.labLanguage ?? 'python') : undefined,
          initialCli: slot.cliPreset,
          cwd: inheritCwd,
          status: slot.kind === 'shell' ? 'starting' : 'ready',
          createdAt: Date.now(),
        };
        nextTabs.push(created);
        usedIds.add(created.id);
        resolvedSlotIds.push(created.id);
      } else {
        const fallback =
          nextTabs.find((c) => !usedIds.has(c.id)) ?? nextTabs[0];
        if (fallback) {
          usedIds.add(fallback.id);
          resolvedSlotIds.push(fallback.id);
        }
      }
    }

    setTabs(nextTabs);
    setPaneTabIds(resolvedSlotIds);
    setSplitMode(preset.splitMode);
    setFocusedPaneIndex(0);
    showTempNotice(`已切换场景预设：${preset.title}`);
    const firstId = resolvedSlotIds[0];
    if (firstId) requestAnimationFrame(() => focusTabHandle(firstId));
  };

  /** 在当前窗格快速向右/网格拆出并新增一个独立会话窗格（图二核心交互）。 */
  const splitOutPane = (fromPaneIdx: number, cliPreset?: TerminalCliPreset) => {
    const currCount = visiblePaneCountForMode(splitMode);
    let nextMode: SplitLayoutMode = splitMode;
    if (currCount === 1) nextMode = 'vertical';
    else if (currCount === 2) nextMode = 'tri';
    else if (currCount === 3) nextMode = 'quad';

    const nextVisibleCount = visiblePaneCountForMode(nextMode);
    if (tabs.length < MAX_WORKSPACE_TABS) {
      const targetSlot =
        currCount < 4 ? currCount : Math.min(fromPaneIdx + 1, 3);
      createNewTab(activeTab?.shell ?? 'powershell', cliPreset, targetSlot);
    } else if (cliPreset && activePaneIds[fromPaneIdx]) {
      terminalRefs.current
        .get(activePaneIds[fromPaneIdx])
        ?.sendCommand(cliPreset, true);
    }
    if (nextMode !== splitMode) {
      setSplitMode(nextMode);
      setFocusedPaneIndex(Math.min(currCount, nextVisibleCount - 1));
    }
  };

  const closePaneSlot = (paneIdx: number) => {
    const count = visiblePaneCountForMode(splitMode);
    if (count <= 1) return;
    const nextSlots = activePaneIds.filter((_, idx) => idx !== paneIdx);
    setPaneTabIds(nextSlots);
    const nextMode: SplitLayoutMode =
      count === 4 ? 'tri' : count === 3 ? 'vertical' : 'single';
    setSplitMode(nextMode);
    setFocusedPaneIndex((curr) => Math.max(0, Math.min(curr, count - 2)));
  };

  const handlePopoutWindow = async (
    cliPreset?: TerminalCliPreset,
    sourceTabId?: string,
    specialKind?: {
      kind: TerminalTabKind;
      labLanguage?: TerminalCodeLabLanguage;
    },
  ) => {
    setShowPopoutMenu(false);
    const srcTab =
      tabs.find((t) => t.id === (sourceTabId ?? activeTabId)) ?? activeTab;
    const targetCwd =
      terminalRefs.current.get(srcTab?.id ?? '')?.getCwd() ||
      srcTab?.cwd ||
      initialCleanCwd;
    const targetKind = specialKind?.kind ?? srcTab?.kind ?? 'shell';
    const targetLabLang =
      specialKind?.labLanguage ?? srcTab?.labLanguage ?? 'python';
    const result = await openStandaloneTerminalWindow({
      cwd: normalizeDisplayPath(targetCwd),
      shell: srcTab?.shell ?? 'powershell',
      cli: cliPreset,
      kind: targetKind,
      labLanguage: targetKind === 'lab' ? targetLabLang : undefined,
      theme,
    });
    if (result.ok) {
      showTempNotice(
        targetKind === 'agent'
          ? '已在独立窗口打开 Seamind Agent'
          : targetKind === 'lab'
            ? '已在独立窗口打开 Euporie 实验本'
            : cliPreset
              ? `已在独立窗口启动 ${cliPreset}`
              : '已打开独立终端窗口',
      );
    } else {
      showTempNotice(result.error || '独立窗口创建失败');
    }
  };

  const createSpecialTab = useCallback(
    (
      kind: 'agent' | 'lab',
      labLanguage: TerminalCodeLabLanguage = 'python',
      targetPaneIdx?: number,
    ): TerminalTab | null => {
      if (tabs.length >= MAX_WORKSPACE_TABS) return null;
      const nextIndex = tabs.length + 1;
      const title =
        kind === 'agent'
          ? `Agent ${nextIndex}`
          : labLanguage === 'python'
            ? `Python Lab ${nextIndex}`
            : labLanguage === 'cpp'
              ? `C++ Lab ${nextIndex}`
              : `C Lab ${nextIndex}`;
      const newTab: TerminalTab = {
        id: makeTabId(),
        title,
        kind,
        shell: activeTab?.shell ?? 'powershell',
        labLanguage: kind === 'lab' ? labLanguage : undefined,
        cwd: normalizeDisplayPath(focusedLiveCwd),
        status: 'ready',
        createdAt: Date.now(),
      };
      setTabs((prev) => [...prev, newTab]);
      const slot = targetPaneIdx ?? safeFocusedPane;
      setPaneTabIds((prev) => {
        const next = [...prev];
        next[slot] = newTab.id;
        return next;
      });
      setFocusedPaneIndex(slot);
      setShowShellMenu(false);
      requestAnimationFrame(() => focusTabHandle(newTab.id));
      return newTab;
    },
    [
      activeTab?.shell,
      focusTabHandle,
      focusedLiveCwd,
      safeFocusedPane,
      tabs.length,
    ],
  );

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePaneIdsRef = useRef(activePaneIds);
  activePaneIdsRef.current = activePaneIds;
  const splitModeRef = useRef(splitMode);
  splitModeRef.current = splitMode;

  const ensurePaneForTab = useCallback(
    (targetTabId: string) => {
      const visibleIdx = activePaneIdsRef.current.indexOf(targetTabId);
      if (visibleIdx >= 0) {
        setFocusedPaneIndex(visibleIdx);
        return visibleIdx;
      }
      if (splitModeRef.current === 'single' && tabsRef.current.length >= 2) {
        setSplitMode('vertical');
        const nextSlot = 1;
        setPaneTabIds((prev) => {
          const next = [...prev];
          next[nextSlot] = targetTabId;
          return next;
        });
        setFocusedPaneIndex(nextSlot);
        return nextSlot;
      }
      const nextSlot =
        activePaneIdsRef.current.length > 1
          ? (safeFocusedPane + 1) % activePaneIdsRef.current.length
          : 0;
      setPaneTabIds((prev) => {
        const next = [...prev];
        next[nextSlot] = targetTabId;
        return next;
      });
      setFocusedPaneIndex(nextSlot);
      return nextSlot;
    },
    [safeFocusedPane],
  );

  const sendToShellPane = useCallback(
    (command: string, execute = true, paneNumber?: number) => {
      const currentTabs = tabsRef.current;
      const paneTabId = paneNumber
        ? activePaneIdsRef.current[paneNumber - 1]
        : undefined;
      const explicitTab = paneTabId
        ? currentTabs.find(
            (t) => t.id === paneTabId && (!t.kind || t.kind === 'shell'),
          )
        : undefined;
      const visibleShell = activePaneIdsRef.current
        .map((id) => currentTabs.find((t) => t.id === id))
        .find((t): t is TerminalTab =>
          Boolean(t && (!t.kind || t.kind === 'shell')),
        );
      const anyShell =
        explicitTab ??
        visibleShell ??
        currentTabs.find((t) => !t.kind || t.kind === 'shell');

      if (anyShell) {
        ensurePaneForTab(anyShell.id);
        window.setTimeout(() => {
          const h = terminalRefs.current.get(anyShell.id);
          h?.sendCommand(command, execute);
          h?.focus();
        }, 80);
        return;
      }

      const targetSlot =
        splitModeRef.current === 'single' ? 1 : safeFocusedPane;
      if (splitModeRef.current === 'single') setSplitMode('vertical');
      const created = createNewTab('powershell', undefined, targetSlot);
      if (created) {
        window.setTimeout(() => {
          const h = terminalRefs.current.get(created.id);
          h?.sendCommand(command, execute);
          h?.focus();
        }, 550);
      }
    },
    [createNewTab, ensurePaneForTab, safeFocusedPane],
  );

  const pushToCodeLab = useCallback(
    (lang: TerminalCodeLabLanguage, code: string, autoRun = true) => {
      const existing =
        activePaneIdsRef.current
          .map((id) => tabsRef.current.find((t) => t.id === id))
          .find((t): t is TerminalTab => t?.kind === 'lab') ??
        tabsRef.current.find((t) => t.kind === 'lab');

      if (existing) {
        ensurePaneForTab(existing.id);
        window.setTimeout(() => {
          labRefs.current
            .get(existing.id)
            ?.insertAndRunCell(lang, code, autoRun);
          labRefs.current.get(existing.id)?.focus();
        }, 80);
        return;
      }

      const targetSlot =
        splitModeRef.current === 'single' ? 1 : safeFocusedPane;
      if (splitModeRef.current === 'single') setSplitMode('vertical');
      const created = createSpecialTab('lab', lang, targetSlot);
      if (created) {
        window.setTimeout(() => {
          labRefs.current
            .get(created.id)
            ?.insertAndRunCell(lang, code, autoRun);
          labRefs.current.get(created.id)?.focus();
        }, 120);
      }
    },
    [createSpecialTab, ensurePaneForTab, safeFocusedPane],
  );

  useEffect(() => {
    if (!active || !externalCodeLabPush) return;
    const { id, language, source, autoRun } = externalCodeLabPush;
    onExternalCodeLabPushConsumed?.(id);
    setRailModule('lab');
    pushToCodeLab(language, source, Boolean(autoRun));
  }, [
    active,
    externalCodeLabPush,
    onExternalCodeLabPushConsumed,
    pushToCodeLab,
  ]);

  const sendToAgentPane = useCallback(
    (prompt: string) => {
      const existing =
        activePaneIdsRef.current
          .map((id) => tabsRef.current.find((t) => t.id === id))
          .find((t): t is TerminalTab => t?.kind === 'agent') ??
        tabsRef.current.find((t) => t.kind === 'agent');

      if (existing) {
        ensurePaneForTab(existing.id);
        window.setTimeout(() => {
          agentRefs.current.get(existing.id)?.submitPrompt(prompt);
          agentRefs.current.get(existing.id)?.focus();
        }, 80);
        return;
      }

      const targetSlot =
        splitModeRef.current === 'single' ? 1 : safeFocusedPane;
      if (splitModeRef.current === 'single') setSplitMode('vertical');
      const created = createSpecialTab('agent', 'python', targetSlot);
      if (created) {
        window.setTimeout(() => {
          agentRefs.current.get(created.id)?.submitPrompt(prompt);
          agentRefs.current.get(created.id)?.focus();
        }, 150);
      }
    },
    [createSpecialTab, ensurePaneForTab, safeFocusedPane],
  );

  const paneAccessor = useMemo(
    () => ({
      readPaneText: (paneNumber: number, maxLines = 80) => {
        const tabId = activePaneIdsRef.current[paneNumber - 1];
        if (!tabId) return null;
        const tabItem = tabsRef.current.find((t) => t.id === tabId);
        if (!tabItem) return null;
        const shellText = terminalRefs.current
          .get(tabId)
          ?.getScreenText(maxLines);
        const labText = labRefs.current.get(tabId)?.getScreenText(maxLines);
        const agentText = agentRefs.current.get(tabId)?.getScreenText(maxLines);
        const cwdText =
          terminalRefs.current.get(tabId)?.getCwd() || tabItem.cwd || '';
        return {
          title: tabItem.title,
          cwd: cwdText,
          text: shellText || labText || agentText || '(窗格当前无文本内容)',
        };
      },
      readLastError: () => {
        for (const id of activePaneIdsRef.current) {
          const labErr = labRefs.current.get(id)?.getLastErrorText();
          if (labErr) return labErr;
        }
        for (const id of activePaneIdsRef.current) {
          const text = terminalRefs.current.get(id)?.getScreenText(60);
          if (text) {
            const lines = text.split('\n');
            const errStart = lines.findIndex((l) =>
              /error|traceback|exception|fatal|failed|无法/i.test(l),
            );
            if (errStart >= 0) {
              return lines.slice(Math.max(0, errStart - 2)).join('\n');
            }
          }
        }
        for (const id of activePaneIdsRef.current) {
          const fallback = terminalRefs.current.get(id)?.getScreenText(30);
          if (fallback?.trim()) return fallback;
        }
        return '';
      },
      sendToShellPane,
      pushToCodeLab,
    }),
    [pushToCodeLab, sendToShellPane],
  );

  const mergedBridge = useMemo<TerminalWorkspaceBridge>(() => {
    const runPythonQuick = async ({ code }: { code: string }) => {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const w = new Worker(
          new URL('../workbench/python.worker.ts', import.meta.url),
          { type: 'module' },
        );
        const timer = window.setTimeout(() => {
          w.terminate();
          reject(new Error('Python 工具执行超时（20s）'));
        }, 20_000);
        w.onmessage = (
          event: MessageEvent<{
            type: string;
            output?: string;
            resultText?: string;
            error?: string;
            stderr?: string;
          }>,
        ) => {
          window.clearTimeout(timer);
          w.terminate();
          resolve({
            ok: event.data.type !== 'error',
            output: event.data.output ?? '',
            stderr: event.data.stderr ?? '',
            resultText: event.data.resultText ?? '',
            error: event.data.error ?? null,
          });
        };
        w.onerror = (event) => {
          window.clearTimeout(timer);
          w.terminate();
          reject(new Error(event.message || 'Pyodide Worker 执行失败'));
        };
        const indexURL = new URL('pyodide/', document.baseURI).href;
        const moduleURL = new URL('pyodide/pyodide.mjs', document.baseURI).href;
        w.postMessage({
          requestId: `tool-${Date.now()}`,
          action: 'exec',
          source: code,
          indexURL,
          moduleURL,
        });
      });
    };

    const baseCaps = bridge?.capabilities
      ? {
          ...bridge.capabilities,
          runPythonSnippet:
            bridge.capabilities.runPythonSnippet ?? runPythonQuick,
        }
      : {
          ...createFallbackTerminalCapabilities(bridge?.activeMindmapTitle),
          runPythonSnippet: runPythonQuick,
        };

    return {
      ...bridge,
      books: bridge?.books ?? books,
      onOpenBook: bridge?.onOpenBook ?? onOpenBook,
      capabilities: baseCaps,
    };
  }, [books, bridge, onOpenBook]);

  const closeTab = (tabId: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (tabs.length <= 1) return;
    const nextTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(nextTabs);
    setPaneTabIds((prev) =>
      prev.map((id) => (id === tabId ? (nextTabs[0]?.id ?? '') : id)),
    );
    terminalRefs.current.delete(tabId);
    agentRefs.current.delete(tabId);
    labRefs.current.delete(tabId);
  };

  const startRenameTab = (tab: TerminalTab) => {
    setEditingTabId(tab.id);
    setEditingTitle(tab.title);
  };

  const saveRenameTab = () => {
    if (!editingTabId) return;
    const trimmed = editingTitle.trim();
    if (trimmed) {
      setTabs((prev) =>
        prev.map((t) => (t.id === editingTabId ? { ...t, title: trimmed } : t)),
      );
    }
    setEditingTabId(null);
  };

  const sendCommandToActive = (cmd: string, execute = true) => {
    const handle = terminalRefs.current.get(activeTabId);
    if (handle) {
      handle.sendCommand(cmd, execute);
      handle.focus();
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem(
        COMMAND_FAVORITES_KEY,
        JSON.stringify(favoriteCommandIds),
      );
    } catch {
      // noop
    }
  }, [favoriteCommandIds]);

  useEffect(() => {
    try {
      localStorage.setItem(
        COMMAND_RECENTS_KEY,
        JSON.stringify(recentCommandIds),
      );
    } catch {
      // noop
    }
  }, [recentCommandIds]);

  const rememberCommand = (id: string) => {
    if (!LINUX_CHEAT_ITEMS.some((item) => item.id === id)) return;
    setRecentCommandIds((previous) =>
      [id, ...previous.filter((item) => item !== id)].slice(0, 30),
    );
  };

  const toggleCommandFavorite = (id: string) => {
    setFavoriteCommandIds((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [id, ...previous],
    );
  };

  const runOrConfirmCommand = (
    title: string,
    command: string,
    requiresConfirmation: boolean,
    itemId: string,
  ) => {
    rememberCommand(itemId);
    if (requiresConfirmation) {
      setPendingCommand({
        title,
        command,
        tabId: activeTabId,
        shell: activeTab?.shell ?? 'powershell',
        cwd: focusedLiveCwd,
      });
      return;
    }
    sendCommandToActive(command, true);
  };

  const confirmPendingCommand = () => {
    if (!pendingCommand) return;
    const handle = terminalRefs.current.get(pendingCommand.tabId);
    if (handle) {
      handle.sendCommand(pendingCommand.command, true);
      handle.focus();
    }
    setPendingCommand(null);
  };

  const activeShell = activeTab?.shell ?? 'powershell';
  const sessionReady = activeTab?.status === 'ready';
  const filteredLinuxCheats = useMemo(
    () =>
      filterCommandLibrary(LINUX_CHEAT_ITEMS, {
        query: commandQuery,
        category: linuxFilter,
        view: commandView,
        favoriteIds: favoriteCommandIds,
        recentIds: recentCommandIds,
      }),
    [
      commandQuery,
      commandView,
      favoriteCommandIds,
      linuxFilter,
      recentCommandIds,
    ],
  );
  const visibleCommandIds = useMemo(
    () => filteredLinuxCheats.map((item) => item.id),
    [filteredLinuxCheats],
  );

  useEffect(() => {
    setFocusedCommandId((current) =>
      commandMatchesFocus(visibleCommandIds, current),
    );
  }, [visibleCommandIds]);

  useEffect(() => {
    if (!focusedCommandId || !commandPanelRef.current) return;
    const row = commandPanelRef.current.querySelector(
      `[data-command-id="${CSS.escape(focusedCommandId)}"]`,
    );
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedCommandId]);

  const filteredKnowledgeActions = useMemo(
    () => filterKnowledgeActions(KNOWLEDGE_ACTION_ITEMS, knowledgeQuery),
    [knowledgeQuery],
  );
  const visibleKnowledgeIds = useMemo(
    () => filteredKnowledgeActions.map((item) => item.id),
    [filteredKnowledgeActions],
  );

  useEffect(() => {
    setFocusedKnowledgeId((current) =>
      commandMatchesFocus(visibleKnowledgeIds, current),
    );
  }, [visibleKnowledgeIds]);

  useEffect(() => {
    if (!focusedKnowledgeId || !knowledgePanelRef.current) return;
    const row = knowledgePanelRef.current.querySelector(
      `[data-knowledge-id="${CSS.escape(focusedKnowledgeId)}"]`,
    );
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedKnowledgeId]);

  const relatedBooks = useMemo(() => {
    return books.filter((b) =>
      /linux|unix|c primer|system|bash|network|tcp|hacker/i.test(b.title),
    );
  }, [books]);

  const applyFocusedCommand = (execute: boolean) => {
    const item = filteredLinuxCheats.find(
      (entry) => entry.id === focusedCommandId,
    );
    if (!item || !sessionReady) return;
    const command = commandTextForShell(item, activeShell);
    if (!command) return;
    if (execute) {
      runOrConfirmCommand(
        item.title,
        command,
        Boolean(item.requiresConfirmation),
        item.id,
      );
      return;
    }
    rememberCommand(item.id);
    sendCommandToActive(command, false);
  };

  const onCommandListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (pendingCommand) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const fromField =
      target instanceof HTMLInputElement ||
      Boolean(target.closest('[data-command-id]'));
    if (!fromField) return;
    if (target.closest('button')) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setFocusedCommandId((current) =>
        moveFocusedCommand(
          visibleCommandIds,
          current,
          event.key === 'ArrowDown' ? 1 : -1,
        ),
      );
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    applyFocusedCommand(event.shiftKey);
  };

  const applyKnowledgeAction = (
    item: (typeof filteredKnowledgeActions)[number],
    execute: boolean,
  ) => {
    if (!sessionReady) return;
    const command = knowledgeCommandForShell(item, activeShell);
    if (!command) return;
    if (execute) {
      runOrConfirmCommand(
        item.title,
        command,
        Boolean(item.requiresConfirmation),
        item.id,
      );
      return;
    }
    sendCommandToActive(command, false);
  };

  const onKnowledgeListKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    if (pendingCommand) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const fromField =
      target instanceof HTMLInputElement ||
      Boolean(target.closest('[data-knowledge-id]'));
    if (!fromField) return;
    if (target.closest('button')) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setFocusedKnowledgeId((current) =>
        moveFocusedCommand(
          visibleKnowledgeIds,
          current,
          event.key === 'ArrowDown' ? 1 : -1,
        ),
      );
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const item = filteredKnowledgeActions.find(
      (entry) => entry.id === focusedKnowledgeId,
    );
    if (!item) return;
    applyKnowledgeAction(item, event.shiftKey);
  };

  const tabToPaneIndex = useMemo(() => {
    const map = new Map<string, number>();
    activePaneIds.forEach((tabId, paneIdx) => {
      if (!map.has(tabId)) map.set(tabId, paneIdx);
    });
    return map;
  }, [activePaneIds]);

  const isStageZoomed =
    zoomedPaneIndex !== null && zoomedPaneIndex < visibleCount;
  const showPaneHeaders = visibleCount > 1 && !isStageZoomed;
  const focusedSessionMeta = activeTab
    ? sessionMetaById[activeTab.id]
    : undefined;
  const activeFooterHints = useMemo(
    () => buildSmartFooterHints(activeTab?.kind ?? 'shell', isStageZoomed),
    [activeTab?.kind, isStageZoomed],
  );

  // Auto-sync left rail module with active tab kind
  useEffect(() => {
    const currentKind: TerminalTabKind = activeTab?.kind ?? 'shell';
    setRailModule(currentKind);
  }, [activeTab?.id, activeTab?.kind]);

  const shellTabs = useMemo(
    () => tabs.filter((t) => !t.kind || t.kind === 'shell'),
    [tabs],
  );
  const agentTabs = useMemo(
    () => tabs.filter((t) => t.kind === 'agent'),
    [tabs],
  );
  const labTabs = useMemo(() => tabs.filter((t) => t.kind === 'lab'), [tabs]);

  const groupedCodeLabFiles = useMemo(
    () => groupCodeLabFilesByFolder(codeLabFiles, codeLabSearch, codeLabFilter),
    [codeLabFiles, codeLabSearch, codeLabFilter],
  );

  const activateOrCreateTabInFocusedPane = useCallback(
    (tabId: string) => {
      const paneIdx = activePaneIds.indexOf(tabId);
      if (paneIdx >= 0) {
        setFocusedPaneIndex(paneIdx);
      } else {
        setPaneTabIds((prev) => {
          const next = [...prev];
          next[safeFocusedPane] = tabId;
          return next;
        });
      }
      requestAnimationFrame(() => focusTabHandle(tabId));
    },
    [activePaneIds, focusTabHandle, safeFocusedPane],
  );

  const handleSelectRailModule = useCallback(
    (nextModule: TerminalTabKind) => {
      setRailModule(nextModule);
      const currentKind: TerminalTabKind = activeTab?.kind ?? 'shell';
      if (currentKind === nextModule) return;
      const existing = tabs.find((t) => (t.kind ?? 'shell') === nextModule);
      if (existing) {
        activateOrCreateTabInFocusedPane(existing.id);
      } else if (nextModule === 'agent') {
        createSpecialTab('agent');
      } else if (nextModule === 'lab') {
        createSpecialTab('lab', 'python');
      } else {
        createNewTab('powershell');
      }
    },
    [
      activateOrCreateTabInFocusedPane,
      activeTab?.kind,
      createNewTab,
      createSpecialTab,
      tabs,
    ],
  );

  const withActiveLabHandle = useCallback(
    (
      preferredLang: TerminalCodeLabLanguage,
      callback: (handle: TerminalCodeLabViewHandle) => void,
    ) => {
      if (activeTab?.kind === 'lab') {
        const handle = labRefs.current.get(activeTab.id);
        if (handle) {
          callback(handle);
          return;
        }
      }
      const existingLab =
        tabs.find((t) => t.kind === 'lab' && t.labLanguage === preferredLang) ??
        tabs.find((t) => t.kind === 'lab');
      if (existingLab) {
        activateOrCreateTabInFocusedPane(existingLab.id);
        window.setTimeout(() => {
          const handle = labRefs.current.get(existingLab.id);
          if (handle) callback(handle);
        }, 60);
      } else {
        createSpecialTab('lab', preferredLang);
        window.setTimeout(() => {
          for (const [, handle] of labRefs.current.entries()) {
            callback(handle);
            break;
          }
        }, 90);
      }
    },
    [
      activateOrCreateTabInFocusedPane,
      activeTab?.id,
      activeTab?.kind,
      createSpecialTab,
      tabs,
    ],
  );

  const handleOpenSavedCodeFile = useCallback(
    (file: CodeLabSavedFile) => {
      setRailModule('lab');
      withActiveLabHandle(file.language, (handle) => {
        handle.loadSavedFile(file);
      });
    },
    [withActiveLabHandle],
  );

  const handleInsertSnippetToLab = useCallback(
    (snippet: CodeLabSnippetItem, autoRun: boolean) => {
      setRailModule('lab');
      withActiveLabHandle(snippet.language, (handle) => {
        handle.insertAndRunCell(snippet.language, snippet.code, autoRun);
      });
    },
    [withActiveLabHandle],
  );

  interface PaletteActionItem {
    id: string;
    badge: string;
    title: string;
    subtitle: string;
    run: () => void;
  }

  const paletteActions: PaletteActionItem[] = [
    ...WORKSPACE_LAYOUT_PRESETS.map((preset) => ({
      id: `preset-${preset.id}`,
      badge: `模板 ${preset.badge}`,
      title: preset.title,
      subtitle: preset.description,
      run: () => applyWorkspacePreset(preset),
    })),
    {
      id: 'new-agent',
      badge: '新建',
      title: '打开 >_ Seamind Agent 书卷智能体',
      subtitle: '支持 /## 能力调度与 API×CLI 套娃协同',
      run: () => createSpecialTab('agent'),
    },
    {
      id: 'new-py-lab',
      badge: '新建',
      title: '打开 Euporie Python 交互实验本',
      subtitle: '支持 Pyodide / Conda 双内核、matplotlib 绘图与 .ipynb',
      run: () => createSpecialTab('lab', 'python'),
    },
    {
      id: 'new-c-lab',
      badge: '新建',
      title: '打开 Euporie C/C++ 编译实验本',
      subtitle: '支持公共头文件前置格、stdin 测试与 GDB 终端直达',
      run: () => createSpecialTab('lab', 'c'),
    },
    {
      id: 'new-shell',
      badge: '新建',
      title: '新建 PowerShell 会话',
      subtitle: `在工作目录 ${focusedLiveCwd || '.'} 启动`,
      run: () => createNewTab('powershell'),
    },
    {
      id: 'toggle-zoom',
      badge: '视图',
      title: isStageZoomed
        ? '还原多窗格分屏 (Ctrl+Shift+M)'
        : '全屏放大当前聚焦窗格 (Ctrl+Shift+M)',
      subtitle: '保持其他后台终端与实验状态运行',
      run: () => {
        if (visibleCount > 1) {
          setZoomedPaneIndex((z) => (z === null ? safeFocusedPane : null));
        }
      },
    },
    {
      id: 'toggle-drawer',
      badge: '工具',
      title: '打开 / 收起命令库与知识动作侧栏 (Ctrl+Shift+L)',
      subtitle: '常用 Linux/Windows 命令模板速查',
      run: () => setDrawerOpen((o) => !o),
    },
    ...(mergedBridge.onNavigateWorkspace
      ? (
          [
            ['reader', '电子书阅读器', '切换到 EPUB 伴读与星图'],
            ['knowledge', '知识库笔记', '查看并编辑 Markdown 文档'],
            ['mindmap', '思维导图工作台', '回到当前思维导图画布'],
            ['exams', '试卷中心', '查看测验与错题复盘'],
            ['player', '双螺旋播放器', '继续视频课程学习路径'],
            ['literature', '论文文献库', '查阅 PDF 与 BibTeX 批注'],
            ['feed', 'RSS 订阅阅读', '浏览最新关注博客订阅'],
          ] as const
        ).map(([ws, title, subtitle]) => ({
          id: `nav-${ws}`,
          badge: '工作区',
          title: `前往「${title}」`,
          subtitle,
          run: () => mergedBridge.onNavigateWorkspace?.(ws),
        }))
      : []),
  ];

  const filteredPaletteActions = paletteActions.filter((item) => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.badge.toLowerCase().includes(q)
    );
  });
  const safePaletteIndex = Math.min(
    paletteIndex,
    Math.max(0, filteredPaletteActions.length - 1),
  );

  return (
    <main
      className={`terminal-workspace${standalone ? ' is-standalone' : ''}`}
      aria-label="终端与多窗格 CLI 工作区"
    >
      {/* Unified Session Tabs & Image-2 Multi-Window Controls */}
      <nav className="terminal-topbar" aria-label="终端会话与多开控制">
        <div className="terminal-tabs-track" role="tablist">
          {tabs.map((tab, index) => {
            const assignedPane = tabToPaneIndex.get(tab.id);
            const isVisible = assignedPane !== undefined;
            const isActive = tab.id === activeTabId;
            const isEditing = editingTabId === tab.id;
            return (
              <div
                key={tab.id}
                className={`terminal-tab-item${isActive ? ' is-active' : ''}${isVisible ? ' is-visible-in-pane' : ''}`}
                onClick={() => {
                  const paneIdx = activePaneIds.indexOf(tab.id);
                  if (paneIdx >= 0) {
                    setFocusedPaneIndex(paneIdx);
                  } else {
                    setPaneTabIds((prev) => {
                      const next = [...prev];
                      next[safeFocusedPane] = tab.id;
                      return next;
                    });
                  }
                  if (tab.bellCount) {
                    setTabs((prev) =>
                      prev.map((item) =>
                        item.id === tab.id ? { ...item, bellCount: 0 } : item,
                      ),
                    );
                  }
                  requestAnimationFrame(() => focusTabHandle(tab.id));
                }}
                onDoubleClick={() => startRenameTab(tab)}
                role="tab"
                aria-selected={isActive}
              >
                <span
                  className={`tab-status-dot is-${tab.status}`}
                  aria-hidden="true"
                />
                {tab.bellCount ? (
                  <span className="tab-bell-dot" title="该会话刚完成响铃提醒" />
                ) : null}
                {isEditing ? (
                  <input
                    type="text"
                    className="tab-rename-input"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={saveRenameTab}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRenameTab();
                      if (e.key === 'Escape') setEditingTabId(null);
                    }}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="tab-title"
                    title={
                      index < 9 ? `${tab.title} (Alt+${index + 1})` : tab.title
                    }
                  >
                    {tab.title}
                  </span>
                )}
                {tabs.length > 1 && (
                  <button
                    type="button"
                    className="tab-close-btn"
                    onClick={(e) => closeTab(tab.id, e)}
                    aria-label={`关闭 ${tab.title}`}
                    title="关闭会话"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}

          <div className="terminal-new-tab-container" ref={shellMenuRef}>
            <button
              type="button"
              className="terminal-new-tab-btn"
              onClick={() => {
                setShowShellMenu((prev) => !prev);
                setToolsMenuOpen(false);
                setShowPrefsMenu(false);
                setShowPopoutMenu(false);
              }}
              disabled={tabs.length >= MAX_WORKSPACE_TABS}
              aria-expanded={showShellMenu}
              title="新建终端、交互 Agent 或 Euporie 代码实验本"
            >
              + 新建
            </button>

            <button
              type="button"
              className="terminal-new-special-btn"
              onClick={() => createSpecialTab('agent')}
              disabled={tabs.length >= MAX_WORKSPACE_TABS}
              title="打开自研 Seamind Agent（支持 /## 命令及 API×CLI 套娃协同）"
            >
              Agent
            </button>

            <div className="terminal-preset-container" ref={presetMenuRef}>
              <button
                type="button"
                className={`terminal-new-special-btn${showPresetMenu ? ' is-active' : ''}`}
                onClick={() => {
                  setShowPresetMenu((prev) => !prev);
                  setShowShellMenu(false);
                  setToolsMenuOpen(false);
                  setShowPrefsMenu(false);
                  setShowPopoutMenu(false);
                }}
                aria-expanded={showPresetMenu}
                title="一键套用多窗格协同预设模板"
              >
                场景模板 ▾
              </button>

              {showPresetMenu && (
                <div className="terminal-preset-menu" role="menu">
                  <div className="shell-menu-header">多窗协同场景预设模板</div>
                  {WORKSPACE_LAYOUT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="terminal-preset-option"
                      onClick={() => applyWorkspacePreset(preset)}
                    >
                      <div className="terminal-preset-opt-top">
                        <span className="option-badge">{preset.badge}</span>
                        <strong>{preset.title}</strong>
                      </div>
                      <span className="option-desc">{preset.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {showShellMenu && (
              <div className="terminal-shell-menu">
                <div className="shell-menu-header">
                  Seamind Agent &amp; Euporie 实验
                </div>
                <div className="shell-cli-quick-row">
                  <button
                    type="button"
                    className="shell-cli-quick-btn is-primary"
                    disabled={tabs.length >= MAX_WORKSPACE_TABS}
                    onClick={() => createSpecialTab('agent')}
                  >
                    &gt;_ Seamind Agent
                  </button>
                  <button
                    type="button"
                    className="shell-cli-quick-btn"
                    disabled={tabs.length >= MAX_WORKSPACE_TABS}
                    onClick={() => createSpecialTab('lab', 'python')}
                  >
                    Python 实验本
                  </button>
                  <button
                    type="button"
                    className="shell-cli-quick-btn"
                    disabled={tabs.length >= MAX_WORKSPACE_TABS}
                    onClick={() => createSpecialTab('lab', 'c')}
                  >
                    C/C++ 实验本
                  </button>
                </div>

                <div className="shell-menu-header">一键启动 CLI 模型会话</div>
                <div className="shell-cli-quick-row">
                  {CLI_PRESETS.map((cli) => (
                    <button
                      key={cli.id}
                      type="button"
                      className="shell-cli-quick-btn"
                      disabled={tabs.length >= MAX_WORKSPACE_TABS}
                      onClick={() => createNewTab('powershell', cli.id)}
                      title={cli.desc}
                    >
                      ⚡ {cli.label}
                    </button>
                  ))}
                </div>

                <div className="shell-menu-header">选择 Shell 外壳</div>
                {tabs.length >= MAX_WORKSPACE_TABS && (
                  <div className="shell-menu-limit">
                    已达到 {MAX_WORKSPACE_TABS} 个会话上限，请先关闭不用的标签。
                  </div>
                )}
                {shells.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`shell-menu-option ${opt.available ? '' : 'is-unavailable'}`}
                    disabled={
                      !opt.available || tabs.length >= MAX_WORKSPACE_TABS
                    }
                    onClick={() => createNewTab(opt.id)}
                  >
                    <div className="option-main">
                      <span className="option-badge">{opt.badge}</span>
                      <strong className="option-name">{opt.name}</strong>
                      {!opt.available && (
                        <span className="option-status">未检测到</span>
                      )}
                    </div>
                    <span className="option-desc">{opt.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Window & Multi-Pane Controls (Aligned with Image 2) */}
        <div className="terminal-window-controls">
          {windowNotice && (
            <span className="terminal-topbar-notice">{windowNotice}</span>
          )}

          <details className="terminal-layout-menu">
            <summary title="选择窗格布局" aria-label="选择窗格布局">
              <LayoutIcon mode={splitMode} />
              <span>布局</span>
            </summary>
            <div
              className="terminal-layout-options"
              role="group"
              aria-label="多窗格分屏交互"
            >
              {(
                [
                  ['single', '单窗格'],
                  ['vertical', '左右并排双开（自动新建右窗）'],
                  ['horizontal', '上下双开（自动新建下窗）'],
                  ['tri', '三窗格布局（左主 + 右上下）'],
                  ['quad', '四宫格多开（最多 4 窗同时运行 CLI）'],
                ] as const
              ).map(([mode, title]) => (
                <button
                  key={mode}
                  type="button"
                  className={
                    !isStageZoomed && splitMode === mode ? 'is-active' : ''
                  }
                  onClick={(event) => {
                    switchLayoutMode(mode);
                    event.currentTarget
                      .closest('details')
                      ?.removeAttribute('open');
                  }}
                  title={title}
                  aria-label={title}
                >
                  <LayoutIcon mode={mode} />
                  <span>{title}</span>
                </button>
              ))}
            </div>
          </details>

          {visibleCount > 1 && (
            <button
              type="button"
              className={`terminal-icon-btn${isStageZoomed ? ' is-active' : ''}`}
              onClick={() =>
                setZoomedPaneIndex((z) => (z === null ? safeFocusedPane : null))
              }
              title={
                isStageZoomed
                  ? '还原分屏画布 (Ctrl+Shift+M)'
                  : '放大当前聚焦窗格至全屏 (Ctrl+Shift+M)'
              }
            >
              <ZoomPaneIcon zoomed={isStageZoomed} />
            </button>
          )}

          <button
            type="button"
            className={`terminal-icon-btn${paletteOpen ? ' is-active' : ''}`}
            onClick={() => {
              setPaletteOpen(true);
              setPaletteQuery('');
              setPaletteIndex(0);
              requestAnimationFrame(() => paletteSearchRef.current?.focus());
            }}
            title="全局终端命令面板 (Ctrl+K)"
          >
            <span>⌘K</span>
          </button>

          <div className="terminal-popout-container" ref={popoutMenuRef}>
            <button
              type="button"
              className={`terminal-icon-btn terminal-popout-btn${showPopoutMenu ? ' is-active' : ''}`}
              onClick={() => {
                setShowPopoutMenu((prev) => !prev);
                setShowShellMenu(false);
                setShowPrefsMenu(false);
                setToolsMenuOpen(false);
              }}
              title="多开独立窗口（新开原生桌面窗，可同时看书并跑多个 CLI 模型）"
              aria-expanded={showPopoutMenu}
            >
              <PopoutWindowIcon />
              <span>多开窗</span>
            </button>

            {showPopoutMenu && (
              <div className="terminal-popout-menu" role="menu">
                <div className="shell-menu-header">多开独立桌面窗口</div>
                <button
                  type="button"
                  className="terminal-tools-option"
                  onClick={() =>
                    void handlePopoutWindow(undefined, undefined, {
                      kind: 'agent',
                    })
                  }
                >
                  独立窗口打开 &gt;_ Seamind Agent
                </button>
                <button
                  type="button"
                  className="terminal-tools-option"
                  onClick={() =>
                    void handlePopoutWindow(undefined, undefined, {
                      kind: 'lab',
                      labLanguage: 'python',
                    })
                  }
                >
                  独立窗口打开 Euporie Python 实验本
                </button>
                <button
                  type="button"
                  className="terminal-tools-option"
                  onClick={() => void handlePopoutWindow(undefined)}
                >
                  新建独立 Shell 窗口
                </button>
                {CLI_PRESETS.map((cli) => (
                  <button
                    key={cli.id}
                    type="button"
                    className="terminal-tools-option"
                    onClick={() => void handlePopoutWindow(cli.id)}
                  >
                    独立窗口启动 ⚡ {cli.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="terminal-prefs-container" ref={prefsMenuRef}>
            <button
              type="button"
              className={`terminal-icon-btn${showPrefsMenu ? ' is-active' : ''}`}
              onClick={() => {
                setShowPrefsMenu((prev) => !prev);
                setShowShellMenu(false);
                setShowPopoutMenu(false);
                setToolsMenuOpen(false);
              }}
              title="终端外观与 Alacritty 交互设置"
              aria-expanded={showPrefsMenu}
            >
              配置
            </button>

            {showPrefsMenu && (
              <div className="terminal-prefs-popover">
                <div className="shell-menu-header">
                  Alacritty 交互与渲染设置
                </div>
                <div className="terminal-prefs-row">
                  <span>字号</span>
                  <div className="terminal-prefs-stepper">
                    <button
                      type="button"
                      onClick={() =>
                        saveTerminalPreferences({
                          fontSize: prefs.fontSize - 1,
                        })
                      }
                    >
                      -
                    </button>
                    <strong>{prefs.fontSize}px</strong>
                    <button
                      type="button"
                      onClick={() =>
                        saveTerminalPreferences({
                          fontSize: prefs.fontSize + 1,
                        })
                      }
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="terminal-prefs-row">
                  <span>光标形态</span>
                  <div className="terminal-prefs-seg">
                    {(['block', 'underline', 'bar'] as const).map((style) => (
                      <button
                        key={style}
                        type="button"
                        className={
                          prefs.cursorStyle === style ? 'is-active' : ''
                        }
                        onClick={() =>
                          saveTerminalPreferences({ cursorStyle: style })
                        }
                      >
                        {style === 'block'
                          ? '方块'
                          : style === 'underline'
                            ? '底线'
                            : '竖线'}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="terminal-prefs-check">
                  <input
                    type="checkbox"
                    checked={prefs.cursorBlink}
                    onChange={(e) =>
                      saveTerminalPreferences({ cursorBlink: e.target.checked })
                    }
                  />
                  <span>光标闪烁</span>
                </label>

                <label className="terminal-prefs-check">
                  <input
                    type="checkbox"
                    checked={prefs.saveOnSelect}
                    onChange={(e) =>
                      saveTerminalPreferences({
                        saveOnSelect: e.target.checked,
                      })
                    }
                  />
                  <span>鼠标选中自动复制 (save_to_clipboard)</span>
                </label>

                <label className="terminal-prefs-check">
                  <input
                    type="checkbox"
                    checked={prefs.smartCopyPaste}
                    onChange={(e) =>
                      saveTerminalPreferences({
                        smartCopyPaste: e.target.checked,
                      })
                    }
                  />
                  <span>智能 Ctrl+C（有选区时复制，无选区中断）</span>
                </label>

                <label className="terminal-prefs-check">
                  <input
                    type="checkbox"
                    checked={prefs.webglEnabled}
                    onChange={(e) =>
                      saveTerminalPreferences({
                        webglEnabled: e.target.checked,
                      })
                    }
                  />
                  <span>WebGL2 GPU 加速（重开会话生效）</span>
                </label>

                <div className="terminal-prefs-footer">
                  <button
                    type="button"
                    className="terminal-status-btn"
                    onClick={() =>
                      saveTerminalPreferences(DEFAULT_TERMINAL_PREFERENCES)
                    }
                  >
                    恢复默认
                  </button>
                  <span>Vi: Ctrl+Shift+Space · Hints: Ctrl+Shift+O</span>
                </div>
              </div>
            )}
          </div>

          <div className="terminal-tools-container" ref={toolsMenuRef}>
            <button
              type="button"
              className={`terminal-icon-btn terminal-drawer-toggle-btn${drawerOpen || toolsMenuOpen ? ' is-active' : ''}`}
              aria-expanded={drawerOpen}
              onClick={() => {
                setDrawerOpen((open) => !open);
                setToolsMenuOpen(false);
                setShowShellMenu(false);
                setShowPopoutMenu(false);
                setShowPrefsMenu(false);
              }}
              title={`切换命令库 / 知识修正侧栏 (${COMMAND_LIBRARY_SHORTCUT_LABEL})`}
              aria-keyshortcuts="Control+Shift+L"
            >
              <DrawerSplitIcon />
              <span>工具栏</span>
            </button>
          </div>
        </div>
      </nav>

      {/* Center Multi-Pane Stage + Left Modular Rail + Optional Right Drawer */}
      <div className="terminal-workspace-body">
        <aside
          className={`terminal-left-rail${railModule === 'lab' ? ' is-lab-rail' : ''}${leftRailCollapsed ? ' is-collapsed' : ''}`}
          aria-label="终端模块切换与代码文件收集侧边栏"
        >
          {leftRailCollapsed ? (
            <div className="terminal-rail-slim">
              <button
                type="button"
                className="terminal-rail-slim-btn"
                onClick={toggleLeftRail}
                title="展开终端与代码收集侧边栏"
                aria-label="展开侧边栏"
              >
                &gt;
              </button>
              <button
                type="button"
                className={`terminal-rail-slim-btn${railModule === 'shell' ? ' is-active' : ''}`}
                onClick={() => handleSelectRailModule('shell')}
                title={`终端会话 (${shellTabs.length})`}
              >
                &gt;_
              </button>
              <button
                type="button"
                className={`terminal-rail-slim-btn${railModule === 'agent' ? ' is-active' : ''}`}
                onClick={() => handleSelectRailModule('agent')}
                title={`Seamind Agent (${agentTabs.length})`}
              >
                AI
              </button>
              <button
                type="button"
                className={`terminal-rail-slim-btn${railModule === 'lab' ? ' is-active' : ''}`}
                onClick={() => handleSelectRailModule('lab')}
                title={`代码实验室与文件收集库 (${codeLabFiles.length})`}
              >
                Lab
              </button>
              <div className="terminal-rail-slim-sep" />
              <button
                type="button"
                className="terminal-rail-slim-btn"
                onClick={() => {
                  if (railModule === 'agent') createSpecialTab('agent');
                  else if (railModule === 'lab')
                    createSpecialTab('lab', 'python');
                  else createNewTab('powershell');
                }}
                title="新建当前模块会话"
              >
                +
              </button>
              <button
                type="button"
                className="terminal-rail-slim-btn"
                onClick={() => {
                  setPaletteOpen(true);
                  setPaletteQuery('');
                  setPaletteIndex(0);
                }}
                title="命令面板 (Ctrl+K)"
              >
                ⌘
              </button>
            </div>
          ) : (
            <>
              <div className="terminal-rail-top">
                <div className="terminal-rail-brand-row">
                  <span className="terminal-rail-brand-title">
                    {railModule === 'lab' ? '实验本' : '终端与代码实验室'}
                  </span>
                  <button
                    type="button"
                    className="terminal-rail-collapse-btn"
                    onClick={toggleLeftRail}
                    title="收起左侧边栏"
                    aria-label="收起左侧边栏"
                  >
                    &lt;
                  </button>
                </div>

                <div
                  className="terminal-rail-mode-tabs"
                  role="tablist"
                  aria-label="终端三大模块切换"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={railModule === 'shell'}
                    className={`terminal-rail-mode-tab${railModule === 'shell' ? ' is-active' : ''}`}
                    onClick={() => handleSelectRailModule('shell')}
                  >
                    <span>终端</span>
                    <span className="terminal-rail-count">
                      {shellTabs.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={railModule === 'agent'}
                    className={`terminal-rail-mode-tab${railModule === 'agent' ? ' is-active' : ''}`}
                    onClick={() => handleSelectRailModule('agent')}
                  >
                    <span>Agent</span>
                    <span className="terminal-rail-count">
                      {agentTabs.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={railModule === 'lab'}
                    className={`terminal-rail-mode-tab${railModule === 'lab' ? ' is-active' : ''}`}
                    onClick={() => handleSelectRailModule('lab')}
                  >
                    <span>实验室</span>
                    <span className="terminal-rail-count">
                      {codeLabFiles.length}
                    </span>
                  </button>
                </div>
              </div>

              <div className="terminal-rail-scroll">
                {railModule === 'lab' && (
                  <div className="terminal-rail-section is-lab-institutional">
                    <div
                      className="terminal-rail-sub-seg"
                      role="tablist"
                      aria-label="代码资产与视图"
                    >
                      <button
                        type="button"
                        className={labRailSubTab === 'files' ? 'is-active' : ''}
                        onClick={() => setLabRailSubTab('files')}
                      >
                        代码库 ({codeLabFiles.length})
                      </button>
                      <button
                        type="button"
                        className={
                          labRailSubTab === 'snippets' ? 'is-active' : ''
                        }
                        onClick={() => setLabRailSubTab('snippets')}
                      >
                        代码片段 ({DEFAULT_CODELAB_SNIPPETS.length})
                      </button>
                    </div>

                    {labRailSubTab === 'files' ? (
                      <>
                        <details className="terminal-rail-new-details">
                          <summary>
                            <LabPlusIcon size={13} />
                            新建实验本
                          </summary>
                          <div className="terminal-rail-new-options">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.currentTarget
                                  .closest('details')
                                  ?.removeAttribute('open');
                                withActiveLabHandle('python', (h) =>
                                  h.createNewNotebook('python', '书籍伴读验证'),
                                );
                              }}
                            >
                              Python 实验本
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.currentTarget
                                  .closest('details')
                                  ?.removeAttribute('open');
                                withActiveLabHandle('c', (h) =>
                                  h.createNewNotebook('c', '系统与网络实验'),
                                );
                              }}
                            >
                              C 实验本
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.currentTarget
                                  .closest('details')
                                  ?.removeAttribute('open');
                                withActiveLabHandle('cpp', (h) =>
                                  h.createNewNotebook('cpp', '算法与数据结构'),
                                );
                              }}
                            >
                              C++ 实验本
                            </button>
                          </div>
                        </details>

                        <input
                          type="search"
                          className="terminal-rail-search"
                          value={codeLabSearch}
                          onChange={(e) => setCodeLabSearch(e.target.value)}
                          placeholder="搜索实验本、标签或函数…"
                          aria-label="搜索收集的代码文件"
                        />

                        <label className="terminal-rail-filter-row">
                          <span>筛选</span>
                          <select
                            value={codeLabFilter}
                            onChange={(event) =>
                              setCodeLabFilter(
                                event.target.value as
                                  'all' | TerminalCodeLabLanguage | 'starred',
                              )
                            }
                          >
                            <option value="all">全部实验本</option>
                            <option value="python">Python</option>
                            <option value="c">C</option>
                            <option value="cpp">C++</option>
                            <option value="starred">已收藏</option>
                          </select>
                        </label>

                        <div className="terminal-rail-folders">
                          {groupedCodeLabFiles.map((group) => {
                            const isCollapsed = Boolean(
                              collapsedLabFolders[group.folder],
                            );
                            return (
                              <div
                                key={group.folder}
                                className="terminal-rail-folder-group"
                              >
                                <button
                                  type="button"
                                  className="terminal-rail-folder-head"
                                  onClick={() =>
                                    setCollapsedLabFolders((prev) => ({
                                      ...prev,
                                      [group.folder]: !prev[group.folder],
                                    }))
                                  }
                                >
                                  <span className="terminal-rail-folder-caret">
                                    {isCollapsed ? (
                                      <LabChevronRightIcon size={11} />
                                    ) : (
                                      <LabChevronDownIcon size={11} />
                                    )}
                                  </span>
                                  <span className="terminal-rail-folder-name">
                                    {group.folder}
                                  </span>
                                  <span className="terminal-rail-folder-count">
                                    {group.items.length}
                                  </span>
                                </button>

                                {!isCollapsed && (
                                  <div className="terminal-rail-folder-items">
                                    {group.items.length === 0 ? (
                                      <div className="terminal-rail-empty-hint">
                                        暂无归档文件
                                      </div>
                                    ) : (
                                      group.items.map((file) => {
                                        const isCurrent =
                                          activeLabInfo.fileId === file.id;
                                        const badge =
                                          file.language === 'cpp'
                                            ? 'CPP'
                                            : file.language === 'c'
                                              ? 'C'
                                              : 'PY';
                                        return (
                                          <div
                                            key={file.id}
                                            className={`terminal-rail-file-row${isCurrent ? ' is-active' : ''}`}
                                          >
                                            <button
                                              type="button"
                                              className="terminal-rail-file-main"
                                              onClick={() =>
                                                handleOpenSavedCodeFile(file)
                                              }
                                              title={`${file.title} (${file.cells.length} 格)`}
                                            >
                                              <span
                                                className={`terminal-rail-lang-badge is-${file.language}`}
                                              >
                                                {badge}
                                              </span>
                                              <span className="terminal-rail-file-title">
                                                {file.title}
                                              </span>
                                              <span className="terminal-rail-file-cells">
                                                {file.cells.length}
                                              </span>
                                            </button>
                                            <button
                                              type="button"
                                              className={`terminal-rail-star-btn${file.starred ? ' is-starred' : ''}`}
                                              onClick={() =>
                                                setCodeLabFiles(
                                                  toggleStarCodeLabFile(
                                                    file.id,
                                                  ),
                                                )
                                              }
                                              title={
                                                file.starred
                                                  ? '取消收藏'
                                                  : '收藏代码文件'
                                              }
                                              aria-label={
                                                file.starred
                                                  ? '取消收藏'
                                                  : '收藏代码文件'
                                              }
                                            >
                                              <LabStarIcon
                                                size={11}
                                                filled={file.starred}
                                              />
                                            </button>
                                            <button
                                              type="button"
                                              className="terminal-rail-del-btn"
                                              onClick={() =>
                                                setCodeLabFiles(
                                                  deleteCodeLabFile(file.id),
                                                )
                                              }
                                              title="从收集库移除"
                                              aria-label="从收集库移除"
                                            >
                                              <LabCloseIcon size={11} />
                                            </button>
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
                      <div className="terminal-rail-snippets-list">
                        {DEFAULT_CODELAB_SNIPPETS.map((snip) => (
                          <div
                            key={snip.id}
                            className="terminal-rail-snippet-card"
                          >
                            <div className="terminal-rail-snippet-top">
                              <span
                                className={`terminal-rail-lang-badge is-${snip.language}`}
                              >
                                {snip.language.toUpperCase()}
                              </span>
                              <strong>{snip.title}</strong>
                            </div>
                            <p className="terminal-rail-snippet-desc">
                              {snip.description}
                            </p>
                            <div className="terminal-rail-snippet-actions">
                              <button
                                type="button"
                                className="terminal-rail-mini-btn"
                                onClick={() =>
                                  handleInsertSnippetToLab(snip, false)
                                }
                              >
                                <LabPlusIcon size={11} />
                                <span>插入格</span>
                              </button>
                              <button
                                type="button"
                                className="terminal-rail-mini-btn is-accent"
                                onClick={() =>
                                  handleInsertSnippetToLab(snip, true)
                                }
                              >
                                <LabPlayIcon size={11} />
                                <span>运行</span>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {labTabs.length > 0 && (
                      <>
                        <div className="terminal-rail-group-label">
                          打开的实验室窗格 ({labTabs.length})
                        </div>
                        <div className="terminal-rail-session-list">
                          {labTabs.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              className={`terminal-rail-session-item${t.id === activeTabId ? ' is-active' : ''}`}
                              onClick={() =>
                                activateOrCreateTabInFocusedPane(t.id)
                              }
                            >
                              <span
                                className={`tab-status-dot is-${t.status}`}
                              />
                              <span className="terminal-rail-session-name">
                                {t.title}
                              </span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {railModule === 'agent' && (
                  <div className="terminal-rail-section">
                    <div className="terminal-rail-group-head">
                      <span>活跃 Agent 会话 ({agentTabs.length})</span>
                      <button
                        type="button"
                        className="terminal-rail-mini-btn is-accent"
                        onClick={() => createSpecialTab('agent')}
                      >
                        + 新建 Agent
                      </button>
                    </div>
                    <div className="terminal-rail-session-list">
                      {agentTabs.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={`terminal-rail-session-item${t.id === activeTabId ? ' is-active' : ''}`}
                          onClick={() => activateOrCreateTabInFocusedPane(t.id)}
                        >
                          <span className={`tab-status-dot is-${t.status}`} />
                          <span className="terminal-rail-session-name">
                            {t.title}
                          </span>
                        </button>
                      ))}
                    </div>

                    <div className="terminal-rail-group-label">
                      多窗协同场景模板
                    </div>
                    <div className="terminal-rail-preset-list">
                      {WORKSPACE_LAYOUT_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className="terminal-rail-preset-card"
                          onClick={() => applyWorkspacePreset(preset)}
                        >
                          <div className="terminal-rail-preset-top">
                            <span className="option-badge">{preset.badge}</span>
                            <strong>{preset.title}</strong>
                          </div>
                          <span>{preset.description}</span>
                        </button>
                      ))}
                    </div>

                    <div className="terminal-rail-group-label">
                      快捷指令与模型配置
                    </div>
                    <div className="terminal-rail-action-grid">
                      <button
                        type="button"
                        className="terminal-rail-mini-btn"
                        onClick={() => sendToAgentPane('/help')}
                      >
                        /help 指南
                      </button>
                      <button
                        type="button"
                        className="terminal-rail-mini-btn"
                        onClick={() => {
                          if (activeTab?.kind === 'agent') {
                            agentRefs.current
                              .get(activeTab.id)
                              ?.openModelModal();
                          }
                        }}
                      >
                        Ctrl+M 模型
                      </button>
                    </div>
                  </div>
                )}

                {railModule === 'shell' && (
                  <div className="terminal-rail-section">
                    <div className="terminal-rail-group-head">
                      <span>活跃终端会话 ({shellTabs.length})</span>
                      <button
                        type="button"
                        className="terminal-rail-mini-btn is-accent"
                        onClick={() => createNewTab('powershell')}
                      >
                        + 新建终端
                      </button>
                    </div>
                    <div className="terminal-rail-session-list">
                      {shellTabs.map((t) => (
                        <div
                          key={t.id}
                          className={`terminal-rail-session-item${t.id === activeTabId ? ' is-active' : ''}`}
                        >
                          <button
                            type="button"
                            className="terminal-rail-session-main"
                            onClick={() =>
                              activateOrCreateTabInFocusedPane(t.id)
                            }
                          >
                            <span className={`tab-status-dot is-${t.status}`} />
                            <span className="option-badge">
                              {t.shell.toUpperCase()}
                            </span>
                            <span className="terminal-rail-session-name">
                              {t.title}
                            </span>
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className="terminal-rail-group-label">
                      启动 Shell 外壳
                    </div>
                    <div className="terminal-rail-action-grid">
                      {shells.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className="terminal-rail-mini-btn"
                          disabled={
                            !opt.available || tabs.length >= MAX_WORKSPACE_TABS
                          }
                          onClick={() => createNewTab(opt.id)}
                          title={opt.description}
                        >
                          + {opt.badge}
                        </button>
                      ))}
                    </div>

                    <div className="terminal-rail-group-label">
                      CLI 模型套娃会话
                    </div>
                    <div className="terminal-rail-action-grid">
                      {CLI_PRESETS.map((cli) => (
                        <button
                          key={cli.id}
                          type="button"
                          className="terminal-rail-mini-btn"
                          disabled={tabs.length >= MAX_WORKSPACE_TABS}
                          onClick={() => createNewTab('powershell', cli.id)}
                          title={cli.desc}
                        >
                          ⚡ {cli.label}
                        </button>
                      ))}
                    </div>

                    <div className="terminal-rail-group-label">
                      命令速查与知识动作
                    </div>
                    <button
                      type="button"
                      className="terminal-rail-full-btn"
                      onClick={() => setDrawerOpen((o) => !o)}
                    >
                      {drawerOpen
                        ? '收起右侧命令速查栏'
                        : '展开 Linux / 知识库命令栏'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </aside>

        <section
          className={`terminal-stage-panes is-${isStageZoomed ? 'single' : splitMode}${isStageZoomed ? ' is-zoomed' : ''}${showPaneHeaders ? '' : ' is-headerless'}`}
          aria-label="终端多窗格画布"
          style={
            {
              '--primary-pane-size': `${splitRatio}fr`,
              '--secondary-pane-size': `${1 - splitRatio}fr`,
            } as React.CSSProperties
          }
        >
          {/* Compact Pane Chrome Headers (only rendered in multi-pane split when unzoomed) */}
          {showPaneHeaders &&
            activePaneIds.map((paneTabId, paneIdx) => {
              if (isStageZoomed && paneIdx !== zoomedPaneIndex) return null;
              const paneTab = tabs.find((t) => t.id === paneTabId) ?? tabs[0];
              if (!paneTab) return null;
              const isPaneFocused = paneIdx === safeFocusedPane;
              return (
                <div
                  key={`header-${paneIdx}`}
                  className={`pane-header pane-header-${paneIdx}${isPaneFocused ? ' is-focused' : ''}`}
                  style={{
                    gridArea: isStageZoomed ? 'header0' : `header${paneIdx}`,
                  }}
                  onMouseDown={() => {
                    setFocusedPaneIndex(paneIdx);
                    requestAnimationFrame(() => focusTabHandle(paneTab.id));
                  }}
                >
                  <div className="pane-header-left">
                    <span
                      className={`pane-status-dot is-${paneTab.status}`}
                      aria-hidden="true"
                    />
                    <select
                      className="pane-tab-select"
                      value={paneTab.id}
                      onChange={(event) => {
                        const nextId = event.target.value;
                        setPaneTabIds((prev) => {
                          const next = [...prev];
                          next[paneIdx] = nextId;
                          return next;
                        });
                        setFocusedPaneIndex(paneIdx);
                      }}
                      aria-label={`窗格 ${paneIdx + 1} 会话`}
                    >
                      {tabs.map((tab) => {
                        const badge =
                          tab.kind === 'agent'
                            ? 'AGENT'
                            : tab.kind === 'lab'
                              ? `LAB:${(tab.labLanguage ?? 'py').toUpperCase()}`
                              : tab.shell.toUpperCase();
                        return (
                          <option key={tab.id} value={tab.id}>
                            [{badge}] {tab.title}
                          </option>
                        );
                      })}
                    </select>
                    {paneTab.statusMessage && (
                      <span
                        className="pane-header-meta"
                        title={paneTab.statusMessage}
                      >
                        {paneTab.statusMessage}
                      </span>
                    )}
                  </div>

                  <div className="pane-header-actions">
                    {(!paneTab.kind || paneTab.kind === 'shell') &&
                      CLI_PRESETS.map((cli) => (
                        <button
                          key={cli.id}
                          type="button"
                          className="pane-mini-cli-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFocusedPaneIndex(paneIdx);
                            terminalRefs.current
                              .get(paneTab.id)
                              ?.sendCommand(cli.id, true);
                          }}
                          title={`在当前窗格运行 ${cli.desc}`}
                        >
                          {cli.label}
                        </button>
                      ))}

                    {visibleCount > 1 && (
                      <button
                        type="button"
                        className={`pane-mini-icon-btn${isStageZoomed ? ' is-active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setZoomedPaneIndex((z) =>
                            z === null ? paneIdx : null,
                          );
                        }}
                        title={
                          isStageZoomed
                            ? '还原多窗分屏 (Ctrl+Shift+M)'
                            : '全屏放大此窗格 (Ctrl+Shift+M)'
                        }
                      >
                        <ZoomPaneIcon zoomed={isStageZoomed} />
                      </button>
                    )}

                    <button
                      type="button"
                      className="pane-mini-icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        splitOutPane(paneIdx);
                      }}
                      title="向侧边新增分屏窗格"
                    >
                      <DrawerSplitIcon />
                    </button>

                    <button
                      type="button"
                      className="pane-mini-icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handlePopoutWindow(undefined, paneTab.id);
                      }}
                      title="将此目录弹出到新独立窗口"
                    >
                      <PopoutWindowIcon />
                    </button>

                    {visibleCount > 1 && !isStageZoomed && (
                      <button
                        type="button"
                        className="pane-mini-icon-btn is-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          closePaneSlot(paneIdx);
                        }}
                        title="关闭此分屏窗格（后台会话仍保留在标签栏）"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

          {/* Drag divider for 2-pane splits and tri vertical split */}
          {!isStageZoomed &&
            (splitMode === 'vertical' ||
              splitMode === 'horizontal' ||
              splitMode === 'tri') && (
              <div
                className="terminal-pane-divider"
                role="separator"
                aria-orientation={
                  splitMode === 'horizontal' ? 'horizontal' : 'vertical'
                }
                onPointerDown={(event) => {
                  const container = event.currentTarget.parentElement;
                  if (!container) return;
                  const rect = container.getBoundingClientRect();
                  const isHorizontal = splitMode === 'horizontal';
                  const onPointerMove = (moveEvent: PointerEvent) => {
                    const ratio = isHorizontal
                      ? (moveEvent.clientY - rect.top - 28) /
                        Math.max(1, rect.height - 56)
                      : (moveEvent.clientX - rect.left) /
                        Math.max(1, rect.width);
                    setSplitRatio(Math.max(0.22, Math.min(0.78, ratio)));
                  };
                  const onPointerUp = () => {
                    window.removeEventListener('pointermove', onPointerMove);
                    window.removeEventListener('pointerup', onPointerUp);
                  };
                  window.addEventListener('pointermove', onPointerMove);
                  window.addEventListener('pointerup', onPointerUp, {
                    once: true,
                  });
                }}
                title="拖动调整窗格比例"
              >
                <div className="divider-handle" />
              </div>
            )}

          {/* Stably mounted PTY, Agent & Code Lab instances mapped cleanly onto pane0..pane3 */}
          {tabs.map((tab) => {
            const assignedPane = tabToPaneIndex.get(tab.id);
            const isVisibleInStage =
              assignedPane !== undefined &&
              (!isStageZoomed || assignedPane === zoomedPaneIndex);
            const isFocused = assignedPane === safeFocusedPane;
            const paneStyle = {
              gridArea:
                isStageZoomed && isVisibleInStage
                  ? 'pane0'
                  : isVisibleInStage
                    ? `pane${assignedPane}`
                    : 'pane0',
            };
            const onTabStatus = (
              status: TerminalTab['status'],
              message?: string,
            ) => {
              setTabs((previous) =>
                previous.map((item) =>
                  item.id === tab.id
                    ? { ...item, status, statusMessage: message }
                    : item,
                ),
              );
            };
            const onFocusTabPane = () => {
              if (assignedPane !== undefined) {
                setFocusedPaneIndex(assignedPane);
              }
            };

            if (tab.kind === 'agent') {
              return (
                <TerminalAgentView
                  key={tab.id}
                  ref={(instance) => {
                    if (instance) agentRefs.current.set(tab.id, instance);
                    else agentRefs.current.delete(tab.id);
                  }}
                  tab={tab}
                  theme={theme}
                  isFocused={isFocused}
                  style={paneStyle}
                  active={active && isVisibleInStage}
                  bridge={mergedBridge}
                  paneAccessor={paneAccessor}
                  onFocusPane={onFocusTabPane}
                  onStatusChange={onTabStatus}
                />
              );
            }

            if (tab.kind === 'lab') {
              return (
                <TerminalCodeLabView
                  key={tab.id}
                  ref={(instance) => {
                    if (instance) labRefs.current.set(tab.id, instance);
                    else labRefs.current.delete(tab.id);
                  }}
                  tab={tab}
                  theme={theme}
                  isFocused={isFocused}
                  style={paneStyle}
                  active={active && isVisibleInStage}
                  bridge={mergedBridge}
                  onFocusPane={onFocusTabPane}
                  onStatusChange={onTabStatus}
                  onSendToShellPane={sendToShellPane}
                  onSendToAgentPane={sendToAgentPane}
                  onActiveFileChange={setActiveLabInfo}
                />
              );
            }

            return (
              <TerminalSessionView
                key={tab.id}
                ref={(instance) => {
                  if (instance) terminalRefs.current.set(tab.id, instance);
                  else terminalRefs.current.delete(tab.id);
                }}
                tab={tab}
                theme={theme}
                isFocused={isFocused}
                style={paneStyle}
                active={active && isVisibleInStage}
                onFocusPane={onFocusTabPane}
                onStatusChange={onTabStatus}
                onMetaChange={(meta) => {
                  setSessionMetaById((prev) => ({
                    ...prev,
                    [tab.id]: meta,
                  }));
                }}
                onCwdChange={(nextCwd) => {
                  setTabs((previous) =>
                    previous.map((item) =>
                      item.id === tab.id ? { ...item, cwd: nextCwd } : item,
                    ),
                  );
                }}
                onBell={() => {
                  setTabs((previous) =>
                    previous.map((item) =>
                      item.id === tab.id && item.id !== activeTabId
                        ? { ...item, bellCount: (item.bellCount ?? 0) + 1 }
                        : item,
                    ),
                  );
                }}
              />
            );
          })}
        </section>

        {/* Collapsible Command & Knowledge Drawer */}
        {drawerOpen && (
          <aside
            className="terminal-knowledge-drawer"
            aria-label="终端命令与跨界面知识联动"
          >
            <div className="drawer-heading">
              <div className="drawer-segmented-tabs" role="tablist">
                {TERMINAL_TOOLS.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    role="tab"
                    aria-selected={drawerTab === tool.id}
                    className={`drawer-tab-btn ${drawerTab === tool.id ? 'is-active' : ''}`}
                    onClick={() => applyTool(tool.id)}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`drawer-pin-btn ${drawerPinned ? 'is-active' : ''}`}
                aria-pressed={drawerPinned}
                onClick={() => setDrawerPinned((pinned) => !pinned)}
                title={
                  drawerPinned
                    ? '已钉住，Esc 留给终端'
                    : '钉住后面板不会被 Esc 关掉'
                }
              >
                {drawerPinned ? '已钉住' : '钉住'}
              </button>
              <button
                type="button"
                className="drawer-close-btn"
                onClick={() => {
                  setDrawerOpen(false);
                  focusActiveTerminal();
                }}
                aria-label="关闭工具面板"
              >
                ×
              </button>
            </div>

            {drawerTab === 'linux' && (
              <div
                className="drawer-panel-scroll"
                ref={commandPanelRef}
                onKeyDown={onCommandListKeyDown}
              >
                <div className="command-library-toolbar">
                  <input
                    ref={commandSearchRef}
                    className="command-search"
                    type="search"
                    role="combobox"
                    aria-expanded={filteredLinuxCheats.length > 0}
                    aria-controls="terminal-command-list"
                    aria-autocomplete="list"
                    aria-activedescendant={
                      focusedCommandId
                        ? `command-row-${focusedCommandId}`
                        : undefined
                    }
                    value={commandQuery}
                    onChange={(event) => setCommandQuery(event.target.value)}
                    placeholder="搜索命令、用途或场景"
                    aria-label="搜索命令库"
                  />
                  <div className="command-view-switch" aria-label="命令筛选">
                    {(
                      [
                        ['all', '全部'],
                        ['favorites', '收藏'],
                        ['recent', '最近'],
                      ] as const
                    ).map(([view, label]) => (
                      <button
                        key={view}
                        type="button"
                        className={
                          commandView === view
                            ? 'filter-chip is-active'
                            : 'filter-chip'
                        }
                        onClick={() => setCommandView(view)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="command-shell-context">
                    目标窗格 #{safeFocusedPane + 1} ·{' '}
                    {shells.find((shell) => shell.id === activeShell)?.name ??
                      activeShell}
                    {' · Enter 填入 · Shift+Enter 运行'}
                  </div>
                </div>
                <div className="drawer-filter-bar">
                  {COMMAND_CATEGORY_FILTERS.map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className={`filter-chip ${linuxFilter === val ? 'is-active' : ''}`}
                      onClick={() => setLinuxFilter(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <ul
                  id="terminal-command-list"
                  className="command-list"
                  role="listbox"
                  aria-label="命令库"
                >
                  {filteredLinuxCheats.map((item) => {
                    const command = commandTextForShell(item, activeShell);
                    const focused = item.id === focusedCommandId;
                    const categoryLabel =
                      COMMAND_CATEGORY_FILTERS.find(
                        ([id]) => id === item.category,
                      )?.[1] ?? item.categoryLabel;
                    const otherShells = shellsWithCommand(item, shells).filter(
                      (shell) => shell.id !== activeShell,
                    );
                    return (
                      <li key={item.id}>
                        <div
                          id={`command-row-${item.id}`}
                          className={
                            focused ? 'command-row is-focused' : 'command-row'
                          }
                          role="option"
                          aria-selected={focused}
                          data-command-id={item.id}
                          title={
                            sessionReady
                              ? '填入当前聚焦终端，不回车'
                              : '终端还没就绪'
                          }
                          onMouseEnter={() => setFocusedCommandId(item.id)}
                          onMouseDown={(event) => {
                            if (
                              event.target instanceof Element &&
                              event.target.closest('button')
                            ) {
                              return;
                            }
                            event.preventDefault();
                          }}
                          onClick={(event) => {
                            if (
                              event.target instanceof Element &&
                              event.target.closest('button')
                            ) {
                              return;
                            }
                            setFocusedCommandId(item.id);
                            if (!command || !sessionReady) return;
                            rememberCommand(item.id);
                            sendCommandToActive(command, false);
                          }}
                        >
                          <div className="command-row-main">
                            <span className="command-row-tag">
                              {categoryLabel}
                            </span>
                            <span className="command-row-title">
                              {item.title}
                            </span>
                            <button
                              type="button"
                              className={
                                favoriteCommandIds.includes(item.id)
                                  ? 'command-favorite is-active'
                                  : 'command-favorite'
                              }
                              onClick={() => toggleCommandFavorite(item.id)}
                              aria-label={
                                favoriteCommandIds.includes(item.id)
                                  ? '取消收藏命令'
                                  : '收藏命令'
                              }
                            >
                              {favoriteCommandIds.includes(item.id)
                                ? '已收藏'
                                : '收藏'}
                            </button>
                          </div>
                          <code
                            className={
                              command
                                ? 'command-row-code'
                                : 'command-row-code is-missing'
                            }
                          >
                            {command ?? '当前环境没有这条命令'}
                          </code>
                          {focused && (
                            <div className="command-row-detail">
                              <p className="command-row-note">
                                {item.explanation} {item.practicalScenario}
                              </p>
                              {command ? (
                                <button
                                  type="button"
                                  className="command-row-run"
                                  disabled={!sessionReady}
                                  title={
                                    item.requiresConfirmation
                                      ? '运行前需要确认'
                                      : '在当前聚焦终端运行'
                                  }
                                  onClick={() =>
                                    runOrConfirmCommand(
                                      item.title,
                                      command,
                                      Boolean(item.requiresConfirmation),
                                      item.id,
                                    )
                                  }
                                >
                                  运行
                                </button>
                              ) : (
                                <div className="command-row-actions">
                                  <span className="command-row-shells">
                                    {otherShells.length > 0
                                      ? `可用环境：${otherShells
                                          .map((shell) =>
                                            shell.available
                                              ? shell.name
                                              : `${shell.name}（未检测到）`,
                                          )
                                          .join('、')}`
                                      : '没有其他环境提供这条命令'}
                                  </span>
                                  {otherShells.map((shell) => (
                                    <button
                                      key={shell.id}
                                      type="button"
                                      className="command-row-shell"
                                      disabled={
                                        !shell.available ||
                                        tabs.length >= MAX_WORKSPACE_TABS
                                      }
                                      title={
                                        shell.available
                                          ? `用${shell.name}新建标签`
                                          : '未检测到'
                                      }
                                      onClick={() => createNewTab(shell.id)}
                                    >
                                      用{shell.name}新建标签
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {filteredLinuxCheats.length === 0 && (
                  <div className="command-empty-state">没有匹配的命令。</div>
                )}

                {relatedBooks.length > 0 && (
                  <div className="drawer-related-books">
                    <div className="related-books-header">相关书架</div>
                    {relatedBooks.map((book) => (
                      <div
                        key={book.relativePath}
                        className="related-book-row"
                        onClick={() => onOpenBook?.(book)}
                        title="点击直接在电子书阅读器中打开"
                      >
                        <span className="related-book-tag">EPUB</span>
                        <span className="related-book-title">{book.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {drawerTab === 'knowledge' && (
              <div
                className="drawer-panel-scroll"
                ref={knowledgePanelRef}
                onKeyDown={onKnowledgeListKeyDown}
              >
                <div className="drawer-intro-card">
                  <h4>知识修正</h4>
                  <p>
                    示例命令，在当前目录执行。路径是写死的，例如「计算机网络复习.md」和
                    test.c。填入或运行不会打开知识库、导图或试卷。已经发出的命令要在终端里用
                    Ctrl+C 中断。
                  </p>
                </div>
                <div className="command-library-toolbar">
                  <input
                    ref={knowledgeSearchRef}
                    className="command-search"
                    type="search"
                    role="combobox"
                    aria-expanded={filteredKnowledgeActions.length > 0}
                    aria-controls="terminal-knowledge-list"
                    aria-autocomplete="list"
                    aria-activedescendant={
                      focusedKnowledgeId
                        ? `knowledge-row-${focusedKnowledgeId}`
                        : undefined
                    }
                    value={knowledgeQuery}
                    onChange={(event) => setKnowledgeQuery(event.target.value)}
                    placeholder="搜索知识动作"
                    aria-label="搜索知识动作"
                  />
                  <div className="command-shell-context">
                    目标窗格 #{safeFocusedPane + 1} ·{' '}
                    {shells.find((shell) => shell.id === activeShell)?.name ??
                      activeShell}
                    {' · Enter 填入 · Shift+Enter 运行'}
                  </div>
                </div>
                <ul
                  id="terminal-knowledge-list"
                  className="command-list"
                  role="listbox"
                  aria-label="知识修正"
                >
                  {filteredKnowledgeActions.map((item) => {
                    const command = knowledgeCommandForShell(item, activeShell);
                    const focused = item.id === focusedKnowledgeId;
                    const otherShells = knowledgeShells(item, shells).filter(
                      (shell) => shell.id !== activeShell,
                    );
                    return (
                      <li key={item.id}>
                        <div
                          id={`knowledge-row-${item.id}`}
                          className={
                            focused ? 'command-row is-focused' : 'command-row'
                          }
                          role="option"
                          aria-selected={focused}
                          data-knowledge-id={item.id}
                          title={
                            sessionReady
                              ? '填入当前聚焦终端，不回车'
                              : '终端还没就绪'
                          }
                          onMouseEnter={() => setFocusedKnowledgeId(item.id)}
                          onMouseDown={(event) => {
                            if (
                              event.target instanceof Element &&
                              event.target.closest('button')
                            ) {
                              return;
                            }
                            event.preventDefault();
                          }}
                          onClick={(event) => {
                            if (
                              event.target instanceof Element &&
                              event.target.closest('button')
                            ) {
                              return;
                            }
                            setFocusedKnowledgeId(item.id);
                            applyKnowledgeAction(item, false);
                          }}
                        >
                          <div className="command-row-main">
                            <span className="command-row-tag">
                              {KNOWLEDGE_TARGET_LABEL[item.category]}
                            </span>
                            <span className="command-row-title">
                              {item.title}
                            </span>
                          </div>
                          <code
                            className={
                              command
                                ? 'command-row-code'
                                : 'command-row-code is-missing'
                            }
                          >
                            {command ?? '当前环境没有这条命令'}
                          </code>
                          {focused && (
                            <div className="command-row-detail">
                              <p className="command-row-note">
                                {knowledgeActionNote(item)}
                              </p>
                              {command ? (
                                <div className="command-row-actions">
                                  <button
                                    type="button"
                                    className="command-row-fill"
                                    disabled={!sessionReady}
                                    title="填入当前聚焦终端，不回车"
                                    onClick={() =>
                                      applyKnowledgeAction(item, false)
                                    }
                                  >
                                    填入
                                  </button>
                                  <button
                                    type="button"
                                    className="command-row-run"
                                    disabled={!sessionReady}
                                    title={
                                      item.requiresConfirmation
                                        ? '运行前需要确认'
                                        : '在当前聚焦终端运行'
                                    }
                                    onClick={() =>
                                      applyKnowledgeAction(item, true)
                                    }
                                  >
                                    运行
                                  </button>
                                </div>
                              ) : (
                                <div className="command-row-actions">
                                  <span className="command-row-shells">
                                    {otherShells.length > 0
                                      ? `可用环境：${otherShells
                                          .map((shell) =>
                                            shell.available
                                              ? shell.name
                                              : `${shell.name}（未检测到）`,
                                          )
                                          .join('、')}`
                                      : '没有其他环境提供这条命令'}
                                  </span>
                                  {otherShells.map((shell) => (
                                    <button
                                      key={shell.id}
                                      type="button"
                                      className="command-row-shell"
                                      disabled={
                                        !shell.available ||
                                        tabs.length >= MAX_WORKSPACE_TABS
                                      }
                                      title={
                                        shell.available
                                          ? `用${shell.name}新建标签`
                                          : '未检测到'
                                      }
                                      onClick={() => createNewTab(shell.id)}
                                    >
                                      用{shell.name}新建标签
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {filteredKnowledgeActions.length === 0 && (
                  <div className="command-empty-state">
                    没有匹配的知识动作。
                  </div>
                )}
              </div>
            )}
          </aside>
        )}
      </div>

      {pendingCommand && (
        <div
          className="terminal-command-confirm-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPendingCommand(null);
          }}
        >
          <section
            className="terminal-command-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="terminal-command-confirm-title"
          >
            <div className="terminal-command-confirm-heading">
              <span className="terminal-confirm-label">执行前确认</span>
              <button
                type="button"
                className="terminal-confirm-close"
                onClick={() => setPendingCommand(null)}
                aria-label="关闭确认窗口"
              >
                ×
              </button>
            </div>
            <h2 id="terminal-command-confirm-title">{pendingCommand.title}</h2>
            <p>
              此命令会修改文件或权限。确认 Shell 为{' '}
              <strong>{pendingCommand.shell.toUpperCase()}</strong>，工作目录为{' '}
              <code>{pendingCommand.cwd || '.'}</code>。
            </p>
            <pre className="terminal-confirm-command">
              <code>{pendingCommand.command}</code>
            </pre>
            <div className="terminal-confirm-actions">
              <button type="button" onClick={() => setPendingCommand(null)}>
                取消
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={confirmPendingCommand}
              >
                确认并执行
              </button>
            </div>
          </section>
        </div>
      )}

      <footer
        className="terminal-unified-footer"
        aria-label="终端状态与快捷动作"
      >
        <div className="terminal-footer-left">
          <span
            className={`tab-status-dot is-${activeTab?.status ?? 'ready'}`}
            aria-hidden="true"
          />
          <span className="terminal-footer-session">
            {activeTab?.title ?? 'PowerShell'}
          </span>
          <span className="terminal-footer-sep" aria-hidden="true">
            ·
          </span>
          <span className="terminal-footer-path" title={focusedLiveCwd || '.'}>
            {focusedLiveCwd || '.'}
          </span>
          {isStageZoomed && (
            <button
              type="button"
              className="terminal-footer-zoom-pill"
              onClick={() => setZoomedPaneIndex(null)}
              title="点击还原分屏布局 (Ctrl+Shift+M)"
            >
              已放大 · 还原
            </button>
          )}
          {focusedSessionMeta?.viActive && (
            <span className="terminal-footer-state">
              Vi {focusedSessionMeta.viMode}
            </span>
          )}
          {focusedSessionMeta?.flashNotice && (
            <span className="terminal-footer-state">
              {focusedSessionMeta.flashNotice}
            </span>
          )}
          {focusedSessionMeta &&
            focusedSessionMeta.internalStatus !== '就绪' && (
              <span className="terminal-footer-warn">
                {focusedSessionMeta.internalStatus}
              </span>
            )}
        </div>

        <div className="terminal-footer-hints">
          {(!activeTab?.kind || activeTab.kind === 'shell') &&
            focusedSessionMeta && (
              <>
                <span className="terminal-footer-meta">
                  {focusedSessionMeta.webgl ? 'GL' : 'DOM'}{' '}
                  {focusedSessionMeta.cols}×{focusedSessionMeta.rows}
                </span>
                <button
                  type="button"
                  className={`terminal-footer-cmd${focusedSessionMeta.searchOpen ? ' is-active' : ''}`}
                  onClick={() =>
                    terminalRefs.current.get(activeTabId)?.openSearch()
                  }
                  title="搜索缓冲区 (Ctrl+Shift+F)"
                >
                  搜索
                </button>
                <button
                  type="button"
                  className={`terminal-footer-cmd${focusedSessionMeta.viActive ? ' is-active' : ''}`}
                  onClick={() =>
                    terminalRefs.current.get(activeTabId)?.toggleViMode()
                  }
                  title="Vi 光标选择模式 (Ctrl+Shift+Space)"
                >
                  Vi
                </button>
                <button
                  type="button"
                  className={`terminal-footer-cmd${focusedSessionMeta.hintsActive ? ' is-active' : ''}`}
                  onClick={() =>
                    terminalRefs.current.get(activeTabId)?.triggerHints()
                  }
                  title="快捷路径/链接标号跳转 (Ctrl+Shift+O)"
                >
                  Hints
                </button>
                <button
                  type="button"
                  className="terminal-footer-cmd"
                  onClick={() => terminalRefs.current.get(activeTabId)?.clear()}
                  title="清屏"
                >
                  清屏
                </button>
              </>
            )}

          {activeTab?.kind === 'agent' &&
            activeFooterHints.map((hint) => (
              <span
                key={`${hint.keys}-${hint.label}`}
                className="terminal-footer-hint"
              >
                <kbd>{hint.keys}</kbd>
                {hint.label}
              </span>
            ))}

          <span className="terminal-footer-meta">UTF-8</span>
          <button
            type="button"
            className="terminal-footer-palette-btn"
            onClick={() => {
              setPaletteOpen(true);
              setPaletteQuery('');
              setPaletteIndex(0);
              requestAnimationFrame(() => paletteSearchRef.current?.focus());
            }}
            title="全局终端命令面板 (Ctrl+K)"
          >
            Ctrl+K
          </button>
        </div>
      </footer>

      {paletteOpen && (
        <div
          className="terminal-palette-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPaletteOpen(false);
              focusActiveTerminal();
            }
          }}
        >
          <section
            className="terminal-palette-modal"
            role="dialog"
            aria-modal="true"
            aria-label="全局终端命令面板"
          >
            <div className="terminal-palette-input-row">
              <span className="terminal-palette-prompt">&gt;_</span>
              <input
                ref={paletteSearchRef}
                type="text"
                className="terminal-palette-input"
                value={paletteQuery}
                onChange={(e) => {
                  setPaletteQuery(e.target.value);
                  setPaletteIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setPaletteOpen(false);
                    focusActiveTerminal();
                    return;
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setPaletteIndex((i) =>
                      Math.min(
                        Math.max(0, filteredPaletteActions.length - 1),
                        i + 1,
                      ),
                    );
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setPaletteIndex((i) => Math.max(0, i - 1));
                    return;
                  }
                  if (
                    e.key === 'Enter' &&
                    filteredPaletteActions[safePaletteIndex]
                  ) {
                    e.preventDefault();
                    const chosen = filteredPaletteActions[safePaletteIndex];
                    setPaletteOpen(false);
                    chosen.run();
                  }
                }}
                placeholder="搜索场景模板、新建 Agent / Code Lab、切换分屏或工作区跳转…"
              />
            </div>

            <div className="terminal-palette-list" role="listbox">
              {filteredPaletteActions.length === 0 ? (
                <div className="terminal-palette-empty">无匹配操作</div>
              ) : (
                filteredPaletteActions.map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={idx === safePaletteIndex}
                    className={`terminal-palette-item${idx === safePaletteIndex ? ' is-selected' : ''}`}
                    onMouseEnter={() => setPaletteIndex(idx)}
                    onClick={() => {
                      setPaletteOpen(false);
                      item.run();
                    }}
                  >
                    <span className="terminal-palette-badge">{item.badge}</span>
                    <div className="terminal-palette-item-text">
                      <strong>{item.title}</strong>
                      <span>{item.subtitle}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
