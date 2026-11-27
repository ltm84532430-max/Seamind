import type { EbookDashboardBook } from './EbookReadingDashboard';

export const UNCATEGORIZED_BOOK_GROUP = '未分类';

export type ReadingMetricMode = 'time' | 'words';
export type ReadingAnalyticsScope = 'month' | 'year' | 'all';

export const CATEGORY_CHART_PALETTE: readonly string[] = [
  '#ba5b42', // Terracotta Rust
  '#2c6e58', // Deep Editorial Pine
  '#2e5c8a', // Institutional Slate Blue
  '#c48735', // Warm Ochre
  '#6c5699', // Muted Amethyst
  '#2d7d82', // Seafoam Teal
  '#a64d6d', // Berry Clay
  '#6d7c86', // Cool Pewter
];

export interface CategoryBookBreakdown {
  progressKey: string;
  title: string;
  seconds: number;
  words: number;
  progress: number;
}

export interface CategoryReadingBucket {
  category: string;
  color: string;
  seconds: number;
  words: number;
  bookCount: number;
  activeDates: string[];
  share: number; // 0..100 based on active metric
  books: CategoryBookBreakdown[];
}

export interface CategoryReadingSummary {
  totalSeconds: number;
  totalWords: number;
  categories: CategoryReadingBucket[];
  topCategory: CategoryReadingBucket | null;
}

export interface DonutSliceGeometry {
  category: string;
  color: string;
  value: number;
  share: number;
  startAngle: number;
  endAngle: number;
  path: string;
  expandedPath: string;
}

