import { memo } from 'react';
import type {
  TerminalCliPreset,
  TerminalShellOption,
  TerminalTab,
} from '../terminal-types';

export interface CliPresetItem {
  id: TerminalCliPreset;
  label: string;
  desc: string;
}

export interface ShellWorkspaceSidebarProps {
  shellTabs: TerminalTab[];
  activeTabId: string;
  shells: TerminalShellOption[];
  cliPresets: readonly CliPresetItem[];
  tabLimitReached: boolean;
  drawerOpen: boolean;
  onCreateShellTab: (
    shellId: TerminalShellOption['id'],
    cliId?: TerminalCliPreset,
  ) => void;
  onSelectTab: (tabId: string) => void;
  onToggleCommandDrawer: () => void;
}

export const ShellWorkspaceSidebar = memo(function ShellWorkspaceSidebar({
  shellTabs,
  activeTabId,
  shells,
  cliPresets,
  tabLimitReached,
  drawerOpen,
  onCreateShellTab,
  onSelectTab,
  onToggleCommandDrawer,
}: ShellWorkspaceSidebarProps) {
  return (
    <div className="terminal-rail-section">
      <div className="terminal-rail-group-head">
        <span>活跃终端会话 ({shellTabs.length})</span>
        <button
          type="button"
          className="terminal-rail-mini-btn is-accent"
          disabled={tabLimitReached}
          onClick={() => onCreateShellTab('powershell')}
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
              onClick={() => onSelectTab(t.id)}
            >
              <span className="option-badge">{t.shell.toUpperCase()}</span>
              <span className="terminal-rail-session-name">{t.title}</span>
            </button>
          </div>
        ))}
      </div>

      <div className="terminal-rail-group-label">启动 Shell 外壳</div>
      <div className="terminal-rail-action-grid">
        {shells.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className="terminal-rail-mini-btn"
            disabled={!opt.available || tabLimitReached}
            onClick={() => onCreateShellTab(opt.id)}
            title={opt.description}
          >
            + {opt.badge}
          </button>
        ))}
      </div>

      <div className="terminal-rail-group-label">CLI 模型套娃会话 (MCP)</div>
      <div className="terminal-rail-action-grid is-three-col">
        {cliPresets.map((cli) => (
          <button
            key={cli.id}
            type="button"
            className="terminal-rail-mini-btn"
            disabled={tabLimitReached}
            onClick={() => onCreateShellTab('powershell', cli.id)}
            title={cli.desc}
          >
            {cli.label}
          </button>
        ))}
      </div>

      <div className="terminal-rail-group-label">命令速查与知识动作</div>
      <button
        type="button"
        className="terminal-rail-full-btn"
        onClick={onToggleCommandDrawer}
      >
        {drawerOpen ? '收起命令工具抽屉' : '打开命令工具抽屉'}
      </button>
    </div>
  );
});
