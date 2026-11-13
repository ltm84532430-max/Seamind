import {
  habitDateFromOrdinal,
  habitDateOrdinal,
  isHabitDueOn,
} from './habit-list-model';

export interface DailyHabitStats {
  date: string;
  done: number;
  skipped: number;
}

export interface HabitStreakAndRateMetrics {
  currentStreak: number;
  bestStreak: number;
  scheduledCount: number;
  completedScheduledCount: number;
  completionRate: number | null;
}

/** 完成日期只计入真正完成打卡的日期，跳过记录单独保留。 */
export function summarizeHabitDays(days: DailyHabitStats[]) {
  return days.reduce(
    (total, day) => ({
      done: total.done + day.done,
      skipped: total.skipped + day.skipped,
      completedDays: total.completedDays + (day.done > 0 ? 1 : 0),
      recordedDays: total.recordedDays + (day.done + day.skipped > 0 ? 1 : 0),
    }),
    { done: 0, skipped: 0, completedDays: 0, recordedDays: 0 },
  );
}

/** 计算所选习惯在时间区间内的当前/最佳连续打卡天数及计划完成率。 */
export function computeHabitStreaksAndRate({
  habits,
  occurrences,
  fromDate,
  today,
}: {
  habits: ReadonlyArray<{
    id: string;
    active: boolean;
    startDate: string;
    intervalDays: number;
  }>;
  occurrences: ReadonlyArray<{
    habitId: string;
    dueDate: string;
    status: 'done' | 'skipped';
  }>;
  fromDate: string;
  today: string;
}): HabitStreakAndRateMetrics {
  const fromOrdinal = habitDateOrdinal(fromDate);
  const todayOrdinal = habitDateOrdinal(today);
  if (
    fromOrdinal == null ||
    todayOrdinal == null ||
    todayOrdinal < fromOrdinal
  ) {
    return {
      currentStreak: 0,
      bestStreak: 0,
      scheduledCount: 0,
      completedScheduledCount: 0,
      completionRate: null,
    };
  }

  const activeHabits = habits.filter((habit) => habit.active);
  const doneByDate = new Map<string, Set<string>>();
  for (const occurrence of occurrences) {
    if (occurrence.status !== 'done') continue;
    const set = doneByDate.get(occurrence.dueDate) ?? new Set<string>();
    set.add(occurrence.habitId);
    doneByDate.set(occurrence.dueDate, set);
  }

  let runningStreak = 0;
  let bestStreak = 0;
  let scheduledCount = 0;
  let completedScheduledCount = 0;

  for (let ordinal = fromOrdinal; ordinal <= todayOrdinal; ordinal += 1) {
    const date = habitDateFromOrdinal(ordinal);
    const doneOnDay = doneByDate.get(date);
    const dueIds = activeHabits
      .filter((habit) => isHabitDueOn(habit, date))
      .map((habit) => habit.id);

    if (dueIds.length === 0) {
      if (doneOnDay && doneOnDay.size > 0) {
        runningStreak += 1;
        bestStreak = Math.max(bestStreak, runningStreak);
      }
      continue;
    }

    const doneDueCount = dueIds.filter((id) => doneOnDay?.has(id)).length;
    scheduledCount += dueIds.length;
    completedScheduledCount += doneDueCount;

    if (doneDueCount === dueIds.length) {
      runningStreak += 1;
      bestStreak = Math.max(bestStreak, runningStreak);
    } else if (date < today) {
      runningStreak = 0;
    }
  }

  return {
    currentStreak: runningStreak,
    bestStreak,
    scheduledCount,
    completedScheduledCount,
    completionRate:
      scheduledCount > 0
        ? Math.round((completedScheduledCount / scheduledCount) * 100)
        : null,
  };
}
