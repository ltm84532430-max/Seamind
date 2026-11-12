import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import '../ebook/book-galaxy-view.css';
import type { EpubExamSummary } from './epub-exams';
import { layoutExamGraph } from './exam-graph-model';
import type { ExamReviewSchedule, ReviewUrgency } from './review-schedule';

export interface ExamGraphItem {
  exam: EpubExamSummary;
  schedule: ExamReviewSchedule;
}

interface Props {
  bookKey: string;
  bookTitle: string;
  coverDataUrl: string | null;
  items: ExamGraphItem[];
  selectedId: string | null;
  onSelectExam: (id: string) => void;
  onOpenExam: (exam: EpubExamSummary) => void;
  onOpenBook?: () => void;
}

const URGENCY_COLOR: Record<ReviewUrgency, string> = {
  overdue: '#e04332',
  today: '#e05638',
  upcoming: '#d97706',
  inProgress: '#38bdf8',
  notStarted: '#94a3b8',
  later: '#34d399',
};

function clampScale(value: number): number {
  return Math.max(0.25, Math.min(2.6, value));
}

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

function shortLabel(label: string, limit: number): string {
  const chars = Array.from(label);
  if (chars.length <= limit) return label;
  return `${chars.slice(0, limit).join('')}…`;
}

export function ExamGraphView({
  bookKey,
  bookTitle,
  coverDataUrl,
  items,
  selectedId,
  onSelectExam,
  onOpenExam,
  onOpenBook,
}: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(0.72);
  const [pan, setPan] = useState({ x: 400, y: 300 });
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoverPoint, setHoverPoint] = useState({ x: 0, y: 0 });
  const layout = useMemo(
    () => layoutExamGraph(items.map(({ exam }) => exam.id)),
    [items],
  );
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.exam.id, item])),
    [items],
  );
  const rings = [...new Set(layout.nodes.map((node) => node.ring))];
  const dueCount = items.filter(({ schedule }) =>
    ['overdue', 'today'].includes(schedule.urgency),
  ).length;
  const needle = query.trim().toLowerCase();
  const matchedIds = useMemo(() => {
    if (!needle) return null;
    return new Set(
      items
        .filter(({ exam }) =>
          `${exam.sourceSectionLabel} ${exam.bookTitle}`
            .toLowerCase()
            .includes(needle),
        )
        .map(({ exam }) => exam.id),
    );
  }, [items, needle]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setViewport({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (viewport.width < 10 || viewport.height < 10) return;
    const size = Math.max(layout.extent * 2, 320);
    const next = clampScale(
      Math.min((viewport.width - 96) / size, (viewport.height - 96) / size),
    );
    setScale(Math.max(0.4, next));
    setPan({ x: viewport.width / 2, y: viewport.height / 2 });
  }, [bookKey, viewport.width, viewport.height, layout.extent]);

  const resetView = () => {
    const size = Math.max(layout.extent * 2, 320);
    const next = clampScale(
      Math.min((viewport.width - 96) / size, (viewport.height - 96) / size),
    );
    setScale(Math.max(0.4, next));
    setPan({ x: viewport.width / 2, y: viewport.height / 2 });
  };

  const zoomAt = (nextScale: number, clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const actualScale = clampScale(nextScale);
    const worldX = (x - pan.x) / scale;
    const worldY = (y - pan.y) / scale;
    setPan({
      x: x - worldX * actualScale,
      y: y - worldY * actualScale,
    });
    setScale(actualScale);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    zoomAt(
      scale * (event.deltaY < 0 ? 1.12 : 0.89),
      event.clientX,
      event.clientY,
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target as Element).closest?.('.galaxy-node-group')
    ) {
      return;
    }
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) return;
    setPan({
      x: start.panX + event.clientX - start.x,
      y: start.panY + event.clientY - start.y,
    });
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const hovered = hoveredId ? itemById.get(hoveredId) : undefined;
  const sunRadius = 32;

  return (
    <div
      className="book-galaxy-container exam-galaxy"
      aria-label={`《${bookTitle}》试卷星系`}
    >
      <div className="book-galaxy-header">
        <div className="book-galaxy-title-wrap">
          <span className="book-galaxy-badge">试卷星系</span>
          <span className="book-galaxy-title">《{bookTitle}》</span>
          <div className="book-galaxy-stats">
            <span className="book-galaxy-stat-pill">{items.length} 份试卷</span>
            <span>·</span>
            <span className="book-galaxy-stat-pill">{dueCount} 份需复习</span>
          </div>
        </div>
        <div className="book-galaxy-actions">
          <input
            type="text"
            className="book-galaxy-search-input"
            placeholder="检索章节试卷…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="book-galaxy-btn" onClick={resetView}>
            重置视角
          </button>
        </div>
      </div>
      <div
        ref={canvasRef}
        className={`book-galaxy-canvas${dragging ? ' is-panning' : ''}`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <svg
          className="book-galaxy-svg"
          width={viewport.width}
          height={viewport.height}
        >
          <defs>
            <clipPath id="exam-galaxy-sun-clip">
              <circle cx={0} cy={0} r={sunRadius} />
            </clipPath>
            {coverDataUrl && (
              <pattern
                id="exam-galaxy-sun-cover"
                patternUnits="userSpaceOnUse"
                x={-sunRadius}
                y={-sunRadius}
                width={sunRadius * 2}
                height={sunRadius * 2}
              >
                <image
                  href={coverDataUrl}
                  x={0}
                  y={0}
                  width={sunRadius * 2}
                  height={sunRadius * 2}
                  preserveAspectRatio="xMidYMid slice"
                />
              </pattern>
            )}
            <radialGradient id="exam-galaxy-sun-grad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ff7b54" />
              <stop offset="70%" stopColor="#e05638" />
              <stop offset="100%" stopColor="#992e18" />
            </radialGradient>
          </defs>
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${scale})`}>
            {rings.map((ring) => {
              const nodeOnRing = layout.nodes.find(
                (node) => node.ring === ring,
              );
              const ringRadius = nodeOnRing
                ? Math.round(Math.hypot(nodeOnRing.x, nodeOnRing.y))
                : 0;
              if (!ringRadius) return null;
              return (
                <circle
                  key={ring}
                  className="galaxy-orbit-ring"
                  cx={0}
                  cy={0}
                  r={ringRadius}
                />
              );
            })}
            {layout.nodes.map((node, index) => {
              const next = layout.nodes[index + 1];
              if (!next) return null;
              const dimmed =
                matchedIds != null &&
                !matchedIds.has(node.id) &&
                !matchedIds.has(next.id);
              const spotlight = hoveredId === node.id || hoveredId === next.id;
              const mx = ((node.x + next.x) / 2) * 0.86;
              const my = ((node.y + next.y) / 2) * 0.86;
              return (
                <path
                  key={`seq-${node.id}`}
                  d={`M ${node.x} ${node.y} Q ${mx} ${my} ${next.x} ${next.y}`}
                  className={`galaxy-link-sequence${spotlight ? ' is-spotlight' : ''}${dimmed ? ' is-dimmed' : ''}`}
                />
              );
            })}
            {layout.nodes.map((node) => {
              const urgency =
                itemById.get(node.id)?.schedule.urgency ?? 'notStarted';
              const dimmed = matchedIds != null && !matchedIds.has(node.id);
              const spotlight = hoveredId === node.id || selectedId === node.id;
              return (
                <line
                  key={node.id}
                  className={`galaxy-link-orbit is-root-spoke${spotlight ? ' is-spotlight' : ''}${dimmed ? ' is-dimmed' : ''}`}
                  x1={0}
                  y1={0}
                  x2={node.x}
                  y2={node.y}
                  style={
                    {
                      '--link-color': URGENCY_COLOR[urgency],
                    } as CSSProperties
                  }
                />
              );
            })}
            <g
              className="galaxy-node-group is-sun has-note"
              onClick={() => onOpenBook?.()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <circle cx={0} cy={0} r={sunRadius + 8} fill="transparent" />
              {coverDataUrl ? (
                <circle
                  cx={0}
                  cy={0}
                  r={sunRadius}
                  fill="url(#exam-galaxy-sun-cover)"
                  clipPath="url(#exam-galaxy-sun-clip)"
                  className="galaxy-sun-circle"
                />
              ) : (
                <>
                  <circle
                    cx={0}
                    cy={0}
                    r={sunRadius}
                    fill="url(#exam-galaxy-sun-grad)"
                    className="galaxy-node-circle"
                  />
                  <text x={0} y={5} className="galaxy-sun-monogram">
                    {Array.from(bookTitle).slice(0, 1).join('')}
                  </text>
                </>
              )}
              <text x={0} y={sunRadius + 18} className="galaxy-sun-title">
                《{shortLabel(bookTitle, 16)}》
              </text>
            </g>
            {layout.nodes.map((node) => {
              const item = itemById.get(node.id);
              if (!item) return null;
              const label = item.exam.sourceSectionLabel || '未命名试卷';
              const due = ['overdue', 'today'].includes(item.schedule.urgency);
              const active =
                hoveredId === node.id || selectedId === node.id || due;
              const dimmed =
                (matchedIds != null && !matchedIds.has(node.id)) ||
                (hoveredId != null && hoveredId !== node.id);
              const practiced = item.exam.status === 'submitted';
              const radius = due || selectedId === node.id ? 7.2 : 5.4;
              const showLabel =
                active || scale >= 0.72 || matchedIds?.has(node.id);
              return (
                <g
                  key={node.id}
                  className={`galaxy-node-group is-planet ${practiced ? 'has-note' : 'no-note'} ${active ? 'is-hovered' : ''} ${dimmed ? 'is-dimmed' : ''}`}
                  transform={`translate(${node.x}, ${node.y})`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onSelectExam(node.id)}
                  onDoubleClick={() => onOpenExam(item.exam)}
                  onMouseEnter={(event) => {
                    const rect = canvasRef.current?.getBoundingClientRect();
                    setHoveredId(node.id);
                    setHoverPoint({
                      x: event.clientX - (rect?.left ?? 0),
                      y: event.clientY - (rect?.top ?? 0),
                    });
                  }}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <circle cx={0} cy={0} r={16} fill="transparent" />
                  {due && selectedId === node.id && (
                    <circle cx={0} cy={0} className="galaxy-current-pulse" />
                  )}
                  {(practiced || active) && (
                    <circle
                      cx={0}
                      cy={0}
                      r={radius + 3.5}
                      className="galaxy-note-halo"
                      style={
                        {
                          '--node-color': URGENCY_COLOR[item.schedule.urgency],
                        } as CSSProperties
                      }
                    />
                  )}
                  <circle
                    cx={0}
                    cy={0}
                    r={radius}
                    fill={URGENCY_COLOR[item.schedule.urgency]}
                    className="galaxy-node-circle"
                    style={
                      {
                        '--node-color': URGENCY_COLOR[item.schedule.urgency],
                      } as CSSProperties
                    }
                  />
                  {showLabel && (
                    <text
                      x={0}
                      y={radius + 12}
                      className={`galaxy-planet-badge${active ? ' is-prominent' : ''}`}
                    >
                      {shortLabel(label, active || scale >= 0.9 ? 18 : 8)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="book-galaxy-hud-hint">
          <i className="exam-galaxy-swatch is-due" />
          <span>逾期</span>
          <i className="exam-galaxy-swatch is-soon" />
          <span>今日</span>
          <i className="exam-galaxy-swatch is-open" />
          <span>未交</span>
          <i className="exam-galaxy-swatch is-done" />
          <span>已交</span>
          <span>·</span>
          <span>单击查看</span>
          <span>·</span>
          <span>双击打开</span>
          <span>·</span>
          <span>滚轮缩放 ({Math.round(scale * 100)}%)</span>
        </div>
        <div className="exam-galaxy-dock">
          <button
            type="button"
            aria-label="缩小星系"
            onClick={() => setScale((value) => clampScale(value / 1.12))}
          >
            −
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button
            type="button"
            aria-label="放大星系"
            onClick={() => setScale((value) => clampScale(value * 1.12))}
          >
            +
          </button>
          <button type="button" onClick={resetView}>
            适配全景
          </button>
        </div>
        {hovered && (
          <div
            className="book-galaxy-tooltip"
            style={{
              left: Math.min(
                hoverPoint.x + 12,
                Math.max(12, viewport.width - 280),
              ),
              top: Math.min(
                hoverPoint.y + 12,
                Math.max(12, viewport.height - 132),
              ),
            }}
          >
            <div className="book-galaxy-tooltip-head">
              <span>{hovered.exam.sourceSectionLabel || '未命名试卷'}</span>
              <span className="book-galaxy-badge">
                {urgencyText(hovered.schedule)}
              </span>
            </div>
            <div className="book-galaxy-tooltip-meta">
              {hovered.exam.questionCount} 题 · 已交卷{' '}
              {hovered.schedule.completedRounds} 轮
            </div>
            <div className="book-galaxy-tooltip-hint">
              单击查看 · 双击打开试卷
            </div>
          </div>
        )}
        {!items.length && (
          <p className="exam-galaxy-empty">这本书在当前筛选条件下没有试卷。</p>
        )}
      </div>
    </div>
  );
}
