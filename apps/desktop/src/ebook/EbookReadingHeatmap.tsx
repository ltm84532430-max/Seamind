import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent } from 'react';
import { EbookCategoryTimeChart } from './EbookCategoryTimeChart';
import type { EbookDashboardBook } from './EbookReadingDashboard';
import {
  formatReadingDuration,
  formatReadingDurationCompact,
  UNCATEGORIZED_BOOK_GROUP,
  type ReadingMetricMode,
} from './ebook-reading-analytics';
import {
  clearReadingActivityForDate,
  clearAllReadingActivity,
} from './ebook-storage';

export type HeatmapViewUnit = 'month' | 'year';

interface DayBookEntry {
  title: string;
  words: number;
  seconds: number;
  category: string;
}

interface DayActivity {
  date: string;
  words: number;
  seconds: number;
  books: DayBookEntry[];
}

interface MonthCell {
  date: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isFuture: boolean;
  words: number;
  seconds: number;
  books: DayBookEntry[];
  level: number;
}

interface YearDayCell {
  date: string;
  words: number;
  seconds: number;
  books: DayBookEntry[];
  inRange: boolean;
  isFuture: boolean;
  level: number;
}

/**
 * Tracks the inner size of an element. The SVG charts draw in these real pixels; a fixed viewBox
 * stretched with preserveAspectRatio="xMinYMin meet" distorted every label when the window was resized.
 */
