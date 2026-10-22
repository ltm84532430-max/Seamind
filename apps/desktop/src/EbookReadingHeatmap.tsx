import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EbookDashboardBook } from './EbookReadingDashboard';

export type HeatmapViewUnit = 'month' | 'year';

interface DayActivity {
  date: string;
  words: number;
  books: Array<{ title: string; words: number }>;
}

interface MonthCell {
  date: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isFuture: boolean;
  words: number;
  books: Array<{ title: string; words: number }>;
  level: number;
}

interface YearDayCell {
  date: string;
  words: number;
  books: Array<{ title: string; words: number }>;
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
}: {
  books: EbookDashboardBook[];
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

  const monthGridRef = useRef<HTMLDivElement>(null);
  const yearGridRef = useRef<HTMLDivElement>(null);
  const [chartBoxRef, chartSize] = useElementSize({ width: 520, height: 173 });

  // Map of date string YYYY-MM-DD -> { words, books }
  const activityByDate = useMemo(() => {
    const result = new Map<string, DayActivity>();
    for (const book of books) {
      for (const [date, words] of Object.entries(
        book.activity?.dailyWords ?? {},
      )) {
        if (!words || words <= 0) continue;
        const day = result.get(date) ?? { date, words: 0, books: [] };
        day.words += words;
        day.books.push({ title: book.title, words });
        result.set(date, day);
      }
    }
    return result;
  }, [books]);

  // Total words tracked across all dates
  const totalTrackedWords = useMemo(() => {
    let sum = 0;
    for (const item of activityByDate.values()) {
      sum += item.words;
    }
    return sum;
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
      cells.push({
        date: key,
        dayNumber: dayNum,
        isCurrentMonth: false,
        isToday: key === todayKey,
        isFuture: key > todayKey,
        words,
        books: act?.books ?? [],
        level: getHeatLevel(words),
      });
    }

    let monthWords = 0;
    let activeDaysCount = 0;
    let peakDayWords = 0;
    let peakDayDate = '';
    const daysOfMonth: Array<{
      day: number;
      date: string;
      words: number;
      books: Array<{ title: string; words: number }>;
    }> = [];

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(selectedYear, selectedMonth - 1, day);
      const key = localDateKey(date);
      const act = activityByDate.get(key);
      const words = act?.words ?? 0;
      const booksList = act?.books ?? [];

      monthWords += words;
      if (words > 0) {
        activeDaysCount += 1;
        if (words > peakDayWords) {
          peakDayWords = words;
          peakDayDate = key;
        }
      }

      daysOfMonth.push({ day, date: key, words, books: booksList });

      cells.push({
        date: key,
        dayNumber: day,
        isCurrentMonth: true,
        isToday: key === todayKey,
        isFuture: key > todayKey,
        words,
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
      cells.push({
        date: key,
        dayNumber: day,
        isCurrentMonth: false,
        isToday: key === todayKey,
        isFuture: key > todayKey,
        words,
        books: act?.books ?? [],
        level: getHeatLevel(words),
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
    const activeRate = Math.round((activeDaysCount / daysInMonth) * 100);

    return {
      cells,
      daysInMonth,
      daysOfMonth,
      totalWords: monthWords,
      activeDays: activeDaysCount,
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
        const words = act?.words ?? 0;

        if (inRange) {
          yearWords += words;
          const monthIndex = curDate.getMonth();
          monthlyWords[monthIndex] += words;
          if (words > 0) {
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
          books: act?.books ?? [],
          inRange,
          isFuture,
          level: getHeatLevel(words),
        });
      }
      weeks.push(days);
    }

    const isCurrentActualYear = selectedYear === today.getFullYear();
    const dayOfYearSoFar = isCurrentActualYear
      ? Math.max(
          1,
          Math.floor((today.getTime() - startOfYear.getTime()) / 86400000) + 1,
        )
      : 365;
    const dailyAvg = Math.round(yearWords / dayOfYearSoFar);
    const activeRate = Math.round((activeDays / 365) * 100);

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
      activeDays,
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
        dailyAvg: monthData.dailyAvg,
        activeDays: monthData.activeDays,
        totalDays: monthData.daysInMonth,
        activeRate: monthData.activeRate,
        peakWords: monthData.peakWords,
        peakDate: monthData.peakDate,
      };
    }
    return {
      totalWords: yearData.totalWords,
      dailyAvg: yearData.dailyAvg,
      activeDays: yearData.activeDays,
      totalDays: 365,
      activeRate: yearData.activeRate,
      peakWords: yearData.peakWords,
      peakDate: yearData.peakDate,
    };
  }, [viewUnit, monthData, yearData]);

  // Active inspected date (hovered date takes precedence, else focusedDate)
  const activeInspectDate = hoveredDate || focusedDate;
  const inspectActivity = activityByDate.get(activeInspectDate);
  const inspectWords = inspectActivity?.words ?? 0;
  const inspectBooks = inspectActivity?.books ?? [];

  return (
    <section
      className={`ebook-reading-heatmap ebook-library-heatmap ebook-institutional-heatmap${expanded ? ' is-expanded' : ''}`}
      aria-labelledby="ebook-heatmap-title"
    >
      {/* 1. Institutional Desk Header */}
      <header className="ebook-institutional-header">
        <div className="ebook-institutional-title-block">
          <div className="ebook-institutional-kicker-row">
            <span className="ebook-institutional-kicker">
              READING VELOCITY & HEAT TELEMETRY
            </span>
            <span className="ebook-institutional-badge">机构级阅读审计</span>
          </div>
          <div className="ebook-institutional-title-row">
            <h2 id="ebook-heatmap-title">阅读热力与字数图表</h2>
            <span
              className="ebook-institutional-period-tag"
              aria-label="当前统计周期"
            >
              {viewUnit === 'month'
                ? `${selectedYear}年 ${selectedMonth}月`
                : `${selectedYear}年度`}
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
          {/* 2. Institutional KPI Metrics Ribbon */}
          <div
            className="ebook-institutional-kpi-ribbon"
            role="region"
            aria-label="阅读指标数据概览"
          >
            <div className="ebook-institutional-kpi-tile">
              <span className="ebook-kpi-label">周期累计读量 · VOLUME</span>
              <div className="ebook-kpi-main">
                <strong className="ebook-kpi-value">
                  {formatWords(currentMetrics.totalWords)}
                </strong>
                <span className="ebook-kpi-unit">字</span>
              </div>
              <span className="ebook-kpi-sub">
                {viewUnit === 'month'
                  ? `${selectedMonth}月全月有效沉浸`
                  : `${selectedYear}年度总计读量`}
              </span>
            </div>

            <div className="ebook-institutional-kpi-tile">
              <span className="ebook-kpi-label">日均阅读强度 · DAILY AVG</span>
              <div className="ebook-kpi-main">
                <strong className="ebook-kpi-value">
                  {formatWords(currentMetrics.dailyAvg)}
                </strong>
                <span className="ebook-kpi-unit">字/日</span>
              </div>
              <span className="ebook-kpi-sub">
                {viewUnit === 'month'
                  ? '当月自然日均基准线'
                  : '年度日均阅读推进'}
              </span>
            </div>

            <div className="ebook-institutional-kpi-tile">
              <span className="ebook-kpi-label">
                有效打卡天数 · ACTIVE RATIO
              </span>
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
              <span className="ebook-kpi-sub">阅读活跃频次占比</span>
            </div>

            <div className="ebook-institutional-kpi-tile">
              <span className="ebook-kpi-label">单日阅读峰值 · PEAK DAY</span>
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
                  ? `发生于 ${currentMetrics.peakDate}`
                  : '本周期暂无记录'}
              </span>
            </div>
          </div>

          {/* 3. Main Split View: Heatmap Matrix (Left) + 2D Summary Chart (Right) */}
          <div className="ebook-institutional-analytics-split">
            {/* Left Column: Heatmap (Month or Year) */}
            <div className="ebook-institutional-heatmap-pane">
              <div className="ebook-pane-header">
                <div className="ebook-pane-title-group">
                  <span className="ebook-pane-tag">HEATMAP MATRIX</span>
                  <h3 className="ebook-pane-title">
                    {viewUnit === 'month'
                      ? '月度阅读密度阵列'
                      : '年度 52 周密度分布'}
                  </h3>
                </div>
                <span className="ebook-pane-status">
                  {viewUnit === 'month'
                    ? `${selectedYear}年${selectedMonth}月 · ${monthData.daysInMonth}天`
                    : `${selectedYear}年 · 52周`}
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
                    {monthData.cells.map((cell) => {
                      const isSelected = focusedDate === cell.date;
                      const isHovered = hoveredDate === cell.date;
                      const label = cell.isCurrentMonth
                        ? `${cell.date}，约 ${formatWords(cell.words)} 字${
                            cell.books.length
                              ? `\n${cell.books.map((b) => `${b.title}：约 ${formatWords(b.words)} 字`).join('\n')}`
                              : ''
                          }`
                        : `${cell.date}（非本月）`;

                      return (
                        <button
                          type="button"
                          role="gridcell"
                          key={cell.date}
                          data-date={cell.date}
                          className={`ebook-month-day level-${cell.level}${
                            cell.isCurrentMonth ? '' : ' is-outside'
                          }${cell.isToday ? ' is-today' : ''}${
                            isSelected ? ' is-selected' : ''
                          }${isHovered ? ' is-hovered' : ''}`}
                          tabIndex={focusedDate === cell.date ? 0 : -1}
                          title={label}
                          aria-label={label}
                          onMouseEnter={() => setHoveredDate(cell.date)}
                          onMouseLeave={() => setHoveredDate(null)}
                          onClick={() => setFocusedDate(cell.date)}
                          onFocus={() => setFocusedDate(cell.date)}
                        >
                          <span className="ebook-month-day-num">
                            {cell.dayNumber}
                          </span>
                          {cell.words > 0 && (
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
                            const label = day.inRange
                              ? `${day.date}，约 ${formatWords(day.words)} 字${
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
                                }${isSelected ? ' is-selected' : ''}${
                                  isHovered ? ' is-hovered' : ''
                                }`}
                                data-date={day.date}
                                key={day.date}
                                tabIndex={focusedDate === day.date ? 0 : -1}
                                aria-label={label}
                                title={label}
                                onMouseEnter={() => setHoveredDate(day.date)}
                                onMouseLeave={() => setHoveredDate(null)}
                                onClick={() => setFocusedDate(day.date)}
                                onFocus={() => setFocusedDate(day.date)}
                              />
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Institutional Color Scale Legend */}
              <div
                className="ebook-institutional-legend"
                aria-label="热力等级色阶"
              >
                <span className="ebook-legend-title">阅读热阶：</span>
                <div className="ebook-legend-chips">
                  <span className="ebook-legend-chip">
                    <i className="level-0" />
                    <span>0</span>
                  </span>
                  <span className="ebook-legend-chip">
                    <i className="level-1" />
                    <span>1-500</span>
                  </span>
                  <span className="ebook-legend-chip">
                    <i className="level-2" />
                    <span>500-1.5k</span>
                  </span>
                  <span className="ebook-legend-chip">
                    <i className="level-3" />
                    <span>1.5k-3k</span>
                  </span>
                  <span className="ebook-legend-chip">
                    <i className="level-4" />
                    <span>&gt;3,000 字</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Right Column: 2D Daily Word Count Summary Chart (二维字数图表总结) */}
            <div className="ebook-institutional-chart-pane">
              <div className="ebook-pane-header">
                <div className="ebook-pane-title-group">
                  <span className="ebook-pane-tag">2D ANALYTICS CHART</span>
                  <h3 className="ebook-pane-title">
                    {viewUnit === 'month'
                      ? '每日阅读字数分布图'
                      : '全年月度阅读字数分布'}
                  </h3>
                </div>
                <span className="ebook-pane-sub">
                  {viewUnit === 'month'
                    ? `1日 - ${monthData.daysInMonth}日序列`
                    : '1月 - 12月聚合柱图'}
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
                  <span className="ebook-inspector-level">
                    {inspectWords > 0
                      ? `热度 Level ${getHeatLevel(inspectWords)} · 活跃阅读日`
                      : '暂无阅读记录'}
                  </span>
                </div>

                <div className="ebook-inspector-body">
                  <div className="ebook-inspector-words-block">
                    <span className="ebook-inspector-number">
                      {formatWords(inspectWords)}
                    </span>
                    <span className="ebook-inspector-unit">字</span>
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
                              title={b.title}
                            >
                              《{b.title}》
                            </span>
                            <span className="ebook-inspector-book-words">
                              {formatWords(b.words)} 字
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="ebook-inspector-empty">
                        当天未产生有效阅读字数。
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="ebook-heatmap-note">
            机构级阅读审计体系按本地有效阅读活动实时聚合。全库累计记录有效阅读约{' '}
            {formatWords(totalTrackedWords)} 字。
            {books.some((book) => book.activity?.wordCountUnavailable) &&
              ' 图片型或无法提取正文的 EPUB 不计入字数。'}{' '}
            悬停或点击任意日期单元格或图表立柱，可查看当日阅读书目明细。
          </p>
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
  width,
  height,
}: {
  days: Array<{
    day: number;
    date: string;
    words: number;
    books: Array<{ title: string; words: number }>;
  }>;
  dailyAvg: number;
  activeDate: string;
  onHoverDate: (date: string | null) => void;
  onSelectDate: (date: string) => void;
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
      {/* Drawn last so the bars cannot hide the benchmark label. */}
      {avgY !== null && (
        <text
          x={svgWidth - paddingRight - 4}
          y={avgY - 4}
          textAnchor="end"
          className="ebook-chart-avg-label"
        >
          AVG {formatWords(dailyAvg)} 字
        </text>
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
        <text
          x={svgWidth - paddingRight - 4}
          y={avgY - 4}
          textAnchor="end"
          className="ebook-chart-avg-label"
        >
          月均基准 {formatWords(monthlyAvg)} 字
        </text>
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
  if (words < 1500) return 2;
  if (words < 3000) return 3;
  return 4;
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
