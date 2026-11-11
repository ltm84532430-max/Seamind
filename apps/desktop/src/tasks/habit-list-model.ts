export type HabitListScope = 'today' | 'library';

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
