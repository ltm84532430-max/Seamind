import { useEffect, useMemo, useRef, useState } from 'react';
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
  TerminalSessionView,
  type TerminalSessionViewHandle,
} from './TerminalSessionView';
import type {
  SplitLayoutMode,
  TerminalCliPreset,
  TerminalPreferences,
  TerminalShellOption,
  TerminalShellType,
  TerminalTab,
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
  standalone?: boolean;
  initialShell?: TerminalShellType;
  initialCli?: TerminalCliPreset;
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
  standalone = false,
  initialShell = 'powershell',
  initialCli,
}: TerminalWorkspaceProps) {
  const initialCleanCwd = normalizeDisplayPath(cwd);
  const initialTabRef = useRef<TerminalTab>({
    id: 'tab-1',
    title: initialCli
      ? `${initialCli.toUpperCase()} · ${initialShell.toUpperCase()}`
      : `${initialShell === 'powershell' ? 'PowerShell' : initialShell.toUpperCase()} 1`,
    shell: initialShell,
    cwd: initialCleanCwd,
    initialCli,
    status: 'starting',
    createdAt: Date.now(),
  });

  const [shells, setShells] = useState<TerminalShellOption[]>(DEFAULT_SHELLS);
  const [tabs, setTabs] = useState<TerminalTab[]>([initialTabRef.current]);
  const [paneTabIds, setPaneTabIds] = useState<string[]>(['tab-1']);
  const [focusedPaneIndex, setFocusedPaneIndex] = useState<number>(0);
  const [splitMode, setSplitMode] = useState<SplitLayoutMode>('single');
  const [splitRatio, setSplitRatio] = useState<number>(0.5);

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

  const terminalRefs = useRef<Map<string, TerminalSessionViewHandle>>(
    new Map(),
  );
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const shellMenuRef = useRef<HTMLDivElement>(null);
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

  const focusActiveTerminal = () => {
    terminalRefs.current.get(activeTabId)?.focus();
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
    if (!showShellMenu && !toolsMenuOpen && !showPrefsMenu && !showPopoutMenu) {
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
  }, [showShellMenu, toolsMenuOpen, showPrefsMenu, showPopoutMenu]);

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
        requestAnimationFrame(() => terminalRefs.current.get(tab.id)?.focus());
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
        requestAnimationFrame(() => commandSearchRef.current?.focus());
        return;
      }
      if (event.key !== 'Escape') return;
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
    safeFocusedPane,
    showPopoutMenu,
    showPrefsMenu,
    showShellMenu,
    tabs,
    toolsMenuOpen,
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
  ) => {
    setShowPopoutMenu(false);
    const srcTab =
      tabs.find((t) => t.id === (sourceTabId ?? activeTabId)) ?? activeTab;
    const targetCwd =
      terminalRefs.current.get(srcTab?.id ?? '')?.getCwd() ||
      srcTab?.cwd ||
      initialCleanCwd;
    const result = await openStandaloneTerminalWindow({
      cwd: normalizeDisplayPath(targetCwd),
      shell: srcTab?.shell ?? 'powershell',
      cli: cliPreset,
      theme,
    });
    if (result.ok) {
      showTempNotice(
        cliPreset ? `已在独立窗口启动 ${cliPreset}` : '已打开独立终端窗口',
      );
    } else {
      showTempNotice(result.error || '独立窗口创建失败');
    }
  };

  const closeTab = (tabId: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (tabs.length <= 1) return;
    const nextTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(nextTabs);
    setPaneTabIds((prev) =>
      prev.map((id) => (id === tabId ? (nextTabs[0]?.id ?? '') : id)),
    );
    terminalRefs.current.delete(tabId);
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
                  requestAnimationFrame(() =>
                    terminalRefs.current.get(tab.id)?.focus(),
                  );
                }}
                onDoubleClick={() => startRenameTab(tab)}
                role="tab"
                aria-selected={isActive}
              >
                <span className="tab-shell-tag">{tab.shell.toUpperCase()}</span>
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
                  <span className="tab-title" title={tab.title}>
                    {tab.title}
                  </span>
                )}
                {index < 9 && (
                  <span className="tab-index-hint">{`Alt+${index + 1}`}</span>
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
              title="新建终端或一键开启 AI CLI 会话"
            >
              + 新建
            </button>

            {showShellMenu && (
              <div className="terminal-shell-menu">
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

          <div
            className="terminal-layout-icons"
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
                className={`terminal-icon-btn${splitMode === mode ? ' is-active' : ''}`}
                onClick={() => switchLayoutMode(mode)}
                title={title}
                aria-label={title}
              >
                <LayoutIcon mode={mode} />
              </button>
            ))}
          </div>

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

      {/* Center Multi-Pane Stage + Optional Right Drawer */}
      <div className="terminal-workspace-body">
        <section
          className={`terminal-stage-panes is-${splitMode}`}
          aria-label="终端多窗格画布"
          style={
            {
              '--primary-pane-size': `${splitRatio}fr`,
              '--secondary-pane-size': `${1 - splitRatio}fr`,
            } as React.CSSProperties
          }
        >
          {/* Compact Pane Chrome Headers (one per visible pane slot) */}
          {activePaneIds.map((paneTabId, paneIdx) => {
            const paneTab = tabs.find((t) => t.id === paneTabId) ?? tabs[0];
            if (!paneTab) return null;
            const isPaneFocused = paneIdx === safeFocusedPane;
            return (
              <div
                key={`header-${paneIdx}`}
                className={`pane-header pane-header-${paneIdx}${isPaneFocused ? ' is-focused' : ''}`}
                style={{ gridArea: `header${paneIdx}` }}
                onMouseDown={() => {
                  setFocusedPaneIndex(paneIdx);
                  requestAnimationFrame(() =>
                    terminalRefs.current.get(paneTab.id)?.focus(),
                  );
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
                    {tabs.map((tab) => (
                      <option key={tab.id} value={tab.id}>
                        [{tab.shell.toUpperCase()}] {tab.title}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="pane-header-actions">
                  {CLI_PRESETS.map((cli) => (
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

                  {visibleCount > 1 && (
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
          {(splitMode === 'vertical' ||
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
                    : (moveEvent.clientX - rect.left) / Math.max(1, rect.width);
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

          {/* Stably mounted PTY instances mapped cleanly onto pane0..pane3 */}
          {tabs.map((tab) => {
            const assignedPane = tabToPaneIndex.get(tab.id);
            const isVisibleInStage = assignedPane !== undefined;
            const isFocused = assignedPane === safeFocusedPane;
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
                style={{
                  gridArea: isVisibleInStage ? `pane${assignedPane}` : 'pane0',
                }}
                active={active && isVisibleInStage}
                onFocusPane={() => {
                  if (assignedPane !== undefined) {
                    setFocusedPaneIndex(assignedPane);
                  }
                }}
                onStatusChange={(status, message) => {
                  setTabs((previous) =>
                    previous.map((item) =>
                      item.id === tab.id
                        ? { ...item, status, statusMessage: message }
                        : item,
                    ),
                  );
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
    </main>
  );
}
