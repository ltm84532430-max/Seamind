import { describe, expect, it } from 'vitest';
import {
  collectTaskDescendantIds,
  compareTasksBy,
  countPlanActiveTasks,
  extractSortedVideoIds,
} from '../src/tasks/task-list-model';

describe('task list model', () => {
  it('counts only non-archived tasks belonging to a plan', () => {
    const tasks = [
      { planId: 'p1', archivedAt: null },
      { planId: 'p1', archivedAt: 1700000000 },
      { planId: 'p2', archivedAt: null },
      { planId: null, archivedAt: null },
    ];
    expect(countPlanActiveTasks(tasks, 'p1')).toBe(1);
    expect(countPlanActiveTasks(tasks, 'p2')).toBe(1);
    expect(countPlanActiveTasks(tasks, 'missing')).toBe(0);
  });

  it('sorts tasks by priority, dueDate, updatedAt, and default position', () => {
    const a = {
      position: 2,
      createdAt: 100,
      updatedAt: 200,
      priority: 1,
      dueDate: '2026-11-15',
      title: 'A',
    };
    const b = {
      position: 1,
      createdAt: 200,
      updatedAt: 500,
      priority: 3,
      dueDate: '2026-11-10',
      title: 'B',
    };
    const c = {
      position: 0,
      createdAt: 300,
      updatedAt: 100,
      priority: 0,
      dueDate: null,
      title: 'C',
    };

    expect(
      [a, b, c]
        .sort((l, r) => compareTasksBy(l, r, 'priority'))
        .map((t) => t.title),
    ).toEqual(['B', 'A', 'C']);
    expect(
      [a, b, c]
        .sort((l, r) => compareTasksBy(l, r, 'dueDate'))
        .map((t) => t.title),
    ).toEqual(['B', 'A', 'C']);
    expect(
      [a, b, c]
        .sort((l, r) => compareTasksBy(l, r, 'updatedAt'))
        .map((t) => t.title),
    ).toEqual(['B', 'A', 'C']);
    expect(
      [a, b, c]
        .sort((l, r) => compareTasksBy(l, r, 'position'))
        .map((t) => t.title),
    ).toEqual(['C', 'B', 'A']);
  });

  it('collects all descendant task ids safely even with cycles', () => {
    const tasks = [
      { id: 't1', parentId: null },
      { id: 't2', parentId: 't1' },
      { id: 't3', parentId: 't2' },
      { id: 't4', parentId: 't3' },
      { id: 'other', parentId: null },
    ];
    expect([...collectTaskDescendantIds(tasks, 't1')].sort()).toEqual([
      't2',
      't3',
      't4',
    ]);

    const cyclic = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect([...collectTaskDescendantIds(cyclic, 'a')]).toEqual(['b']);
  });

  it('extracts sorted unique YouTube resource ids', () => {
    const key1 = extractSortedVideoIds([
      {
        resources: [
          {
            kind: 'youtube',
            resourceId: 'vid-b',
            title: 'B',
            targetKind: 'video',
            baseline: 0,
            target: 1,
            targetUnit: 'percent',
          },
          {
            kind: 'ebook',
            resourceId: 'book-1',
            title: 'Book',
            targetKind: 'progress',
            baseline: 0,
            target: 1,
            targetUnit: 'percent',
          },
        ],
      },
      {
        resources: [
          {
            kind: 'youtube',
            resourceId: 'vid-a',
            title: 'A',
            targetKind: 'video',
            baseline: 0,
            target: 1,
            targetUnit: 'percent',
          },
          {
            kind: 'youtube',
            resourceId: 'vid-b',
            title: 'B2',
            targetKind: 'video',
            baseline: 0,
            target: 1,
            targetUnit: 'percent',
          },
        ],
      },
    ]);
    expect(key1).toBe('vid-a,vid-b');
  });
});
