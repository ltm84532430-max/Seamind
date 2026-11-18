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
  type GalaxyPhysicsConfig,
  type GalaxyPhysicsState,
} from '../graph/galaxy-physics';
import type { CategoryStats, FeedArticle, FeedChannelWithStats } from './types';
import {
  buildFeedGalaxyGraph,
  FEED_GALAXY_HIGHLIGHT_LIMIT,
  rankUnreadChannels,
  type FeedGalaxyNode,
} from './feed-galaxy-model';
import '../ebook/book-galaxy-view.css';
import './feed-galaxy-view.css';

interface FeedGalaxyGraphViewProps {
  categories: CategoryStats[];
  channels: FeedChannelWithStats[];
  onClose: () => void;
  onSelectCategory: (category: string) => void;
  onSelectChannel: (channelId: string) => void;
  onSelectArticle: (article: FeedArticle) => void;
  onPlayAudio?: (article: FeedArticle) => void;
  loadChannelArticles: (channelId: string) => Promise<FeedArticle[]>;
}

interface Point {
  x: number;
  y: number;
}

interface NodePointerState {
  node: FeedGalaxyNode;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
}

const ROOT_ID = 'sun-root';
const MAX_ZOOM = 3.5;
const MIN_ZOOM = 0.18;
/** 与 LearningPathStarMapView 的初始缩放一致。 */
const INITIAL_ZOOM = 0.68;

function truncate(text: string, limit: number) {
  const characters = Array.from(text);
  return characters.length > limit
    ? `${characters.slice(0, limit - 1).join('')}…`
    : text;
}

function formatDate(timestamp?: number) {
  if (!timestamp) return '日期未知';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? '日期未知'
    : new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
}

function nodeHaystack(node: FeedGalaxyNode) {
  return [node.label, node.sublabel, node.url, node.categoryName, node.summary]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase();
}

