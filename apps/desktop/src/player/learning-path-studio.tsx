import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { runLearningPathAgentTurn } from '../agent/runtime';
import type { LearningPathProposal } from '../agent/types';
import { CloseIcon } from './icons';
import type { LearningPathStageOverview } from './learning-path-layout';
import { extractProposalFromText } from './learning-path-parser';
import {
  ACADEMIC_ENGINEERING_PROMPT_BLUEPRINTS,
  compileAcademicEngineeringPrompt,
  HACKER_CONSTELLATION_PATH_ID,
  HACKER_LEARNING_PATH_PRESET,
} from './learning-path-presets';
import type { LearningPathExternalBridges } from './LearningPathView';
import { usePlayerHost } from './host';
import { errorText, playerApi } from './player-api';
import {
  FAVORITE_CATEGORY_COLORS,
  type FavoritesSnapshot,
  type LearningPathNodeInput,
  type LearningPathSummary,
} from './types';

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
    snapshot?.items.filter((item) => item.categoryId === null).length ?? 0;

  return (
    <div className="lp-proposal-backdrop" role="dialog" aria-modal="true">
      <div className="lp-proposal-modal lp-create-modal">
        <header className="lp-proposal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p className="lp-create-lead">{subtitle}</p>}
          </div>
          <button type="button" className="lp-icon-btn" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="lp-proposal-body">
          {loading ? (
            <p className="lp-create-lead">正在读取收藏分类…</p>
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
                  {uncategorizedCount} 个视频
                </span>
              </div>
              {(snapshot?.categories ?? []).map((cat) => {
                const count = (snapshot?.items ?? []).filter(
                  (item) => item.categoryId === cat.categoryId,
                ).length;
                const colorMeta = FAVORITE_CATEGORY_COLORS.find(
                  (color) => color.id === cat.color,
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
                      {count} 个视频
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <footer className="lp-proposal-foot">
          <span className="lp-create-lead">点一个分类即可导入。</span>
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

function pathProgress(path: LearningPathSummary): number {
  if (path.videoCount <= 0) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round((path.finishedCount / path.videoCount) * 100)),
  );
}

export function PathDirectoryRail({
  activePathId,
  stages,
  stagesLoading = false,
  activeStageId,
  onSelectStage,
  onCreate,
}: {
  activePathId: string | null;
  stages?: LearningPathStageOverview[] | null;
  stagesLoading?: boolean;
  activeStageId?: string | null;
  onSelectStage?: (stageId: string) => void;
  onCreate: () => void;
}) {
  const host = usePlayerHost();

  return (
    <aside className="lp-studio-rail" aria-label="学习路径目录">
      <div className="lp-studio-rail-head">
        <button
          type="button"
          className="lp-studio-rail-title"
          onClick={() => host.go({ kind: 'learning-paths-home' })}
        >
          学习路径
        </button>
        <button type="button" className="lp-btn" onClick={onCreate}>
          新建
        </button>
      </div>
      <div className="lp-studio-rail-scroll">
        {host.learningPaths.length === 0 ? (
          <p className="lp-studio-rail-empty">还没有路径</p>
        ) : (
          host.learningPaths.map((path) => {
            const active = path.pathId === activePathId;
            const percent = pathProgress(path);
            return (
              <div
                key={path.pathId}
                className={`lp-rail-group${active ? ' is-active' : ''}`}
              >
                <button
                  type="button"
                  className="lp-rail-path"
                  aria-current={active ? 'page' : undefined}
                  onClick={() =>
                    host.go({ kind: 'learning-path', pathId: path.pathId })
                  }
                >
                  <span className="lp-rail-path-title">{path.title}</span>
                  <span className="lp-rail-path-meta">
                    {path.finishedCount}/{path.videoCount || path.nodeCount}
                  </span>
                  <span className="lp-rail-progress" aria-hidden="true">
                    <span style={{ width: `${percent}%` }} />
                  </span>
                </button>
                {active && (
                  <div className="lp-rail-stages" aria-label="阶段">
                    {stagesLoading || stages == null ? (
                      <p className="lp-studio-rail-empty">正在读取阶段…</p>
                    ) : stages.length === 0 ? (
                      <p className="lp-studio-rail-empty">还没有阶段</p>
                    ) : (
                      stages.map((stage) => (
                        <button
                          key={stage.nodeId}
                          type="button"
                          className={`lp-rail-stage${
                            stage.nodeId === activeStageId ? ' is-active' : ''
                          }`}
                          aria-current={
                            stage.nodeId === activeStageId ? 'true' : undefined
                          }
                          onClick={() => onSelectStage?.(stage.nodeId)}
                        >
                          <span className="lp-rail-stage-index">
                            {String(stage.index + 1).padStart(2, '0')}
                          </span>
                          <span className="lp-rail-stage-title">
                            {stage.title}
                          </span>
                          <span className="lp-rail-stage-meta">
                            {stage.completedCount}/{stage.videoCount}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

export function LearningPathCreateDialog({
  open,
  bridges,
  onClose,
}: {
  open: boolean;
  bridges?: LearningPathExternalBridges;
  onClose: () => void;
}) {
  const host = usePlayerHost();
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [categoryImportOpen, setCategoryImportOpen] = useState(false);
  const [aiTopic, setAiTopic] = useState('');
  const [aiTopologyMode, setAiTopologyMode] = useState<
    'constellation' | 'linear' | 'radial'
  >('linear');
  const [aiRunning, setAiRunning] = useState(false);
  const [aiStatus, setAiStatus] = useState('');
  const [aiCandidateProposal, setAiCandidateProposal] =
    useState<LearningPathProposal | null>(null);

  const openOrCreateHackerConstellation = async () => {
    if (saving) return;
    const existing = host.learningPaths.find(
      (path) => path.pathId === HACKER_CONSTELLATION_PATH_ID,
    );
    if (
      existing &&
      existing.nodeCount >= HACKER_LEARNING_PATH_PRESET.nodes.length
    ) {
      onClose();
      host.go({ kind: 'learning-path', pathId: existing.pathId });
      return;
    }
    setSaving(true);
    try {
      const saved = await playerApi.learningPathSave(
        HACKER_LEARNING_PATH_PRESET,
      );
      await host.reloadOverview();
      onClose();
      host.go({ kind: 'learning-path', pathId: saved.summary.pathId });
      host.notify(existing ? '已更新黑客安全路径' : '已生成黑客安全路径');
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
            title: '第一阶段',
            note: null,
          },
        ],
      });
      await host.reloadOverview();
      setNewTitle('');
      setNewDesc('');
      onClose();
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
      const items = snap.items.filter((item) =>
        cat.id === null ? item.categoryId === null : item.categoryId === cat.id,
      );
      if (items.length === 0) {
        host.notify(`分类「${cat.name}」里还没有视频。`, 'error');
        return;
      }
      const nodes: LearningPathNodeInput[] = [
        {
          nodeId: 'stage-1',
          parentId: null,
          position: 0,
          kind: 'stage',
          title: cat.name,
          note: `从收藏分类「${cat.name}」导入`,
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
          title: `${cat.name} · 学完`,
          note: null,
        },
      ];
      const saved = await playerApi.learningPathSave({
        title: cat.name,
        description: `由收藏分类「${cat.name}」生成，${items.length} 节课`,
        nodes,
        videos: items.map((item) => ({
          videoId: item.video.videoId,
          title: item.video.title,
          channelName: item.video.channelName,
          channelId: item.video.channelId,
          durationSeconds: item.video.durationSeconds,
        })),
      });
      await host.reloadOverview();
      setCategoryImportOpen(false);
      onClose();
      host.go({ kind: 'learning-path', pathId: saved.summary.pathId });
      host.notify(`已从「${cat.name}」创建路径`);
    } catch (err) {
      host.notify(errorText(err, '创建知识树失败'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const launchCliPrompt = (cli: 'agy' | 'claude' | 'codex') => {
    const topic =
      aiTopic.trim() ||
      ACADEMIC_ENGINEERING_PROMPT_BLUEPRINTS[0]?.prompt ||
      '操作系统与 Linux 内核源码工程';
    const prompt = compileAcademicEngineeringPrompt(topic, aiTopologyMode)
      .replace(/\s+/g, ' ')
      .trim();
    const escaped = prompt.replace(/"/g, '\\"');
    const cmd =
      cli === 'agy'
        ? `agy -i "${escaped}"`
        : cli === 'claude'
          ? `claude "${escaped}"`
          : `codex "${escaped}"`;
    bridges?.onSendTerminalCommand?.(cmd, true);
    onClose();
  };

  const runQuickAi = async () => {
    if (!bridges?.aiProvider || !bridges.agentCapabilities) {
      host.notify('请先在模型设置中填写 API 地址、模型和密钥。', 'error');
      return;
    }
    const topic = aiTopic.trim();
    if (!topic || aiRunning) return;
    setAiRunning(true);
    setAiStatus('正在生成路径…');
    setAiCandidateProposal(null);
    const compiledPrompt = compileAcademicEngineeringPrompt(
      topic,
      aiTopologyMode,
    );
    try {
      const result = await runLearningPathAgentTurn({
        history: [],
        prompt: compiledPrompt,
        provider: bridges.aiProvider,
        capabilities: bridges.agentCapabilities,
        activePathSummary: null,
        onEvent: (event) => {
          if (event.kind === 'tool') {
            setAiStatus(`${event.label}：${event.summary}`);
          }
        },
      });
      if (result.learningPathProposal) {
        bridges.onPreviewLearningPathProposal?.(
          result.learningPathProposal,
          'ai',
        );
        setAiStatus('已生成预览，请在弹窗里确认。');
        setAiCandidateProposal(null);
      } else {
        const parsed = extractProposalFromText(topic, result.reply);
        if (parsed) {
          setAiCandidateProposal(parsed);
          setAiStatus('生成完成，可以应用这条路径。');
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
    <>
      {open && (
        <div
          className="lp-proposal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="新建学习路径"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div className="lp-proposal-modal lp-create-modal">
            <header className="lp-proposal-head">
              <div>
                <h3>新建路径</h3>
                <p className="lp-create-lead">
                  空白路径、从收藏导入，或用提示词生成。
                </p>
              </div>
              <button
                type="button"
                className="lp-icon-btn"
                onClick={onClose}
                aria-label="关闭"
              >
                <CloseIcon />
              </button>
            </header>
            <div className="lp-proposal-body lp-create-body">
              <form
                className="lp-create-form"
                onSubmit={(event) => void createBlankPath(event)}
              >
                <input
                  className="lp-create-input"
                  type="text"
                  required
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  placeholder="路径标题"
                />
                <input
                  className="lp-create-input is-grow"
                  type="text"
                  value={newDesc}
                  onChange={(event) => setNewDesc(event.target.value)}
                  placeholder="一句说明，可以留空"
                />
                <button
                  type="submit"
                  className="lp-btn is-primary"
                  disabled={saving}
                >
                  创建
                </button>
              </form>
              <div className="lp-create-actions">
                <button
                  type="button"
                  className="lp-btn"
                  disabled={saving}
                  onClick={() => void openOrCreateHackerConstellation()}
                >
                  黑客安全路径
                </button>
                <button
                  type="button"
                  className="lp-btn"
                  onClick={() => setCategoryImportOpen(true)}
                >
                  从收藏导入
                </button>
              </div>
              <div className="lp-create-generate">
                <div className="lp-topology-mode-bar">
                  <h4>生成</h4>
                  <div
                    className="lp-segmented lp-topology-mode-pills"
                    role="group"
                    aria-label="路径结构"
                  >
                    {(
                      [
                        ['linear', '主线'],
                        ['constellation', '网状'],
                        ['radial', '辐射'],
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
                <div className="lp-create-form">
                  <input
                    className="lp-create-input is-grow"
                    type="text"
                    value={aiTopic}
                    onChange={(event) => setAiTopic(event.target.value)}
                    placeholder="输入领域，或点下面的提示词"
                  />
                  <button
                    type="button"
                    className="lp-btn is-primary"
                    disabled={!aiTopic.trim() || aiRunning}
                    onClick={() => void runQuickAi()}
                  >
                    {aiRunning ? '生成中…' : '生成预览'}
                  </button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => launchCliPrompt('agy')}
                  >
                    AGY
                  </button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => launchCliPrompt('claude')}
                  >
                    Claude
                  </button>
                </div>
                <div className="lp-blueprint-matrix" aria-label="提示词">
                  <div className="lp-blueprint-matrix-head">
                    <span className="lp-blueprint-matrix-kicker">提示词</span>
                    <span className="lp-blueprint-matrix-hint">
                      点一张卡片，填入上面的主题。
                    </span>
                  </div>
                  <div className="lp-blueprint-grid">
                    {ACADEMIC_ENGINEERING_PROMPT_BLUEPRINTS.map((blueprint) => {
                      const active = aiTopic.trim() === blueprint.prompt;
                      return (
                        <button
                          key={blueprint.id}
                          type="button"
                          className={`lp-blueprint-card${active ? ' is-active' : ''}`}
                          onClick={() => setAiTopic(blueprint.prompt)}
                        >
                          <div className="lp-blueprint-card-top">
                            <span className="lp-blueprint-tag">
                              {blueprint.tag}
                            </span>
                            <strong className="lp-blueprint-title">
                              {blueprint.title}
                            </strong>
                          </div>
                          <div className="lp-blueprint-meta">
                            <span>学术：{blueprint.academicBenchmarks}</span>
                            <span>工程：{blueprint.engineeringTargets}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {aiStatus && <p className="lp-create-status">{aiStatus}</p>}
                {aiCandidateProposal && (
                  <div className="lp-proposal-quick-card">
                    <div>
                      <h4>{aiCandidateProposal.input.title}</h4>
                      <p>
                        {aiCandidateProposal.stageCount} 个阶段，
                        {aiCandidateProposal.videoCount} 节课
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
                      应用
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <CategoryImportDialog
        isOpen={categoryImportOpen}
        onClose={() => setCategoryImportOpen(false)}
        onSelectCategory={(cat) => void importCategoryAsPath(cat)}
        title="从收藏分类创建路径"
        subtitle="选取一个分类，把里面的视频做成一条路径"
      />
    </>
  );
}

export function LearningPathsHomeView({
  bridges,
}: {
  bridges?: LearningPathExternalBridges;
}) {
  const host = usePlayerHost();
  const [createOpen, setCreateOpen] = useState(false);
  const count = host.learningPaths.length;

  return (
    <div className="lp-studio">
      <PathDirectoryRail
        activePathId={null}
        onCreate={() => setCreateOpen(true)}
      />
      <section className="lp-studio-main">
        <header className="lp-studio-head">
          <div className="lp-studio-head-text">
            <h2>学习路径</h2>
            <p>{count === 0 ? '还没有路径' : `${count} 条路径`}</p>
          </div>
          <button
            type="button"
            className="lp-btn is-primary"
            onClick={() => setCreateOpen(true)}
          >
            新建
          </button>
        </header>
        <div className="lp-studio-empty">
          <h3>{count === 0 ? '从新建开始' : '从左侧打开一条路径'}</h3>
          <p>
            {count === 0
              ? '可以建一条空白路径，或从收藏和提示词生成。'
              : '打开后，这里会列出当前阶段的课程。'}
          </p>
        </div>
      </section>
      <LearningPathCreateDialog
        open={createOpen}
        bridges={bridges}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
