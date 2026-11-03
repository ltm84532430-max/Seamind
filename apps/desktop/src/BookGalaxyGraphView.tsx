import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { BookGalaxyGraph, GalaxyNode } from './book-galaxy-model';
import './book-galaxy-view.css';

export interface BookGalaxyGraphViewProps {
  graph: BookGalaxyGraph;
  currentChapterHref?: string;
  theme?: 'light' | 'dark';
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
  const [scale, setScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  const [hoveredNode, setHoveredNode] = useState<{
    node: GalaxyNode;
    clientX: number;
    clientY: number;
  } | null>(null);

  const [searchFilter, setSearchFilter] = useState('');

  // Auto-fit calculation
  const calculateAutoFit = (width: number, height: number) => {
    const gw = Math.max(300, graph.bounds.maxX - graph.bounds.minX);
    const gh = Math.max(300, graph.bounds.maxY - graph.bounds.minY);
    const scaleX = (width - 80) / gw;
    const scaleY = (height - 80) / gh;
    const fitScale = Math.min(1.15, Math.max(0.28, Math.min(scaleX, scaleY)));
    return {
      scale: fitScale,
      pan: { x: width / 2, y: height / 2 },
    };
  };

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
  }, [
    graph.bounds.maxX,
    graph.bounds.maxY,
    graph.bounds.minX,
    graph.bounds.minY,
  ]);

  // Pan interaction
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.galaxy-node-group')) return;
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

  // Wheel zoom
  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    const nextScale = Math.min(3.2, Math.max(0.18, scale * zoomFactor));

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      setScale(nextScale);
      return;
    }

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Zoom towards mouse pointer
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

  const filteredNodes = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return graph.nodes;
    return graph.nodes.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        (n.chapterIndex && n.chapterIndex.toLowerCase().includes(q)) ||
        (n.noteTitle && n.noteTitle.toLowerCase().includes(q)),
    );
  }, [graph.nodes, searchFilter]);

  const activeFilteredIds = useMemo(() => {
    return new Set(filteredNodes.map((n) => n.id));
  }, [filteredNodes]);

  // Unique orbit radii for guide rings
  const orbitGuideRadii = useMemo(() => {
    const set = new Set<number>();
    graph.nodes.forEach((n) => {
      if (n.kind === 'cluster' && n.orbitRadius) {
        set.add(n.orbitRadius);
      }
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [graph.nodes]);

  const sunNode = graph.nodes.find((n) => n.kind === 'sun');
  const sunRadius = sunNode ? sunNode.radius : 40;
  const coverUrl = sunNode?.coverDataUrl || graph.coverDataUrl;

  return (
    <div className="book-galaxy-container" ref={containerRef}>
      {/* Top Header Controls */}
      <div className="book-galaxy-header">
        <div className="book-galaxy-title-wrap">
          <span className="book-galaxy-badge">全书知识星系</span>
          <span className="book-galaxy-title">《{graph.bookTitle}》</span>
          <div className="book-galaxy-stats">
            <span className="book-galaxy-stat-pill">
              章节: {graph.stats.totalChapters}
            </span>
            <span>·</span>
            <span className="book-galaxy-stat-pill">
              笔记覆盖: {graph.stats.notesCount} (
              {graph.stats.completionPercentage}%)
            </span>
          </div>
        </div>

        <div className="book-galaxy-actions">
          <input
            type="text"
            className="lit-text-input"
            style={{ width: 140, height: 26, fontSize: 11 }}
            placeholder="搜索章节或知识点…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
          <button
            type="button"
            className="book-galaxy-btn"
            title="自适应居中缩放全景"
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

      {/* SVG Canvas Viewport */}
      <div
        className={`book-galaxy-canvas ${isPanning ? 'is-panning' : ''}`}
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
            {/* Center Book Cover: True SVG Circular Clip and Pattern (Sanitized Identifiers) */}
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

            <filter
              id="galaxyGlow"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur
                in="SourceGraphic"
                stdDeviation="4"
                result="blur"
              />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
            {/* Dynamic concentric orbital guide rings */}
            {orbitGuideRadii.map((radius) => (
              <circle
                key={`orbit-ring-${radius}`}
                cx={0}
                cy={0}
                r={radius}
                className="galaxy-orbit-ring"
              />
            ))}

            {/* Links */}
            {graph.links.map((link, idx) => {
              const srcNode = graph.nodes.find((n) => n.id === link.source);
              const tgtNode = graph.nodes.find((n) => n.id === link.target);
              if (!srcNode || !tgtNode) return null;

              if (link.kind === 'sequence') {
                return (
                  <path
                    key={`seq-${idx}`}
                    d={`M ${srcNode.x} ${srcNode.y} Q ${(srcNode.x + tgtNode.x) / 2} ${(srcNode.y + tgtNode.y) / 2} ${tgtNode.x} ${tgtNode.y}`}
                    className="galaxy-link-sequence"
                  />
                );
              }

              const isIntraCluster =
                tgtNode.kind === 'planet' || tgtNode.kind === 'satellite';
              const strokeColor =
                isIntraCluster && link.color ? link.color : undefined;

              return (
                <line
                  key={`link-${idx}`}
                  x1={srcNode.x}
                  y1={srcNode.y}
                  x2={tgtNode.x}
                  y2={tgtNode.y}
                  className={`galaxy-link-orbit ${isIntraCluster ? 'is-intra' : ''}`}
                  style={
                    strokeColor
                      ? { stroke: strokeColor, opacity: 0.35 }
                      : undefined
                  }
                />
              );
            })}

            {/* Nodes */}
            {graph.nodes.map((node) => {
              const isMatch = activeFilteredIds.has(node.id);
              const isSun = node.kind === 'sun';
              const isCluster = node.kind === 'cluster';
              const isPlanet = node.kind === 'planet';
              const isSatellite = node.kind === 'satellite';

              return (
                <g
                  key={node.id}
                  className={`galaxy-node-group ${isSun ? 'is-sun' : ''}`}
                  transform={`translate(${node.x}, ${node.y})`}
                  opacity={searchFilter && !isMatch ? 0.18 : 1}
                  onClick={() => onSelectNode(node)}
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
                  {/* Active reading chapter pulse */}
                  {node.isCurrent && (
                    <circle cx={0} cy={0} className="galaxy-current-pulse" />
                  )}

                  {/* Has-note glowing halo */}
                  {node.hasNote && !isSun && (
                    <circle
                      cx={0}
                      cy={0}
                      r={node.radius + 5}
                      className="galaxy-note-halo"
                    />
                  )}

                  {/* Central Node: Inherently circular book cover */}
                  {isSun ? (
                    <>
                      {coverUrl ? (
                        <circle
                          cx={0}
                          cy={0}
                          r={node.radius}
                          fill="url(#galaxy-sun-cover-pattern)"
                          clipPath="url(#galaxy-sun-cover-clip)"
                          className="galaxy-sun-circle"
                          style={{
                            stroke: 'rgba(255, 255, 255, 0.45)',
                            strokeWidth: 1.5,
                          }}
                        />
                      ) : (
                        <>
                          <circle
                            cx={0}
                            cy={0}
                            r={node.radius}
                            fill="url(#sunGradient)"
                            className="galaxy-node-circle"
                          />
                          <text x={0} y={5} className="galaxy-sun-monogram">
                            {graph.bookTitle.slice(0, 2).toUpperCase()}
                          </text>
                        </>
                      )}
                      {/* Name of the book strictly below the center node */}
                      <text
                        x={0}
                        y={node.radius + 20}
                        className="galaxy-sun-title"
                      >
                        《{graph.bookTitle}》
                      </text>
                    </>
                  ) : (
                    <>
                      {/* Cluster, Planet, Satellite Node Circle */}
                      <circle
                        cx={0}
                        cy={0}
                        r={node.radius}
                        fill={node.color}
                        className="galaxy-node-circle"
                        style={
                          {
                            '--node-color': node.color,
                          } as React.CSSProperties
                        }
                      />

                      {/* Note marker dot if note exists */}
                      {node.hasNote && (
                        <circle
                          cx={node.radius - 2}
                          cy={-node.radius + 2}
                          r={3.2}
                          fill="#10b981"
                        />
                      )}

                      {/* Cluster Chapter Labels */}
                      {isCluster && (
                        <>
                          <text
                            x={0}
                            y={node.radius + 13}
                            className="galaxy-node-label"
                          >
                            {node.chapterIndex ||
                              (node.label.length > 8
                                ? `${node.label.slice(0, 8)}…`
                                : node.label)}
                          </text>
                          <text
                            x={0}
                            y={node.radius + 24}
                            className="galaxy-node-sublabel"
                          >
                            {node.label.length > 12
                              ? `${node.label.slice(0, 12)}…`
                              : node.label}
                          </text>
                        </>
                      )}

                      {/* Planet Labels: Clean index or hover decluttering */}
                      {isPlanet && (
                        <>
                          {node.chapterIndex ? (
                            <text
                              x={0}
                              y={node.radius + 11}
                              className="galaxy-planet-badge"
                            >
                              {node.chapterIndex}
                            </text>
                          ) : hoveredNode?.node.id === node.id ||
                            scale >= 1.05 ? (
                            <text
                              x={0}
                              y={node.radius + 11}
                              className="galaxy-node-sublabel"
                            >
                              {node.label.length > 8
                                ? `${node.label.slice(0, 8)}…`
                                : node.label}
                            </text>
                          ) : null}
                        </>
                      )}

                      {/* Satellite hover-only label */}
                      {isSatellite && hoveredNode?.node.id === node.id && (
                        <text
                          x={0}
                          y={node.radius + 10}
                          className="galaxy-node-sublabel"
                        >
                          {node.label.slice(0, 8)}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Floating Tooltip Card */}
        {hoveredNode && (
          <div
            className="book-galaxy-tooltip"
            style={{
              left: Math.min(hoveredNode.clientX, dimensions.width - 290),
              top: Math.min(hoveredNode.clientY, dimensions.height - 150),
            }}
          >
            <div className="book-galaxy-tooltip-head">
              <span>
                {hoveredNode.node.kind === 'sun'
                  ? `《${hoveredNode.node.bookTitle}》`
                  : hoveredNode.node.label}
              </span>
              <span className="book-galaxy-badge">
                {hoveredNode.node.kind === 'sun'
                  ? '全书核心'
                  : hoveredNode.node.chapterIndex ||
                    (hoveredNode.node.kind === 'cluster' ? '章节' : '小节')}
              </span>
            </div>

            {hoveredNode.node.parentChapter && (
              <div style={{ color: '#94a3b8', fontSize: 11 }}>
                所属章节：{hoveredNode.node.parentChapter}
              </div>
            )}

            <div
              className={`book-galaxy-tooltip-status ${
                hoveredNode.node.hasNote ? 'is-has-note' : 'is-no-note'
              }`}
            >
              <span>
                {hoveredNode.node.hasNote
                  ? '● 已关联章节知识库笔记'
                  : '○ 暂无独立笔记'}
              </span>
            </div>

            {hoveredNode.node.isCurrent && (
              <div style={{ color: '#d9573b', fontWeight: 600, fontSize: 11 }}>
                ★ 当前正文阅读所在位置
              </div>
            )}

            <div className="book-galaxy-tooltip-hint">
              {hoveredNode.node.kind === 'sun'
                ? '点击节点：查看全书总览笔记与主目录'
                : '点击节点：电子书同步跳转该章，右侧展开该节笔记'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
