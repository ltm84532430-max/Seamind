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

export interface LearningPathStarMapViewProps {
  detail: LearningPathDetail;
  layout: LearningPathLayoutResult;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onPlayNode: (node: PositionedPathNode) => void;
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
  onSelectNode,
  onPlayNode,
}: LearningPathStarMapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 620 });
  const [pan, setPan] = useState({ x: 450, y: 310 });
  const [scale, setScale] = useState(0.72);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

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

  const [searchFilter, setSearchFilter] = useState('');
  const [controlsOpen, setControlsOpen] = useState(false);

  // Star-Map Topology & Display Filters
  const [hideOptional, setHideOptional] = useState(false);
  const [showPrerequisites, setShowPrerequisites] = useState(true);
  const [showSpineLinks, setShowSpineLinks] = useState(true);
  const [showOrbitGuides, setShowOrbitGuides] = useState(true);
  const [nodeSizeScale, setNodeSizeScale] = useState(1.0);
  const [labelFadeThreshold, setLabelFadeThreshold] = useState(0.65);
  const [physicsConfig, setPhysicsConfig] = useState<PathStarPhysicsConfig>(
    DEFAULT_PATH_STAR_PHYSICS_CONFIG,
  );

  const starGraph = useMemo(
    () => buildLearningPathStarGraph(detail, layout),
    [detail, layout],
  );

  const visibleNodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const n of starGraph.nodes) {
      if (hideOptional && n.optional) continue;
      set.add(n.id);
    }
    return set;
  }, [starGraph.nodes, hideOptional]);

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
    for (let i = 0; i < 12; i++) {
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
    hideOptional,
    reheatSimulation,
  ]);

  const calculateAutoFit = useCallback(
    (width: number, height: number) => {
      const gw = Math.max(360, starGraph.bounds.maxX - starGraph.bounds.minX);
      const gh = Math.max(360, starGraph.bounds.maxY - starGraph.bounds.minY);
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
        ?.querySelector('.lp-starmap-canvas')
        ?.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.lp-star-node-group')) return;
    if ((e.target as HTMLElement).closest('.lp-starmap-drawer')) return;
    if ((e.target as HTMLElement).closest('.lp-starmap-subheader')) return;
    if ((e.target as HTMLElement).closest('.lp-starmap-dock')) return;
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
        if (clicked.id === 'core-hub') {
          onSelectNode(null);
        } else {
          onSelectNode(selectedNodeId === clicked.id ? null : clicked.id);
        }
      }
      return;
    }

    if (!isPanning) return;
    setIsPanning(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    const nextScale = Math.min(3.2, Math.max(0.2, scale * zoomFactor));

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
    for (let i = 0; i < 12; i++) {
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

  const focusStarNode = (nodeId: string, targetScale = 1.05) => {
    const pos = livePositions[nodeId];
    if (!pos) return;
    setScale(targetScale);
    setPan({
      x: Math.round(dimensions.width / 2 - pos.x * targetScale),
      y: Math.round(dimensions.height / 2 - pos.y * targetScale),
    });
    onSelectNode(nodeId);
  };

  const nodeMap = useMemo(() => {
    const map = new Map<string, PathStarNode>();
    for (const n of starGraph.nodes) {
      map.set(n.id, n);
    }
    return map;
  }, [starGraph.nodes]);

  const adjacencyMap = useMemo(
    () =>
      buildPathStarAdjacencyMap(starGraph, {
        includeSpine: showSpineLinks,
        includePrerequisites: showPrerequisites,
      }),
    [starGraph, showSpineLinks, showPrerequisites],
  );

  const activeFocalId =
    draggingNodeId ?? hoveredNode?.node.id ?? selectedNodeId ?? null;
  const spotlightNeighborSet = useMemo(() => {
    if (!activeFocalId) return null;
    return adjacencyMap.get(activeFocalId) ?? new Set([activeFocalId]);
  }, [activeFocalId, adjacencyMap]);

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

  const stageFontSize = Math.max(
    9.5,
    Math.min(13.5, 11.2 / Math.pow(scale, 0.28)),
  );
  const lessonFontSize = Math.max(
    8.5,
    Math.min(11.5, 9.8 / Math.pow(scale, 0.28)),
  );

  return (
    <div className="lp-starmap-container" ref={containerRef}>
      {/* Top Floating Star-Map Subheader */}
      <div className="lp-starmap-subheader">
        <div className="lp-starmap-stats">
          <span className="lp-starmap-badge">CONSTELLATION · 课程知识星图</span>
          <span>星域: {starGraph.stats.totalStages}</span>
          <span>·</span>
          <span>
            课程完成: {starGraph.stats.completedVideos}/
            {starGraph.stats.totalVideos}
          </span>
          {starGraph.stats.prerequisiteLinksCount > 0 && (
            <>
              <span>·</span>
              <span>
                跨阶段先修链: {starGraph.stats.prerequisiteLinksCount}
              </span>
            </>
          )}
        </div>

        <div className="lp-starmap-actions">
          <input
            type="text"
            className="lp-starmap-search"
            placeholder="搜索星图节点、模块或频道…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
          <button
            type="button"
            className={`lp-starmap-btn ${hideOptional ? 'is-active' : ''}`}
            onClick={() => setHideOptional((v) => !v)}
            title="隐藏选修支线节点，仅聚焦核心主线星系"
          >
            仅主线
          </button>
          <button
            type="button"
            className={`lp-starmap-btn ${showPrerequisites ? 'is-active' : ''}`}
            onClick={() => setShowPrerequisites((v) => !v)}
            title="显示或隐藏跨阶段先修依赖弧线"
          >
            先修网
          </button>
          <button
            type="button"
            className={`lp-starmap-btn ${controlsOpen ? 'is-active' : ''}`}
            onClick={() => setControlsOpen((v) => !v)}
          >
            星图参数
          </button>
          <button
            type="button"
            className="lp-starmap-btn"
            onClick={handleResetView}
          >
            重排星系
          </button>
        </div>
      </div>

      {/* Institutional Obsidian-Style Force & Filter Drawer */}
      {controlsOpen && (
        <aside className="lp-starmap-drawer" aria-label="星图物理与显示参数">
          <div className="lp-starmap-drawer-head">
            <span>STAR ENGINE · 星图力场参数</span>
            <button
              type="button"
              onClick={() => setControlsOpen(false)}
              className="lp-starmap-drawer-close"
            >
              关闭
            </button>
          </div>

          <div className="lp-starmap-drawer-section">
            <div className="lp-starmap-kicker">拓扑图层 · LAYERS</div>
            <label className="lp-starmap-toggle">
              <span>仅显示必修主线节点</span>
              <input
                type="checkbox"
                checked={hideOptional}
                onChange={(e) => setHideOptional(e.target.checked)}
              />
            </label>
            <label className="lp-starmap-toggle">
              <span>显示跨模块先修依赖边</span>
              <input
                type="checkbox"
                checked={showPrerequisites}
                onChange={(e) => setShowPrerequisites(e.target.checked)}
              />
            </label>
            <label className="lp-starmap-toggle">
              <span>显示阶段主脉络连线</span>
              <input
                type="checkbox"
                checked={showSpineLinks}
                onChange={(e) => setShowSpineLinks(e.target.checked)}
              />
            </label>
            <label className="lp-starmap-toggle">
              <span>显示星域轨道辅助环</span>
              <input
                type="checkbox"
                checked={showOrbitGuides}
                onChange={(e) => setShowOrbitGuides(e.target.checked)}
              />
            </label>
          </div>

          <div className="lp-starmap-drawer-section">
            <div className="lp-starmap-kicker">视觉与缩放 · DISPLAY</div>
            <div className="lp-starmap-slider">
              <div className="lp-starmap-slider-top">
                <span>星体节点尺寸</span>
                <strong>{nodeSizeScale.toFixed(2)}x</strong>
              </div>
              <input
                type="range"
                min="0.65"
                max="1.55"
                step="0.05"
                value={nodeSizeScale}
                onChange={(e) => setNodeSizeScale(Number(e.target.value))}
              />
            </div>
            <div className="lp-starmap-slider">
              <div className="lp-starmap-slider-top">
                <span>小节标题渐显阈值 (LOD)</span>
                <strong>{labelFadeThreshold.toFixed(2)}</strong>
              </div>
              <input
                type="range"
                min="0.35"
                max="1.2"
                step="0.05"
                value={labelFadeThreshold}
                onChange={(e) => setLabelFadeThreshold(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="lp-starmap-drawer-section">
            <div className="lp-starmap-kicker">物理引擎 · FORCES</div>
            <div className="lp-starmap-slider">
              <div className="lp-starmap-slider-top">
                <span>电荷排斥力</span>
                <strong>{physicsConfig.repelStrength.toFixed(2)}</strong>
              </div>
              <input
                type="range"
                min="0.35"
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
            <div className="lp-starmap-slider">
              <div className="lp-starmap-slider-top">
                <span>星域轨道间距</span>
                <strong>{physicsConfig.linkDistanceScale.toFixed(2)}x</strong>
              </div>
              <input
                type="range"
                min="0.6"
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
            <div className="lp-starmap-slider">
              <div className="lp-starmap-slider-top">
                <span>中心引力强度</span>
                <strong>{physicsConfig.centerGravity.toFixed(2)}</strong>
              </div>
              <input
                type="range"
                min="0.35"
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

          <div className="lp-starmap-drawer-foot">
            <button
              type="button"
              className="lp-starmap-btn"
              onClick={() => reheatSimulation(0.65)}
            >
              演化力场
            </button>
            <button
              type="button"
              className="lp-starmap-btn"
              onClick={() => {
                setPhysicsConfig(DEFAULT_PATH_STAR_PHYSICS_CONFIG);
                setNodeSizeScale(1.0);
                setLabelFadeThreshold(0.65);
                setHideOptional(false);
                setShowPrerequisites(true);
                setShowSpineLinks(true);
                setShowOrbitGuides(true);
              }}
            >
              恢复默认
            </button>
          </div>
        </aside>
      )}

      {/* Interactive SVG Star-Map Viewport */}
      <div
        className={`lp-starmap-canvas ${isPanning ? 'is-panning' : ''} ${
          draggingNodeId ? 'is-dragging-node' : ''
        }`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
      >
        <svg
          className="lp-starmap-svg"
          width={dimensions.width}
          height={dimensions.height}
        >
          <defs>
            <radialGradient id="lpCoreSunGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ff8563" />
              <stop offset="68%" stopColor="#d9573b" />
              <stop offset="100%" stopColor="#8c2d19" />
            </radialGradient>
            <marker
              id="lp-star-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path
                d="M 0 1.5 L 8.5 5 L 0 8.5 z"
                fill="rgba(148, 163, 184, 0.65)"
              />
            </marker>
            <marker
              id="lp-star-arrow-spotlight"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5.5"
              markerHeight="5.5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="#f59e0b" />
            </marker>
          </defs>

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
            {/* Concentric Orbital Guide Rings */}
            {showOrbitGuides &&
              orbitGuideRadii.map((r) => (
                <circle
                  key={`guide-${r}`}
                  cx={0}
                  cy={0}
                  r={r}
                  className="lp-star-orbit-ring"
                />
              ))}

            {/* Links */}
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
                ? (link.source === activeFocalId &&
                    spotlightNeighborSet.has(link.target)) ||
                  (link.target === activeFocalId &&
                    spotlightNeighborSet.has(link.source)) ||
                  (nodeMap.get(activeFocalId || '')?.kind === 'stage' &&
                    spotlightNeighborSet.has(link.source) &&
                    spotlightNeighborSet.has(link.target))
                : false;

              const isDimmed =
                (Boolean(spotlightNeighborSet) && !isSpotlightLink) ||
                (Boolean(filteredNodeIds) &&
                  !filteredNodeIds?.has(link.source) &&
                  !filteredNodeIds?.has(link.target));

              if (link.kind === 'prerequisite' || link.kind === 'spine') {
                const mx = (srcPos.x + tgtPos.x) / 2;
                const my =
                  (srcPos.y + tgtPos.y) / 2 -
                  (link.kind === 'prerequisite' ? 36 : 18);
                return (
                  <path
                    key={link.id}
                    d={`M ${srcPos.x} ${srcPos.y} Q ${mx} ${my} ${tgtPos.x} ${tgtPos.y}`}
                    className={`lp-star-link is-${link.kind} ${
                      link.active ? 'is-completed' : ''
                    } ${isSpotlightLink ? 'is-spotlight' : ''} ${
                      isDimmed ? 'is-dimmed' : ''
                    }`}
                    style={{ '--star-color': link.color } as CSSProperties}
                    markerEnd={
                      link.kind === 'prerequisite'
                        ? isSpotlightLink
                          ? 'url(#lp-star-arrow-spotlight)'
                          : 'url(#lp-star-arrow)'
                        : undefined
                    }
                  />
                );
              }

              return (
                <line
                  key={link.id}
                  x1={srcPos.x}
                  y1={srcPos.y}
                  x2={tgtPos.x}
                  y2={tgtPos.y}
                  className={`lp-star-link is-${link.kind} ${
                    link.active ? 'is-completed' : ''
                  } ${link.optional ? 'is-optional' : ''} ${
                    isSpotlightLink ? 'is-spotlight' : ''
                  } ${isDimmed ? 'is-dimmed' : ''}`}
                  style={{ '--star-color': link.color } as CSSProperties}
                />
              );
            })}

            {/* Star Nodes */}
            {starGraph.nodes.map((node) => {
              if (!visibleNodeIds.has(node.id)) return null;

              const pos = livePositions[node.id] ?? node;
              const isCore = node.kind === 'core';
              const isStage = node.kind === 'stage';
              const isCheckpoint = node.kind === 'checkpoint';
              const isSelected = selectedNodeId === node.id;
              const isFocalSelf = activeFocalId === node.id;
              const isNeighbor = spotlightNeighborSet
                ? spotlightNeighborSet.has(node.id)
                : false;
              const isSearchMatch = filteredNodeIds
                ? filteredNodeIds.has(node.id)
                : true;

              const isDimmed =
                (Boolean(spotlightNeighborSet) && !isNeighbor) ||
                (Boolean(filteredNodeIds) && !isSearchMatch);

              const degreeBoost = Math.min(3.5, node.degree * 0.28);
              const r = isCore
                ? 28 * nodeSizeScale
                : isStage
                  ? (12.5 + degreeBoost) * nodeSizeScale
                  : isCheckpoint
                    ? (8.8 + degreeBoost * 0.35) * nodeSizeScale
                    : (node.optional ? 5.2 : 6.8 + degreeBoost * 0.25) *
                      nodeSizeScale;

              // Semantic Zoom (LOD) label opacity
              const t1 = labelFadeThreshold * 0.52;
              const t2 = labelFadeThreshold;
              const forceLabel =
                isCore ||
                isStage ||
                isFocalSelf ||
                isNeighbor ||
                isSelected ||
                node.isNextUp ||
                isCheckpoint ||
                (Boolean(filteredNodeIds) && isSearchMatch);

              let labelOpacity = 0;
              if (forceLabel) {
                labelOpacity = 1;
              } else if (scale >= t2) {
                labelOpacity = 0.9;
              } else if (scale > t1) {
                labelOpacity = ((scale - t1) / (t2 - t1)) * 0.85;
              }

              const shortText =
                scale >= 0.92 || isFocalSelf || isNeighbor || isSelected
                  ? node.label.length > 22
                    ? `${node.label.slice(0, 22)}…`
                    : node.label
                  : node.orderIndex !== null
                    ? `#${String(node.orderIndex).padStart(2, '0')} ${
                        node.label.length > 10
                          ? `${node.label.slice(0, 10)}…`
                          : node.label
                      }`
                    : node.label.length > 12
                      ? `${node.label.slice(0, 12)}…`
                      : node.label;

              return (
                <g
                  key={node.id}
                  className={[
                    'lp-star-node-group',
                    `is-${node.kind}`,
                    `status-${node.status}`,
                    node.optional ? 'is-optional' : '',
                    node.isNextUp ? 'is-next-up' : '',
                    isSelected ? 'is-selected' : '',
                    isFocalSelf ? 'is-hovered' : '',
                    isNeighbor ? 'is-neighbor' : '',
                    isDimmed ? 'is-dimmed' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
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
                  {/* Generous invisible hit circle for effortless dragging/clicking */}
                  <circle
                    cx={0}
                    cy={0}
                    r={Math.max(15, r + 6)}
                    fill="transparent"
                  />

                  {/* Active Next-Up Beacon Pulse */}
                  {node.isNextUp && (
                    <circle cx={0} cy={0} className="lp-star-next-pulse" />
                  )}

                  {/* Selected / Completed / Stage Progress Ring */}
                  {(node.status === 'completed' || isStage || isSelected) &&
                    !isCore && (
                      <circle
                        cx={0}
                        cy={0}
                        r={r + 4}
                        className={`lp-star-halo ${
                          node.status === 'completed' ? 'is-completed' : ''
                        } ${isSelected ? 'is-selected' : ''}`}
                        style={{ '--star-color': node.color } as CSSProperties}
                      />
                    )}

                  {isCore ? (
                    <>
                      <circle
                        cx={0}
                        cy={0}
                        r={r + 5}
                        className="lp-star-core-ring"
                      />
                      <circle
                        cx={0}
                        cy={0}
                        r={r}
                        fill="url(#lpCoreSunGrad)"
                        className="lp-star-core-circle"
                      />
                      <text x={0} y={4} className="lp-star-core-pct">
                        {Math.round(node.progressRatio * 100)}%
                      </text>
                      <text x={0} y={r + 18} className="lp-star-core-title">
                        {node.label.length > 18
                          ? `${node.label.slice(0, 18)}…`
                          : node.label}
                      </text>
                    </>
                  ) : (
                    <>
                      {isCheckpoint ? (
                        <polygon
                          points={`0,${-r * 1.25} ${r * 1.25},0 0,${r * 1.25} ${-r * 1.25},0`}
                          fill={node.color}
                          className="lp-star-node-shape is-diamond"
                          style={
                            { '--star-color': node.color } as CSSProperties
                          }
                        />
                      ) : (
                        <circle
                          cx={0}
                          cy={0}
                          r={r}
                          fill={node.color}
                          className="lp-star-node-shape"
                          style={
                            { '--star-color': node.color } as CSSProperties
                          }
                        />
                      )}

                      {labelOpacity > 0.04 && (
                        <text
                          x={0}
                          y={r + (isStage ? 15 : 12)}
                          className={`lp-star-label ${
                            isStage ? 'is-stage-label' : 'is-lesson-label'
                          } ${
                            node.isNextUp || isFocalSelf || isSelected
                              ? 'is-prominent'
                              : ''
                          }`}
                          style={{
                            fontSize: `${
                              isStage ? stageFontSize : lessonFontSize
                            }px`,
                            opacity: labelOpacity,
                          }}
                        >
                          {shortText}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Bottom-left Star-Map Dock */}
        <div className="lp-starmap-dock">
          <button
            type="button"
            onClick={() =>
              setScale((s) => Math.max(0.22, Number((s - 0.12).toFixed(2))))
            }
            title="缩小星图"
          >
            −
          </button>
          <span className="lp-zoom-readout">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            onClick={() =>
              setScale((s) => Math.min(2.8, Number((s + 0.12).toFixed(2))))
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
              onClick={() => focusStarNode(layout.nextUpNodeId!, 1.1)}
            >
              定位下一课
            </button>
          )}
        </div>

        {/* Bottom-right Legend */}
        <div className="lp-starmap-legend">
          <span>拖拽星体：弹性牵引簇群</span>
          <span>·</span>
          <span>悬停：高亮先修与后续依赖链</span>
          <span>·</span>
          <span>单击：检视详情 / 双击：立即播放</span>
        </div>

        {/* Institutional Floating Hover Card */}
        {hoveredNode && !draggingNodeId && (
          <div
            className="lp-starmap-tooltip"
            style={{
              left: Math.min(hoveredNode.clientX, dimensions.width - 310),
              top: Math.min(hoveredNode.clientY, dimensions.height - 210),
            }}
          >
            <div className="lp-starmap-tooltip-head">
              <span className="lp-starmap-tooltip-kind">
                {hoveredNode.node.kind === 'core'
                  ? '课程核心恒星'
                  : hoveredNode.node.kind === 'stage'
                    ? `星域 ${hoveredNode.node.stageIndex + 1}`
                    : hoveredNode.node.kind === 'checkpoint'
                      ? '里程碑节点'
                      : hoveredNode.node.orderIndex !== null
                        ? `#${String(hoveredNode.node.orderIndex).padStart(2, '0')} 视频课`
                        : '知识节点'}
              </span>
              <span
                className={`lp-starmap-tooltip-status status-${hoveredNode.node.status}`}
              >
                {hoveredNode.node.isNextUp
                  ? '★ 下一课'
                  : hoveredNode.node.status === 'completed'
                    ? '● 已学完'
                    : hoveredNode.node.status === 'in_progress'
                      ? '◐ 学习中'
                      : hoveredNode.node.status === 'locked'
                        ? '○ 待解锁'
                        : '○ 可学习'}
              </span>
            </div>

            <strong className="lp-starmap-tooltip-title">
              {hoveredNode.node.label}
            </strong>

            {hoveredNode.node.video && (
              <div className="lp-starmap-tooltip-video">
                {hoveredNode.node.video.thumbnailUrl && (
                  <img
                    src={hoveredNode.node.video.thumbnailUrl}
                    alt=""
                    loading="lazy"
                  />
                )}
                <div>
                  <div>
                    {hoveredNode.node.video.channelName ||
                      hoveredNode.node.video.videoId}
                  </div>
                  {hoveredNode.node.video.durationSeconds && (
                    <div className="lp-starmap-tooltip-duration">
                      时长:{' '}
                      {formatDurationShort(
                        hoveredNode.node.video.durationSeconds,
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {hoveredNode.node.note && (
              <p className="lp-starmap-tooltip-note">{hoveredNode.node.note}</p>
            )}

            <div className="lp-starmap-tooltip-deps">
              <span>前置先修: {hoveredNode.node.prerequisiteIds.length}</span>
              <span>·</span>
              <span>解锁后续: {hoveredNode.node.dependentIds.length}</span>
            </div>

            <div className="lp-starmap-tooltip-hint">
              {hoveredNode.node.video
                ? '单击在右侧打开节点详情 · 双击直接播放视频'
                : '单击检视模块详情 · 按住拖拽可调整星簇布局'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
