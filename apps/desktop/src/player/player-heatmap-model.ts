import { parseDateKey } from '../tasks/calendar-model';
import {
  habitDateFromOrdinal,
  habitDateOrdinal,
} from '../tasks/habit-list-model';
import {
  FAVORITE_CATEGORY_COLORS,
  type WatchCategoryStat,
  type WatchDayCategoryBreakdown,
  type WatchHeatmapDay,
  type WatchHeatmapSummary,
} from './types';

const DAY_MS = 86_400_000;

export type PlayerHeatmapPeriod = 90 | 180 | 365;
export type PlayerHeatmapColorMode = 'intensity' | 'category';

export interface WatchProgressTick {
  videoId: string;
  seconds: number;
  wallMs: number;
}

export interface PlayerHeatmapCell {
  date: string;
  week: number;
  weekday: number;
  level: 0 | 1 | 2 | 3 | 4;
  totalSeconds: number;
  videoCount: number;
  dominantCategoryId: string | null;
  breakdown: WatchDayCategoryBreakdown[];
  isToday: boolean;
}

export interface PlayerHeatmapMonthTick {
  week: number;
  label: string;
}

export interface PlayerHeatmapMetrics {
  totalSeconds: number;
  activeDays: number;
  currentStreak: number;
  bestStreak: number;
  avgActiveSeconds: number;
}

export interface PlayerHeatmapGridModel {
  cells: PlayerHeatmapCell[];
  weekCount: number;
  monthTicks: PlayerHeatmapMonthTick[];
  metrics: PlayerHeatmapMetrics;
}

export interface PixelGridSizing {
  cellPx: number;
  gapPx: number;
}

export interface UniformHeatmapSizing {
  cellPx: number;
  stripGapPx: number;
  monthGapPx: number;
}

export interface PlayerMonthCalendarDay {
  key: string;
  date: string | null;
  dayNumber: number | null;
  inRange: boolean;
  cell: PlayerHeatmapCell | null;
}

export interface PlayerMonthCalendarBlock {
  monthKey: string;
  year: number;
  month: number;
  label: string;
  totalSeconds: number;
  slots: PlayerMonthCalendarDay[];
}

export interface WatchPieSlice {
  categoryId: string;
  categoryKind: string;
  label: string;
  color: string;
  totalSeconds: number;
  videoCount: number;
  ratio: number;
  percent: number;
  startAngleDeg: number;
  endAngleDeg: number;
  isOtherAggregate: boolean;
}

export interface WeekdayRhythmBar {
  weekday: number;
  shortLabel: string;
  fullLabel: string;
  totalSeconds: number;
  activeDays: number;
  ratio: number;
  isPeak: boolean;
}

export type DayPeriodId = 'morning' | 'afternoon' | 'evening' | 'night';

export interface HourlyRhythmBar {
  hour: number;
  label: string;
  seconds: number;
  ratio: number;
  isPeak: boolean;
  periodId: DayPeriodId;
}

export interface DayPeriodSummary {
  id: DayPeriodId;
  label: string;
  persona: string;
  rangeLabel: string;
  seconds: number;
  percent: number;
  isPeak: boolean;
}

export interface HourlyRhythmModel {
  hours: HourlyRhythmBar[];
  buckets: DayPeriodSummary[];
  peakHourLabel: string | null;
  peakPersona: string | null;
  totalSeconds: number;
}

const FALLBACK_CATEGORY_PALETTE = [
  '#3b9c6e',
  '#4a90e2',
  '#e08e36',
  '#9b6dd7',
  '#df735b',
  '#1ea896',
  '#d95d87',
  '#6c87c8',
];

const FAVORITE_COLOR_BY_ID = new Map<string, string>(
  FAVORITE_CATEGORY_COLORS.map((item) => [item.id, item.accent]),
);

/**
 * 计算单次播放进度上报中的有效「视频内容时长」增量（忽略倍速影响）。
 * 在 1.5x / 2x / 3x 下，按视频自身播放位置前进了多少内容秒数来计入；
 * 若遇到暂停、负向回退、或手动拖进度条大幅跳跃，则视为非连续播放跳转而不计入。
 */
