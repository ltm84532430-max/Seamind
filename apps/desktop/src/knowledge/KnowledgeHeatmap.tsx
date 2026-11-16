import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KnowledgeHeatmapDayEntry,
  KnowledgeHeatmapSummary,
  MapDocument,
} from '../library/library';
import { libraryApi } from '../library/library-api';
import {
  habitDateFromOrdinal,
  habitDateOrdinal,
} from '../tasks/habit-list-model';
import {
  buildKnowledgeHeatmapGrid,
  computeKnowledgeHeatmapRange,
  heatmapFiltersForScope,
  todayLocalDateKey,
  type KnowledgeHeatmapCell,
  type KnowledgeHeatmapPeriod,
  type KnowledgeHeatmapScope,
} from './knowledge-heatmap-model';

export interface KnowledgeHeatmapProps {
  rootPath: string | null;
  documents: MapDocument[];
  onOpenNote(note: MapDocument): void;
}

const WEEKDAY_LABELS = ['一', '', '三', '', '五', '', ''];
const HEATMAP_PERIODS: Array<{ value: KnowledgeHeatmapPeriod; label: string }> =
  [
    { value: 180, label: '近半年' },
    { value: 365, label: '近一年' },
  ];
const HEATMAP_SCOPES: Array<{ value: KnowledgeHeatmapScope; label: string }> = [
  { value: 'all', label: '全部写入' },
  { value: 'manual', label: '仅手写' },
  { value: 'doc', label: '仅文档' },
  { value: 'mindmap', label: '仅导图' },
];

