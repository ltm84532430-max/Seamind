import { memo, useState } from 'react';
import type { ActiveWorkspace } from '../../app/app-storage';
import {
  BookIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FileTextIcon,
  FlaskIcon,
  PlusIcon,
} from '../agent/AgentIcons';
import { normalizeDisplayPath } from '../terminal-alacritty';
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
    desc: '左侧编写 SQL/PY/R，右侧协作分析与修改',
    primary: 'lab',
    secondary: 'agent',
  },
  {
    id: 'reader-agent',
    label: '电子书 + Agent',
    desc: '左侧阅读原著章节，右侧推导答疑',
    primary: 'reader',
    secondary: 'agent',
  },
  {
    id: 'paper-agent',
    label: '论文 + Agent',
    desc: '左侧精读论文，右侧提炼笔记与验证脚本',
    primary: 'literature',
    secondary: 'agent',
  },
  {
    id: 'shell-agent',
    label: '终端 + Agent',
    desc: '左侧命令行执行，右侧诊断报错与修复',
    primary: 'terminal',
    secondary: 'agent',
  },
];

export interface AgentWorkspaceResources {
  cwd?: string;
  books: Array<{ title: string }>;
  documents: Array<{ title: string }>;
  dataFiles: Array<{ alias: string; format: string }>;
  dbConnections: Array<{
    name: string;
    dbType: string;
    database?: string;
    readOnly?: boolean;
    tables?: Array<{
      name: string;
      schema?: string | null;
      estimatedRows?: number | null;
    }>;
  }>;
  labNotebooks: Array<{ id: string; title: string; language: string }>;
  activeDocumentTitle?: string | null;
  activeMindmapTitle?: string | null;
}

export interface AgentWorkspaceSidebarProps {
  agentTabs: TerminalTab[];
  activeTabId: string;
  workspaceResources?: AgentWorkspaceResources;
  onCreateAgentTab: () => void;
  onSelectTab: (tabId: string) => void;
  onSendPrompt: (prompt: string) => void;
  onAttachContext?: (token: string) => void;
  onOpenModelModal: () => void;
  onOpenSplitPair?: (
    primary: ActiveWorkspace,
    secondary: ActiveWorkspace,
  ) => void;
}

type ResourceSectionKey = 'books' | 'data' | 'lab' | 'knowledge';

function toSafeMentionArg(raw: string): string {
  return raw.trim().replace(/\s+/g, '_').slice(0, 28);
}

