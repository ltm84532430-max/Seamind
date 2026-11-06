export interface DailyHabitStats {
  date: string;
  done: number;
  skipped: number;
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
