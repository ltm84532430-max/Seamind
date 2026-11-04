import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { CategoryStats, FeedChannelWithStats } from './types';

interface FeedGalaxyViewProps {
  categories: CategoryStats[];
  channels: FeedChannelWithStats[];
  onClose: () => void;
  onSelectCategory: (category: string) => void;
  onSelectChannel: (channelId: string) => void;
}

type GalaxyNodeType = 'sun' | 'category' | 'channel';

interface FeedGalaxyNode {
  id: string;
  kind: GalaxyNodeType;
  label: string;
  sublabel?: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  unreadCount: number;
  articleCount?: number;
  channelCount?: number;
  url?: string;
  categoryName?: string;
  channelId?: string;
}

interface FeedGalaxyLink {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  color: string;
  kind: 'center' | 'channel';
  targetNodeId: string;
}

const CATEGORY_ORBIT = 180;
const CHANNEL_ORBIT_INNER = 300;
const CHANNEL_ORBIT_OUTER = 348;
const GALAXY_BOUND_RADIUS = 380;

function truncate(text: string, maxLen: number): string {
  const chars = Array.from(text);
  return chars.length > maxLen
    ? `${chars.slice(0, maxLen - 1).join('')}…`
    : text;
}

export const FeedGalaxyView: React.FC<FeedGalaxyViewProps> = ({
  categories,
  channels,
  onClose,
  onSelectCategory,
  onSelectChannel,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 650 });
  const [pan, setPan] = useState({ x: 450, y: 325 });
  const [scale, setScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const [hoveredNode, setHoveredNode] = useState<{
    node: FeedGalaxyNode;
    clientX: number;
    clientY: number;
  } | null>(null);

  const [searchFilter, setSearchFilter] = useState('');

  // Total statistics across all subscriptions
  const stats = useMemo(() => {
    const totalUnread = channels.reduce(
      (sum, ch) => sum + (ch.unreadCount || 0),
      0,
    );
    const totalArticles = channels.reduce(
      (sum, ch) => sum + (ch.totalCount || 0),
      0,
    );
    return {
      totalCategories: categories.length,
      totalChannels: channels.length,
      totalUnread,
      totalArticles,
    };
  }, [categories, channels]);

  // Compute celestial graph topology
  const { nodes, links } = useMemo(() => {
    const calculatedNodes: FeedGalaxyNode[] = [];
    const calculatedLinks: FeedGalaxyLink[] = [];

    // Central Sun node
    const sunNode: FeedGalaxyNode = {
      id: 'sun',
      kind: 'sun',
      label: 'SEAMIND RSS',
      sublabel: '全域订阅源',
      x: 0,
      y: 0,
      radius: 40,
      color: '#d9573b',
      unreadCount: stats.totalUnread,
      articleCount: stats.totalArticles,
      channelCount: stats.totalChannels,
    };
    calculatedNodes.push(sunNode);

    const catCount = Math.max(categories.length, 1);
    categories.forEach((category, catIndex) => {
      const catAngle = -Math.PI / 2 + (Math.PI * 2 * catIndex) / catCount;
      const catX = Math.round(Math.cos(catAngle) * CATEGORY_ORBIT);
      const catY = Math.round(Math.sin(catAngle) * CATEGORY_ORBIT);
      const catColor = category.color || '#3b82f6';
      const catRadius = Math.min(
        30,
        Math.max(22, 22 + Math.min(6, category.channelCount)),
      );

      const catNode: FeedGalaxyNode = {
        id: `cat-${category.name}`,
        kind: 'category',
        label: category.name,
        sublabel: `${category.channelCount} 源 · ${category.unreadCount} 未读`,
        x: catX,
        y: catY,
        radius: catRadius,
        color: catColor,
        unreadCount: category.unreadCount,
        articleCount: channels
          .filter((channel) => channel.category === category.name)
          .reduce((sum, channel) => sum + channel.totalCount, 0),
        channelCount: category.channelCount,
        categoryName: category.name,
      };
      calculatedNodes.push(catNode);

      // Link: Center Sun -> Category Planet
      calculatedLinks.push({
        id: `link-sun-${category.name}`,
        sourceX: 0,
        sourceY: 0,
        targetX: catX,
        targetY: catY,
        color: catColor,
        kind: 'center',
        targetNodeId: catNode.id,
      });

      // Child channel satellites orbiting their category
      const memberChannels = channels.filter(
        (ch) => ch.category === category.name,
      );
      const memberCount = memberChannels.length;
      if (memberCount > 0) {
        const sectorSpan = (Math.PI * 2 * 0.78) / catCount;
        memberChannels.forEach((channel, chIndex) => {
          const chAngle =
            catAngle -
            sectorSpan / 2 +
            (sectorSpan * (chIndex + 0.5)) / memberCount;
          // Stagger alternating channels across two concentric shells to eliminate overlap
          const chOrbitRadius =
            memberCount > 1 && chIndex % 2 === 1
              ? CHANNEL_ORBIT_OUTER
              : CHANNEL_ORBIT_INNER;
          const chX = Math.round(Math.cos(chAngle) * chOrbitRadius);
          const chY = Math.round(Math.sin(chAngle) * chOrbitRadius);
          const unread = channel.unreadCount || 0;
          const chRadius = Math.min(
            11,
            Math.max(6.5, 6.5 + Math.min(4, Math.log2(unread + 1))),
          );

          const chNode: FeedGalaxyNode = {
            id: `ch-${channel.id}`,
            kind: 'channel',
            label: channel.title,
            sublabel: channel.url,
            x: chX,
            y: chY,
            radius: chRadius,
            color: catColor,
            unreadCount: unread,
            articleCount: channel.totalCount,
            url: channel.url,
            categoryName: category.name,
            channelId: channel.id,
          };
          calculatedNodes.push(chNode);

          // Link: Category Planet -> Channel Satellite
          calculatedLinks.push({
            id: `link-cat-${category.name}-ch-${channel.id}`,
            sourceX: catX,
            sourceY: catY,
            targetX: chX,
            targetY: chY,
            color: catColor,
            kind: 'channel',
            targetNodeId: chNode.id,
          });
        });
      }
    });

    return { nodes: calculatedNodes, links: calculatedLinks };
  }, [categories, channels, stats]);

  // Auto-fit calculation
  const calculateAutoFit = (width: number, height: number) => {
    const graphDiameter = GALAXY_BOUND_RADIUS * 2 + 80;
    const scaleX = (width - 80) / graphDiameter;
    const scaleY = (height - 80) / graphDiameter;
    const fitScale = Math.min(1.2, Math.max(0.32, Math.min(scaleX, scaleY)));
    return {
      scale: fitScale,
      pan: { x: width / 2, y: height / 2 },
    };
  };

  // Measure container and initialize auto-fit
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
  }, []);

  // Pan interactions with pointer capture
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.feed-galaxy-node-group')) return;
    setIsPanning(true);
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isPanning) return;
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    setPan({
      x: panStartRef.current.panX + dx,
      y: panStartRef.current.panY + dy,
    });
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!isPanning) return;
    setIsPanning(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // Wheel zoom towards cursor position
  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    const nextScale = Math.min(3.2, Math.max(0.22, scale * zoomFactor));

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
    const fit = calculateAutoFit(dimensions.width, dimensions.height);
    setScale(fit.scale);
    setPan(fit.pan);
    setSearchFilter('');
  };

  // Filtered nodes logic
  const activeFilteredIds = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return new Set(nodes.map((n) => n.id));

    const matchIds = new Set<string>();
    nodes.forEach((n) => {
      if (
        n.label.toLowerCase().includes(q) ||
        (n.sublabel && n.sublabel.toLowerCase().includes(q)) ||
        (n.url && n.url.toLowerCase().includes(q)) ||
        (n.categoryName && n.categoryName.toLowerCase().includes(q))
      ) {
        matchIds.add(n.id);
        // If channel matches, also highlight its category planet
        if (n.categoryName) {
          matchIds.add(`cat-${n.categoryName}`);
        }
      }
    });
    // Center sun is always active
    matchIds.add('sun');
    return matchIds;
  }, [nodes, searchFilter]);

  const handleNodeClick = (node: FeedGalaxyNode) => {
    if (node.kind === 'category' && node.categoryName) {
      onSelectCategory(node.categoryName);
    } else if (node.kind === 'channel' && node.channelId) {
      onSelectChannel(node.channelId);
    } else if (node.kind === 'sun') {
      handleResetView();
    }
  };

  return (
    <div
      className="feed-galaxy-overlay"
      ref={containerRef}
      aria-label="订阅源全景知识星系"
    >
      {/* 顶部控制栏：对齐电子书星系与三栏 Header 48px 标准高度 */}
      <header className="feed-galaxy-header">
        <div className="feed-galaxy-title-wrap">
          <span className="feed-galaxy-badge">订阅源星系</span>
          <span className="feed-galaxy-title">博客与 RSS 知识星系</span>
          <div className="feed-galaxy-stats">
            <span className="feed-galaxy-stat-pill">
              分类: {stats.totalCategories}
            </span>
            <span>·</span>
            <span className="feed-galaxy-stat-pill">
              订阅源: {stats.totalChannels}
            </span>
            <span>·</span>
            <span className="feed-galaxy-stat-pill">
              未读文章: {stats.totalUnread}
            </span>
          </div>
        </div>

        <div className="feed-galaxy-actions">
          <input
            type="text"
            className="feed-galaxy-search-input"
            placeholder="搜索分类或订阅源…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
          <button
            type="button"
            className="feed-galaxy-btn"
            title="自适应居中缩放全景"
            onClick={handleResetView}
          >
            重置视角
          </button>
          <button
            type="button"
            className="feed-galaxy-btn is-primary"
            onClick={onClose}
          >
            返回列表
          </button>
        </div>
      </header>

      {/* SVG 画布交互视口 */}
      <div
        className={`feed-galaxy-canvas ${isPanning ? 'is-panning' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
      >
        <svg
          className="feed-galaxy-svg"
          width={dimensions.width}
          height={dimensions.height}
        >
          <defs>
            <radialGradient id="feedSunGradient" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ff7b54" />
              <stop offset="68%" stopColor="#e05638" />
              <stop offset="100%" stopColor="#992e18" />
            </radialGradient>

            <filter
              id="feedGalaxyGlow"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur
                in="SourceGraphic"
                stdDeviation="5"
                result="blur"
              />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
            {/* 同心导轨引力轨道圈 */}
            <circle
              cx={0}
              cy={0}
              r={CATEGORY_ORBIT}
              className="feed-galaxy-orbit-ring"
            />
            <circle
              cx={0}
              cy={0}
              r={CHANNEL_ORBIT_INNER}
              className="feed-galaxy-orbit-ring"
            />
            <circle
              cx={0}
              cy={0}
              r={CHANNEL_ORBIT_OUTER}
              className="feed-galaxy-orbit-ring"
            />

            {/* 引力连接线束 Links */}
            {links.map((link) => {
              const isMatch = activeFilteredIds.has(link.targetNodeId);
              const opacity = searchFilter && !isMatch ? 0.08 : 0.32;
              return (
                <line
                  key={link.id}
                  x1={link.sourceX}
                  y1={link.sourceY}
                  x2={link.targetX}
                  y2={link.targetY}
                  className={`feed-galaxy-link ${link.kind === 'channel' ? 'is-channel' : 'is-center'}`}
                  style={{
                    stroke: link.color,
                    opacity,
                  }}
                />
              );
            })}

            {/* 星系节点群 Nodes */}
            {nodes.map((node) => {
              const isMatch = activeFilteredIds.has(node.id);
              const isSun = node.kind === 'sun';
              const isCategory = node.kind === 'category';
              const hasUnread = node.unreadCount > 0;

              return (
                <g
                  key={node.id}
                  className={`feed-galaxy-node-group ${isSun ? 'is-sun' : isCategory ? 'is-category' : 'is-channel'}`}
                  transform={`translate(${node.x}, ${node.y})`}
                  opacity={searchFilter && !isMatch ? 0.15 : 1}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.label}${node.sublabel ? `，${node.sublabel}` : ''}`}
                  onClick={() => handleNodeClick(node)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleNodeClick(node);
                    }
                  }}
                  onMouseEnter={(e) => {
                    const rect = containerRef.current?.getBoundingClientRect();
                    setHoveredNode({
                      node,
                      clientX: e.clientX - (rect?.left ?? 0),
                      clientY: e.clientY - (rect?.top ?? 0),
                    });
                  }}
                  onMouseLeave={() => setHoveredNode(null)}
                >
                  {/* 未读脉冲光晕环 */}
                  {hasUnread && isSun && (
                    <circle cx={0} cy={0} className="galaxy-current-pulse" />
                  )}

                  {hasUnread && !isSun && (
                    <circle
                      cx={0}
                      cy={0}
                      r={node.radius + 4.5}
                      className="galaxy-note-halo"
                      style={{ stroke: node.color }}
                    />
                  )}

                  {/* 核心太阳节点 */}
                  {isSun ? (
                    <>
                      <circle
                        cx={0}
                        cy={0}
                        r={node.radius}
                        fill="url(#feedSunGradient)"
                        filter="url(#feedGalaxyGlow)"
                        className="feed-galaxy-sun-circle"
                      />
                      <text x={0} y={4} className="feed-galaxy-sun-monogram">
                        RSS
                      </text>
                      <text
                        x={0}
                        y={node.radius + 20}
                        className="feed-galaxy-sun-title"
                      >
                        全域知识星系
                      </text>
                    </>
                  ) : isCategory ? (
                    <>
                      {/* 分类星球节点 */}
                      <circle
                        cx={0}
                        cy={0}
                        r={node.radius}
                        fill={node.color}
                        className="feed-galaxy-category-circle"
                        style={
                          {
                            '--node-color': node.color,
                          } as React.CSSProperties
                        }
                      />
                      <text
                        x={0}
                        y={4}
                        className="feed-galaxy-category-count"
                        textAnchor="middle"
                      >
                        {node.unreadCount > 0
                          ? node.unreadCount
                          : node.channelCount}
                      </text>
                      <text
                        x={0}
                        y={node.radius + 15}
                        className="feed-galaxy-node-label"
                        textAnchor="middle"
                      >
                        {truncate(node.label, 12)}
                      </text>
                      <text
                        x={0}
                        y={node.radius + 28}
                        className="feed-galaxy-node-sublabel"
                        textAnchor="middle"
                      >
                        {node.channelCount} 源 · {node.unreadCount} 未读
                      </text>
                    </>
                  ) : (
                    <>
                      {/* 订阅源卫星节点 */}
                      <circle
                        cx={0}
                        cy={0}
                        r={16}
                        className="feed-galaxy-channel-hit-target"
                      />
                      <circle
                        cx={0}
                        cy={0}
                        r={node.radius}
                        fill={node.color}
                        className="feed-galaxy-channel-circle"
                        style={
                          {
                            '--node-color': node.color,
                          } as React.CSSProperties
                        }
                      />
                      {(scale >= 1.05 || hoveredNode?.node.id === node.id) && (
                        <text
                          x={0}
                          y={node.radius + 11}
                          className="feed-galaxy-channel-title"
                          textAnchor="middle"
                        >
                          {truncate(node.label, 9)}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* 悬停信息浮窗卡片 Tooltip */}
        {hoveredNode && (
          <div
            className="feed-galaxy-tooltip"
            style={{
              left: Math.min(hoveredNode.clientX, dimensions.width - 310),
              top: Math.min(hoveredNode.clientY, dimensions.height - 180),
            }}
          >
            <div className="feed-galaxy-tooltip-head">
              <span className="feed-galaxy-tooltip-title">
                {hoveredNode.node.label}
              </span>
              <span className="feed-galaxy-badge">
                {hoveredNode.node.kind === 'sun'
                  ? '核心中枢'
                  : hoveredNode.node.kind === 'category'
                    ? '分类星群'
                    : '订阅源卫星'}
              </span>
            </div>

            {hoveredNode.node.categoryName &&
              hoveredNode.node.kind === 'channel' && (
                <div className="feed-galaxy-tooltip-row">
                  所属分类：<b>{hoveredNode.node.categoryName}</b>
                </div>
              )}

            {hoveredNode.node.url && (
              <div
                className="feed-galaxy-tooltip-row is-url"
                title={hoveredNode.node.url}
              >
                {hoveredNode.node.url}
              </div>
            )}

            <div className="feed-galaxy-tooltip-stats">
              {hoveredNode.node.kind === 'sun' ? (
                <>
                  <span>分类：{stats.totalCategories}</span>
                  <span>·</span>
                  <span>订阅源：{stats.totalChannels}</span>
                  <span>·</span>
                  <span>文章：{stats.totalArticles}</span>
                </>
              ) : hoveredNode.node.kind === 'category' ? (
                <>
                  <span>包含订阅源：{hoveredNode.node.channelCount}</span>
                  <span>·</span>
                  <span>总文章：{hoveredNode.node.articleCount}</span>
                </>
              ) : (
                <>
                  <span>文章总数：{hoveredNode.node.articleCount ?? 0}</span>
                </>
              )}
            </div>

            <div
              className={`feed-galaxy-tooltip-status ${
                hoveredNode.node.unreadCount > 0 ? 'is-unread' : 'is-read'
              }`}
            >
              <span>
                {hoveredNode.node.unreadCount > 0
                  ? `● ${hoveredNode.node.unreadCount} 篇未读文章更新`
                  : '○ 暂无未读文章'}
              </span>
            </div>

            <div className="feed-galaxy-tooltip-hint">
              {hoveredNode.node.kind === 'sun'
                ? '提示：滚轮自由缩放，按住画布拖拽漫游星系全景'
                : hoveredNode.node.kind === 'category'
                  ? '点击节点：直接筛选该分类下所有订阅文章'
                  : '点击节点：快速打开并聚焦阅读该订阅源'}
            </div>
          </div>
        )}
      </div>

      <footer className="feed-galaxy-footer">
        滚轮平滑缩放 · 按住拖拽平移 · 点击分类星球筛选 · 点击卫星阅读源
      </footer>
    </div>
  );
};
