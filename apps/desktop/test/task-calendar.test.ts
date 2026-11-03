import { describe, expect, it } from 'vitest';
import {
  dateKey,
  localToday,
  monthGrid,
  parseDateKey,
  shiftedMonth,
} from '../src/tasks/calendar-model';

describe('task deadline calendar', () => {
  it('keeps date-only deadlines on local calendar days', () => {
    const local = new Date(2026, 9, 28, 23, 45);
    expect(localToday(local)).toBe('2026-10-28');
    expect(dateKey(2026, 10, 28)).toBe('2026-10-28');
  });

  it('starts weeks on Monday and includes adjacent month dates', () => {
    const grid = monthGrid(2026, 11);
    expect(grid[0]).toMatchObject({ date: '2026-10-26', inMonth: false });
    expect(grid.find((cell) => cell.date === '2026-11-01')).toMatchObject({
      day: 1,
      inMonth: true,
    });
    expect(grid.length % 7).toBe(0);
    expect(grid.at(-1)?.date).toBe('2026-12-06');
    expect(shiftedMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });

  it('rejects impossible dates while accepting leap days', () => {
    expect(parseDateKey('2024-02-29')).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
    for (const value of [
      '2026-02-29',
      '1900-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-2-01',
    ]) {
      expect(parseDateKey(value)).toBeNull();
    }
  });
});
