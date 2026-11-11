import { describe, expect, it } from 'vitest';
import {
  compareHabitsByCategory,
  nextCheckStatus,
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
});
