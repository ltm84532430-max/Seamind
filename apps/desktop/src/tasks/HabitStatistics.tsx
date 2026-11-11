import { useEffect, useMemo, useRef, useState } from 'react';
import { habitApi, TASKS_CHANGED_EVENT } from './task-api';
import type { HabitSnapshot } from './types';
import { dateKey, parseDateKey } from './calendar-model';
import { summarizeHabitDays } from './habit-statistics-model';
import type { DailyHabitStats } from './habit-statistics-model';

const DAY_MS = 86_400_000;
const PERIODS = [30, 90, 365] as const;

function dateOrdinal(value: string): number | null {
  const parsed = parseDateKey(value);
  if (!parsed) return null;
  const date = new Date(0);
  date.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
  date.setUTCHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / DAY_MS);
}

function dateFromOrdinal(value: number): string {
  const date = new Date(value * DAY_MS);
  return dateKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function shortDate(value: string): string {
  const parsed = parseDateKey(value);
  return parsed ? `${parsed.month}/${parsed.day}` : value;
}

function fullDate(value: string): string {
  const parsed = parseDateKey(value);
  return parsed ? `${parsed.year}年${parsed.month}月${parsed.day}日` : value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function linePath(
  days: DailyHabitStats[],
  key: 'done' | 'skipped',
  xFor: (index: number) => number,
  yFor: (value: number) => number,
): string {
  return days
    .map(
      (day, index) =>
        `${index === 0 ? 'M' : 'L'}${xFor(index)},${yFor(day[key])}`,
    )
    .join(' ');
}

function HabitTrendChart({ days }: { days: DailyHabitStats[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setContainerWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const width = Math.max(640, days.length * 4, containerWidth);
  const height = 220;
  const left = 42;
  const right = 14;
  const top = 14;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(
    1,
    ...days.flatMap((day) => [day.done, day.skipped]),
  );
  const xFor = (index: number) =>
    left + (index / Math.max(1, days.length - 1)) * plotWidth;
  const yFor = (value: number) =>
    top + plotHeight - (value / maxValue) * plotHeight;
  const yTicks = [...new Set([0, Math.round(maxValue / 2), maxValue])];
  const xTicks = days.flatMap((day, index) => {
    const parsed = parseDateKey(day.date);
    if (
      !parsed ||
      (index !== 0 && index !== days.length - 1 && parsed.day !== 1)
    ) {
      return [];
    }
    return [{ index, label: shortDate(day.date) }];
  });
  const hasDone = days.some((day) => day.done > 0);
  const hasSkipped = days.some((day) => day.skipped > 0);

  return (
    <div className="habit-trend-scroll" ref={scrollRef}>
      <svg
        className="habit-trend-chart"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label="每日完成和跳过习惯次数趋势图，横轴为日期，纵轴为次数"
      >
        {yTicks.map((tick) => {
          const y = yFor(tick);
          return (
            <g className="habit-chart-grid" key={tick}>
              <line x1={left} y1={y} x2={width - right} y2={y} />
              <text x={left - 8} y={y + 4} textAnchor="end">
                {tick}
              </text>
            </g>
          );
        })}
        {hasDone && (
          <path
            className="habit-trend-line is-done"
            d={linePath(days, 'done', xFor, yFor)}
          />
        )}
        {hasSkipped && (
          <path
            className="habit-trend-line is-skipped"
            d={linePath(days, 'skipped', xFor, yFor)}
          />
        )}
        {days.map((day, index) => (
          <g key={day.date} className="habit-trend-point">
            <title>
              {`${fullDate(day.date)} · 完成 ${day.done} 次 · 跳过 ${day.skipped} 次`}
            </title>
            {day.done > 0 && (
              <circle
                className="is-done"
                cx={xFor(index)}
                cy={yFor(day.done)}
                r="2.5"
              />
            )}
          </g>
        ))}
        {xTicks.map((tick) => (
          <text
            className="habit-chart-date"
            key={`${tick.index}:${tick.label}`}
            x={xFor(tick.index)}
            y={height - 8}
            textAnchor={
              tick.index === 0
                ? 'start'
                : tick.index === days.length - 1
                  ? 'end'
                  : 'middle'
            }
          >
            {tick.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

function HabitHeatmap({
  days,
  onSelectDate,
}: {
  days: DailyHabitStats[];
  onSelectDate(date: string): void;
}) {
  const [focusedDate, setFocusedDate] = useState(days.at(-1)?.date ?? '');
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (days.length && !days.some((day) => day.date === focusedDate)) {
      setFocusedDate(days.at(-1)!.date);
    }
  }, [days, focusedDate]);
  const firstDate = days[0]?.date;
  const firstOrdinal = firstDate ? dateOrdinal(firstDate) : null;
  const mondayOffset =
    firstOrdinal == null
      ? 0
      : (new Date(firstOrdinal * DAY_MS).getUTCDay() + 6) % 7;
  const weekCount = Math.ceil((mondayOffset + days.length) / 7);
  const cells = days.map((day, index) => {
    const position = mondayOffset + index;
    return {
      ...day,
      week: Math.floor(position / 7) + 1,
      weekday: (position % 7) + 1,
      level: Math.min(4, day.done),
      skippedOnly: day.done === 0 && day.skipped > 0,
    };
  });
  const monthTicks = cells.flatMap((cell, index) => {
    const parsed = parseDateKey(cell.date);
    if (!parsed || (index !== 0 && parsed.day !== 1)) return [];
    return [{ week: cell.week, label: `${parsed.month}月` }];
  });
  const weekdayLabels = ['一', '', '三', '', '五', '', '日'];

  return (
    <div className="habit-heatmap-layout">
      <div className="habit-heatmap-weekdays" aria-hidden="true">
        {weekdayLabels.map((label, index) => (
          <span key={index}>{label}</span>
        ))}
      </div>
      <div className="habit-heatmap-scroll">
        <div
          className="habit-heatmap-months"
          style={{ gridTemplateColumns: `repeat(${weekCount}, 20px)` }}
          aria-hidden="true"
        >
          {monthTicks.map((month) => (
            <span
              key={`${month.week}:${month.label}`}
              style={{ gridColumn: month.week }}
            >
              {month.label}
            </span>
          ))}
        </div>
        <div
          className="habit-heatmap-grid"
          role="group"
          aria-label="习惯每日打卡热力图"
          style={{ gridTemplateColumns: `repeat(${weekCount}, 20px)` }}
        >
          {cells.map((cell, index) => (
            <button
              type="button"
              className={`habit-heatmap-cell level-${cell.level}${cell.skippedOnly ? ' is-skipped' : ''}`}
              key={cell.date}
              style={{ gridColumn: cell.week, gridRow: cell.weekday }}
              title={`${fullDate(cell.date)} · 完成 ${cell.done} 次 · 跳过 ${cell.skipped} 次`}
              aria-label={`${fullDate(cell.date)}，完成 ${cell.done} 次，跳过 ${cell.skipped} 次`}
              tabIndex={cell.date === focusedDate ? 0 : -1}
              ref={(node) => {
                if (node) cellRefs.current.set(cell.date, node);
                else cellRefs.current.delete(cell.date);
              }}
              onFocus={() => setFocusedDate(cell.date)}
              onKeyDown={(event) => {
                const offset = {
                  ArrowLeft: -7,
                  ArrowRight: 7,
                  ArrowUp: -1,
                  ArrowDown: 1,
                }[
                  event.key as
                    | 'ArrowLeft'
                    | 'ArrowRight'
                    | 'ArrowUp'
                    | 'ArrowDown'
                ];
                const targetIndex =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? cells.length - 1
                      : offset == null
                        ? -1
                        : index + offset;
                if (targetIndex < 0 || targetIndex >= cells.length) return;
                event.preventDefault();
                const next = cells[targetIndex].date;
                setFocusedDate(next);
                cellRefs.current.get(next)?.focus();
              }}
              onClick={() => onSelectDate(cell.date)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function HabitStatistics({
  today,
  categoryFilter,
  habitIds,
  onSelectDate,
}: {
  today: string;
  categoryFilter: string;
  habitIds: string[];
  onSelectDate(date: string): void;
}) {
  const [periodDays, setPeriodDays] = useState<(typeof PERIODS)[number]>(365);
  const [habitFilter, setHabitFilter] = useState('all');
  const [snapshot, setSnapshot] = useState<HabitSnapshot | null>(null);
  const [snapshotRange, setSnapshotRange] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const todayOrdinal = dateOrdinal(today) ?? 0;
  const fromDate = dateFromOrdinal(todayOrdinal - periodDays + 1);
  const currentRange = `${fromDate}:${today}`;
  const activeSnapshot = snapshotRange === currentRange ? snapshot : null;

  useEffect(() => {
    let disposed = false;
    let requestId = 0;
    const load = async () => {
      const currentRequest = ++requestId;
      setLoading(true);
      try {
        const next = await habitApi.snapshot(fromDate, today);
        if (!disposed && currentRequest === requestId) {
          setSnapshot(next);
          setSnapshotRange(currentRange);
          setError('');
        }
      } catch (reason) {
        if (!disposed && currentRequest === requestId)
          setError(errorText(reason));
      } finally {
        if (!disposed && currentRequest === requestId) setLoading(false);
      }
    };
    const onChanged = () => void load();
    const onReturn = () => {
      if (document.visibilityState !== 'hidden') void load();
    };

    void load();
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      disposed = true;
      requestId += 1;
      window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [fromDate, today, currentRange]);

  useEffect(() => setHabitFilter('all'), [categoryFilter]);
  useEffect(() => {
    if (habitFilter !== 'all' && !habitIds.includes(habitFilter))
      setHabitFilter('all');
  }, [habitFilter, habitIds]);

  const availableHabits = useMemo(() => {
    const allowed = new Set(habitIds);
    return (activeSnapshot?.habits ?? []).filter((habit) =>
      allowed.has(habit.id),
    );
  }, [habitIds, activeSnapshot?.habits]);
  const selectedHabits = useMemo(
    () =>
      availableHabits.filter(
        (habit) => habitFilter === 'all' || habit.id === habitFilter,
      ),
    [availableHabits, habitFilter],
  );
  const days = useMemo(() => {
    const startOrdinal = dateOrdinal(fromDate) ?? 0;
    const selectedIds = new Set(selectedHabits.map((habit) => habit.id));
    const occurrencesByDate = new Map<
      string,
      { done: number; skipped: number }
    >();
    // 统计只依据已保存的打卡记录，暂停区间不会被推算成计划或遗漏次数。
    for (const occurrence of activeSnapshot?.occurrences ?? []) {
      if (!selectedIds.has(occurrence.habitId)) continue;
      const current = occurrencesByDate.get(occurrence.dueDate) ?? {
        done: 0,
        skipped: 0,
      };
      current[occurrence.status] += 1;
      occurrencesByDate.set(occurrence.dueDate, current);
    }

    return Array.from({ length: periodDays }, (_, index) => {
      const date = dateFromOrdinal(startOrdinal + index);
      const counts = occurrencesByDate.get(date);
      return {
        date,
        done: counts?.done ?? 0,
        skipped: counts?.skipped ?? 0,
      };
    });
  }, [fromDate, periodDays, selectedHabits, activeSnapshot?.occurrences]);

  const totals = useMemo(() => summarizeHabitDays(days), [days]);
  const recordedDays = useMemo(
    () => days.filter((day) => day.done + day.skipped > 0),
    [days],
  );
  const selectedHabitIds = new Set(selectedHabits.map((habit) => habit.id));
  const habitsWithRecords = new Set(
    (activeSnapshot?.occurrences ?? [])
      .filter((occurrence) => selectedHabitIds.has(occurrence.habitId))
      .map((occurrence) => occurrence.habitId),
  ).size;
  const categoryName =
    categoryFilter === 'all'
      ? '全部分类'
      : (activeSnapshot?.categories.find(
          (category) => category.id === categoryFilter,
        )?.name ?? '所选分类');

  return (
    <section className="habit-stats-view" aria-label="习惯打卡统计">
      <div className="habit-stats-toolbar">
        <div className="habit-stats-scope">
          <label>
            习惯
            <select
              value={habitFilter}
              onChange={(event) => setHabitFilter(event.target.value)}
            >
              <option value="all">{categoryName}</option>
              {availableHabits.map((habit) => (
                <option key={habit.id} value={habit.id}>
                  {habit.title}
                  {habit.active ? '' : ' · 已暂停'}
                </option>
              ))}
            </select>
          </label>
          <div
            className="habit-stats-period"
            role="group"
            aria-label="统计时间范围"
          >
            {PERIODS.map((period) => (
              <button
                type="button"
                className={periodDays === period ? 'is-active' : ''}
                key={period}
                onClick={() => setPeriodDays(period)}
              >
                近 {period} 天
              </button>
            ))}
          </div>
        </div>
        <span className="habit-stats-range">
          {fromDate} — {today}
        </span>
      </div>

      {error && (
        <div className="habit-stats-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event(TASKS_CHANGED_EVENT))}
          >
            重试
          </button>
        </div>
      )}

      <div className="habit-stats-cards">
        <article>
          <span>完成打卡</span>
          <strong>{activeSnapshot ? totals.done : '—'}</strong>
          <small>次</small>
        </article>
        <article>
          <span>跳过记录</span>
          <strong>{activeSnapshot ? totals.skipped : '—'}</strong>
          <small>次</small>
        </article>
        <article>
          <span>完成日期</span>
          <strong>{activeSnapshot ? totals.completedDays : '—'}</strong>
          <small>天</small>
        </article>
        <article>
          <span>有记录的习惯</span>
          <strong>{activeSnapshot ? habitsWithRecords : '—'}</strong>
          <small>项</small>
        </article>
      </div>

      {!activeSnapshot ? (
        <div className="habit-stats-empty">
          {error
            ? '当前时段的统计记录暂不可用。'
            : loading
              ? '正在载入统计记录…'
              : '当前时段没有统计记录。'}
        </div>
      ) : (
        <>
          <section className="habit-stats-panel">
            <header>
              <div>
                <strong>每日打卡趋势</strong>
                <span>打卡次数 / 日</span>
              </div>
              <div className="habit-stats-legend">
                <span className="is-done">已完成</span>
                <span className="is-skipped">已跳过</span>
              </div>
            </header>
            <HabitTrendChart days={days} />
          </section>

          <section className="habit-stats-panel habit-heatmap-panel">
            <header>
              <div>
                <strong>打卡热力图</strong>
                <span>点击日期查看当天习惯</span>
              </div>
              <div
                className="habit-heatmap-scale"
                aria-label="完成打卡次数图例"
              >
                <span>少</span>
                {[0, 1, 2, 3, 4].map((level) => (
                  <i
                    key={level}
                    className={`habit-heatmap-cell level-${level}`}
                  />
                ))}
                <i
                  className="habit-heatmap-cell is-skipped"
                  title="仅有跳过记录"
                />
                <span>多</span>
              </div>
            </header>
            <HabitHeatmap days={days} onSelectDate={onSelectDate} />
          </section>

          <details className="habit-stats-records">
            <summary>查看每日记录 · {totals.recordedDays} 天</summary>
            {recordedDays.length ? (
              <div className="habit-stats-records-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">日期</th>
                      <th scope="col">完成</th>
                      <th scope="col">跳过</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recordedDays.map((day) => (
                      <tr key={day.date}>
                        <th scope="row">{fullDate(day.date)}</th>
                        <td>{day.done}</td>
                        <td>{day.skipped}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>所选时段没有打卡记录。</p>
            )}
          </details>

          <p className="habit-stats-note">
            完成日期仅计入实际完成的日期；跳过单独统计。未打卡日期不推断为遗漏。
          </p>
        </>
      )}
    </section>
  );
}