function useElementSize(fallback: { width: number; height: number }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState(fallback);

  useLayoutEffect(() => {
    if (!element) return undefined;
    const update = () => {
      const width = Math.round(element.clientWidth);
      const height = Math.round(element.clientHeight);
      if (width <= 0 || height <= 0) return;
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [setElement, size] as const;
}

export default function EbookReadingHeatmap({
  books,
  onActivityChanged,
}: {
  books: EbookDashboardBook[];
  onActivityChanged?: () => void;
}) {
  const today = new Date();
  const todayKey = localDateKey(today);

  // Default unit is 'month' as requested
  const [viewUnit, setViewUnit] = useState<HeatmapViewUnit>('month');
  const [selectedYear, setSelectedYear] = useState<number>(today.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(
    today.getMonth() + 1,
  ); // 1-12
  const [focusedDate, setFocusedDate] = useState<string>(todayKey);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<boolean>(true);
  const [localRevision, setLocalRevision] = useState<number>(0);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [categoryMetric, setCategoryMetric] = useState<ReadingMetricMode>(
    () => {
      const hasAnySeconds = books.some((b) =>
        Object.values(b.activity?.dailySeconds ?? {}).some((s) => s > 0),
      );
      return hasAnySeconds ? 'time' : 'words';
    },
  );
  const moreActionsRef = useRef<HTMLDetailsElement>(null);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    date: string;
    words: number;
    books: DayBookEntry[];
  } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleDown = (e: MouseEvent | PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.ebook-heatmap-context-menu')) return;
      setContextMenu(null);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('pointerdown', handleDown as EventListener);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('pointerdown', handleDown as EventListener);
      window.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu]);

  const handleCellContextMenu = (
    e: MouseEvent<HTMLElement | SVGElement>,
    date: string,
    words: number,
    dayBooks: DayBookEntry[],
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setFocusedDate(date);
    const menuWidth = 200;
    const menuHeight = 120;
    const x = Math.min(e.clientX + 2, window.innerWidth - menuWidth - 10);
    const y = Math.min(e.clientY + 2, window.innerHeight - menuHeight - 10);
    setContextMenu({
      x: Math.max(10, x),
      y: Math.max(10, y),
      date,
      words,
      books: dayBooks,
    });
  };

  const handleClearDate = (date: string, words: number) => {
    const formatted = formatWords(words);
    const msg =
      words > 0
        ? `确认清除 ${date} 的阅读字数记录吗？\n（将清除 ${formatted} 字阅读量）`
        : `确认清除 ${date} 的阅读记录吗？`;
    if (!window.confirm(msg)) return;

    for (const b of books) {
      if (b.activity?.dailyWords && date in b.activity.dailyWords) {
        delete b.activity.dailyWords[date];
      }
      if (b.activity?.dailySeconds && date in b.activity.dailySeconds) {
        delete b.activity.dailySeconds[date];
      }
      if (b.activity?.pendingProgress && date in b.activity.pendingProgress) {
        delete b.activity.pendingProgress[date];
      }
    }
    clearReadingActivityForDate(
      date,
      books.map((b) => b.progressKey),
    );
    setContextMenu(null);
    setLocalRevision((v) => v + 1);
    onActivityChanged?.();
  };

  const handleClearAll = () => {
    if (
      !window.confirm(
        '确认清空全部电子书的阅读热力与字数记录吗？\n此操作通常用于清理测试数据，所有历史打卡与字数将重置为 0。',
      )
    ) {
      return;
    }
    for (const b of books) {
      if (b.activity) {
        b.activity.dailyWords = {};
        b.activity.dailySeconds = {};
        b.activity.pendingProgress = {};
      }
    }
    clearAllReadingActivity(books.map((b) => b.progressKey));
    setContextMenu(null);
    setLocalRevision((v) => v + 1);
    onActivityChanged?.();
  };

  const monthGridRef = useRef<HTMLDivElement>(null);
  const yearGridRef = useRef<HTMLDivElement>(null);
  const [chartBoxRef, chartSize] = useElementSize({ width: 520, height: 173 });

  // Map of date string YYYY-MM-DD -> { words, seconds, books }
  const activityByDate = useMemo(() => {
    const result = new Map<string, DayActivity>();
    for (const book of books) {
      const category =
        book.metadata?.manualCategory?.trim() || UNCATEGORIZED_BOOK_GROUP;
      const dateSet = new Set<string>([
        ...Object.keys(book.activity?.dailyWords ?? {}),
        ...Object.keys(book.activity?.dailySeconds ?? {}),
      ]);
      for (const date of dateSet) {
        const words = book.activity?.dailyWords?.[date] ?? 0;
        const seconds = book.activity?.dailySeconds?.[date] ?? 0;
        if (words <= 0 && seconds <= 0) continue;
        const day = result.get(date) ?? {
          date,
          words: 0,
          seconds: 0,
          books: [],
        };
        day.words += words;
        day.seconds += seconds;
        day.books.push({ title: book.title, words, seconds, category });
        result.set(date, day);
      }
    }
    return result;
  }, [books, localRevision]);

  // Total words & seconds tracked across all dates
  const { totalTrackedWords, totalTrackedSeconds } = useMemo(() => {
    let wordsSum = 0;
    let secondsSum = 0;
    for (const item of activityByDate.values()) {
      wordsSum += item.words;
      secondsSum += item.seconds;
    }
    return { totalTrackedWords: wordsSum, totalTrackedSeconds: secondsSum };
  }, [activityByDate]);

  // Stepper handlers
  const stepMonth = (delta: number) => {
    let nextMonth = selectedMonth + delta;
    let nextYear = selectedYear;
    if (nextMonth < 1) {
      nextMonth = 12;
      nextYear -= 1;
    } else if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    setSelectedMonth(nextMonth);
    setSelectedYear(nextYear);
    const targetKey = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
    setFocusedDate(targetKey);
  };

  const stepYear = (delta: number) => {
    const nextYear = selectedYear + delta;
    setSelectedYear(nextYear);
    const targetKey = `${nextYear}-${String(selectedMonth).padStart(2, '0')}-01`;
    setFocusedDate(targetKey);
  };

  const resetToCurrent = () => {
    const now = new Date();
    setSelectedYear(now.getFullYear());
    setSelectedMonth(now.getMonth() + 1);
    setFocusedDate(todayKey);
  };

  const handleDateKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    dateKey: string,
  ) => {
    const offset =
      event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp'
            ? -7
            : event.key === 'ArrowDown'
              ? 7
              : null;
    if (offset === null) return;
    const [year, month, day] = dateKey.split('-').map(Number);
    const nextDate = new Date(year, month - 1, day + offset);
    const nextKey = localDateKey(nextDate);
    const grid = event.currentTarget.closest(
      '.ebook-month-grid, .ebook-heatmap-grid',
    );
    const target = grid?.querySelector<HTMLButtonElement>(
      `[data-date="${nextKey}"]`,
    );
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  // --- Month View Data Computation ---
  const monthData = useMemo(() => {
    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
    const firstDayDate = new Date(selectedYear, selectedMonth - 1, 1);
    // Monday-based: 0=Mon, 6=Sun
    const startWeekday = (firstDayDate.getDay() + 6) % 7;

    // Previous month padding
    const prevMonthDaysCount = new Date(
      selectedYear,
      selectedMonth - 1,
      0,
    ).getDate();
    const cells: MonthCell[] = [];

    for (let i = startWeekday - 1; i >= 0; i -= 1) {
      const dayNum = prevMonthDaysCount - i;
      const prevDate = new Date(selectedYear, selectedMonth - 2, dayNum);
      const key = localDateKey(prevDate);
      const act = activityByDate.get(key);
      const words = act?.words ?? 0;
      const seconds = act?.seconds ?? 0;
      cells.push({
        date: key,
        dayNumber: dayNum,
        isCurrentMonth: false,
        isToday: key === todayKey,
        isFuture: key > todayKey,
        words,
        seconds,
        books: act?.books ?? [],
        level: 0,
      });
    }

    let monthWords = 0;
    let monthSeconds = 0;
    let activeDaysCount = 0;
    let peakDayWords = 0;
    let peakDayDate = '';
    const daysOfMonth: Array<{
      day: number;
      date: string;
      words: number;
      seconds: number;
      books: DayBookEntry[];
    }> = [];

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(selectedYear, selectedMonth - 1, day);
      const key = localDateKey(date);
      const act = activityByDate.get(key);
      const isFuture = key > todayKey;
      const words = isFuture ? 0 : (act?.words ?? 0);
      const seconds = isFuture ? 0 : (act?.seconds ?? 0);
      const booksList = isFuture ? [] : (act?.books ?? []);

      monthWords += words;
      monthSeconds += seconds;
      if (words > 0 || seconds > 0) {
        activeDaysCount += 1;
        if (words > peakDayWords) {
          peakDayWords = words;
          peakDayDate = key;
        }
      }

      daysOfMonth.push({ day, date: key, words, seconds, books: booksList });

      cells.push({
        date: key,
        dayNumber: day,
        isCurrentMonth: true,
        isToday: key === todayKey,
        isFuture,
        words,
        seconds,
        books: booksList,
        level: getHeatLevel(words),
      });
    }

    // Trailing days to complete grid rows
    const remaining = (7 - (cells.length % 7)) % 7;
    for (let day = 1; day <= remaining; day += 1) {
      const nextDate = new Date(selectedYear, selectedMonth, day);
      const key = localDateKey(nextDate);
      const act = activityByDate.get(key);
      const words = act?.words ?? 0;
      const seconds = act?.seconds ?? 0;
      cells.push({
        date: key,
        dayNumber: day,
        isCurrentMonth: false,
        isToday: key === todayKey,
        isFuture: key > todayKey,
        words,
        seconds,
        books: act?.books ?? [],
        level: 0,
      });
    }

    // If active month is current month, daily avg is calculated based on days passed so far
    const isCurrentActualMonth =
      selectedYear === today.getFullYear() &&
      selectedMonth === today.getMonth() + 1;
    const elapsedDays = isCurrentActualMonth
      ? Math.max(1, today.getDate())
      : daysInMonth;
    const dailyAvg = Math.round(monthWords / elapsedDays);
    const dailyAvgSeconds = Math.round(monthSeconds / elapsedDays);
    const activeRate = Math.round((activeDaysCount / elapsedDays) * 100);

    return {
      cells,
      daysInMonth,
      daysOfMonth,
      totalWords: monthWords,
      totalSeconds: monthSeconds,
      dailyAvgSeconds,
      activeDays: activeDaysCount,
      elapsedDays,
      dailyAvg,
      activeRate,
      peakWords: peakDayWords,
      peakDate: peakDayDate,
    };
  }, [selectedYear, selectedMonth, activityByDate, todayKey]);

  // --- Year View Data Computation (52 weeks) ---
  const yearData = useMemo(() => {
    // Generate 52/53 weeks covering the selected year
    const startOfYear = new Date(selectedYear, 0, 1);
    const endOfYear = new Date(selectedYear, 11, 31);
    // Align to Monday start
    const gridStart = new Date(startOfYear);
    gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7));

    const weeks: YearDayCell[][] = [];
    const currentWeekCursor = new Date(gridStart);
    let yearWords = 0;
    let yearSeconds = 0;
    let activeDays = 0;
    let peakDayWords = 0;
    let peakDayDate = '';

    // Monthly aggregation for 2D chart
    const monthlyWords = Array.from({ length: 12 }, () => 0);
    const monthlyActiveDays = Array.from({ length: 12 }, () => 0);

    for (let w = 0; w < 53; w += 1) {
      const days: YearDayCell[] = [];
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const curDate = new Date(currentWeekCursor);
        curDate.setDate(curDate.getDate() + w * 7 + weekday);
        const key = localDateKey(curDate);
        const inRange = curDate >= startOfYear && curDate <= endOfYear;
        const isFuture = key > todayKey;
        const act = activityByDate.get(key);
        const words = isFuture ? 0 : (act?.words ?? 0);
        const seconds = isFuture ? 0 : (act?.seconds ?? 0);

        if (inRange) {
          yearWords += words;
          yearSeconds += seconds;
          const monthIndex = curDate.getMonth();
          monthlyWords[monthIndex] += words;
          if (words > 0 || seconds > 0) {
            activeDays += 1;
            monthlyActiveDays[monthIndex] += 1;
            if (words > peakDayWords) {
              peakDayWords = words;
              peakDayDate = key;
            }
          }
        }

        days.push({
          date: key,
          words,
          seconds,
          books: isFuture ? [] : (act?.books ?? []),
          inRange,
          isFuture,
          level: getHeatLevel(words),
        });
      }
      weeks.push(days);
    }

    const isCurrentActualYear = selectedYear === today.getFullYear();
    const daysInYear =
      new Date(selectedYear, 1, 29).getMonth() === 1 ? 366 : 365;
    const elapsedDays = isCurrentActualYear
      ? Math.floor(
          (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
            Date.UTC(selectedYear, 0, 1)) /
            86400000,
        ) + 1
      : daysInYear;
    const dailyAvg = Math.round(yearWords / elapsedDays);
    const dailyAvgSeconds = Math.round(yearSeconds / elapsedDays);
    const activeRate = Math.round((activeDays / elapsedDays) * 100);

    // Month headers for year grid
    const monthHeaders: Array<{ label: string; start: number; span: number }> =
      [];
    weeks.forEach((week, index) => {
      const firstValidDay = week.find((d) => d.inRange) ?? week[0];
      const m = Number(firstValidDay.date.slice(5, 7));
      const label = `${m}月`;
      const prev = monthHeaders[monthHeaders.length - 1];
      if (prev && prev.label === label) {
        prev.span += 1;
      } else {
        monthHeaders.push({ label, start: index, span: 1 });
      }
    });

    return {
      weeks,
      monthHeaders,
      totalWords: yearWords,
      totalSeconds: yearSeconds,
      dailyAvgSeconds,
      activeDays,
      elapsedDays,
      dailyAvg,
      activeRate,
      peakWords: peakDayWords,
      peakDate: peakDayDate,
      monthlyWords,
      monthlyActiveDays,
    };
  }, [selectedYear, activityByDate, todayKey]);

  // Current active KPI metrics depending on view
  const currentMetrics = useMemo(() => {
    if (viewUnit === 'month') {
      return {
        totalWords: monthData.totalWords,
        totalSeconds: monthData.totalSeconds,
        dailyAvgSeconds: monthData.dailyAvgSeconds,
        dailyAvg: monthData.dailyAvg,
        activeDays: monthData.activeDays,
        totalDays: monthData.elapsedDays,
        activeRate: monthData.activeRate,
        peakWords: monthData.peakWords,
        peakDate: monthData.peakDate,
      };
    }
    return {
      totalWords: yearData.totalWords,
      totalSeconds: yearData.totalSeconds,
      dailyAvgSeconds: yearData.dailyAvgSeconds,
      dailyAvg: yearData.dailyAvg,
      activeDays: yearData.activeDays,
      totalDays: yearData.elapsedDays,
      activeRate: yearData.activeRate,
      peakWords: yearData.peakWords,
      peakDate: yearData.peakDate,
    };
  }, [viewUnit, monthData, yearData]);

  // Active inspected date (hovered date takes precedence, else focusedDate)
  const activeInspectDate = hoveredDate || focusedDate;
  const inspectActivity = activityByDate.get(activeInspectDate);
  const inspectWords = inspectActivity?.words ?? 0;
  const inspectSeconds = inspectActivity?.seconds ?? 0;
  const inspectBooks = inspectActivity?.books ?? [];

  return (
    <section
      className={`ebook-reading-heatmap ebook-library-heatmap ebook-institutional-heatmap${expanded ? ' is-expanded' : ''}`}
      aria-labelledby="ebook-heatmap-title"
    >
      {/* 1. Clean Header */}
      <header className="ebook-institutional-header">
        <div className="ebook-institutional-title-block">
          <div className="ebook-institutional-title-row">
            <h2 id="ebook-heatmap-title">阅读统计</h2>
            <span
              className="ebook-institutional-period-tag"
              aria-label="当前统计周期"
            >
              {viewUnit === 'month'
                ? `${selectedYear}年${selectedMonth}月`
                : `${selectedYear}年`}
            </span>
          </div>
        </div>

        <div className="ebook-institutional-header-actions">
          {/* View Unit Switcher (Default: Month) */}
          <div
            className="ebook-institutional-seg-control"
            role="radiogroup"
            aria-label="热力图聚合粒度"
          >
            <button
              type="button"
              className={`ebook-institutional-seg-btn${viewUnit === 'month' ? ' is-active' : ''}`}
              onClick={() => setViewUnit('month')}
              role="radio"
              aria-checked={viewUnit === 'month'}
            >
              月度视图
            </button>
            <button
              type="button"
              className={`ebook-institutional-seg-btn${viewUnit === 'year' ? ' is-active' : ''}`}
              onClick={() => setViewUnit('year')}
              role="radio"
              aria-checked={viewUnit === 'year'}
            >
              年度视图
            </button>
          </div>

          {/* Stepper Navigation */}
          <div
            className="ebook-institutional-stepper"
            aria-label="时间周期步进"
          >
            <button
              type="button"
              className="ebook-institutional-stepper-btn"
              onClick={() =>
                viewUnit === 'month' ? stepMonth(-1) : stepYear(-1)
              }
              title={viewUnit === 'month' ? '上一月' : '上一年'}
              aria-label={viewUnit === 'month' ? '上一月' : '上一年'}
            >
              ‹
            </button>
            <button
              type="button"
              className="ebook-institutional-stepper-reset"
              onClick={resetToCurrent}
              title={viewUnit === 'month' ? '返回本月' : '返回今年'}
            >
              {viewUnit === 'month' ? '本月' : '今年'}
            </button>
            <button
              type="button"
              className="ebook-institutional-stepper-btn"
              onClick={() =>
                viewUnit === 'month' ? stepMonth(1) : stepYear(1)
              }
              title={viewUnit === 'month' ? '下一月' : '下一年'}
              aria-label={viewUnit === 'month' ? '下一月' : '下一年'}
            >
              ›
            </button>
          </div>

          <details className="ebook-heatmap-more" ref={moreActionsRef}>
            <summary aria-label="更多热力图操作">更多</summary>
            <div className="ebook-heatmap-more-menu">
              <button
                type="button"
                className="ebook-heatmap-clear-all"
                onClick={() => {
                  moreActionsRef.current?.removeAttribute('open');
                  handleClearAll();
                }}
                title="清空全部电子书的每日阅读字数记录"
              >
                清除统计记录…
              </button>
            </div>
          </details>

          {/* Expand / Collapse Toggle */}
          <button
            type="button"
            className="ebook-heatmap-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
            {expanded ? '收起看板' : '展开看板'}
          </button>
        </div>
      </header>

      {expanded && (
        <div className="ebook-institutional-body">
          {/* 2. KPI Metrics Ribbon */}
          <div
            className="ebook-institutional-kpi-ribbon"
            role="region"
            aria-label="阅读指标数据概览"
          >
            <div className="ebook-institutional-kpi-tile">
              <span className="ebook-kpi-label">累计读量</span>
              <div className="ebook-kpi-main">
                <strong className="ebook-kpi-value">
                  {formatWords(currentMetrics.totalWords)}
                </strong>
                <span className="ebook-kpi-unit">字</span>
              </div>
              <span className="ebook-kpi-sub">
                {viewUnit === 'month'
                  ? selectedYear === today.getFullYear() &&
                    selectedMonth === today.getMonth() + 1
                    ? `截至 ${today.getDate()} 日`
                    : `${selectedMonth} 月累计`
                  : selectedYear === today.getFullYear()
                    ? `截至 ${today.getMonth() + 1} 月 ${today.getDate()} 日`
                    : `${selectedYear} 年累计`}
              </span>
            </div>

            <div className="ebook-institutional-kpi-tile">
              <span className="ebook-kpi-label">阅读时长</span>
              <div className="ebook-kpi-main">
                <strong className="ebook-kpi-value">
                  {currentMetrics.totalSeconds > 0
                    ? formatReadingDurationCompact(currentMetrics.totalSeconds)
                    : '0m'}
                </strong>
              </div>
              <span className="ebook-kpi-sub">
                {currentMetrics.totalSeconds > 0
                  ? `日均 ${formatReadingDurationCompact(currentMetrics.dailyAvgSeconds)}`
                  : '阅读时自动计时'}
              </span>
            </div>

            <div className="ebook-institutional-kpi-tile">
              <span className="ebook-kpi-label">日均读量</span>
              <div className="ebook-kpi-main">
                <strong className="ebook-kpi-value">
                  {formatWords(currentMetrics.dailyAvg)}
                </strong>
                <span className="ebook-kpi-unit">字/日</span>
              </div>
              <span className="ebook-kpi-sub">
                按 {currentMetrics.totalDays} 天计算
              </span>
            </div>

            <div className="ebook-institutional-kpi-tile">
              <span className="ebook-kpi-label">活跃天数</span>
              <div className="ebook-kpi-main">
                <strong className="ebook-kpi-value">
                  {currentMetrics.activeDays}
                  <small className="ebook-kpi-denom">
                    {' '}
                    / {currentMetrics.totalDays} 天
                  </small>
                </strong>
                <span className="ebook-kpi-badge">
                  {currentMetrics.activeRate}%
                </span>
              </div>
              <span className="ebook-kpi-sub">有效阅读天数占比</span>
            </div>

            <div className="ebook-institutional-kpi-tile">
              <span className="ebook-kpi-label">单日峰值</span>
              <div className="ebook-kpi-main">
                <strong className="ebook-kpi-value">
                  {currentMetrics.peakWords > 0
                    ? formatWords(currentMetrics.peakWords)
                    : '—'}
                </strong>
                {currentMetrics.peakWords > 0 && (
                  <span className="ebook-kpi-unit">字</span>
                )}
              </div>
              <span className="ebook-kpi-sub">
                {currentMetrics.peakDate
                  ? currentMetrics.peakDate
                  : '本周期暂无记录'}
              </span>
            </div>
          </div>

          {/* 3. Adaptive Pixel-Strict Bento Grid (Month: 2-col + bottom full | Year: top full + 2-col bottom) */}
          <div
            className={`ebook-analytics-bento ${viewUnit === 'year' ? 'is-year' : 'is-month'}`}
          >
            {/* Heatmap Pane */}
            <div className="ebook-institutional-heatmap-pane">
              <div className="ebook-pane-header">
                <div className="ebook-pane-title-group">
                  <h3 className="ebook-pane-title">
                    {viewUnit === 'month' ? '月度热力' : '年度热力'}
                  </h3>
                </div>
                <span className="ebook-pane-status">
                  {viewUnit === 'month'
                    ? `${selectedYear}年${selectedMonth}月 · ${monthData.daysInMonth}天`
                    : `${selectedYear}年 · 53周`}
                </span>
              </div>

              {viewUnit === 'month' ? (
                /* Month Calendar Grid */
                <div className="ebook-month-calendar" ref={monthGridRef}>
                  <div className="ebook-month-weekdays" aria-hidden="true">
                    <span>一</span>
                    <span>二</span>
                    <span>三</span>
                    <span>四</span>
                    <span>五</span>
                    <span>六</span>
                    <span>日</span>
                  </div>
                  <div
                    className="ebook-month-grid"
                    role="grid"
                    aria-label={`${selectedYear}年${selectedMonth}月每日阅读热力`}
                  >
                    {Array.from(
                      { length: monthData.cells.length / 7 },
                      (_, weekIndex) => (
                        <div
                          className="ebook-month-week"
                          role="row"
                          key={monthData.cells[weekIndex * 7].date}
                        >
                          {monthData.cells
                            .slice(weekIndex * 7, weekIndex * 7 + 7)
                            .map((cell) => {
                              const isSelected = focusedDate === cell.date;
                              const isHovered = hoveredDate === cell.date;
                              const matchesCategory = Boolean(
                                selectedCategory &&
                                cell.isCurrentMonth &&
                                cell.books.some(
                                  (b) => b.category === selectedCategory,
                                ),
                              );
                              const mutedByCategory = Boolean(
                                selectedCategory &&
                                cell.isCurrentMonth &&
                                !matchesCategory,
                              );
                              const label = cell.isCurrentMonth
                                ? `${cell.date}${cell.isFuture ? '（未来日期）' : ''}，约 ${formatWords(cell.words)} 字${
                                    cell.seconds > 0
                                      ? ` · ${formatReadingDuration(cell.seconds)}`
                                      : ''
                                  }${
                                    cell.books.length
                                      ? `\n${cell.books.map((b) => `${b.title}：约 ${formatWords(b.words)} 字${b.seconds > 0 ? ` / ${formatReadingDurationCompact(b.seconds)}` : ''}`).join('\n')}`
                                      : ''
                                  }`
                                : `${cell.date}（非本月）`;

                              return (
                                <button
                                  type="button"
                                  role="gridcell"
                                  key={cell.date}
                                  data-date={cell.date}
                                  className={`ebook-month-day level-${cell.isCurrentMonth ? cell.level : 0}${
                                    cell.isCurrentMonth ? '' : ' is-outside'
                                  }${cell.isFuture ? ' is-future' : ''}${cell.isToday ? ' is-today' : ''}${
                                    isSelected ? ' is-selected' : ''
                                  }${isHovered ? ' is-hovered' : ''}${
                                    matchesCategory ? ' is-category-match' : ''
                                  }${mutedByCategory ? ' is-category-muted' : ''}`}
                                  tabIndex={focusedDate === cell.date ? 0 : -1}
                                  aria-selected={isSelected}
                                  title={label}
                                  aria-label={label}
                                  onKeyDown={(event) =>
                                    handleDateKeyDown(event, cell.date)
                                  }
                                  onMouseEnter={() => setHoveredDate(cell.date)}
                                  onMouseLeave={() => setHoveredDate(null)}
                                  onClick={() => setFocusedDate(cell.date)}
                                  onFocus={() => setFocusedDate(cell.date)}
                                  onContextMenu={(e) =>
                                    handleCellContextMenu(
                                      e,
                                      cell.date,
                                      cell.words,
                                      cell.books,
                                    )
                                  }
                                >
                                  <span className="ebook-month-day-num">
                                    {cell.dayNumber}
                                  </span>
                                  {cell.isCurrentMonth && cell.words > 0 && (
                                    <span className="ebook-month-day-val">
                                      {cell.words >= 1000
                                        ? `${(cell.words / 1000).toFixed(1)}k`
                                        : cell.words}
                                    </span>
                                  )}
                                  {cell.isToday && (
                                    <span
                                      className="ebook-month-today-dot"
                                      aria-hidden="true"
                                    />
                                  )}
                                </button>
                              );
                            })}
                        </div>
                      ),
                    )}
                  </div>
                </div>
              ) : (
                /* Year 52-Week Matrix */
                <div className="ebook-year-calendar" ref={yearGridRef}>
                  <div className="ebook-heatmap-months" aria-hidden="true">
                    {yearData.monthHeaders.map((m) => (
                      <span
                        key={`${m.label}-${m.start}`}
                        style={{
                          gridColumn: `${m.start + 1} / span ${m.span}`,
                        }}
                      >
                        {m.label}
                      </span>
                    ))}
                  </div>
                  <div className="ebook-heatmap-wrap is-expanded">
                    <div
                      className="ebook-heatmap-weekdays is-expanded"
                      aria-hidden="true"
                    >
                      <span>一</span>
                      <span />
                      <span>三</span>
                      <span />
                      <span>五</span>
                      <span />
                      <span />
                    </div>
                    <div
                      className="ebook-heatmap-grid is-expanded"
                      role="grid"
                      aria-label={`${selectedYear}年度每日阅读字数热力`}
                    >
                      {yearData.weeks.map((week, weekIndex) => (
                        <div
                          className="ebook-heatmap-week"
                          role="row"
                          key={weekIndex}
                        >
                          {week.map((day) => {
                            const isSelected = focusedDate === day.date;
                            const isHovered = hoveredDate === day.date;
                            const matchesCategory = Boolean(
                              selectedCategory &&
                              day.inRange &&
                              day.books.some(
                                (b) => b.category === selectedCategory,
                              ),
                            );
                            const mutedByCategory = Boolean(
                              selectedCategory &&
                              day.inRange &&
                              !matchesCategory,
                            );
                            const label = day.inRange
                              ? `${day.date}${day.isFuture ? '（未来日期）' : ''}，约 ${formatWords(day.words)} 字${
                                  day.seconds > 0
                                    ? ` · ${formatReadingDuration(day.seconds)}`
                                    : ''
                                }${
                                  day.books.length
                                    ? `\n${day.books.map((b) => `${b.title}：约 ${formatWords(b.words)} 字`).join('\n')}`
                                    : ''
                                }`
                              : `${day.date}（不在本年）`;

                            return (
                              <button
                                type="button"
                                role="gridcell"
                                className={`ebook-heatmap-day level-${day.level}${
                                  day.inRange ? '' : ' is-outside'
                                }${day.isFuture ? ' is-future' : ''}${isSelected ? ' is-selected' : ''}${
                                  isHovered ? ' is-hovered' : ''
                                }${matchesCategory ? ' is-category-match' : ''}${
                                  mutedByCategory ? ' is-category-muted' : ''
                                }`}
                                data-date={day.date}
                                key={day.date}
                                tabIndex={focusedDate === day.date ? 0 : -1}
                                aria-selected={isSelected}
                                aria-label={label}
                                title={label}
                                onKeyDown={(event) =>
                                  handleDateKeyDown(event, day.date)
                                }
                                onMouseEnter={() => setHoveredDate(day.date)}
                                onMouseLeave={() => setHoveredDate(null)}
                                onClick={() => setFocusedDate(day.date)}
                                onFocus={() => setFocusedDate(day.date)}
                                onContextMenu={(e) =>
                                  handleCellContextMenu(
                                    e,
                                    day.date,
                                    day.words,
                                    day.books,
                                  )
                                }
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Compact Pixel-Strict Heat Scale Bar */}
              <div
                className="ebook-institutional-legend is-compact-ramp"
                aria-label="热力等级色阶"
              >
                <span className="ebook-legend-summary">
                  活跃 {currentMetrics.activeDays} 天
                </span>
                <div className="ebook-legend-ramp">
                  <span className="ebook-legend-edge">少</span>
                  <span className="ebook-legend-swatches">
                    {(
                      [
                        [0, '0 字'],
                        [1, '1 – 499 字'],
                        [2, '500 – 2,999 字'],
                        [3, '3,000 – 9,999 字'],
                        [4, '10,000 – 49,999 字'],
                        [5, '≥ 50,000 字'],
                      ] as const
                    ).map(([lvl, tip]) => (
                      <i
                        key={lvl}
                        className={`ebook-legend-swatch level-${lvl}`}
                        title={tip}
                      />
                    ))}
                  </span>
                  <span className="ebook-legend-edge">多</span>
                </div>
              </div>
            </div>

            {/* Chart & Day Inspector Pane */}
            <div className="ebook-institutional-chart-pane">
              <div className="ebook-pane-header">
                <div className="ebook-pane-title-group">
                  <h3 className="ebook-pane-title">
                    {viewUnit === 'month' ? '每日分布' : '月度分布'}
                  </h3>
                </div>
                <span className="ebook-pane-sub">
                  {viewUnit === 'month'
                    ? `1日 – ${monthData.daysInMonth}日`
                    : '1月 – 12月'}
                </span>
              </div>

              {/* 2D Vector Chart */}
              <div className="ebook-2d-chart-box" ref={chartBoxRef}>
                {viewUnit === 'month' ? (
                  <Month2DChart
                    days={monthData.daysOfMonth}
                    width={chartSize.width}
                    height={chartSize.height}
                    dailyAvg={monthData.dailyAvg}
                    activeDate={activeInspectDate}
                    onHoverDate={(d) => setHoveredDate(d)}
                    onSelectDate={(d) => setFocusedDate(d)}
                    onContextMenuDate={(e, d, words, dayBooks) =>
                      handleCellContextMenu(e, d, words, dayBooks)
                    }
                  />
                ) : (
                  <Year2DChart
                    monthlyWords={yearData.monthlyWords}
                    monthlyActiveDays={yearData.monthlyActiveDays}
                    width={chartSize.width}
                    height={chartSize.height}
                    dailyAvg={yearData.dailyAvg}
                    selectedYear={selectedYear}
                  />
                )}
              </div>

              {/* Interactive Day / Period Inspector Card */}
              <div
                className="ebook-institutional-inspector"
                role="status"
                aria-label="聚焦日详细阅读审计"
              >
                <div className="ebook-inspector-header">
                  <div className="ebook-inspector-title-row">
                    <span className="ebook-inspector-dot" />
                    <strong className="ebook-inspector-date">
                      {formatInspectDateTitle(activeInspectDate)}
                    </strong>
                  </div>
                  <div className="ebook-inspector-tools">
                    <span className="ebook-inspector-level">
                      {inspectWords > 0
                        ? `热度 Level ${getHeatLevel(inspectWords)} · 活跃阅读日`
                        : '暂无阅读记录'}
                    </span>
                    {inspectWords > 0 && (
                      <button
                        type="button"
                        className="ebook-inspector-clear-btn"
                        onClick={() =>
                          handleClearDate(activeInspectDate, inspectWords)
                        }
                        title={`清除 ${activeInspectDate} 的阅读字数记录`}
                      >
                        清除此日字数
                      </button>
                    )}
                  </div>
                </div>

                <div className="ebook-inspector-body">
                  <div className="ebook-inspector-words-block">
                    <span className="ebook-inspector-number">
                      {formatWords(inspectWords)}
                    </span>
                    <span className="ebook-inspector-unit">字</span>
                    {inspectSeconds > 0 && (
                      <span className="ebook-inspector-duration-pill">
                        {formatReadingDuration(inspectSeconds)}
                      </span>
                    )}
                    {viewUnit === 'month' &&
                      monthData.totalWords > 0 &&
                      inspectWords > 0 && (
                        <span className="ebook-inspector-ratio">
                          (占当月{' '}
                          {(
                            (inspectWords / monthData.totalWords) *
                            100
                          ).toFixed(1)}
                          %)
                        </span>
                      )}
                  </div>

                  <div className="ebook-inspector-books">
                    {inspectBooks.length > 0 ? (
                      <ul className="ebook-inspector-book-list">
                        {inspectBooks.map((b, i) => (
                          <li key={i} className="ebook-inspector-book-item">
                            <span
                              className="ebook-inspector-book-name"
                              title={`${b.title}（${b.category}）`}
                            >
                              《{b.title}》
                            </span>
                            <span className="ebook-inspector-book-words">
                              {b.seconds > 0
                                ? `${formatReadingDurationCompact(b.seconds)} · `
                                : ''}
                              {formatWords(b.words)} 字
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="ebook-inspector-empty">
                        当天未产生有效阅读记录。
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Category Reading Time Donut & Breakdown (Bottom Full in Month / Bottom-Right in Year) */}
            <EbookCategoryTimeChart
              books={books}
              viewUnit={viewUnit}
              selectedYear={selectedYear}
              selectedMonth={selectedMonth}
              metric={categoryMetric}
              onMetricChange={setCategoryMetric}
              selectedCategory={selectedCategory}
              onSelectCategory={setSelectedCategory}
            />
          </div>

          <p className="ebook-heatmap-note">
            全库累计阅读约 {formatWords(totalTrackedWords)} 字
            {totalTrackedSeconds > 0
              ? ` · 实测 ${formatReadingDuration(totalTrackedSeconds)}`
              : ''}
            。点击日期或组合扇区可联动查看明细，右键日期可清除记录。
          </p>
        </div>
      )}

      {contextMenu && (
        <div
          className="ebook-heatmap-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ebook-context-menu-head">
            <span className="ebook-context-menu-date">{contextMenu.date}</span>
            <span className="ebook-context-menu-words">
              {contextMenu.words > 0
                ? `共 ${formatWords(contextMenu.words)} 字`
                : '无阅读记录'}
            </span>
          </div>
          <div className="ebook-context-menu-items">
            <button
              type="button"
              className="ebook-context-menu-item is-danger"
              disabled={contextMenu.words <= 0}
              onClick={() => {
                handleClearDate(contextMenu.date, contextMenu.words);
                setContextMenu(null);
              }}
            >
              清除该日阅读字数
            </button>
            <div className="ebook-context-menu-divider" />
            <button
              type="button"
              className="ebook-context-menu-item is-muted"
              onClick={() => {
                handleClearAll();
                setContextMenu(null);
              }}
            >
              清空全部阅读记录…
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// --- 2D Month Bar & Trend Chart Component ---
function Month2DChart({
  days,
  dailyAvg,
  activeDate,
  onHoverDate,
  onSelectDate,
  onContextMenuDate,
  width,
  height,
}: {
  days: Array<{
    day: number;
    date: string;
    words: number;
    seconds: number;
    books: DayBookEntry[];
  }>;
  dailyAvg: number;
  activeDate: string;
  onHoverDate: (date: string | null) => void;
  onSelectDate: (date: string) => void;
  onContextMenuDate?: (
    e: MouseEvent<SVGGElement>,
    date: string,
    words: number,
    books: DayBookEntry[],
  ) => void;
  width: number;
  height: number;
}) {
  const maxDayWords = Math.max(1000, ...days.map((d) => d.words));
  // Round up maxDayWords to a clean aesthetic scale
  const scaleMax = computeAestheticScale(maxDayWords);

  // SVG dimensions
  const svgWidth = Math.max(260, width);
  const svgHeight = Math.max(120, height);
  const paddingLeft = 46;
  const paddingRight = 14;
  const paddingTop = 22;
  const paddingBottom = 26;

  const plotWidth = svgWidth - paddingLeft - paddingRight;
  const plotHeight = svgHeight - paddingTop - paddingBottom;

  const numDays = days.length;
  const slotWidth = plotWidth / numDays;
  const barWidth = Math.max(3.5, Math.min(10, slotWidth - 2.5));

  // Ticks at 0, 50%, 100%
  const ticks = [0, Math.round(scaleMax / 2), scaleMax];

  // Benchmark average line Y
  const avgY =
    dailyAvg > 0
      ? paddingTop +
        plotHeight -
        Math.min(plotHeight, (dailyAvg / scaleMax) * plotHeight)
      : null;

  return (
    <svg
      className="ebook-2d-svg"
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      preserveAspectRatio="xMinYMin meet"
      aria-label="每日字数二维柱图"
    >
      {/* Horizontal grid lines & Y labels */}
      {ticks.map((tickVal) => {
        const y = paddingTop + plotHeight - (tickVal / scaleMax) * plotHeight;
        return (
          <g key={tickVal} className="ebook-chart-grid-group">
            <line
              x1={paddingLeft}
              y1={y}
              x2={svgWidth - paddingRight}
              y2={y}
              className="ebook-chart-grid-line"
            />
            <text
              x={paddingLeft - 6}
              y={y + 3.5}
              textAnchor="end"
              className="ebook-chart-y-text"
            >
              {tickVal >= 1000
                ? `${(tickVal / 1000).toFixed(tickVal % 1000 === 0 ? 0 : 1)}k`
                : tickVal}
            </text>
          </g>
        );
      })}

      {/* Daily Average Benchmark Dashed Line */}
      {avgY !== null && (
        <g className="ebook-chart-avg-line-group">
          <line
            x1={paddingLeft}
            y1={avgY}
            x2={svgWidth - paddingRight}
            y2={avgY}
            className="ebook-chart-avg-line"
          />
        </g>
      )}

      {/* Daily Bars */}
      {days.map((item, index) => {
        const x = paddingLeft + index * slotWidth + (slotWidth - barWidth) / 2;
        const barHeight =
          item.words > 0
            ? Math.max(3, (item.words / scaleMax) * plotHeight)
            : 0;
        const y = paddingTop + plotHeight - barHeight;
        const level = getHeatLevel(item.words);
        const isActive = activeDate === item.date;

        return (
          <g
            key={item.date}
            className={`ebook-chart-bar-group${isActive ? ' is-active' : ''}`}
            onMouseEnter={() => onHoverDate(item.date)}
            onMouseLeave={() => onHoverDate(null)}
            onClick={() => onSelectDate(item.date)}
            onContextMenu={(e) =>
              onContextMenuDate?.(e, item.date, item.words, item.books)
            }
          >
            {/* Hover hit area */}
            <rect
              x={paddingLeft + index * slotWidth}
              y={paddingTop}
              width={slotWidth}
              height={plotHeight}
              className="ebook-chart-bar-hit"
            />

            {/* Active column highlight */}
            {isActive && (
              <rect
                x={paddingLeft + index * slotWidth}
                y={paddingTop}
                width={slotWidth}
                height={plotHeight}
                className="ebook-chart-active-col"
              />
            )}

            {/* Base pip if words == 0 */}
            {item.words === 0 ? (
              <rect
                x={x}
                y={paddingTop + plotHeight - 1.5}
                width={barWidth}
                height={1.5}
                className="ebook-chart-bar-zero"
              />
            ) : (
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                className={`ebook-chart-bar-rect level-${level}${isActive ? ' is-active' : ''}`}
              />
            )}

            {/* X-axis label (for specific days: 1, 5, 10, 15, 20, 25, last) */}
            {(item.day === 1 ||
              item.day % 5 === 0 ||
              item.day === days.length) && (
              <text
                x={paddingLeft + index * slotWidth + slotWidth / 2}
                y={paddingTop + plotHeight + 16}
                textAnchor="middle"
                className={`ebook-chart-x-text${isActive ? ' is-active' : ''}`}
              >
                {item.day}
              </text>
            )}
          </g>
        );
      })}
      {/* Drawn as a clean top-right pill so bars and active columns never collide with the benchmark label. */}
      {avgY !== null && (
        <g className="ebook-chart-avg-pill-group">
          <rect
            x={svgWidth - paddingRight - 108}
            y={4}
            width={106}
            height={16}
            rx={4}
            className="ebook-chart-avg-pill-bg"
          />
          <text
            x={svgWidth - paddingRight - 55}
            y={15}
            textAnchor="middle"
            className="ebook-chart-avg-label"
          >
            日均 {formatWords(dailyAvg)} 字
          </text>
        </g>
      )}
    </svg>
  );
}

// --- 2D Year Monthly Bar Chart Component ---
function Year2DChart({
  monthlyWords,
  monthlyActiveDays,
  dailyAvg,
  selectedYear,
  width,
  height,
}: {
  monthlyWords: number[];
  monthlyActiveDays: number[];
  dailyAvg: number;
  selectedYear: number;
  width: number;
  height: number;
}) {
  const maxMonthWords = Math.max(5000, ...monthlyWords);
  const scaleMax = computeAestheticScale(maxMonthWords);

  const svgWidth = Math.max(260, width);
  const svgHeight = Math.max(120, height);
  const paddingLeft = 50;
  const paddingRight = 14;
  const paddingTop = 22;
  const paddingBottom = 26;

  const plotWidth = svgWidth - paddingLeft - paddingRight;
  const plotHeight = svgHeight - paddingTop - paddingBottom;

  const slotWidth = plotWidth / 12;
  const barWidth = Math.max(12, Math.min(22, slotWidth - 10));

  const ticks = [0, Math.round(scaleMax / 2), scaleMax];

  // Monthly average based on dailyAvg * 30.5
  const monthlyAvg = Math.round(dailyAvg * 30.5);
  const avgY =
    monthlyAvg > 0
      ? paddingTop +
        plotHeight -
        Math.min(plotHeight, (monthlyAvg / scaleMax) * plotHeight)
      : null;

  return (
    <svg
      className="ebook-2d-svg"
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      preserveAspectRatio="xMinYMin meet"
      aria-label={`${selectedYear}全年月度阅读柱图`}
    >
      {ticks.map((tickVal) => {
        const y = paddingTop + plotHeight - (tickVal / scaleMax) * plotHeight;
        return (
          <g key={tickVal} className="ebook-chart-grid-group">
            <line
              x1={paddingLeft}
              y1={y}
              x2={svgWidth - paddingRight}
              y2={y}
              className="ebook-chart-grid-line"
            />
            <text
              x={paddingLeft - 6}
              y={y + 3.5}
              textAnchor="end"
              className="ebook-chart-y-text"
            >
              {tickVal >= 1000 ? `${(tickVal / 1000).toFixed(0)}k` : tickVal}
            </text>
          </g>
        );
      })}

      {avgY !== null && (
        <g className="ebook-chart-avg-line-group">
          <line
            x1={paddingLeft}
            y1={avgY}
            x2={svgWidth - paddingRight}
            y2={avgY}
            className="ebook-chart-avg-line"
          />
        </g>
      )}

      {monthlyWords.map((words, mIndex) => {
        const monthNum = mIndex + 1;
        const x = paddingLeft + mIndex * slotWidth + (slotWidth - barWidth) / 2;
        const barHeight =
          words > 0 ? Math.max(4, (words / scaleMax) * plotHeight) : 0;
        const y = paddingTop + plotHeight - barHeight;
        const level = getMonthHeatLevel(words);
        const activeDaysCount = monthlyActiveDays[mIndex];
        const label = `${selectedYear}年${monthNum}月：约 ${formatWords(words)} 字（活跃 ${activeDaysCount} 天）`;

        return (
          <g
            key={monthNum}
            className="ebook-chart-bar-group"
            tabIndex={0}
            aria-label={label}
          >
            <title>{label}</title>
            <rect
              x={paddingLeft + mIndex * slotWidth}
              y={paddingTop}
              width={slotWidth}
              height={plotHeight}
              className="ebook-chart-bar-hit"
            />
            {words === 0 ? (
              <rect
                x={x}
                y={paddingTop + plotHeight - 2}
                width={barWidth}
                height={2}
                className="ebook-chart-bar-zero"
              />
            ) : (
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                className={`ebook-chart-bar-rect level-${level}`}
              />
            )}
            <text
              x={paddingLeft + mIndex * slotWidth + slotWidth / 2}
              y={paddingTop + plotHeight + 16}
              textAnchor="middle"
              className="ebook-chart-x-text"
            >
              {monthNum}月
            </text>
          </g>
        );
      })}
      {avgY !== null && (
        <g className="ebook-chart-avg-pill-group">
          <rect
            x={svgWidth - paddingRight - 122}
            y={4}
            width={120}
            height={16}
            rx={4}
            className="ebook-chart-avg-pill-bg"
          />
          <text
            x={svgWidth - paddingRight - 62}
            y={15}
            textAnchor="middle"
            className="ebook-chart-avg-label"
          >
            月均基准 {formatWords(monthlyAvg)} 字
          </text>
        </g>
      )}
    </svg>
  );
}

// --- Helpers ---
function computeAestheticScale(val: number): number {
  if (val <= 1000) return 1000;
  if (val <= 2000) return 2000;
  if (val <= 4000) return 4000;
  if (val <= 8000) return 8000;
  if (val <= 15000) return 15000;
  if (val <= 30000) return 30000;
  if (val <= 60000) return 60000;
  return Math.ceil(val / 20000) * 20000;
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatWords(words: number): string {
  return new Intl.NumberFormat('zh-CN').format(Math.round(words));
}

function getHeatLevel(words: number): number {
  if (words <= 0) return 0;
  if (words < 500) return 1;
  if (words < 3000) return 2;
  if (words < 10000) return 3;
  if (words < 50000) return 4;
  return 5;
}

function getMonthHeatLevel(words: number): number {
  if (words <= 0) return 0;
  if (words < 5000) return 1;
  if (words < 15000) return 2;
  if (words < 35000) return 3;
  return 4;
}

function formatInspectDateTitle(dateKey: string): string {
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '未选定日期';
  const parts = dateKey.split('-');
  const y = parts[0];
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const date = new Date(Number(y), m - 1, d);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const dayName = weekdays[date.getDay()] ?? '';
  return `${y}年${m}月${d}日 · ${dayName}`;
}