export function formatReadingDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  if (safe === 0) return '0 分钟';
  if (safe < 60) return `${safe} 秒`;
  const totalMinutes = Math.round(safe / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function formatReadingDurationCompact(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  if (safe === 0) return '0m';
  if (safe < 60) return `${safe}s`;
  const totalMinutes = Math.round(safe / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function isDateInAnalyticsScope(
  dateKey: string,
  scope: ReadingAnalyticsScope,
  year: number,
  month: number,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  if (scope === 'all') return true;
  const prefixYear = String(year);
  if (scope === 'year') {
    return dateKey.startsWith(`${prefixYear}-`);
  }
  const prefixMonth = `${prefixYear}-${String(month).padStart(2, '0')}-`;
  return dateKey.startsWith(prefixMonth);
}

export function buildCategoryReadingSummary(
  books: readonly EbookDashboardBook[],
  options: {
    scope: ReadingAnalyticsScope;
    year: number;
    month: number;
    metric: ReadingMetricMode;
  },
): CategoryReadingSummary {
  const { scope, year, month, metric } = options;
  const map = new Map<
    string,
    {
      seconds: number;
      words: number;
      bookCount: number;
      dates: Set<string>;
      books: CategoryBookBreakdown[];
    }
  >();

  let totalSeconds = 0;
  let totalWords = 0;

  for (const book of books) {
    const category =
      book.metadata?.manualCategory?.trim() || UNCATEGORIZED_BOOK_GROUP;
    let bookSeconds = 0;
    let bookWords = 0;
    const bookDates: string[] = [];

    for (const [date, sec] of Object.entries(
      book.activity?.dailySeconds ?? {},
    )) {
      if (sec > 0 && isDateInAnalyticsScope(date, scope, year, month)) {
        bookSeconds += sec;
        bookDates.push(date);
      }
    }

    for (const [date, words] of Object.entries(
      book.activity?.dailyWords ?? {},
    )) {
      if (words > 0 && isDateInAnalyticsScope(date, scope, year, month)) {
        bookWords += words;
        bookDates.push(date);
      }
    }

    const entry = map.get(category) ?? {
      seconds: 0,
      words: 0,
      bookCount: 0,
      dates: new Set<string>(),
      books: [],
    };
    entry.bookCount += 1;
    entry.seconds += bookSeconds;
    entry.words += bookWords;
    for (const d of bookDates) entry.dates.add(d);
    entry.books.push({
      progressKey: book.progressKey,
      title: book.title,
      seconds: bookSeconds,
      words: bookWords,
      progress: book.metadata?.progress ?? 0,
    });
    map.set(category, entry);

    totalSeconds += bookSeconds;
    totalWords += bookWords;
  }

  const totalMetric = metric === 'time' ? totalSeconds : totalWords;
  const orderedNames = [...map.keys()].sort((a, b) => {
    const entryA = map.get(a)!;
    const entryB = map.get(b)!;
    const primaryA = metric === 'time' ? entryA.seconds : entryA.words;
    const primaryB = metric === 'time' ? entryB.seconds : entryB.words;
    if (primaryB !== primaryA) return primaryB - primaryA;
    const secondaryA = metric === 'time' ? entryA.words : entryA.seconds;
    const secondaryB = metric === 'time' ? entryB.words : entryB.seconds;
    if (secondaryB !== secondaryA) return secondaryB - secondaryA;
    if (a === UNCATEGORIZED_BOOK_GROUP) return 1;
    if (b === UNCATEGORIZED_BOOK_GROUP) return -1;
    return entryB.bookCount - entryA.bookCount;
  });

  const categories: CategoryReadingBucket[] = orderedNames.map((name, idx) => {
    const entry = map.get(name)!;
    const metricVal = metric === 'time' ? entry.seconds : entry.words;
    const share = totalMetric > 0 ? (metricVal / totalMetric) * 100 : 0;
    const sortedBooks = [...entry.books].sort((a, b) => {
      const valA = metric === 'time' ? a.seconds : a.words;
      const valB = metric === 'time' ? b.seconds : b.words;
      if (valB !== valA) return valB - valA;
      return b.progress - a.progress;
    });
    return {
      category: name,
      color: CATEGORY_CHART_PALETTE[idx % CATEGORY_CHART_PALETTE.length],
      seconds: entry.seconds,
      words: entry.words,
      bookCount: entry.bookCount,
      activeDates: [...entry.dates].sort(),
      share,
      books: sortedBooks,
    };
  });

  const topCategory =
    categories.find((c) => (metric === 'time' ? c.seconds > 0 : c.words > 0)) ??
    null;

  return {
    totalSeconds,
    totalWords,
    categories,
    topCategory,
  };
}

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

export function describeDonutArc(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = Math.min(359.95, Math.max(0.2, endAngle - startAngle));
  const clampedEnd = startAngle + sweep;
  const outerStart = polarToCartesian(cx, cy, outerR, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, clampedEnd);
  const innerEnd = polarToCartesian(cx, cy, innerR, clampedEnd);
  const innerStart = polarToCartesian(cx, cy, innerR, startAngle);
  const largeArc = sweep > 180 ? 1 : 0;
  return [
    `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

export function computeDonutSlices(
  categories: readonly CategoryReadingBucket[],
  metric: ReadingMetricMode,
  cx = 96,
  cy = 96,
  outerR = 78,
  innerR = 52,
): DonutSliceGeometry[] {
  const nonZero = categories
    .map((c) => ({
      category: c.category,
      color: c.color,
      value: metric === 'time' ? c.seconds : c.words,
      share: c.share,
    }))
    .filter((c) => c.value > 0);

  if (nonZero.length === 0) return [];
  const total = nonZero.reduce((acc, item) => acc + item.value, 0);
  if (total <= 0) return [];

  const gapDeg = nonZero.length > 1 ? 1.8 : 0;
  let cursor = 0;

  return nonZero.map((item) => {
    const rawSweep = (item.value / total) * 360;
    const startAngle = cursor + gapDeg / 2;
    const endAngle = cursor + Math.max(rawSweep - gapDeg / 2, gapDeg / 2 + 0.5);
    cursor += rawSweep;
    return {
      category: item.category,
      color: item.color,
      value: item.value,
      share: item.share,
      startAngle,
      endAngle,
      path: describeDonutArc(cx, cy, outerR, innerR, startAngle, endAngle),
      expandedPath: describeDonutArc(
        cx,
        cy,
        outerR + 5,
        innerR - 1,
        startAngle,
        endAngle,
      ),
    };
  });
}
