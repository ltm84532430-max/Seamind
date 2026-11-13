import { dateKey, parseDateKey } from './calendar-model';

export type HabitListScope = 'today' | 'library';

const BUILTIN_CATEGORY_COLORS: Record<string, string> = {
  'habit-category-health': '#58a889',
  'habit-category-learning': '#5b8def',
  'habit-category-work': '#d99043',
  'habit-category-life': '#9c7ae0',
};

const CUSTOM_CATEGORY_PALETTE = [
  '#4ea3a8',
  '#c8738b',
  '#7f9c54',
  '#c97e57',
  '#6c87c8',
  '#b07db3',
];

export function habitCategoryColor(
  categoryId: string | null | undefined,
  categories: ReadonlyArray<{ id: string; isBuiltin?: boolean }>,
): string | null {
  if (!categoryId) return null;
  if (BUILTIN_CATEGORY_COLORS[categoryId]) {
    return BUILTIN_CATEGORY_COLORS[categoryId];
  }
  const customCategories = categories.filter((category) => !category.isBuiltin);
  const index = customCategories.findIndex(
    (category) => category.id === categoryId,
  );
  if (index < 0) return null;
  return CUSTOM_CATEGORY_PALETTE[index % CUSTOM_CATEGORY_PALETTE.length];
}

export function habitDateOrdinal(value: string): number | null {
  const parsed = parseDateKey(value);
  if (!parsed) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
  utc.setUTCHours(0, 0, 0, 0);
  return Math.floor(utc.getTime() / 86_400_000);
}

export function habitDateFromOrdinal(value: number): string {
  const date = new Date(value * 86_400_000);
  return dateKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

export function isHabitDueOn(
  habit: { startDate: string; intervalDays: number },
  date: string,
): boolean {
  if (habit.intervalDays < 1) return false;
  const start = habitDateOrdinal(habit.startDate);
  const current = habitDateOrdinal(date);
  if (start == null || current == null || current < start) return false;
  return (current - start) % habit.intervalDays === 0;
}

export function nextHabitDueOnOrAfter(
  habit: { startDate: string; intervalDays: number },
  date: string,
): string {
  const start = habitDateOrdinal(habit.startDate);
  const current = habitDateOrdinal(date);
  if (start == null || current == null || current <= start)
    return habit.startDate;
  const elapsed = current - start;
  return habitDateFromOrdinal(
    current +
      ((habit.intervalDays - (elapsed % habit.intervalDays)) %
        habit.intervalDays),
  );
}

export function normalizeHabitScope(value: unknown): HabitListScope {
  return value === 'library' || value === 'all' || value === 'inactive'
    ? 'library'
    : 'today';
}

/** 再点已完成是撤销；待打卡和已跳过都直接记为完成。 */
export function nextCheckStatus(
  current: 'done' | 'skipped' | null | undefined,
): 'done' | null {
  return current === 'done' ? null : 'done';
}

export function compareHabitsByCategory<
  T extends { categoryId: string | null; title: string },
>(categories: ReadonlyArray<{ id: string }>, left: T, right: T): number {
  const rank = new Map(
    categories.map((category, index) => [category.id, index]),
  );
  const leftRank =
    left.categoryId != null && rank.has(left.categoryId)
      ? rank.get(left.categoryId)!
      : Number.MAX_SAFE_INTEGER;
  const rightRank =
    right.categoryId != null && rank.has(right.categoryId)
      ? rank.get(right.categoryId)!
      : Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left.title.localeCompare(right.title, 'zh-CN');
}