export const AgentWorkspaceSidebar = memo(function AgentWorkspaceSidebar({
  agentTabs,
  activeTabId,
  workspaceResources,
  onCreateAgentTab,
  onSelectTab,
  onSendPrompt,
  onAttachContext,
  onOpenModelModal,
  onOpenSplitPair,
}: AgentWorkspaceSidebarProps) {
  const [openSections, setOpenSections] = useState<
    Record<ResourceSectionKey, boolean>
  >({
    books: false,
    data: true,
    lab: false,
    knowledge: false,
  });

  const toggleSection = (key: ResourceSectionKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleAttach = (token: string) => {
    if (onAttachContext) onAttachContext(token);
    else onSendPrompt(token);
  };

  const displayCwd = workspaceResources?.cwd
    ? normalizeDisplayPath(workspaceResources.cwd)
    : null;

  const dataCount =
    (workspaceResources?.dataFiles.length ?? 0) +
    (workspaceResources?.dbConnections.length ?? 0);

  return (
    <div className="terminal-rail-section ag-workspace-rail">
      {/* SessionList */}
      <div className="terminal-rail-group-head">
        <span>会话 ({agentTabs.length})</span>
        <button
          type="button"
          className="terminal-rail-mini-btn is-accent"
          onClick={onCreateAgentTab}
          title="新建 Agent 研究会话"
        >
          + 新会话
        </button>
      </div>

      <div className="terminal-rail-session-list" role="list">
        {agentTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`terminal-rail-session-item ag-rail-session${t.id === activeTabId ? ' is-active' : ''}`}
            onClick={() => onSelectTab(t.id)}
            title={t.statusMessage || t.title}
          >
            <span
              className={`ag-rail-session-dot is-${t.status}`}
              aria-hidden="true"
            />
            <span className="terminal-rail-session-name">{t.title}</span>
            {t.status === 'starting' && (
              <span className="ag-rail-session-state">运行中</span>
            )}
            {t.status === 'error' && (
              <span className="ag-rail-session-state is-error">异常</span>
            )}
          </button>
        ))}
      </div>

      {/* ResourceNavigator: Books / Data / Lab / Knowledge */}
      {workspaceResources && (
        <div
          className="ag-rail-resources"
          aria-label="工作区资源导航（点击挂载到输入区）"
        >
          <div className="terminal-rail-group-label">工作区资源</div>
          {displayCwd && (
            <div className="ag-rail-meta-path" title={workspaceResources.cwd}>
              {displayCwd}
            </div>
          )}

          {/* Books */}
          <div className="ag-rail-res-group">
            <button
              type="button"
              className="ag-rail-res-head"
              onClick={() => toggleSection('books')}
              aria-expanded={openSections.books}
            >
              {openSections.books ? (
                <ChevronDownIcon size={12} />
              ) : (
                <ChevronRightIcon size={12} />
              )}
              <BookIcon size={13} />
              <span>Books</span>
              <span className="ag-rail-res-count">
                {workspaceResources.books.length}
              </span>
            </button>
            {openSections.books && (
              <div className="ag-rail-res-list">
                <button
                  type="button"
                  className="ag-rail-res-item"
                  onClick={() => handleAttach('#chapter')}
                  title="挂载阅读器当前章节 (#chapter)"
                >
                  <PlusIcon size={11} />
                  <span>#chapter 当前阅读章节</span>
                </button>
                {workspaceResources.books.slice(0, 6).map((book) => (
                  <button
                    key={book.title}
                    type="button"
                    className="ag-rail-res-item"
                    onClick={() =>
                      handleAttach(`#book:${toSafeMentionArg(book.title)}`)
                    }
                    title={`挂载《${book.title}》到输入框`}
                  >
                    <PlusIcon size={11} />
                    <span>{book.title}</span>
                  </button>
                ))}
                {workspaceResources.books.length === 0 && (
                  <span className="ag-rail-res-empty">暂无本地书籍</span>
                )}
              </div>
            )}
          </div>

          {/* Data */}
          <div className="ag-rail-res-group">
            <button
              type="button"
              className="ag-rail-res-head"
              onClick={() => toggleSection('data')}
              aria-expanded={openSections.data}
            >
              {openSections.data ? (
                <ChevronDownIcon size={12} />
              ) : (
                <ChevronRightIcon size={12} />
              )}
              <DatabaseIcon size={13} />
              <span>Data</span>
              <span className="ag-rail-res-count">{dataCount}</span>
            </button>
            {openSections.data && (
              <div className="ag-rail-res-list">
                <button
                  type="button"
                  className="ag-rail-res-item"
                  onClick={() => handleAttach('#data')}
                  title="挂载全部已挂载数据与连接 (#data)"
                >
                  <PlusIcon size={11} />
                  <span>#data 全部挂载数据源</span>
                </button>
                {workspaceResources.dataFiles.slice(0, 5).map((f) => (
                  <button
                    key={f.alias}
                    type="button"
                    className="ag-rail-res-item"
                    onClick={() => handleAttach('#data')}
                    title={`挂载数据文件 ${f.alias} (${f.format.toUpperCase()})`}
                  >
                    <PlusIcon size={11} />
                    <span>
                      {f.alias} ({f.format.toUpperCase()})
                    </span>
                  </button>
                ))}
                {workspaceResources.dbConnections.slice(0, 6).map((db) => (
                  <div key={db.name} className="ag-rail-db-group">
                    <button
                      type="button"
                      className="ag-rail-res-item"
                      onClick={() => handleAttach('#data')}
                      title={`挂载数据库 ${db.name} (${db.dbType.toUpperCase()}${db.readOnly === false ? ' · 读写' : ' · 只读'})`}
                    >
                      <PlusIcon size={11} />
                      <span>
                        {db.name} ({db.dbType.toUpperCase()}
                        {db.readOnly === false ? '' : '·只读'})
                      </span>
                    </button>
                    {db.tables && db.tables.length > 0 && (
                      <div className="ag-rail-db-tables">
                        {db.tables.slice(0, 4).map((tbl) => {
                          const fq =
                            tbl.schema && tbl.schema !== 'main'
                              ? `${tbl.schema}.${tbl.name}`
                              : tbl.name;
                          return (
                            <button
                              key={`${db.name}:${fq}`}
                              type="button"
                              className="ag-rail-res-item is-nested"
                              onClick={() =>
                                onSendPrompt(
                                  `#data 请使用 datalab_profile_table 剖析数据库「${db.name}」中的 ${fq} 表结构、字段分布与样本数据，并给出研究建议。`,
                                )
                              }
                              title={`点击让 Agent 立即只读剖析 ${fq}`}
                            >
                              <span>{fq}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Lab */}
          <div className="ag-rail-res-group">
            <button
              type="button"
              className="ag-rail-res-head"
              onClick={() => toggleSection('lab')}
              aria-expanded={openSections.lab}
            >
              {openSections.lab ? (
                <ChevronDownIcon size={12} />
              ) : (
                <ChevronRightIcon size={12} />
              )}
              <FlaskIcon size={13} />
              <span>Lab</span>
              <span className="ag-rail-res-count">
                {workspaceResources.labNotebooks.length}
              </span>
            </button>
            {openSections.lab && (
              <div className="ag-rail-res-list">
                <button
                  type="button"
                  className="ag-rail-res-item"
                  onClick={() => handleAttach('#lab')}
                  title="挂载当前实验本单元格 (#lab)"
                >
                  <PlusIcon size={11} />
                  <span>#lab 当前实验本</span>
                </button>
                <button
                  type="button"
                  className="ag-rail-res-item"
                  onClick={() => handleAttach('#env')}
                  title="挂载 Python / R 运行环境 (#env)"
                >
                  <PlusIcon size={11} />
                  <span>#env 本地分析环境</span>
                </button>
                {workspaceResources.labNotebooks.slice(0, 5).map((nb) => (
                  <button
                    key={nb.id}
                    type="button"
                    className="ag-rail-res-item"
                    onClick={() => handleAttach('#lab')}
                    title={`${nb.title} (${nb.language})`}
                  >
                    <PlusIcon size={11} />
                    <span>{nb.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Knowledge */}
          <div className="ag-rail-res-group">
            <button
              type="button"
              className="ag-rail-res-head"
              onClick={() => toggleSection('knowledge')}
              aria-expanded={openSections.knowledge}
            >
              {openSections.knowledge ? (
                <ChevronDownIcon size={12} />
              ) : (
                <ChevronRightIcon size={12} />
              )}
              <FileTextIcon size={13} />
              <span>Knowledge</span>
              <span className="ag-rail-res-count">
                {workspaceResources.documents.length}
              </span>
            </button>
            {openSections.knowledge && (
              <div className="ag-rail-res-list">
                {workspaceResources.activeMindmapTitle && (
                  <button
                    type="button"
                    className="ag-rail-res-item"
                    onClick={() => handleAttach('#map')}
                    title={`挂载当前导图：${workspaceResources.activeMindmapTitle}`}
                  >
                    <PlusIcon size={11} />
                    <span>#map {workspaceResources.activeMindmapTitle}</span>
                  </button>
                )}
                {workspaceResources.documents.slice(0, 6).map((doc) => (
                  <button
                    key={doc.title}
                    type="button"
                    className="ag-rail-res-item"
                    onClick={() =>
                      handleAttach(`#kb:${toSafeMentionArg(doc.title)}`)
                    }
                    title={`挂载知识文档：${doc.title}`}
                  >
                    <PlusIcon size={11} />
                    <span>{doc.title}</span>
                  </button>
                ))}
                {workspaceResources.documents.length === 0 && (
                  <span className="ag-rail-res-empty">暂无知识库笔记</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {onOpenSplitPair && (
        <>
          <div className="terminal-rail-group-label">协同分屏</div>
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

      <div className="terminal-rail-group-label">快捷工具</div>
      <div className="terminal-rail-action-grid is-agent-actions">
        <button
          type="button"
          className="terminal-rail-mini-btn"
          onClick={() => onSendPrompt('/help')}
        >
          /help 速查
        </button>
        <button
          type="button"
          className="terminal-rail-mini-btn"
          onClick={onOpenModelModal}
        >
          Ctrl+M 内核
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
