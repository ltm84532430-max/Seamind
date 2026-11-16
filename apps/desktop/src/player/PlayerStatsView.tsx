import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  habitDateFromOrdinal,
  habitDateOrdinal,
} from '../tasks/habit-list-model';
import { formatDuration } from './format';
import { usePlayerHost } from './host';
import MarqueeText from './MarqueeText';
import { playerApi } from './player-api';
import {
  buildHourlyRhythm,
  buildPlayerHeatmapGrid,
  buildPlayerMonthlyCalendars,
  buildWatchPieSlices,
  buildWeekdayRhythm,
  categoryKindLabel,
  computePlayerHeatmapRange,
  computeUniformHeatmapSizing,
  formatCompactDuration,
  formatWatchDurationSummary,
  pieSlicePath,
  resolveCategoryColor,
  type PlayerHeatmapCell,
  type PlayerHeatmapColorMode,
  type PlayerHeatmapPeriod,
  type WatchPieSlice,
} from './player-heatmap-model';
import {
  loadSubscriptionGroups,
  onSubscriptionGroupsChanged,
  type SubscriptionGroup,
} from './subscription-groups';
import type {
  SubscriptionGroupRule,
  VideoItem,
  WatchCategoryStat,
  WatchDayVideoEntry,
  WatchHeatmapSummary,
} from './types';

const WEEKDAY_LABELS = ['一', '', '三', '', '五', '', ''];
const CALENDAR_WEEKDAY_HEADS = ['一', '二', '三', '四', '五', '六', '日'];
const PERIOD_OPTIONS: Array<{ value: PlayerHeatmapPeriod; label: string }> = [
  { value: 90, label: '近 3 个月' },
  { value: 180, label: '近半年' },
  { value: 365, label: '近一年' },
];

function localTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toGroupRules(groups: SubscriptionGroup[]): SubscriptionGroupRule[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    color: group.color ?? null,
    channelIds: group.channelIds,
  }));
}

function levelOpacity(level: 0 | 1 | 2 | 3 | 4): number {
  switch (level) {
    case 1:
      return 0.28;
    case 2:
      return 0.5;
    case 3:
      return 0.72;
    case 4:
      return 0.94;
    default:
      return 0;
  }
}

