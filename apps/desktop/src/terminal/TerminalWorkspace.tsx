import { useEffect, useRef, useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Theme } from '../app/app-storage';
import type { EpubBookDocument } from '../library/library';
import {
  LINUX_CHEAT_ITEMS,
  KNOWLEDGE_ACTION_ITEMS,
} from './terminal-cheatsheet';
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

function getCheatCommand(
  item: (typeof LINUX_CHEAT_ITEMS)[number],
  shell: TerminalShellType,
) {
  return (
    item.commandByShell?.[shell] ??
    (shell === 'bash' || shell === 'wsl' ? item.cmd : undefined)
  );
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
  const [drawerOpen, setDrawerOpen] = useState<boolean>(true);
  const [drawerTab, setDrawerTab] = useState<'linux' | 'knowledge' | 'env'>(
    'linux',
  );
  const [linuxFilter, setLinuxFilter] = useState<string>('all');
  const [commandQuery, setCommandQuery] = useState('');
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
  const filteredLinuxCheats = useMemo(() => {
    const query = commandQuery.trim().toLocaleLowerCase();
    return LINUX_CHEAT_ITEMS.filter((item) => {
      const command = getCheatCommand(item, activeShell);
      if (!command) return false;
      if (linuxFilter !== 'all' && item.category !== linuxFilter) return false;
      if (commandView === 'favorites' && !favoriteCommandIds.includes(item.id))
        return false;
      if (commandView === 'recent' && !recentCommandIds.includes(item.id))
        return false;
      return (
        !query ||
        [item.title, item.explanation, item.practicalScenario, command].some(
          (value) => value.toLocaleLowerCase().includes(query),
        )
      );
    }).sort((left, right) => {
      if (commandView !== 'recent') return 0;
      return (
        recentCommandIds.indexOf(left.id) - recentCommandIds.indexOf(right.id)
      );
    });
  }, [
    activeShell,
    commandQuery,
    commandView,
    favoriteCommandIds,
    linuxFilter,
    recentCommandIds,
  ]);

  const availableKnowledgeActions = KNOWLEDGE_ACTION_ITEMS.filter(
    (item) => item.commandByShell?.[activeShell],
  );

  const relatedBooks = useMemo(() => {
    return books.filter((b) =>
      /linux|unix|c primer|system|bash|network|tcp|hacker/i.test(b.title),
    );
  }, [books]);

  return (
    <main className="terminal-workspace" aria-label="终端与系统实验工作区">
      {/* 1. Header Toolbar */}
      <header className="terminal-workspace-header">
        <div className="terminal-workspace-brand">
          <span className="terminal-brand-badge">TERMINAL HUB</span>
          <h1 className="terminal-brand-title">终端与系统实验</h1>
          <span className="terminal-brand-sub">
            多会话 PTY · Linux 原生环境 · 跨界面知识修正中枢
          </span>
        </div>

        {/* 顶部遥测胶囊 */}
        <div className="terminal-telemetry-capsules">
          <div className="telemetry-pill">
            <span className="pill-label">会话并发</span>
            <strong className="pill-value">{tabs.length}</strong>
          </div>
          <div className="telemetry-pill">
            <span className="pill-label">活动环境</span>
            <strong className="pill-value">
              {activeTab?.shell.toUpperCase()}
            </strong>
          </div>
          <div className="telemetry-pill">
            <span className="pill-label">分屏布局</span>
            <strong className="pill-value">
              {splitMode === 'single'
                ? '单窗格'
                : splitMode === 'vertical'
                  ? '左右分屏'
                  : '上下分屏'}
            </strong>
          </div>
        </div>

        {/* 右侧工具操作组 */}
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

          {/* 抽屉折叠切换 */}
          <button
            type="button"
            className={`terminal-drawer-toggle ${drawerOpen ? 'is-active' : ''}`}
            onClick={() => setDrawerOpen((prev) => !prev)}
            title="展开/收起 Linux 实验与知识联动抽屉"
          >
            {drawerOpen ? '收起抽屉' : '知识与实验抽屉'}
          </button>
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
                <span className="tab-index-hint">{`Alt+${index + 1}`}</span>
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
        <div className="terminal-new-tab-container">
          <button
            type="button"
            className="terminal-new-tab-btn"
            onClick={() => setShowShellMenu((prev) => !prev)}
            disabled={tabs.length >= MAX_WORKSPACE_TABS}
            title="新建终端会话"
          >
            + 新建终端
          </button>

          {showShellMenu && (
            <div
              className="terminal-shell-menu"
              onMouseLeave={() => setShowShellMenu(false)}
            >
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
                  </div>
                  <span className="option-desc">{opt.description}</span>
                </button>
              ))}
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
            {/* 抽屉分段控制 */}
            <div className="drawer-segmented-tabs">
              <button
                type="button"
                className={`drawer-tab-btn ${drawerTab === 'linux' ? 'is-active' : ''}`}
                onClick={() => setDrawerTab('linux')}
              >
                命令库
              </button>
              <button
                type="button"
                className={`drawer-tab-btn ${drawerTab === 'knowledge' ? 'is-active' : ''}`}
                onClick={() => setDrawerTab('knowledge')}
              >
                知识修正
              </button>
              <button
                type="button"
                className={`drawer-tab-btn ${drawerTab === 'env' ? 'is-active' : ''}`}
                onClick={() => setDrawerTab('env')}
              >
                环境矩阵
              </button>
            </div>

            {/* TAB 1: 按当前 Shell 过滤的命令卡片 */}
            {drawerTab === 'linux' && (
              <div className="drawer-panel-scroll">
                <div className="command-library-toolbar">
                  <input
                    className="command-search"
                    type="search"
                    value={commandQuery}
                    onChange={(event) => setCommandQuery(event.target.value)}
                    placeholder="搜索命令、用途或场景"
                    aria-label="搜索终端命令卡片"
                  />
                  <div
                    className="command-view-switch"
                    aria-label="命令卡片筛选"
                  >
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
                  </div>
                </div>
                <div className="drawer-filter-bar">
                  {[
                    ['all', '全部'],
                    ['fs', '文件权限'],
                    ['text', '三剑客'],
                    ['proc', '进程'],
                    ['net', '网络'],
                    ['sys', '系统'],
                  ].map(([val, label]) => (
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

                <div className="drawer-cards-stack">
                  {filteredLinuxCheats.map((item) => {
                    const command = getCheatCommand(item, activeShell);
                    if (!command) return null;
                    return (
                      <article key={item.id} className="cheat-card">
                        <div className="cheat-card-top">
                          <span className="cheat-badge">
                            [{item.category.toUpperCase()}]
                          </span>
                          <h4 className="cheat-title">{item.title}</h4>
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
                        <p className="cheat-expl">{item.explanation}</p>
                        <pre className="cheat-code-box">
                          <code>{command}</code>
                        </pre>
                        <div className="cheat-scenario">
                          <span className="scenario-label">实战场景:</span>
                          <span>{item.practicalScenario}</span>
                        </div>
                        <div className="cheat-actions">
                          <button
                            type="button"
                            className="cheat-btn-fill"
                            disabled={activeTab?.status !== 'ready'}
                            onClick={() => {
                              rememberCommand(item.id);
                              sendCommandToActive(command, false);
                            }}
                            title="将命令写入终端输入区但不立即回车"
                          >
                            填入终端
                          </button>
                          <button
                            type="button"
                            className="cheat-btn-run"
                            disabled={activeTab?.status !== 'ready'}
                            onClick={() =>
                              runOrConfirmCommand(
                                item.title,
                                command,
                                Boolean(item.requiresConfirmation),
                                item.id,
                              )
                            }
                            title="直接发送命令并在终端执行"
                          >
                            执行命令
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
                {filteredLinuxCheats.length === 0 && (
                  <div className="command-empty-state">
                    当前 Shell 没有匹配的命令卡片。可切换到 PowerShell、Git Bash
                    或 WSL，或修改搜索条件。
                  </div>
                )}

                {relatedBooks.length > 0 && (
                  <div className="drawer-related-books">
                    <div className="related-books-header">
                      书架关联 Linux / C 读物
                    </div>
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

            {/* TAB 2: 跨界面知识修正中枢 */}
            {drawerTab === 'knowledge' && (
              <div className="drawer-panel-scroll">
                <div className="drawer-intro-card">
                  <h4>跨界面知识修正机制</h4>
                  <p>
                    在当前终端可直接使用 <code>Add-Content</code>、Python
                    脚本或注入了 Seamind MCP 的 <code>agy</code> /{' '}
                    <code>claude</code> / <code>codex</code> 对知识库 Markdown
                    笔记、思维导图骨架及电子书笔记实施自动化校准。
                  </p>
                </div>

                <div className="drawer-cards-stack">
                  {availableKnowledgeActions.map((item) => {
                    const command = item.commandByShell?.[activeShell];
                    if (!command) return null;
                    return (
                      <article key={item.id} className="knowledge-action-card">
                        <div className="action-card-header">
                          <span className="action-badge">
                            [{item.categoryBadge}]
                          </span>
                          <span className="action-target">
                            联动 {item.targetWorkspace}
                          </span>
                        </div>
                        <h4 className="action-title">{item.title}</h4>
                        <p className="action-desc">{item.description}</p>
                        <pre className="action-code-box">
                          <code>{command}</code>
                        </pre>
                        <div className="action-footer">
                          <button
                            type="button"
                            className="action-fill-btn"
                            disabled={activeTab?.status !== 'ready'}
                            onClick={() => {
                              rememberCommand(item.id);
                              sendCommandToActive(command, false);
                            }}
                          >
                            填入终端
                          </button>
                          <button
                            type="button"
                            className="action-run-btn"
                            disabled={activeTab?.status !== 'ready'}
                            onClick={() =>
                              runOrConfirmCommand(
                                item.title,
                                command,
                                Boolean(item.requiresConfirmation),
                                item.id,
                              )
                            }
                          >
                            运行修正
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            {/* TAB 3: 本机 Shell 环境矩阵 */}
            {drawerTab === 'env' && (
              <div className="drawer-panel-scroll">
                <div className="env-matrix-list">
                  {shells.map((sh) => (
                    <div
                      key={sh.id}
                      className={`env-card ${sh.available ? 'is-online' : 'is-offline'}`}
                    >
                      <div className="env-card-header">
                        <span className="env-badge">[{sh.badge}]</span>
                        <strong className="env-name">{sh.name}</strong>
                        <span
                          className={`env-status-pill ${sh.available ? 'ok' : 'fail'}`}
                        >
                          {sh.available ? '已检测就绪' : '未检测到'}
                        </span>
                      </div>
                      <p className="env-desc">{sh.description}</p>
                      {sh.available && (
                        <button
                          type="button"
                          className="env-spawn-btn"
                          onClick={() => addTab(sh.id)}
                        >
                          以此环境新建标签
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <div className="env-tips-card">
                  <h4>WSL 原生 Linux 接入提示</h4>
                  <p>
                    在 Windows 终端中运行 <code>wsl --install</code>{' '}
                    即可快速获取 Ubuntu 环境。
                    安装完成后，本板块将自动识别并提供原生 Linux
                    终端环境进行实操。
                  </p>
                </div>
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
