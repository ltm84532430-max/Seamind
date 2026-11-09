import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  buildGalaxyAdjacencyMap,
  createGalaxyPhysicsState,
  DEFAULT_GALAXY_PHYSICS_CONFIG,
  stepGalaxyPhysics,
  type GalaxyPhysicsState,
} from '../graph/galaxy-physics';
import type { CategoryStats, FeedArticle, FeedChannelWithStats } from './types';
import { buildFeedGalaxyGraph, type FeedGalaxyNode } from './feed-galaxy-model';
import './feed-galaxy-view.css';

interface FeedGalaxyGraphViewProps {
  categories: CategoryStats[];
  channels: FeedChannelWithStats[];
  onClose: () => void;
  onSelectCategory: (category: string) => void;
  onSelectChannel: (channelId: string) => void;
  onSelectArticle: (article: FeedArticle) => void;
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
  offsetX: number;
  offsetY: number;
}

const ROOT_ID = 'sun-root';
const MAX_ZOOM = 3.5;
const MIN_ZOOM = 0.22;

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

export function FeedGalaxyGraphView({
  categories,
  channels,
  onClose,
  onSelectCategory,
  onSelectChannel,
  onSelectArticle,
  loadChannelArticles,
}: FeedGalaxyGraphViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 650 });
  const [pan, setPan] = useState<Point>({ x: 450, y: 325 });
  const [scale, setScale] = useState(0.55);
  const [isPanning, setIsPanning] = useState(false);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState(ROOT_ID);
  const [searchFilter, setSearchFilter] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [onlyAudio, setOnlyAudio] = useState(false);
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

  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const dragRef = useRef<NodePointerState | null>(null);
  const physicsRef = useRef<GalaxyPhysicsState | null>(null);
  const rafRef = useRef<number | null>(null);
  const hasInitializedView = useRef(false);
  const positionsRef = useRef(livePositions);
  positionsRef.current = livePositions;
  const graph = useMemo(
    () =>
      buildFeedGalaxyGraph(
        categories,
        channels,
        expandedChannelId,
        expandedChannelId ? (articlesByChannel[expandedChannelId] ?? []) : [],
      ),
    [categories, channels, expandedChannelId, articlesByChannel],
  );
  const nodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );
  const adjacency = useMemo(
    () => buildGalaxyAdjacencyMap(graph.nodes, graph.links),
    [graph.nodes, graph.links],
  );

  const syncPositions = useCallback((state: GalaxyPhysicsState) => {
    const next: Record<string, Point> = {};
    for (const body of state.bodyList) next[body.id] = { x: body.x, y: body.y };
    setLivePositions(next);
  }, []);

  const startSimulation = useCallback(() => {
    if (rafRef.current !== null) return;
    const tick = () => {
      const state = physicsRef.current;
      if (!state) {
        rafRef.current = null;
        return;
      }
      const keepRunning = stepGalaxyPhysics(
        state,
        DEFAULT_GALAXY_PHYSICS_CONFIG,
      );
      syncPositions(state);
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
    for (let index = 0; index < 8; index++)
      stepGalaxyPhysics(state, DEFAULT_GALAXY_PHYSICS_CONFIG);
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

  const fitView = useCallback(
    (width = dimensions.width, height = dimensions.height) => {
      const graphWidth = Math.max(300, graph.bounds.maxX - graph.bounds.minX);
      const graphHeight = Math.max(300, graph.bounds.maxY - graph.bounds.minY);
      const nextScale = Math.min(
        1.15,
        Math.max(
          0.24,
          Math.min((width - 72) / graphWidth, (height - 72) / graphHeight),
        ),
      );
      setScale(nextScale);
      setPan({ x: width / 2, y: height / 2 });
    },
    [
      dimensions.height,
      dimensions.width,
      graph.bounds.maxX,
      graph.bounds.maxY,
      graph.bounds.minX,
      graph.bounds.minY,
    ],
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
          x: current.x + (next.width - dimensions.width) / 2,
          y: current.y + (next.height - dimensions.height) / 2,
        }));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [dimensions.height, dimensions.width, fitView]);

  const visibleNodeIds = useMemo(() => {
    const query = searchFilter.trim().toLocaleLowerCase();
    const directMatches = query
      ? graph.nodes.filter((node) =>
          [node.label, node.sublabel, node.url, node.categoryName]
            .filter(Boolean)
            .some((value) => value!.toLocaleLowerCase().includes(query)),
        )
      : graph.nodes;
    const visible = new Set<string>([ROOT_ID]);

    for (const node of directMatches) {
      if (onlyUnread && node.kind !== 'sun' && node.unreadCount === 0) continue;
      if (onlyAudio && node.kind !== 'sun' && node.audioCount === 0) continue;
      if (!query && isInsideCollapsedCategory(node)) continue;
      if (node.kind === 'satellite' && !expandedChannelId) continue;

      let current: FeedGalaxyNode | undefined = node;
      while (current) {
        visible.add(current.id);
        current = current.parentId ? nodeById.get(current.parentId) : undefined;
      }
    }

    if (query) {
      for (const node of graph.nodes) {
        if (node.kind === 'sun') visible.add(node.id);
      }
    }
    return visible;
  }, [
    collapsedCategories,
    expandedChannelId,
    graph.nodes,
    nodeById,
    onlyAudio,
    onlyUnread,
    searchFilter,
  ]);

  function isInsideCollapsedCategory(node: FeedGalaxyNode) {
    let parentId = node.parentId;
    while (parentId) {
      if (collapsedCategories.has(parentId)) return true;
      parentId = nodeById.get(parentId)?.parentId;
    }
    return false;
  }

  const spotlightIds = useMemo(() => {
    const activeId = draggingNodeId ?? hoveredNodeId ?? selectedNodeId;
    if (!activeId || activeId === ROOT_ID) return null;
    return activeId ? (adjacency.get(activeId) ?? new Set([activeId])) : null;
  }, [adjacency, draggingNodeId, hoveredNodeId, selectedNodeId]);

  const selectedNode = selectedNodeId
    ? nodeById.get(selectedNodeId)
    : undefined;
  const selectedChannel = selectedNode?.channelId
    ? channels.find((channel) => channel.id === selectedNode.channelId)
    : undefined;
  const selectedArticle = selectedNode?.articleId
    ? articlesByChannel[selectedNode.channelId ?? '']?.find(
        (article) => article.id === selectedNode.articleId,
      )
    : undefined;

  const centerNode = useCallback(
    (node: FeedGalaxyNode) => {
      const position = positionsRef.current[node.id] ?? node;
      setPan({
        x: dimensions.width / 2 - position.x * scale,
        y: dimensions.height / 2 - position.y * scale,
      });
      setSelectedNodeId(node.id);
    },
    [dimensions.height, dimensions.width, scale],
  );

  const focusSearchResult = () => {
    const query = searchFilter.trim().toLocaleLowerCase();
    if (!query) return;
    const match = graph.nodes.find((node) =>
      [node.label, node.sublabel, node.url, node.categoryName]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(query)),
    );
    if (match) centerNode(match);
  };

  const clientToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const localX = clientX - (rect?.left ?? 0);
      const localY = clientY - (rect?.top ?? 0);
      return { x: (localX - pan.x) / scale, y: (localY - pan.y) / scale };
    },
    [pan.x, pan.y, scale],
  );

  const handleCanvasPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if ((event.target as HTMLElement).closest('.feed-galaxy-node')) return;
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
    const body = physicsRef.current?.bodies.get(node.id);
    if (!body || node.kind === 'sun') {
      dragRef.current = {
        node,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        offsetX: 0,
        offsetY: 0,
      };
    } else {
      const point = clientToWorld(event.clientX, event.clientY);
      const offsetX = body.x - point.x;
      const offsetY = body.y - point.y;
      body.fx = body.x;
      body.fy = body.y;
      dragRef.current = {
        node,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        offsetX,
        offsetY,
      };
      setDraggingNodeId(node.id);
      reheatSimulation(0.35);
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
      )
        drag.moved = true;
      if (drag.node.kind !== 'sun') {
        const point = clientToWorld(event.clientX, event.clientY);
        const body = physicsRef.current?.bodies.get(drag.node.id);
        if (body) {
          body.fx = point.x + drag.offsetX;
          body.fy = point.y + drag.offsetY;
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
      if (body) {
        if (drag.node.kind === 'cluster') {
          body.anchorX = body.x;
          body.anchorY = body.y;
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
      dragRef.current = null;
      setDraggingNodeId(null);
      setSelectedNodeId(drag.node.id);
      if (!drag.moved && drag.node.kind === 'planet' && drag.node.channelId) {
        // 点击订阅源按需展开最近文章；再次点击则收起文章节点。
        void toggleChannelArticles(drag.node.channelId);
      }
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // 宿主视图可能已释放指针捕获，这里允许重复释放。
      }
      return;
    }
    if (!isPanning) return;
    setIsPanning(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 宿主视图可能已释放指针捕获，这里允许重复释放。
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
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
    setSelectedNodeId(`feed:${channelId}`);
    setExpandedChannelId(channelId);
    setArticleLoadErrors((current) => {
      if (!current[channelId]) return current;
      const next = { ...current };
      delete next[channelId];
      return next;
    });
    if (Object.prototype.hasOwnProperty.call(articlesByChannel, channelId))
      return;
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
      setSelectedNodeId(`feed:${channelId}`);
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

  const nodePosition = (node: FeedGalaxyNode) => livePositions[node.id] ?? node;

  return (
    <section className="feed-galaxy-overlay" aria-label="RSS 订阅关系图">
      <header className="feed-galaxy-header">
        <div className="feed-galaxy-title-wrap">
          <span className="feed-galaxy-overline">RSS / KNOWLEDGE GRAPH</span>
          <strong className="feed-galaxy-title">订阅关系</strong>
          <span className="feed-galaxy-stats">
            {graph.stats.categoryCount} 分类 · {graph.stats.channelCount} 订阅源
            · {graph.stats.unreadCount} 未读 · {graph.stats.audioCount} 音频
          </span>
        </div>
        <div className="feed-galaxy-actions">
          <input
            value={searchFilter}
            onChange={(event) => setSearchFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') focusSearchResult();
            }}
            aria-label="搜索分类、订阅源或文章"
            placeholder="搜索分类、订阅源或文章…"
          />
          <button
            type="button"
            className={onlyUnread ? 'is-active' : ''}
            aria-pressed={onlyUnread}
            onClick={() => setOnlyUnread((value) => !value)}
          >
            未读
          </button>
          <button
            type="button"
            className={onlyAudio ? 'is-active' : ''}
            aria-pressed={onlyAudio}
            onClick={() => setOnlyAudio((value) => !value)}
          >
            含播客
          </button>
          <button type="button" onClick={() => fitView()}>
            适应画布
          </button>
          <button type="button" className="is-primary" onClick={onClose}>
            返回列表
          </button>
        </div>
      </header>

      <div className="feed-galaxy-body">
        <div
          ref={canvasRef}
          className={`feed-galaxy-canvas ${isPanning ? 'is-panning' : ''}`}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerUp}
          onWheel={handleWheel}
        >
          <svg
            className="feed-galaxy-svg"
            width={dimensions.width}
            height={dimensions.height}
            role="group"
            aria-label="RSS 分类和订阅源拓扑"
          >
            <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
              {graph.links.map((link) => {
                if (
                  !visibleNodeIds.has(link.source) ||
                  !visibleNodeIds.has(link.target)
                )
                  return null;
                const sourceNode = nodeById.get(link.source);
                const targetNode = nodeById.get(link.target);
                if (!sourceNode || !targetNode) return null;
                const source = nodePosition(sourceNode);
                const target = nodePosition(targetNode);
                const highlighted =
                  !spotlightIds ||
                  spotlightIds.has(link.source) ||
                  spotlightIds.has(link.target);
                return (
                  <line
                    key={`${link.source}:${link.target}`}
                    className="feed-galaxy-link"
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    style={{
                      stroke: link.color ?? '#697784',
                      opacity: highlighted ? 0.48 : 0.1,
                    }}
                  />
                );
              })}

              {graph.nodes
                .filter((node) => visibleNodeIds.has(node.id))
                .map((node) => {
                  const position = nodePosition(node);
                  const highlighted =
                    !spotlightIds || spotlightIds.has(node.id);
                  const focused = selectedNodeId === node.id;
                  const labelVisible =
                    node.kind === 'sun' ||
                    node.kind === 'cluster' ||
                    scale >= 0.68 ||
                    hoveredNodeId === node.id ||
                    focused;
                  const nodeClass = [
                    'feed-galaxy-node',
                    `is-${node.kind}`,
                    focused ? 'is-selected' : '',
                    !highlighted ? 'is-dimmed' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');

                  return (
                    <g
                      key={node.id}
                      className={nodeClass}
                      transform={`translate(${position.x}, ${position.y})`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.label}，${node.unreadCount} 篇未读`}
                      onPointerDown={(event) =>
                        handleNodePointerDown(event, node)
                      }
                      onMouseEnter={() => setHoveredNodeId(node.id)}
                      onMouseLeave={() => setHoveredNodeId(null)}
                      onFocus={() => setHoveredNodeId(node.id)}
                      onBlur={() => setHoveredNodeId(null)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setSelectedNodeId(node.id);
                        if (node.kind === 'planet' && node.channelId)
                          void toggleChannelArticles(node.channelId);
                      }}
                    >
                      {node.kind === 'sun' ? (
                        <>
                          <circle
                            r={node.radius}
                            className="feed-galaxy-root-mark"
                          />
                          <text className="feed-galaxy-root-count" y={4}>
                            {node.unreadCount}
                          </text>
                        </>
                      ) : node.kind === 'cluster' ? (
                        <>
                          <circle
                            r={node.radius}
                            className="feed-galaxy-cluster-mark"
                            style={
                              {
                                '--node-color': node.color,
                              } as React.CSSProperties
                            }
                          />
                          <text className="feed-galaxy-cluster-count" y={4}>
                            {node.channelCount}
                          </text>
                        </>
                      ) : node.kind === 'planet' ? (
                        <>
                          <circle
                            r={node.radius}
                            className="feed-galaxy-feed-mark"
                            style={
                              {
                                '--node-color': node.color,
                              } as React.CSSProperties
                            }
                          />
                          {node.unreadCount > 0 && (
                            <circle
                              className="feed-galaxy-unread-indicator"
                              cx={node.radius - 1}
                              cy={-node.radius + 1}
                              r={3.5}
                            />
                          )}
                        </>
                      ) : (
                        <>
                          <circle
                            r={node.radius}
                            className={`feed-galaxy-article-mark ${node.readStatus === 'unread' ? 'is-unread' : ''} ${node.starred ? 'is-starred' : ''}`}
                          />
                          {node.audioUrl && (
                            <circle
                              className="feed-galaxy-audio-mark"
                              cx={0}
                              cy={0}
                              r={2.2}
                            />
                          )}
                        </>
                      )}
                      {labelVisible && (
                        <text
                          className="feed-galaxy-node-label"
                          y={node.radius + (node.kind === 'sun' ? 22 : 17)}
                        >
                          {truncate(
                            node.label,
                            node.kind === 'satellite' ? 23 : 18,
                          )}
                        </text>
                      )}
                    </g>
                  );
                })}
            </g>
          </svg>
          <div
            className="feed-galaxy-canvas-controls"
            aria-label="图谱视角"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() =>
                setScale((value) => Math.min(MAX_ZOOM, value * 1.15))
              }
              aria-label="放大"
            >
              +
            </button>
            <button
              type="button"
              onClick={() =>
                setScale((value) => Math.max(MIN_ZOOM, value / 1.15))
              }
              aria-label="缩小"
            >
              −
            </button>
            <span>{Math.round(scale * 100)}%</span>
          </div>
        </div>

        <aside className="feed-galaxy-details" aria-live="polite">
          {selectedNode ? (
            <>
              <div className="feed-galaxy-detail-heading">
                <span className="feed-galaxy-overline">
                  {selectedNode.kind === 'sun'
                    ? 'OVERVIEW'
                    : selectedNode.kind === 'cluster'
                      ? 'CATEGORY'
                      : selectedNode.kind === 'planet'
                        ? 'SUBSCRIPTION'
                        : 'ARTICLE'}
                </span>
                <h2>{selectedNode.label}</h2>
                {selectedNode.sublabel && <p>{selectedNode.sublabel}</p>}
              </div>

              <dl className="feed-galaxy-detail-metrics">
                <div>
                  <dt>未读</dt>
                  <dd>{selectedNode.unreadCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>文章</dt>
                  <dd>{selectedNode.totalCount.toLocaleString()}</dd>
                </div>
                {selectedNode.kind !== 'satellite' && (
                  <div>
                    <dt>音频</dt>
                    <dd>{selectedNode.audioCount.toLocaleString()}</dd>
                  </div>
                )}
                {selectedNode.kind === 'cluster' && (
                  <div>
                    <dt>订阅源</dt>
                    <dd>{selectedNode.channelCount ?? 0}</dd>
                  </div>
                )}
              </dl>

              {selectedNode.kind === 'cluster' && selectedNode.categoryName && (
                <div className="feed-galaxy-detail-actions">
                  <button
                    type="button"
                    onClick={() => toggleCategory(selectedNode.categoryName!)}
                  >
                    {collapsedCategories.has(selectedNode.id)
                      ? '展开订阅源'
                      : '收起订阅源'}
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    onClick={() => onSelectCategory(selectedNode.categoryName!)}
                  >
                    打开分类列表
                  </button>
                </div>
              )}

              {selectedNode.kind === 'planet' && selectedChannel && (
                <>
                  <div className="feed-galaxy-detail-section">
                    <span>所属分类</span>
                    <strong>{selectedChannel.category || '未分类'}</strong>
                    <span>最近同步</span>
                    <strong>{formatDate(selectedChannel.lastSyncAt)}</strong>
                    {selectedChannel.syncStatus === 'error' && (
                      <p className="feed-galaxy-sync-error">
                        {selectedChannel.errorMessage || '上次同步失败'}
                      </p>
                    )}
                  </div>
                  {articleLoadErrors[selectedChannel.id] && (
                    <p className="feed-galaxy-sync-error" role="alert">
                      {articleLoadErrors[selectedChannel.id]}
                    </p>
                  )}
                  {expandedChannelId === selectedChannel.id &&
                    articlesByChannel[selectedChannel.id]?.length === 0 &&
                    !articleLoadErrors[selectedChannel.id] && (
                      <p className="feed-galaxy-empty-detail">
                        该订阅源近期没有文章。
                      </p>
                    )}
                  <div className="feed-galaxy-detail-actions">
                    <button
                      type="button"
                      disabled={loadingChannelId === selectedChannel.id}
                      onClick={() =>
                        void toggleChannelArticles(selectedChannel.id)
                      }
                    >
                      {loadingChannelId === selectedChannel.id
                        ? '正在载入…'
                        : articleLoadErrors[selectedChannel.id]
                          ? '重试加载文章'
                          : expandedChannelId === selectedChannel.id
                            ? '收起最近文章'
                            : '展开最近文章'}
                    </button>
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => onSelectChannel(selectedChannel.id)}
                    >
                      打开订阅源
                    </button>
                  </div>
                </>
              )}

              {selectedNode.kind === 'satellite' && selectedArticle && (
                <>
                  <div className="feed-galaxy-article-summary">
                    {selectedArticle.imageUrl && (
                      <img
                        src={selectedArticle.imageUrl}
                        alt=""
                        loading="lazy"
                      />
                    )}
                    <p>{selectedNode.summary || '该文章没有摘要。'}</p>
                    <span>{formatDate(selectedArticle.publishedAt)}</span>
                    <span>
                      {selectedArticle.readStatus === 'unread'
                        ? '未读'
                        : '已读'}
                      {selectedArticle.starred ? ' · 已收藏' : ''}
                      {selectedArticle.audioUrl ? ' · 含音频' : ''}
                    </span>
                  </div>
                  <div className="feed-galaxy-detail-actions">
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => onSelectArticle(selectedArticle)}
                    >
                      在阅读栏打开
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <p className="feed-galaxy-empty-detail">选择一个节点查看详情。</p>
          )}
        </aside>
      </div>

      <footer className="feed-galaxy-footer">
        滚轮缩放 · 拖动画布平移 · 拖动节点调整布局 · 点击订阅源展开最近文章 ·
        选中文章后在阅读栏打开
      </footer>
    </section>
  );
}
