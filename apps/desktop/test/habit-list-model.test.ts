import { describe, expect, it } from 'vitest';
import {
  compareHabitsByCategory,
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
});
