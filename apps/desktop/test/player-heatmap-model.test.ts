import { describe, expect, it } from 'vitest';
import {
  buildHourlyRhythm,
  buildPlayerHeatmapGrid,
  buildPlayerMonthlyCalendars,
  buildWatchPieSlices,
  buildWeekdayRhythm,
  categoryKindLabel,
  computePixelGridSizing,
  computeUniformHeatmapSizing,
  computeWatchedContentDelta,
  formatCompactDuration,
  formatWatchDurationSummary,
  pieSlicePath,
  playerHeatLevel,
  resolveCategoryColor,
} from '../src/player/player-heatmap-model';

describe('player heatmap model', () => {
  it('counts genuine video content seconds across speeds and rejects seeks/pauses', () => {
    const prev = { videoId: 'v1', seconds: 100, wallMs: 10_000 };
    // 1x speed over 2s wall clock -> +2s content
    expect(computeWatchedContentDelta(prev, 'v1', 102, 12_000, true)).toBe(2);
    // 2x speed over 2s wall clock -> +4s content (playback speed ignored)
    expect(computeWatchedContentDelta(prev, 'v1', 104, 12_000, true)).toBe(4);
    // Paused -> 0
    expect(computeWatchedContentDelta(prev, 'v1', 102, 12_000, false)).toBe(0);
    // Manual forward seek +120s over 1s -> ignored
    expect(computeWatchedContentDelta(prev, 'v1', 220, 11_000, true)).toBe(0);
    // Backward scrub -> ignored
    expect(computeWatchedContentDelta(prev, 'v1', 90, 11_000, true)).toBe(0);
    // Different video -> 0
    expect(computeWatchedContentDelta(prev, 'v2', 102, 12_000, true)).toBe(0);
  });

  it('maps content duration seconds into 5 heatmap levels', () => {
    expect(playerHeatLevel(0)).toBe(0);
    expect(playerHeatLevel(300)).toBe(1);
    expect(playerHeatLevel(15 * 60)).toBe(1);
    expect(playerHeatLevel(30 * 60)).toBe(2);
    expect(playerHeatLevel(60 * 60)).toBe(3);
    expect(playerHeatLevel(120 * 60)).toBe(4);
  });

  it('builds heatmap grid, streaks, and dominant category breakdown', () => {
    const grid = buildPlayerHeatmapGrid(
      {
        fromDate: '2026-11-12',
        toDate: '2026-11-16',
        categories: [],
        days: [
          {
            date: '2026-11-12',
            totalSeconds: 1800,
            videoCount: 1,
            dominantCategoryId: 'path:quant',
            breakdown: [
              {
                categoryId: 'path:quant',
                categoryKind: 'learning-path',
                label: '量化学习',
                color: null,
                seconds: 1800,
                videoCount: 1,
              },
            ],
          },
          {
            date: '2026-11-14',
            totalSeconds: 5400,
            videoCount: 2,
            dominantCategoryId: 'course:mit',
            breakdown: [],
          },
          {
            date: '2026-11-15',
            totalSeconds: 900,
            videoCount: 1,
            dominantCategoryId: 'path:quant',
            breakdown: [],
          },
        ],
      },
      '2026-11-16',
    );

    expect(grid.cells).toHaveLength(5);
    expect(grid.cells[0].level).toBe(2);
    expect(grid.cells[2].level).toBe(3);
    expect(grid.cells[4].isToday).toBe(true);
    expect(grid.metrics).toEqual({
      totalSeconds: 8100,
      activeDays: 3,
      currentStreak: 2,
      bestStreak: 2,
      avgActiveSeconds: 2700,
    });
  });

  it('resolves category colors, kind labels, and duration strings cleanly', () => {
    expect(resolveCategoryColor('fav:1', 'ocean')).toBe('#2563eb');
    expect(resolveCategoryColor('grp:1', '#4a90e2')).toBe('#4a90e2');
    expect(resolveCategoryColor('path:quant', null)).toMatch(/^#/);
    expect(categoryKindLabel('learning-path')).toBe('学习路径');
    expect(categoryKindLabel('course')).toBe('课程');
    expect(formatWatchDurationSummary(5100)).toBe('1 小时 25 分钟');
    expect(formatCompactDuration(5100)).toBe('1h 25m');
  });

  it('computes strict integer pixel sizing and pie chart geometry', () => {
    expect(computePixelGridSizing(640, 27)).toEqual({ cellPx: 19, gapPx: 4 });
    expect(computePixelGridSizing(1080, 53)).toEqual({ cellPx: 17, gapPx: 3 });

    const cats = Array.from({ length: 9 }, (_, i) => ({
      categoryId: `c${i}`,
      categoryKind: i === 0 ? 'learning-path' : 'channel',
      label: `分类 ${i}`,
      color: null,
      totalSeconds: (10 - i) * 100,
      videoCount: 1,
    }));
    const slices = buildWatchPieSlices(cats, 7);
    expect(slices).toHaveLength(7);
    expect(slices[0].startAngleDeg).toBe(-90);
    expect(slices[6].endAngleDeg).toBe(270);
    expect(slices[6].isOtherAggregate).toBe(true);
    expect(pieSlicePath(100, 100, 80, -90, 270)).toContain('A 80 80 0 1 1');
    expect(pieSlicePath(100, 100, 80, -90, 90)).toContain('L 100.00');
  });

  it('computes weekday rhythm and 24-hour golden time summaries', () => {
    const weekdayBars = buildWeekdayRhythm([
      { weekday: 1, totalSeconds: 600 },
      { weekday: 6, totalSeconds: 2400 },
      { weekday: 7, totalSeconds: 1200 },
    ]);
    expect(weekdayBars).toHaveLength(7);
    expect(weekdayBars[5].fullLabel).toBe('周六');
    expect(weekdayBars[5].isPeak).toBe(true);
    expect(weekdayBars[5].ratio).toBe(1);

    const hourly = new Array<number>(24).fill(0);
    hourly[10] = 600;
    hourly[22] = 1800;
    hourly[23] = 1200;
    const rhythm = buildHourlyRhythm(hourly);
    expect(rhythm.peakHourLabel).toBe('22:00–23:00');
    expect(rhythm.peakPersona).toBe('深夜冲刺型');
    const night = rhythm.buckets.find((b) => b.id === 'night');
    expect(night?.percent).toBe(83);
  });

  it('computes period-invariant uniform pixel sizing and 7x6 monthly calendar matrices', () => {
    expect(computeUniformHeatmapSizing(1080)).toEqual({
      cellPx: 16,
      stripGapPx: 3,
      monthGapPx: 2,
    });
    expect(computeUniformHeatmapSizing(1280)).toEqual({
      cellPx: 18,
      stripGapPx: 3,
      monthGapPx: 2,
    });
    expect(computeUniformHeatmapSizing(640).cellPx).toBe(14);

    const grid = buildPlayerHeatmapGrid(
      {
        fromDate: '2026-08-19',
        toDate: '2026-11-16',
        categories: [],
        days: [
          {
            date: '2026-08-20',
            totalSeconds: 1200,
            videoCount: 1,
            dominantCategoryId: 'c1',
            breakdown: [],
          },
          {
            date: '2026-11-14',
            totalSeconds: 3600,
            videoCount: 2,
            dominantCategoryId: 'c1',
            breakdown: [],
          },
        ],
      },
      '2026-11-16',
    );
    const months = buildPlayerMonthlyCalendars(
      grid.cells,
      '2026-08-19',
      '2026-11-16',
    );
    expect(months.map((m) => m.label)).toEqual(['8月', '9月', '10月', '11月']);
    for (const block of months) {
      expect(block.slots).toHaveLength(42);
    }
    expect(months[0].totalSeconds).toBe(1200);
    expect(months[3].totalSeconds).toBe(3600);
    // Out-of-range dates inside boundary months are flagged rather than clickable active cells
    const aug10 = months[0].slots.find((s) => s.date === '2026-08-10');
    expect(aug10?.inRange).toBe(false);
    expect(aug10?.cell).toBeNull();
    const nov20 = months[3].slots.find((s) => s.date === '2026-11-20');
    expect(nov20?.inRange).toBe(false);
  });
});
