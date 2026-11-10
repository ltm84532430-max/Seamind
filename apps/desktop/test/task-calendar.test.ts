import { describe, expect, it } from 'vitest';
import {
  dateKey,
  formatCalendarPeriod,
  localToday,
  monthGrid,
  parseDateKey,
  shiftedDateByDays,
  shiftedDateByMonth,
  shiftedMonth,
  weekGrid,
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

  it('keeps the selected day when moving months and clamps short months', () => {
    expect(shiftedDateByMonth('2026-11-06', 1)).toBe('2026-12-06');
    expect(shiftedDateByMonth('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftedDateByMonth('2024-01-31', 1)).toBe('2024-02-29');
  });

  it('shows a Monday-first week across month and year boundaries', () => {
    expect(weekGrid('2026-11-01').map((cell) => cell.date)).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
    expect(shiftedDateByDays('2026-12-28', 7)).toBe('2027-01-04');
  });

  it('formats month and week labels for the toolbar', () => {
    expect(formatCalendarPeriod('month', { year: 2026, month: 11 })).toBe(
      '2026年11月',
    );
    expect(
      formatCalendarPeriod(
        'week',
        { year: 2026, month: 11 },
        '2026-11-09',
        '2026-11-15',
      ),
    ).toBe('11月9日 – 15日');
    expect(
      formatCalendarPeriod(
        'week',
        { year: 2026, month: 11 },
        '2026-10-26',
        '2026-11-01',
      ),
    ).toBe('10月26日 – 11月1日');
    expect(
      formatCalendarPeriod(
        'week',
        { year: 2026, month: 12 },
        '2026-12-28',
        '2027-01-03',
      ),
    ).toBe('2026年12月28日 – 2027年1月3日');
  });
});
