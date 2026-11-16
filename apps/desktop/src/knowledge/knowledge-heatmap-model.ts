import type {
  KnowledgeHeatmapDay,
  KnowledgeHeatmapSummary,
} from '../library/library';
import { parseDateKey } from '../tasks/calendar-model';
import {
  habitDateFromOrdinal,
  habitDateOrdinal,
} from '../tasks/habit-list-model';

const DAY_MS = 86_400_000;

export type KnowledgeHeatmapPeriod = 180 | 365;

export type KnowledgeHeatmapScope = 'all' | 'doc' | 'mindmap' | 'manual';

export interface KnowledgeHeatmapCell {
  date: string;
  week: number;
  weekday: number;
  level: 0 | 1 | 2 | 3 | 4;
  totalCount: number;
  createdCount: number;
  updatedCount: number;
  docCount: number;
  mindmapCount: number;
  charDelta: number;
  isToday: boolean;
}

export interface KnowledgeHeatmapMonthTick {
  week: number;
  label: string;
}

export interface KnowledgeHeatmapMetrics {
  totalWrites: number;
  createdWrites: number;
  updatedWrites: number;
  activeDays: number;
  currentStreak: number;
  bestStreak: number;
}

export interface KnowledgeHeatmapGridModel {
  cells: KnowledgeHeatmapCell[];
  weekCount: number;
  monthTicks: KnowledgeHeatmapMonthTick[];
  metrics: KnowledgeHeatmapMetrics;
}

/** 固定实用阈值分档，避免某日集中导入多篇笔记时压扁日常写入颜色对比度。 */
export function knowledgeHeatLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 5) return 3;
  return 4;
}

export function todayLocalDateKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function computeKnowledgeHeatmapRange(
  today: string,
  periodDays: KnowledgeHeatmapPeriod,
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

export function heatmapFiltersForScope(scope: KnowledgeHeatmapScope): {
  kindFilter?: string;
  originFilter?: string;
} {
  if (scope === 'doc') return { kindFilter: 'doc' };
  if (scope === 'mindmap') return { kindFilter: 'mindmap' };
  if (scope === 'manual') return { originFilter: 'manual' };
  return {};
}

export function buildKnowledgeHeatmapGrid(
  summary: KnowledgeHeatmapSummary,
  today: string,
): KnowledgeHeatmapGridModel {
  const startOrd = habitDateOrdinal(summary.fromDate);
  const endOrd = habitDateOrdinal(summary.toDate);
  if (startOrd == null || endOrd == null || endOrd < startOrd) {
    return {
      cells: [],
      weekCount: 0,
      monthTicks: [],
      metrics: {
        totalWrites: 0,
        createdWrites: 0,
        updatedWrites: 0,
        activeDays: 0,
        currentStreak: 0,
        bestStreak: 0,
      },
    };
  }

  const byDate = new Map<string, KnowledgeHeatmapDay>();
  for (const day of summary.days) {
    byDate.set(day.date, day);
  }

  const mondayOffset = (new Date(startOrd * DAY_MS).getUTCDay() + 6) % 7;
  const totalDays = endOrd - startOrd + 1;
  const weekCount = Math.ceil((mondayOffset + totalDays) / 7);

  const cells: KnowledgeHeatmapCell[] = [];
  const monthTicks: KnowledgeHeatmapMonthTick[] = [];
  let lastTickWeek = -3;

  let totalWrites = 0;
  let createdWrites = 0;
  let updatedWrites = 0;
  let activeDays = 0;
  let runningStreak = 0;
  let bestStreak = 0;

  for (let offset = 0; offset < totalDays; offset += 1) {
    const ordinal = startOrd + offset;
    const date = habitDateFromOrdinal(ordinal);
    const day = byDate.get(date);
    const totalCount = day?.totalCount ?? 0;
    const createdCount = day?.createdCount ?? 0;
    const updatedCount = day?.updatedCount ?? 0;
    const docCount = day?.docCount ?? 0;
    const mindmapCount = day?.mindmapCount ?? 0;
    const charDelta = day?.charDelta ?? 0;
    const position = mondayOffset + offset;
    const week = Math.floor(position / 7) + 1;
    const weekday = (position % 7) + 1;

    cells.push({
      date,
      week,
      weekday,
      level: knowledgeHeatLevel(totalCount),
      totalCount,
      createdCount,
      updatedCount,
      docCount,
      mindmapCount,
      charDelta,
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

    totalWrites += totalCount;
    createdWrites += createdCount;
    updatedWrites += updatedCount;
    if (totalCount > 0) {
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
      totalWrites,
      createdWrites,
      updatedWrites,
      activeDays,
      currentStreak: runningStreak,
      bestStreak,
    },
  };
}
