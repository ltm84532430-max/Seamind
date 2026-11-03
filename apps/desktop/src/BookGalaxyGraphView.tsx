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

  // Measure container dimensions
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
          setPan({ x: width / 2, y: height / 2 });
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
    const nextScale = Math.min(3.0, Math.max(0.25, scale * zoomFactor));

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
    setScale(1);
    setPan({ x: dimensions.width / 2, y: dimensions.height / 2 });
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

  return (
    <div className="book-galaxy-container" ref={containerRef}>
      {/* Top Header Controls */}
      <div className="book-galaxy-header">
        <div className="book-galaxy-title-wrap">
          <span className="book-galaxy-badge">全书知识星系</span>
          <span className="book-galaxy-title">{graph.bookTitle}</span>
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
            placeholder="搜索小节或概念…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
          />
          <button
            type="button"
            className="book-galaxy-btn"
            title="居中重置视角"
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
            <radialGradient id="sunGradient" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ff7b54" />
              <stop offset="70%" stopColor="#d9573b" />
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
            {/* Concentric orbital guide rings */}
            <circle cx={0} cy={0} r={240} className="galaxy-orbit-ring" />
            <circle cx={0} cy={0} r={120} className="galaxy-orbit-ring" />
            <circle cx={0} cy={0} r={360} className="galaxy-orbit-ring" />

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

              return (
                <line
                  key={`link-${idx}`}
                  x1={srcNode.x}
                  y1={srcNode.y}
                  x2={tgtNode.x}
                  y2={tgtNode.y}
                  className="galaxy-link-orbit"
                />
              );
            })}

            {/* Nodes */}
            {graph.nodes.map((node) => {
              const isMatch = activeFilteredIds.has(node.id);
              const isSun = node.kind === 'sun';
              const isCluster = node.kind === 'cluster';

              return (
                <g
                  key={node.id}
                  className="galaxy-node-group"
                  transform={`translate(${node.x}, ${node.y})`}
                  opacity={searchFilter && !isMatch ? 0.2 : 1}
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

                  {/* Body Circle */}
                  <circle
                    cx={0}
                    cy={0}
                    r={node.radius}
                    fill={isSun ? 'url(#sunGradient)' : node.color}
                    className="galaxy-node-circle"
                    style={
                      {
                        '--node-color': node.color,
                      } as React.CSSProperties
                    }
                  />

                  {/* Note marker dot if note exists */}
                  {node.hasNote && !isSun && (
                    <circle
                      cx={node.radius - 2}
                      cy={-node.radius + 2}
                      r={3.5}
                      fill="#10b981"
                    />
                  )}

                  {/* Label */}
                  <text
                    x={0}
                    y={node.radius + 14}
                    className="galaxy-node-label"
                  >
                    {node.chapterIndex ||
                      (isSun ? '主恒星' : node.label.slice(0, 10))}
                  </text>
                  {isCluster && (
                    <text
                      x={0}
                      y={node.radius + 25}
                      className="galaxy-node-sublabel"
                    >
                      {node.label.length > 10
                        ? `${node.label.slice(0, 10)}…`
                        : node.label}
                    </text>
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
              <span>{hoveredNode.node.label}</span>
              {hoveredNode.node.chapterIndex && (
                <span className="book-galaxy-badge">
                  {hoveredNode.node.chapterIndex}
                </span>
              )}
            </div>

            {hoveredNode.node.parentChapter && (
              <div style={{ color: '#94a3b8', fontSize: 11 }}>
                所属大章：{hoveredNode.node.parentChapter}
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
              点击节点：电子书同步跳转该章，右侧展开该节笔记
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
