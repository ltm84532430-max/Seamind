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
  buildGalaxyAdjacencyMap,
  computeVisibleGalaxyLabelIds,
  createGalaxyPhysicsState,
  DEFAULT_GALAXY_PHYSICS_CONFIG,
  stepGalaxyPhysics,
  type BookGalaxyGraph,
  type GalaxyNode,
  type GalaxyPhysicsConfig,
  type GalaxyPhysicsState,
} from './book-galaxy-model';
import type { Theme } from '../app/app-storage';
import './book-galaxy-view.css';

export interface BookGalaxyGraphViewProps {
  graph: BookGalaxyGraph;
  currentChapterHref?: string;
  theme?: Theme;
  onSelectNode: (node: GalaxyNode) => void;
  onSwitchToEditor?: () => void;
}

export function BookGalaxyGraphView({
  graph,
  onSelectNode,
  onSwitchToEditor,
}: BookGalaxyGraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [pan, setPan] = useState({ x: 400, y: 300 });
  const [scale, setScale] = useState(0.65);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Interactive node drag state
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const dragInfoRef = useRef<{
    node: GalaxyNode;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);

  const [hoveredNode, setHoveredNode] = useState<{
    node: GalaxyNode;
    clientX: number;
    clientY: number;
  } | null>(null);

  const [searchFilter, setSearchFilter] = useState('');
  const [controlsOpen, setControlsOpen] = useState(false);

  // Obsidian-style Graph Filter & Display states
  const [onlyWithNotes, setOnlyWithNotes] = useState(false);
  const [showSatellites, setShowSatellites] = useState(true);
  const [showAllFootnotes, setShowAllFootnotes] = useState(false);
  const [showCrossLinks, setShowCrossLinks] = useState(true);
  const [showSequenceLinks, setShowSequenceLinks] = useState(false);
  const [showOrbitGuides, setShowOrbitGuides] = useState(false);
  const [nodeSizeScale, setNodeSizeScale] = useState(1.0);
  const [labelFadeThreshold, setLabelFadeThreshold] = useState(0.68);
  const [physicsConfig, setPhysicsConfig] = useState<GalaxyPhysicsConfig>(
    DEFAULT_GALAXY_PHYSICS_CONFIG,
  );

  // Force simulation state & live positions
  const physicsRef = useRef<GalaxyPhysicsState | null>(null);
  const physicsConfigRef = useRef<GalaxyPhysicsConfig>(physicsConfig);
  physicsConfigRef.current = physicsConfig;

  const [livePositions, setLivePositions] = useState<
    Record<string, { x: number; y: number }>
  >(() => {
    const initial: Record<string, { x: number; y: number }> = {};
    for (const n of graph.nodes) {
      initial[n.id] = { x: n.x, y: n.y };
    }
    return initial;
  });

  const nodeMap = useMemo(() => {
    const map = new Map<string, GalaxyNode>();
    for (const n of graph.nodes) {
      map.set(n.id, n);
    }
    return map;
  }, [graph.nodes]);

  const filteredNodes = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return graph.nodes;
    return graph.nodes.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        (n.chapterIndex && n.chapterIndex.toLowerCase().includes(q)) ||
        (n.noteTitle && n.noteTitle.toLowerCase().includes(q)) ||
        (n.footnoteData?.content &&
          n.footnoteData.content.toLowerCase().includes(q)) ||
        (n.footnoteData?.quote &&
          n.footnoteData.quote.toLowerCase().includes(q)) ||
        (n.footnoteData?.footnoteKey &&
          n.footnoteData.footnoteKey.toLowerCase().includes(q)),
    );
  }, [graph.nodes, searchFilter]);

  const activeFilteredIds = useMemo(() => {
    return new Set(filteredNodes.map((n) => n.id));
  }, [filteredNodes]);

  const activeHoveredId = draggingNodeId ?? hoveredNode?.node.id ?? null;

  // Visible nodes based on topology filters & Choice B focused footnote visibility
  const visibleNodeIds = useMemo(() => {
    const set = new Set<string>();
    const activeAncestorIds = new Set<string>();
    const hasSearchQuery = Boolean(searchFilter.trim());

    if (onlyWithNotes) {
      for (const n of graph.nodes) {
        if (n.kind === 'footnote') continue;
        if (n.hasNote || n.isCurrent) {
          set.add(n.id);
          let parentId = n.parentId;
          while (parentId) {
            activeAncestorIds.add(parentId);
            parentId = nodeMap.get(parentId)?.parentId;
          }
        }
      }
    }

    for (const n of graph.nodes) {
      if (n.kind === 'sun') {
        set.add(n.id);
        continue;
      }
      if (n.kind === 'footnote') {
        continue;
      }
      if (!showSatellites && n.kind === 'satellite') {
        continue;
      }
      if (onlyWithNotes) {
        if (n.hasNote || n.isCurrent || activeAncestorIds.has(n.id)) {
          set.add(n.id);
        }
        continue;
      }
      set.add(n.id);
    }

    // Choice B: by default, focus footnotes on current chapter + hovered cluster + search matches
    const focusedClusters = new Set<string>();
    let sunFocused = false;
    for (const n of graph.nodes) {
      if (n.isCurrent && n.rootClusterId) {
        focusedClusters.add(n.rootClusterId);
      }
    }
    if (activeHoveredId) {
      const hovered = nodeMap.get(activeHoveredId);
      if (hovered) {
        if (hovered.kind === 'sun') {
          sunFocused = true;
        } else if (hovered.rootClusterId) {
          focusedClusters.add(hovered.rootClusterId);
        } else if (hovered.parentId === 'sun-root') {
          sunFocused = true;
        }
      }
    }

    for (const n of graph.nodes) {
      if (n.kind !== 'footnote') continue;
      if (n.parentId && !set.has(n.parentId)) continue;

      const isFocused =
        showAllFootnotes ||
        Boolean(n.isCurrent) ||
        n.id === activeHoveredId ||
        (hasSearchQuery && activeFilteredIds.has(n.id)) ||
        Boolean(n.rootClusterId && focusedClusters.has(n.rootClusterId)) ||
        (n.parentId === 'sun-root' && sunFocused);

      if (isFocused) {
        set.add(n.id);
      }
    }

    return set;
  }, [
    graph.nodes,
    nodeMap,
    onlyWithNotes,
    showSatellites,
    showAllFootnotes,
    activeHoveredId,
    searchFilter,
    activeFilteredIds,
  ]);

  const visibleIdsRef = useRef<Set<string>>(visibleNodeIds);
  visibleIdsRef.current = visibleNodeIds;

  const nonCollidingLabelIds = useMemo(() => {
    const priorityIds = new Set<string>();
    if (activeHoveredId) priorityIds.add(activeHoveredId);
    for (const node of graph.nodes) {
      if (node.isCurrent || node.hasNote) priorityIds.add(node.id);
    }
    return computeVisibleGalaxyLabelIds({
      nodes: graph.nodes,
      positions: livePositions,
      scale,
      visibleIds: visibleNodeIds,
      priorityIds,
    });
  }, [activeHoveredId, graph.nodes, livePositions, scale, visibleNodeIds]);

  const syncPositionsFromPhysics = useCallback((state: GalaxyPhysicsState) => {
    const next: Record<string, { x: number; y: number }> = {};
    for (const body of state.bodyList) {
      next[body.id] = { x: body.x, y: body.y };
    }
    setLivePositions(next);
  }, []);

  // Initialize & run 60fps force simulation (throttled during final settling tail)
  const rafRef = useRef<number | null>(null);
  const startSimulationLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    let frameCount = 0;
    const tick = () => {
      const state = physicsRef.current;
      if (!state) {
        rafRef.current = null;
        return;
      }
      const keepRunning = stepGalaxyPhysics(
        state,
        physicsConfigRef.current,
        visibleIdsRef.current,
      );
      frameCount += 1;
      const hasPinned = state.bodyList.some(
        (body) => body.fx !== null || body.fy !== null,
      );
      if (
        hasPinned ||
        state.alpha >= 0.08 ||
        frameCount % 2 === 0 ||
        !keepRunning
      ) {
        syncPositionsFromPhysics(state);
      }
      if (keepRunning) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [syncPositionsFromPhysics]);

  useEffect(() => {
    const state = createGalaxyPhysicsState(graph);
    // Warm up 10 steps for organic initial relaxation
    for (let i = 0; i < 10; i++) {
      stepGalaxyPhysics(state, physicsConfigRef.current, visibleIdsRef.current);
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
  }, [graph, startSimulationLoop, syncPositionsFromPhysics]);

  const reheatSimulation = useCallback(
    (alpha = 0.45) => {
      const state = physicsRef.current;
      if (!state) return;
      state.alpha = Math.max(state.alpha, alpha);
      startSimulationLoop();
    },
    [startSimulationLoop],
  );

  // Reheat when physics sliders or visibility filters change
  useEffect(() => {
    reheatSimulation(0.38);
  }, [
    physicsConfig.repelStrength,
    physicsConfig.linkDistanceScale,
    physicsConfig.linkTension,
    physicsConfig.centerGravity,
    onlyWithNotes,
    showSatellites,
    showAllFootnotes,
    reheatSimulation,
  ]);

  // Auto-fit calculation
  const calculateAutoFit = useCallback(
    (width: number, height: number) => {
      const gw = Math.max(300, graph.bounds.maxX - graph.bounds.minX);
      const gh = Math.max(300, graph.bounds.maxY - graph.bounds.minY);
      const scaleX = (width - 96) / gw;
      const scaleY = (height - 96) / gh;
      const fitScale = Math.min(1.15, Math.max(0.28, Math.min(scaleX, scaleY)));
      return {
        scale: fitScale,
        pan: { x: width / 2, y: height / 2 },
      };
    },
    [
      graph.bounds.maxX,
      graph.bounds.maxY,
      graph.bounds.minX,
      graph.bounds.minY,
    ],
  );

  // Measure container dimensions & initial auto-fit
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

  // Convert client coordinates to graph world coordinates
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

  // Node pointer down (initiate elastic drag or click)
  const handleNodePointerDown = (
    e: ReactPointerEvent<SVGGElement>,
    node: GalaxyNode,
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
      // ignore in non-DOM test environments
    }
  };

  // Canvas Pan & Node Drag interaction
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.galaxy-node-group')) return;
    if ((e.target as HTMLElement).closest('.book-galaxy-controls-drawer')) {
      return;
    }
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
        if (info.node.kind === 'cluster') {
          // Update cluster anchor so dragged cluster stays in its new region organically
          body.anchorX = body.x;
          body.anchorY = body.y;
        }
        body.fx = null;
        body.fy = null;
        reheatSimulation(0.22);
      }
      const wasClick = !info.moved;
      const clickedNode = info.node;
      dragInfoRef.current = null;
      setDraggingNodeId(null);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      if (wasClick) {
        onSelectNode(clickedNode);
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

  // Wheel zoom
  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
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
    const state = createGalaxyPhysicsState(graph);
    for (let i = 0; i < 10; i++) {
      stepGalaxyPhysics(state, physicsConfigRef.current, visibleIdsRef.current);
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
    setPhysicsConfig(DEFAULT_GALAXY_PHYSICS_CONFIG);
    setNodeSizeScale(1.0);
    setLabelFadeThreshold(0.68);
    setOnlyWithNotes(false);
    setShowSatellites(true);
    setShowAllFootnotes(false);
    setShowCrossLinks(true);
    setShowSequenceLinks(false);
    setShowOrbitGuides(false);
  };

  // 1-Hop Obsidian Adjacency Map
  const adjacencyMap = useMemo(
    () =>
      buildGalaxyAdjacencyMap(graph.nodes, graph.links, {
        includeSequence: showSequenceLinks,
        includeCrossLinks: showCrossLinks,
      }),
    [graph.nodes, graph.links, showSequenceLinks, showCrossLinks],
  );

  const spotlightNeighborSet = useMemo(() => {
    if (!activeHoveredId) return null;
    return adjacencyMap.get(activeHoveredId) ?? new Set([activeHoveredId]);
  }, [activeHoveredId, adjacencyMap]);

  // Unique orbit radii for optional guide rings
  const orbitGuideRadii = useMemo(() => {
    const set = new Set<number>();
    graph.nodes.forEach((n) => {
      if (n.kind === 'cluster' && n.orbitRadius) {
        set.add(Math.round(n.orbitRadius * physicsConfig.linkDistanceScale));
      }
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [graph.nodes, physicsConfig.linkDistanceScale]);

  const sunNode = graph.nodes.find((n) => n.kind === 'sun');
  const sunRadius = sunNode ? Math.round(32 * nodeSizeScale) : 32;
  const coverUrl = sunNode?.coverDataUrl || graph.coverDataUrl;

  const crossLinksCount = useMemo(
    () => graph.links.filter((l) => l.kind === 'cross_link').length,
    [graph.links],
  );

  const visibleStats = useMemo(() => {
    let chapters = 0;
    let footnotes = 0;
    for (const id of visibleNodeIds) {
      const node = nodeMap.get(id);
      if (!node || node.kind === 'sun') continue;
      if (node.kind === 'footnote') {
        footnotes++;
      } else {
        chapters++;
      }
    }
    return { chapters, footnotes };
  }, [visibleNodeIds, nodeMap]);

  // Inverse scale font compensation for Obsidian-like crisp labels at any zoom
  const clusterFontSize = Math.max(
    9.5,
    Math.min(13.5, 11.2 / Math.pow(scale, 0.28)),
  );
  const planetFontSize = Math.max(
    8.5,
    Math.min(11.5, 9.8 / Math.pow(scale, 0.28)),
  );

  return (
    <div className="book-galaxy-container" ref={containerRef}>
      {/* Top Header Controls */}
      <div className="book-galaxy-header">
        <div className="book-galaxy-title-wrap">
          <span className="book-galaxy-badge">全书知识星系</span>
          <span className="book-galaxy-title">《{graph.bookTitle}》</span>
          <div className="book-galaxy-stats">
            <span className="book-galaxy-stat-pill">
              节点: {visibleStats.chapters}/{graph.stats.totalChapters}
            </span>
            <span>·</span>
            <span className="book-galaxy-stat-pill">
              已记笔记: {graph.stats.notesCount} (
              {graph.stats.completionPercentage}%)
            </span>
            <span>·</span>
            <span className="book-galaxy-stat-pill">
              脚注: {visibleStats.footnotes}/{graph.stats.footnotesCount}
            </span>
            {crossLinksCount > 0 && (
              <>
                <span>·</span>
                <span className="book-galaxy-stat-pill">
                  跨章联动: {crossLinksCount}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="book-galaxy-actions">
          <input
            type="text"
            className="book-galaxy-search-input"
            placeholder="检索章节、笔记或脚注…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
          <button
            type="button"
            className={`book-galaxy-btn ${onlyWithNotes ? 'is-active' : ''}`}
            title="仅显示已创建读书笔记的章节与路径"
            onClick={() => setOnlyWithNotes((prev) => !prev)}
          >
            仅看笔记
          </button>
          <button
            type="button"
            className={`book-galaxy-btn ${showAllFootnotes ? 'is-active' : ''}`}
            title={
              showAllFootnotes
                ? '已展开全书全部脚注；点击切回按当前阅读章与悬停章聚焦'
                : '默认仅聚焦当前阅读章与悬停章脚注；点击展开全书全部脚注'
            }
            onClick={() => setShowAllFootnotes((prev) => !prev)}
          >
            {showAllFootnotes
              ? `全部脚注 (${graph.stats.footnotesCount})`
              : `聚焦脚注 (${graph.stats.footnotesCount})`}
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
          {onSwitchToEditor && (
            <button
              type="button"
              className="book-galaxy-btn is-primary"
              onClick={onSwitchToEditor}
            >
              返回笔记编辑
            </button>
          )}
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
              <span>仅显示已关联笔记章节</span>
              <input
                type="checkbox"
                checked={onlyWithNotes}
                onChange={(e) => setOnlyWithNotes(e.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示三级子节节点</span>
              <input
                type="checkbox"
                checked={showSatellites}
                onChange={(e) => setShowSatellites(e.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示全书全部脚注 (关闭则按章聚焦)</span>
              <input
                type="checkbox"
                checked={showAllFootnotes}
                onChange={(e) => setShowAllFootnotes(e.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示跨章节知识关联边</span>
              <input
                type="checkbox"
                checked={showCrossLinks}
                onChange={(e) => setShowCrossLinks(e.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示章节顺序脉络线</span>
              <input
                type="checkbox"
                checked={showSequenceLinks}
                onChange={(e) => setShowSequenceLinks(e.target.checked)}
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
            <clipPath id="galaxy-sun-cover-clip">
              <circle cx={0} cy={0} r={sunRadius} />
            </clipPath>

            {coverUrl && (
              <pattern
                id="galaxy-sun-cover-pattern"
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

            <radialGradient id="sunGradient" cx="50%" cy="50%" r="50%">
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

            {/* Topological & Cross-Chapter Links */}
            {graph.links.map((link, idx) => {
              if (link.kind === 'sequence' && !showSequenceLinks) return null;
              if (link.kind === 'cross_link' && !showCrossLinks) return null;
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
                  (hoveredNode?.node.kind === 'cluster' &&
                    spotlightNeighborSet.has(link.source) &&
                    spotlightNeighborSet.has(link.target)) ||
                  (link.kind === 'orbit' &&
                    spotlightNeighborSet.has(link.source) &&
                    spotlightNeighborSet.has(link.target))
                : false;

              const isDimmedBySpotlight =
                Boolean(spotlightNeighborSet) && !isSpotlightLink;

              const isSearchDimmed =
                Boolean(searchFilter) &&
                !activeFilteredIds.has(link.source) &&
                !activeFilteredIds.has(link.target);

              if (link.kind === 'sequence') {
                return (
                  <path
                    key={`seq-${idx}`}
                    d={`M ${srcPos.x} ${srcPos.y} Q ${(srcPos.x + tgtPos.x) / 2} ${(srcPos.y + tgtPos.y) / 2} ${tgtPos.x} ${tgtPos.y}`}
                    className={`galaxy-link-sequence ${
                      isSpotlightLink ? 'is-spotlight' : ''
                    } ${isDimmedBySpotlight || isSearchDimmed ? 'is-dimmed' : ''}`}
                  />
                );
              }

              if (link.kind === 'cross_link') {
                const mx = (srcPos.x + tgtPos.x) / 2;
                const my = (srcPos.y + tgtPos.y) / 2 - 28;
                return (
                  <path
                    key={`cross-${idx}`}
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

              const isIntraCluster =
                tgtNode.kind === 'planet' ||
                tgtNode.kind === 'satellite' ||
                tgtNode.kind === 'footnote';
              const isFootnoteLink = tgtNode.kind === 'footnote';
              const strokeColor = link.color || tgtNode.color;

              return (
                <line
                  key={`link-${idx}`}
                  x1={srcPos.x}
                  y1={srcPos.y}
                  x2={tgtPos.x}
                  y2={tgtPos.y}
                  className={`galaxy-link-orbit ${
                    isIntraCluster ? 'is-intra' : 'is-root-spoke'
                  } ${isFootnoteLink ? 'is-footnote-orbit' : ''} ${
                    isSpotlightLink ? 'is-spotlight' : ''
                  } ${isDimmedBySpotlight || isSearchDimmed ? 'is-dimmed' : ''}`}
                  style={
                    strokeColor
                      ? ({ '--link-color': strokeColor } as CSSProperties)
                      : undefined
                  }
                />
              );
            })}

            {/* Nodes */}
            {graph.nodes.map((node) => {
              if (!visibleNodeIds.has(node.id)) return null;

              const pos = livePositions[node.id] ?? node;
              const isMatch = activeFilteredIds.has(node.id);
              const isSun = node.kind === 'sun';
              const isCluster = node.kind === 'cluster';
              const isPlanet = node.kind === 'planet';
              const isSatellite = node.kind === 'satellite';
              const isFootnote = node.kind === 'footnote';
              const footnoteSource = node.footnoteData?.source;

              const isHoveredSelf = activeHoveredId === node.id;
              const isSpotlightNeighbor = spotlightNeighborSet
                ? spotlightNeighborSet.has(node.id)
                : false;
              const isDimmed =
                (Boolean(spotlightNeighborSet) && !isSpotlightNeighbor) ||
                (Boolean(searchFilter) && !isMatch);

              // Refined Obsidian node radius scaled by degree & note status
              const degreeBoost = Math.min(3.5, (node.degree ?? 0) * 0.25);
              const displayRadius = isSun
                ? sunRadius
                : isCluster
                  ? (9.5 + degreeBoost) * nodeSizeScale
                  : isPlanet
                    ? ((node.hasNote ? 6.2 : 4.5) + degreeBoost * 0.35) *
                      nodeSizeScale
                    : isFootnote
                      ? (footnoteSource === 'epub-note' ? 5.2 : 4.8) *
                        nodeSizeScale
                      : (node.hasNote ? 4.2 : 3.0) * nodeSizeScale;

              // Semantic Zoom (LOD) label visibility calculation
              const t1 = labelFadeThreshold * 0.55;
              const t2 = labelFadeThreshold;
              const forceShowLabel =
                isHoveredSelf ||
                isSpotlightNeighbor ||
                Boolean(node.isCurrent) ||
                Boolean(node.hasNote) ||
                (Boolean(searchFilter) && isMatch);

              const labelClear = nonCollidingLabelIds.has(node.id);
              let planetLabelOpacity = 0;
              if (forceShowLabel) {
                planetLabelOpacity = 1;
              } else if (labelClear && scale >= t2) {
                planetLabelOpacity = 0.88;
              } else if (labelClear && scale > t1) {
                planetLabelOpacity = ((scale - t1) / (t2 - t1)) * 0.85;
              }

              const showSatelliteLabel =
                isHoveredSelf ||
                isSpotlightNeighbor ||
                node.hasNote ||
                (labelClear && scale >= labelFadeThreshold * 1.35);

              const showFootnoteLabel =
                isHoveredSelf ||
                hoveredNode?.node.id === node.parentId ||
                (isSpotlightNeighbor && hoveredNode?.node.kind !== 'cluster') ||
                (Boolean(searchFilter.trim()) && isMatch) ||
                (labelClear && scale >= labelFadeThreshold * 1.15);

              const diamondR = displayRadius * 1.18;
              const diamondPoints = `0,${-diamondR} ${diamondR},0 0,${diamondR} ${-diamondR},0`;
              const haloR = diamondR + 3.2;
              const diamondHaloPoints = `0,${-haloR} ${haloR},0 0,${haloR} ${-haloR},0`;

              const cleanPlanetText =
                scale >= 0.95 || isHoveredSelf || isSpotlightNeighbor
                  ? node.label.length > 22
                    ? `${node.label.slice(0, 22)}…`
                    : node.label
                  : node.chapterIndex ||
                    (node.label.length > 10
                      ? `${node.label.slice(0, 10)}…`
                      : node.label);

              return (
                <g
                  key={node.id}
                  className={`galaxy-node-group is-${node.kind} ${
                    isSun ? 'is-sun' : ''
                  } ${node.hasNote ? 'has-note' : 'no-note'} ${
                    isHoveredSelf ? 'is-hovered' : ''
                  } ${isSpotlightNeighbor ? 'is-neighbor' : ''} ${
                    isDimmed ? 'is-dimmed' : ''
                  }`}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onPointerDown={(e) => handleNodePointerDown(e, node)}
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
                  {/* Invisible hit area so small Obsidian nodes remain effortless to grab/click */}
                  <circle
                    cx={0}
                    cy={0}
                    r={Math.max(14, displayRadius + 6)}
                    fill="transparent"
                  />

                  {/* Active reading chapter pulse */}
                  {node.isCurrent && (
                    <circle cx={0} cy={0} className="galaxy-current-pulse" />
                  )}

                  {/* Has-note crisp outer ring / Footnote diamond halo */}
                  {isFootnote ? (
                    <polygon
                      points={diamondHaloPoints}
                      className={`galaxy-footnote-halo is-${
                        footnoteSource ?? 'epub-note'
                      } ${node.footnoteData?.syncedNotePath ? 'is-synced' : ''}`}
                      style={
                        {
                          '--node-color': node.color,
                        } as CSSProperties
                      }
                    />
                  ) : (
                    node.hasNote &&
                    !isSun && (
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
                    )
                  )}

                  {/* Central Book Node */}
                  {isSun ? (
                    <>
                      {coverUrl ? (
                        <circle
                          cx={0}
                          cy={0}
                          r={sunRadius}
                          fill="url(#galaxy-sun-cover-pattern)"
                          clipPath="url(#galaxy-sun-cover-clip)"
                          className="galaxy-sun-circle"
                        />
                      ) : (
                        <>
                          <circle
                            cx={0}
                            cy={0}
                            r={sunRadius}
                            fill="url(#sunGradient)"
                            className="galaxy-node-circle"
                          />
                          <text x={0} y={5} className="galaxy-sun-monogram">
                            {graph.bookTitle.slice(0, 2).toUpperCase()}
                          </text>
                        </>
                      )}
                      <text
                        x={0}
                        y={sunRadius + 18}
                        className="galaxy-sun-title"
                      >
                        《{graph.bookTitle}》
                      </text>
                    </>
                  ) : isFootnote ? (
                    <>
                      <polygon
                        points={diamondPoints}
                        fill={node.color}
                        className={`galaxy-node-diamond is-${
                          footnoteSource ?? 'epub-note'
                        } ${node.footnoteData?.syncedNotePath ? 'is-synced' : ''}`}
                        style={
                          {
                            '--node-color': node.color,
                          } as CSSProperties
                        }
                      />
                      <circle
                        cx={0}
                        cy={0}
                        r={Math.max(1.3, displayRadius * 0.28)}
                        className={`galaxy-footnote-pip is-${
                          footnoteSource ?? 'epub-note'
                        }`}
                      />
                      {showFootnoteLabel && (
                        <text
                          x={0}
                          y={diamondR + 10}
                          className="galaxy-footnote-label"
                          style={{ fontSize: `${planetFontSize * 0.88}px` }}
                        >
                          {node.label}
                        </text>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Obsidian Node Core */}
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

                      {/* Cluster Chapter Labels */}
                      {isCluster && (
                        <text
                          x={0}
                          y={displayRadius + 14}
                          className="galaxy-node-label"
                          style={{ fontSize: `${clusterFontSize}px` }}
                        >
                          {scale >= 0.72 || isHoveredSelf || isSpotlightNeighbor
                            ? node.label.length > 18
                              ? `${node.label.slice(0, 18)}…`
                              : node.label
                            : node.chapterIndex ||
                              (node.label.length > 10
                                ? `${node.label.slice(0, 10)}…`
                                : node.label)}
                        </text>
                      )}

                      {/* Planet Labels with Smooth Semantic Zoom (LOD) */}
                      {isPlanet && planetLabelOpacity > 0.04 && (
                        <text
                          x={0}
                          y={displayRadius + 11}
                          className={`galaxy-planet-badge ${
                            node.hasNote || isHoveredSelf ? 'is-prominent' : ''
                          }`}
                          style={{
                            fontSize: `${planetFontSize}px`,
                            opacity: planetLabelOpacity,
                          }}
                        >
                          {cleanPlanetText}
                        </text>
                      )}

                      {/* Satellite Labels on close zoom or spotlight */}
                      {isSatellite && showSatelliteLabel && (
                        <text
                          x={0}
                          y={displayRadius + 10}
                          className="galaxy-node-sublabel"
                          style={{ fontSize: `${planetFontSize * 0.92}px` }}
                        >
                          {node.label.length > 16
                            ? `${node.label.slice(0, 16)}…`
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
          <span>拖拽节点：物理牵引簇群</span>
          <span>·</span>
          <span>悬停：1-Hop 拓扑聚光灯</span>
          <span>·</span>
          <span>滚轮：语义缩放 ({Math.round(scale * 100)}%)</span>
          <span>·</span>
          <span>单击：同步章节与笔记</span>
        </div>

        {/* Floating Tooltip Card */}
        {hoveredNode && !draggingNodeId && (
          <div
            className="book-galaxy-tooltip"
            style={{
              left: Math.max(
                12,
                Math.min(hoveredNode.clientX, dimensions.width - 310),
              ),
              top: Math.max(
                12,
                Math.min(
                  hoveredNode.clientY,
                  dimensions.height -
                    (hoveredNode.node.kind === 'footnote' ? 245 : 165),
                ),
              ),
            }}
          >
            <div className="book-galaxy-tooltip-head">
              <span>
                {hoveredNode.node.kind === 'sun'
                  ? `《${hoveredNode.node.bookTitle}》`
                  : hoveredNode.node.kind === 'footnote'
                    ? hoveredNode.node.footnoteData?.footnoteKey
                      ? `脚注 [^${hoveredNode.node.footnoteData.footnoteKey}]`
                      : '书籍原位脚注'
                    : hoveredNode.node.label}
              </span>
              <span className="book-galaxy-badge">
                {hoveredNode.node.kind === 'sun'
                  ? '全书核心'
                  : hoveredNode.node.kind === 'footnote'
                    ? hoveredNode.node.footnoteData?.source === 'epub-note'
                      ? '书内批注'
                      : hoveredNode.node.footnoteData?.source === 'epub-ai'
                        ? 'AI 脚注'
                        : '笔记脚注'
                    : hoveredNode.node.chapterIndex ||
                      (hoveredNode.node.kind === 'cluster' ? '章节点' : '小节')}
              </span>
            </div>

            {hoveredNode.node.parentChapter && (
              <div className="book-galaxy-tooltip-meta">
                所属章节：{hoveredNode.node.parentChapter}
              </div>
            )}

            {hoveredNode.node.kind === 'footnote' ? (
              <>
                {hoveredNode.node.footnoteData?.quote && (
                  <blockquote className="book-galaxy-tooltip-quote">
                    “
                    {hoveredNode.node.footnoteData.quote.length > 96
                      ? `${hoveredNode.node.footnoteData.quote.slice(0, 96)}…`
                      : hoveredNode.node.footnoteData.quote}
                    ”
                  </blockquote>
                )}
                {hoveredNode.node.footnoteData?.content && (
                  <div className="book-galaxy-tooltip-footnote-body">
                    {hoveredNode.node.footnoteData.content.length > 180
                      ? `${hoveredNode.node.footnoteData.content.slice(0, 180)}…`
                      : hoveredNode.node.footnoteData.content}
                  </div>
                )}
                <div className="book-galaxy-tooltip-status is-has-note">
                  <span>
                    {hoveredNode.node.footnoteData?.source ===
                    'markdown-footnote'
                      ? `● 关联笔记：《${hoveredNode.node.footnoteData.noteTitle || '章节笔记'}》`
                      : hoveredNode.node.footnoteData?.syncedNotePath
                        ? `● 已同步至笔记 [^${hoveredNode.node.footnoteData.syncedFootnoteKey || ''}]`
                        : '◆ 书内原位脚注（可跳转原页或在阅读器中写入笔记）'}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="book-galaxy-tooltip-meta">
                  拓扑连接度：{hoveredNode.node.degree ?? 1} 个相邻节点
                </div>

                <div
                  className={`book-galaxy-tooltip-status ${
                    hoveredNode.node.hasNote ? 'is-has-note' : 'is-no-note'
                  }`}
                >
                  <span>
                    {hoveredNode.node.hasNote
                      ? '● 已关联章节知识库笔记'
                      : '○ 暂无独立笔记（点击可创建）'}
                  </span>
                </div>
              </>
            )}

            {hoveredNode.node.isCurrent && (
              <div className="book-galaxy-tooltip-current">
                {hoveredNode.node.kind === 'footnote'
                  ? '位于当前阅读章节'
                  : '当前阅读所在章节'}
              </div>
            )}

            <div className="book-galaxy-tooltip-hint">
              {hoveredNode.node.kind === 'sun'
                ? '单击查看全书总览笔记 · 按住可拖拽牵引星系'
                : hoveredNode.node.kind === 'footnote'
                  ? '单击精确定位电子书原句与右侧笔记脚注'
                  : '单击跳转该章并展开笔记 · 按住可物理拖拽节点'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
