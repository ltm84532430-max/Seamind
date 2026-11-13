/** Task deadlines are local calendar dates, without a time or UTC conversion. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function dateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseDateKey(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  )
    return null;
  return { year, month, day };
}

export function localToday(now = new Date()): string {
  return dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function monthGrid(
  year: number,
  month: number,
): Array<{ date: string; day: number; inMonth: boolean }> {
  const first = new Date(0);
  first.setFullYear(year, month - 1, 1);
  first.setHours(12, 0, 0, 0);
  const leading = (first.getDay() + 6) % 7; // Monday first.
  const count = Math.ceil((leading + daysInMonth(year, month)) / 7) * 7;
  first.setDate(1 - leading);
  return Array.from({ length: count }, () => {
    const cell = {
      date: dateKey(first.getFullYear(), first.getMonth() + 1, first.getDate()),
      day: first.getDate(),
      inMonth: first.getMonth() + 1 === month,
    };
    first.setDate(first.getDate() + 1);
    return cell;
  });
}

export function shiftedMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const zeroBased = year * 12 + month - 1 + delta;
  const nextYear = Math.floor(zeroBased / 12);
  if (nextYear < 1 || nextYear > 9999) return { year, month };
  return { year: nextYear, month: (zeroBased % 12) + 1 };
}

/** 翻月时尽量保留所选日；目标月份较短时落到该月最后一天。 */
export function shiftedDateByMonth(value: string, delta: number): string {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  const next = shiftedMonth(parsed.year, parsed.month, delta);
  return dateKey(
    next.year,
    next.month,
    Math.min(parsed.day, daysInMonth(next.year, next.month)),
  );
}

export function shiftedDateByDays(value: string, delta: number): string {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  const next = new Date(0);
  next.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day + delta);
  next.setUTCHours(12, 0, 0, 0);
  const year = next.getUTCFullYear();
  return year >= 1 && year <= 9999
    ? dateKey(year, next.getUTCMonth() + 1, next.getUTCDate())
    : value;
}

/** 周视图与月视图使用相同的周一开始规则。 */
export function weekGrid(
  value: string,
): Array<{ date: string; day: number; inMonth: boolean }> {
  const parsed = parseDateKey(value);
  if (!parsed) return [];
  const selected = new Date(0);
  selected.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
  const mondayOffset = (selected.getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftedDateByDays(value, index - mondayOffset);
    const day = parseDateKey(date)!;
    return { date, day: day.day, inMonth: day.month === parsed.month };
  });
}

/** 工具栏上的月份或周范围。同一月的周不重复月份，跨年时两端都写年份。 */
export function formatCalendarPeriod(
  mode: 'month' | 'week',
  month: { year: number; month: number },
  weekStart?: string,
  weekEnd?: string,
): string {
  if (mode === 'month') return `${month.year}年${month.month}月`;
  const start = weekStart ? parseDateKey(weekStart) : null;
  const end = weekEnd ? parseDateKey(weekEnd) : null;
  if (!start || !end) return `${weekStart ?? ''} – ${weekEnd ?? ''}`;
  const sameYear = start.year === end.year;
  const startLabel = sameYear
    ? `${start.month}月${start.day}日`
    : `${start.year}年${start.month}月${start.day}日`;
  const endLabel =
    sameYear && start.month === end.month
      ? `${end.day}日`
      : sameYear
        ? `${end.month}月${end.day}日`
        : `${end.year}年${end.month}月${end.day}日`;
  return `${startLabel} – ${endLabel}`;
}

export const DEFAULT_CALENDAR_CELL_LIMIT = 3;

const CALENDAR_DAY_OVERHEAD_PX = 36;
const CALENDAR_ITEM_ROW_PX = 22;

/** 计算日历单格可展示条目数：周视图全量展示，月视图按行高动态适配。 */
export function computeCalendarCellVisibleCount(
  mode: 'month' | 'week',
  rowHeight: number | null | undefined,
  totalEntries: number,
): number {
  if (totalEntries <= 0) return 0;
  if (mode === 'week') return totalEntries;
  if (rowHeight == null || !Number.isFinite(rowHeight) || rowHeight <= 0) {
    return Math.min(totalEntries, DEFAULT_CALENDAR_CELL_LIMIT);
  }
  const availableHeight = Math.max(0, rowHeight - CALENDAR_DAY_OVERHEAD_PX);
  const slotsAvailable = Math.max(
    1,
    Math.floor((availableHeight + 2) / CALENDAR_ITEM_ROW_PX),
  );
  if (totalEntries <= slotsAvailable) return totalEntries;
  return Math.max(1, slotsAvailable - 1);
}
