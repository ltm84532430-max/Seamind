import { describe, expect, it } from 'vitest';
import {
  compareHabitsByCategory,
  countPendingDueHabits,
  formatBadgeCount,
  habitCategoryColor,
  isHabitDueOn,
  nextCheckStatus,
  nextHabitDueOnOrAfter,
  normalizeHabitScope,
} from '../src/tasks/habit-list-model';

describe('habit list model', () => {
  it('folds the old all and paused scopes into the library', () => {
    expect(normalizeHabitScope('today')).toBe('today');
    expect(normalizeHabitScope('library')).toBe('library');
    expect(normalizeHabitScope('all')).toBe('library');
    expect(normalizeHabitScope('inactive')).toBe('library');
    expect(normalizeHabitScope('other')).toBe('today');
  });

  it('completes an open or skipped habit and clears a completed one', () => {
    expect(nextCheckStatus(undefined)).toBe('done');
    expect(nextCheckStatus(null)).toBe('done');
    expect(nextCheckStatus('skipped')).toBe('done');
    expect(nextCheckStatus('done')).toBeNull();
  });

  it('keeps category order and leaves uncategorized habits last', () => {
    const categories = [{ id: 'health' }, { id: 'study' }];
    const habits = [
      { categoryId: null, title: '早睡' },
      { categoryId: 'study', title: '阅读' },
      { categoryId: 'health', title: '拉伸' },
      { categoryId: 'health', title: '喝水' },
    ];
    expect(
      [...habits].sort((left, right) =>
        compareHabitsByCategory(categories, left, right),
      ),
    ).toEqual([
      { categoryId: 'health', title: '喝水' },
      { categoryId: 'health', title: '拉伸' },
      { categoryId: 'study', title: '阅读' },
      { categoryId: null, title: '早睡' },
    ]);
  });

  it('assigns distinct colors to builtin and custom categories', () => {
    const categories = [
      { id: 'habit-category-health', isBuiltin: true },
      { id: 'habit-category-learning', isBuiltin: true },
      { id: 'custom-1', isBuiltin: false },
      { id: 'custom-2', isBuiltin: false },
    ];
    expect(habitCategoryColor('habit-category-health', categories)).toBe(
      '#58a889',
    );
    expect(habitCategoryColor('habit-category-learning', categories)).toBe(
      '#5b8def',
    );
    expect(habitCategoryColor('custom-1', categories)).not.toBeNull();
    expect(habitCategoryColor('custom-1', categories)).not.toBe(
      habitCategoryColor('custom-2', categories),
    );
    expect(habitCategoryColor(null, categories)).toBeNull();
  });

  it('calculates recurring habit due dates and next due dates', () => {
    const habit = { startDate: '2026-11-01', intervalDays: 3 };
    expect(isHabitDueOn(habit, '2026-10-31')).toBe(false);
    expect(isHabitDueOn(habit, '2026-11-01')).toBe(true);
    expect(isHabitDueOn(habit, '2026-11-02')).toBe(false);
    expect(isHabitDueOn(habit, '2026-11-04')).toBe(true);
    expect(nextHabitDueOnOrAfter(habit, '2026-10-30')).toBe('2026-11-01');
    expect(nextHabitDueOnOrAfter(habit, '2026-11-02')).toBe('2026-11-04');
    expect(nextHabitDueOnOrAfter(habit, '2026-11-04')).toBe('2026-11-04');
  });

  it('counts pending due habits independently of tasks, decrements on done or skipped, hides at zero, and resets on a new day', () => {
    const habits = [
      {
        id: 'h-daily-1',
        title: '背单词',
        note: null,
        categoryId: null,
        intervalDays: 1,
        startDate: '2026-11-10',
        active: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'h-daily-2',
        title: '算法题',
        note: null,
        categoryId: null,
        intervalDays: 1,
        startDate: '2026-11-10',
        active: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'h-interval',
        title: '长跑',
        note: null,
        categoryId: null,
        intervalDays: 2,
        startDate: '2026-11-15',
        active: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'h-paused',
        title: '已暂停习惯',
        note: null,
        categoryId: null,
        intervalDays: 1,
        startDate: '2026-11-01',
        active: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'h-future',
        title: '未来习惯',
        note: null,
        categoryId: null,
        intervalDays: 1,
        startDate: '2026-11-20',
        active: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    // 2026-11-16: h-daily-1 + h-daily-2 are due (h-interval is due 11/15, 11/17)
    expect(
      countPendingDueHabits({ habits, occurrences: [] }, '2026-11-16'),
    ).toBe(2);

    // Completing one habit decrements count by 1
    expect(
      countPendingDueHabits(
        {
          habits,
          occurrences: [
            {
              habitId: 'h-daily-1',
              dueDate: '2026-11-16',
              status: 'done',
              completedAt: 100,
              updatedAt: 100,
            },
          ],
        },
        '2026-11-16',
      ),
    ).toBe(1);

    // Skipping the remaining due habit brings pending count to 0 (badge hidden)
    const allResolvedToday = {
      habits,
      occurrences: [
        {
          habitId: 'h-daily-1',
          dueDate: '2026-11-16',
          status: 'done' as const,
          completedAt: 100,
          updatedAt: 100,
        },
        {
          habitId: 'h-daily-2',
          dueDate: '2026-11-16',
          status: 'skipped' as const,
          completedAt: null,
          updatedAt: 101,
        },
      ],
    };
    expect(countPendingDueHabits(allResolvedToday, '2026-11-16')).toBe(0);

    // Rolling over to 2026-11-17 refreshes fresh count: h-daily-1 + h-daily-2 + h-interval
    expect(countPendingDueHabits(allResolvedToday, '2026-11-17')).toBe(3);

    expect(formatBadgeCount(5)).toBe('5');
    expect(formatBadgeCount(99)).toBe('99');
    expect(formatBadgeCount(105)).toBe('99+');
  });
});
