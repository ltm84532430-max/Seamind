import { useEffect, useRef, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
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
  TerminalSessionView,
  type TerminalSessionViewHandle,
} from './TerminalSessionView';
import type {
  TerminalTab,
  TerminalShellType,
  TerminalShellOption,
  SplitLayoutMode,
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
import './terminal-workspace.css';

interface TerminalWorkspaceProps {
  active: boolean;
  cwd: string;
  theme: Theme;
  books?: EpubBookDocument[];
  onOpenBook?: (book: EpubBookDocument) => void;
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

export default function TerminalWorkspace({
  active,
  cwd,
  theme,
  books = [],
  onOpenBook,
}: TerminalWorkspaceProps) {
  const [shells, setShells] = useState<TerminalShellOption[]>(DEFAULT_SHELLS);
  const [tabs, setTabs] = useState<TerminalTab[]>([
    {
      id: 'tab-1',
      title: 'PowerShell 1',
      shell: 'powershell',
      cwd,
      status: 'starting',
      createdAt: Date.now(),
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');
  const [secondaryTabId, setSecondaryTabId] = useState<string>('tab-1');
  const [splitMode, setSplitMode] = useState<SplitLayoutMode>('single');
  const [splitRatio, setSplitRatio] = useState<number>(0.5);
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
  const [showShellMenu, setShowShellMenu] = useState<boolean>(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>('');

  const terminalRefs = useRef<Map<string, TerminalSessionViewHandle>>(
    new Map(),
  );
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const shellMenuRef = useRef<HTMLDivElement>(null);
  const commandSearchRef = useRef<HTMLInputElement>(null);
  const commandPanelRef = useRef<HTMLDivElement>(null);
  const knowledgeSearchRef = useRef<HTMLInputElement>(null);
  const knowledgePanelRef = useRef<HTMLDivElement>(null);

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

  // Detect available shells from Tauri backend
  useEffect(() => {
    if (!active) return;
    invoke<TerminalShellOption[]>('terminal_detect_shells')
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
      // 上次打开的工具仍可在当前进程中使用。
    }
  }, [drawerTab]);

  useEffect(() => {
    if (!showShellMenu && !toolsMenuOpen) return;
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
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [showShellMenu, toolsMenuOpen]);

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
        setActiveTabId(tab.id);
        setShowShellMenu(false);
        setToolsMenuOpen(false);
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
    activeTabId,
    drawerOpen,
    drawerPinned,
    drawerTab,
    editingTabId,
    pendingCommand,
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

  const addTab = (shell: TerminalShellType = 'powershell') => {
    if (tabs.length >= MAX_WORKSPACE_TABS) return;
    const nextIndex = tabs.length + 1;
    const shellDef = shells.find((s) => s.id === shell);
    const title = `${shellDef?.name ?? shell.toUpperCase()} ${nextIndex}`;
    const newTab: TerminalTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      shell,
      cwd,
      status: 'starting',
      createdAt: Date.now(),
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
    if (splitMode !== 'single' && tabs.length === 1) {
      setSecondaryTabId(newTab.id);
    }
    setShowShellMenu(false);
  };

  const closeTab = (tabId: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (tabs.length <= 1) return; // Keep at least one tab
    const nextTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(nextTabs);
    if (activeTabId === tabId) {
      setActiveTabId(nextTabs[0]?.id ?? '');
    }
    if (secondaryTabId === tabId) {
      setSecondaryTabId(nextTabs[0]?.id ?? '');
    }
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
      // 只保存内置卡片 ID，不落盘保存终端命令或用户输入，避免记录凭据。
      localStorage.setItem(
        COMMAND_FAVORITES_KEY,
        JSON.stringify(favoriteCommandIds),
      );
    } catch {
      // 收藏状态仍可在当前进程中使用。
    }
  }, [favoriteCommandIds]);

  useEffect(() => {
    try {
      localStorage.setItem(
        COMMAND_RECENTS_KEY,
        JSON.stringify(recentCommandIds),
      );
    } catch {
      // 最近使用记录仍可在当前进程中使用。
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
        cwd: activeTab?.cwd ?? cwd,
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

  return (
    <main className="terminal-workspace" aria-label="终端与系统实验工作区">
      {/* 1. Header Toolbar */}
      <header className="terminal-workspace-header">
        <div className="terminal-header-actions">
          {/* 分屏切换按钮 */}
          <div className="terminal-split-selector" aria-label="分屏布局切换">
            <button
              type="button"
              className={`split-btn ${splitMode === 'single' ? 'is-active' : ''}`}
              onClick={() => setSplitMode('single')}
              title="单窗格显示"
            >
              单屏
            </button>
            <button
              type="button"
              className={`split-btn ${splitMode === 'vertical' ? 'is-active' : ''}`}
              onClick={() => {
                setSplitMode('vertical');
                if (tabs.length > 1 && secondaryTabId === activeTabId) {
                  const alt = tabs.find((t) => t.id !== activeTabId);
                  if (alt) setSecondaryTabId(alt.id);
                }
              }}
              title="左右分屏对照"
            >
              左右
            </button>
            <button
              type="button"
              className={`split-btn ${splitMode === 'horizontal' ? 'is-active' : ''}`}
              onClick={() => {
                setSplitMode('horizontal');
                if (tabs.length > 1 && secondaryTabId === activeTabId) {
                  const alt = tabs.find((t) => t.id !== activeTabId);
                  if (alt) setSecondaryTabId(alt.id);
                }
              }}
              title="上下分屏对照"
            >
              上下
            </button>
          </div>

          <div className="terminal-tools-container" ref={toolsMenuRef}>
            <button
              type="button"
              className={`terminal-tools-btn ${drawerOpen || toolsMenuOpen ? 'is-active' : ''}`}
              aria-expanded={toolsMenuOpen}
              aria-haspopup="menu"
              onClick={() => {
                setToolsMenuOpen((open) => !open);
                setShowShellMenu(false);
              }}
              title={`打开命令库或知识修正（${COMMAND_LIBRARY_SHORTCUT_LABEL} 打开命令库）`}
              aria-keyshortcuts="Control+Shift+L"
            >
              工具
            </button>
            {toolsMenuOpen && (
              <div className="terminal-tools-menu" role="menu">
                {TERMINAL_TOOLS.map((tool) => {
                  const selected = drawerOpen && drawerTab === tool.id;
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={`terminal-tools-option ${selected ? 'is-active' : ''}`}
                      onClick={() => applyTool(tool.id)}
                    >
                      {tool.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* 2. Multi-Tab Navigation Bar */}
      <nav className="terminal-tab-bar" aria-label="终端会话标签栏">
        <div className="terminal-tabs-track">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            const isEditing = editingTabId === tab.id;
            return (
              <div
                key={tab.id}
                className={`terminal-tab-item ${isActive ? 'is-active' : ''}`}
                onClick={() => setActiveTabId(tab.id)}
                onDoubleClick={() => startRenameTab(tab)}
                role="tab"
                aria-selected={isActive}
              >
                <span className="tab-shell-tag">{tab.shell.toUpperCase()}</span>
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
        </div>

        {/* 新建标签菜单 */}
        <div className="terminal-new-tab-container" ref={shellMenuRef}>
          <button
            type="button"
            className="terminal-new-tab-btn"
            onClick={() => {
              setShowShellMenu((prev) => !prev);
              setToolsMenuOpen(false);
            }}
            disabled={tabs.length >= MAX_WORKSPACE_TABS}
            aria-expanded={showShellMenu}
            title="新建终端会话"
          >
            + 新建终端
          </button>

          {showShellMenu && (
            <div className="terminal-shell-menu">
              <div className="shell-menu-header">选择会话环境</div>
              {tabs.length >= MAX_WORKSPACE_TABS && (
                <div className="shell-menu-limit">
                  当前工作区已达到 {MAX_WORKSPACE_TABS}{' '}
                  个会话上限，请先关闭一个标签。
                </div>
              )}
              {shells.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`shell-menu-option ${opt.available ? '' : 'is-unavailable'}`}
                  disabled={!opt.available || tabs.length >= MAX_WORKSPACE_TABS}
                  onClick={() => addTab(opt.id)}
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
              <p className="shell-menu-install">
                安装 WSL：在终端运行 <code>wsl --install</code>
              </p>
            </div>
          )}
        </div>
      </nav>

      {/* 3. Center Workspace Body (Split Stage + Right Drawer) */}
      <div className="terminal-workspace-body">
        {/* 中央主舞台：支持单屏与多分屏 */}
        {/* 每个标签只挂载一个 xterm；切换分屏只改变网格区域，不重建 PTY。 */}
        <section
          className={`terminal-stage-panes is-${splitMode}`}
          aria-label="终端画布"
          style={
            {
              '--primary-pane-size': `${splitRatio}fr`,
              '--secondary-pane-size': `${1 - splitRatio}fr`,
            } as React.CSSProperties
          }
        >
          <div className="pane-header pane-header-primary">
            <span className="pane-label">
              {splitMode === 'single' ? '当前会话' : '窗格 A'}
            </span>
            <select
              className="pane-tab-select"
              value={activeTabId}
              onChange={(event) => setActiveTabId(event.target.value)}
              aria-label="窗格 A 关联会话"
            >
              {tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  [{tab.shell.toUpperCase()}] {tab.title} ·{' '}
                  {tab.status === 'ready'
                    ? '就绪'
                    : tab.status === 'starting'
                      ? '启动中'
                      : tab.status === 'exited'
                        ? '已退出'
                        : '错误'}
                </option>
              ))}
            </select>
          </div>

          {splitMode !== 'single' && (
            <div className="pane-header pane-header-secondary">
              <span className="pane-label">窗格 B</span>
              <select
                className="pane-tab-select"
                value={secondaryTabId}
                onChange={(event) => setSecondaryTabId(event.target.value)}
                aria-label="窗格 B 关联会话"
              >
                {tabs.map((tab) => (
                  <option key={tab.id} value={tab.id}>
                    [{tab.shell.toUpperCase()}] {tab.title}
                  </option>
                ))}
              </select>
            </div>
          )}

          {splitMode !== 'single' && (
            <div
              className="terminal-pane-divider"
              role="separator"
              aria-orientation={
                splitMode === 'vertical' ? 'vertical' : 'horizontal'
              }
              onPointerDown={(event) => {
                const container = event.currentTarget.parentElement;
                if (!container) return;
                const rect = container.getBoundingClientRect();
                const isVertical = splitMode === 'vertical';
                const onPointerMove = (moveEvent: PointerEvent) => {
                  const ratio = isVertical
                    ? (moveEvent.clientX - rect.left) / rect.width
                    : (moveEvent.clientY - rect.top - 60) /
                      Math.max(1, rect.height - 65);
                  setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)));
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

          {tabs.map((tab) => (
            <TerminalSessionView
              key={tab.id}
              ref={(instance) => {
                if (instance) terminalRefs.current.set(tab.id, instance);
                else terminalRefs.current.delete(tab.id);
              }}
              tab={tab}
              theme={theme}
              style={{
                gridArea: tab.id === activeTabId ? 'primary' : 'secondary',
              }}
              active={
                active &&
                (tab.id === activeTabId ||
                  (splitMode !== 'single' &&
                    tab.id === secondaryTabId &&
                    tab.id !== activeTabId))
              }
              onStatusChange={(status, message) => {
                setTabs((previous) =>
                  previous.map((item) =>
                    item.id === tab.id
                      ? { ...item, status, statusMessage: message }
                      : item,
                  ),
                );
              }}
            />
          ))}

          {splitMode !== 'single' && activeTabId === secondaryTabId && (
            <div
              className="terminal-pane-empty"
              style={{ gridArea: 'secondary' }}
            >
              选择另一个会话以打开第二个窗格
            </div>
          )}
        </section>
        {/* 4. Right Collapsible Drawer: Linux 实操与跨界面知识联动 */}
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
                    当前环境：
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
                              ? '填入当前终端，不回车'
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
                                      : '在当前终端运行'
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
                                      onClick={() => addTab(shell.id)}
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
                    当前环境：
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
                              ? '填入当前终端，不回车'
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
                                    title="填入当前终端，不回车"
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
                                        : '在当前终端运行'
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
                                      onClick={() => addTab(shell.id)}
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