export function computeWatchedContentDelta(
  prev: WatchProgressTick | null,
  videoId: string,
  currSeconds: number,
  currWallMs: number,
  playing: boolean,
): number {
  if (!playing || !prev || prev.videoId !== videoId) return 0;
  if (!Number.isFinite(currSeconds) || !Number.isFinite(prev.seconds)) return 0;
  const wallDt = (currWallMs - prev.wallMs) / 1000;
  if (wallDt <= 0 || wallDt > 5) return 0;
  const contentDelta = currSeconds - prev.seconds;
  if (contentDelta <= 0) return 0;
  const maxReasonableDelta = Math.max(10, wallDt * 5);
  if (contentDelta > maxReasonableDelta) return 0;
  return contentDelta;
}

/** 按视频内容累计时长划定 5 档热度等级：0 / <=15m / <=45m / <=90m / >90m。 */
export function playerHeatLevel(seconds: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (seconds <= 15 * 60) return 1;
  if (seconds <= 45 * 60) return 2;
  if (seconds <= 90 * 60) return 3;
  return 4;
}

export function formatWatchDurationSummary(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 分钟';
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(seconds))} 秒`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours === 0) return `${mins} 分钟`;
  if (mins === 0) return `${hours} 小时`;
  return `${hours} 小时 ${mins} 分钟`;
}

export function formatCompactDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(seconds))}s`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export function resolveCategoryColor(
  categoryId: string,
  declaredColor: string | null | undefined,
): string {
  if (declaredColor) {
    const trimmed = declaredColor.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('rgb')) return trimmed;
    const mapped = FAVORITE_COLOR_BY_ID.get(trimmed);
    if (mapped) return mapped;
  }
  let hash = 0;
  for (const ch of categoryId) {
    hash = (Math.imul(hash, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return FALLBACK_CATEGORY_PALETTE[hash % FALLBACK_CATEGORY_PALETTE.length];
}

export function categoryKindLabel(kind: string): string {
  switch (kind) {
    case 'learning-path':
      return '学习路径';
    case 'course':
      return '课程';
    case 'favorite-category':
      return '收藏分类';
    case 'subscription-group':
      return '订阅分组';
    case 'channel':
      return '频道';
    default:
      return '其他';
  }
}

export function computePlayerHeatmapRange(
  today: string,
  periodDays: PlayerHeatmapPeriod,
): { fromDate: string; toDate: string } {
  const endOrd = habitDateOrdinal(today);
  if (endOrd == null) {
    return { fromDate: today, toDate: today };
  }
  return {
    fromDate: habitDateFromOrdinal(endOrd - Math.max(0, periodDays - 1)),
    toDate: today,
  };
}

export function buildPlayerHeatmapGrid(
  summary: WatchHeatmapSummary,
  today: string,
): PlayerHeatmapGridModel {
  const startOrd = habitDateOrdinal(summary.fromDate);
  const endOrd = habitDateOrdinal(summary.toDate);
  if (startOrd == null || endOrd == null || endOrd < startOrd) {
    return {
      cells: [],
      weekCount: 0,
      monthTicks: [],
      metrics: {
        totalSeconds: 0,
        activeDays: 0,
        currentStreak: 0,
        bestStreak: 0,
        avgActiveSeconds: 0,
      },
    };
  }

  const byDate = new Map<string, WatchHeatmapDay>();
  for (const day of summary.days) {
    byDate.set(day.date, day);
  }

  const mondayOffset = (new Date(startOrd * DAY_MS).getUTCDay() + 6) % 7;
  const totalDays = endOrd - startOrd + 1;
  const weekCount = Math.ceil((mondayOffset + totalDays) / 7);

  const cells: PlayerHeatmapCell[] = [];
  const monthTicks: PlayerHeatmapMonthTick[] = [];
  let lastTickWeek = -3;

  let totalSeconds = 0;
  let activeDays = 0;
  let runningStreak = 0;
  let bestStreak = 0;

  for (let offset = 0; offset < totalDays; offset += 1) {
    const ordinal = startOrd + offset;
    const date = habitDateFromOrdinal(ordinal);
    const day = byDate.get(date);
    const secs = day?.totalSeconds ?? 0;
    const videoCount = day?.videoCount ?? 0;
    const position = mondayOffset + offset;
    const week = Math.floor(position / 7) + 1;
    const weekday = (position % 7) + 1;

    cells.push({
      date,
      week,
      weekday,
      level: playerHeatLevel(secs),
      totalSeconds: secs,
      videoCount,
      dominantCategoryId: day?.dominantCategoryId ?? null,
      breakdown: day?.breakdown ?? [],
      isToday: date === today,
    });

    const parsed = parseDateKey(date);
    if (
      parsed &&
      (offset === 0 || parsed.day === 1) &&
      week - lastTickWeek >= 2
    ) {
      monthTicks.push({ week, label: `${parsed.month}月` });
      lastTickWeek = week;
    }

    totalSeconds += secs;
    if (secs > 0) {
      activeDays += 1;
      runningStreak += 1;
      bestStreak = Math.max(bestStreak, runningStreak);
    } else if (date < today) {
      runningStreak = 0;
    }
  }

  return {
    cells,
    weekCount,
    monthTicks,
    metrics: {
      totalSeconds,
      activeDays,
      currentStreak: runningStreak,
      bestStreak,
      avgActiveSeconds: activeDays > 0 ? totalSeconds / activeDays : 0,
    },
  };
}

/**
 * 根据容器可用宽度和周列数计算严格的整数像素方格尺寸与间距，
 * 让热力图尽可能铺满卡片宽度且绝不出现亚像素模糊。
 */
export function computePixelGridSizing(
  availWidth: number,
  weekCount: number,
): PixelGridSizing {
  const cols = Math.max(1, Math.floor(weekCount));
  const gapPx = cols >= 40 ? 3 : 4;
  if (!Number.isFinite(availWidth) || availWidth <= 0) {
    return { cellPx: cols >= 40 ? 16 : 22, gapPx };
  }
  const usable = Math.floor(availWidth) - (cols - 1) * gapPx - 2;
  const raw = Math.floor(usable / cols);
  const cellPx = Math.max(13, Math.min(34, raw));
  return { cellPx, gapPx };
}

/**
 * 方案 A 专用：始终以「全年 53 周」与「固定框高（7 行 / 6 行月历）」为基准计算统一整数像素边长，
 * 确保在近 3 个月 / 近半年 / 近一年之间切换时，单格像素尺寸恒定、卡片外框一像素不变。
 */
export function computeUniformHeatmapSizing(
  stageWidth: number,
): UniformHeatmapSizing {
  const stripGapPx = 3;
  const monthGapPx = 2;
  if (!Number.isFinite(stageWidth) || stageWidth <= 0) {
    return { cellPx: 16, stripGapPx, monthGapPx };
  }
  const weekdayAxisReserve = 26;
  const usable =
    Math.floor(stageWidth) - weekdayAxisReserve - 52 * stripGapPx - 2;
  const raw = Math.floor(usable / 53);
  const cellPx = Math.max(14, Math.min(18, raw));
  return { cellPx, stripGapPx, monthGapPx };
}

/**
 * 将 `[fromDate, toDate]` 区间切分为按自然月排列的「7 列 × 6 行」等高月历矩阵，
 * 用于近 3 个月 / 近半年在固定热力图框内等像素拼排展示。
 */
export function buildPlayerMonthlyCalendars(
  cells: ReadonlyArray<PlayerHeatmapCell>,
  fromDate: string,
  toDate: string,
): PlayerMonthCalendarBlock[] {
  const fromParsed = parseDateKey(fromDate);
  const toParsed = parseDateKey(toDate);
  if (!fromParsed || !toParsed) return [];

  const fromScore = fromParsed.year * 12 + (fromParsed.month - 1);
  const toScore = toParsed.year * 12 + (toParsed.month - 1);
  if (toScore < fromScore) return [];

  const cellByDate = new Map<string, PlayerHeatmapCell>();
  for (const cell of cells) {
    cellByDate.set(cell.date, cell);
  }

  const spansMultipleYears = fromParsed.year !== toParsed.year;
  const blocks: PlayerMonthCalendarBlock[] = [];

  for (let score = fromScore; score <= toScore; score += 1) {
    const year = Math.floor(score / 12);
    const month = (score % 12) + 1;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const firstDow =
      (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;

    const slots: PlayerMonthCalendarDay[] = [];
    for (let i = 0; i < firstDow; i += 1) {
      slots.push({
        key: `${monthKey}:pre:${i}`,
        date: null,
        dayNumber: null,
        inRange: false,
        cell: null,
      });
    }

    let totalSeconds = 0;
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateStr = `${monthKey}-${String(day).padStart(2, '0')}`;
      const inRange = dateStr >= fromDate && dateStr <= toDate;
      const cell = inRange ? (cellByDate.get(dateStr) ?? null) : null;
      if (cell) totalSeconds += cell.totalSeconds;
      slots.push({
        key: dateStr,
        date: dateStr,
        dayNumber: day,
        inRange,
        cell,
      });
    }

    let postIdx = 0;
    while (slots.length < 42) {
      slots.push({
        key: `${monthKey}:post:${postIdx}`,
        date: null,
        dayNumber: null,
        inRange: false,
        cell: null,
      });
      postIdx += 1;
    }

    blocks.push({
      monthKey,
      year,
      month,
      label: spansMultipleYears
        ? `${String(year).slice(-2)}/${month}月`
        : `${month}月`,
      totalSeconds,
      slots,
    });
  }

  return blocks;
}

/**
 * 将大类观看时长列表转换为 SVG 扇形图切片。
 * 超出 `maxSlices` 的尾部零散小类会聚合成最后一块「其他合并」，保持扇区清晰易读。
 */
export function buildWatchPieSlices(
  categories: ReadonlyArray<WatchCategoryStat>,
  maxSlices = 7,
): WatchPieSlice[] {
  const positive = categories.filter((item) => item.totalSeconds > 0);
  const totalSeconds = positive.reduce(
    (sum, item) => sum + item.totalSeconds,
    0,
  );
  if (totalSeconds <= 0) return [];

  const cap = Math.max(2, maxSlices);
  const items: Array<{
    categoryId: string;
    categoryKind: string;
    label: string;
    color: string;
    totalSeconds: number;
    videoCount: number;
    isOtherAggregate: boolean;
  }> = [];

  if (positive.length <= cap) {
    for (const cat of positive) {
      items.push({
        categoryId: cat.categoryId,
        categoryKind: cat.categoryKind,
        label: cat.label,
        color: resolveCategoryColor(cat.categoryId, cat.color),
        totalSeconds: cat.totalSeconds,
        videoCount: cat.videoCount,
        isOtherAggregate: false,
      });
    }
  } else {
    const head = positive.slice(0, cap - 1);
    const tail = positive.slice(cap - 1);
    for (const cat of head) {
      items.push({
        categoryId: cat.categoryId,
        categoryKind: cat.categoryKind,
        label: cat.label,
        color: resolveCategoryColor(cat.categoryId, cat.color),
        totalSeconds: cat.totalSeconds,
        videoCount: cat.videoCount,
        isOtherAggregate: false,
      });
    }
    items.push({
      categoryId: '__pie_other__',
      categoryKind: 'other',
      label: `其余 ${tail.length} 项合计`,
      color: '#6b7882',
      totalSeconds: tail.reduce((sum, item) => sum + item.totalSeconds, 0),
      videoCount: tail.reduce((sum, item) => sum + item.videoCount, 0),
      isOtherAggregate: true,
    });
  }

  let cursorDeg = -90;
  return items.map((item, index) => {
    const ratio = item.totalSeconds / totalSeconds;
    const spanDeg = index === items.length - 1 ? 270 - cursorDeg : ratio * 360;
    const startAngleDeg = cursorDeg;
    const endAngleDeg = cursorDeg + spanDeg;
    cursorDeg = endAngleDeg;
    return {
      ...item,
      ratio,
      percent: Math.round(ratio * 100),
      startAngleDeg,
      endAngleDeg,
    };
  });
}

/** 生成 SVG 扇形 `<path d="...">`（当接近 360 度时用整圆双弧路径避免 SVG 零弧渲染丢失）。 */
export function pieSlicePath(
  cx: number,
  cy: number,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const sweep = endAngleDeg - startAngleDeg;
  if (sweep >= 359.99) {
    return [
      `M ${cx} ${cy - radius}`,
      `A ${radius} ${radius} 0 1 1 ${cx} ${cy + radius}`,
      `A ${radius} ${radius} 0 1 1 ${cx} ${cy - radius}`,
      'Z',
    ].join(' ');
  }
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const x1 = cx + radius * Math.cos(rad(startAngleDeg));
  const y1 = cy + radius * Math.sin(rad(startAngleDeg));
  const x2 = cx + radius * Math.cos(rad(endAngleDeg));
  const y2 = cy + radius * Math.sin(rad(endAngleDeg));
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

const WEEKDAY_NAMES: ReadonlyArray<{ shortLabel: string; fullLabel: string }> =
  [
    { shortLabel: '一', fullLabel: '周一' },
    { shortLabel: '二', fullLabel: '周二' },
    { shortLabel: '三', fullLabel: '周三' },
    { shortLabel: '四', fullLabel: '周四' },
    { shortLabel: '五', fullLabel: '周五' },
    { shortLabel: '六', fullLabel: '周六' },
    { shortLabel: '日', fullLabel: '周日' },
  ];

/** 统计周一至周日各星期的累计内容观看时长，识别周内投入高峰。 */
export function buildWeekdayRhythm(
  cells: ReadonlyArray<Pick<PlayerHeatmapCell, 'weekday' | 'totalSeconds'>>,
): WeekdayRhythmBar[] {
  const sums = new Array<number>(7).fill(0);
  const activeCounts = new Array<number>(7).fill(0);
  for (const cell of cells) {
    const idx = cell.weekday - 1;
    if (idx < 0 || idx > 6) continue;
    sums[idx] += cell.totalSeconds;
    if (cell.totalSeconds > 0) activeCounts[idx] += 1;
  }
  const maxSeconds = Math.max(0, ...sums);
  return WEEKDAY_NAMES.map((meta, idx) => ({
    weekday: idx + 1,
    shortLabel: meta.shortLabel,
    fullLabel: meta.fullLabel,
    totalSeconds: sums[idx],
    activeDays: activeCounts[idx],
    ratio: maxSeconds > 0 ? sums[idx] / maxSeconds : 0,
    isPeak: maxSeconds > 0 && sums[idx] === maxSeconds,
  }));
}

function periodForHour(hour: number): DayPeriodId {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

const DAY_PERIOD_META: ReadonlyArray<{
  id: DayPeriodId;
  label: string;
  persona: string;
  rangeLabel: string;
}> = [
  {
    id: 'morning',
    label: '清晨',
    persona: '清晨早学型',
    rangeLabel: '05–11点',
  },
  {
    id: 'afternoon',
    label: '午后',
    persona: '午后专注型',
    rangeLabel: '11–17点',
  },
  {
    id: 'evening',
    label: '夜晚',
    persona: '晚间精进型',
    rangeLabel: '17–22点',
  },
  { id: 'night', label: '深夜', persona: '深夜冲刺型', rangeLabel: '22–05点' },
];

/** 统计 24 小时及四大黄金时段（清晨/午后/夜晚/深夜）的内容观看分布。 */
export function buildHourlyRhythm(
  hourlySeconds: ReadonlyArray<number> | undefined,
): HourlyRhythmModel {
  const safeHours = Array.from({ length: 24 }, (_, hour) => {
    const value = hourlySeconds?.[hour] ?? 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const totalSeconds = safeHours.reduce((sum, v) => sum + v, 0);
  const maxHourSeconds = Math.max(0, ...safeHours);

  const bucketSums: Record<DayPeriodId, number> = {
    morning: 0,
    afternoon: 0,
    evening: 0,
    night: 0,
  };
  let peakHour = -1;
  const hours: HourlyRhythmBar[] = safeHours.map((seconds, hour) => {
    const periodId = periodForHour(hour);
    bucketSums[periodId] += seconds;
    const isPeak = maxHourSeconds > 0 && seconds === maxHourSeconds;
    if (isPeak && peakHour === -1) peakHour = hour;
    return {
      hour,
      label: String(hour).padStart(2, '0'),
      seconds,
      ratio: maxHourSeconds > 0 ? seconds / maxHourSeconds : 0,
      isPeak,
      periodId,
    };
  });

  const maxBucketSeconds = Math.max(0, ...Object.values(bucketSums));
  let peakPersona: string | null = null;
  const buckets: DayPeriodSummary[] = DAY_PERIOD_META.map((meta) => {
    const seconds = bucketSums[meta.id];
    const isPeak = maxBucketSeconds > 0 && seconds === maxBucketSeconds;
    if (isPeak && !peakPersona) peakPersona = meta.persona;
    return {
      ...meta,
      seconds,
      percent:
        totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 100) : 0,
      isPeak,
    };
  });

  const peakHourLabel =
    peakHour >= 0
      ? `${String(peakHour).padStart(2, '0')}:00–${String((peakHour + 1) % 24).padStart(2, '0')}:00`
      : null;

  return {
    hours,
    buckets,
    peakHourLabel,
    peakPersona,
    totalSeconds,
  };
}
