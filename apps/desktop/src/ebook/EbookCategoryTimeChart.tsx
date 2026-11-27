import { memo, useMemo, useState } from 'react';
import type { EbookDashboardBook } from './EbookReadingDashboard';
import {
  buildCategoryReadingSummary,
  computeDonutSlices,
  formatReadingDuration,
  formatReadingDurationCompact,
  type ReadingAnalyticsScope,
  type ReadingMetricMode,
} from './ebook-reading-analytics';

export interface EbookCategoryTimeChartProps {
  books: readonly EbookDashboardBook[];
  viewUnit: 'month' | 'year';
  selectedYear: number;
  selectedMonth: number;
  metric: ReadingMetricMode;
  onMetricChange: (next: ReadingMetricMode) => void;
  selectedCategory: string | null;
  onSelectCategory: (category: string | null) => void;
}

function formatWordsCompact(words: number): string {
  if (words >= 10000) return `${(words / 10000).toFixed(1)}万字`;
  if (words >= 1000) return `${(words / 1000).toFixed(1)}k字`;
  return `${Math.round(words)}字`;
}

export const EbookCategoryTimeChart = memo(function EbookCategoryTimeChart({
  books,
  viewUnit,
  selectedYear,
  selectedMonth,
  metric,
  onMetricChange,
  selectedCategory,
  onSelectCategory,
}: EbookCategoryTimeChartProps) {
  const [allTimeScope, setAllTimeScope] = useState(false);
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const effectiveScope: ReadingAnalyticsScope = allTimeScope ? 'all' : viewUnit;

  const summary = useMemo(
    () =>
      buildCategoryReadingSummary(books, {
        scope: effectiveScope,
        year: selectedYear,
        month: selectedMonth,
        metric,
      }),
    [books, effectiveScope, metric, selectedMonth, selectedYear],
  );

  const slices = useMemo(
    () => computeDonutSlices(summary.categories, metric),
    [metric, summary.categories],
  );

  const activeCategoryName = hoveredCategory ?? selectedCategory;
  const activeBucket = useMemo(
    () =>
      activeCategoryName
        ? (summary.categories.find((c) => c.category === activeCategoryName) ??
          null)
        : null,
    [activeCategoryName, summary.categories],
  );

  const hasMetricData =
    metric === 'time' ? summary.totalSeconds > 0 : summary.totalWords > 0;

  const scopeLabel =
    effectiveScope === 'all'
      ? '全部累计'
      : effectiveScope === 'month'
        ? `${selectedYear}年${selectedMonth}月`
        : `${selectedYear}年度`;

  const handleToggleCategory = (category: string) => {
    const nextSelected = selectedCategory === category ? null : category;
    onSelectCategory(nextSelected);
    setExpandedCategory((curr) => (curr === category ? null : category));
  };

  return (
    <section
      className="ebook-category-analytics-card"
      aria-label="组合书籍阅读时间扇形监控"
    >
      <div className="ebook-pane-header ebook-category-analytics-head">
        <div className="ebook-pane-title-group">
          <h3 className="ebook-pane-title">组合书籍分布</h3>
          <span className="ebook-category-period-chip">{scopeLabel}</span>
          {selectedCategory && (
            <button
              type="button"
              className="ebook-category-filter-clear"
              onClick={() => {
                onSelectCategory(null);
                setExpandedCategory(null);
              }}
              title="取消热力图组合高亮筛选"
            >
              已联动：{selectedCategory} ×
            </button>
          )}
        </div>

        <div className="ebook-category-analytics-controls">
          <button
            type="button"
            className={`ebook-category-scope-btn${allTimeScope ? ' is-active' : ''}`}
            onClick={() => setAllTimeScope((v) => !v)}
            title={
              allTimeScope
                ? '当前展示全部历史累计，点击切回当前热力周期'
                : '切换到全部历史累计'
            }
          >
            {allTimeScope ? '全部累计' : '跟随周期'}
          </button>

          <div
            className="ebook-institutional-seg-control is-compact"
            role="radiogroup"
            aria-label="组合分布统计口径"
          >
            <button
              type="button"
              role="radio"
              aria-checked={metric === 'time'}
              className={`ebook-institutional-seg-btn${metric === 'time' ? ' is-active' : ''}`}
              onClick={() => onMetricChange('time')}
            >
              阅读时长
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={metric === 'words'}
              className={`ebook-institutional-seg-btn${metric === 'words' ? ' is-active' : ''}`}
              onClick={() => onMetricChange('words')}
            >
              阅读字数
            </button>
          </div>
        </div>
      </div>

      <div className="ebook-category-analytics-body">
        {/* Left: SVG Donut / Pie Chart */}
        <div className="ebook-donut-stage">
          <svg
            className="ebook-donut-svg"
            viewBox="0 0 192 192"
            width="192"
            height="192"
            role="img"
            aria-label="组合书籍阅读占比扇形图"
          >
            {/* Base subtle track ring */}
            <circle
              cx="96"
              cy="96"
              r="65"
              fill="none"
              className="ebook-donut-track"
              strokeWidth="26"
            />

            {slices.map((slice) => {
              const isHighlighted = activeCategoryName === slice.category;
              const isDimmed = Boolean(activeCategoryName) && !isHighlighted;
              return (
                <path
                  key={slice.category}
                  d={isHighlighted ? slice.expandedPath : slice.path}
                  fill={slice.color}
                  className={`ebook-donut-slice${isHighlighted ? ' is-active' : ''}${isDimmed ? ' is-dimmed' : ''}`}
                  onMouseEnter={() => setHoveredCategory(slice.category)}
                  onMouseLeave={() => setHoveredCategory(null)}
                  onClick={() => handleToggleCategory(slice.category)}
                >
                  <title>
                    {slice.category}：{slice.share.toFixed(1)}%
                  </title>
                </path>
              );
            })}
          </svg>

          <div className="ebook-donut-center" aria-live="polite">
            {activeBucket ? (
              <>
                <span className="ebook-donut-center-kicker">
                  {activeBucket.category}
                </span>
                <strong className="ebook-donut-center-val">
                  {metric === 'time'
                    ? formatReadingDurationCompact(activeBucket.seconds)
                    : formatWordsCompact(activeBucket.words)}
                </strong>
                <span className="ebook-donut-center-sub">
                  {activeBucket.share.toFixed(1)}% · {activeBucket.bookCount}本
                </span>
              </>
            ) : hasMetricData ? (
              <>
                <span className="ebook-donut-center-kicker">
                  {metric === 'time' ? '周期总时长' : '周期总字数'}
                </span>
                <strong className="ebook-donut-center-val">
                  {metric === 'time'
                    ? formatReadingDurationCompact(summary.totalSeconds)
                    : formatWordsCompact(summary.totalWords)}
                </strong>
                <span className="ebook-donut-center-sub">
                  {summary.topCategory
                    ? `主攻：${summary.topCategory.category}`
                    : `${summary.categories.length} 个组合`}
                </span>
              </>
            ) : (
              <>
                <span className="ebook-donut-center-kicker">
                  {metric === 'time' ? '暂无时长' : '暂无字数'}
                </span>
                <strong className="ebook-donut-center-val">—</strong>
                <span className="ebook-donut-center-sub">阅读时自动计时</span>
              </>
            )}
          </div>
        </div>

        {/* Right: Category Breakdown & Book-level Drilldown */}
        <div className="ebook-category-rank-pane">
          {!hasMetricData && metric === 'time' && summary.totalWords > 0 && (
            <div className="ebook-category-empty-hint">
              <span>
                当前周期尚无实测阅读时长（打开电子书阅读后每 15 秒自动累计）。
              </span>
              <button type="button" onClick={() => onMetricChange('words')}>
                按历史字数查看占比 →
              </button>
            </div>
          )}

          {summary.categories.length === 0 ? (
            <div className="ebook-category-empty-hint">
              <span>
                书架中暂无电子书，导入书籍并分组后可在此监控时间占比。
              </span>
            </div>
          ) : (
            <div className="ebook-category-rank-list" role="list">
              {summary.categories.map((bucket) => {
                const isSelected = selectedCategory === bucket.category;
                const isExpanded = expandedCategory === bucket.category;
                const isHovered = hoveredCategory === bucket.category;
                const barWidth = Math.max(
                  bucket.share > 0 ? 3 : 0,
                  Math.min(100, bucket.share),
                );
                return (
                  <div
                    key={bucket.category}
                    role="listitem"
                    className={`ebook-category-rank-item${isSelected ? ' is-selected' : ''}${isHovered ? ' is-hovered' : ''}`}
                    onMouseEnter={() => setHoveredCategory(bucket.category)}
                    onMouseLeave={() => setHoveredCategory(null)}
                  >
                    <button
                      type="button"
                      className="ebook-category-rank-row"
                      aria-expanded={isExpanded}
                      onClick={() => handleToggleCategory(bucket.category)}
                    >
                      <span
                        className="ebook-category-swatch"
                        style={{ backgroundColor: bucket.color }}
                        aria-hidden="true"
                      />
                      <span className="ebook-category-name">
                        {bucket.category}
                      </span>
                      <span className="ebook-category-book-count">
                        {bucket.bookCount} 本
                      </span>
                      <span className="ebook-category-metric-val">
                        {metric === 'time'
                          ? formatReadingDuration(bucket.seconds)
                          : formatWordsCompact(bucket.words)}
                      </span>
                      <span className="ebook-category-share">
                        {bucket.share.toFixed(1)}%
                      </span>
                    </button>

                    <div
                      className="ebook-category-bar-track"
                      aria-hidden="true"
                    >
                      <span
                        className="ebook-category-bar-fill"
                        style={{
                          width: `${barWidth}%`,
                          backgroundColor: bucket.color,
                        }}
                      />
                    </div>

                    {isExpanded && (
                      <div className="ebook-category-drilldown">
                        {bucket.books.map((bookItem) => (
                          <div
                            key={bookItem.progressKey}
                            className="ebook-category-drilldown-row"
                          >
                            <span
                              className="ebook-category-drilldown-title"
                              title={bookItem.title}
                            >
                              {bookItem.title}
                            </span>
                            <span className="ebook-category-drilldown-meta">
                              {bookItem.seconds > 0
                                ? formatReadingDurationCompact(bookItem.seconds)
                                : '0m'}
                              {bookItem.words > 0
                                ? ` · ${formatWordsCompact(bookItem.words)}`
                                : ''}
                              {` · ${Math.round(bookItem.progress * 100)}%`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
});
