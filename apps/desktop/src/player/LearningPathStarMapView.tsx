import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  buildLearningPathStarGraph,
  buildPathStarAdjacencyMap,
  createPathStarPhysicsState,
  DEFAULT_PATH_STAR_PHYSICS_CONFIG,
  stepPathStarPhysics,
  type LearningPathLayoutResult,
  type PathStarNode,
  type PathStarPhysicsConfig,
  type PathStarPhysicsState,
  type PositionedPathNode,
} from './learning-path-layout';
import type { LearningPathDetail } from './types';
import { thumbnailUrl } from './video-links';

export interface LearningPathStarMapViewProps {
  detail: LearningPathDetail;
  layout: LearningPathLayoutResult;
  selectedNodeId: string | null;
  focusRequest?: { nodeId: string; seq: number } | null;
  onSelectNode: (nodeId: string | null) => void;
  onPlayNode: (node: PositionedPathNode) => void;
  onEditNode?: (nodeId: string) => void;
  onAddChildNode?: (parentId: string | null) => void;
  onDeleteNode?: (nodeId: string) => void;
}

function formatDurationShort(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '';
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export default function LearningPathStarMapView({
  detail,
  layout,
  selectedNodeId,
  focusRequest,
  onSelectNode,
  onPlayNode,
  onEditNode,
  onAddChildNode,
  onDeleteNode,
}: LearningPathStarMapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 920, height: 640 });
  const [pan, setPan] = useState({ x: 460, y: 320 });
  const [scale, setScale] = useState(0.68);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Interactive node drag state
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const dragInfoRef = useRef<{
    node: PathStarNode;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);

  const [hoveredNode, setHoveredNode] = useState<{
    node: PathStarNode;
    clientX: number;
    clientY: number;
  } | null>(null);

  // Clicked node that opens the interactive Video Thumbnail Popover Card
  const [pinnedCardNodeId, setPinnedCardNodeId] = useState<string | null>(
    selectedNodeId,
  );

  useEffect(() => {
    if (selectedNodeId === null) {
      setPinnedCardNodeId(null);
    }
  }, [selectedNodeId]);

  const [searchFilter, setSearchFilter] = useState('');
  const [controlsOpen, setControlsOpen] = useState(false);

  // Obsidian-style Graph Filter & Display states (matched to BookGalaxyGraphView)
  const [onlyPending, setOnlyPending] = useState(false);
  const [showSatellites, setShowSatellites] = useState(true);
  const [showPrerequisites, setShowPrerequisites] = useState(true);
  const [showSpineLinks, setShowSpineLinks] = useState(false);
  const [showOrbitGuides, setShowOrbitGuides] = useState(false);
  const [nodeSizeScale, setNodeSizeScale] = useState(1.0);
  const [labelFadeThreshold, setLabelFadeThreshold] = useState(0.68);
  const [physicsConfig, setPhysicsConfig] = useState<PathStarPhysicsConfig>(
    DEFAULT_PATH_STAR_PHYSICS_CONFIG,
  );

  const starGraph = useMemo(
    () => buildLearningPathStarGraph(detail, layout),
    [detail, layout],
  );

  const nodeMap = useMemo(() => {
    const map = new Map<string, PathStarNode>();
    for (const n of starGraph.nodes) {
      map.set(n.id, n);
    }
    return map;
  }, [starGraph.nodes]);

  // Visible nodes based on topology filters
  const visibleNodeIds = useMemo(() => {
    const set = new Set<string>();
    const stagesWithPending = new Set<number>();
    if (onlyPending) {
      for (const n of starGraph.nodes) {
        if (
          (n.kind === 'video' || n.kind === 'checkpoint') &&
          n.status !== 'completed'
        ) {
          stagesWithPending.add(n.stageIndex);
        }
      }
    }
    for (const n of starGraph.nodes) {
      if (n.kind === 'core') {
        set.add(n.id);
        continue;
      }
      if (!showSatellites && n.kind === 'satellite') {
        continue;
      }
      if (onlyPending) {
        if (n.kind === 'stage' && stagesWithPending.has(n.stageIndex)) {
          set.add(n.id);
        } else if (n.status !== 'completed') {
          set.add(n.id);
        }
        continue;
      }
      set.add(n.id);
    }
    return set;
  }, [starGraph.nodes, onlyPending, showSatellites]);

  const visibleIdsRef = useRef<Set<string>>(visibleNodeIds);
  visibleIdsRef.current = visibleNodeIds;

  const physicsRef = useRef<PathStarPhysicsState | null>(null);
  const physicsConfigRef = useRef<PathStarPhysicsConfig>(physicsConfig);
  physicsConfigRef.current = physicsConfig;

  const [livePositions, setLivePositions] = useState<
    Record<string, { x: number; y: number }>
  >(() => {
    const initial: Record<string, { x: number; y: number }> = {};
    for (const n of starGraph.nodes) {
      initial[n.id] = { x: n.x, y: n.y };
    }
    return initial;
  });

  const syncPositionsFromPhysics = useCallback(
    (state: PathStarPhysicsState) => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const body of state.bodyList) {
        next[body.id] = { x: body.x, y: body.y };
      }
      setLivePositions(next);
    },
    [],
  );

  const rafRef = useRef<number | null>(null);
  const startSimulationLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    const tick = () => {
      const state = physicsRef.current;
      if (!state) {
        rafRef.current = null;
        return;
      }
      const keepRunning = stepPathStarPhysics(
        state,
        physicsConfigRef.current,
        visibleIdsRef.current,
      );
      syncPositionsFromPhysics(state);
      if (keepRunning) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [syncPositionsFromPhysics]);

  useEffect(() => {
    const state = createPathStarPhysicsState(starGraph);
    for (let i = 0; i < 10; i++) {
      stepPathStarPhysics(
        state,
        physicsConfigRef.current,
        visibleIdsRef.current,
      );
    }
    physicsRef.current = state;
    syncPositionsFromPhysics(state);
    startSimulationLoop();

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [starGraph, startSimulationLoop, syncPositionsFromPhysics]);

  const reheatSimulation = useCallback(
    (alpha = 0.45) => {
      const state = physicsRef.current;
      if (!state) return;
      state.alpha = Math.max(state.alpha, alpha);
      startSimulationLoop();
    },
    [startSimulationLoop],
  );

  useEffect(() => {
    reheatSimulation(0.38);
  }, [
    physicsConfig.repelStrength,
    physicsConfig.linkDistanceScale,
    physicsConfig.linkTension,
    physicsConfig.centerGravity,
    onlyPending,
    showSatellites,
    reheatSimulation,
  ]);

  const calculateAutoFit = useCallback(
    (width: number, height: number) => {
      const gw = Math.max(320, starGraph.bounds.maxX - starGraph.bounds.minX);
      const gh = Math.max(320, starGraph.bounds.maxY - starGraph.bounds.minY);
      const scaleX = (width - 96) / gw;
      const scaleY = (height - 96) / gh;
      const fitScale = Math.min(1.15, Math.max(0.28, Math.min(scaleX, scaleY)));
      return {
        scale: fitScale,
        pan: { x: width / 2, y: height / 2 },
      };
    },
    [
      starGraph.bounds.maxX,
      starGraph.bounds.maxY,
      starGraph.bounds.minX,
      starGraph.bounds.minY,
    ],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
          const fit = calculateAutoFit(width, height);
          setScale(fit.scale);
          setPan(fit.pan);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [calculateAutoFit]);

  const focusStarNode = useCallback(
    (nodeId: string, targetScale = 0.95) => {
      const node = nodeMap.get(nodeId);
      const pos = livePositions[nodeId] ?? node;
      if (!pos) return;
      setScale(targetScale);
      setPan({
        x: Math.round(dimensions.width / 2 - pos.x * targetScale),
        y: Math.round(dimensions.height / 2 - pos.y * targetScale),
      });
      setPinnedCardNodeId(nodeId);
      onSelectNode(nodeId === 'core-hub' ? null : nodeId);
    },
    [dimensions.height, dimensions.width, livePositions, nodeMap, onSelectNode],
  );

  const lastFocusSeqRef = useRef<number>(0);
  useEffect(() => {
    if (!focusRequest || focusRequest.seq === lastFocusSeqRef.current) return;
    lastFocusSeqRef.current = focusRequest.seq;
    focusStarNode(focusRequest.nodeId, 0.92);
  }, [focusRequest, focusStarNode]);

  const clientToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const localX = clientX - (rect?.left ?? 0);
      const localY = clientY - (rect?.top ?? 0);
      return {
        x: (localX - pan.x) / scale,
        y: (localY - pan.y) / scale,
        localX,
        localY,
      };
    },
    [pan.x, pan.y, scale],
  );

  const handleNodePointerDown = (
    e: ReactPointerEvent<SVGGElement>,
    node: PathStarNode,
  ) => {
    e.stopPropagation();
    const world = clientToWorld(e.clientX, e.clientY);
    dragInfoRef.current = {
      node,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    };
    setDraggingNodeId(node.id);

    const body = physicsRef.current?.bodies.get(node.id);
    if (body) {
      body.fx = world.x;
      body.fy = world.y;
      reheatSimulation(0.35);
    }

    try {
      containerRef.current
        ?.querySelector('.book-galaxy-canvas')
        ?.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('.galaxy-node-group')) return;
    if (target.closest('.book-galaxy-controls-drawer')) return;
    if (target.closest('.lp-star-video-card')) return;
    if (target.closest('.lp-starmap-dock')) return;
    setIsPanning(true);
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragInfoRef.current) {
      const info = dragInfoRef.current;
      const dist = Math.hypot(
        e.clientX - info.startClientX,
        e.clientY - info.startClientY,
      );
      if (dist >= 4) {
        info.moved = true;
      }
      const world = clientToWorld(e.clientX, e.clientY);
      const body = physicsRef.current?.bodies.get(info.node.id);
      if (body) {
        body.fx = world.x;
        body.fy = world.y;
        reheatSimulation(0.32);
      }
      setHoveredNode({
        node: info.node,
        clientX: world.localX,
        clientY: world.localY,
      });
      return;
    }

    if (!isPanning) return;
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    setPan({
      x: panStartRef.current.panX + dx,
      y: panStartRef.current.panY + dy,
    });
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragInfoRef.current) {
      const info = dragInfoRef.current;
      const body = physicsRef.current?.bodies.get(info.node.id);
      if (body) {
        if (info.node.kind === 'stage') {
          body.anchorX = body.x;
          body.anchorY = body.y;
        }
        body.fx = null;
        body.fy = null;
        reheatSimulation(0.22);
      }
      const wasClick = !info.moved;
      const clicked = info.node;
      dragInfoRef.current = null;
      setDraggingNodeId(null);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      if (wasClick) {
        const nextId = pinnedCardNodeId === clicked.id ? null : clicked.id;
        setPinnedCardNodeId(nextId);
        const realNodeId =
          clicked.kind === 'satellite'
            ? clicked.parentId
            : clicked.id === 'core-hub'
              ? null
              : clicked.id;
        onSelectNode(nextId ? realNodeId : null);
      }
      return;
    }

    if (!isPanning) return;
    const movedDist = Math.hypot(
      e.clientX - panStartRef.current.x,
      e.clientY - panStartRef.current.y,
    );
    setIsPanning(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (movedDist < 4) {
      setPinnedCardNodeId(null);
      onSelectNode(null);
    }
  };

  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.lp-star-video-card')) return;
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    const nextScale = Math.min(3.5, Math.max(0.18, scale * zoomFactor));

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      setScale(nextScale);
      return;
    }

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const nextPanX = mouseX - (mouseX - pan.x) * (nextScale / scale);
    const nextPanY = mouseY - (mouseY - pan.y) * (nextScale / scale);

    setScale(nextScale);
    setPan({ x: nextPanX, y: nextPanY });
  };

  const handleResetView = () => {
    const state = createPathStarPhysicsState(starGraph);
    for (let i = 0; i < 10; i++) {
      stepPathStarPhysics(
        state,
        physicsConfigRef.current,
        visibleIdsRef.current,
      );
    }
    physicsRef.current = state;
    syncPositionsFromPhysics(state);
    startSimulationLoop();

    const fit = calculateAutoFit(dimensions.width, dimensions.height);
    setScale(fit.scale);
    setPan(fit.pan);
    setSearchFilter('');
  };

  const handleResetPhysicsDefaults = () => {
    setPhysicsConfig(DEFAULT_PATH_STAR_PHYSICS_CONFIG);
    setNodeSizeScale(1.0);
    setLabelFadeThreshold(0.68);
    setOnlyPending(false);
    setShowSatellites(true);
    setShowPrerequisites(true);
    setShowSpineLinks(false);
    setShowOrbitGuides(false);
  };

  const adjacencyMap = useMemo(
    () =>
      buildPathStarAdjacencyMap(starGraph, {
        includeSpine: showSpineLinks,
        includePrerequisites: showPrerequisites,
      }),
    [starGraph, showSpineLinks, showPrerequisites],
  );

  const activeHoveredId =
    draggingNodeId ?? hoveredNode?.node.id ?? pinnedCardNodeId ?? null;
  const spotlightNeighborSet = useMemo(() => {
    if (!activeHoveredId) return null;
    return adjacencyMap.get(activeHoveredId) ?? new Set([activeHoveredId]);
  }, [activeHoveredId, adjacencyMap]);

  const filteredNodeIds = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return null;
    const matches = new Set<string>();
    for (const n of starGraph.nodes) {
      if (
        n.label.toLowerCase().includes(q) ||
        n.stageTitle.toLowerCase().includes(q) ||
        (n.note && n.note.toLowerCase().includes(q)) ||
        (n.video?.channelName && n.video.channelName.toLowerCase().includes(q))
      ) {
        matches.add(n.id);
      }
    }
    return matches;
  }, [starGraph.nodes, searchFilter]);

  const orbitGuideRadii = useMemo(() => {
    const set = new Set<number>();
    for (const n of starGraph.nodes) {
      if (n.kind === 'stage' && n.orbitRadius > 0) {
        set.add(Math.round(n.orbitRadius * physicsConfig.linkDistanceScale));
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [starGraph.nodes, physicsConfig.linkDistanceScale]);

  const sunRadius = Math.round(32 * nodeSizeScale);
  const coverUrl = starGraph.coverThumbnailUrl;
  const completionPct =
    starGraph.stats.totalVideos > 0
      ? Math.round(
          (starGraph.stats.completedVideos / starGraph.stats.totalVideos) * 100,
        )
      : 0;

  const clusterFontSize = Math.max(
    9.5,
    Math.min(13.5, 11.2 / Math.pow(scale, 0.28)),
  );
  const planetFontSize = Math.max(
    8.5,
    Math.min(11.5, 9.8 / Math.pow(scale, 0.28)),
  );

  // Resolve the clicked node and its parent lesson/stage for the Video Thumbnail Popover Card
  const pinnedNode = pinnedCardNodeId
    ? (nodeMap.get(pinnedCardNodeId) ?? null)
    : null;
  const pinnedLessonNode = useMemo(() => {
    if (!pinnedNode) return null;
    if (pinnedNode.kind === 'satellite' && pinnedNode.parentId) {
      return nodeMap.get(pinnedNode.parentId) ?? pinnedNode;
    }
    return pinnedNode;
  }, [nodeMap, pinnedNode]);

  const stageLessonsForCard = useMemo(() => {
    if (!pinnedLessonNode) return [];
    if (pinnedLessonNode.kind === 'core') {
      return starGraph.nodes.filter(
        (n) =>
          (n.kind === 'video' || n.kind === 'checkpoint') &&
          Boolean(n.positionedNode?.video),
      );
    }
    if (pinnedLessonNode.kind === 'stage') {
      return starGraph.nodes.filter(
        (n) =>
          n.stageIndex === pinnedLessonNode.stageIndex &&
          (n.kind === 'video' || n.kind === 'checkpoint') &&
          Boolean(n.positionedNode?.video),
      );
    }
    return [];
  }, [pinnedLessonNode, starGraph.nodes]);

  const pinnedCardScreenPos = useMemo(() => {
    if (!pinnedNode) return null;
    const pos = livePositions[pinnedNode.id] ?? pinnedNode;
    const rawX = pan.x + pos.x * scale;
    const rawY = pan.y + pos.y * scale;
    const cardW = 336;
    const cardH =
      pinnedLessonNode?.kind === 'stage' || pinnedLessonNode?.kind === 'core'
        ? 380
        : 396;
    const preferRight = rawX + 24 + cardW <= dimensions.width - 14;
    const left = preferRight
      ? Math.max(14, rawX + 22)
      : Math.max(
          14,
          Math.min(rawX - cardW - 22, dimensions.width - cardW - 14),
        );
    const top = Math.max(
      54,
      Math.min(rawY - 60, dimensions.height - cardH - 14),
    );
    return { left: Math.round(left), top: Math.round(top) };
  }, [
    dimensions.height,
    dimensions.width,
    livePositions,
    pan.x,
    pan.y,
    pinnedLessonNode?.kind,
    pinnedNode,
    scale,
  ]);

  return (
    <div className="book-galaxy-container lp-starmap-root" ref={containerRef}>
      {/* Top Header Controls — Identical structure to Image 1 (BookGalaxyGraphView) */}
      <div className="book-galaxy-header">
        <div className="book-galaxy-title-wrap">
          <span className="book-galaxy-badge">课程知识星系</span>
          <span className="book-galaxy-title">《{starGraph.title}》</span>
          <div className="book-galaxy-stats">
            <span className="book-galaxy-stat-pill">
              节点: {visibleNodeIds.size - 1}/{starGraph.nodes.length - 1}
            </span>
            <span>·</span>
            <span className="book-galaxy-stat-pill">
              已学课程: {starGraph.stats.completedVideos}/
              {starGraph.stats.totalVideos} ({completionPct}%)
            </span>
            {starGraph.stats.prerequisiteLinksCount > 0 && (
              <>
                <span>·</span>
                <span className="book-galaxy-stat-pill">
                  跨簇联动: {starGraph.stats.prerequisiteLinksCount}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="book-galaxy-actions">
          <input
            type="text"
            className="lit-text-input book-galaxy-search-input"
            placeholder="检索课程或知识节点…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
          <button
            type="button"
            className={`book-galaxy-btn ${onlyPending ? 'is-active' : ''}`}
            title="仅显示待学习与学习中的课程节点"
            onClick={() => setOnlyPending((prev) => !prev)}
          >
            仅看待学
          </button>
          <button
            type="button"
            className={`book-galaxy-btn ${controlsOpen ? 'is-active' : ''}`}
            title="打开 Obsidian 力导向物理与视图参数控制台"
            onClick={() => setControlsOpen((prev) => !prev)}
          >
            图谱参数
          </button>
          <button
            type="button"
            className="book-galaxy-btn"
            title="重排力导向布局并自适应居中缩放"
            onClick={handleResetView}
          >
            重置视角
          </button>
        </div>
      </div>

      {/* Institutional Obsidian-Style Graph Control Drawer */}
      {controlsOpen && (
        <aside
          className="book-galaxy-controls-drawer"
          aria-label="图谱物理与显示参数"
        >
          <div className="book-galaxy-controls-head">
            <span>GRAPH ENGINE · 图谱参数</span>
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
              <span>仅显示未完成课程节点</span>
              <input
                type="checkbox"
                checked={onlyPending}
                onChange={(e) => setOnlyPending(e.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示三级知识点星点</span>
              <input
                type="checkbox"
                checked={showSatellites}
                onChange={(e) => setShowSatellites(e.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示跨星域先修关联边</span>
              <input
                type="checkbox"
                checked={showPrerequisites}
                onChange={(e) => setShowPrerequisites(e.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示阶段顺序脉络线</span>
              <input
                type="checkbox"
                checked={showSpineLinks}
                onChange={(e) => setShowSpineLinks(e.target.checked)}
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
                <span>标签显现缩放阈值 (LOD)</span>
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
            <div className="book-galaxy-controls-kicker">力场引擎 · FORCES</div>
            <div className="book-galaxy-slider-row">
              <div className="book-galaxy-slider-label">
                <span>节点电荷排斥力</span>
                <strong>{physicsConfig.repelStrength.toFixed(2)}</strong>
              </div>
              <input
                type="range"
                min="0.3"
                max="2.2"
                step="0.05"
                value={physicsConfig.repelStrength}
                onChange={(e) =>
                  setPhysicsConfig((prev) => ({
                    ...prev,
                    repelStrength: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="book-galaxy-slider-row">
              <div className="book-galaxy-slider-label">
                <span>弹簧连线距离</span>
                <strong>{physicsConfig.linkDistanceScale.toFixed(2)}x</strong>
              </div>
              <input
                type="range"
                min="0.55"
                max="1.6"
                step="0.05"
                value={physicsConfig.linkDistanceScale}
                onChange={(e) =>
                  setPhysicsConfig((prev) => ({
                    ...prev,
                    linkDistanceScale: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="book-galaxy-slider-row">
              <div className="book-galaxy-slider-label">
                <span>中心向心聚拢力</span>
                <strong>{physicsConfig.centerGravity.toFixed(2)}</strong>
              </div>
              <input
                type="range"
                min="0.3"
                max="1.8"
                step="0.05"
                value={physicsConfig.centerGravity}
                onChange={(e) =>
                  setPhysicsConfig((prev) => ({
                    ...prev,
                    centerGravity: Number(e.target.value),
                  }))
                }
              />
            </div>
          </div>

          <div className="book-galaxy-controls-foot">
            <button
              type="button"
              className="book-galaxy-btn"
              onClick={() => reheatSimulation(0.65)}
            >
              重新演化力场
            </button>
            <button
              type="button"
              className="book-galaxy-btn"
              onClick={handleResetPhysicsDefaults}
            >
              恢复默认
            </button>
          </div>
        </aside>
      )}

      {/* SVG Canvas Viewport */}
      <div
        className={`book-galaxy-canvas ${isPanning ? 'is-panning' : ''} ${
          draggingNodeId ? 'is-dragging-node' : ''
        }`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
      >
        <svg
          className="book-galaxy-svg"
          width={dimensions.width}
          height={dimensions.height}
        >
          <defs>
            <clipPath id="lp-star-sun-cover-clip">
              <circle cx={0} cy={0} r={sunRadius} />
            </clipPath>

            {coverUrl && (
              <pattern
                id="lp-star-sun-cover-pattern"
                patternUnits="userSpaceOnUse"
                x={-sunRadius}
                y={-sunRadius}
                width={sunRadius * 2}
                height={sunRadius * 2}
              >
                <image
                  href={coverUrl}
                  x={0}
                  y={0}
                  width={sunRadius * 2}
                  height={sunRadius * 2}
                  preserveAspectRatio="xMidYMid slice"
                />
              </pattern>
            )}

            <radialGradient id="lpStarSunGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ff7b54" />
              <stop offset="70%" stopColor="#e05638" />
              <stop offset="100%" stopColor="#992e18" />
            </radialGradient>
          </defs>

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
            {/* Optional concentric orbital guide rings */}
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

            {/* Topological & Cross-Cluster Links */}
            {starGraph.links.map((link) => {
              if (link.kind === 'spine' && !showSpineLinks) return null;
              if (link.kind === 'prerequisite' && !showPrerequisites) {
                return null;
              }
              if (
                !visibleNodeIds.has(link.source) ||
                !visibleNodeIds.has(link.target)
              ) {
                return null;
              }

              const srcNode = nodeMap.get(link.source);
              const tgtNode = nodeMap.get(link.target);
              if (!srcNode || !tgtNode) return null;

              const srcPos = livePositions[link.source] ?? srcNode;
              const tgtPos = livePositions[link.target] ?? tgtNode;

              const isSpotlightLink = spotlightNeighborSet
                ? (link.source === activeHoveredId &&
                    spotlightNeighborSet.has(link.target)) ||
                  (link.target === activeHoveredId &&
                    spotlightNeighborSet.has(link.source)) ||
                  (nodeMap.get(activeHoveredId || '')?.kind === 'stage' &&
                    spotlightNeighborSet.has(link.source) &&
                    spotlightNeighborSet.has(link.target))
                : false;

              const isDimmedBySpotlight =
                Boolean(spotlightNeighborSet) && !isSpotlightLink;

              const isSearchDimmed =
                Boolean(filteredNodeIds) &&
                !filteredNodeIds?.has(link.source) &&
                !filteredNodeIds?.has(link.target);

              if (link.kind === 'spine') {
                return (
                  <path
                    key={link.id}
                    d={`M ${srcPos.x} ${srcPos.y} Q ${(srcPos.x + tgtPos.x) / 2} ${(srcPos.y + tgtPos.y) / 2} ${tgtPos.x} ${tgtPos.y}`}
                    className={`galaxy-link-sequence ${
                      isSpotlightLink ? 'is-spotlight' : ''
                    } ${isDimmedBySpotlight || isSearchDimmed ? 'is-dimmed' : ''}`}
                  />
                );
              }

              if (link.kind === 'prerequisite') {
                const mx = (srcPos.x + tgtPos.x) / 2;
                const my = (srcPos.y + tgtPos.y) / 2 - 28;
                return (
                  <path
                    key={link.id}
                    d={`M ${srcPos.x} ${srcPos.y} Q ${mx} ${my} ${tgtPos.x} ${tgtPos.y}`}
                    className={`galaxy-link-cross ${
                      isSpotlightLink ? 'is-spotlight' : ''
                    } ${isDimmedBySpotlight || isSearchDimmed ? 'is-dimmed' : ''}`}
                    style={
                      link.color
                        ? ({ '--link-color': link.color } as CSSProperties)
                        : undefined
                    }
                  />
                );
              }

              const isIntraCluster = link.kind !== 'core_spoke';
              const strokeColor = link.color || tgtNode.color;

              return (
                <line
                  key={link.id}
                  x1={srcPos.x}
                  y1={srcPos.y}
                  x2={tgtPos.x}
                  y2={tgtPos.y}
                  className={`galaxy-link-orbit ${
                    isIntraCluster ? 'is-intra' : 'is-root-spoke'
                  } ${isSpotlightLink ? 'is-spotlight' : ''} ${
                    isDimmedBySpotlight || isSearchDimmed ? 'is-dimmed' : ''
                  }`}
                  style={
                    strokeColor
                      ? ({ '--link-color': strokeColor } as CSSProperties)
                      : undefined
                  }
                />
              );
            })}

            {/* Star Dot Nodes — Matching BookGalaxyGraphView (Image 1) */}
            {starGraph.nodes.map((node) => {
              if (!visibleNodeIds.has(node.id)) return null;

              const pos = livePositions[node.id] ?? node;
              const isMatch = filteredNodeIds
                ? filteredNodeIds.has(node.id)
                : true;
              const isSun = node.kind === 'core';
              const isCluster = node.kind === 'stage';
              const isPlanet =
                node.kind === 'video' || node.kind === 'checkpoint';
              const isSatellite = node.kind === 'satellite';

              const isHoveredSelf = activeHoveredId === node.id;
              const isPinnedSelf = pinnedCardNodeId === node.id;
              const isSpotlightNeighbor = spotlightNeighborSet
                ? spotlightNeighborSet.has(node.id)
                : false;
              const isDimmed =
                (Boolean(spotlightNeighborSet) && !isSpotlightNeighbor) ||
                (Boolean(filteredNodeIds) && !isMatch);

              const hasVideoOrDone =
                node.status === 'completed' ||
                node.isNextUp ||
                node.kind === 'checkpoint';
              const degreeBoost = Math.min(3.5, (node.degree ?? 0) * 0.22);
              const displayRadius = isSun
                ? sunRadius
                : isCluster
                  ? (9.5 + degreeBoost) * nodeSizeScale
                  : isPlanet
                    ? ((hasVideoOrDone ? 6.2 : 4.8) + degreeBoost * 0.3) *
                      nodeSizeScale
                    : 3.1 * nodeSizeScale;

              // Semantic Zoom (LOD) label visibility calculation
              const t1 = labelFadeThreshold * 0.55;
              const t2 = labelFadeThreshold;
              const forceShowLabel =
                isHoveredSelf ||
                isPinnedSelf ||
                isSpotlightNeighbor ||
                node.isNextUp ||
                node.status === 'completed' ||
                node.kind === 'checkpoint' ||
                (Boolean(filteredNodeIds) && isMatch);

              let planetLabelOpacity = 0;
              if (forceShowLabel) {
                planetLabelOpacity = 1;
              } else if (scale >= t2) {
                planetLabelOpacity = 0.88;
              } else if (scale > t1) {
                planetLabelOpacity = ((scale - t1) / (t2 - t1)) * 0.85;
              }

              const showSatelliteLabel =
                isHoveredSelf ||
                isPinnedSelf ||
                isSpotlightNeighbor ||
                scale >= labelFadeThreshold * 1.15;

              const cleanPlanetText =
                scale >= 0.88 ||
                isHoveredSelf ||
                isPinnedSelf ||
                isSpotlightNeighbor
                  ? node.label.length > 20
                    ? `${node.label.slice(0, 20)}…`
                    : node.label
                  : node.shortCode ||
                    (node.label.length > 10
                      ? `${node.label.slice(0, 10)}…`
                      : node.label);

              return (
                <g
                  key={node.id}
                  className={`galaxy-node-group is-${
                    isSun
                      ? 'sun'
                      : isCluster
                        ? 'cluster'
                        : isPlanet
                          ? 'planet'
                          : 'satellite'
                  } ${
                    hasVideoOrDone || isPinnedSelf ? 'has-note' : 'no-note'
                  } ${isHoveredSelf || isPinnedSelf ? 'is-hovered' : ''} ${
                    isSpotlightNeighbor ? 'is-neighbor' : ''
                  } ${isDimmed ? 'is-dimmed' : ''}`}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onPointerDown={(e) => handleNodePointerDown(e, node)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (node.positionedNode?.video) {
                      onPlayNode(node.positionedNode);
                    }
                  }}
                  onMouseEnter={(e) => {
                    if (dragInfoRef.current) return;
                    const rect = containerRef.current?.getBoundingClientRect();
                    setHoveredNode({
                      node,
                      clientX: e.clientX - (rect?.left ?? 0),
                      clientY: e.clientY - (rect?.top ?? 0),
                    });
                  }}
                  onMouseLeave={() => {
                    if (dragInfoRef.current) return;
                    setHoveredNode(null);
                  }}
                >
                  {/* Invisible hit area */}
                  <circle
                    cx={0}
                    cy={0}
                    r={Math.max(14, displayRadius + 6)}
                    fill="transparent"
                  />

                  {/* Active Next-Up pulse */}
                  {node.isNextUp && (
                    <circle cx={0} cy={0} className="galaxy-current-pulse" />
                  )}

                  {/* Completed / Checkpoint / Pinned outer halo */}
                  {(hasVideoOrDone || isPinnedSelf) && !isSun && (
                    <circle
                      cx={0}
                      cy={0}
                      r={displayRadius + 3.5}
                      className="galaxy-note-halo"
                      style={
                        {
                          '--node-color': node.color,
                        } as CSSProperties
                      }
                    />
                  )}

                  {/* Central Course Sun Node with Circular Cover Cutout */}
                  {isSun ? (
                    <>
                      {coverUrl ? (
                        <circle
                          cx={0}
                          cy={0}
                          r={sunRadius}
                          fill="url(#lp-star-sun-cover-pattern)"
                          clipPath="url(#lp-star-sun-cover-clip)"
                          className="galaxy-sun-circle"
                        />
                      ) : (
                        <>
                          <circle
                            cx={0}
                            cy={0}
                            r={sunRadius}
                            fill="url(#lpStarSunGrad)"
                            className="galaxy-node-circle"
                          />
                          <text x={0} y={5} className="galaxy-sun-monogram">
                            {starGraph.title.slice(0, 2).toUpperCase()}
                          </text>
                        </>
                      )}
                      <text
                        x={0}
                        y={sunRadius + 18}
                        className="galaxy-sun-title"
                      >
                        《{starGraph.title}》
                      </text>
                    </>
                  ) : (
                    <>
                      <circle
                        cx={0}
                        cy={0}
                        r={displayRadius}
                        fill={node.color}
                        className="galaxy-node-circle"
                        style={
                          {
                            '--node-color': node.color,
                          } as CSSProperties
                        }
                      />

                      {/* Stage Cluster Label */}
                      {isCluster && (
                        <text
                          x={0}
                          y={displayRadius + 14}
                          className="galaxy-node-label"
                          style={{ fontSize: `${clusterFontSize}px` }}
                        >
                          {scale >= 0.65 ||
                          isHoveredSelf ||
                          isPinnedSelf ||
                          isSpotlightNeighbor
                            ? node.label.length > 18
                              ? `${node.label.slice(0, 18)}…`
                              : node.label
                            : node.shortCode || node.label.slice(0, 8)}
                        </text>
                      )}

                      {/* Video / Checkpoint Planet Label */}
                      {isPlanet && planetLabelOpacity > 0.04 && (
                        <text
                          x={0}
                          y={displayRadius + 11}
                          className={`galaxy-planet-badge ${
                            hasVideoOrDone || isHoveredSelf || isPinnedSelf
                              ? 'is-prominent'
                              : ''
                          }`}
                          style={{
                            fontSize: `${planetFontSize}px`,
                            opacity: planetLabelOpacity,
                          }}
                        >
                          {cleanPlanetText}
                        </text>
                      )}

                      {/* 3rd-level Knowledge Point Satellite Label */}
                      {isSatellite && showSatelliteLabel && (
                        <text
                          x={0}
                          y={displayRadius + 10}
                          className="galaxy-node-sublabel"
                          style={{ fontSize: `${planetFontSize * 0.9}px` }}
                        >
                          {node.label.length > 14
                            ? `${node.label.slice(0, 14)}…`
                            : node.label}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Bottom-left subtle Obsidian interaction legend */}
        <div className="book-galaxy-hud-hint">
          <span>单击星点：弹出视频缩略图与选集</span>
          <span>·</span>
          <span>双击星点：立即播放</span>
          <span>·</span>
          <span>拖拽：物理牵引星簇</span>
          <span>·</span>
          <span>滚轮：缩放 ({Math.round(scale * 100)}%)</span>
        </div>

        {/* Bottom-right quick zoom & next-up dock */}
        <div className="lp-starmap-dock lp-starmap-dock-right">
          <button
            type="button"
            onClick={() =>
              setScale((s) => Math.max(0.2, Number((s - 0.12).toFixed(2))))
            }
            title="缩小星图"
          >
            −
          </button>
          <span className="lp-starmap-zoom-readout">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() =>
              setScale((s) => Math.min(3.2, Number((s + 0.12).toFixed(2))))
            }
            title="放大星图"
          >
            +
          </button>
          <button type="button" onClick={handleResetView}>
            适配全景
          </button>
          {layout.nextUpNodeId && (
            <button
              type="button"
              onClick={() => focusStarNode(layout.nextUpNodeId!, 1.0)}
            >
              定位下一课
            </button>
          )}
        </div>

        {/* Lightweight Hover Tooltip (only when no card is pinned or hovering a different node) */}
        {hoveredNode &&
          !draggingNodeId &&
          hoveredNode.node.id !== pinnedCardNodeId && (
            <div
              className="book-galaxy-tooltip"
              style={{
                left: Math.min(hoveredNode.clientX, dimensions.width - 300),
                top: Math.min(hoveredNode.clientY, dimensions.height - 175),
              }}
            >
              <div className="book-galaxy-tooltip-head">
                <span>
                  {hoveredNode.node.kind === 'core'
                    ? `《${starGraph.title}》`
                    : hoveredNode.node.label}
                </span>
                <span className="book-galaxy-badge">
                  {hoveredNode.node.kind === 'core'
                    ? '课程核心'
                    : hoveredNode.node.kind === 'stage'
                      ? `星域 ${hoveredNode.node.stageIndex + 1}`
                      : hoveredNode.node.kind === 'satellite'
                        ? '知识要领'
                        : hoveredNode.node.shortCode || '视频课'}
                </span>
              </div>

              {hoveredNode.node.stageTitle &&
                hoveredNode.node.kind !== 'core' &&
                hoveredNode.node.kind !== 'stage' && (
                  <div className="book-galaxy-tooltip-meta">
                    所属星域：{hoveredNode.node.stageTitle}
                  </div>
                )}

              {hoveredNode.node.video && (
                <div className="book-galaxy-tooltip-meta">
                  频道：{hoveredNode.node.video.channelName || 'YouTube'} ·{' '}
                  {hoveredNode.node.video.durationSeconds
                    ? formatDurationShort(
                        hoveredNode.node.video.durationSeconds,
                      )
                    : '视频课程'}
                </div>
              )}

              <div
                className={`book-galaxy-tooltip-status ${
                  hoveredNode.node.status === 'completed'
                    ? 'is-has-note'
                    : 'is-no-note'
                }`}
              >
                <span>
                  {hoveredNode.node.isNextUp
                    ? '★ 当前推荐下一课（单击展开视频缩略图）'
                    : hoveredNode.node.status === 'completed'
                      ? '● 已学完该课程节点'
                      : '○ 单击星点查看视频缩略图与课程操作'}
                </span>
              </div>
            </div>
          )}

        {/* Clicked Star Dot -> Interactive Video Thumbnail Popover Card */}
        {pinnedNode && pinnedLessonNode && pinnedCardScreenPos && (
          <aside
            className="lp-star-video-card"
            style={
              {
                left: pinnedCardScreenPos.left,
                top: pinnedCardScreenPos.top,
                '--star-accent': pinnedNode.color,
              } as CSSProperties
            }
            aria-label="星点视频预览卡片"
          >
            {pinnedLessonNode.kind === 'stage' ||
            pinnedLessonNode.kind === 'core' ? (
              /* Stage Cluster / Core Hub Video Playlist Thumbnail Card */
              <>
                <div className="lp-star-vcard-stage-head">
                  <div>
                    <span className="lp-star-vcard-pill">
                      {pinnedLessonNode.kind === 'core'
                        ? '课程全星系总览'
                        : `星域 ${pinnedLessonNode.stageIndex + 1}`}
                    </span>
                    <h4>{pinnedLessonNode.label}</h4>
                  </div>
                  <button
                    type="button"
                    className="lp-star-vcard-close"
                    onClick={() => {
                      setPinnedCardNodeId(null);
                      onSelectNode(null);
                    }}
                    title="关闭卡片"
                  >
                    ✕
                  </button>
                </div>

                {pinnedLessonNode.note && (
                  <p className="lp-star-vcard-note">{pinnedLessonNode.note}</p>
                )}

                <div className="lp-star-vcard-playlist">
                  {stageLessonsForCard.map((lesson) => {
                    const vid = lesson.video;
                    if (!vid || !lesson.positionedNode) return null;
                    const thumb =
                      vid.thumbnailUrl ?? thumbnailUrl(vid.videoId, 'mq');
                    return (
                      <div
                        key={lesson.id}
                        className={`lp-star-vcard-playitem ${
                          lesson.isNextUp ? 'is-next' : ''
                        }`}
                      >
                        <button
                          type="button"
                          className="lp-star-vcard-playitem-thumb"
                          onClick={() => onPlayNode(lesson.positionedNode!)}
                          title={`立即播放：${lesson.label}`}
                        >
                          <img src={thumb} alt="" loading="lazy" />
                          {vid.durationSeconds && (
                            <span className="lp-star-vcard-duration">
                              {formatDurationShort(vid.durationSeconds)}
                            </span>
                          )}
                          <span className="lp-star-vcard-miniplay">▶</span>
                        </button>
                        <div
                          className="lp-star-vcard-playitem-info"
                          onClick={() => focusStarNode(lesson.id, 1.05)}
                        >
                          <strong>
                            {lesson.shortCode ? `${lesson.shortCode} · ` : ''}
                            {lesson.label}
                          </strong>
                          <span>
                            {vid.channelName || vid.videoId}
                            {lesson.status === 'completed'
                              ? ' · 已学完'
                              : lesson.isNextUp
                                ? ' · 下一课'
                                : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="lp-star-vcard-actions">
                  {stageLessonsForCard[0]?.positionedNode && (
                    <button
                      type="button"
                      className="book-galaxy-btn is-primary"
                      onClick={() => {
                        const nextInStage =
                          stageLessonsForCard.find(
                            (l) => l.status !== 'completed',
                          ) ?? stageLessonsForCard[0];
                        if (nextInStage?.positionedNode) {
                          onPlayNode(nextInStage.positionedNode);
                        }
                      }}
                    >
                      ▶ 播放本星域课程
                    </button>
                  )}
                  {pinnedLessonNode.kind === 'stage' && onAddChildNode && (
                    <button
                      type="button"
                      className="book-galaxy-btn"
                      onClick={() => onAddChildNode(pinnedLessonNode.id)}
                    >
                      + 添加视频
                    </button>
                  )}
                  {pinnedLessonNode.kind === 'stage' && onEditNode && (
                    <button
                      type="button"
                      className="book-galaxy-btn"
                      onClick={() => onEditNode(pinnedLessonNode.id)}
                    >
                      编辑星域
                    </button>
                  )}
                </div>
              </>
            ) : (
              /* Single Video / Checkpoint / Satellite Institutional Dossier Card */
              <>
                <header className="lp-star-vcard-inst-head">
                  <div className="lp-star-vcard-top-badges">
                    <span className="lp-star-vcard-pill">
                      NODE{' '}
                      {pinnedLessonNode.shortCode ||
                        `#${pinnedLessonNode.orderIndex ?? 1}`}
                    </span>
                    <span
                      className={`lp-star-vcard-status is-${pinnedLessonNode.status}`}
                    >
                      {pinnedLessonNode.isNextUp
                        ? '下一课'
                        : pinnedLessonNode.status === 'completed'
                          ? '已完成'
                          : pinnedLessonNode.kind === 'checkpoint'
                            ? '里程碑'
                            : pinnedLessonNode.optional
                              ? '选修'
                              : '待学习'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="lp-star-vcard-close"
                    onClick={() => {
                      setPinnedCardNodeId(null);
                      onSelectNode(null);
                    }}
                    title="关闭节点卡片"
                  >
                    ✕
                  </button>
                </header>

                <div className="lp-star-vcard-body">
                  {pinnedNode.kind === 'satellite' && (
                    <div className="lp-star-vcard-sat-focus">
                      当前点击知识星点：<strong>{pinnedNode.label}</strong>
                    </div>
                  )}

                  <div className="lp-star-vcard-media-row">
                    {pinnedLessonNode.video ? (
                      <button
                        type="button"
                        className="lp-star-vcard-thumb-compact"
                        onClick={() => {
                          if (pinnedLessonNode.positionedNode) {
                            onPlayNode(pinnedLessonNode.positionedNode);
                          }
                        }}
                        title={`点击立即播放：${pinnedLessonNode.label}`}
                      >
                        <img
                          src={
                            pinnedLessonNode.video.thumbnailUrl ??
                            thumbnailUrl(pinnedLessonNode.video.videoId, 'mq')
                          }
                          alt={pinnedLessonNode.label}
                        />
                        <span className="lp-star-vcard-miniplay">▶</span>
                        {pinnedLessonNode.video.durationSeconds && (
                          <span className="lp-star-vcard-duration">
                            {formatDurationShort(
                              pinnedLessonNode.video.durationSeconds,
                            )}
                          </span>
                        )}
                        <div className="lp-star-vcard-progress">
                          <div
                            style={{
                              width: `${Math.round(
                                pinnedLessonNode.progressRatio * 100,
                              )}%`,
                            }}
                          />
                        </div>
                      </button>
                    ) : (
                      <div className="lp-star-vcard-no-video">
                        <span>STAGE // CHECKPOINT</span>
                      </div>
                    )}

                    <div className="lp-star-vcard-media-info">
                      <h4 className="lp-star-vcard-title">
                        {pinnedLessonNode.label}
                      </h4>
                      <div className="lp-star-vcard-submeta">
                        <span>{pinnedLessonNode.stageTitle}</span>
                        {pinnedLessonNode.video?.channelName && (
                          <>
                            <span>·</span>
                            <span>{pinnedLessonNode.video.channelName}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {pinnedLessonNode.note && (
                    <p className="lp-star-vcard-note">
                      {pinnedLessonNode.note}
                    </p>
                  )}

                  {pinnedLessonNode.knowledgeTopics.length > 0 && (
                    <div className="lp-star-vcard-topics">
                      {pinnedLessonNode.knowledgeTopics.map((topic, idx) => {
                        const satId = `${pinnedLessonNode.id}::sat-${idx}`;
                        const isTopicActive = pinnedNode.id === satId;
                        return (
                          <button
                            key={satId}
                            type="button"
                            className={`lp-star-vcard-topic-chip ${
                              isTopicActive ? 'is-active' : ''
                            }`}
                            onClick={() =>
                              setPinnedCardNodeId(
                                isTopicActive ? pinnedLessonNode.id : satId,
                              )
                            }
                          >
                            {topic}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {(pinnedLessonNode.prerequisiteIds.length > 0 ||
                    pinnedLessonNode.dependentIds.length > 0) && (
                    <div className="lp-star-vcard-deps">
                      {pinnedLessonNode.prerequisiteIds.length > 0 && (
                        <div className="lp-star-vcard-dep-row">
                          <span className="lp-star-vcard-dep-label">先修</span>
                          {pinnedLessonNode.prerequisiteIds.map((reqId) => {
                            const req = nodeMap.get(reqId);
                            if (!req) return null;
                            return (
                              <button
                                key={`req-${reqId}`}
                                type="button"
                                className="lp-star-vcard-dep-chip is-prereq"
                                onClick={() => focusStarNode(reqId, 1.0)}
                                title={`跳转到先修节点：${req.label}`}
                              >
                                ← {req.shortCode || req.label.slice(0, 8)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {pinnedLessonNode.dependentIds.length > 0 && (
                        <div className="lp-star-vcard-dep-row">
                          <span className="lp-star-vcard-dep-label">后续</span>
                          {pinnedLessonNode.dependentIds.map((depId) => {
                            const dep = nodeMap.get(depId);
                            if (!dep) return null;
                            return (
                              <button
                                key={`dep-${depId}`}
                                type="button"
                                className="lp-star-vcard-dep-chip is-unlock"
                                onClick={() => focusStarNode(depId, 1.0)}
                                title={`跳转到后续课程：${dep.label}`}
                              >
                                {dep.shortCode || dep.label.slice(0, 8)} →
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="lp-star-vcard-actions">
                  {pinnedLessonNode.positionedNode?.video && (
                    <button
                      type="button"
                      className="book-galaxy-btn is-primary"
                      onClick={() =>
                        onPlayNode(pinnedLessonNode.positionedNode!)
                      }
                    >
                      ▶ 立即播放
                    </button>
                  )}
                  {onEditNode && (
                    <button
                      type="button"
                      className="book-galaxy-btn"
                      onClick={() => onEditNode(pinnedLessonNode.id)}
                    >
                      编辑节点
                    </button>
                  )}
                  {onAddChildNode && (
                    <button
                      type="button"
                      className="book-galaxy-btn"
                      onClick={() => onAddChildNode(pinnedLessonNode.id)}
                    >
                      + 子课
                    </button>
                  )}
                  {onDeleteNode && (
                    <button
                      type="button"
                      className="book-galaxy-btn"
                      onClick={() => onDeleteNode(pinnedLessonNode.id)}
                    >
                      删除
                    </button>
                  )}
                </div>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
