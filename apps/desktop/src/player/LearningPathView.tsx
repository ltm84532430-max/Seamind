import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent, WheelEvent } from 'react';
import '../ebook/book-galaxy-view.css';
import type { AgentCapabilities } from '../agent/capabilities';
import { runLearningPathAgentTurn } from '../agent/runtime';
import type {
  AgentCallEvent,
  AgentChatMessage,
  LearningPathProposal,
} from '../agent/types';
import { formatDuration } from './format';
import { usePlayerHost } from './host';
import { CloseIcon, PathTreeIcon } from './icons';
import {
  buildLearningPathStageOverview,
  computeLearningPathLayout,
  learningPathToMarkdown,
} from './learning-path-layout';
import type {
  LearningPathConnectorStyle,
  LearningPathLayoutMode,
  LearningPathTheme,
  PositionedPathNode,
} from './learning-path-layout';
import { errorText, playerApi } from './player-api';
import {
  FAVORITE_CATEGORY_COLORS,
  type FavoritesSnapshot,
  type LearningPathDetail,
  type LearningPathNodeInput,
  type LearningPathNodeKind,
  type VideoInput,
} from './types';
import { extractProposalFromText } from './learning-path-parser';
import LearningPathStarMapView from './LearningPathStarMapView';
import {
  HACKER_CONSTELLATION_PATH_ID,
  HACKER_LEARNING_PATH_PRESET,
} from './learning-path-presets';
import { VideoPickerModal, type VideoPickerItem } from './VideoPickerModal';
import { parseYouTubeTarget, thumbnailUrl } from './video-links';
import { StateMessage } from './VideoList';

const STYLE_STORAGE_KEY = 'seamind:learning-path-style:v1';

interface StoredPathStyle {
  layoutMode: LearningPathLayoutMode;
  theme: LearningPathTheme;
  connectorStyle: LearningPathConnectorStyle;
}

const DEFAULT_STYLE: StoredPathStyle = {
  layoutMode: 'tree',
  theme: 'terracotta',
  connectorStyle: 'curve',
};

const NODE_STATUS_LABEL: Record<PositionedPathNode['status'], string> = {
  completed: '已完成',
  in_progress: '进行中',
  ready: '待学习',
  locked: '待解锁',
};

const NODE_KIND_LABEL: Record<LearningPathNodeKind, string> = {
  stage: '阶段',
  video: '课程',
  checkpoint: '里程碑',
};

function readStoredStyle(): StoredPathStyle {
  try {
    const raw = window.localStorage.getItem(STYLE_STORAGE_KEY);
    if (!raw) return DEFAULT_STYLE;
    const parsed = JSON.parse(raw) as Partial<StoredPathStyle>;
    return {
      layoutMode:
        parsed.layoutMode === 'tree' ||
        parsed.layoutMode === 'metro' ||
        parsed.layoutMode === 'dag' ||
        parsed.layoutMode === 'lanes' ||
        parsed.layoutMode === 'radial'
          ? parsed.layoutMode
          : 'tree',
      theme:
        parsed.theme === 'terracotta' ||
        parsed.theme === 'blueprint' ||
        parsed.theme === 'cyber' ||
        parsed.theme === 'botanical' ||
        parsed.theme === 'minimal'
          ? parsed.theme
          : 'terracotta',
      connectorStyle:
        parsed.connectorStyle === 'curve' ||
        parsed.connectorStyle === 'orthogonal' ||
        parsed.connectorStyle === 'metro'
          ? parsed.connectorStyle
          : 'curve',
    };
  } catch {
    return DEFAULT_STYLE;
  }
}

function saveStoredStyle(style: StoredPathStyle) {
  try {
    window.localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify(style));
  } catch {
    // Ignore storage write errors
  }
}

const THEME_OPTIONS: {
  id: LearningPathTheme;
  label: string;
  swatch: string;
}[] = [
  { id: 'terracotta', label: '赤陶工坊', swatch: '#c8563b' },
  { id: 'blueprint', label: '工程蓝图', swatch: '#3d9cf0' },
  { id: 'cyber', label: '极光拓扑', swatch: '#14b8a6' },
  { id: 'botanical', label: '森系书院', swatch: '#3a6b4c' },
  { id: 'minimal', label: '极简墨线', swatch: '#262626' },
];

export interface LearningPathExternalBridges {
  aiProvider?: { baseUrl: string; model: string } | null;
  agentCapabilities?: AgentCapabilities;
  onSendTerminalCommand?: (text: string, execute?: boolean) => void;
  onPreviewLearningPathProposal?: (
    proposal: LearningPathProposal,
    source: 'ai',
  ) => void;
  onExportMarkdownToMindmap?: (title: string, markdown: string) => void;
}

