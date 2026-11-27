import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCategoryReadingSummary,
  computeDonutSlices,
  formatReadingDuration,
  UNCATEGORIZED_BOOK_GROUP,
} from '../src/ebook/ebook-reading-analytics';
import {
  clearReadingActivityForDate,
  loadEpubReadingActivity,
  recordEpubReadingDuration,
} from '../src/ebook/ebook-storage';
import type { EbookDashboardBook } from '../src/ebook/EbookReadingDashboard';

const memoryStorage = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() {
      return memoryStorage.size;
    },
    key: (index: number) => [...memoryStorage.keys()][index] ?? null,
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStorage.delete(key);
    },
    clear: () => {
      memoryStorage.clear();
    },
  },
});

describe('ebook reading duration & category analytics', () => {
  beforeEach(() => {
    memoryStorage.clear();
  });

  it('persists and clears dailySeconds alongside dailyWords', () => {
    const key = 'library:linux/how-linux-works.epub:100:200';
    recordEpubReadingDuration(key, 45, '2026-11-23');
    recordEpubReadingDuration(key, 75, '2026-11-23');
    recordEpubReadingDuration(key, 120, '2026-11-24');

    const loaded = loadEpubReadingActivity(key);
    expect(loaded?.dailySeconds?.['2026-11-23']).toBe(120);
    expect(loaded?.dailySeconds?.['2026-11-24']).toBe(120);

    clearReadingActivityForDate('2026-11-23', [key]);
    const afterClear = loadEpubReadingActivity(key);
    expect(afterClear?.dailySeconds?.['2026-11-23']).toBeUndefined();
    expect(afterClear?.dailySeconds?.['2026-11-24']).toBe(120);
  });

  it('aggregates reading time and words by book category and computes donut slices', () => {
    const books: EbookDashboardBook[] = [
      {
        progressKey: 'b1',
        title: 'How Linux Works',
        metadata: {
          title: 'How Linux Works',
          author: 'Brian Ward',
          manualCategory: 'Linux',
          progress: 0.4,
          lastReadAt: 1,
        },
        activity: {
          furthestProgress: 0.4,
          estimatedTotalWords: 100000,
          dailyWords: { '2026-11-23': 12000 },
          dailySeconds: { '2026-11-23': 3600 },
          pendingProgress: {},
          wordCountUnavailable: false,
        },
        plan: null,
      },
      {
        progressKey: 'b2',
        title: 'SQL 必知必会',
        metadata: {
          title: 'SQL 必知必会',
          author: 'Ben Forta',
          manualCategory: '数据分析',
          progress: 0.6,
          lastReadAt: 1,
        },
        activity: {
          furthestProgress: 0.6,
          estimatedTotalWords: 50000,
          dailyWords: { '2026-11-24': 4000, '2026-10-12': 8000 },
          dailySeconds: { '2026-11-24': 1200, '2026-10-12': 2400 },
          pendingProgress: {},
          wordCountUnavailable: false,
        },
        plan: null,
      },
      {
        progressKey: 'b3',
        title: 'Python for Finance',
        metadata: {
          title: 'Python for Finance',
          author: 'Yves',
          progress: 0.1,
          lastReadAt: 1,
        },
        activity: null,
        plan: null,
      },
    ];

    const monthSummary = buildCategoryReadingSummary(books, {
      scope: 'month',
      year: 2026,
      month: 11,
      metric: 'time',
    });

    expect(monthSummary.totalSeconds).toBe(4800);
    expect(monthSummary.topCategory?.category).toBe('Linux');
    expect(monthSummary.categories[0].share).toBeCloseTo(75, 1);
    expect(monthSummary.categories[1].category).toBe('数据分析');
    expect(monthSummary.categories[1].share).toBeCloseTo(25, 1);
    expect(monthSummary.categories[2].category).toBe(UNCATEGORIZED_BOOK_GROUP);

    const slices = computeDonutSlices(monthSummary.categories, 'time');
    expect(slices).toHaveLength(2);
    expect(slices[0].path).toContain('A 78 78');

    expect(formatReadingDuration(0)).toBe('0 分钟');
    expect(formatReadingDuration(5400)).toBe('1h 30m');
  });
});