export default function PlayerStatsView() {
  const host = usePlayerHost();
  const [period, setPeriod] = useState<PlayerHeatmapPeriod>(180);
  const [colorMode, setColorMode] =
    useState<PlayerHeatmapColorMode>('intensity');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');
  const [groups, setGroups] = useState<SubscriptionGroup[]>(() =>
    loadSubscriptionGroups(),
  );

  const [summary, setSummary] = useState<WatchHeatmapSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayEntries, setDayEntries] = useState<WatchDayVideoEntry[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [hoveredCell, setHoveredCell] = useState<{
    cell: PlayerHeatmapCell;
    x: number;
    y: number;
  } | null>(null);
  const [hoveredPieSliceId, setHoveredPieSliceId] = useState<string | null>(
    null,
  );

  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedDate, setFocusedDate] = useState('');

  useEffect(() => {
    return onSubscriptionGroupsChanged(() => {
      setGroups(loadSubscriptionGroups());
    });
  }, []);

  const today = localTodayDateKey();
  const range = useMemo(
    () => computePlayerHeatmapRange(today, period),
    [today, period],
  );
  const groupRules = useMemo(() => toGroupRules(groups), [groups]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    playerApi
      .watchHeatmap({
        fromDate: range.fromDate,
        toDate: range.toDate,
        subscriptionGroups: groupRules,
        categoryFilter: selectedCategoryId,
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
  }, [
    range.fromDate,
    range.toDate,
    groupRules,
    selectedCategoryId,
    host.learningPaths,
    host.playlists,
    host.favoriteCategories,
  ]);

  useEffect(() => {
    if (!selectedDate) {
      setDayEntries([]);
      setDetailError('');
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError('');
    playerApi
      .watchDayDetail({
        date: selectedDate,
        subscriptionGroups: groupRules,
        categoryFilter: selectedCategoryId,
      })
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
  }, [selectedDate, groupRules, selectedCategoryId]);

  const categories: WatchCategoryStat[] = summary?.categories ?? [];
  const categoryColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categories) {
      map.set(cat.categoryId, resolveCategoryColor(cat.categoryId, cat.color));
    }
    return map;
  }, [categories]);

  const activeCategoryColor =
    selectedCategoryId !== 'all'
      ? (categoryColorMap.get(selectedCategoryId) ?? 'var(--player-accent)')
      : undefined;

  const totalAllCategorySeconds = useMemo(
    () => categories.reduce((sum, item) => sum + item.totalSeconds, 0),
    [categories],
  );

  const pieSlices: WatchPieSlice[] = useMemo(
    () => buildWatchPieSlices(categories, 7),
    [categories],
  );

  const activePieSlice = useMemo(() => {
    if (hoveredPieSliceId) {
      return pieSlices.find((s) => s.categoryId === hoveredPieSliceId) ?? null;
    }
    if (selectedCategoryId !== 'all') {
      return pieSlices.find((s) => s.categoryId === selectedCategoryId) ?? null;
    }
    return pieSlices[0] ?? null;
  }, [hoveredPieSliceId, pieSlices, selectedCategoryId]);

  const grid = useMemo(() => {
    const source: WatchHeatmapSummary = summary ?? {
      fromDate: range.fromDate,
      toDate: range.toDate,
      categories: [],
      days: [],
    };
    return buildPlayerHeatmapGrid(source, today);
  }, [summary, range.fromDate, range.toDate, today]);

  const isMonthlyMatrixMode = period !== 365;
  const monthlyCalendars = useMemo(
    () =>
      isMonthlyMatrixMode
        ? buildPlayerMonthlyCalendars(grid.cells, range.fromDate, range.toDate)
        : [],
    [isMonthlyMatrixMode, grid.cells, range.fromDate, range.toDate],
  );

  const weekdayRhythm = useMemo(
    () => buildWeekdayRhythm(grid.cells),
    [grid.cells],
  );
  const hourlyRhythm = useMemo(
    () => buildHourlyRhythm(summary?.hourlySeconds),
    [summary?.hourlySeconds],
  );
  const [hoveredHour, setHoveredHour] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      const next = Math.floor(node.clientWidth);
      if (next > 0) setStageWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setHoveredCell(null);
  }, [period, selectedCategoryId]);

  const pixelSizing = useMemo(
    () => computeUniformHeatmapSizing(stageWidth),
    [stageWidth],
  );

  useEffect(() => {
    if (
      grid.cells.length > 0 &&
      !grid.cells.some((cell) => cell.date === focusedDate)
    ) {
      setFocusedDate(grid.cells[grid.cells.length - 1].date);
    }
  }, [grid.cells, focusedDate]);

  const showTooltipFor = (
    cell: PlayerHeatmapCell,
    target: HTMLButtonElement,
  ) => {
    const stage = stageRef.current;
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const cellRect = target.getBoundingClientRect();
    const rawX = Math.round(
      cellRect.left - stageRect.left + cellRect.width / 2,
    );
    const padX = 120;
    const maxX = Math.max(padX, Math.floor(stageRect.width) - padX);
    setHoveredCell({
      cell,
      x: Math.max(padX, Math.min(maxX, rawX)),
      y: Math.round(cellRect.top - stageRect.top),
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

  const openEntryVideo = useCallback(
    async (entry: WatchDayVideoEntry) => {
      const toFallbackItem = (row: WatchDayVideoEntry): VideoItem => ({
        videoId: row.videoId,
        channelId: null,
        channelName: row.channelName,
        title: row.title,
        publishedAt: null,
        publishedApprox: false,
        durationSeconds:
          row.durationSeconds != null ? Math.round(row.durationSeconds) : null,
        viewCount: null,
        viewText: null,
        thumbnailUrl: row.thumbnailUrl,
        progressSeconds: null,
        finished: row.finished,
        lastPlayedAt: row.lastWatchedAt,
        favorite: false,
        watchLater: false,
      });

      try {
        const ids = dayEntries.length
          ? dayEntries.map((item) => item.videoId)
          : [entry.videoId];
        const fetched = await playerApi.videoItems(ids);
        const byId = new Map(fetched.map((item) => [item.videoId, item]));
        const item = byId.get(entry.videoId) ?? toFallbackItem(entry);
        const queueItems = dayEntries.length
          ? dayEntries.map(
              (row) => byId.get(row.videoId) ?? toFallbackItem(row),
            )
          : [item];
        host.openVideo(item, {
          title: `${entry.date} 观看记录`,
          items: queueItems,
        });
      } catch (reason) {
        host.notify(
          reason instanceof Error ? reason.message : '无法打开该视频',
          'error',
        );
      }
    },
    [dayEntries, host],
  );

  const { metrics } = grid;

  const renderHeatCell = (
    cell: PlayerHeatmapCell,
    opts?: {
      gridPos?: boolean;
      dayNumber?: number | null;
      compact?: boolean;
    },
  ) => {
    const selected = selectedDate === cell.date;
    const customTint =
      cell.level > 0
        ? (activeCategoryColor ??
          (colorMode === 'category' && cell.dominantCategoryId
            ? categoryColorMap.get(cell.dominantCategoryId)
            : undefined))
        : undefined;

    return (
      <button
        key={cell.date}
        ref={(node) => {
          if (node) cellRefs.current.set(cell.date, node);
          else cellRefs.current.delete(cell.date);
        }}
        type="button"
        className={
          `player-stats-cell level-${cell.level}` +
          (opts?.compact ? ' is-calendar-cell' : '') +
          (selected ? ' is-selected' : '') +
          (cell.isToday ? ' is-today' : '')
        }
        style={{
          ...(opts?.gridPos
            ? { gridColumn: cell.week, gridRow: cell.weekday }
            : undefined),
          ...(customTint
            ? {
                backgroundColor: `color-mix(in srgb, ${customTint} ${Math.round(levelOpacity(cell.level) * 100)}%, var(--player-panel-alt))`,
                borderColor: `color-mix(in srgb, ${customTint} 70%, var(--player-line))`,
              }
            : undefined),
        }}
        tabIndex={cell.date === focusedDate ? 0 : -1}
        aria-pressed={selected}
        aria-label={`${cell.date}：观看 ${formatWatchDurationSummary(cell.totalSeconds)}`}
        onFocus={(event) => showTooltipFor(cell, event.currentTarget)}
        onBlur={() => setHoveredCell(null)}
        onMouseEnter={(event) => showTooltipFor(cell, event.currentTarget)}
        onClick={() =>
          setSelectedDate((prev) => (prev === cell.date ? null : cell.date))
        }
        onKeyDown={(event) => {
          const horzDelta = isMonthlyMatrixMode ? 1 : 7;
          const vertDelta = isMonthlyMatrixMode ? 7 : 1;
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            moveCellFocus(cell.date, horzDelta);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            moveCellFocus(cell.date, -horzDelta);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveCellFocus(cell.date, vertDelta);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveCellFocus(cell.date, -vertDelta);
          }
        }}
      >
        {opts?.dayNumber != null ? (
          <span className="player-stats-cell-day">{opts.dayNumber}</span>
        ) : null}
      </button>
    );
  };

  const pieCard = (
    <section
      className="player-stats-card player-stats-pie-card"
      aria-label="课程与视频大类扇形图"
    >
      <div className="player-stats-card-head">
        <h2>课程 / 大类占比扇形图</h2>
        <span>共 {formatCompactDuration(totalAllCategorySeconds)}</span>
      </div>

      {pieSlices.length === 0 ? (
        <div className="player-stats-empty">当前时间窗暂无可统计观看时长。</div>
      ) : (
        <div className="player-stats-pie-layout">
          <div className="player-stats-pie-canvas">
            <svg
              viewBox="0 0 200 200"
              className="player-stats-pie-svg"
              role="img"
              aria-label="课程与类别播放时长占比扇形图"
            >
              {pieSlices.map((slice) => {
                const isSelected = selectedCategoryId === slice.categoryId;
                const isHovered = hoveredPieSliceId === slice.categoryId;
                const dimmed =
                  selectedCategoryId !== 'all' &&
                  !isSelected &&
                  !isHovered &&
                  !slice.isOtherAggregate;
                const radius = isSelected || isHovered ? 88 : 82;
                return (
                  <path
                    key={slice.categoryId}
                    d={pieSlicePath(
                      100,
                      100,
                      radius,
                      slice.startAngleDeg,
                      slice.endAngleDeg,
                    )}
                    fill={slice.color}
                    fillOpacity={dimmed ? 0.35 : 0.94}
                    stroke="var(--player-panel)"
                    strokeWidth={2}
                    className={`player-stats-pie-slice${slice.isOtherAggregate ? '' : ' is-clickable'}`}
                    onMouseEnter={() => setHoveredPieSliceId(slice.categoryId)}
                    onMouseLeave={() => setHoveredPieSliceId(null)}
                    onClick={() => {
                      if (slice.isOtherAggregate) return;
                      setSelectedCategoryId((prev) =>
                        prev === slice.categoryId ? 'all' : slice.categoryId,
                      );
                    }}
                  />
                );
              })}
            </svg>
            <div className="player-stats-pie-focus">
              {activePieSlice ? (
                <>
                  <i
                    className="player-stats-dot"
                    style={{ background: activePieSlice.color }}
                  />
                  <MarqueeText
                    text={activePieSlice.label}
                    className="player-stats-pie-focus-label"
                  />
                  <strong>
                    {activePieSlice.percent}% ·{' '}
                    {formatCompactDuration(activePieSlice.totalSeconds)}
                  </strong>
                </>
              ) : (
                <span className="player-stats-pie-focus-placeholder">
                  悬停扇区查看详细占比
                </span>
              )}
            </div>
          </div>

          <div className="player-stats-pie-legend">
            {pieSlices.map((slice) => {
              const isSelected = selectedCategoryId === slice.categoryId;
              const isHovered = hoveredPieSliceId === slice.categoryId;
              return (
                <button
                  key={slice.categoryId}
                  type="button"
                  disabled={slice.isOtherAggregate}
                  className={`player-stats-pie-legend-item player-marquee-trigger${isSelected ? ' is-active' : ''}${isHovered ? ' is-hovered' : ''}`}
                  onMouseEnter={() => setHoveredPieSliceId(slice.categoryId)}
                  onMouseLeave={() => setHoveredPieSliceId(null)}
                  onClick={() => {
                    if (slice.isOtherAggregate) return;
                    setSelectedCategoryId((prev) =>
                      prev === slice.categoryId ? 'all' : slice.categoryId,
                    );
                  }}
                >
                  <i
                    className="player-stats-pie-swatch"
                    style={{ background: slice.color }}
                  />
                  <MarqueeText
                    text={slice.label}
                    className="player-stats-pie-legend-name"
                  />
                  <span className="player-stats-pie-legend-val">
                    {slice.percent}% ·{' '}
                    {formatCompactDuration(slice.totalSeconds)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );

  const rhythmCard = (
    <section
      className="player-stats-card player-stats-rhythm-card"
      aria-label="周内学习节律与黄金时段"
    >
      <div className="player-stats-card-head">
        <h2>学习节律与黄金时段</h2>
        <span>
          {hourlyRhythm.peakPersona
            ? `${hourlyRhythm.peakPersona}${hourlyRhythm.peakHourLabel ? ` · 峰值 ${hourlyRhythm.peakHourLabel}` : ''}`
            : '暂无时段记录'}
        </span>
      </div>

      <div className="player-stats-rhythm-block">
        <div className="player-stats-rhythm-subhead">
          <strong>周内投入分布（周一 ~ 周日）</strong>
          <span>按每日累计内容时长</span>
        </div>
        <div className="player-stats-weekday-bars">
          {weekdayRhythm.map((bar) => (
            <div
              key={bar.weekday}
              className={`player-stats-weekday-col${bar.isPeak ? ' is-peak' : ''}`}
              title={`${bar.fullLabel}：${formatWatchDurationSummary(bar.totalSeconds)}（活跃 ${bar.activeDays} 天）`}
            >
              <span className="player-stats-weekday-val">
                {bar.totalSeconds > 0
                  ? formatCompactDuration(bar.totalSeconds)
                  : ''}
              </span>
              <div className="player-stats-weekday-track">
                <div
                  className="player-stats-weekday-fill"
                  style={{
                    height: `${
                      bar.totalSeconds > 0
                        ? Math.max(4, Math.round(bar.ratio * 52))
                        : 0
                    }px`,
                  }}
                />
              </div>
              <span className="player-stats-weekday-lbl">{bar.shortLabel}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="player-stats-rhythm-block">
        <div className="player-stats-rhythm-subhead">
          <strong>24 小时活跃黄金时段</strong>
          <span>
            {hoveredHour != null
              ? `${String(hoveredHour).padStart(2, '0')}:00–${String((hoveredHour + 1) % 24).padStart(2, '0')}:00 · ${formatWatchDurationSummary(hourlyRhythm.hours[hoveredHour]?.seconds ?? 0)}`
              : hourlyRhythm.peakHourLabel
                ? `高峰 ${hourlyRhythm.peakHourLabel}`
                : '悬停查看各小时时长'}
          </span>
        </div>

        <div
          className="player-stats-hourly-bars"
          onMouseLeave={() => setHoveredHour(null)}
        >
          {hourlyRhythm.hours.map((bar) => (
            <button
              key={bar.hour}
              type="button"
              className={`player-stats-hourly-col is-${bar.periodId}${bar.isPeak ? ' is-peak' : ''}${hoveredHour === bar.hour ? ' is-hovered' : ''}`}
              aria-label={`${bar.label}点：${formatWatchDurationSummary(bar.seconds)}`}
              onMouseEnter={() => setHoveredHour(bar.hour)}
              onFocus={() => setHoveredHour(bar.hour)}
            >
              <span className="player-stats-hourly-track">
                <span
                  className="player-stats-hourly-fill"
                  style={{
                    height: `${
                      bar.seconds > 0
                        ? Math.max(3, Math.round(bar.ratio * 46))
                        : 0
                    }px`,
                  }}
                />
              </span>
              <span className="player-stats-hourly-lbl">
                {bar.hour % 3 === 0 ? bar.label : ''}
              </span>
            </button>
          ))}
        </div>

        <div className="player-stats-day-periods">
          {hourlyRhythm.buckets.map((bucket) => (
            <div
              key={bucket.id}
              className={`player-stats-day-period is-${bucket.id}${bucket.isPeak ? ' is-peak' : ''}`}
            >
              <div className="player-stats-day-period-top">
                <span>{bucket.label}</span>
                <small>{bucket.rangeLabel}</small>
              </div>
              <strong>
                {bucket.percent}% · {formatCompactDuration(bucket.seconds)}
              </strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );

  const breakdownCard = (
    <section
      className="player-stats-card player-stats-breakdown-card"
      aria-label="各课程与视频种类时长分布"
    >
      <div className="player-stats-card-head">
        <h2>大类时长分布（学习路径 / 课程 / 订阅分类 / 其他）</h2>
        <span>共 {formatWatchDurationSummary(totalAllCategorySeconds)}</span>
      </div>

      {categories.length === 0 ? (
        <div className="player-stats-empty">当前时间窗暂无分类统计数据。</div>
      ) : (
        <div className="player-stats-breakdown-list">
          {categories.map((cat) => {
            const color =
              categoryColorMap.get(cat.categoryId) ?? 'var(--player-accent)';
            const pct =
              totalAllCategorySeconds > 0
                ? Math.round((cat.totalSeconds / totalAllCategorySeconds) * 100)
                : 0;
            const active = selectedCategoryId === cat.categoryId;
            return (
              <button
                key={cat.categoryId}
                type="button"
                className={`player-stats-breakdown-row player-marquee-trigger${active ? ' is-active' : ''}`}
                onClick={() =>
                  setSelectedCategoryId((prev) =>
                    prev === cat.categoryId ? 'all' : cat.categoryId,
                  )
                }
              >
                <div className="player-stats-breakdown-label">
                  <span className="player-stats-kind-chip" style={{ color }}>
                    {categoryKindLabel(cat.categoryKind)}
                  </span>
                  <MarqueeText
                    text={cat.label}
                    className="player-stats-breakdown-name"
                  />
                </div>
                <div className="player-stats-breakdown-track">
                  <div
                    className="player-stats-breakdown-fill"
                    style={{
                      width: `${Math.max(2, pct)}%`,
                      background: color,
                    }}
                  />
                </div>
                <div className="player-stats-breakdown-val">
                  <strong>
                    {formatWatchDurationSummary(cat.totalSeconds)}
                  </strong>
                  <span>
                    {pct}% · {cat.videoCount} 集
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );

  const dayDetailCard = (
    <section
      className="player-stats-card player-stats-day-detail-card"
      aria-label={
        selectedDate ? `${selectedDate} 观看记录` : '每日观看视频明细'
      }
    >
      <div className="player-stats-card-head">
        <h2>
          {selectedDate
            ? `${selectedDate} 观看课程与视频明细`
            : '每日观看课程与视频明细'}
        </h2>
        {selectedDate ? (
          <button
            type="button"
            className="player-stats-link-btn"
            onClick={() => setSelectedDate(null)}
          >
            清除选中
          </button>
        ) : (
          <span>点击热力图日格下钻</span>
        )}
      </div>

      {!selectedDate ? (
        <div className="player-stats-empty">
          点击上方热力图任意日期格，即可在此框内查看当天看过的课程与视频列表，并支持点击直接续播。
        </div>
      ) : detailLoading ? (
        <div className="player-stats-empty">正在读取当天明细…</div>
      ) : detailError ? (
        <div className="player-stats-error">{detailError}</div>
      ) : dayEntries.length === 0 ? (
        <div className="player-stats-empty">
          这一天没有符合当前筛选条件的观看记录。
        </div>
      ) : (
        <div className="player-stats-day-list">
          {dayEntries.map((entry) => {
            const color =
              categoryColorMap.get(entry.categoryId) ??
              resolveCategoryColor(entry.categoryId, entry.categoryColor);
            return (
              <button
                key={`${entry.date}:${entry.videoId}`}
                type="button"
                className="player-stats-day-item player-marquee-trigger"
                onClick={() => void openEntryVideo(entry)}
              >
                <span
                  className="player-stats-cat-badge"
                  style={{
                    borderColor: `color-mix(in srgb, ${color} 45%, var(--player-line))`,
                    color,
                    background: `color-mix(in srgb, ${color} 12%, transparent)`,
                  }}
                >
                  <i
                    className="player-stats-dot"
                    style={{ background: color }}
                  />
                  <MarqueeText
                    text={entry.categoryLabel}
                    className="player-stats-badge-marquee"
                  />
                </span>

                <MarqueeText
                  text={entry.title}
                  className="player-stats-day-title"
                />

                <span className="player-stats-day-meta">
                  {categoryKindLabel(entry.categoryKind)} · 看了{' '}
                  <strong>{formatCompactDuration(entry.watchedSeconds)}</strong>
                  {entry.durationSeconds
                    ? ` / ${formatDuration(entry.durationSeconds)}`
                    : ''}
                  {entry.finished ? ' ✓' : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );

  return (
    <div className="player-view player-stats-view">
      <header className="player-view-header player-stats-header">
        <div>
          <h1>学习时长与课程热力图</h1>
          <p className="player-stats-subtitle">
            按视频内容有效推进时长统计（忽略倍速）；学习路径与课程自动聚合归类，悬停长标题可滚动阅读全称。
          </p>
        </div>

        <div className="player-stats-header-controls">
          <div
            className="player-stats-segmented"
            role="group"
            aria-label="着色模式"
          >
            <button
              type="button"
              className={colorMode === 'intensity' ? 'is-active' : undefined}
              onClick={() => setColorMode('intensity')}
            >
              时长强度
            </button>
            <button
              type="button"
              className={colorMode === 'category' ? 'is-active' : undefined}
              onClick={() => setColorMode('category')}
            >
              主导课程着色
            </button>
          </div>

          <div
            className="player-stats-segmented"
            role="group"
            aria-label="统计时间范围"
          >
            {PERIOD_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={period === option.value ? 'is-active' : undefined}
                onClick={() => setPeriod(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="player-view-body player-stats-body">
        <section className="player-stats-kpis" aria-label="核心学习指标">
          <div className="player-stats-kpi">
            <span>累计内容时长</span>
            <strong>{formatWatchDurationSummary(metrics.totalSeconds)}</strong>
          </div>
          <div className="player-stats-kpi">
            <span>活跃学习天数</span>
            <strong>{metrics.activeDays} 天</strong>
          </div>
          <div className="player-stats-kpi">
            <span>当前连续学习</span>
            <strong>{metrics.currentStreak} 天</strong>
          </div>
          <div className="player-stats-kpi">
            <span>最长连续纪录</span>
            <strong>{metrics.bestStreak} 天</strong>
          </div>
          <div className="player-stats-kpi">
            <span>活跃日均时长</span>
            <strong>
              {formatWatchDurationSummary(metrics.avgActiveSeconds)}
            </strong>
          </div>
        </section>

        <section
          className="player-stats-card player-stats-filter-card"
          aria-label="课程与视频大类筛选"
        >
          <div className="player-stats-card-head">
            <h2>课程 / 学习路径 / 分类筛选</h2>
            <span>{categories.length} 个活跃类别</span>
          </div>

          <div className="player-stats-category-pills" role="group">
            <button
              type="button"
              className={`player-stats-pill player-marquee-trigger${selectedCategoryId === 'all' ? ' is-active' : ''}`}
              onClick={() => setSelectedCategoryId('all')}
            >
              <span>全部视频</span>
              <em>{formatCompactDuration(totalAllCategorySeconds)}</em>
            </button>

            {categories.map((cat) => {
              const color =
                categoryColorMap.get(cat.categoryId) ?? 'var(--player-accent)';
              const active = selectedCategoryId === cat.categoryId;
              return (
                <button
                  key={cat.categoryId}
                  type="button"
                  className={`player-stats-pill player-marquee-trigger${active ? ' is-active' : ''}`}
                  style={
                    active
                      ? ({
                          borderColor: color,
                          background: `color-mix(in srgb, ${color} 16%, var(--player-panel))`,
                        } as React.CSSProperties)
                      : undefined
                  }
                  onClick={() =>
                    setSelectedCategoryId((prev) =>
                      prev === cat.categoryId ? 'all' : cat.categoryId,
                    )
                  }
                >
                  <i
                    className="player-stats-dot"
                    style={{ background: color }}
                    aria-hidden="true"
                  />
                  <MarqueeText
                    text={cat.label}
                    className="player-stats-pill-label"
                  />
                  <em>{formatCompactDuration(cat.totalSeconds)}</em>
                </button>
              );
            })}
          </div>
        </section>

        <section
          className="player-stats-card player-stats-heatmap-card"
          aria-label="每日播放时长热力图"
        >
          <div className="player-stats-card-head">
            <h2>每日播放时长热力图</h2>
            <span>
              {loading
                ? '正在计算…'
                : selectedCategoryId === 'all'
                  ? isMonthlyMatrixMode
                    ? `月历像素矩阵（${monthlyCalendars.length} 个月 · 恒定 ${pixelSizing.cellPx}px 格）`
                    : `全年 53 周连续像素格（${pixelSizing.cellPx}px 格）`
                  : `已筛选：${categories.find((c) => c.categoryId === selectedCategoryId)?.label ?? ''}`}
            </span>
          </div>

          <div
            className="player-stats-heatmap-stage"
            ref={stageRef}
            style={
              {
                '--stats-cell-size': `${pixelSizing.cellPx}px`,
                '--stats-cell-gap': `${pixelSizing.stripGapPx}px`,
                '--stats-month-gap': `${pixelSizing.monthGapPx}px`,
              } as React.CSSProperties
            }
          >
            <div className="player-stats-heatmap-stage-body">
              {error ? (
                <div className="player-stats-error" role="alert">
                  统计加载失败：{error}
                </div>
              ) : isMonthlyMatrixMode ? (
                <div
                  className={`player-stats-month-matrix count-${monthlyCalendars.length}`}
                  style={
                    {
                      '--stats-month-count': Math.max(
                        1,
                        monthlyCalendars.length,
                      ),
                    } as React.CSSProperties
                  }
                  onMouseLeave={() => setHoveredCell(null)}
                >
                  {monthlyCalendars.map((block) => (
                    <div
                      key={block.monthKey}
                      className="player-stats-month-card"
                    >
                      <div className="player-stats-month-card-head">
                        <strong>{block.label}</strong>
                        <span>{formatCompactDuration(block.totalSeconds)}</span>
                      </div>
                      <div className="player-stats-month-block-body">
                        <div
                          className="player-stats-month-dow"
                          aria-hidden="true"
                        >
                          {CALENDAR_WEEKDAY_HEADS.map((label) => (
                            <span key={label}>{label}</span>
                          ))}
                        </div>
                        <div
                          className="player-stats-month-grid"
                          role="grid"
                          aria-label={`${block.label}每日内容观看时长`}
                        >
                          {block.slots.map((slot) => {
                            if (slot.date == null) {
                              return (
                                <span
                                  key={slot.key}
                                  className="player-stats-cell is-pad"
                                  aria-hidden="true"
                                />
                              );
                            }
                            if (!slot.inRange || !slot.cell) {
                              return (
                                <span
                                  key={slot.key}
                                  className="player-stats-cell is-calendar-cell is-out-of-range"
                                  aria-hidden="true"
                                >
                                  <span className="player-stats-cell-day">
                                    {slot.dayNumber}
                                  </span>
                                </span>
                              );
                            }
                            return renderHeatCell(slot.cell, {
                              dayNumber: slot.dayNumber,
                              compact: true,
                            });
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="player-stats-heatmap-layout">
                  <div className="player-stats-weekdays" aria-hidden="true">
                    {WEEKDAY_LABELS.map((label, idx) => (
                      <span key={idx}>{label}</span>
                    ))}
                  </div>

                  <div className="player-stats-heatmap-scroll">
                    <div
                      className="player-stats-months"
                      style={{
                        gridTemplateColumns: `repeat(${Math.max(grid.weekCount, 1)}, ${pixelSizing.cellPx}px)`,
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
                      className="player-stats-grid"
                      style={{
                        gridTemplateColumns: `repeat(${Math.max(grid.weekCount, 1)}, ${pixelSizing.cellPx}px)`,
                      }}
                      role="grid"
                      aria-label="播放器每日内容观看时长"
                      onMouseLeave={() => setHoveredCell(null)}
                    >
                      {grid.cells.map((cell) =>
                        renderHeatCell(cell, { gridPos: true }),
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {hoveredCell && (
              <div
                className="player-stats-tooltip"
                role="status"
                style={{
                  left: `${hoveredCell.x}px`,
                  top: `${hoveredCell.y}px`,
                }}
              >
                <div className="player-stats-tooltip-top">
                  <strong>{hoveredCell.cell.date}</strong>
                  <span>
                    {formatWatchDurationSummary(hoveredCell.cell.totalSeconds)}
                    {hoveredCell.cell.videoCount > 0
                      ? ` · ${hoveredCell.cell.videoCount} 个视频`
                      : ''}
                  </span>
                </div>

                {hoveredCell.cell.breakdown.length > 0 && (
                  <>
                    <div className="player-stats-tooltip-bar">
                      {hoveredCell.cell.breakdown.map((part) => {
                        const pct =
                          hoveredCell.cell.totalSeconds > 0
                            ? (part.seconds / hoveredCell.cell.totalSeconds) *
                              100
                            : 0;
                        const color =
                          categoryColorMap.get(part.categoryId) ??
                          resolveCategoryColor(part.categoryId, part.color);
                        return (
                          <span
                            key={part.categoryId}
                            style={{
                              width: `${Math.max(4, pct)}%`,
                              background: color,
                            }}
                          />
                        );
                      })}
                    </div>
                    <div className="player-stats-tooltip-list">
                      {hoveredCell.cell.breakdown.slice(0, 4).map((part) => {
                        const pct =
                          hoveredCell.cell.totalSeconds > 0
                            ? Math.round(
                                (part.seconds / hoveredCell.cell.totalSeconds) *
                                  100,
                              )
                            : 0;
                        const color =
                          categoryColorMap.get(part.categoryId) ??
                          resolveCategoryColor(part.categoryId, part.color);
                        return (
                          <div
                            key={part.categoryId}
                            className="player-stats-tooltip-row"
                          >
                            <i
                              className="player-stats-dot"
                              style={{ background: color }}
                            />
                            <span className="player-stats-tooltip-cat">
                              {part.label}
                            </span>
                            <em>
                              {formatCompactDuration(part.seconds)} ({pct}%)
                            </em>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="player-stats-heatmap-footer">
              <span>
                {selectedDate
                  ? `已选中 ${selectedDate}，右下角面板可直接点击视频续播`
                  : '点击任意日期格，在下方固定明细面板查看当天课程与视频'}
              </span>
              <div className="player-stats-legend" aria-label="时长强弱图例">
                <span>少</span>
                {[0, 1, 2, 3, 4].map((lvl) => (
                  <i
                    key={lvl}
                    className={`player-stats-cell level-${lvl}`}
                    style={
                      lvl > 0 && activeCategoryColor
                        ? {
                            backgroundColor: `color-mix(in srgb, ${activeCategoryColor} ${Math.round(levelOpacity(lvl as 0 | 1 | 2 | 3 | 4) * 100)}%, var(--player-panel-alt))`,
                          }
                        : undefined
                    }
                  />
                ))}
                <span>多</span>
              </div>
            </div>
          </div>
        </section>

        <div className="player-stats-lower-grid">
          {pieCard}
          {rhythmCard}
        </div>

        <div className="player-stats-detail-grid">
          {breakdownCard}
          {dayDetailCard}
        </div>
      </div>
    </div>
  );
}