export function FeedGalaxyGraphView({
  categories,
  channels,
  onClose,
  onSelectCategory,
  onSelectChannel,
  onSelectArticle,
  onPlayAudio,
  loadChannelArticles,
}: FeedGalaxyGraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 920, height: 640 });
  const [pan, setPan] = useState<Point>({ x: 460, y: 320 });
  const [scale, setScale] = useState(INITIAL_ZOOM);
  const [isPanning, setIsPanning] = useState(false);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<{
    node: FeedGalaxyNode;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [pinnedCardNodeId, setPinnedCardNodeId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [onlyAudio, setOnlyAudio] = useState(false);
  const [showSatellites, setShowSatellites] = useState(true);
  const [showOrbitGuides, setShowOrbitGuides] = useState(false);
  const [showSiblingArcs, setShowSiblingArcs] = useState(true);
  const [useCategoryColors, setUseCategoryColors] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [nodeSizeScale, setNodeSizeScale] = useState(1);
  const [labelFadeThreshold, setLabelFadeThreshold] = useState(0.68);
  const [physicsConfig, setPhysicsConfig] = useState<GalaxyPhysicsConfig>(
    DEFAULT_GALAXY_PHYSICS_CONFIG,
  );
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedChannelId, setExpandedChannelId] = useState<string | null>(
    null,
  );
  const [articlesByChannel, setArticlesByChannel] = useState<
    Record<string, FeedArticle[]>
  >({});
  const [loadingChannelId, setLoadingChannelId] = useState<string | null>(null);
  const [articleLoadErrors, setArticleLoadErrors] = useState<
    Record<string, string>
  >({});
  const [livePositions, setLivePositions] = useState<Record<string, Point>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenFallback, setFullscreenFallback] = useState(false);

  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const dragRef = useRef<NodePointerState | null>(null);
  const physicsRef = useRef<GalaxyPhysicsState | null>(null);
  const physicsConfigRef = useRef(physicsConfig);
  physicsConfigRef.current = physicsConfig;
  const rafRef = useRef<number | null>(null);
  const hasInitializedView = useRef(false);
  const dimensionsRef = useRef(dimensions);
  dimensionsRef.current = dimensions;
  const positionsRef = useRef(livePositions);
  positionsRef.current = livePositions;

  const loadedArticles = useMemo(
    () => Object.values(articlesByChannel).flat(),
    [articlesByChannel],
  );
  const graph = useMemo(
    () =>
      buildFeedGalaxyGraph(
        categories,
        channels,
        expandedChannelId,
        loadedArticles,
        { useCategoryColors },
      ),
    [
      categories,
      channels,
      expandedChannelId,
      loadedArticles,
      useCategoryColors,
    ],
  );

  // 预载未读靠前的订阅源文章，让默认视图也有第 4 层文章卫星，与课程星图的知识点卫星密度一致。
  const requestedPreviewIds = useRef(new Set<string>());
  useEffect(() => {
    const targets = rankUnreadChannels(channels)
      .slice(0, FEED_GALAXY_HIGHLIGHT_LIMIT)
      .map((channel) => channel.id)
      .filter((id) => !requestedPreviewIds.current.has(id));
    if (targets.length === 0) return;
    for (const id of targets) requestedPreviewIds.current.add(id);
    // 不随 channels 刷新而丢弃结果；同一订阅源只预载一次，失败的允许下次重试。
    void Promise.allSettled(
      targets.map((id) =>
        loadChannelArticles(id).then((items) => [id, items] as const),
      ),
    ).then((results) => {
      const loaded = results.flatMap((result, index) => {
        if (result.status === 'fulfilled') return [result.value];
        requestedPreviewIds.current.delete(targets[index]);
        return [];
      });
      if (loaded.length === 0) return;
      setArticlesByChannel((current) => {
        const next = { ...current };
        for (const [id, items] of loaded) {
          if (!Object.prototype.hasOwnProperty.call(next, id)) next[id] = items;
        }
        return next;
      });
    });
  }, [channels, loadChannelArticles]);
  const nodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );
  const adjacency = useMemo(
    () => buildGalaxyAdjacencyMap(graph.nodes, graph.links),
    [graph.nodes, graph.links],
  );

  const searchQuery = searchFilter.trim().toLocaleLowerCase();

  const visibleNodeIds = useMemo(() => {
    const visible = new Set<string>([ROOT_ID]);
    const collapsed = (node: FeedGalaxyNode) => {
      let parentId = node.parentId;
      while (parentId) {
        if (collapsedCategories.has(parentId)) return true;
        parentId = nodeById.get(parentId)?.parentId;
      }
      return false;
    };
    for (const node of graph.nodes) {
      if (node.kind === 'sun') continue;
      if (!showSatellites && node.kind === 'satellite') continue;
      const revealedBySearch =
        Boolean(searchQuery) && nodeHaystack(node).includes(searchQuery);
      if (collapsed(node) && !revealedBySearch) continue;
      visible.add(node.id);
    }
    return visible;
  }, [collapsedCategories, graph.nodes, nodeById, searchQuery, showSatellites]);

  const filteredNodeIds = useMemo(() => {
    if (!searchQuery && !onlyUnread && !onlyAudio) return null;
    const matches = new Set<string>([ROOT_ID]);
    const direct = graph.nodes.filter((node) => {
      if (node.kind === 'sun') return false;
      if (searchQuery && !nodeHaystack(node).includes(searchQuery))
        return false;
      if (onlyUnread && node.unreadCount === 0) return false;
      if (onlyAudio && node.audioCount === 0) return false;
      return true;
    });
    for (const node of direct) {
      let current: FeedGalaxyNode | undefined = node;
      while (current) {
        matches.add(current.id);
        current = current.parentId ? nodeById.get(current.parentId) : undefined;
      }
    }
    return matches;
  }, [graph.nodes, nodeById, onlyAudio, onlyUnread, searchQuery]);

  const visibleIdsRef = useRef(visibleNodeIds);
  visibleIdsRef.current = visibleNodeIds;

  const nonCollidingLabelIds = useMemo(() => {
    const priorityIds = new Set<string>();
    if (hoveredNode?.node.id) priorityIds.add(hoveredNode.node.id);
    if (pinnedCardNodeId) priorityIds.add(pinnedCardNodeId);
    for (const node of graph.nodes) {
      if (node.isFocus || node.isHighlighted) priorityIds.add(node.id);
    }
    return computeVisibleGalaxyLabelIds({
      nodes: graph.nodes,
      positions: livePositions,
      scale,
      visibleIds: visibleNodeIds,
      priorityIds,
    });
  }, [
    graph.nodes,
    hoveredNode?.node.id,
    livePositions,
    pinnedCardNodeId,
    scale,
    visibleNodeIds,
  ]);

  const syncPositions = useCallback((state: GalaxyPhysicsState) => {
    const next: Record<string, Point> = {};
    for (const body of state.bodyList) next[body.id] = { x: body.x, y: body.y };
    setLivePositions(next);
  }, []);

  const startSimulation = useCallback(() => {
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
        syncPositions(state);
      }
      if (keepRunning) rafRef.current = requestAnimationFrame(tick);
      else rafRef.current = null;
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [syncPositions]);

  const reheatSimulation = useCallback(
    (alpha = 0.32) => {
      if (!physicsRef.current) return;
      physicsRef.current.alpha = Math.max(physicsRef.current.alpha, alpha);
      startSimulation();
    },
    [startSimulation],
  );

  useEffect(() => {
    const previousBodies = physicsRef.current?.bodies;
    const seededGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        ...(positionsRef.current[node.id] ?? {}),
        ...(previousBodies?.get(node.id)
          ? {
              orbitRadius: previousBodies.get(node.id)!.orbitRadius,
              orbitAngle: previousBodies.get(node.id)!.orbitAngle,
            }
          : {}),
      })),
    };
    const state = createGalaxyPhysicsState(seededGraph);
    for (let index = 0; index < 8; index++) {
      stepGalaxyPhysics(state, physicsConfigRef.current, visibleIdsRef.current);
    }
    physicsRef.current = state;
    syncPositions(state);
    startSimulation();
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [graph, startSimulation, syncPositions]);

  useEffect(() => {
    reheatSimulation(0.38);
  }, [
    physicsConfig.repelStrength,
    physicsConfig.linkDistanceScale,
    physicsConfig.linkTension,
    physicsConfig.centerGravity,
    onlyUnread,
    onlyAudio,
    showSatellites,
    visibleNodeIds,
    reheatSimulation,
  ]);

  // 与课程星图一致：固定初始缩放居中，保证分类/订阅源显示完整名称而不是编号。
  const fitView = useCallback(
    (width = dimensions.width, height = dimensions.height) => {
      setScale(INITIAL_ZOOM);
      setPan({ x: width / 2, y: height / 2 });
    },
    [dimensions.height, dimensions.width],
  );

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const next = { width: rect.width, height: rect.height };
      setDimensions(next);
      if (!hasInitializedView.current) {
        hasInitializedView.current = true;
        fitView(next.width, next.height);
      } else {
        setPan((current) => ({
          x: current.x + (next.width - dimensionsRef.current.width) / 2,
          y: current.y + (next.height - dimensionsRef.current.height) / 2,
        }));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitView]);

  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(
        document.fullscreenElement === containerRef.current ||
          fullscreenFallback,
      );
    };
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () =>
      document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, [fullscreenFallback]);

  useEffect(() => {
    if (!fullscreenFallback) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setFullscreenFallback(false);
      setIsFullscreen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [fullscreenFallback]);

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement === container) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (fullscreenFallback) {
      setFullscreenFallback(false);
      setIsFullscreen(false);
      return;
    }
    try {
      await container.requestFullscreen();
      setIsFullscreen(true);
    } catch {
      setFullscreenFallback(true);
      setIsFullscreen(true);
    }
  }, [fullscreenFallback]);

  const clientToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
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

  const focusNode = useCallback(
    (nodeId: string, targetScale = 0.95) => {
      const node = nodeById.get(nodeId);
      const position = positionsRef.current[nodeId] ?? node;
      if (!node || !position) return;
      const canvasRect = canvasRef.current?.getBoundingClientRect();
      setScale(targetScale);
      setPan({
        x: Math.round(
          (canvasRect?.width ?? dimensions.width) / 2 -
            position.x * targetScale,
        ),
        y: Math.round(
          (canvasRect?.height ?? dimensions.height) / 2 -
            position.y * targetScale,
        ),
      });
      setPinnedCardNodeId(nodeId);
    },
    [dimensions.height, dimensions.width, nodeById],
  );

  const handleResetView = () => {
    const state = createGalaxyPhysicsState(graph);
    for (let index = 0; index < 8; index++) {
      stepGalaxyPhysics(state, physicsConfigRef.current, visibleIdsRef.current);
    }
    physicsRef.current = state;
    syncPositions(state);
    startSimulation();
    const rect = canvasRef.current?.getBoundingClientRect();
    fitView(rect?.width ?? dimensions.width, rect?.height ?? dimensions.height);
    setSearchFilter('');
  };

  const handleResetPhysicsDefaults = () => {
    setPhysicsConfig(DEFAULT_GALAXY_PHYSICS_CONFIG);
    setNodeSizeScale(1);
    setLabelFadeThreshold(0.68);
    setOnlyUnread(false);
    setOnlyAudio(false);
    setShowSatellites(true);
    setShowOrbitGuides(false);
    setShowSiblingArcs(true);
    setUseCategoryColors(false);
  };

  const handleCanvasPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const target = event.target as HTMLElement;
    if (target.closest('.galaxy-node-group')) return;
    if (target.closest('.book-galaxy-controls-drawer')) return;
    if (target.closest('.lp-star-video-card')) return;
    if (target.closest('.lp-starmap-dock')) return;
    panStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleNodePointerDown = (
    event: ReactPointerEvent<SVGGElement>,
    node: FeedGalaxyNode,
  ) => {
    event.stopPropagation();
    dragRef.current = {
      node,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    if (node.kind !== 'sun') {
      const point = clientToWorld(event.clientX, event.clientY);
      const body = physicsRef.current?.bodies.get(node.id);
      if (body) {
        body.fx = point.x;
        body.fy = point.y;
        setDraggingNodeId(node.id);
        reheatSimulation(0.35);
      }
    }
    canvasRef.current?.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const drag = dragRef.current;
    if (drag) {
      if (
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >=
        4
      ) {
        drag.moved = true;
      }
      if (drag.node.kind !== 'sun') {
        const point = clientToWorld(event.clientX, event.clientY);
        const body = physicsRef.current?.bodies.get(drag.node.id);
        if (body) {
          body.fx = point.x;
          body.fy = point.y;
          reheatSimulation(0.28);
        }
      }
      return;
    }
    if (!isPanning) return;
    setPan({
      x: panStartRef.current.panX + event.clientX - panStartRef.current.x,
      y: panStartRef.current.panY + event.clientY - panStartRef.current.y,
    });
  };

  const handleCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) {
      const body = physicsRef.current?.bodies.get(drag.node.id);
      if (body && drag.node.kind !== 'sun') {
        if (drag.node.kind === 'cluster') {
          const sun = physicsRef.current?.bodies.get(ROOT_ID);
          body.anchorX = body.x - (sun?.x ?? 0);
          body.anchorY = body.y - (sun?.y ?? 0);
        } else if (body.parentId) {
          const parent = physicsRef.current?.bodies.get(body.parentId);
          if (parent) {
            const dx = body.x - parent.x;
            const dy = body.y - parent.y;
            body.orbitRadius = Math.max(36, Math.hypot(dx, dy));
            body.orbitAngle = Math.atan2(dy, dx);
          }
        }
        body.fx = null;
        body.fy = null;
        reheatSimulation(0.22);
      }
      const wasClick = !drag.moved;
      dragRef.current = null;
      setDraggingNodeId(null);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // 宿主视图可能已释放指针捕获。
      }
      if (wasClick) {
        setPinnedCardNodeId((current) =>
          current === drag.node.id ? null : drag.node.id,
        );
      }
      return;
    }
    if (!isPanning) return;
    const moved = Math.hypot(
      event.clientX - panStartRef.current.x,
      event.clientY - panStartRef.current.y,
    );
    setIsPanning(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 宿主视图可能已释放指针捕获。
    }
    if (moved < 4) setPinnedCardNodeId(null);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.lp-star-video-card')) return;
    event.preventDefault();
    const nextScale = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, scale * (event.deltaY < 0 ? 1.12 : 0.89)),
    );
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    setPan({
      x: mouseX - (mouseX - pan.x) * (nextScale / scale),
      y: mouseY - (mouseY - pan.y) * (nextScale / scale),
    });
    setScale(nextScale);
  };

  async function expandChannel(channelId: string) {
    setExpandedChannelId(channelId);
    setPinnedCardNodeId(`feed:${channelId}`);
    setArticleLoadErrors((current) => {
      if (!current[channelId]) return current;
      const next = { ...current };
      delete next[channelId];
      return next;
    });
    if (Object.prototype.hasOwnProperty.call(articlesByChannel, channelId)) {
      return;
    }
    setLoadingChannelId(channelId);
    try {
      const recentArticles = await loadChannelArticles(channelId);
      setArticlesByChannel((current) => ({
        ...current,
        [channelId]: recentArticles,
      }));
      reheatSimulation(0.45);
    } catch (error) {
      setArticleLoadErrors((current) => ({
        ...current,
        [channelId]:
          error instanceof Error
            ? error.message
            : '最近文章加载失败，请稍后重试。',
      }));
    } finally {
      setLoadingChannelId((current) =>
        current === channelId ? null : current,
      );
    }
  }

  async function toggleChannelArticles(channelId: string) {
    if (loadingChannelId === channelId) return;
    if (expandedChannelId === channelId && !articleLoadErrors[channelId]) {
      setExpandedChannelId(null);
      setPinnedCardNodeId(`feed:${channelId}`);
      return;
    }
    await expandChannel(channelId);
  }

  const toggleCategory = (category: string) => {
    const categoryId = `category:${category}`;
    setCollapsedCategories((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
    reheatSimulation(0.32);
  };

  const openArticle = (article: FeedArticle) => {
    if (article.audioUrl && onPlayAudio) {
      onPlayAudio(article);
      return;
    }
    onSelectArticle(article);
  };

  const nodePosition = (node: FeedGalaxyNode) => livePositions[node.id] ?? node;
  const pinnedNode = pinnedCardNodeId
    ? nodeById.get(pinnedCardNodeId)
    : undefined;
  const activeHoveredId =
    draggingNodeId ?? hoveredNode?.node.id ?? pinnedCardNodeId ?? null;
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

  const sunRadius = Math.round(32 * nodeSizeScale);
  const clusterFontSize = Math.max(
    9.5,
    Math.min(13.5, 11.2 / Math.pow(scale, 0.28)),
  );
  const planetFontSize = Math.max(
    8.5,
    Math.min(11.5, 9.8 / Math.pow(scale, 0.28)),
  );

  const pinnedChannel = pinnedNode?.channelId
    ? channels.find((channel) => channel.id === pinnedNode.channelId)
    : undefined;
  const pinnedArticle = pinnedNode?.articleId
    ? articlesByChannel[pinnedNode.channelId ?? '']?.find(
        (article) => article.id === pinnedNode.articleId,
      )
    : undefined;
  const topUnreadChannels = graph.nodes
    .filter((node) => node.kind === 'planet' && node.unreadCount > 0)
    .sort((a, b) => b.unreadCount - a.unreadCount)
    .slice(0, 6);
  const focusUnread = () => {
    const target = topUnreadChannels[0];
    if (target) focusNode(target.id, 1);
  };

  const focusListedNode = (node: FeedGalaxyNode) => {
    if (node.parentId && collapsedCategories.has(node.parentId)) {
      const parentId = node.parentId;
      setCollapsedCategories((current) => {
        const next = new Set(current);
        next.delete(parentId);
        return next;
      });
    }
    focusNode(node.id, 1.05);
  };

  const pinnedCardScreenPos = useMemo(() => {
    if (!pinnedNode) return null;
    const position = livePositions[pinnedNode.id] ?? pinnedNode;
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const containerRect = containerRef.current?.getBoundingClientRect();
    const offsetX = (canvasRect?.left ?? 0) - (containerRect?.left ?? 0);
    const offsetY = (canvasRect?.top ?? 0) - (containerRect?.top ?? 0);
    const rawX = offsetX + pan.x + position.x * scale;
    const rawY = offsetY + pan.y + position.y * scale;
    const cardW = 348;
    const cardH = pinnedNode.kind === 'satellite' ? 430 : 390;
    const width = containerRect?.width ?? dimensions.width;
    const height = containerRect?.height ?? dimensions.height;
    const preferRight = rawX + 24 + cardW <= width - 14;
    const left = preferRight
      ? Math.max(14, rawX + 22)
      : Math.max(14, Math.min(rawX - cardW - 22, width - cardW - 14));
    const top = Math.max(54, Math.min(rawY - 60, height - cardH - 14));
    return { left: Math.round(left), top: Math.round(top) };
  }, [
    dimensions.height,
    dimensions.width,
    livePositions,
    pan.x,
    pan.y,
    pinnedNode,
    scale,
  ]);

  const renderedCount = Math.max(0, visibleNodeIds.size - 1);

  return (
    <section
      ref={containerRef}
      className={`book-galaxy-container feed-galaxy-root${fullscreenFallback ? ' is-fullscreen-fallback' : ''}`}
      aria-label="RSS 订阅关系图"
    >
      <div className="book-galaxy-header">
        <div className="book-galaxy-title-wrap">
          <span className="book-galaxy-badge">订阅星系</span>
          <span className="book-galaxy-title">订阅总览</span>
          <div className="book-galaxy-stats">
            <span className="book-galaxy-stat-pill">
              节点: {renderedCount}/{Math.max(0, graph.nodes.length - 1)}
            </span>
            <span>·</span>
            <span className="book-galaxy-stat-pill">
              未读: {graph.stats.unreadCount}
            </span>
            <span>·</span>
            <span className="book-galaxy-stat-pill">
              订阅源: {graph.stats.channelCount}
            </span>
            <span>·</span>
            <span className="book-galaxy-stat-pill">
              音频: {graph.stats.audioCount}
            </span>
          </div>
        </div>
        <div className="book-galaxy-actions">
          <input
            type="text"
            className="book-galaxy-search-input"
            value={searchFilter}
            onChange={(event) => setSearchFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              const match = graph.nodes.find(
                (node) =>
                  node.kind !== 'sun' &&
                  nodeHaystack(node).includes(searchQuery),
              );
              if (match) focusNode(match.id, 0.95);
            }}
            aria-label="搜索分类、订阅源或文章"
            placeholder="检索分类、订阅源或文章…"
          />
          <button
            type="button"
            className={`book-galaxy-btn ${onlyUnread ? 'is-active' : ''}`}
            title="未读节点保持高亮，已读节点变暗"
            aria-pressed={onlyUnread}
            onClick={() => setOnlyUnread((value) => !value)}
          >
            仅看未读
          </button>
          <button
            type="button"
            className={`book-galaxy-btn ${controlsOpen ? 'is-active' : ''}`}
            title="打开力导向物理与视图参数"
            onClick={() => setControlsOpen((value) => !value)}
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
          <button
            type="button"
            className={`book-galaxy-btn${isFullscreen ? ' is-active' : ''}`}
            title={isFullscreen ? '退出全屏（Esc）' : '全屏显示星图'}
            aria-label={isFullscreen ? '退出全屏' : '全屏显示星图'}
            aria-pressed={isFullscreen}
            onClick={() => void toggleFullscreen()}
          >
            {isFullscreen ? '退出全屏' : '全屏'}
          </button>
          <button
            type="button"
            className="book-galaxy-btn is-primary"
            onClick={onClose}
          >
            返回列表
          </button>
        </div>
      </div>

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
              <span>仅高亮未读节点</span>
              <input
                type="checkbox"
                checked={onlyUnread}
                onChange={(event) => setOnlyUnread(event.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>仅高亮含音频的节点</span>
              <input
                type="checkbox"
                checked={onlyAudio}
                onChange={(event) => setOnlyAudio(event.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示文章卫星</span>
              <input
                type="checkbox"
                checked={showSatellites}
                onChange={(event) => setShowSatellites(event.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示同心轨道参考环</span>
              <input
                type="checkbox"
                checked={showOrbitGuides}
                onChange={(event) => setShowOrbitGuides(event.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>显示同类订阅弧线</span>
              <input
                type="checkbox"
                checked={showSiblingArcs}
                onChange={(event) => setShowSiblingArcs(event.target.checked)}
              />
            </label>
            <label className="book-galaxy-toggle-row">
              <span>使用分类自定义颜色</span>
              <input
                type="checkbox"
                checked={useCategoryColors}
                onChange={(event) => setUseCategoryColors(event.target.checked)}
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
                onChange={(event) =>
                  setNodeSizeScale(Number(event.target.value))
                }
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
                onChange={(event) =>
                  setLabelFadeThreshold(Number(event.target.value))
                }
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
                onChange={(event) =>
                  setPhysicsConfig((current) => ({
                    ...current,
                    repelStrength: Number(event.target.value),
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
                onChange={(event) =>
                  setPhysicsConfig((current) => ({
                    ...current,
                    linkDistanceScale: Number(event.target.value),
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
                onChange={(event) =>
                  setPhysicsConfig((current) => ({
                    ...current,
                    centerGravity: Number(event.target.value),
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

      <div
        ref={canvasRef}
        className={`book-galaxy-canvas ${isPanning ? 'is-panning' : ''} ${
          draggingNodeId ? 'is-dragging-node' : ''
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
          role="group"
          aria-label="RSS 分类和订阅源拓扑"
        >
          <defs>
            <radialGradient id="feedStarSunGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ff7b54" />
              <stop offset="70%" stopColor="#e05638" />
              <stop offset="100%" stopColor="#992e18" />
            </radialGradient>
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
                    spotlightIds.has(link.source)) ||
                  (nodeById.get(activeHoveredId || '')?.kind === 'cluster' &&
                    spotlightIds.has(link.source) &&
                    spotlightIds.has(link.target))
                : false;
              const isDimmedBySpotlight =
                Boolean(spotlightIds) && !isSpotlightLink;
              const isSearchDimmed =
                Boolean(filteredNodeIds) &&
                !filteredNodeIds?.has(link.source) &&
                !filteredNodeIds?.has(link.target);
              if (link.kind === 'sequence') {
                if (!showSiblingArcs) return null;
                // 与课程星图的前置依赖弧线同款：二次贝塞尔上拱 28px。
                const mx = (source.x + target.x) / 2;
                const my = (source.y + target.y) / 2 - 28;
                return (
                  <path
                    key={`seq:${link.source}:${link.target}`}
                    d={`M ${source.x} ${source.y} Q ${mx} ${my} ${target.x} ${target.y}`}
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
              return (
                <line
                  key={`${link.source}:${link.target}`}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  className={`galaxy-link-orbit ${
                    link.source === ROOT_ID ? 'is-root-spoke' : 'is-intra'
                  } ${isSpotlightLink ? 'is-spotlight' : ''} ${
                    isDimmedBySpotlight || isSearchDimmed ? 'is-dimmed' : ''
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
              const isStarredArticle =
                node.kind === 'satellite' && node.starred;
              const isMatch = filteredNodeIds
                ? filteredNodeIds.has(node.id)
                : true;
              const isHoveredSelf = activeHoveredId === node.id;
              const isPinnedSelf = pinnedCardNodeId === node.id;
              const isSpotlightNeighbor = spotlightIds
                ? spotlightIds.has(node.id)
                : false;
              const isDimmed =
                (Boolean(spotlightIds) && !isSpotlightNeighbor) ||
                (Boolean(filteredNodeIds) && !isMatch);
              const isCaughtUp =
                isPlanet && node.totalCount > 0 && node.unreadCount === 0;
              // 状态映射对齐课程星图：
              // 焦点源 ≈ 下一节（唯一脉冲）；未读前列 ≈ 检查点（放大 + 常驻标签）；已读完 ≈ 已完成（光晕）。
              const isFocus = isPlanet && Boolean(node.isFocus);
              const isHighlighted = isPlanet && Boolean(node.isHighlighted);
              const isEmphasized = isFocus || isHighlighted || isCaughtUp;
              const degreeBoost = Math.min(3.5, (node.degree ?? 0) * 0.22);
              const displayRadius = isSun
                ? sunRadius
                : isCluster
                  ? (9.5 + degreeBoost) * nodeSizeScale
                  : isPlanet
                    ? ((isEmphasized ? 6.2 : 4.8) + degreeBoost * 0.3) *
                      nodeSizeScale
                    : isStarredArticle
                      ? 6.4 * nodeSizeScale
                      : 3.1 * nodeSizeScale;
              const t1 = labelFadeThreshold * 0.55;
              const t2 = labelFadeThreshold;
              const forceShowLabel =
                isHoveredSelf ||
                isPinnedSelf ||
                isSpotlightNeighbor ||
                isFocus ||
                isHighlighted ||
                (Boolean(filteredNodeIds) && isMatch);
              const labelClear = nonCollidingLabelIds.has(node.id);
              let planetLabelOpacity = 0;
              if (forceShowLabel) planetLabelOpacity = 1;
              else if (labelClear && scale >= t2) planetLabelOpacity = 0.88;
              else if (labelClear && scale > t1) {
                planetLabelOpacity = ((scale - t1) / (t2 - t1)) * 0.85;
              }
              const showSatelliteLabel =
                isHoveredSelf ||
                isPinnedSelf ||
                isSpotlightNeighbor ||
                (labelClear && scale >= labelFadeThreshold * 1.15) ||
                (labelClear &&
                  isStarredArticle &&
                  scale >= labelFadeThreshold * 0.72);
              const cleanPlanetText =
                scale >= 0.88 ||
                isHoveredSelf ||
                isPinnedSelf ||
                isSpotlightNeighbor
                  ? truncate(node.label, 20)
                  : node.shortCode || truncate(node.label, 10);
              const prominent = isEmphasized || isPinnedSelf;

              return (
                <g
                  key={node.id}
                  className={`galaxy-node-group is-${node.kind} ${
                    isStarredArticle ? 'is-note' : ''
                  } ${prominent || isStarredArticle ? 'has-note' : 'no-note'} ${
                    isHoveredSelf || isPinnedSelf ? 'is-hovered' : ''
                  } ${isSpotlightNeighbor ? 'is-neighbor' : ''} ${
                    isDimmed ? 'is-dimmed' : ''
                  }`}
                  transform={`translate(${position.x}, ${position.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.label}，${node.unreadCount} 篇未读`}
                  onPointerDown={(event) => handleNodePointerDown(event, node)}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    if (node.kind === 'planet' && node.channelId) {
                      onSelectChannel(node.channelId);
                      return;
                    }
                    if (node.kind === 'cluster' && node.categoryName) {
                      onSelectCategory(node.categoryName);
                      return;
                    }
                    if (node.kind !== 'satellite' || !node.articleId) return;
                    const article = articlesByChannel[
                      node.channelId ?? ''
                    ]?.find((item) => item.id === node.articleId);
                    if (article) openArticle(article);
                  }}
                  onMouseEnter={(event) => {
                    if (dragRef.current) return;
                    const rect = canvasRef.current?.getBoundingClientRect();
                    setHoveredNode({
                      node,
                      clientX: event.clientX - (rect?.left ?? 0),
                      clientY: event.clientY - (rect?.top ?? 0),
                    });
                  }}
                  onMouseLeave={() => {
                    if (dragRef.current) return;
                    setHoveredNode(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setPinnedCardNodeId(node.id);
                  }}
                >
                  <circle
                    cx={0}
                    cy={0}
                    r={Math.max(14, displayRadius + 6)}
                    fill="transparent"
                  />
                  {isFocus && (
                    <circle cx={0} cy={0} className="galaxy-current-pulse" />
                  )}
                  {(isEmphasized || isPinnedSelf) && !isSun && (
                    <circle
                      cx={0}
                      cy={0}
                      r={displayRadius + 3.5}
                      className="galaxy-note-halo"
                      style={{ '--node-color': node.color } as CSSProperties}
                    />
                  )}
                  {isSun ? (
                    <>
                      <circle
                        cx={0}
                        cy={0}
                        r={sunRadius}
                        fill="url(#feedStarSunGrad)"
                        className="galaxy-node-circle"
                      />
                      <text x={0} y={5} className="galaxy-sun-monogram">
                        订阅
                      </text>
                      <text
                        x={0}
                        y={sunRadius + 18}
                        className="galaxy-sun-title"
                      >
                        订阅总览
                      </text>
                    </>
                  ) : (
                    <>
                      {isStarredArticle ? (
                        <rect
                          x={-displayRadius}
                          y={-displayRadius}
                          width={displayRadius * 2}
                          height={displayRadius * 2}
                          rx={1.5}
                          fill={node.color}
                          className="galaxy-node-circle galaxy-note-node-mark"
                          style={
                            { '--node-color': node.color } as CSSProperties
                          }
                        />
                      ) : (
                        <circle
                          cx={0}
                          cy={0}
                          r={displayRadius}
                          fill={node.color}
                          className="galaxy-node-circle"
                          style={
                            { '--node-color': node.color } as CSSProperties
                          }
                        />
                      )}
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
                            ? truncate(node.label, 18)
                            : node.shortCode || truncate(node.label, 8)}
                        </text>
                      )}
                      {isPlanet && planetLabelOpacity > 0.04 && (
                        <text
                          x={0}
                          y={displayRadius + 11}
                          className={`galaxy-planet-badge ${
                            prominent || isHoveredSelf ? 'is-prominent' : ''
                          }`}
                          style={{
                            fontSize: `${planetFontSize}px`,
                            opacity: planetLabelOpacity,
                          }}
                        >
                          {cleanPlanetText}
                        </text>
                      )}
                      {node.kind === 'satellite' && showSatelliteLabel && (
                        <text
                          x={0}
                          y={displayRadius + 10}
                          className="galaxy-node-sublabel"
                          style={{ fontSize: `${planetFontSize * 0.9}px` }}
                        >
                          {truncate(node.label, 14)}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        <div className="book-galaxy-hud-hint">
          <span>单击星点：弹出订阅卡片</span>
          <span>·</span>
          <span>双击星点：打开列表或文章</span>
          <span>·</span>
          <span>拖拽：物理牵引星簇</span>
          <span>·</span>
          <span>滚轮：缩放 ({Math.round(scale * 100)}%)</span>
        </div>

        <div className="lp-starmap-dock lp-starmap-dock-right">
          <button
            type="button"
            onClick={() =>
              setScale((value) =>
                Math.max(MIN_ZOOM, Number((value - 0.12).toFixed(2))),
              )
            }
            title="缩小星图"
            aria-label="缩小"
          >
            −
          </button>
          <span className="lp-starmap-zoom-readout">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() =>
              setScale((value) =>
                Math.min(MAX_ZOOM, Number((value + 0.12).toFixed(2))),
              )
            }
            title="放大星图"
            aria-label="放大"
          >
            +
          </button>
          <button type="button" onClick={handleResetView}>
            适配全景
          </button>
          {topUnreadChannels.length > 0 && (
            <button type="button" onClick={focusUnread}>
              定位未读
            </button>
          )}
        </div>

        {hoveredNode &&
          !draggingNodeId &&
          hoveredNode.node.id !== pinnedCardNodeId && (
            <div
              className="book-galaxy-tooltip"
              style={{
                left: Math.min(hoveredNode.clientX, dimensions.width - 280),
                top: Math.min(hoveredNode.clientY, dimensions.height - 150),
              }}
            >
              <div className="book-galaxy-tooltip-head">
                <span>
                  {hoveredNode.node.kind === 'sun'
                    ? '订阅总览'
                    : hoveredNode.node.label}
                </span>
                <span className="book-galaxy-badge">
                  {hoveredNode.node.kind === 'sun'
                    ? '星系核心'
                    : hoveredNode.node.kind === 'cluster'
                      ? hoveredNode.node.shortCode || '分类'
                      : hoveredNode.node.kind === 'planet'
                        ? hoveredNode.node.shortCode || '订阅源'
                        : hoveredNode.node.starred
                          ? '标星文章'
                          : '文章'}
                </span>
              </div>
              {hoveredNode.node.categoryName &&
                hoveredNode.node.kind !== 'cluster' && (
                  <div className="book-galaxy-tooltip-meta">
                    所属分类：{hoveredNode.node.categoryName}
                  </div>
                )}
              <div className="book-galaxy-tooltip-meta">
                未读 {hoveredNode.node.unreadCount}
                {hoveredNode.node.kind !== 'satellite'
                  ? ` · 文章 ${hoveredNode.node.totalCount} · 音频 ${hoveredNode.node.audioCount}`
                  : hoveredNode.node.audioUrl
                    ? ' · 含音频'
                    : ''}
              </div>
              <div
                className={`book-galaxy-tooltip-status ${
                  hoveredNode.node.unreadCount > 0
                    ? 'is-has-note'
                    : 'is-no-note'
                }`}
              >
                <span>
                  {hoveredNode.node.kind === 'planet' &&
                  hoveredNode.node.unreadCount > 0
                    ? '● 有未读文章（单击展开卡片）'
                    : hoveredNode.node.kind === 'planet' &&
                        hoveredNode.node.totalCount > 0
                      ? '● 该订阅源已读完'
                      : '单击星点查看操作'}
                </span>
              </div>
            </div>
          )}
      </div>

      {pinnedNode && pinnedCardScreenPos && (
        <aside
          className="lp-star-video-card"
          style={
            {
              left: pinnedCardScreenPos.left,
              top: pinnedCardScreenPos.top,
              '--star-accent': pinnedNode.color,
            } as CSSProperties
          }
          aria-label="星点订阅卡片"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {pinnedNode.kind === 'sun' || pinnedNode.kind === 'cluster' ? (
            <>
              <div className="lp-star-vcard-stage-head">
                <div>
                  <span className="lp-star-vcard-pill">
                    {pinnedNode.kind === 'sun'
                      ? '订阅全星系'
                      : pinnedNode.shortCode || '分类'}
                  </span>
                  <h4>{pinnedNode.label}</h4>
                </div>
                <button
                  type="button"
                  className="lp-star-vcard-close"
                  onClick={() => setPinnedCardNodeId(null)}
                  title="关闭卡片"
                >
                  ✕
                </button>
              </div>
              {pinnedNode.sublabel && (
                <p className="lp-star-vcard-note">{pinnedNode.sublabel}</p>
              )}
              <dl className="feed-galaxy-card-metrics">
                <div>
                  <dt>未读</dt>
                  <dd>{pinnedNode.unreadCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>文章</dt>
                  <dd>{pinnedNode.totalCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>音频</dt>
                  <dd>{pinnedNode.audioCount.toLocaleString()}</dd>
                </div>
                {pinnedNode.kind === 'cluster' && (
                  <div>
                    <dt>订阅源</dt>
                    <dd>{pinnedNode.channelCount ?? 0}</dd>
                  </div>
                )}
              </dl>
              <div className="lp-star-vcard-playlist">
                {(pinnedNode.kind === 'sun'
                  ? topUnreadChannels
                  : graph.nodes.filter(
                      (node) =>
                        node.parentId === pinnedNode.id &&
                        node.kind === 'planet',
                    )
                ).map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className="lp-star-vcard-playitem"
                    onClick={() => focusListedNode(node)}
                  >
                    <div className="lp-star-vcard-playitem-info">
                      <strong>
                        {node.shortCode ? `${node.shortCode} · ` : ''}
                        {node.label}
                      </strong>
                      <span>
                        未读 {node.unreadCount}
                        {node.audioCount > 0
                          ? ` · 音频 ${node.audioCount}`
                          : ''}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              <div className="lp-star-vcard-actions">
                {pinnedNode.kind === 'cluster' && pinnedNode.categoryName && (
                  <>
                    <button
                      type="button"
                      className="book-galaxy-btn"
                      onClick={() => toggleCategory(pinnedNode.categoryName!)}
                    >
                      {collapsedCategories.has(pinnedNode.id)
                        ? '展开订阅源'
                        : '收起订阅源'}
                    </button>
                    <button
                      type="button"
                      className="book-galaxy-btn is-primary"
                      onClick={() => onSelectCategory(pinnedNode.categoryName!)}
                    >
                      打开分类列表
                    </button>
                  </>
                )}
                {pinnedNode.kind === 'sun' && topUnreadChannels[0] && (
                  <button
                    type="button"
                    className="book-galaxy-btn is-primary"
                    onClick={focusUnread}
                  >
                    定位未读最多的源
                  </button>
                )}
              </div>
            </>
          ) : pinnedNode.kind === 'planet' && pinnedChannel ? (
            <>
              <header className="lp-star-vcard-inst-head">
                <div className="lp-star-vcard-top-badges">
                  <span className="lp-star-vcard-pill">
                    {pinnedNode.shortCode || '订阅源'}
                  </span>
                  <span
                    className={`lp-star-vcard-status ${
                      pinnedNode.unreadCount > 0
                        ? 'is-in_progress'
                        : 'is-completed'
                    }`}
                  >
                    {pinnedNode.unreadCount > 0
                      ? `${pinnedNode.unreadCount} 未读`
                      : '已读完'}
                  </span>
                </div>
                <button
                  type="button"
                  className="lp-star-vcard-close"
                  onClick={() => setPinnedCardNodeId(null)}
                  title="关闭卡片"
                >
                  ✕
                </button>
              </header>
              <div className="feed-galaxy-card-body">
                <h3 className="lp-star-vcard-title">{pinnedNode.label}</h3>
                <p className="lp-star-vcard-submeta">{pinnedChannel.url}</p>
                <p className="lp-star-vcard-note">
                  所属分类：{pinnedChannel.category || '未分类'}
                  <br />
                  最近同步：{formatDate(pinnedChannel.lastSyncAt)}
                  <br />
                  文章 {pinnedNode.totalCount} · 音频 {pinnedNode.audioCount}
                </p>
                {pinnedChannel.syncStatus === 'error' && (
                  <p className="feed-galaxy-card-error">
                    {pinnedChannel.errorMessage || '上次同步失败'}
                  </p>
                )}
                {articleLoadErrors[pinnedChannel.id] && (
                  <p className="feed-galaxy-card-error" role="alert">
                    {articleLoadErrors[pinnedChannel.id]}
                  </p>
                )}
                {expandedChannelId === pinnedChannel.id &&
                  articlesByChannel[pinnedChannel.id]?.length === 0 &&
                  !articleLoadErrors[pinnedChannel.id] && (
                    <p className="lp-star-vcard-note">该订阅源近期没有文章。</p>
                  )}
              </div>
              <div className="lp-star-vcard-actions">
                <button
                  type="button"
                  className="book-galaxy-btn"
                  disabled={loadingChannelId === pinnedChannel.id}
                  onClick={() => void toggleChannelArticles(pinnedChannel.id)}
                >
                  {loadingChannelId === pinnedChannel.id
                    ? '正在载入…'
                    : articleLoadErrors[pinnedChannel.id]
                      ? '重试加载文章'
                      : expandedChannelId === pinnedChannel.id
                        ? '收起最近文章'
                        : '展开最近文章'}
                </button>
                <button
                  type="button"
                  className="book-galaxy-btn is-primary"
                  onClick={() => onSelectChannel(pinnedChannel.id)}
                >
                  打开订阅源
                </button>
              </div>
            </>
          ) : (
            pinnedArticle && (
              <>
                <header className="lp-star-vcard-inst-head">
                  <div className="lp-star-vcard-top-badges">
                    <span className="lp-star-vcard-pill">
                      {pinnedNode.starred ? '标星文章' : '文章'}
                    </span>
                    <span
                      className={`lp-star-vcard-status ${
                        pinnedArticle.readStatus === 'unread'
                          ? 'is-in_progress'
                          : 'is-completed'
                      }`}
                    >
                      {pinnedArticle.readStatus === 'unread' ? '未读' : '已读'}
                      {pinnedArticle.audioUrl ? ' · 含音频' : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="lp-star-vcard-close"
                    onClick={() => setPinnedCardNodeId(null)}
                    title="关闭卡片"
                  >
                    ✕
                  </button>
                </header>
                <div className="feed-galaxy-card-body">
                  {pinnedArticle.imageUrl && (
                    <img
                      className="feed-galaxy-card-cover"
                      src={pinnedArticle.imageUrl}
                      alt=""
                      loading="lazy"
                    />
                  )}
                  <h3 className="lp-star-vcard-title">{pinnedArticle.title}</h3>
                  <p className="lp-star-vcard-submeta">
                    {pinnedArticle.channelTitle} ·{' '}
                    {formatDate(pinnedArticle.publishedAt)}
                  </p>
                  <p className="lp-star-vcard-note">
                    {pinnedNode.summary || '该文章没有摘要。'}
                  </p>
                </div>
                <div className="lp-star-vcard-actions">
                  {pinnedArticle.audioUrl && onPlayAudio && (
                    <button
                      type="button"
                      className="book-galaxy-btn"
                      onClick={() => onPlayAudio(pinnedArticle)}
                    >
                      播放音频
                    </button>
                  )}
                  <button
                    type="button"
                    className="book-galaxy-btn is-primary"
                    onClick={() => onSelectArticle(pinnedArticle)}
                  >
                    打开文章
                  </button>
                </div>
              </>
            )
          )}
        </aside>
      )}
    </section>
  );
}
