import { describe, expect, it } from 'vitest';
import {
  computeHabitStreaksAndRate,
  summarizeHabitDays,
} from '../src/tasks/habit-statistics-model';

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

  it('computes current streak, best streak, and scheduled completion rate', () => {
    const metrics = computeHabitStreaksAndRate({
      habits: [
        { id: 'h1', active: true, startDate: '2026-11-01', intervalDays: 1 },
        { id: 'h2', active: false, startDate: '2026-11-01', intervalDays: 1 },
      ],
      occurrences: [
        { habitId: 'h1', dueDate: '2026-11-01', status: 'done' },
        { habitId: 'h1', dueDate: '2026-11-02', status: 'done' },
        { habitId: 'h1', dueDate: '2026-11-03', status: 'skipped' },
        { habitId: 'h1', dueDate: '2026-11-04', status: 'done' },
      ],
      fromDate: '2026-11-01',
      today: '2026-11-05',
    });
    expect(metrics).toEqual({
      currentStreak: 1,
      bestStreak: 2,
      scheduledCount: 5,
      completedScheduledCount: 3,
      completionRate: 60,
    });
  });
});
