import { memo } from 'react';
import type { ActiveWorkspace } from '../../app/app-storage';
import type { TerminalTab } from '../terminal-types';

interface QuickSplitPreset {
  id: string;
  label: string;
  desc: string;
  primary: ActiveWorkspace;
  secondary: ActiveWorkspace;
}

const AGENT_SPLIT_PRESETS: readonly QuickSplitPreset[] = [
  {
    id: 'lab-agent',
    label: '编辑器 + Agent',
    desc: '左侧写 SQL/PY/R，右侧实时协作改代码',
    primary: 'lab',
    secondary: 'agent',
  },
  {
    id: 'reader-agent',
    label: '电子书 + Agent',
    desc: '左侧伴读原著，右侧答疑推理',
    primary: 'reader',
    secondary: 'agent',
  },
  {
    id: 'paper-agent',
    label: '论文 + Agent',
    desc: '左侧精读论文，右侧提炼笔记与代码',
    primary: 'literature',
    secondary: 'agent',
  },
  {
    id: 'shell-agent',
    label: '终端 + Agent',
    desc: '左侧命令行运行，右侧自动诊断报错',
    primary: 'terminal',
    secondary: 'agent',
  },
];

export interface AgentWorkspaceSidebarProps {
  agentTabs: TerminalTab[];
  activeTabId: string;
  onCreateAgentTab: () => void;
  onSelectTab: (tabId: string) => void;
  onSendPrompt: (prompt: string) => void;
  onOpenModelModal: () => void;
  onOpenSplitPair?: (
    primary: ActiveWorkspace,
    secondary: ActiveWorkspace,
  ) => void;
}

export const AgentWorkspaceSidebar = memo(function AgentWorkspaceSidebar({
  agentTabs,
  activeTabId,
  onCreateAgentTab,
  onSelectTab,
  onSendPrompt,
  onOpenModelModal,
  onOpenSplitPair,
}: AgentWorkspaceSidebarProps) {
  return (
    <div className="terminal-rail-section">
      <div className="terminal-rail-group-head">
        <span>活跃 Agent 会话 ({agentTabs.length})</span>
        <button
          type="button"
          className="terminal-rail-mini-btn is-accent"
          onClick={onCreateAgentTab}
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
            onClick={() => onSelectTab(t.id)}
          >
            <span className="terminal-rail-session-name">{t.title}</span>
          </button>
        ))}
      </div>

      {onOpenSplitPair && (
        <>
          <div className="terminal-rail-group-label">一键协同分屏</div>
          <div className="terminal-rail-split-presets">
            {AGENT_SPLIT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="terminal-rail-split-chip"
                onClick={() =>
                  onOpenSplitPair(preset.primary, preset.secondary)
                }
                title={preset.desc}
              >
                <strong>{preset.label}</strong>
                <span>{preset.desc}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="terminal-rail-group-label">快捷指令与配置</div>
      <div className="terminal-rail-action-grid is-agent-actions">
        <button
          type="button"
          className="terminal-rail-mini-btn"
          onClick={() => onSendPrompt('/help')}
        >
          /help 指南
        </button>
        <button
          type="button"
          className="terminal-rail-mini-btn"
          onClick={onOpenModelModal}
        >
          Ctrl+M 模型
        </button>
        <button
          type="button"
          className="terminal-rail-mini-btn"
          onClick={() => onSendPrompt('/mcp')}
        >
          /mcp 状态
        </button>
      </div>
    </div>
  );
});