function formatWriteClock(unixSecs: number): string {
  if (!unixSecs) return '';
  const date = new Date(unixSecs * 1000);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export default function KnowledgeHeatmap({
  rootPath,
  documents,
  onOpenNote,
}: KnowledgeHeatmapProps) {
  const [period, setPeriod] = useState<KnowledgeHeatmapPeriod>(365);
  const [scope, setScope] = useState<KnowledgeHeatmapScope>('all');
  const [summary, setSummary] = useState<KnowledgeHeatmapSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayEntries, setDayEntries] = useState<KnowledgeHeatmapDayEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [hoveredCell, setHoveredCell] = useState<{
    cell: KnowledgeHeatmapCell;
    x: number;
    y: number;
  } | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedDate, setFocusedDate] = useState('');

  const today = todayLocalDateKey();
  const range = useMemo(
    () => computeKnowledgeHeatmapRange(today, period),
    [today, period],
  );
  const filters = useMemo(() => heatmapFiltersForScope(scope), [scope]);

  // Trigger heatmap refresh when document list snapshot updates (create/edit/delete).
  const docRevisionKey = useMemo(() => {
    let latestUpdated = 0;
    for (const doc of documents) {
      if (doc.updatedAt > latestUpdated) latestUpdated = doc.updatedAt;
    }
    return `${documents.length}:${latestUpdated}`;
  }, [documents]);

  useEffect(() => {
    if (!rootPath) {
      setSummary(null);
      setError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    libraryApi
      .writingHeatmap({
        fromDate: range.fromDate,
        toDate: range.toDate,
        ...filters,
      })
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, range.fromDate, range.toDate, filters, docRevisionKey]);

  useEffect(() => {
    if (!rootPath || !selectedDate) {
      setDayEntries([]);
      setDetailError('');
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError('');
    libraryApi
      .writingDayDetail({ date: selectedDate, ...filters })
      .then((entries) => {
        if (!cancelled) setDayEntries(entries);
      })
      .catch((reason) => {
        if (!cancelled) {
          setDetailError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, selectedDate, filters, docRevisionKey]);

  const grid = useMemo(() => {
    const source: KnowledgeHeatmapSummary = summary ?? {
      fromDate: range.fromDate,
      toDate: range.toDate,
      days: [],
    };
    return buildKnowledgeHeatmapGrid(source, today);
  }, [summary, range.fromDate, range.toDate, today]);

  useEffect(() => {
    if (
      grid.cells.length > 0 &&
      !grid.cells.some((cell) => cell.date === focusedDate)
    ) {
      setFocusedDate(grid.cells[grid.cells.length - 1].date);
    }
  }, [grid.cells, focusedDate]);

  const docById = useMemo(
    () => new Map(documents.map((doc) => [doc.id, doc])),
    [documents],
  );
  const docByPath = useMemo(
    () => new Map(documents.map((doc) => [doc.relativePath, doc])),
    [documents],
  );

  const showTooltipFor = (
    cell: KnowledgeHeatmapCell,
    target: HTMLButtonElement,
  ) => {
    const stage = stageRef.current;
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const cellRect = target.getBoundingClientRect();
    setHoveredCell({
      cell,
      x: cellRect.left - stageRect.left + cellRect.width / 2,
      y: cellRect.top - stageRect.top,
    });
  };

  const moveCellFocus = (date: string, deltaDays: number) => {
    const ord = habitDateOrdinal(date);
    if (ord == null) return;
    const nextDate = habitDateFromOrdinal(ord + deltaDays);
    const nextEl = cellRefs.current.get(nextDate);
    if (!nextEl) return;
    setFocusedDate(nextDate);
    nextEl.focus();
  };

  const { metrics } = grid;

  return (
    <section
      className="knowledge-home-panel knowledge-heatmap-panel"
      aria-label="写作热力图"
    >
      <div className="knowledge-panel-head knowledge-heatmap-head">
        <div className="knowledge-heatmap-title-group">
          <h3>写作热力图</h3>
          <div className="knowledge-heatmap-kpis">
            <span>
              共写入 <strong>{metrics.totalWrites}</strong> 篇
            </span>
            <i aria-hidden="true">·</i>
            <span>
              活跃 <strong>{metrics.activeDays}</strong> 天
            </span>
            <i aria-hidden="true">·</i>
            <span>
              连续 <strong>{metrics.currentStreak}</strong> 天
            </span>
            <i aria-hidden="true">·</i>
            <span>
              最长 <strong>{metrics.bestStreak}</strong> 天
            </span>
          </div>
        </div>

        <div className="knowledge-heatmap-controls">
          <div
            className="knowledge-heatmap-segmented"
            role="group"
            aria-label="统计范围"
          >
            {HEATMAP_SCOPES.map((item) => (
              <button
                key={item.value}
                type="button"
                className={scope === item.value ? 'is-active' : undefined}
                aria-pressed={scope === item.value}
                onClick={() => setScope(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div
            className="knowledge-heatmap-segmented"
            role="group"
            aria-label="时间跨度"
          >
            {HEATMAP_PERIODS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={period === item.value ? 'is-active' : undefined}
                aria-pressed={period === item.value}
                onClick={() => setPeriod(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <div className="knowledge-heatmap-status is-error" role="alert">
          写作热力图加载失败：{error}
        </div>
      ) : (
        <div className="knowledge-heatmap-body" ref={stageRef}>
          <div className="knowledge-heatmap-layout">
            <div className="knowledge-heatmap-weekdays" aria-hidden="true">
              {WEEKDAY_LABELS.map((label, index) => (
                <span key={index}>{label}</span>
              ))}
            </div>

            <div className="knowledge-heatmap-scroll">
              <div
                className="knowledge-heatmap-months"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(grid.weekCount, 1)}, 12px)`,
                }}
                aria-hidden="true"
              >
                {grid.monthTicks.map((tick) => (
                  <span
                    key={`${tick.week}:${tick.label}`}
                    style={{ gridColumn: tick.week }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>

              <div
                className="knowledge-heatmap-grid"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(grid.weekCount, 1)}, 12px)`,
                }}
                role="grid"
                aria-label="每日写入篇数网格"
                onMouseLeave={() => setHoveredCell(null)}
              >
                {grid.cells.map((cell) => {
                  const selected = selectedDate === cell.date;
                  return (
                    <button
                      key={cell.date}
                      ref={(node) => {
                        if (node) cellRefs.current.set(cell.date, node);
                        else cellRefs.current.delete(cell.date);
                      }}
                      type="button"
                      className={
                        `knowledge-heatmap-cell level-${cell.level}` +
                        (selected ? ' is-selected' : '') +
                        (cell.isToday ? ' is-today' : '')
                      }
                      style={{
                        gridColumn: cell.week,
                        gridRow: cell.weekday,
                      }}
                      tabIndex={cell.date === focusedDate ? 0 : -1}
                      aria-pressed={selected}
                      aria-label={`${cell.date}：写入 ${cell.totalCount} 篇（新增 ${cell.createdCount}，更新 ${cell.updatedCount}）`}
                      onFocus={(event) =>
                        showTooltipFor(cell, event.currentTarget)
                      }
                      onBlur={() => setHoveredCell(null)}
                      onMouseEnter={(event) =>
                        showTooltipFor(cell, event.currentTarget)
                      }
                      onClick={() =>
                        setSelectedDate((prev) =>
                          prev === cell.date ? null : cell.date,
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowRight') {
                          event.preventDefault();
                          moveCellFocus(cell.date, 7);
                        } else if (event.key === 'ArrowLeft') {
                          event.preventDefault();
                          moveCellFocus(cell.date, -7);
                        } else if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          moveCellFocus(cell.date, 1);
                        } else if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          moveCellFocus(cell.date, -1);
                        }
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {hoveredCell && (
            <div
              className="knowledge-heatmap-tooltip"
              role="status"
              style={{
                left: `${hoveredCell.x}px`,
                top: `${hoveredCell.y}px`,
              }}
            >
              <strong>{hoveredCell.cell.date}</strong>
              <span>
                写入 {hoveredCell.cell.totalCount} 篇
                {hoveredCell.cell.totalCount > 0
                  ? `（新增 ${hoveredCell.cell.createdCount} · 更新 ${hoveredCell.cell.updatedCount}）`
                  : ''}
              </span>
            </div>
          )}

          <div className="knowledge-heatmap-footer">
            <span className="knowledge-heatmap-hint">
              {loading
                ? '正在同步写入统计…'
                : metrics.totalWrites === 0
                  ? '新建或保存笔记后将点亮对应日期'
                  : selectedDate
                    ? `已选中 ${selectedDate}（点击上方日期可切换或收起）`
                    : '点击任意日期格查看当天写入笔记'}
            </span>

            <div className="knowledge-heatmap-legend" aria-label="强度图例">
              <span>少</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <i
                  key={level}
                  className={`knowledge-heatmap-cell level-${level}`}
                />
              ))}
              <span>多</span>
            </div>
          </div>

          {selectedDate && (
            <div
              className="knowledge-heatmap-detail"
              aria-label={`${selectedDate} 写入详情`}
            >
              <div className="knowledge-heatmap-detail-head">
                <strong>{selectedDate} 写入记录</strong>
                <button type="button" onClick={() => setSelectedDate(null)}>
                  收起
                </button>
              </div>
              {detailLoading ? (
                <div className="knowledge-heatmap-detail-empty">
                  正在读取当日笔记…
                </div>
              ) : detailError ? (
                <div className="knowledge-heatmap-detail-empty is-error">
                  读取失败：{detailError}
                </div>
              ) : dayEntries.length === 0 ? (
                <div className="knowledge-heatmap-detail-empty">
                  该日暂无符合当前筛选条件的写入记录。
                </div>
              ) : (
                <div className="knowledge-heatmap-detail-list">
                  {dayEntries.map((entry) => {
                    const liveDoc =
                      docById.get(entry.documentId) ??
                      docByPath.get(entry.relativePath);
                    return (
                      <button
                        key={`${entry.date}:${entry.documentId}`}
                        type="button"
                        className="knowledge-heatmap-detail-item"
                        disabled={!liveDoc}
                        title={
                          liveDoc
                            ? `打开「${liveDoc.title}」`
                            : '该笔记已不在当前目录索引中'
                        }
                        onClick={() => {
                          if (liveDoc) onOpenNote(liveDoc);
                        }}
                      >
                        <span
                          className={`knowledge-heatmap-action-tag is-${entry.action === 'create' ? 'create' : 'edit'}`}
                        >
                          {entry.action === 'create' ? '新增' : '更新'}
                        </span>
                        <span className="knowledge-heatmap-detail-title">
                          {entry.title}
                        </span>
                        <span className="knowledge-heatmap-detail-meta">
                          {entry.kind === 'mindmap' ? '导图' : '文档'}
                          {!liveDoc ? ' · 已移除' : ''}
                          {entry.lastWriteAt
                            ? ` · ${formatWriteClock(entry.lastWriteAt)}`
                            : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
