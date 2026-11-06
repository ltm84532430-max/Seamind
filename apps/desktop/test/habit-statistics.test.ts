import { describe, expect, it } from 'vitest';
import { summarizeHabitDays } from '../src/tasks/habit-statistics-model';

describe('habit statistics summary', () => {
  it('counts completed dates once even when several habits are completed', () => {
    expect(
      summarizeHabitDays([
        { date: '2026-11-04', done: 2, skipped: 1 },
        { date: '2026-11-05', done: 1, skipped: 0 },
      ]),
    ).toEqual({ done: 3, skipped: 1, completedDays: 2, recordedDays: 2 });
  });

  it('keeps skipped-only dates out of completed dates and ignores empty dates', () => {
    expect(
      summarizeHabitDays([
        { date: '2026-11-04', done: 0, skipped: 1 },
        { date: '2026-11-05', done: 0, skipped: 0 },
      ]),
    ).toEqual({ done: 0, skipped: 1, completedDays: 0, recordedDays: 1 });
  });
});
