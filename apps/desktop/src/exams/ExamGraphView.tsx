import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import '../ebook/book-galaxy-view.css';
import { findStoredCoverByBookKey } from '../ebook/ebook-storage';
import {
  buildGalaxyAdjacencyMap,
  createGalaxyPhysicsState,
  DEFAULT_GALAXY_PHYSICS_CONFIG,
  stepGalaxyPhysics,
  type GalaxyPhysicsConfig,
  type GalaxyPhysicsState,
} from '../graph/galaxy-physics';
import type { EpubExamSummary } from './epub-exams';
import {
  buildExamGalaxyGraph,
  EXAM_ROOT_ID,
  truncateLabel,
  type ExamGalaxyMode,
  type ExamGalaxyStarNode,
} from './exam-graph-model';
import type { ExamReviewSchedule } from './review-schedule';

export interface ExamGraphItem {
  exam: EpubExamSummary;
  schedule: ExamReviewSchedule;
}

interface Props {
  mode: ExamGalaxyMode;
  bookKey: string;
  bookTitle: string;
  coverDataUrl: string | null;
  items: ExamGraphItem[];
  selectedId: string | null;
  externalQuery?: string;
  onSelectExam: (id: string) => void;
  onOpenExam: (exam: EpubExamSummary) => void;
  onOpenBook?: () => void;
  onSelectBookFilter?: (bookKey: string) => void;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.8;
const INITIAL_ZOOM = 0.86;

function urgencyText(schedule: ExamReviewSchedule): string {
  if (schedule.urgency === 'overdue') {
    return `逾期 ${Math.abs(schedule.daysUntil ?? 0)} 天`;
  }
  if (schedule.urgency === 'today') return '今日到期';
  if (schedule.urgency === 'notStarted') return '待交卷';
  if (schedule.urgency === 'inProgress') return '重做中';
  if (schedule.urgency === 'upcoming') return `${schedule.daysUntil} 天后`;
  return `${schedule.daysUntil ?? ''} 天后`;
}

function bookMonogram(title: string): string {
  const clean = title.replace(/[《》【】[\]()（）\s]/g, '').trim();
  if (!clean) return 'BOOK';
  return Array.from(clean).slice(0, 2).join('').toUpperCase();
}

export function ExamGraphView({
  mode,
  bookKey,
  bookTitle,
  coverDataUrl,
  items,
  selectedId,
  externalQuery = '',
  onSelectExam,
  onOpenExam,
  onOpenBook,
  onSelectBookFilter,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgInstanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const [dimensions, setDimensions] = useState({ width: 960, height: 640 });
  const [scale, setScale] = useState(INITIAL_ZOOM);
  const [pan, setPan] = useState({ x: 480, y: 320 });
  const hasCenteredRef = useRef(false);

  const [controlsOpen, setControlsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Toggles & Physics
  const [onlyDue, setOnlyDue] = useState(false);
  const [showOrbitGuides, setShowOrbitGuides] = useState(true);
  const [showSequenceArcs, setShowSequenceArcs] = useState(false);
  const [nodeSizeScale, setNodeSizeScale] = useState(1);
  const [labelFadeThreshold, setLabelFadeThreshold] = useState(0.5);
  const [physicsConfig, setPhysicsConfig] = useState<GalaxyPhysicsConfig>(
    DEFAULT_GALAXY_PHYSICS_CONFIG,
  );
  const physicsConfigRef = useRef(physicsConfig);
  physicsConfigRef.current = physicsConfig;

  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(
    () => new Set(),
  );
  const [hoveredNode, setHoveredNode] = useState<{
    node: ExamGalaxyStarNode;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  const graph = useMemo(
    () =>
      buildExamGalaxyGraph(items, {
        mode,
        bookKey,
        bookTitle,
        selectedId,
      }),
    [bookKey, bookTitle, items, mode, selectedId],
  );

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );

  const adjacency = useMemo(
    () =>
      buildGalaxyAdjacencyMap(graph.nodes, graph.links, {
        includeSequence: showSequenceArcs,
      }),
    [graph.links, graph.nodes, showSequenceArcs],
  );

  const visibleNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      if (
        node.kind === 'planet' &&
        node.parentId &&
        collapsedClusters.has(node.parentId)
      ) {
        continue;
      }
      if (onlyDue && node.kind === 'planet') {
        const u = node.schedule?.urgency;
        if (u !== 'overdue' && u !== 'today') continue;
      }
      ids.add(node.id);
    }
    return ids;
  }, [collapsedClusters, graph.nodes, onlyDue]);

