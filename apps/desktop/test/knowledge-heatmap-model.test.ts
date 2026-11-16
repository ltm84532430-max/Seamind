import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeHeatmapGrid,
  computeKnowledgeHeatmapRange,
  heatmapFiltersForScope,
  knowledgeHeatLevel,
} from '../src/knowledge/knowledge-heatmap-model';

describe('knowledge heatmap model', () => {
  it('maps write counts onto fixed 5-tier intensity levels', () => {
    expect(knowledgeHeatLevel(0)).toBe(0);
    expect(knowledgeHeatLevel(1)).toBe(1);
    expect(knowledgeHeatLevel(2)).toBe(2);
    expect(knowledgeHeatLevel(3)).toBe(2);
    expect(knowledgeHeatLevel(4)).toBe(3);
    expect(knowledgeHeatLevel(5)).toBe(3);
    expect(knowledgeHeatLevel(6)).toBe(4);
    expect(knowledgeHeatLevel(25)).toBe(4);
  });

  it('computes inclusive date range for 180 and 365 day windows', () => {
    expect(computeKnowledgeHeatmapRange('2026-11-16', 180)).toEqual({
      fromDate: '2026-05-21',
      toDate: '2026-11-16',
    });
    expect(computeKnowledgeHeatmapRange('2026-11-16', 365)).toEqual({
      fromDate: '2025-11-17',
      toDate: '2026-11-16',
    });
  });

  it('builds padded dense grid and computes streaks without breaking today before first write', () => {
    const grid = buildKnowledgeHeatmapGrid(
      {
        fromDate: '2026-11-10',
        toDate: '2026-11-16',
        days: [
          {
            date: '2026-11-10',
            totalCount: 2,
            createdCount: 2,
            updatedCount: 0,
            docCount: 2,
            mindmapCount: 0,
            charDelta: 300,
          },
          {
            date: '2026-11-11',
            totalCount: 1,
            createdCount: 0,
            updatedCount: 1,
            docCount: 1,
            mindmapCount: 0,
            charDelta: 50,
          },
          {
            date: '2026-11-14',
            totalCount: 4,
            createdCount: 3,
            updatedCount: 1,
            docCount: 3,
            mindmapCount: 1,
            charDelta: 800,
          },
          {
            date: '2026-11-15',
            totalCount: 1,
            createdCount: 1,
            updatedCount: 0,
            docCount: 1,
            mindmapCount: 0,
            charDelta: 120,
          },
        ],
      },
      '2026-11-16',
    );

    expect(grid.cells).toHaveLength(7);
    expect(grid.cells.find((cell) => cell.date === '2026-11-14')?.level).toBe(
      3,
    );
    expect(grid.cells.find((cell) => cell.date === '2026-11-16')?.isToday).toBe(
      true,
    );
    expect(grid.metrics).toEqual({
      totalWrites: 8,
      createdWrites: 6,
      updatedWrites: 2,
      activeDays: 4,
      currentStreak: 2,
      bestStreak: 2,
    });
  });

  it('maps scope tabs to backend query filters', () => {
    expect(heatmapFiltersForScope('all')).toEqual({});
    expect(heatmapFiltersForScope('doc')).toEqual({ kindFilter: 'doc' });
    expect(heatmapFiltersForScope('mindmap')).toEqual({
      kindFilter: 'mindmap',
    });
    expect(heatmapFiltersForScope('manual')).toEqual({
      originFilter: 'manual',
    });
  });
});