export function CategoryImportDialog({
  isOpen,
  onClose,
  onSelectCategory,
  title = '从收藏分类导入视频',
  subtitle = '选取一个收藏分类，将其包含的视频组织为知识树阶段与课程',
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelectCategory: (category: { id: string | null; name: string }) => void;
  title?: string;
  subtitle?: string;
}) {
  const [snapshot, setSnapshot] = useState<FavoritesSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    playerApi
      .favoritesSnapshot()
      .then((snap) => setSnapshot(snap))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen]);

  if (!isOpen) return null;

  const uncategorizedCount =
    snapshot?.items.filter((i) => i.categoryId === null).length ?? 0;

  return (
    <div className="lp-proposal-backdrop" role="dialog" aria-modal="true">
      <div className="lp-proposal-modal" style={{ width: 'min(580px, 92vw)' }}>
        <header className="lp-proposal-head">
          <div>
            <span className="lp-proposal-badge">一键生成知识树</span>
            <h3>{title}</h3>
            {subtitle && (
              <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.78 }}>
                {subtitle}
              </p>
            )}
          </div>
          <button type="button" className="lp-icon-btn" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="lp-proposal-body">
          {loading ? (
            <div
              style={{ textAlign: 'center', padding: '30px 0', opacity: 0.7 }}
            >
              正在读取收藏分类…
            </div>
          ) : (
            <div className="lp-cat-import-list">
              <div
                className="lp-cat-import-card"
                onClick={() =>
                  onSelectCategory({ id: null, name: '未分类收藏' })
                }
              >
                <div className="lp-cat-import-card-title">
                  <span
                    className="vpick-cat-dot"
                    style={{ background: 'var(--player-muted)' }}
                  />
                  <span>未分类收藏</span>
                </div>
                <span className="lp-cat-import-card-count">
                  {uncategorizedCount} 个视频 →
                </span>
              </div>

              {(snapshot?.categories ?? []).map((cat) => {
                const count = (snapshot?.items ?? []).filter(
                  (i) => i.categoryId === cat.categoryId,
                ).length;
                const colorMeta = FAVORITE_CATEGORY_COLORS.find(
                  (c) => c.id === cat.color,
                );
                return (
                  <div
                    key={cat.categoryId}
                    className="lp-cat-import-card"
                    onClick={() =>
                      onSelectCategory({ id: cat.categoryId, name: cat.name })
                    }
                  >
                    <div className="lp-cat-import-card-title">
                      <span
                        className="vpick-cat-dot"
                        style={{
                          background: colorMeta?.accent ?? '#df735b',
                        }}
                      />
                      <span>{cat.name}</span>
                    </div>
                    <span className="lp-cat-import-card-count">
                      {count} 个视频 →
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <footer className="lp-proposal-foot">
          <span style={{ fontSize: 12, opacity: 0.72 }}>
            点击任意分类即可自动读取全部视频并建立连贯的学习知识树。
          </span>
          <div className="lp-proposal-foot-actions">
            <button type="button" className="lp-btn" onClick={onClose}>
              取消
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function LearningPathsHomeView({
  bridges,
}: {
  bridges?: LearningPathExternalBridges;
}) {
  const host = usePlayerHost();
  const [creating, setCreating] = useState(false);
  const [categoryImportOpen, setCategoryImportOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [aiTopic, setAiTopic] = useState('');
  const [aiTopologyMode, setAiTopologyMode] = useState<
    'constellation' | 'linear' | 'radial'
  >('constellation');
  const [aiRunning, setAiRunning] = useState(false);
  const [aiStatus, setAiStatus] = useState('');
  const [aiCandidateProposal, setAiCandidateProposal] =
    useState<LearningPathProposal | null>(null);

  const openOrCreateHackerConstellation = async () => {
    if (saving) return;
    const existing = host.learningPaths.find(
      (p) => p.pathId === HACKER_CONSTELLATION_PATH_ID,
    );
    if (existing) {
      host.go({ kind: 'learning-path', pathId: existing.pathId });
      return;
    }
    setSaving(true);
    try {
      const saved = await playerApi.learningPathSave(
        HACKER_LEARNING_PATH_PRESET,
      );
      await host.reloadOverview();
      host.go({ kind: 'learning-path', pathId: saved.summary.pathId });
      host.notify('已生成「黑客与网络安全全链路星图路径」');
    } catch (err) {
      host.notify(errorText(err, '生成黑客星图路径失败'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const createBlankPath = async (event: FormEvent) => {
    event.preventDefault();
    if (!newTitle.trim() || saving) return;
    setSaving(true);
    try {
      const saved = await playerApi.learningPathSave({
        title: newTitle.trim(),
        description: newDesc.trim() || null,
        nodes: [
          {
            nodeId: 'stage-1',
            parentId: null,
            position: 0,
            kind: 'stage',
            title: '第一阶段：入门基础',
            note: '点击卡片右上角 + 添加视频课程节点',
          },
        ],
      });
      await host.reloadOverview();
      setCreating(false);
      setNewTitle('');
      setNewDesc('');
      host.go({ kind: 'learning-path', pathId: saved.summary.pathId });
    } catch (error) {
      host.notify(errorText(error, '创建学习路径失败'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const importCategoryAsPath = async (cat: {
    id: string | null;
    name: string;
  }) => {
    try {
      setSaving(true);
      const snap = await playerApi.favoritesSnapshot();
      const items = snap.items.filter((i) =>
        cat.id === null ? i.categoryId === null : i.categoryId === cat.id,
      );
      if (items.length === 0) {
        host.notify(
          `分类「${cat.name}」中暂无视频，请先在「我的收藏」中添加视频。`,
          'error',
        );
        return;
      }
      const stageTitle = `${cat.name} 核心课程`;
      const nodes: LearningPathNodeInput[] = [
        {
          nodeId: 'stage-1',
          parentId: null,
          position: 0,
          kind: 'stage',
          title: stageTitle,
          note: `从收藏分类「${cat.name}」一键生成`,
        },
        ...items.map((item, idx) => ({
          nodeId: `vid-${idx + 1}`,
          parentId: 'stage-1',
          position: idx + 1,
          kind: 'video' as const,
          title: item.video.title,
          videoId: item.video.videoId,
          startSeconds: 0,
          optional: false,
          note:
            item.note ||
            (item.video.channelName ? `频道：${item.video.channelName}` : null),
        })),
        {
          nodeId: 'checkpoint-finish',
          parentId: null,
          position: items.length + 1,
          kind: 'checkpoint' as const,
          title: `${cat.name} · 知识通关`,
          note: '恭喜学完本分类下的全部视频课程',
        },
      ];
      const saved = await playerApi.learningPathSave({
        title: `${cat.name} · 视频知识树`,
        description: `由收藏分类「${cat.name}」生成，包含 ${items.length} 节视频课程`,
        nodes,
        videos: items.map((i) => ({
          videoId: i.video.videoId,
          title: i.video.title,
          channelName: i.video.channelName,
          channelId: i.video.channelId,
          durationSeconds: i.video.durationSeconds,
        })),
      });
      await host.reloadOverview();
      setCategoryImportOpen(false);
      host.go({ kind: 'learning-path', pathId: saved.summary.pathId });
      host.notify(`已从「${cat.name}」成功创建视频知识树！`);
    } catch (err) {
      host.notify(errorText(err, '创建知识树失败'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const launchCliPrompt = (cli: 'agy' | 'claude' | 'codex') => {
    const topic = aiTopic.trim() || 'Rust 异步与并发系统编程';
    const topologyHint =
      aiTopologyMode === 'constellation'
        ? '星图网状结构（包含 5-7 个并行知识簇 stage、每簇下多节课程视频、并使用 prerequisiteIds 建立跨模块的先修依赖与汇聚里程碑 checkpoint）'
        : aiTopologyMode === 'radial'
          ? '专题中心辐射结构（以核心模块为中心，向外分层展开专题分支与选修卫星节点）'
          : '分阶段从左向右递进的主线结构';
    const prompt = `请使用 Seamind MCP 工具先调用 player_search_youtube 搜索真实的 YouTube 教学视频，围绕「${topic}」规划一条【${topologyHint}】的视频学习路径，并调用 learning_path_propose 提交预览。`;
    const escaped = prompt.replace(/"/g, '\\"');
    const cmd =
      cli === 'agy'
        ? `agy -i "${escaped}"`
        : cli === 'claude'
          ? `claude "${escaped}"`
          : `codex "${escaped}"`;
    bridges?.onSendTerminalCommand?.(cmd, true);
  };

  const runQuickAi = async () => {
    if (!bridges?.aiProvider || !bridges.agentCapabilities) {
      host.notify(
        '请先在顶部「模型设置」中配置 API 地址、模型与密钥，或使用底部 CLI 终端。',
        'error',
      );
      return;
    }
    const topic = aiTopic.trim();
    if (!topic || aiRunning) return;
    setAiRunning(true);
    setAiStatus('正在检索 YouTube 视频并规划知识网络…');
    setAiCandidateProposal(null);
    const topologyInstruction =
      aiTopologyMode === 'constellation'
        ? '请构建一条【星图网状型（Constellation DAG）】学习路径：包含 4-6 个不同的知识领域簇（stage），每个领域簇包含 2-4 节真实视频节点，并通过 prerequisiteIds 构建跨阶段的先修依赖关系与综合里程碑（checkpoint），以及 1-2 节选修拓展节点（optional: true）。'
        : aiTopologyMode === 'radial'
          ? '请构建一条【专题辐射型】学习路径：围绕核心原理模块向外划分多个平行专题阶段（stage）及选修拓展节点（optional: true）。'
          : '请构建一条包含 3-4 个递进阶段与对应视频节点的【进阶主线型】学习路径。';
    try {
      const result = await runLearningPathAgentTurn({
        history: [],
        prompt: `请围绕「${topic}」搜索真实 YouTube 课程视频。${topologyInstruction} 完成后提交预览提案。`,
        provider: bridges.aiProvider,
        capabilities: bridges.agentCapabilities,
        activePathSummary: null,
        onEvent: (ev) => {
          if (ev.kind === 'tool') {
            setAiStatus(`${ev.label}：${ev.summary}`);
          }
        },
      });
      if (result.learningPathProposal) {
        bridges.onPreviewLearningPathProposal?.(
          result.learningPathProposal,
          'ai',
        );
        setAiStatus('已生成路径预览，请在弹窗中确认保存。');
        setAiCandidateProposal(null);
      } else {
        const parsed = extractProposalFromText(topic, result.reply);
        if (parsed) {
          setAiCandidateProposal(parsed);
          setAiStatus(
            'AI 已规划完成！请点击下方「应用此方案并生成知识树」确认写入。',
          );
        } else {
          setAiCandidateProposal(null);
          setAiStatus(result.reply);
        }
      }
    } catch (error) {
      host.notify(errorText(error, 'AI 生成学习路径失败'), 'error');
      setAiStatus('');
    } finally {
      setAiRunning(false);
    }
  };

  return (
    <div className="lp-home">
      <div className="lp-home-hero">
        <div>
          <h2>学习路径 · 视频知识星图与技能树</h2>
          <p>
            支持多模态组织 YouTube 视频课程：全尺寸可交互力导向
            <strong>知识星图</strong>、<strong>径向星环图</strong>、
            <strong>技能拓扑图</strong>、<strong>树状图</strong>与
            <strong>地铁轨道流</strong>。支持在底部终端调用 <code>agy</code> /{' '}
            <code>claude</code> / <code>codex</code> 或内置 AI
            自动构建网状先修图谱。
          </p>
        </div>
        <div className="lp-home-actions">
          <button
            type="button"
            className="lp-btn"
            disabled={saving}
            onClick={() => void openOrCreateHackerConstellation()}
            title="打开或一键生成包含 7 大安全领域簇与 21 节课程的黑客攻防星图"
          >
            黑客安全星图路径
          </button>
          <button
            type="button"
            className="lp-btn"
            onClick={() => bridges?.onSendTerminalCommand?.('', false)}
          >
            打开底部 CLI 终端
          </button>
          <button
            type="button"
            className="lp-btn"
            onClick={() => setCategoryImportOpen(true)}
            title="从现有收藏夹分类一键生成结构化视频知识树"
          >
            从收藏分类创建知识树
          </button>
          <button
            type="button"
            className="lp-btn is-primary"
            onClick={() => setCreating((v) => !v)}
          >
            新建空白路径
          </button>
        </div>
      </div>

      <div
        className="lp-copilot-section"
        style={{ marginTop: 18, padding: '14px 16px' }}
      >
        <div className="lp-topology-mode-bar">
          <h4>快速让 CLI / AI 生成视频学习路径</h4>
          <div
            className="lp-segmented lp-topology-mode-pills"
            role="group"
            aria-label="路径结构形态"
          >
            {(
              [
                ['constellation', '星图网状型'],
                ['linear', '进阶主线型'],
                ['radial', '专题辐射型'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={aiTopologyMode === mode ? 'is-active' : ''}
                aria-pressed={aiTopologyMode === mode}
                onClick={() => setAiTopologyMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 8,
            alignItems: 'center',
          }}
        >
          <input
            type="text"
            value={aiTopic}
            onChange={(e) => setAiTopic(e.target.value)}
            placeholder="输入想学的主题，例如：3Blue1Brown 线性代数与微积分 / TypeScript 类型体操 / 计算机图形学入门…"
            style={{
              flex: '1 1 320px',
              height: 32,
              padding: '0 10px',
              border: '1px solid var(--player-line-strong)',
              background: 'var(--player-panel)',
              color: 'var(--player-ink)',
              fontSize: 12.5,
            }}
          />
          <button
            type="button"
            className="lp-btn is-primary"
            disabled={!aiTopic.trim() || aiRunning}
            onClick={() => void runQuickAi()}
          >
            {aiRunning ? '规划中…' : '内置 AI 生成预览'}
          </button>
          <button
            type="button"
            className="lp-btn"
            onClick={() => launchCliPrompt('agy')}
            title="唤醒底部终端并用 Google AGY CLI 搜索生成"
          >
            用 AGY CLI 生成
          </button>
          <button
            type="button"
            className="lp-btn"
            onClick={() => launchCliPrompt('claude')}
          >
            用 Claude CLI 生成
          </button>
        </div>
        {aiStatus && (
          <p style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
            {aiStatus}
          </p>
        )}
        {aiCandidateProposal && (
          <div className="lp-proposal-quick-card">
            <div>
              <span className="lp-proposal-badge">检测到 AI 知识规划方案</span>
              <h4>{aiCandidateProposal.input.title}</h4>
              <p>
                包含 {aiCandidateProposal.stageCount} 个阶段，
                {aiCandidateProposal.videoCount} 节视频课程
              </p>
            </div>
            <button
              type="button"
              className="lp-btn is-primary"
              onClick={() => {
                bridges?.onPreviewLearningPathProposal?.(
                  aiCandidateProposal,
                  'ai',
                );
              }}
            >
              应用此方案并生成知识树
            </button>
          </div>
        )}
      </div>

      {creating && (
        <form
          onSubmit={(e) => void createBlankPath(e)}
          className="lp-copilot-section"
          style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          <input
            type="text"
            required
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="路径标题（必填）"
            style={{
              flex: '1 1 200px',
              height: 30,
              padding: '0 9px',
              border: '1px solid var(--player-line-strong)',
              background: 'var(--player-panel)',
              color: 'var(--player-ink)',
            }}
          />
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="学习目标说明（选填）"
            style={{
              flex: '2 1 280px',
              height: 30,
              padding: '0 9px',
              border: '1px solid var(--player-line-strong)',
              background: 'var(--player-panel)',
              color: 'var(--player-ink)',
            }}
          />
          <button type="submit" className="lp-btn is-primary" disabled={saving}>
            创建并打开
          </button>
          <button
            type="button"
            className="lp-btn"
            onClick={() => setCreating(false)}
          >
            取消
          </button>
        </form>
      )}

      <CategoryImportDialog
        isOpen={categoryImportOpen}
        onClose={() => setCategoryImportOpen(false)}
        onSelectCategory={(cat) => void importCategoryAsPath(cat)}
        title="从收藏分类创建知识树"
        subtitle="选取一个分类，将其包含的视频组织为一门结构化的完整知识树"
      />

      {host.learningPaths.length === 0 ? (
        <div style={{ marginTop: 32 }}>
          <StateMessage kind="empty" title="还没有学习路径">
            可以在上方输入主题，点击「用 AGY CLI 生成」或「内置 AI
            生成预览」，也可以手动新建空白路径。
          </StateMessage>
        </div>
      ) : (
        <div className="lp-home-grid">
          {host.learningPaths.map((path) => (
            <button
              key={path.pathId}
              type="button"
              className="lp-home-card"
              onClick={() =>
                host.go({ kind: 'learning-path', pathId: path.pathId })
              }
            >
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    color: 'var(--player-accent)',
                    marginBottom: 6,
                  }}
                >
                  <PathTreeIcon />
                  <span style={{ fontSize: 11, fontWeight: 600 }}>
                    学习路径
                  </span>
                </div>
                <h3>{path.title}</h3>
                {path.description && <p>{path.description}</p>}
              </div>
              <div className="lp-home-card-foot">
                <span>{path.nodeCount} 个节点</span>
                <span>
                  已完成 {path.finishedCount} / {path.videoCount} 课
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface NodeEditorDraft {
  mode: 'add' | 'edit';
  nodeId: string;
  parentId: string;
  kind: LearningPathNodeKind;
  title: string;
  note: string;
  videoLink: string;
  startSeconds: string;
  optional: boolean;
  prerequisiteIdsText: string;
}

export default function LearningPathView({
  pathId,
  reloadToken = 0,
  bridges,
}: {
  pathId: string;
  reloadToken?: number;
  bridges?: LearningPathExternalBridges;
}) {
  const host = usePlayerHost();
  const [detail, setDetail] = useState<LearningPathDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [style, setStyle] = useState<StoredPathStyle>(readStoredStyle);

  const [pan, setPan] = useState({ x: 36, y: 36 });
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  const [canvasMode, setCanvasMode] = useState<
    'constellation' | 'course' | 'overview'
  >('constellation');
  const lastGraphModeRef = useRef<'constellation' | 'course'>('constellation');
  const [starFocusRequest, setStarFocusRequest] = useState<{
    nodeId: string;
    seq: number;
  } | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const dragStartRef = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  const [copilotOpen, setCopilotOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiHistory, setAiHistory] = useState<AgentChatMessage[]>([]);
  const [aiEvents, setAiEvents] = useState<AgentCallEvent[]>([]);
  const [aiReply, setAiReply] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  const [editor, setEditor] = useState<NodeEditorDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [videoPickerState, setVideoPickerState] = useState<{
    isOpen: boolean;
    title?: string;
    subtitle?: string;
    multiple: boolean;
    parentId: string | null;
  }>({
    isOpen: false,
    multiple: true,
    parentId: null,
  });
  const [categoryImportActiveOpen, setCategoryImportActiveOpen] =
    useState(false);
  const [activeAiCandidate, setActiveAiCandidate] =
    useState<LearningPathProposal | null>(null);

  const updateStyle = (patch: Partial<StoredPathStyle>) => {
    setStyle((prev) => {
      const next = { ...prev, ...patch };
      saveStoredStyle(next);
      return next;
    });
  };

  useEffect(() => {
    setPan({ x: 36, y: 36 });
    setScale(1);
    setSelectedNodeId(null);
    setCanvasMode('constellation');
    lastGraphModeRef.current = 'constellation';
  }, [pathId]);

  useEffect(() => {
    // 工具菜单保持单开；点击外部或按 Esc 时收起。
    const closeOutside = (event: PointerEvent) => {
      toolbarRef.current
        ?.querySelectorAll<HTMLDetailsElement>('.lp-menu[open]')
        .forEach((menu) => {
          if (!menu.contains(event.target as Node)) menu.open = false;
        });
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      toolbarRef.current
        ?.querySelectorAll<HTMLDetailsElement>('.lp-menu[open]')
        .forEach((menu) => {
          menu.open = false;
        });
      setDescriptionExpanded(false);
      setSelectedNodeId(null);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, []);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await playerApi.learningPathGet(pathId);
      if (!loaded) {
        setError('找不到这条学习路径，可能已被删除。');
        setDetail(null);
      } else {
        setDetail(loaded);
        setError('');
      }
    } catch (err) {
      setError(errorText(err, '读取学习路径失败'));
    } finally {
      setLoading(false);
    }
  }, [pathId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail, reloadToken]);

  const layout = useMemo(
    () =>
      detail
        ? computeLearningPathLayout(
            detail,
            host.overlay,
            style.layoutMode,
            style.connectorStyle,
          )
        : null,
    [detail, host.overlay, style.layoutMode, style.connectorStyle],
  );

  const stageOverview = useMemo(
    () =>
      detail && layout ? buildLearningPathStageOverview(detail, layout) : [],
    [detail, layout],
  );

  const fitCanvas = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !layout) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const fitX = (rect.width - 72) / layout.width;
    const fitY = (rect.height - 72) / layout.height;
    const nextScale = Math.max(0.45, Math.min(1, Math.min(fitX, fitY)));
    setScale(Number(nextScale.toFixed(2)));
    setPan({
      x: Math.max(24, Math.round((rect.width - layout.width * nextScale) / 2)),
      y: Math.max(
        24,
        Math.round((rect.height - layout.height * nextScale) / 2),
      ),
    });
  }, [layout]);

  const focusNode = useCallback(
    (targetNodeId: string, targetScale = scale) => {
      const targetMode =
        canvasMode === 'overview' ? lastGraphModeRef.current : canvasMode;
      if (targetMode === 'constellation') {
        lastGraphModeRef.current = 'constellation';
        setCanvasMode('constellation');
        setSelectedNodeId(targetNodeId);
        setStarFocusRequest({
          nodeId: targetNodeId,
          seq: Date.now(),
        });
        return;
      }
      const el = viewportRef.current;
      const target = layout?.nodes.find((n) => n.node.nodeId === targetNodeId);
      if (!el || !target) return;
      const rect = el.getBoundingClientRect();
      const nextScale = Math.max(0.65, Math.min(1.15, targetScale));
      const centerX = target.x + target.width / 2;
      const centerY = target.y + target.height / 2;
      lastGraphModeRef.current = 'course';
      setCanvasMode('course');
      setScale(Number(nextScale.toFixed(2)));
      setPan({
        x: Math.round(rect.width * 0.42 - centerX * nextScale),
        y: Math.round(rect.height * 0.46 - centerY * nextScale),
      });
    },
    [canvasMode, layout, scale],
  );

  const selectNode = (targetNodeId: string) => {
    setCopilotOpen(false);
    setSelectedNodeId((prev) => (prev === targetNodeId ? null : targetNodeId));
  };

  const handleNodeKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    currentNodeId: string,
  ) => {
    if (!layout) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectNode(currentNodeId);
      return;
    }
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!delta) return;
    event.preventDefault();
    const index = layout.nodes.findIndex(
      (item) => item.node.nodeId === currentNodeId,
    );
    const next = layout.nodes[index + delta];
    if (!next) return;
    setSelectedNodeId(next.node.nodeId);
    focusNode(next.node.nodeId, scale);
    window.requestAnimationFrame(() => {
      document.getElementById(`lp-select-${next.node.nodeId}`)?.focus();
    });
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (canvasMode !== 'course') return;
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (
      target.closest('.lp-node-card') ||
      target.closest('button') ||
      target.closest('.lp-canvas-dock')
    )
      return;
    setPanning(true);
    dragStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  useEffect(() => {
    if (!panning) return;
    const onMove = (event: globalThis.MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      setPan({
        x: start.panX + (event.clientX - start.x),
        y: start.panY + (event.clientY - start.y),
      });
    };
    const onUp = () => {
      setPanning(false);
      dragStartRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [panning]);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (canvasMode !== 'course') return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.08 : -0.08;
      setScale((prev) =>
        Number(Math.max(0.4, Math.min(1.8, prev + delta)).toFixed(2)),
      );
    } else {
      setPan((prev) => ({
        x: prev.x - event.deltaX,
        y: prev.y - event.deltaY,
      }));
    }
  };

  const queueSource = useMemo(() => {
    if (!detail || !layout) return { title: '学习路径', items: [] };
    return {
      title: detail.summary.title,
      items: layout.orderedPlayableNodes
        .map((n) => n.video)
        .filter((v): v is NonNullable<typeof v> => v !== null),
    };
  }, [detail, layout]);

  const playNode = (positioned: PositionedPathNode) => {
    if (!positioned.video) return;
    const startOverride =
      positioned.node.startSeconds > 0 && !positioned.video.progressSeconds
        ? positioned.node.startSeconds
        : undefined;
    host.openVideo(positioned.video, queueSource, startOverride);
  };

  const openAddNodeModal = (
    parentId: string | null,
    defaultKind?: LearningPathNodeKind,
  ) => {
    const suffix = Math.random().toString(36).slice(2, 7);
    setEditor({
      mode: 'add',
      nodeId: `node-${suffix}`,
      parentId: parentId ?? '',
      kind: defaultKind ?? (parentId ? 'video' : 'stage'),
      title: '',
      note: '',
      videoLink: '',
      startSeconds: '0',
      optional: false,
      prerequisiteIdsText: '',
    });
  };

  const handleVideoPickerConfirm = (selectedVideos: VideoPickerItem[]) => {
    if (editor) {
      const first = selectedVideos[0];
      if (first) {
        setEditor({
          ...editor,
          videoLink: first.videoId,
          title: editor.title.trim() ? editor.title : first.title,
        });
      }
      return;
    }
    void batchAddVideosToStage(videoPickerState.parentId, selectedVideos);
  };

  const batchAddVideosToStage = async (
    targetParentId: string | null,
    videos: VideoPickerItem[],
  ) => {
    if (!detail || videos.length === 0) return;
    setSavingEdit(true);
    try {
      let maxPos = detail.nodes.reduce(
        (acc, n) => Math.max(acc, n.position),
        0,
      );
      const newNodes: LearningPathNodeInput[] = videos.map((v, i) => {
        maxPos += 1;
        const suffix = Math.random().toString(36).slice(2, 6);
        return {
          nodeId: `node-${Date.now().toString(36)}-${suffix}-${i + 1}`,
          parentId: targetParentId,
          position: maxPos,
          kind: 'video',
          title: v.title,
          videoId: v.videoId,
          startSeconds: 0,
          optional: false,
          note: v.channelName ? `频道：${v.channelName}` : null,
        };
      });

      const nextNodes: LearningPathNodeInput[] = [
        ...detail.nodes.map((n) => ({
          nodeId: n.nodeId,
          parentId: n.parentId,
          position: n.position,
          kind: n.kind,
          title: n.title,
          note: n.note,
          videoId: n.videoId,
          startSeconds: n.startSeconds,
          optional: n.optional,
          prerequisiteIds: n.prerequisiteIds,
        })),
        ...newNodes,
      ];

      const newVideoInputs: VideoInput[] = videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        channelName: v.channelName,
        channelId: v.channelId,
        durationSeconds: v.durationSeconds,
      }));

      const updated = await playerApi.learningPathSave({
        pathId: detail.summary.pathId,
        title: detail.summary.title,
        description: detail.summary.description,
        nodes: nextNodes,
        videos: newVideoInputs,
      });

      setDetail(updated);
      host.notify(`已成功添加 ${videos.length} 节课时视频`);
    } catch (err) {
      host.notify(errorText(err, '批量添加视频失败'), 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  const importCategoryIntoActivePath = async (cat: {
    id: string | null;
    name: string;
  }) => {
    if (!detail) return;
    try {
      setSavingEdit(true);
      const snap = await playerApi.favoritesSnapshot();
      const items = snap.items.filter((i) =>
        cat.id === null ? i.categoryId === null : i.categoryId === cat.id,
      );
      if (items.length === 0) {
        host.notify(`分类「${cat.name}」中暂无视频`, 'error');
        return;
      }
      let maxPos = detail.nodes.reduce(
        (acc, n) => Math.max(acc, n.position),
        0,
      );
      const stageNodeId = `stage-${Date.now().toString(36)}`;
      maxPos += 1;
      const stageNode: LearningPathNodeInput = {
        nodeId: stageNodeId,
        parentId: null,
        position: maxPos,
        kind: 'stage',
        title: `${cat.name} 模块`,
        note: `从收藏分类「${cat.name}」导入`,
      };
      const videoNodes: LearningPathNodeInput[] = items.map((item, idx) => {
        maxPos += 1;
        return {
          nodeId: `node-${Date.now().toString(36)}-${idx + 1}`,
          parentId: stageNodeId,
          position: maxPos,
          kind: 'video',
          title: item.video.title,
          videoId: item.video.videoId,
          startSeconds: 0,
          optional: false,
          note:
            item.note ||
            (item.video.channelName ? `频道：${item.video.channelName}` : null),
        };
      });

      const updated = await playerApi.learningPathSave({
        pathId: detail.summary.pathId,
        title: detail.summary.title,
        description: detail.summary.description,
        nodes: [
          ...detail.nodes.map((n) => ({
            nodeId: n.nodeId,
            parentId: n.parentId,
            position: n.position,
            kind: n.kind,
            title: n.title,
            note: n.note,
            videoId: n.videoId,
            startSeconds: n.startSeconds,
            optional: n.optional,
            prerequisiteIds: n.prerequisiteIds,
          })),
          stageNode,
          ...videoNodes,
        ],
        videos: items.map((i) => ({
          videoId: i.video.videoId,
          title: i.video.title,
          channelName: i.video.channelName,
          channelId: i.video.channelId,
          durationSeconds: i.video.durationSeconds,
        })),
      });

      setDetail(updated);
      setCategoryImportActiveOpen(false);
      host.notify(`已将「${cat.name}」的 ${items.length} 个视频作为新阶段导入`);
    } catch (err) {
      host.notify(errorText(err, '导入分类失败'), 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  const openEditNodeModal = (positioned: PositionedPathNode) => {
    const n = positioned.node;
    setEditor({
      mode: 'edit',
      nodeId: n.nodeId,
      parentId: n.parentId ?? '',
      kind: n.kind,
      title: n.title,
      note: n.note ?? '',
      videoLink: n.videoId ?? '',
      startSeconds: String(n.startSeconds || 0),
      optional: n.optional,
      prerequisiteIdsText: n.prerequisiteIds.join(', '),
    });
  };

  const saveNodeDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !editor || savingEdit) return;
    setSavingEdit(true);
    try {
      let videoId: string | null = null;
      let startSecs = Math.max(0, parseInt(editor.startSeconds, 10) || 0);
      const videosToSave: VideoInput[] = [];
      if (editor.videoLink.trim()) {
        const parsed = parseYouTubeTarget(editor.videoLink.trim());
        if (!parsed || parsed.kind !== 'video') {
          throw new Error('请输入有效的 YouTube 视频链接或 11 位视频 ID。');
        }
        videoId = parsed.videoId;
        if (!startSecs && parsed.startSeconds > 0) {
          startSecs = parsed.startSeconds;
        }
        try {
          const info = await playerApi.fetchVideoInfo(videoId);
          videosToSave.push({
            videoId,
            title: info.title || editor.title.trim() || videoId,
            channelName: info.channelName,
            thumbnailUrl: thumbnailUrl(videoId, 'mq'),
          });
        } catch {
          videosToSave.push({
            videoId,
            title: editor.title.trim() || videoId,
            thumbnailUrl: thumbnailUrl(videoId, 'mq'),
          });
        }
      }

      const existingInputs: LearningPathNodeInput[] = detail.nodes.map((n) => ({
        nodeId: n.nodeId,
        parentId: n.parentId,
        position: n.position,
        kind: n.kind,
        title: n.title,
        note: n.note,
        videoId: n.videoId,
        startSeconds: n.startSeconds,
        optional: n.optional,
        prerequisiteIds: n.prerequisiteIds,
      }));

      const nextNode: LearningPathNodeInput = {
        nodeId: editor.nodeId.trim(),
        parentId: editor.parentId.trim() || null,
        position:
          editor.mode === 'add'
            ? existingInputs.length
            : (existingInputs.find((i) => i.nodeId === editor.nodeId)
                ?.position ?? existingInputs.length),
        kind: editor.kind,
        title:
          editor.title.trim() || videosToSave[0]?.title || editor.nodeId.trim(),
        note: editor.note.trim() || null,
        videoId,
        startSeconds: startSecs,
        optional: editor.optional,
        prerequisiteIds: editor.prerequisiteIdsText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };

      const nodes =
        editor.mode === 'add'
          ? [...existingInputs, nextNode]
          : existingInputs.map((item) =>
              item.nodeId === editor.nodeId ? nextNode : item,
            );

      const updated = await playerApi.learningPathSave({
        pathId: detail.summary.pathId,
        title: detail.summary.title,
        description: detail.summary.description,
        nodes,
        videos: videosToSave,
      });
      setDetail(updated);
      setEditor(null);
      await host.reloadOverview();
    } catch (err) {
      host.notify(errorText(err, '保存节点失败'), 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  const deleteNode = async (targetId: string) => {
    if (!detail) return;
    const targetNode = detail.nodes.find((n) => n.nodeId === targetId);
    if (!targetNode) return;
    if (!window.confirm(`确定移除节点「${targetNode.title}」吗？`)) return;
    try {
      const remaining = detail.nodes
        .filter((n) => n.nodeId !== targetId)
        .map((n, index) => ({
          nodeId: n.nodeId,
          parentId: n.parentId === targetId ? targetNode.parentId : n.parentId,
          position: index,
          kind: n.kind,
          title: n.title,
          note: n.note,
          videoId: n.videoId,
          startSeconds: n.startSeconds,
          optional: n.optional,
          prerequisiteIds: n.prerequisiteIds.filter((id) => id !== targetId),
        }));
      const updated = await playerApi.learningPathSave({
        pathId: detail.summary.pathId,
        title: detail.summary.title,
        description: detail.summary.description,
        nodes: remaining,
      });
      setDetail(updated);
      setSelectedNodeId(null);
      await host.reloadOverview();
    } catch (err) {
      host.notify(errorText(err, '删除节点失败'), 'error');
    }
  };

  const deleteEntirePath = async () => {
    if (!detail) return;
    if (
      !window.confirm(
        `确定删除整条学习路径「${detail.summary.title}」吗？（不会删除视频观看历史）`,
      )
    )
      return;
    try {
      await playerApi.learningPathDelete(detail.summary.pathId);
      await host.reloadOverview();
      host.go({ kind: 'learning-paths-home' });
      host.notify('已删除学习路径');
    } catch (err) {
      host.notify(errorText(err, '删除路径失败'), 'error');
    }
  };

  const sendCliForCurrentPath = (cli: 'agy' | 'claude' | 'codex') => {
    if (!detail) return;
    const prompt = `请先调用 learning_path_get(pathId="${detail.summary.pathId}") 查看当前学习路径「${detail.summary.title}」，再用 player_search_youtube 搜索真实进阶视频，并通过 learning_path_propose(mode="append_nodes", pathId="${detail.summary.pathId}", ...) 为后续阶段补充视频节点。`;
    const escaped = prompt.replace(/"/g, '\\"');
    const cmd =
      cli === 'agy'
        ? `agy -i "${escaped}"`
        : cli === 'claude'
          ? `claude "${escaped}"`
          : `codex "${escaped}"`;
    bridges?.onSendTerminalCommand?.(cmd, true);
  };

  const submitCopilotPrompt = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !aiPrompt.trim() || aiBusy) return;
    if (!bridges?.aiProvider || !bridges.agentCapabilities) {
      host.notify(
        '请先在顶部「模型设置」配置 API 模型，或使用上方 CLI 按钮调用终端模型。',
        'error',
      );
      return;
    }
    setAiBusy(true);
    setAiEvents([]);
    setAiReply('');
    try {
      const turn = await runLearningPathAgentTurn({
        history: aiHistory,
        prompt: aiPrompt.trim(),
        provider: bridges.aiProvider,
        capabilities: bridges.agentCapabilities,
        activePathSummary: {
          pathId: detail.summary.pathId,
          title: detail.summary.title,
          nodeCount: detail.summary.nodeCount,
          videoCount: detail.summary.videoCount,
          finishedCount: detail.summary.finishedCount,
        },
        onEvent: (ev) => {
          setAiEvents((prev) => {
            const idx = prev.findIndex((item) => item.id === ev.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = ev;
              return copy;
            }
            return [...prev, ev];
          });
        },
      });
      setAiHistory(turn.history);
      setAiReply(turn.reply);
      setAiPrompt('');
      if (turn.learningPathProposal) {
        bridges.onPreviewLearningPathProposal?.(
          turn.learningPathProposal,
          'ai',
        );
        setActiveAiCandidate(null);
      } else {
        const parsed = extractProposalFromText(
          detail.summary.title,
          turn.reply,
        );
        if (parsed) {
          setActiveAiCandidate(parsed);
        } else {
          setActiveAiCandidate(null);
        }
      }
    } catch (err) {
      setAiReply(`出错：${errorText(err, '请求失败')}`);
    } finally {
      setAiBusy(false);
    }
  };

  if (loading && !detail) {
    return <StateMessage kind="loading" title="正在加载学习路径…" />;
  }
  if (error || !detail || !layout) {
    return (
      <StateMessage
        kind="error"
        title="无法打开学习路径"
        action={
          <button
            type="button"
            className="player-button"
            onClick={() => host.go({ kind: 'learning-paths-home' })}
          >
            返回学习路径总览
          </button>
        }
      >
        {error}
      </StateMessage>
    );
  }

  const finishedVideos = layout.orderedPlayableNodes.filter(
    (n) => n.status === 'completed',
  ).length;
  const totalVideos = layout.orderedPlayableNodes.length;
  const nextUp = layout.nextUpNodeId
    ? (layout.nodes.find((n) => n.node.nodeId === layout.nextUpNodeId) ?? null)
    : null;
  const selectedNode =
    detail.summary.pathId === pathId
      ? (layout.nodes.find((n) => n.node.nodeId === selectedNodeId) ?? null)
      : null;
  const selectedStage = selectedNode
    ? (stageOverview.find((stage) => stage.index === selectedNode.stageIndex) ??
      null)
    : null;
  const selectedPrerequisites = selectedNode
    ? selectedNode.node.prerequisiteIds
        .map((id) => detail.nodes.find((node) => node.nodeId === id))
        .filter((node): node is NonNullable<typeof node> => Boolean(node))
    : [];
  const selectedDependents = selectedNode
    ? detail.nodes.filter((node) =>
        node.prerequisiteIds.includes(selectedNode.node.nodeId),
      )
    : [];

  return (
    <section
      className="lp-workspace"
      data-lp-theme={style.theme}
      data-lp-density={
        canvasMode === 'course' && scale < 0.85 ? 'compact' : 'full'
      }
      aria-label={`学习路径：${detail.summary.title}`}
    >
      <header className="lp-topbar">
        <div className="lp-title-group">
          <button
            type="button"
            className="lp-btn lp-back-btn"
            onClick={() => host.go({ kind: 'learning-paths-home' })}
            title="返回全部学习路径"
          >
            ← 全部路径
          </button>
          <div className="lp-title-text">
            <h2 title={detail.summary.title}>{detail.summary.title}</h2>
            <div className="lp-subtitle">
              <span className="lp-progress-pill">
                已学 {finishedVideos} / {totalVideos} 课
              </span>
              {detail.summary.description && (
                <>
                  <span
                    className="lp-description"
                    title={detail.summary.description}
                  >
                    {detail.summary.description}
                  </span>
                  <button
                    type="button"
                    className="lp-description-toggle"
                    aria-expanded={descriptionExpanded}
                    onClick={() => setDescriptionExpanded((value) => !value)}
                  >
                    详情
                  </button>
                </>
              )}
            </div>
          </div>
          {descriptionExpanded && detail.summary.description && (
            <div className="lp-description-popover">
              {detail.summary.description}
            </div>
          )}
        </div>
        {nextUp && (
          <button
            type="button"
            className="lp-btn is-primary lp-continue-btn"
            onClick={() => playNode(nextUp)}
            title={nextUp.node.title}
          >
            继续学习
          </button>
        )}
      </header>

      <div ref={toolbarRef} className="lp-toolbar-row">
        <div
          className="lp-segmented lp-view-switch"
          role="group"
          aria-label="路径视图"
        >
          <button
            type="button"
            className={canvasMode === 'constellation' ? 'is-active' : ''}
            aria-pressed={canvasMode === 'constellation'}
            onClick={() => {
              lastGraphModeRef.current = 'constellation';
              setCanvasMode('constellation');
            }}
          >
            星图视图
          </button>
          <button
            type="button"
            className={canvasMode === 'course' ? 'is-active' : ''}
            aria-pressed={canvasMode === 'course'}
            onClick={() => {
              lastGraphModeRef.current = 'course';
              setCanvasMode('course');
            }}
          >
            线性视图
          </button>
          <button
            type="button"
            className={canvasMode === 'overview' ? 'is-active' : ''}
            aria-pressed={canvasMode === 'overview'}
            onClick={() => setCanvasMode('overview')}
          >
            路径总览
          </button>
        </div>
        <label className="lp-stage-select-label">
          <span>阶段</span>
          <select
            aria-label="定位到阶段"
            value=""
            onChange={(event) => {
              if (event.target.value) {
                focusNode(event.target.value, 1);
              }
            }}
          >
            <option value="">定位阶段</option>
            {stageOverview.map((stage) => (
              <option key={stage.nodeId} value={stage.nodeId}>
                {String(stage.index + 1).padStart(2, '0')} · {stage.title}
              </option>
            ))}
          </select>
        </label>
        <div className="lp-toolbar-spacer" />
        <details className="lp-menu">
          <summary className="lp-btn">添加</summary>
          <div
            className="lp-menu-panel"
            onClick={(event) => {
              (event.currentTarget.parentElement as HTMLDetailsElement).open =
                false;
            }}
          >
            <button
              type="button"
              onClick={() =>
                setVideoPickerState({
                  isOpen: true,
                  title: '选取课程视频加入知识树',
                  subtitle: '从收藏、播放历史、关注频道或 YouTube 搜索中选取',
                  multiple: true,
                  parentId: null,
                })
              }
            >
              <span>选取视频添加</span>
              <span className="lp-menu-code">VID</span>
            </button>
            <button
              type="button"
              onClick={() => openAddNodeModal(null, 'stage')}
            >
              <span>新增阶段簇</span>
              <span className="lp-menu-code">STG</span>
            </button>
            <button
              type="button"
              onClick={() => setCategoryImportActiveOpen(true)}
            >
              <span>从收藏导入</span>
              <span className="lp-menu-code">FAV</span>
            </button>
          </div>
        </details>
        <details className="lp-menu">
          <summary className="lp-btn">显示设置</summary>
          <div className="lp-menu-panel lp-display-menu">
            <div className="lp-menu-section-head">
              <span>01 · 视图模式</span>
              <em>VIEW</em>
            </div>
            <div className="lp-menu-grid is-two-col">
              <button
                type="button"
                className={canvasMode === 'constellation' ? 'is-active' : ''}
                aria-pressed={canvasMode === 'constellation'}
                onClick={() => {
                  lastGraphModeRef.current = 'constellation';
                  setCanvasMode('constellation');
                }}
              >
                <span>知识星图</span>
                <span className="lp-menu-check">
                  {canvasMode === 'constellation' ? '●' : '○'}
                </span>
              </button>
              <button
                type="button"
                className={canvasMode === 'course' ? 'is-active' : ''}
                aria-pressed={canvasMode === 'course'}
                onClick={() => {
                  lastGraphModeRef.current = 'course';
                  setCanvasMode('course');
                }}
              >
                <span>线性图谱</span>
                <span className="lp-menu-check">
                  {canvasMode === 'course' ? '●' : '○'}
                </span>
              </button>
            </div>

            <div className="lp-menu-section-head">
              <span>02 · 线性拓扑结构</span>
              <em>LAYOUT</em>
            </div>
            <div className="lp-menu-grid is-two-col">
              {(
                [
                  ['tree', '横向树状流'],
                  ['metro', '地铁轨道流'],
                  ['lanes', '阶段泳道栏'],
                  ['dag', '技能拓扑图'],
                  ['radial', '径向星环图'],
                ] as const
              ).map(([mode, label]) => {
                const active =
                  canvasMode === 'course' && style.layoutMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    className={active ? 'is-active' : ''}
                    aria-pressed={active}
                    onClick={() => {
                      lastGraphModeRef.current = 'course';
                      setCanvasMode('course');
                      updateStyle({ layoutMode: mode });
                    }}
                  >
                    <span>{label}</span>
                    <span className="lp-menu-check">{active ? '✓' : ''}</span>
                  </button>
                );
              })}
            </div>

            <div className="lp-menu-section-head">
              <span>03 · 连线路由样式</span>
              <em>ROUTE</em>
            </div>
            <div className="lp-menu-grid is-three-col">
              {(
                [
                  ['curve', '平滑曲线'],
                  ['orthogonal', '正交折线'],
                  ['metro', '45° 轨道'],
                ] as const
              ).map(([connectorStyle, label]) => {
                const active = style.connectorStyle === connectorStyle;
                return (
                  <button
                    key={connectorStyle}
                    type="button"
                    className={active ? 'is-active' : ''}
                    aria-pressed={active}
                    onClick={() => updateStyle({ connectorStyle })}
                  >
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>

            <div className="lp-menu-section-head">
              <span>04 · 视觉色彩主题</span>
              <em>THEME</em>
            </div>
            <div className="lp-menu-theme-list">
              {THEME_OPTIONS.map((theme) => {
                const active = style.theme === theme.id;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    className={active ? 'is-active' : ''}
                    aria-pressed={active}
                    onClick={() => updateStyle({ theme: theme.id })}
                  >
                    <span className="lp-menu-theme-left">
                      <span
                        className="lp-swatch"
                        style={{ backgroundColor: theme.swatch }}
                      />
                      <span>{theme.label}</span>
                    </span>
                    <span className="lp-menu-check">{active ? '✓' : ''}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </details>
        <details className="lp-menu lp-more-menu">
          <summary className="lp-btn">更多</summary>
          <div
            className="lp-menu-panel"
            onClick={(event) => {
              (event.currentTarget.parentElement as HTMLDetailsElement).open =
                false;
            }}
          >
            <button
              type="button"
              onClick={() => bridges?.onSendTerminalCommand?.('', false)}
            >
              <span>终端 CLI</span>
              <span className="lp-menu-code">CLI</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedNodeId(null);
                setCopilotOpen((value) => !value);
              }}
            >
              <span>AI 规划助手</span>
              <span className="lp-menu-code">AI</span>
            </button>
            {bridges?.onExportMarkdownToMindmap && (
              <button
                type="button"
                onClick={() =>
                  bridges.onExportMarkdownToMindmap?.(
                    detail.summary.title,
                    learningPathToMarkdown(detail),
                  )
                }
              >
                <span>导出导图</span>
                <span className="lp-menu-code">MAP</span>
              </button>
            )}
            <button
              type="button"
              className="is-danger"
              onClick={() => void deleteEntirePath()}
            >
              <span>删除路径</span>
              <span className="lp-menu-code">DEL</span>
            </button>
          </div>
        </details>
      </div>

      <div className="lp-body">
        <div
          ref={viewportRef}
          className={`lp-viewport${panning ? ' is-panning' : ''}${canvasMode === 'overview' ? ' is-overview' : canvasMode === 'constellation' ? ' is-constellation' : ''}`}
          onMouseDown={handleMouseDown}
          onWheel={handleWheel}
        >
          {canvasMode === 'constellation' ? (
            <LearningPathStarMapView
              detail={detail}
              layout={layout}
              selectedNodeId={selectedNodeId}
              focusRequest={starFocusRequest}
              onSelectNode={(id) => {
                setSelectedNodeId(id);
                setCopilotOpen(false);
              }}
              onPlayNode={playNode}
              onEditNode={(nodeId) => {
                const item = layout.nodes.find((n) => n.node.nodeId === nodeId);
                if (item) openEditNodeModal(item);
              }}
              onAddChildNode={(parentId) => openAddNodeModal(parentId, 'video')}
              onDeleteNode={(nodeId) => void deleteNode(nodeId)}
            />
          ) : canvasMode === 'overview' ? (
            <div className="lp-overview" aria-label="路径阶段总览">
              <div className="lp-overview-heading">
                <div>
                  <span className="lp-overview-eyebrow">PATH OVERVIEW</span>
                  <h3>路径总览</h3>
                </div>
                <span>
                  {stageOverview.length} 个阶段 · 已学 {finishedVideos} /{' '}
                  {totalVideos} 课
                </span>
              </div>
              <div className="lp-overview-grid">
                {stageOverview.map((stage) => {
                  const percent = stage.videoCount
                    ? Math.round(
                        (stage.completedCount / stage.videoCount) * 100,
                      )
                    : 0;
                  return (
                    <button
                      type="button"
                      key={stage.nodeId}
                      className={`lp-overview-card${stage.isCurrent ? ' is-current' : ''}`}
                      onClick={() => focusNode(stage.nodeId, 1)}
                    >
                      <span className="lp-overview-card-top">
                        <span>
                          阶段 {String(stage.index + 1).padStart(2, '0')}
                        </span>
                        <span>
                          {stage.isCurrent
                            ? '当前阶段'
                            : percent === 100 && stage.videoCount > 0
                              ? '已完成'
                              : '待学习'}
                        </span>
                      </span>
                      <strong>{stage.title}</strong>
                      {stage.note && (
                        <span className="lp-overview-note">{stage.note}</span>
                      )}
                      <span className="lp-overview-card-bottom">
                        <span>
                          {stage.completedCount} / {stage.videoCount} 课
                        </span>
                        {stage.optionalCount > 0 && (
                          <span>{stage.optionalCount} 节选修</span>
                        )}
                      </span>
                      <span className="lp-overview-progress" aria-hidden="true">
                        <span style={{ width: `${percent}%` }} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <>
              <div
                className="lp-stage"
                style={{
                  width: layout.width,
                  height: layout.height,
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                }}
              >
                <svg
                  className="lp-edges-svg"
                  width={layout.width}
                  height={layout.height}
                >
                  <defs>
                    <marker
                      id="lp-arrow-muted"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path
                        d="M 0 1.5 L 8.5 5 L 0 8.5 z"
                        fill="var(--lp-edge)"
                      />
                    </marker>
                    <marker
                      id="lp-arrow-active"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path
                        d="M 0 1.5 L 8.5 5 L 0 8.5 z"
                        fill="var(--lp-edge-active)"
                      />
                    </marker>
                  </defs>
                  {layout.edges.map((edge) => (
                    <path
                      key={edge.id}
                      d={edge.pathD}
                      fill="none"
                      className={[
                        'lp-edge-path',
                        edge.kind === 'spine' ? 'is-spine' : '',
                        edge.optional ? 'is-optional' : '',
                        edge.kind === 'prerequisite' ? 'is-prerequisite' : '',
                        edge.active ? 'is-active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      markerEnd={
                        edge.active
                          ? 'url(#lp-arrow-active)'
                          : 'url(#lp-arrow-muted)'
                      }
                    />
                  ))}
                </svg>

                {layout.laneHeaders.map((header) => (
                  <div
                    key={`lane-${header.stageNodeId}`}
                    className="lp-lane-header"
                    style={{
                      left: header.x,
                      top: header.y,
                      width: header.width,
                      height: header.height,
                    }}
                  >
                    <div className="lp-lane-header-top">
                      <strong>{header.title}</strong>
                      <span>
                        {header.completedCount}/{header.totalCount}
                      </span>
                    </div>
                    {header.note && <p>{header.note}</p>}
                  </div>
                ))}

                {layout.nodes.map((item) => {
                  const { node, video } = item;
                  const isStageCard = node.kind === 'stage' && !video;
                  return (
                    <article
                      key={node.nodeId}
                      className={[
                        'lp-node-card',
                        isStageCard ? 'is-stage' : '',
                        node.kind === 'checkpoint' ? 'is-checkpoint' : '',
                        item.status === 'completed' ? 'is-completed' : '',
                        item.isNextUp ? 'is-next-up' : '',
                        item.status === 'locked' ? 'is-locked' : '',
                        node.optional ? 'is-optional' : '',
                        selectedNodeId === node.nodeId ? 'is-selected' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{
                        left: item.x,
                        top: item.y,
                        width: item.width,
                        height: item.height,
                      }}
                      aria-current={item.isNextUp ? 'step' : undefined}
                    >
                      <div className="lp-node-top">
                        <div className="lp-node-badges">
                          <span className="lp-step-num">
                            {item.orderIndex !== null
                              ? `#${String(item.orderIndex).padStart(2, '0')}`
                              : `S${item.stageIndex + 1}`}
                          </span>
                          {item.isNextUp && (
                            <span className="lp-kind-tag is-next">下一课</span>
                          )}
                          {node.kind === 'checkpoint' && (
                            <span className="lp-kind-tag">里程碑</span>
                          )}
                          {node.optional && (
                            <span className="lp-kind-tag">选修</span>
                          )}
                          {item.status === 'completed' && (
                            <span className="lp-kind-tag is-done">已完成</span>
                          )}
                          {item.status === 'locked' && (
                            <span className="lp-kind-tag">待解锁</span>
                          )}
                        </div>

                        {video && (
                          <button
                            type="button"
                            className="lp-node-quick-play"
                            title={`播放「${node.title}」`}
                            aria-label={`播放「${node.title}」`}
                            onClick={() => playNode(item)}
                          >
                            播放
                          </button>
                        )}
                      </div>

                      <button
                        type="button"
                        id={`lp-select-${node.nodeId}`}
                        className="lp-node-select"
                        aria-label={`${NODE_KIND_LABEL[node.kind]}：${node.title}。按回车查看详情，左右方向键切换节点`}
                        aria-expanded={selectedNodeId === node.nodeId}
                        aria-controls={
                          selectedNodeId === node.nodeId
                            ? 'lp-node-inspector'
                            : undefined
                        }
                        onClick={() => selectNode(node.nodeId)}
                        onKeyDown={(event) =>
                          handleNodeKeyDown(event, node.nodeId)
                        }
                      >
                        <span className="lp-node-main">
                          <span className="lp-node-info">
                            <span className="lp-node-title" title={node.title}>
                              {node.title}
                            </span>
                            <span className="lp-node-meta">
                              {video
                                ? `${video.channelName || video.videoId}${video.durationSeconds ? ` · ${formatDuration(video.durationSeconds)}` : ''}`
                                : '阶段主干节点'}
                            </span>
                          </span>
                        </span>
                      </button>

                      <div className="lp-node-footer">
                        {node.note && (
                          <p className="lp-node-note" title={node.note}>
                            {node.note}
                          </p>
                        )}
                        <div className="lp-progress-track">
                          <div
                            className="lp-progress-fill"
                            style={{
                              width: `${Math.round(item.progressRatio * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>

              <div
                className="lp-canvas-dock"
                role="toolbar"
                aria-label="画布视图控制"
              >
                <button
                  type="button"
                  onClick={() => {
                    const next = Math.max(
                      0.25,
                      Number((scale - 0.12).toFixed(2)),
                    );
                    setScale(next);
                  }}
                  title="缩小"
                >
                  −
                </button>
                <span className="lp-zoom-readout">
                  {Math.round(scale * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setScale((s) =>
                      Math.min(1.65, Number((s + 0.12).toFixed(2))),
                    )
                  }
                  title="放大"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScale(1);
                    setPan({ x: 24, y: 24 });
                  }}
                  title="重置为 100%"
                >
                  1:1
                </button>
                <button
                  type="button"
                  onClick={fitCanvas}
                  title="自动适配整个路径树"
                >
                  适配画布
                </button>
                {layout.nextUpNodeId && (
                  <button
                    type="button"
                    onClick={() => focusNode(layout.nextUpNodeId!, 1)}
                    title="定位到下一节待学视频"
                  >
                    定位下一课
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {canvasMode === 'course' && selectedNode && (
          <aside
            id="lp-node-inspector"
            className="lp-node-inspector"
            aria-label="课程节点详情"
          >
            <header className="lp-inspector-header">
              <div>
                <span>
                  NODE INSPECTOR //{' '}
                  {selectedNode.orderIndex !== null
                    ? `#${String(selectedNode.orderIndex).padStart(2, '0')}`
                    : `S${selectedNode.stageIndex + 1}`}
                </span>
                <strong>节点规格详情</strong>
              </div>
              <button
                type="button"
                className="lp-inspector-close"
                onClick={() => {
                  const nodeId = selectedNode.node.nodeId;
                  setSelectedNodeId(null);
                  window.requestAnimationFrame(() => {
                    document.getElementById(`lp-select-${nodeId}`)?.focus();
                  });
                }}
                aria-label="关闭节点详情"
                title="关闭节点详情 (Esc)"
              >
                <CloseIcon />
              </button>
            </header>
            <div className="lp-inspector-body">
              <div className="lp-inspector-identity">
                <span className="lp-inspector-index">
                  {selectedNode.orderIndex !== null
                    ? `COURSE ${String(selectedNode.orderIndex).padStart(2, '0')}`
                    : `STAGE ${String(selectedNode.stageIndex + 1).padStart(2, '0')}`}
                </span>
                <h3>{selectedNode.node.title}</h3>
                <div className="lp-inspector-tags">
                  <span>{NODE_KIND_LABEL[selectedNode.node.kind]}</span>
                  <span className={`is-${selectedNode.status}`}>
                    {NODE_STATUS_LABEL[selectedNode.status]}
                  </span>
                  {selectedNode.node.optional && <span>选修</span>}
                  {selectedNode.isNextUp && (
                    <span className="is-next">下一课</span>
                  )}
                </div>
              </div>

              {selectedNode.video && (
                <div className="lp-inspector-media-card">
                  <button
                    type="button"
                    className="lp-inspector-media-thumb"
                    onClick={() => playNode(selectedNode)}
                    title={`点击播放：${selectedNode.node.title}`}
                  >
                    <img
                      src={
                        selectedNode.video.thumbnailUrl ??
                        thumbnailUrl(selectedNode.video.videoId, 'mq')
                      }
                      alt=""
                      loading="lazy"
                    />
                    <span className="lp-inspector-media-play">▶</span>
                    {selectedNode.video.durationSeconds ? (
                      <span className="lp-thumb-duration">
                        {formatDuration(selectedNode.video.durationSeconds)}
                      </span>
                    ) : null}
                  </button>
                  <div className="lp-inspector-media-meta">
                    <span className="lp-inspector-media-code">
                      VID // {selectedNode.video.videoId}
                    </span>
                    <strong className="lp-inspector-media-channel">
                      {selectedNode.video.channelName || '未知频道'}
                    </strong>
                    <div className="lp-inspector-media-prog">
                      <div className="lp-progress-track">
                        <div
                          className="lp-progress-fill"
                          style={{
                            width: `${Math.round(selectedNode.progressRatio * 100)}%`,
                          }}
                        />
                      </div>
                      <span>
                        {Math.round(selectedNode.progressRatio * 100)}%
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <dl className="lp-inspector-facts">
                <div>
                  <dt>所属阶段</dt>
                  <dd>
                    {selectedStage
                      ? `${String(selectedStage.index + 1).padStart(2, '0')} · ${selectedStage.title}`
                      : '未分阶段'}
                  </dd>
                </div>
                {selectedNode.video && (
                  <>
                    <div>
                      <dt>频道来源</dt>
                      <dd>{selectedNode.video.channelName || '未知频道'}</dd>
                    </div>
                    <div>
                      <dt>课程时长</dt>
                      <dd>
                        {selectedNode.video.durationSeconds
                          ? formatDuration(selectedNode.video.durationSeconds)
                          : '未提供'}
                      </dd>
                    </div>
                    <div>
                      <dt>观看进度</dt>
                      <dd>{Math.round(selectedNode.progressRatio * 100)}%</dd>
                    </div>
                  </>
                )}
                {selectedNode.node.startSeconds > 0 && (
                  <div>
                    <dt>起播时间</dt>
                    <dd>{formatDuration(selectedNode.node.startSeconds)}</dd>
                  </div>
                )}
              </dl>

              {selectedNode.node.note && (
                <section className="lp-inspector-section">
                  <h4>01 · 学习要点</h4>
                  <p>{selectedNode.node.note}</p>
                </section>
              )}

              <section className="lp-inspector-section">
                <h4>02 · 拓扑依赖关系</h4>
                <div className="lp-inspector-relations">
                  <span>前置课程 (PREREQUISITES)</span>
                  {selectedPrerequisites.length > 0 ? (
                    selectedPrerequisites.map((node) => (
                      <button
                        type="button"
                        key={node.nodeId}
                        onClick={() => {
                          setSelectedNodeId(node.nodeId);
                          focusNode(node.nodeId, scale);
                        }}
                      >
                        ← {node.title}
                      </button>
                    ))
                  ) : (
                    <em>无前置约束</em>
                  )}
                  <span>后续解锁 (UNLOCKS)</span>
                  {selectedDependents.length > 0 ? (
                    selectedDependents.map((node) => (
                      <button
                        type="button"
                        key={node.nodeId}
                        onClick={() => {
                          setSelectedNodeId(node.nodeId);
                          focusNode(node.nodeId, scale);
                        }}
                      >
                        {node.title} →
                      </button>
                    ))
                  ) : (
                    <em>无后续依赖</em>
                  )}
                </div>
              </section>
            </div>
            <footer className="lp-inspector-actions">
              {selectedNode.video ? (
                <>
                  <button
                    type="button"
                    className="lp-btn is-primary"
                    onClick={() => playNode(selectedNode)}
                  >
                    ▶{' '}
                    {selectedNode.status === 'in_progress'
                      ? '继续观看课程'
                      : '立即播放课程'}
                  </button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => host.toggleWatched(selectedNode.video!)}
                  >
                    {selectedNode.video.finished ? '撤销已看' : '标记已看'}
                  </button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() =>
                      setVideoPickerState({
                        isOpen: true,
                        title: selectedNode.node.parentId
                          ? '添加到本阶段'
                          : '添加到路径',
                        subtitle: '可从收藏、历史或搜索中选取后续视频',
                        multiple: true,
                        parentId: selectedNode.node.parentId ?? null,
                      })
                    }
                  >
                    {selectedNode.node.parentId ? '添加到本阶段' : '添加到路径'}
                  </button>
                </>
              ) : selectedNode.node.kind === 'stage' ? (
                <>
                  <button
                    type="button"
                    className="lp-btn is-primary"
                    onClick={() =>
                      setVideoPickerState({
                        isOpen: true,
                        title: `为「${selectedNode.node.title}」选取课程视频`,
                        subtitle: '可从收藏、历史、订阅动态或搜索中批量勾选',
                        multiple: true,
                        parentId: selectedNode.node.nodeId,
                      })
                    }
                  >
                    添加课程视频
                  </button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() =>
                      openAddNodeModal(selectedNode.node.nodeId, 'stage')
                    }
                  >
                    添加子阶段
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="lp-btn"
                onClick={() => openEditNodeModal(selectedNode)}
              >
                编辑节点
              </button>
              <button
                type="button"
                className="lp-btn is-danger"
                onClick={() => void deleteNode(selectedNode.node.nodeId)}
              >
                移除节点
              </button>
            </footer>
          </aside>
        )}

        {copilotOpen && (
          <aside className="lp-copilot-drawer" aria-label="CLI 与 AI 路径助手">
            <header className="lp-copilot-header">
              <strong>AI / CLI 路径共创</strong>
              <button
                type="button"
                className="lp-icon-btn"
                onClick={() => setCopilotOpen(false)}
              >
                <CloseIcon />
              </button>
            </header>
            <div className="lp-copilot-body">
              <div className="lp-copilot-section">
                <h4>底部 CLI 终端联动（MCP）</h4>
                <p>
                  一键在全局底部终端启动 Google AGY / Claude /
                  Codex，自动读取当前路径并搜索新视频扩展：
                </p>
                <div className="lp-cli-chips">
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => sendCliForCurrentPath('agy')}
                  >
                    AGY 续写路径
                  </button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => sendCliForCurrentPath('claude')}
                  >
                    Claude 续写路径
                  </button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => sendCliForCurrentPath('codex')}
                  >
                    Codex 续写路径
                  </button>
                </div>
              </div>

              <form
                onSubmit={(e) => void submitCopilotPrompt(e)}
                className="lp-copilot-section"
              >
                <h4>内置 AI 路径助手</h4>
                <p>
                  直接向应用内置模型下达指令（例如：“帮我在第二阶段补充两节实战案例视频，并加一个里程碑汇合节点”）：
                </p>
                <textarea
                  className="lp-copilot-textarea"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="输入你的扩展或重构需求…"
                />
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button
                    type="submit"
                    className="lp-btn is-primary"
                    disabled={aiBusy || !aiPrompt.trim()}
                  >
                    {aiBusy ? '正在检索规划…' : '生成修改预览'}
                  </button>
                </div>
              </form>

              {aiEvents.length > 0 && (
                <div className="lp-copilot-events">
                  {aiEvents.map((ev) => (
                    <div key={ev.id} className="lp-copilot-event">
                      {ev.kind === 'model'
                        ? `第 ${ev.round} 轮模型推理（${ev.status === 'running' ? '思考中…' : '完成'}）`
                        : `${ev.label} · ${ev.summary}`}
                    </div>
                  ))}
                </div>
              )}

              {aiReply && <div className="lp-copilot-reply">{aiReply}</div>}
              {activeAiCandidate && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="lp-btn is-primary"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={() => {
                      bridges?.onPreviewLearningPathProposal?.(
                        activeAiCandidate,
                        'ai',
                      );
                    }}
                  >
                    应用此方案并生成知识树
                  </button>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {editor && (
        <div className="lp-proposal-backdrop" role="dialog" aria-modal="true">
          <form
            className="lp-proposal-modal"
            style={{ width: 'min(540px, 92vw)' }}
            onSubmit={(e) => void saveNodeDraft(e)}
          >
            <header className="lp-proposal-head">
              <div>
                <span className="lp-proposal-badge">
                  {editor.mode === 'add' ? '新增节点' : '编辑节点'}
                </span>
                <h3>{editor.nodeId}</h3>
              </div>
              <button
                type="button"
                className="lp-icon-btn"
                onClick={() => setEditor(null)}
              >
                <CloseIcon />
              </button>
            </header>

            <div className="lp-proposal-body">
              <label style={{ fontSize: 12 }}>
                节点类型
                <select
                  value={editor.kind}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      kind: e.target.value as LearningPathNodeKind,
                    })
                  }
                  style={{ width: '100%', height: 32, marginTop: 4 }}
                >
                  <option value="video">视频课程 (video)</option>
                  <option value="stage">阶段主干 (stage)</option>
                  <option value="checkpoint">综合里程碑 (checkpoint)</option>
                </select>
              </label>

              <label style={{ fontSize: 12 }}>
                节点标题
                <input
                  type="text"
                  value={editor.title}
                  onChange={(e) =>
                    setEditor({ ...editor, title: e.target.value })
                  }
                  placeholder="留空时若填了视频链接将自动读取视频标题"
                  style={{
                    width: '100%',
                    height: 32,
                    marginTop: 4,
                    padding: '0 8px',
                  }}
                />
              </label>

              <label style={{ fontSize: 12 }}>
                YouTube 视频链接或 11 位 ID（纯阶段分组可留空）
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <input
                    type="text"
                    value={editor.videoLink}
                    onChange={(e) =>
                      setEditor({ ...editor, videoLink: e.target.value })
                    }
                    placeholder="https://www.youtube.com/watch?v=... 或 11 位 videoId"
                    style={{
                      flex: 1,
                      height: 32,
                      padding: '0 8px',
                      background: 'var(--player-panel)',
                      color: 'var(--player-ink)',
                      border: '1px solid var(--player-line-strong)',
                    }}
                  />
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => {
                      setVideoPickerState({
                        isOpen: true,
                        title: '从视频库选取视频填入',
                        multiple: false,
                        parentId: null,
                      });
                    }}
                  >
                    从视频库选取…
                  </button>
                </div>
              </label>

              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ fontSize: 12, flex: 1 }}>
                  父节点 ID（顶层留空）
                  <select
                    value={editor.parentId}
                    onChange={(e) =>
                      setEditor({ ...editor, parentId: e.target.value })
                    }
                    style={{ width: '100%', height: 32, marginTop: 4 }}
                  >
                    <option value="">（顶层主干节点）</option>
                    {detail.nodes
                      .filter((n) => n.nodeId !== editor.nodeId)
                      .map((n) => (
                        <option key={n.nodeId} value={n.nodeId}>
                          {n.title} ({n.nodeId})
                        </option>
                      ))}
                  </select>
                </label>
                <label style={{ fontSize: 12, width: 120 }}>
                  起始秒数
                  <input
                    type="number"
                    min={0}
                    value={editor.startSeconds}
                    onChange={(e) =>
                      setEditor({ ...editor, startSeconds: e.target.value })
                    }
                    style={{
                      width: '100%',
                      height: 32,
                      marginTop: 4,
                      padding: '0 8px',
                    }}
                  />
                </label>
              </div>

              <label style={{ fontSize: 12 }}>
                前置依赖节点（点击快速连接/解除前置关系，在技能拓扑中自动绘线）
                <div className="lp-prereq-selector" style={{ marginTop: 4 }}>
                  {detail.nodes
                    .filter((n) => n.nodeId !== editor.nodeId)
                    .map((n) => {
                      const curSet = new Set(
                        editor.prerequisiteIdsText
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      );
                      const isChecked = curSet.has(n.nodeId);
                      return (
                        <button
                          key={n.nodeId}
                          type="button"
                          className={`lp-prereq-pill${isChecked ? ' is-selected' : ''}`}
                          onClick={() => {
                            if (isChecked) {
                              curSet.delete(n.nodeId);
                            } else {
                              curSet.add(n.nodeId);
                            }
                            setEditor({
                              ...editor,
                              prerequisiteIdsText:
                                Array.from(curSet).join(', '),
                            });
                          }}
                        >
                          {isChecked ? '✓ ' : '+ '}
                          {n.title || n.nodeId}
                        </button>
                      );
                    })}
                </div>
                <input
                  type="text"
                  value={editor.prerequisiteIdsText}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      prerequisiteIdsText: e.target.value,
                    })
                  }
                  placeholder="手动输入节点 ID（逗号分隔）：vid-1, vid-2"
                  style={{
                    width: '100%',
                    height: 28,
                    marginTop: 6,
                    padding: '0 8px',
                    fontSize: 11,
                    opacity: 0.8,
                  }}
                />
              </label>

              <label style={{ fontSize: 12 }}>
                学习要点备注
                <input
                  type="text"
                  value={editor.note}
                  onChange={(e) =>
                    setEditor({ ...editor, note: e.target.value })
                  }
                  placeholder="本章看点或练习提示"
                  style={{
                    width: '100%',
                    height: 32,
                    marginTop: 4,
                    padding: '0 8px',
                  }}
                />
              </label>

              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                }}
              >
                <input
                  type="checkbox"
                  checked={editor.optional}
                  onChange={(e) =>
                    setEditor({ ...editor, optional: e.target.checked })
                  }
                />
                设为选修 / 支线节点（在地铁轨道流中位于支线侧轨）
              </label>
            </div>

            <footer className="lp-proposal-foot">
              <span />
              <div className="lp-proposal-foot-actions">
                <button
                  type="button"
                  className="lp-btn"
                  onClick={() => setEditor(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="lp-btn is-primary"
                  disabled={savingEdit}
                >
                  {savingEdit ? '保存中…' : '保存节点'}
                </button>
              </div>
            </footer>
          </form>
        </div>
      )}

      <VideoPickerModal
        isOpen={videoPickerState.isOpen}
        title={videoPickerState.title}
        subtitle={videoPickerState.subtitle}
        multiple={videoPickerState.multiple}
        onClose={() =>
          setVideoPickerState((prev) => ({ ...prev, isOpen: false }))
        }
        onConfirm={handleVideoPickerConfirm}
      />

      <CategoryImportDialog
        isOpen={categoryImportActiveOpen}
        onClose={() => setCategoryImportActiveOpen(false)}
        onSelectCategory={(cat) => void importCategoryIntoActivePath(cat)}
        title="导入收藏分类作为新学习阶段"
        subtitle="选取一个分类，将其包含的视频作为一个新阶段追加到当前知识树中"
      />
    </section>
  );
}