  const filteredNodeIds = useMemo(() => {
    const needle = externalQuery.trim().toLowerCase();
    if (!needle) return null;
    const matched = new Set<string>([EXAM_ROOT_ID]);
    for (const node of graph.nodes) {
      const hay =
        `${node.label} ${node.bookTitle ?? ''} ${node.shortCode}`.toLowerCase();
      if (hay.includes(needle)) {
        matched.add(node.id);
        if (node.parentId) matched.add(node.parentId);
      }
    }
    return matched;
  }, [externalQuery, graph.nodes]);

  const clusterCovers = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of graph.nodes) {
      if (node.kind === 'cluster' && node.bookKey) {
        const stored = findStoredCoverByBookKey(node.bookKey);
        if (stored) {
          map.set(node.id, stored);
        }
      }
    }
    return map;
  }, [graph.nodes]);

  const clusterCoverClipIds = useMemo(() => {
    const ids = new Map<string, string>();
    let seq = 0;
    for (const node of graph.nodes) {
      if (node.kind === 'cluster' && clusterCovers.has(node.id)) {
        ids.set(node.id, `exam-cclip-${svgInstanceId}-${seq}`);
        seq += 1;
      }
    }
    return ids;
  }, [clusterCovers, graph.nodes, svgInstanceId]);

  const sunClipId = `exam-sun-clip-${svgInstanceId}`;
  const sunGradId = `exam-sun-grad-${svgInstanceId}`;

  const effectiveSunCover = useMemo(() => {
    if (coverDataUrl) return coverDataUrl;
    for (const cover of clusterCovers.values()) {
      if (cover) return cover;
    }
    for (const { exam } of items) {
      if (exam.bookKey) {
        const stored = findStoredCoverByBookKey(exam.bookKey);
        if (stored) return stored;
      }
    }
    return null;
  }, [clusterCovers, coverDataUrl, items]);

  // Physics simulation state
  const physicsRef = useRef<GalaxyPhysicsState | null>(null);
  const [livePositions, setLivePositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const animFrameRef = useRef<number | null>(null);

  const syncPositionsToReact = useCallback((state: GalaxyPhysicsState) => {
    const next: Record<string, { x: number; y: number }> = {};
    for (const [id, body] of state.bodies.entries()) {
      next[id] = { x: body.x, y: body.y };
    }
    setLivePositions(next);
  }, []);

  const ensureAnimLoop = useCallback(() => {
    if (animFrameRef.current !== null) return;
    let tickCount = 0;
    const tick = () => {
      const state = physicsRef.current;
      if (!state) {
        animFrameRef.current = null;
        return;
      }
      const moved = stepGalaxyPhysics(
        state,
        physicsConfigRef.current,
        visibleNodeIds,
      );
      const hasPinned = state.bodyList.some((body) => body.fx !== null);
      tickCount += 1;
      if (moved || tickCount <= 2) {
        syncPositionsToReact(state);
      }
      if (moved || hasPinned) {
        animFrameRef.current = window.requestAnimationFrame(tick);
      } else {
        animFrameRef.current = null;
      }
    };
    animFrameRef.current = window.requestAnimationFrame(tick);
  }, [syncPositionsToReact, visibleNodeIds]);

  const reheatSimulation = useCallback(
    (alpha = 0.55) => {
      if (!physicsRef.current) return;
      physicsRef.current.alpha = Math.max(physicsRef.current.alpha, alpha);
      ensureAnimLoop();
    },
    [ensureAnimLoop],
  );

  useEffect(() => {
    const nextState = createGalaxyPhysicsState(graph);
    if (physicsRef.current) {
      for (const [id, oldBody] of physicsRef.current.bodies.entries()) {
        const nextBody = nextState.bodies.get(id);
        if (nextBody) {
          nextBody.x = oldBody.x;
          nextBody.y = oldBody.y;
        }
      }
    }
    nextState.alpha = 0.6;
    physicsRef.current = nextState;
    syncPositionsToReact(nextState);
    ensureAnimLoop();

    return () => {
      if (animFrameRef.current !== null) {
        window.cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [ensureAnimLoop, graph, syncPositionsToReact]);

  // Measure canvas size cleanly
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setDimensions({ width: rect.width, height: rect.height });
        if (!hasCenteredRef.current) {
          hasCenteredRef.current = true;
          setPan({ x: rect.width / 2, y: rect.height / 2 });
        }
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const resetView = useCallback(() => {
    setScale(INITIAL_ZOOM);
    setPan({ x: dimensions.width / 2, y: dimensions.height / 2 });
  }, [dimensions.height, dimensions.width]);

  const focusNode = useCallback(
    (nodeId: string, nextScale?: number) => {
      const target = livePositions[nodeId] ?? nodeById.get(nodeId);
      if (!target) return;
      const targetScale = nextScale ?? Math.max(scale, 0.92);
      setScale(targetScale);
      setPan({
        x: dimensions.width / 2 - target.x * targetScale,
        y: dimensions.height / 2 - target.y * targetScale,
      });
    },
    [dimensions.height, dimensions.width, livePositions, nodeById, scale],
  );

  const focusUrgentExam = useCallback(() => {
    const target =
      graph.nodes.find((n) => n.kind === 'planet' && n.isFocus) ??
      graph.nodes.find(
        (n) =>
          n.kind === 'planet' &&
          (n.urgency === 'overdue' || n.urgency === 'today'),
      );
    if (target) {
      if (target.exam) onSelectExam(target.exam.id);
      focusNode(target.id, 1);
    }
  }, [focusNode, graph.nodes, onSelectExam]);

  const zoomAtCenter = (factor: number) => {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale * factor));
    const cx = dimensions.width / 2;
    const cy = dimensions.height / 2;
    const ratio = next / scale;
    setPan({
      x: cx - (cx - pan.x) * ratio,
      y: cy - (cy - pan.y) * ratio,
    });
    setScale(next);
  };

  // Drag state
  const pointerActionRef = useRef<
    | {
        kind: 'pan';
        startX: number;
        startY: number;
        originX: number;
        originY: number;
        moved: boolean;
      }
    | {
        kind: 'node';
        nodeId: string;
        startX: number;
        startY: number;
        moved: boolean;
      }
    | null
  >(null);

  const handleCanvasPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.exam-galaxy-dock')) return;
    pointerActionRef.current = {
      kind: 'pan',
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
      moved: false,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleNodePointerDown = (
    event: ReactPointerEvent<SVGGElement>,
    node: ExamGalaxyStarNode,
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    pointerActionRef.current = {
      kind: 'node',
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    setDraggingNodeId(node.id);
    const body = physicsRef.current?.bodies.get(node.id);
    if (body) {
      body.fx = body.x;
      body.fy = body.y;
      body.vx = 0;
      body.vy = 0;
    }
    canvasRef.current?.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const action = pointerActionRef.current;
    if (!action) return;
    const dx = event.clientX - action.startX;
    const dy = event.clientY - action.startY;
    if (Math.hypot(dx, dy) > 4) action.moved = true;

    if (action.kind === 'pan') {
      setPan({ x: action.originX + dx, y: action.originY + dy });
      return;
    }

    if (action.kind === 'node' && physicsRef.current && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const worldX = (event.clientX - rect.left - pan.x) / scale;
      const worldY = (event.clientY - rect.top - pan.y) / scale;
      const body = physicsRef.current.bodies.get(action.nodeId);
      if (body) {
        body.fx = worldX;
        body.fy = worldY;
        body.x = worldX;
        body.y = worldY;
        body.vx = 0;
        body.vy = 0;
      }
      syncPositionsToReact(physicsRef.current);
      reheatSimulation(0.3);
    }
  };

  const handleCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const action = pointerActionRef.current;
    pointerActionRef.current = null;
    if (!action) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsPanning(false);
    setDraggingNodeId(null);

    if (action.kind === 'node' && physicsRef.current) {
      const body = physicsRef.current.bodies.get(action.nodeId);
      if (body) {
        body.fx = null;
        body.fy = null;
      }
      if (action.moved) {
        reheatSimulation(0.28);
      }
    }

    if (action.kind === 'node' && !action.moved) {
      const node = nodeById.get(action.nodeId);
      if (!node) return;
      if (node.kind === 'planet' && node.exam) {
        onSelectExam(node.exam.id);
      } else if (node.kind === 'cluster') {
        setCollapsedClusters((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        });
        reheatSimulation(0.32);
      } else if (node.kind === 'sun' && mode === 'book' && onSelectBookFilter) {
        onSelectBookFilter('');
      }
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale * factor));
    const ratio = next / scale;
    setPan({
      x: px - (px - pan.x) * ratio,
      y: py - (py - pan.y) * ratio,
    });
    setScale(next);
  };

  const toggleFullscreen = async () => {
    const host = containerRef.current;
    if (!host) return;
    try {
      if (document.fullscreenElement === host) {
        await document.exitFullscreen();
      } else {
        await host.requestFullscreen();
      }
    } catch {
      // ignore fullscreen errors in non-supported environments
    }
  };

  const nodePosition = (node: ExamGalaxyStarNode) =>
    livePositions[node.id] ?? node;
  const activeHoveredId = draggingNodeId ?? hoveredNode?.node.id ?? null;
  const spotlightIds = activeHoveredId
    ? (adjacency.get(activeHoveredId) ?? new Set([activeHoveredId]))
    : null;

  const orbitGuideRadii = useMemo(() => {
    const radii = new Set<number>();
    for (const node of graph.nodes) {
      if (node.kind === 'cluster' && node.orbitRadius) {
        radii.add(
          Math.round(node.orbitRadius * physicsConfig.linkDistanceScale),
        );
      }
    }
    return [...radii].sort((a, b) => a - b);
  }, [graph.nodes, physicsConfig.linkDistanceScale]);

  const sunRadius = Math.round(34 * nodeSizeScale);
  const clusterFontSize = Math.max(
    9.5,
    Math.min(13.5, 11.2 / Math.pow(scale, 0.28)),
  );
  const planetFontSize = Math.max(
    8.5,
    Math.min(11.5, 9.8 / Math.pow(scale, 0.28)),
  );
  const dueCount = items.filter(({ schedule }) =>
    ['overdue', 'today'].includes(schedule.urgency),
  ).length;

  return (
    <section
      ref={containerRef}
      className="book-galaxy-container"
      aria-label="试卷星系视图"
    >
      <div className="exam-galaxy-hud">
        <div className="exam-galaxy-hud-left">
          <span className="book-galaxy-badge">
            {mode === 'book' ? '单书星系' : '全库星系'}
          </span>
          <strong className="book-galaxy-title">
            {mode === 'book' ? bookTitle : `全部书籍 · ${items.length} 份试卷`}
          </strong>
          <span className="book-galaxy-subtitle">
            {dueCount > 0 ? `${dueCount} 份待交` : '已稳固'}
          </span>
        </div>

        <div className="exam-galaxy-hud-actions">
          {mode === 'book' && onSelectBookFilter && (
            <button
              type="button"
              className="book-galaxy-btn"
              onClick={() => onSelectBookFilter('')}
            >
              全库视角
            </button>
          )}
          {mode === 'book' && onOpenBook && (
            <button
              type="button"
              className="book-galaxy-btn"
              onClick={onOpenBook}
            >
              打开本书
            </button>
          )}
          <button
            type="button"
            className={`book-galaxy-btn${controlsOpen ? ' is-primary' : ''}`}
            onClick={() => setControlsOpen((v) => !v)}
          >
            图谱设置
          </button>
        </div>
      </div>

      {controlsOpen && (
        <aside
          className="book-galaxy-controls-drawer"
          aria-label="图谱参数控制"
        >
          <div className="book-galaxy-controls-head">
            <span>星系控制台</span>
            <button
              type="button"
              className="book-galaxy-controls-close"
              onClick={() => setControlsOpen(false)}
            >
              关闭
            </button>
          </div>
          <div className="book-galaxy-controls-section">
            <div className="book-galaxy-controls-kicker">
              拓扑过滤 · FILTERS
            </div>
            <label className="book-galaxy-toggle-row">
              <span>仅显示待交 / 逾期试卷</span>
              <input
                type="checkbox"
                checked={onlyDue}
                onChange={(e) => setOnlyDue(e.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示同心轨道参考环</span>
              <input
                type="checkbox"
                checked={showOrbitGuides}
                onChange={(e) => setShowOrbitGuides(e.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示章节顺序弧线</span>
              <input
                type="checkbox"
                checked={showSequenceArcs}
                onChange={(e) => setShowSequenceArcs(e.target.checked)}
              />
            </label>
          </div>

          <div className="book-galaxy-controls-section">
            <div className="book-galaxy-controls-kicker">
              视觉表现 · DISPLAY
            </div>
            <div className="book-galaxy-slider-row">
              <div className="book-galaxy-slider-label">
                <span>节点尺寸比例</span>
                <strong>{nodeSizeScale.toFixed(2)}x</strong>
              </div>
              <input
                type="range"
                min="0.6"
                max="1.6"
                step="0.05"
                value={nodeSizeScale}
                onChange={(e) => setNodeSizeScale(Number(e.target.value))}
              />
            </div>
            <div className="book-galaxy-slider-row">
              <div className="book-galaxy-slider-label">
                <span>标签显现阈值 (LOD)</span>
                <strong>{labelFadeThreshold.toFixed(2)}</strong>
              </div>
              <input
                type="range"
                min="0.35"
                max="1.25"
                step="0.05"
                value={labelFadeThreshold}
                onChange={(e) => setLabelFadeThreshold(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="book-galaxy-controls-section">
            <div className="book-galaxy-controls-kicker">
              力导向物理 · PHYSICS
            </div>
            <div className="book-galaxy-slider-row">
              <div className="book-galaxy-slider-label">
                <span>节点排斥力</span>
                <strong>{physicsConfig.repelStrength.toFixed(2)}x</strong>
              </div>
              <input
                type="range"
                min="0.3"
                max="2.2"
                step="0.05"
                value={physicsConfig.repelStrength}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setPhysicsConfig((prev) => ({ ...prev, repelStrength: val }));
                  reheatSimulation(0.35);
                }}
              />
            </div>
            <div className="book-galaxy-slider-row">
              <div className="book-galaxy-slider-label">
                <span>连线引力距离</span>
                <strong>{physicsConfig.linkDistanceScale.toFixed(2)}x</strong>
              </div>
              <input
                type="range"
                min="0.6"
                max="1.8"
                step="0.05"
                value={physicsConfig.linkDistanceScale}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setPhysicsConfig((prev) => ({
                    ...prev,
                    linkDistanceScale: val,
                  }));
                  reheatSimulation(0.35);
                }}
              />
            </div>
            <div className="book-galaxy-slider-row">
              <div className="book-galaxy-slider-label">
                <span>向心聚合力</span>
                <strong>{physicsConfig.centerGravity.toFixed(2)}x</strong>
              </div>
              <input
                type="range"
                min="0.3"
                max="2.0"
                step="0.05"
                value={physicsConfig.centerGravity}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setPhysicsConfig((prev) => ({ ...prev, centerGravity: val }));
                  reheatSimulation(0.35);
                }}
              />
            </div>
            <button
              type="button"
              className="book-galaxy-btn"
              onClick={() => {
                setPhysicsConfig(DEFAULT_GALAXY_PHYSICS_CONFIG);
                setNodeSizeScale(1);
                setLabelFadeThreshold(0.55);
                reheatSimulation(0.6);
                resetView();
              }}
            >
              重置默认星系参数
            </button>
          </div>
        </aside>
      )}

      <div
        ref={canvasRef}
        className={`book-galaxy-canvas${isPanning ? ' is-panning' : ''}${
          draggingNodeId ? ' is-dragging-node' : ''
        }`}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerUp}
        onWheel={handleWheel}
      >
        <svg
          className="book-galaxy-svg"
          width={dimensions.width}
          height={dimensions.height}
          aria-label="试卷星系知识拓扑"
        >
          <defs>
            <radialGradient id={sunGradId} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ff7b54" />
              <stop offset="70%" stopColor="#e05638" />
              <stop offset="100%" stopColor="#992e18" />
            </radialGradient>
            {effectiveSunCover && (
              <clipPath id={sunClipId}>
                <circle cx="0" cy="0" r={sunRadius} />
              </clipPath>
            )}
            {graph.nodes.map((node) => {
              if (node.kind !== 'cluster') return null;
              const clipId = clusterCoverClipIds.get(node.id);
              if (!clipId) return null;
              const r =
                Math.min(20, 11.5 + node.examCount * 0.75) * nodeSizeScale;
              return (
                <clipPath key={`clip-def-${clipId}`} id={clipId}>
                  <circle cx="0" cy="0" r={r} />
                </clipPath>
              );
            })}
          </defs>

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
            {showOrbitGuides &&
              orbitGuideRadii.map((radius) => (
                <circle
                  key={`orbit-ring-${radius}`}
                  cx={0}
                  cy={0}
                  r={radius}
                  className="galaxy-orbit-ring"
                />
              ))}

            {graph.links.map((link) => {
              if (
                !visibleNodeIds.has(link.source) ||
                !visibleNodeIds.has(link.target)
              ) {
                return null;
              }
              const sourceNode = nodeById.get(link.source);
              const targetNode = nodeById.get(link.target);
              if (!sourceNode || !targetNode) return null;
              const source = nodePosition(sourceNode);
              const target = nodePosition(targetNode);
              const isSpotlightLink = spotlightIds
                ? (link.source === activeHoveredId &&
                    spotlightIds.has(link.target)) ||
                  (link.target === activeHoveredId &&
                    spotlightIds.has(link.source))
                : false;
              const isDimmedBySpotlight =
                Boolean(spotlightIds) && !isSpotlightLink;
              const isSearchDimmed =
                Boolean(filteredNodeIds) &&
                !filteredNodeIds?.has(link.source) &&
                !filteredNodeIds?.has(link.target);

              if (link.kind === 'sequence') {
                if (!showSequenceArcs) return null;
                const mx = (source.x + target.x) / 2;
                const my = (source.y + target.y) / 2 - 26;
                return (
                  <path
                    key={`seq:${link.source}:${link.target}`}
                    d={`M ${source.x} ${source.y} Q ${mx} ${my} ${target.x} ${target.y}`}
                    className={`galaxy-link-cross${
                      isSpotlightLink ? ' is-spotlight' : ''
                    }${isDimmedBySpotlight || isSearchDimmed ? ' is-dimmed' : ''}`}
                    style={
                      link.color
                        ? ({ '--link-color': link.color } as CSSProperties)
                        : undefined
                    }
                  />
                );
              }

              return (
                <line
                  key={`${link.source}:${link.target}`}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  className={`galaxy-link-orbit ${
                    link.source === EXAM_ROOT_ID ? 'is-root-spoke' : 'is-intra'
                  }${isSpotlightLink ? ' is-spotlight' : ''}${
                    isDimmedBySpotlight || isSearchDimmed ? ' is-dimmed' : ''
                  }`}
                  style={
                    link.color
                      ? ({ '--link-color': link.color } as CSSProperties)
                      : undefined
                  }
                />
              );
            })}

            {graph.nodes.map((node) => {
              if (!visibleNodeIds.has(node.id)) return null;
              const position = nodePosition(node);
              const isSun = node.kind === 'sun';
              const isCluster = node.kind === 'cluster';
              const isPlanet = node.kind === 'planet';
              const isMatch = filteredNodeIds
                ? filteredNodeIds.has(node.id)
                : true;
              const isHoveredSelf = activeHoveredId === node.id;
              const isSpotlightNeighbor = spotlightIds
                ? spotlightIds.has(node.id)
                : false;
              const isDimmed =
                (Boolean(spotlightIds) && !isSpotlightNeighbor) ||
                (Boolean(filteredNodeIds) && !isMatch);
              const isFocus = isPlanet && node.isFocus;
              const isEmphasized = isFocus || (isPlanet && node.isHighlighted);
              const displayRadius = isSun
                ? sunRadius
                : isCluster
                  ? Math.min(20, 11.5 + node.examCount * 0.75) * nodeSizeScale
                  : (node.isFocus ? 9.2 : node.isHighlighted ? 7.8 : 6.4) *
                    nodeSizeScale;
              const clusterCover = isCluster
                ? clusterCovers.get(node.id)
                : undefined;

              const t1 = labelFadeThreshold * 0.55;
              const t2 = labelFadeThreshold;
              const forceShowLabel =
                isHoveredSelf ||
                isSpotlightNeighbor ||
                isFocus ||
                node.isHighlighted ||
                (Boolean(filteredNodeIds) && isMatch);
              let planetLabelOpacity = 0;
              if (forceShowLabel) planetLabelOpacity = 1;
              else if (scale >= t2) planetLabelOpacity = 0.88;
              else if (scale > t1) {
                planetLabelOpacity = ((scale - t1) / (t2 - t1)) * 0.85;
              }

              return (
                <g
                  key={node.id}
                  className={`galaxy-node-group is-${node.kind}${
                    isEmphasized ? ' has-note' : ' no-note'
                  }${isHoveredSelf ? ' is-hovered' : ''}${
                    isSpotlightNeighbor ? ' is-neighbor' : ''
                  }${isDimmed ? ' is-dimmed' : ''}`}
                  transform={`translate(${position.x}, ${position.y})`}
                  aria-label={`${node.label} ${node.subtitle}`}
                  onPointerDown={(event) => handleNodePointerDown(event, node)}
                  onDoubleClick={(event: ReactMouseEvent<SVGGElement>) => {
                    event.stopPropagation();
                    if (isPlanet && node.exam) {
                      onOpenExam(node.exam);
                    } else if (
                      isCluster &&
                      node.bookKey &&
                      onSelectBookFilter
                    ) {
                      onSelectBookFilter(node.bookKey);
                    }
                  }}
                  onMouseEnter={(event) => {
                    const rect = canvasRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    setHoveredNode({
                      node,
                      clientX: event.clientX - rect.left,
                      clientY: event.clientY - rect.top,
                    });
                  }}
                  onMouseLeave={() => setHoveredNode(null)}
                >
                  <circle
                    r={Math.max(15, displayRadius + 6)}
                    fill="transparent"
                    className="galaxy-node-hit"
                  />

                  {isEmphasized && !isSun && (
                    <circle
                      r={displayRadius + 3.5}
                      className="galaxy-note-halo"
                      style={{ '--node-color': node.color } as CSSProperties}
                    />
                  )}

                  {isFocus && (
                    <circle
                      r={displayRadius + 8}
                      className="galaxy-current-pulse"
                      style={{ '--node-color': node.color } as CSSProperties}
                    />
                  )}

                  {isSun ? (
                    effectiveSunCover ? (
                      <>
                        <circle
                          r={displayRadius}
                          fill="#eef2f6"
                          className="galaxy-sun-circle"
                        />
                        <image
                          href={effectiveSunCover}
                          x={-displayRadius}
                          y={-displayRadius}
                          width={displayRadius * 2}
                          height={displayRadius * 2}
                          preserveAspectRatio="xMidYMid slice"
                          clipPath={`url(#${sunClipId})`}
                        />
                        <circle
                          r={displayRadius}
                          fill="none"
                          stroke="rgba(186, 91, 66, 0.45)"
                          strokeWidth="1.5"
                        />
                      </>
                    ) : (
                      <>
                        <circle
                          r={displayRadius}
                          fill={`url(#${sunGradId})`}
                          className="galaxy-node-circle"
                        />
                        <text
                          y={5}
                          textAnchor="middle"
                          className="galaxy-sun-monogram"
                        >
                          {bookMonogram(node.label)}
                        </text>
                      </>
                    )
                  ) : isCluster &&
                    clusterCover &&
                    clusterCoverClipIds.has(node.id) ? (
                    <>
                      <circle
                        r={displayRadius}
                        fill="#eef2f6"
                        className="galaxy-sun-circle"
                      />
                      <image
                        href={clusterCover}
                        x={-displayRadius}
                        y={-displayRadius}
                        width={displayRadius * 2}
                        height={displayRadius * 2}
                        preserveAspectRatio="xMidYMid slice"
                        clipPath={`url(#${clusterCoverClipIds.get(node.id)})`}
                      />
                      <circle
                        r={displayRadius}
                        fill="none"
                        stroke={node.color}
                        strokeOpacity="0.55"
                        strokeWidth="1.5"
                      />
                    </>
                  ) : (
                    <circle
                      r={displayRadius}
                      fill={node.color}
                      className="galaxy-node-circle"
                      style={{ '--node-color': node.color } as CSSProperties}
                    />
                  )}

                  {isSun ? (
                    <text
                      y={displayRadius + 16}
                      textAnchor="middle"
                      className="galaxy-sun-title"
                    >
                      {truncateLabel(node.label, 18)}
                    </text>
                  ) : isCluster ? (
                    <text
                      y={displayRadius + clusterFontSize + 4}
                      textAnchor="middle"
                      className="galaxy-node-label is-cluster-label"
                      style={{ fontSize: `${clusterFontSize}px` }}
                    >
                      {truncateLabel(node.label, 14)} ({node.examCount})
                    </text>
                  ) : (
                    planetLabelOpacity > 0 && (
                      <text
                        y={displayRadius + planetFontSize + 3}
                        textAnchor="middle"
                        className="galaxy-node-label is-planet-label"
                        style={{
                          fontSize: `${planetFontSize}px`,
                          opacity: planetLabelOpacity,
                        }}
                      >
                        {truncateLabel(node.label, scale >= 0.88 ? 20 : 12)}
                      </text>
                    )
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {hoveredNode && !draggingNodeId && (
          <div
            className="book-galaxy-tooltip"
            style={{
              left: Math.min(
                dimensions.width - 260,
                Math.max(12, hoveredNode.clientX),
              ),
              top: Math.min(
                dimensions.height - 130,
                Math.max(12, hoveredNode.clientY),
              ),
            }}
          >
            <div className="book-galaxy-tooltip-head">
              <span>{truncateLabel(hoveredNode.node.label, 26)}</span>
              {hoveredNode.node.schedule && (
                <span>{urgencyText(hoveredNode.node.schedule)}</span>
              )}
            </div>
            {hoveredNode.node.exam ? (
              <>
                <div className="book-galaxy-tooltip-meta">
                  《{hoveredNode.node.exam.bookTitle}》 ·{' '}
                  {hoveredNode.node.exam.questionCount} 题 ·{' '}
                  {hoveredNode.node.schedule?.completedRounds ?? 0} 轮
                </div>
                <div className="book-galaxy-tooltip-hint">
                  单击查看右侧解析详情 · 双击直接开始作答
                </div>
              </>
            ) : (
              <>
                <div className="book-galaxy-tooltip-meta">
                  {hoveredNode.node.subtitle}
                </div>
                <div className="book-galaxy-tooltip-hint">
                  {hoveredNode.node.kind === 'cluster'
                    ? mode === 'library'
                      ? '单击折叠子星系 · 双击聚焦本书'
                      : '单击折叠 / 展开该分组'
                    : '拖拽调整视图，滚轮缩放'}
                </div>
              </>
            )}
          </div>
        )}

        {/* Bottom-right Zoom & Focus Dock */}
        <div className="exam-galaxy-dock" aria-label="缩放与视图控制">
          <button type="button" onClick={() => zoomAtCenter(1.22)} title="放大">
            +
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => zoomAtCenter(0.82)} title="缩小">
            −
          </button>
          <button type="button" onClick={resetView} title="重置居中">
            ⟲
          </button>
          <button
            type="button"
            onClick={focusUrgentExam}
            title="定位当前/待复习试卷"
          >
            ⌖
          </button>
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            title={isFullscreen ? '退出全屏' : '全屏'}
          >
            {isFullscreen ? '✕' : '⛶'}
          </button>
        </div>
      </div>

      <footer className="exam-galaxy-legend-inline">
        <span>
          <i className="is-overdue" /> 逾期 / 今日待交
        </span>
        <span>
          <i className="is-upcoming" /> 三日内待复习
        </span>
        <span>
          <i className="is-mastered" /> 稳固 / 已掌握
        </span>
        <span>
          <i /> 未交 / 远期
        </span>
        <span>单击选中 · 双击作答 · 节点可拖拽</span>
      </footer>
    </section>
  );
}
