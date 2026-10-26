import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent, WheelEvent } from 'react';
import type { AgentCapabilities } from '../agent/capabilities';
import { runLearningPathAgentTurn } from '../agent/runtime';
import type {
  AgentCallEvent,
  AgentChatMessage,
  LearningPathProposal,
} from '../agent/types';
import { formatDuration } from './format';
import { usePlayerHost } from './host';
import {
  CheckIcon,
  CloseIcon,
  PathTreeIcon,
  PlusIcon,
  SparkleIcon,
  TerminalBoxIcon,
} from './icons';
import {
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
import type {
  LearningPathDetail,
  LearningPathNodeInput,
  LearningPathNodeKind,
  VideoInput,
} from './types';
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
        parsed.layoutMode === 'lanes'
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

export function LearningPathsHomeView({
  bridges,
}: {
  bridges?: LearningPathExternalBridges;
}) {
  const host = usePlayerHost();
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [aiTopic, setAiTopic] = useState('');
  const [aiRunning, setAiRunning] = useState(false);
  const [aiStatus, setAiStatus] = useState('');

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

  const launchCliPrompt = (cli: 'gemini' | 'claude' | 'codex') => {
    const topic = aiTopic.trim() || 'Rust 异步与并发系统编程';
    const prompt = `请使用 Seamind MCP 工具先调用 player_search_youtube 搜索真实的 YouTube 教学视频，围绕「${topic}」规划一条分阶段从左向右延伸的视频学习路径，并调用 learning_path_propose 提交预览。`;
    const escaped = prompt.replace(/"/g, '\\"');
    const cmd =
      cli === 'gemini'
        ? `gemini -i "${escaped}"`
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
    setAiStatus('正在检索 YouTube 视频并规划阶段…');
    try {
      const result = await runLearningPathAgentTurn({
        history: [],
        prompt: `请围绕「${topic}」搜索真实 YouTube 课程视频，构建一条包含 3 个递进阶段与对应视频节点的学习路径，并提交预览提案。`,
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
      } else {
        setAiStatus(result.reply);
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
          <h2>学习路径 · 视频知识树</h2>
          <p>
            按照从左向右的学习脉络组织 YouTube 视频课程。支持在底部终端直接调用{' '}
            <code>gemini</code> / <code>claude</code> / <code>codex</code>
            ，或使用内置 AI
            自动检索真实视频并生成可交互树状图、地铁轨道图与技能拓扑图。
          </p>
        </div>
        <div className="lp-home-actions">
          <button
            type="button"
            className="lp-btn"
            onClick={() => bridges?.onSendTerminalCommand?.('', false)}
          >
            <TerminalBoxIcon />
            打开底部 CLI 终端
          </button>
          <button
            type="button"
            className="lp-btn is-primary"
            onClick={() => setCreating((v) => !v)}
          >
            <PlusIcon />
            新建空白路径
          </button>
        </div>
      </div>

      <div
        className="lp-copilot-section"
        style={{ marginTop: 18, padding: '14px 16px' }}
      >
        <h4>快速让 CLI / AI 生成视频学习路径</h4>
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
            <SparkleIcon />
            {aiRunning ? '规划中…' : '内置 AI 生成预览'}
          </button>
          <button
            type="button"
            className="lp-btn"
            onClick={() => launchCliPrompt('gemini')}
            title="唤醒底部终端并用 Google Gemini CLI 搜索生成"
          >
            <TerminalBoxIcon />用 Gemini CLI 生成
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

      {host.learningPaths.length === 0 ? (
        <div style={{ marginTop: 32 }}>
          <StateMessage kind="empty" title="还没有学习路径">
            可以在上方输入主题，点击「用 Gemini CLI 生成」或「内置 AI
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

  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{
    clientX: number;
    clientY: number;
    panX: number;
    panY: number;
  } | null>(null);

  const [copilotOpen, setCopilotOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiHistory, setAiHistory] = useState<AgentChatMessage[]>([]);
  const [aiEvents, setAiEvents] = useState<AgentCallEvent[]>([]);
  const [aiReply, setAiReply] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  const [editor, setEditor] = useState<NodeEditorDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const updateStyle = (patch: Partial<StoredPathStyle>) => {
    setStyle((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage quota errors
      }
      return next;
    });
  };

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

  const fitCanvas = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !layout) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const fitScale = Math.min(
      1.05,
      Math.max(
        0.48,
        Math.min(
          (rect.width - 48) / layout.width,
          (rect.height - 48) / layout.height,
        ),
      ),
    );
    setScale(Number(fitScale.toFixed(2)));
    setPan({
      x: Math.max(16, Math.round((rect.width - layout.width * fitScale) / 2)),
      y: Math.max(16, Math.round((rect.height - layout.height * fitScale) / 2)),
    });
  }, [layout]);

  const focusNode = useCallback(
    (targetNodeId: string) => {
      const el = viewportRef.current;
      if (!el || !layout) return;
      const item = layout.nodes.find((n) => n.node.nodeId === targetNodeId);
      if (!item) return;
      const rect = el.getBoundingClientRect();
      setPan({
        x: Math.round(rect.width / 2 - (item.x + item.width / 2) * scale),
        y: Math.round(rect.height / 2 - (item.y + item.height / 2) * scale),
      });
    },
    [layout, scale],
  );

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

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('.lp-node-card, .lp-canvas-dock, button, input')) return;
    setPanning(true);
    dragStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
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
        x: start.panX + (event.clientX - start.clientX),
        y: start.panY + (event.clientY - start.clientY),
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
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = viewportRef.current?.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.1 : 0.9;
      const nextScale = Math.min(
        1.65,
        Math.max(0.42, Number((scale * factor).toFixed(2))),
      );
      if (rect) {
        const cursorX = event.clientX - rect.left;
        const cursorY = event.clientY - rect.top;
        const worldX = (cursorX - pan.x) / scale;
        const worldY = (cursorY - pan.y) / scale;
        setPan({
          x: Math.round(cursorX - worldX * nextScale),
          y: Math.round(cursorY - worldY * nextScale),
        });
      }
      setScale(nextScale);
      return;
    }
    setPan((prev) => ({
      x: prev.x - event.deltaX,
      y: prev.y - event.deltaY,
    }));
  };

  const openAddNodeModal = (parentId: string | null) => {
    const suffix = Math.random().toString(36).slice(2, 7);
    setEditor({
      mode: 'add',
      nodeId: `node-${suffix}`,
      parentId: parentId ?? '',
      kind: parentId ? 'video' : 'stage',
      title: '',
      note: '',
      videoLink: '',
      startSeconds: '0',
      optional: false,
      prerequisiteIdsText: '',
    });
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

  const sendCliForCurrentPath = (cli: 'gemini' | 'claude' | 'codex') => {
    if (!detail) return;
    const prompt = `请先调用 learning_path_get(pathId="${detail.summary.pathId}") 查看当前学习路径「${detail.summary.title}」，再用 player_search_youtube 搜索真实进阶视频，并通过 learning_path_propose(mode="append_nodes", pathId="${detail.summary.pathId}", ...) 为后续阶段补充视频节点。`;
    const escaped = prompt.replace(/"/g, '\\"');
    const cmd =
      cli === 'gemini'
        ? `gemini -i "${escaped}"`
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

  return (
    <section
      className="lp-workspace"
      data-lp-theme={style.theme}
      aria-label={`学习路径：${detail.summary.title}`}
    >
      <header className="lp-topbar">
        <div className="lp-title-group">
          <button
            type="button"
            className="lp-btn"
            onClick={() => host.go({ kind: 'learning-paths-home' })}
            title="返回全部学习路径"
          >
            ← 全部路径
          </button>
          <div className="lp-title-text">
            <h2>{detail.summary.title}</h2>
            <div className="lp-subtitle">
              <span className="lp-progress-pill">
                已学 {finishedVideos} / {totalVideos} 课
              </span>
              {detail.summary.description && (
                <span>{detail.summary.description}</span>
              )}
            </div>
          </div>
        </div>

        <div className="lp-style-group">
          {nextUp && (
            <button
              type="button"
              className="lp-btn is-primary"
              onClick={() => playNode(nextUp)}
            >
              ▶ 继续学习：{nextUp.node.title}
            </button>
          )}
          <button
            type="button"
            className="lp-btn"
            onClick={() => openAddNodeModal(null)}
          >
            <PlusIcon /> 添加节点
          </button>
          <button
            type="button"
            className="lp-btn"
            onClick={() => bridges?.onSendTerminalCommand?.('', false)}
            title="展开/聚焦全局底部 CLI 终端"
          >
            <TerminalBoxIcon /> 终端 CLI
          </button>
          <button
            type="button"
            className={`lp-btn${copilotOpen ? ' is-primary' : ''}`}
            onClick={() => setCopilotOpen((v) => !v)}
          >
            <SparkleIcon /> AI / CLI 助手
          </button>
          {bridges?.onExportMarkdownToMindmap && (
            <button
              type="button"
              className="lp-btn"
              onClick={() =>
                bridges.onExportMarkdownToMindmap?.(
                  detail.summary.title,
                  learningPathToMarkdown(detail),
                )
              }
              title="将当前视频学习路径导出为思维导图打开"
            >
              导出为导图
            </button>
          )}
          <button
            type="button"
            className="lp-btn is-danger"
            onClick={() => void deleteEntirePath()}
          >
            删除
          </button>
        </div>
      </header>

      <div className="lp-toolbar-row">
        <div className="lp-style-group">
          <div className="lp-segmented" role="group" aria-label="布局模式">
            <button
              type="button"
              className={style.layoutMode === 'tree' ? 'is-active' : ''}
              onClick={() => updateStyle({ layoutMode: 'tree' })}
            >
              横向树状流
            </button>
            <button
              type="button"
              className={style.layoutMode === 'metro' ? 'is-active' : ''}
              onClick={() => updateStyle({ layoutMode: 'metro' })}
            >
              地铁轨道流
            </button>
            <button
              type="button"
              className={style.layoutMode === 'dag' ? 'is-active' : ''}
              onClick={() => updateStyle({ layoutMode: 'dag' })}
            >
              技能拓扑图
            </button>
            <button
              type="button"
              className={style.layoutMode === 'lanes' ? 'is-active' : ''}
              onClick={() => updateStyle({ layoutMode: 'lanes' })}
            >
              阶段泳道板
            </button>
          </div>

          <div className="lp-segmented" role="group" aria-label="连线形态">
            <button
              type="button"
              className={style.connectorStyle === 'curve' ? 'is-active' : ''}
              onClick={() => updateStyle({ connectorStyle: 'curve' })}
            >
              平滑曲线
            </button>
            <button
              type="button"
              className={
                style.connectorStyle === 'orthogonal' ? 'is-active' : ''
              }
              onClick={() => updateStyle({ connectorStyle: 'orthogonal' })}
            >
              圆角折线
            </button>
            <button
              type="button"
              className={style.connectorStyle === 'metro' ? 'is-active' : ''}
              onClick={() => updateStyle({ connectorStyle: 'metro' })}
            >
              45°轨道
            </button>
          </div>
        </div>

        <div className="lp-theme-dots" role="group" aria-label="视觉风格主题">
          {THEME_OPTIONS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`lp-theme-dot${style.theme === t.id ? ' is-active' : ''}`}
              onClick={() => updateStyle({ theme: t.id })}
            >
              <span
                className="lp-swatch"
                style={{ backgroundColor: t.swatch }}
              />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="lp-body">
        <div
          ref={viewportRef}
          className={`lp-viewport${panning ? ' is-panning' : ''}`}
          onMouseDown={handleMouseDown}
          onWheel={handleWheel}
        >
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
                  <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--lp-edge)" />
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
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    left: item.x,
                    top: item.y,
                    width: item.width,
                    height: item.height,
                  }}
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
                      {item.status === 'locked' && (
                        <span className="lp-kind-tag">待解锁</span>
                      )}
                    </div>

                    <div className="lp-node-actions">
                      {video && (
                        <button
                          type="button"
                          className={`lp-icon-btn${video.finished ? ' is-done' : ''}`}
                          title={video.finished ? '标为未看' : '标为已看完'}
                          onClick={() => host.toggleWatched(video)}
                        >
                          <CheckIcon filled={video.finished} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="lp-icon-btn"
                        title="在此节点右侧添加子阶段或视频"
                        onClick={() => openAddNodeModal(node.nodeId)}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="lp-icon-btn"
                        title="编辑此节点"
                        onClick={() => openEditNodeModal(item)}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="lp-icon-btn"
                        title="移除此节点"
                        onClick={() => void deleteNode(node.nodeId)}
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  <div className="lp-node-main">
                    {video && (
                      <div
                        className="lp-thumb-wrap"
                        onClick={() => playNode(item)}
                        title="点击播放此课"
                      >
                        <img
                          src={
                            video.thumbnailUrl ??
                            thumbnailUrl(video.videoId, 'mq')
                          }
                          alt=""
                          loading="lazy"
                        />
                        <div className="lp-thumb-play">▶</div>
                        {video.durationSeconds && (
                          <span className="lp-thumb-duration">
                            {formatDuration(video.durationSeconds)}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="lp-node-info">
                      <h4
                        className={`lp-node-title${video ? ' is-clickable' : ''}`}
                        title={node.title}
                        onClick={() => {
                          if (video) playNode(item);
                        }}
                      >
                        {node.title}
                      </h4>
                      <div className="lp-node-meta">
                        {video
                          ? video.channelName || video.videoId
                          : `阶段节点 · ID: ${node.nodeId}`}
                      </div>
                    </div>
                  </div>

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

          <div className="lp-canvas-dock">
            <button
              type="button"
              onClick={() =>
                setScale((s) => Math.max(0.42, Number((s - 0.12).toFixed(2))))
              }
              title="缩小"
            >
              −
            </button>
            <span className="lp-zoom-readout">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              onClick={() =>
                setScale((s) => Math.min(1.65, Number((s + 0.12).toFixed(2))))
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
                onClick={() => focusNode(layout.nextUpNodeId!)}
                title="定位到下一节待学视频"
              >
                定位下一课
              </button>
            )}
          </div>
        </div>

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
                  一键在全局底部终端启动 Google Gemini CLI / Claude /
                  Codex，自动读取当前路径并搜索新视频扩展：
                </p>
                <div className="lp-cli-chips">
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => sendCliForCurrentPath('gemini')}
                  >
                    Gemini 续写路径
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
            </div>
          </aside>
        )}
      </div>

      {editor && (
        <div className="lp-proposal-backdrop" role="dialog" aria-modal="true">
          <form
            className="lp-proposal-modal"
            style={{ width: 'min(520px, 92vw)' }}
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
                <input
                  type="text"
                  value={editor.videoLink}
                  onChange={(e) =>
                    setEditor({ ...editor, videoLink: e.target.value })
                  }
                  placeholder="https://www.youtube.com/watch?v=... 或 11 位 videoId"
                  style={{
                    width: '100%',
                    height: 32,
                    marginTop: 4,
                    padding: '0 8px',
                  }}
                />
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
                前置依赖节点 ID（逗号分隔，用于技能拓扑汇合）
                <input
                  type="text"
                  value={editor.prerequisiteIdsText}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      prerequisiteIdsText: e.target.value,
                    })
                  }
                  placeholder="例如：vid-1, vid-2"
                  style={{
                    width: '100%',
                    height: 32,
                    marginTop: 4,
                    padding: '0 8px',
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
    </section>
  );
}
