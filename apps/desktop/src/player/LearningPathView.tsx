import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent, WheelEvent } from 'react';
import '../ebook/book-galaxy-view.css';
import type { AgentCapabilities } from '../agent/capabilities';
import {
  LEARNING_PATH_BUDGET,
  noteSessionResolution,
  runAgentSession,
  agentProfiles,
} from '../agent/runtime';
import type {
  AgentCallEvent,
  AgentChatMessage,
  LearningPathProposal,
} from '../agent/types';
import { formatDuration } from './format';
import { usePlayerHost } from './host';
import { CloseIcon } from './icons';
import {
  CategoryImportDialog,
  LearningPathCreateDialog,
  PathDirectoryRail,
} from './learning-path-studio';
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
  type LearningPathDetail,
  type LearningPathNodeInput,
  type LearningPathNodeKind,
  type VideoInput,
} from './types';
import { extractProposalFromText } from './learning-path-parser';
import LearningPathStarMapView from './LearningPathStarMapView';
import {
  compileAcademicEngineeringPrompt,
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
    session?: {
      noteResolution(decision: 'confirmed' | 'rejected'): void;
    },
  ) => void;
  onExportMarkdownToMindmap?: (title: string, markdown: string) => void;
}

export { LearningPathsHomeView } from './learning-path-studio';

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
    'directory' | 'constellation' | 'course' | 'overview'
  >('directory');
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
  const [aiPaused, setAiPaused] = useState(false);

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
  const [directoryStageId, setDirectoryStageId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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
    setDirectoryStageId(null);
    setCanvasMode('directory');
    lastGraphModeRef.current = 'course';
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
      let loaded = await playerApi.learningPathGet(pathId);
      if (
        loaded &&
        pathId === HACKER_CONSTELLATION_PATH_ID &&
        loaded.nodes.length < HACKER_LEARNING_PATH_PRESET.nodes.length
      ) {
        loaded = await playerApi.learningPathSave(HACKER_LEARNING_PATH_PRESET);
        void host.reloadOverview();
      }
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
  }, [host, pathId]);

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
    const prompt = compileAcademicEngineeringPrompt(
      aiPrompt.trim() || detail.summary.title,
      'constellation',
      {
        targetPathId: detail.summary.pathId,
        targetPathTitle: detail.summary.title,
        mode: 'append_nodes',
      },
    );
    const escaped = prompt.replace(/"/g, '\\"').replace(/\r?\n+/g, ' ');
    const cmd =
      cli === 'agy'
        ? `agy -i "${escaped}"`
        : cli === 'claude'
          ? `claude "${escaped}"`
          : `codex "${escaped}"`;
    bridges?.onSendTerminalCommand?.(cmd, true);
  };

  const noteLearningPathResolution = (decision: 'confirmed' | 'rejected') => {
    setAiHistory((prev) =>
      noteSessionResolution(
        prev,
        decision === 'confirmed'
          ? '用户已确认并保存了这份学习路径提案。'
          : '用户拒绝了这份学习路径提案，路径没有变化。',
      ),
    );
    setAiPaused(false);
  };

  const submitCopilotPrompt = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || !aiPrompt.trim() || aiBusy || aiPaused) return;
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
    const compiledTurnPrompt = compileAcademicEngineeringPrompt(
      aiPrompt.trim(),
      'constellation',
      {
        targetPathId: detail.summary.pathId,
        targetPathTitle: detail.summary.title,
        mode: 'append_nodes',
      },
    );
    const activePathSummary = {
      pathId: detail.summary.pathId,
      title: detail.summary.title,
      nodeCount: detail.summary.nodeCount,
      videoCount: detail.summary.videoCount,
      finishedCount: detail.summary.finishedCount,
    };
    try {
      const turn = await runAgentSession({
        profile: agentProfiles['learning-path'],
        history: aiHistory,
        prompt: compiledTurnPrompt,
        provider: bridges.aiProvider,
        capabilities: bridges.agentCapabilities,
        contextMessages: [
          {
            role: 'system',
            content: `当前正在查看的学习路径：${JSON.stringify(activePathSummary)}。若用户要求在此路径上补充或修改，请优先调用 learning_path_get 读取完整节点后再使用 append_nodes 或 replace。`,
          },
        ],
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
        if (bridges.onPreviewLearningPathProposal) {
          setAiPaused(true);
          bridges.onPreviewLearningPathProposal(
            turn.learningPathProposal,
            'ai',
            {
              noteResolution: noteLearningPathResolution,
            },
          );
        }
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

  const aiRound = aiEvents.reduce(
    (max, event) => (event.kind === 'model' ? Math.max(max, event.round) : max),
    0,
  );
  const aiToolCount = aiEvents.filter((event) => event.kind === 'tool').length;
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
  const activeStage =
    stageOverview.find((stage) => stage.nodeId === directoryStageId) ??
    stageOverview.find((stage) => stage.isCurrent) ??
    stageOverview[0] ??
    null;
  const directoryLessons = (() => {
    if (!activeStage) return [];
    const inStage = layout.nodes.filter(
      (item) => item.stageIndex === activeStage.index,
    );
    const rows = inStage.filter((item) => {
      const bareStage =
        item.node.nodeId === activeStage.nodeId &&
        item.node.kind === 'stage' &&
        !item.video;
      return !bareStage;
    });
    return [...rows].sort((a, b) => {
      const ao = a.orderIndex ?? a.node.position;
      const bo = b.orderIndex ?? b.node.position;
      return ao - bo || a.node.position - b.node.position;
    });
  })();

  return (
    <section
      className={`lp-workspace${canvasMode === 'directory' ? ' is-directory' : ''}`}
      data-lp-theme={style.theme}
      data-lp-density={
        canvasMode === 'course' && scale < 0.85 ? 'compact' : 'full'
      }
      aria-label={`学习路径：${detail.summary.title}`}
    >
      {canvasMode !== 'directory' && (
        <>
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
                        onClick={() =>
                          setDescriptionExpanded((value) => !value)
                        }
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
                className={
                  (canvasMode as string) === 'directory' ? 'is-active' : ''
                }
                aria-pressed={(canvasMode as string) === 'directory'}
                onClick={() => setCanvasMode('directory')}
              >
                目录
              </button>
              <button
                type="button"
                className={canvasMode === 'constellation' ? 'is-active' : ''}
                aria-pressed={canvasMode === 'constellation'}
                onClick={() => {
                  lastGraphModeRef.current = 'constellation';
                  setCanvasMode('constellation');
                }}
              >
                星图
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
                图谱
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
                  (
                    event.currentTarget.parentElement as HTMLDetailsElement
                  ).open = false;
                }}
              >
                <button
                  type="button"
                  onClick={() =>
                    setVideoPickerState({
                      isOpen: true,
                      title: '选取课程视频加入知识树',
                      subtitle:
                        '从收藏、播放历史、关注频道或 YouTube 搜索中选取',
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
                    className={
                      canvasMode === 'constellation' ? 'is-active' : ''
                    }
                    aria-pressed={canvasMode === 'constellation'}
                    onClick={() => {
                      lastGraphModeRef.current = 'constellation';
                      setCanvasMode('constellation');
                    }}
                  >
                    <span>星图</span>
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
                    <span>图谱</span>
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
                        <span className="lp-menu-check">
                          {active ? '✓' : ''}
                        </span>
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
                        <span className="lp-menu-check">
                          {active ? '✓' : ''}
                        </span>
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
                  (
                    event.currentTarget.parentElement as HTMLDetailsElement
                  ).open = false;
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
        </>
      )}

      <div className="lp-body">
        {canvasMode === 'directory' ? (
          <div className="lp-studio">
            <PathDirectoryRail
              activePathId={pathId}
              stages={stageOverview}
              activeStageId={activeStage?.nodeId ?? null}
              onSelectStage={(stageId) => {
                setDirectoryStageId(stageId);
                setSelectedNodeId(null);
              }}
              onCreate={() => setCreateOpen(true)}
            />
            <section className="lp-studio-main">
              <header className="lp-studio-head">
                <div className="lp-studio-head-text">
                  <h2 title={detail.summary.title}>{detail.summary.title}</h2>
                  <p>
                    {activeStage
                      ? `阶段 ${String(activeStage.index + 1).padStart(2, '0')} · ${activeStage.title}`
                      : '还没有阶段'}
                    <span>
                      已学 {finishedVideos} / {totalVideos} 课
                    </span>
                  </p>
                </div>
                <div ref={toolbarRef} className="lp-studio-head-actions">
                  {nextUp && (
                    <button
                      type="button"
                      className="lp-btn is-primary"
                      onClick={() => playNode(nextUp)}
                      title={nextUp.node.title}
                    >
                      继续学习
                    </button>
                  )}
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => {
                      lastGraphModeRef.current = 'constellation';
                      setCanvasMode('constellation');
                    }}
                  >
                    星图
                  </button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => {
                      lastGraphModeRef.current = 'course';
                      setCanvasMode('course');
                    }}
                  >
                    图谱
                  </button>
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={() => setCreateOpen(true)}
                  >
                    新建
                  </button>
                  <details className="lp-menu">
                    <summary className="lp-btn">添加</summary>
                    <div
                      className="lp-menu-panel"
                      onClick={(event) => {
                        (
                          event.currentTarget
                            .parentElement as HTMLDetailsElement
                        ).open = false;
                      }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setVideoPickerState({
                            isOpen: true,
                            title: '选取课程视频',
                            subtitle: '从收藏、播放历史、关注频道或搜索中选取',
                            multiple: true,
                            parentId: activeStage?.nodeId ?? null,
                          })
                        }
                      >
                        <span>选取视频</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => openAddNodeModal(null, 'stage')}
                      >
                        <span>新增阶段</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setCategoryImportActiveOpen(true)}
                      >
                        <span>从收藏导入</span>
                      </button>
                    </div>
                  </details>
                  <details className="lp-menu lp-more-menu">
                    <summary className="lp-btn">更多</summary>
                    <div
                      className="lp-menu-panel"
                      onClick={(event) => {
                        (
                          event.currentTarget
                            .parentElement as HTMLDetailsElement
                        ).open = false;
                      }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          bridges?.onSendTerminalCommand?.('', false)
                        }
                      >
                        <span>终端</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedNodeId(null);
                          setCopilotOpen((value) => !value);
                        }}
                      >
                        <span>AI 规划</span>
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
                        </button>
                      )}
                      <button
                        type="button"
                        className="is-danger"
                        onClick={() => void deleteEntirePath()}
                      >
                        <span>删除路径</span>
                      </button>
                    </div>
                  </details>
                </div>
              </header>
              {activeStage?.note && (
                <p className="lp-studio-stage-note">{activeStage.note}</p>
              )}
              <div className="lp-studio-lessons">
                {directoryLessons.length === 0 ? (
                  <div className="lp-studio-empty">
                    <h3>这个阶段还没有课程</h3>
                    <button
                      type="button"
                      className="lp-btn is-primary"
                      onClick={() =>
                        setVideoPickerState({
                          isOpen: true,
                          title: '选取课程视频',
                          multiple: true,
                          parentId: activeStage?.nodeId ?? null,
                        })
                      }
                    >
                      添加课程
                    </button>
                  </div>
                ) : (
                  directoryLessons.map((item) => {
                    const open = selectedNodeId === item.node.nodeId;
                    const video = item.video;
                    const meta = [
                      video?.channelName,
                      video?.durationSeconds
                        ? formatDuration(video.durationSeconds)
                        : null,
                      item.node.optional ? '选修' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ');
                    const indexLabel =
                      item.orderIndex !== null
                        ? String(item.orderIndex).padStart(2, '0')
                        : item.node.kind === 'checkpoint'
                          ? '终'
                          : '—';
                    const statusLabel = item.isNextUp
                      ? '下一课'
                      : item.status === 'completed'
                        ? '已学'
                        : item.status === 'in_progress'
                          ? '在看'
                          : item.status === 'locked'
                            ? '待解锁'
                            : item.node.kind === 'checkpoint'
                              ? '里程碑'
                              : '待学习';
                    return (
                      <article
                        key={item.node.nodeId}
                        className={[
                          'lp-lesson',
                          open ? 'is-open' : '',
                          item.isNextUp ? 'is-next' : '',
                          item.status === 'completed' ? 'is-done' : '',
                          item.status === 'locked' ? 'is-locked' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <button
                          type="button"
                          className="lp-lesson-row"
                          aria-expanded={open}
                          onClick={() => selectNode(item.node.nodeId)}
                        >
                          <span className="lp-lesson-index">{indexLabel}</span>
                          <span className="lp-lesson-title">
                            {item.node.title}
                          </span>
                          <span className="lp-lesson-meta">{meta}</span>
                          <span
                            className={`lp-lesson-status is-${item.isNextUp ? 'next' : item.status}`}
                          >
                            {statusLabel}
                          </span>
                        </button>
                        {open && (
                          <div className="lp-lesson-panel">
                            {video && (
                              <button
                                type="button"
                                className="lp-lesson-thumb"
                                onClick={() => playNode(item)}
                                aria-label={`播放 ${item.node.title}`}
                              >
                                <img
                                  src={
                                    video.thumbnailUrl ??
                                    thumbnailUrl(video.videoId, 'mq')
                                  }
                                  alt=""
                                />
                                {video.durationSeconds ? (
                                  <span>
                                    {formatDuration(video.durationSeconds)}
                                  </span>
                                ) : null}
                              </button>
                            )}
                            <div className="lp-lesson-detail">
                              <p className={item.node.note ? '' : 'is-muted'}>
                                {item.node.note || '没有笔记'}
                              </p>
                              <div className="lp-lesson-actions">
                                {video && (
                                  <button
                                    type="button"
                                    className="lp-btn is-primary"
                                    onClick={() => playNode(item)}
                                  >
                                    播放
                                  </button>
                                )}
                                {video && (
                                  <button
                                    type="button"
                                    className="lp-btn"
                                    onClick={() => host.toggleWatched(video)}
                                  >
                                    {video.finished ? '撤销已看' : '标记已看'}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="lp-btn"
                                  onClick={() => openEditNodeModal(item)}
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="lp-btn is-danger"
                                  onClick={() =>
                                    void deleteNode(item.node.nodeId)
                                  }
                                >
                                  移除
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        ) : (
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
                  const item = layout.nodes.find(
                    (n) => n.node.nodeId === nodeId,
                  );
                  if (item) openEditNodeModal(item);
                }}
                onAddChildNode={(parentId) =>
                  openAddNodeModal(parentId, 'video')
                }
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
                        <span
                          className="lp-overview-progress"
                          aria-hidden="true"
                        >
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
                              <span className="lp-kind-tag is-next">
                                下一课
                              </span>
                            )}
                            {node.kind === 'checkpoint' && (
                              <span className="lp-kind-tag">里程碑</span>
                            )}
                            {node.optional && (
                              <span className="lp-kind-tag">选修</span>
                            )}
                            {item.status === 'completed' && (
                              <span className="lp-kind-tag is-done">
                                已完成
                              </span>
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
                              <span
                                className="lp-node-title"
                                title={node.title}
                              >
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
        )}

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
                <h4>内置 AI 学术×工程扩充助手</h4>
                <p>
                  点击下方预设算子或输入深度扩充指令（自动携带「学术理论 ×
                  底层工程」多批次检索规范）：
                </p>
                <div className="lp-copilot-preset-chips">
                  {[
                    {
                      tag: 'ACAD',
                      label: '补齐名校理论课 (MIT/CMU/Stanford)',
                      prompt:
                        '为当前路径各阶段检索并补齐 MIT / CMU / Stanford / Berkeley 名校公开课理论讲座与形式化模型推导节点（共新增 12–20 节长视频），完善跨阶段 prerequisiteIds。',
                    },
                    {
                      tag: 'ENG',
                      label: '补齐底层源码剖析与调试实验',
                      prompt:
                        '为当前路径各阶段检索并补齐内核/编译器/协议栈源码级剖析、GDB/Wireshark/eBPF 现场调试与高校经典 Lab 实战视频（共新增 12–20 节深度工程课）。',
                    },
                    {
                      tag: 'CONF',
                      label: '增补顶会案例与阶段里程碑',
                      prompt:
                        '检索 USENIX / OSDI / DEF CON / Black Hat / CppCon 工业顶会深度演讲，在各星域交汇处增补综合工程实战与 kind="checkpoint" 里程碑节点。',
                    },
                    {
                      tag: 'FULL',
                      label: '重构升级为 50+ 节点双螺旋巨型星图',
                      prompt:
                        '按照「学术理论基座 × 工业底层工程双螺旋」标准，对当前路径进行全面重构与大规模扩充（规划 7–10 个知识星域、45–60+ 节长视频课程，每个节点 note 标注【学术基座】/【工程实现】及 4–6 个三级知识卫星术语）。',
                    },
                  ].map((item) => (
                    <button
                      key={item.tag}
                      type="button"
                      className="lp-copilot-preset-chip"
                      onClick={() => setAiPrompt(item.prompt)}
                    >
                      <span className="lp-copilot-preset-tag">{item.tag}</span>
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
                <textarea
                  className="lp-copilot-textarea"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  placeholder="输入你的学术理论或底层工程扩展需求…"
                />
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button
                    type="submit"
                    className="lp-btn is-primary"
                    disabled={aiBusy || aiPaused || !aiPrompt.trim()}
                  >
                    {aiBusy
                      ? `第 ${aiRound || 1}/${LEARNING_PATH_BUDGET.maxRounds} 轮 · 工具 ${aiToolCount}/${LEARNING_PATH_BUDGET.maxToolCalls}`
                      : aiPaused
                        ? '等待确认这一段'
                        : '生成修改预览'}
                  </button>
                </div>
              </form>

              {aiEvents.length > 0 && (
                <div className="lp-copilot-events">
                  {aiEvents.map((ev) => (
                    <div key={ev.id} className="lp-copilot-event">
                      {ev.kind === 'model'
                        ? `第 ${ev.round}/${LEARNING_PATH_BUDGET.maxRounds} 轮模型推理 · 工具 ${aiToolCount}/${LEARNING_PATH_BUDGET.maxToolCalls}（${ev.status === 'running' ? '思考中…' : '完成'}）`
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
                      if (!bridges?.onPreviewLearningPathProposal) return;
                      setAiPaused(true);
                      bridges.onPreviewLearningPathProposal(
                        activeAiCandidate,
                        'ai',
                        { noteResolution: noteLearningPathResolution },
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

      <LearningPathCreateDialog
        open={createOpen}
        bridges={bridges}
        onClose={() => setCreateOpen(false)}
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
