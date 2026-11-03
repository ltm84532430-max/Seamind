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
