import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { EpubExamSummary } from './epub-exams';
import type { ExamReviewSchedule } from './review-schedule';
import { layoutExamGraph } from './exam-graph-model';

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

function clampScale(value: number): number {
  return Math.max(0.2, Math.min(2, value));
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
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const layout = useMemo(
    () => layoutExamGraph(items.map(({ exam }) => exam.id)),
    [items],
  );
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.exam.id, item])),
    [items],
  );
  const rings = [...new Set(layout.nodes.map((node) => node.ring))];
  const canvasSize = layout.extent * 2;
  const dueCount = items.filter(({ schedule }) =>
    ['overdue', 'today'].includes(schedule.urgency),
  ).length;

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

  const fitScale = clampScale(
    Math.min(
      1.15,
      (viewport.width - 72) / canvasSize,
      (viewport.height - 72) / canvasSize,
    ),
  );
  useEffect(() => {
    // 切换书籍和容器尺寸时重新对焦；节点顺序变化不影响同一书的缩放操作。
    setScale(Math.max(0.55, fitScale));
    setPan({ x: 0, y: 0 });
  }, [bookKey, fitScale]);

  const zoomAt = (nextScale: number, clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    const actualScale = clampScale(nextScale);
    setPan({
      x: x - ((x - pan.x) / scale) * actualScale,
      y: y - ((y - pan.y) / scale) * actualScale,
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
    if (event.button !== 0 || (event.target as HTMLElement).closest('button'))
      return;
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

  return (
    <div className="exam-graph" aria-label={`《${bookTitle}》试卷关系图`}>
      <div className="exam-graph-meta">
        <span className="exam-graph-kicker">BOOK / EXAM MAP</span>
        <strong title={bookTitle}>{bookTitle}</strong>
        <span>
          {items.length} 份试卷 · {dueCount} 份需复习
        </span>
      </div>
      <div
        ref={canvasRef}
        className={`exam-graph-canvas${dragging ? ' is-dragging' : ''}`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          className="exam-graph-world"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          }}
        >
          <svg
            className="exam-graph-lines"
            width={canvasSize}
            height={canvasSize}
            viewBox={`-${layout.extent} -${layout.extent} ${canvasSize} ${canvasSize}`}
            aria-hidden="true"
          >
            {rings.map((ring) => {
              const nodeOnRing = layout.nodes.find((n) => n.ring === ring);
              const ringRadius = nodeOnRing
                ? Math.round(Math.hypot(nodeOnRing.x, nodeOnRing.y))
                : 165 + (ring - 1) * 150;
              return (
                <circle
                  key={ring}
                  className="exam-graph-ring"
                  cx="0"
                  cy="0"
                  r={ringRadius}
                />
              );
            })}
            {layout.nodes.map((node) => {
              const urgency =
                itemById.get(node.id)?.schedule.urgency ?? 'notStarted';
              return (
                <line
                  key={node.id}
                  className={`exam-graph-link is-${urgency}${selectedId === node.id ? ' is-selected' : ''}`}
                  x1="0"
                  y1="0"
                  x2={node.x}
                  y2={node.y}
                />
              );
            })}
          </svg>
          <button
            type="button"
            className="exam-graph-book"
            disabled={!onOpenBook}
            onClick={onOpenBook}
            title={onOpenBook ? `打开《${bookTitle}》` : bookTitle}
          >
            <span className="exam-graph-cover">
              {coverDataUrl ? (
                <img src={coverDataUrl} alt="" />
              ) : (
                <span aria-hidden="true">{bookTitle.slice(0, 1)}</span>
              )}
            </span>
            <span className="exam-graph-book-title">{bookTitle}</span>
            <small>中心书籍 · {items.length} 份试卷</small>
          </button>
          {layout.nodes.map((node) => {
            const item = itemById.get(node.id);
            if (!item) return null;
            return (
              <button
                key={node.id}
                type="button"
                className={`exam-graph-node is-${item.schedule.urgency}${selectedId === node.id ? ' is-selected' : ''}`}
                style={{ left: node.x, top: node.y }}
                title={`${item.exam.sourceSectionLabel || item.exam.bookTitle} · 双击打开试卷`}
                aria-pressed={selectedId === node.id}
                onClick={() => onSelectExam(node.id)}
                onDoubleClick={() => onOpenExam(item.exam)}
              >
                <span className="exam-graph-node-index">
                  EXAM {String(node.order).padStart(2, '0')}
                </span>
                <strong>{item.exam.sourceSectionLabel || '整章试卷'}</strong>
                <span className="exam-graph-node-foot">
                  <span>{item.exam.questionCount} 题</span>
                  <span>
                    {item.schedule.urgency === 'overdue'
                      ? `逾期 ${Math.abs(item.schedule.daysUntil ?? 0)} 天`
                      : item.schedule.urgency === 'today'
                        ? '今日到期'
                        : item.schedule.urgency === 'notStarted'
                          ? '待交卷'
                          : item.schedule.urgency === 'inProgress'
                            ? '重做中'
                            : `${item.schedule.daysUntil} 天后`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {!items.length && (
          <p className="exam-graph-empty">这本书在当前筛选条件下没有试卷。</p>
        )}
      </div>
      <div className="exam-graph-controls" aria-label="关系图缩放">
        <button
          type="button"
          aria-label="缩小关系图"
          onClick={() => setScale((value) => clampScale(value / 1.15))}
        >
          −
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button
          type="button"
          aria-label="放大关系图"
          onClick={() => setScale((value) => clampScale(value * 1.15))}
        >
          ＋
        </button>
        <button
          type="button"
          onClick={() => {
            setScale(fitScale);
            setPan({ x: 0, y: 0 });
          }}
        >
          适应画布
        </button>
      </div>
      <div className="exam-graph-legend">
        <span>
          <i className="is-overdue" />
          到期
        </span>
        <span>
          <i className="is-upcoming" />
          即将到期
        </span>
        <span>
          <i className="is-notStarted" />
          待交卷
        </span>
        <span>滚轮缩放 · 拖动画布 · 单击查看 · 双击打开</span>
      </div>
    </div>
  );
}
