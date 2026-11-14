import { describe, expect, it } from 'vitest';
import {
  buildExamGalaxyGraph,
  EXAM_ROOT_ID,
  layoutExamGraph,
} from '../src/exams/exam-graph-model';
import type { EpubExamSummary } from '../src/exams/epub-exams';
import type { ExamReviewSchedule } from '../src/exams/review-schedule';

function makeSummary(
  id: string,
  bookKey: string,
  bookTitle: string,
  sectionIdx: number,
): EpubExamSummary {
  return {
    id,
    bookKey,
    bookTitle,
    sourceSectionIndex: sectionIdx,
    sourceSectionLabel: `第 ${sectionIdx + 1} 章`,
    questionCount: 10,
    createdAt: 1000 + sectionIdx,
    status: 'submitted',
    masteredCount: 5,
    partialCount: 3,
    reviewCount: 2,
    attemptsCount: 1,
    lastCompletedAt: 2000 + sectionIdx,
  };
}

function makeSchedule(
  urgency: ExamReviewSchedule['urgency'],
): ExamReviewSchedule {
  return {
    urgency,
    dueAt: urgency === 'notStarted' ? null : 3000,
    daysUntil: urgency === 'overdue' ? -2 : urgency === 'today' ? 0 : 4,
    intervalDays: 3,
    completedRounds: 1,
    accuracy: 0.7,
    needReviewCount: urgency === 'overdue' ? 2 : 0,
  };
}

describe('exam graph layout', () => {
  it('keeps node identity and order stable across concentric rings', () => {
    const ids = Array.from({ length: 23 }, (_, index) => `exam-${index}`);
    const layout = layoutExamGraph(ids);
    expect(layout.nodes.map((node) => node.id)).toEqual(ids);
    expect(layout.nodes.filter((node) => node.ring === 1)).toHaveLength(8);
    expect(layout.nodes.filter((node) => node.ring === 2)).toHaveLength(14);
    expect(layout.nodes[0]).toMatchObject({ x: 0, y: -230, order: 1 });
    expect(layoutExamGraph(ids)).toEqual(layout);
  });

  it('keeps 160 by 68 pixel node cards apart from each other and the book', () => {
    const nodes = layoutExamGraph(
      Array.from({ length: 50 }, (_, index) => `exam-${index}`),
    ).nodes;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      expect(Math.abs(node.x) >= 170 || Math.abs(node.y) >= 92).toBe(true);
      for (const other of nodes.slice(index + 1)) {
        expect(
          Math.abs(node.x - other.x) >= 160 || Math.abs(node.y - other.y) >= 68,
        ).toBe(true);
      }
    }
  });
});

describe('buildExamGalaxyGraph', () => {
  it('builds single-book galaxy with urgency clusters, sequence arcs, and a single focus node', () => {
    const items = [
      {
        exam: makeSummary('e1', 'book-a', '算法导论', 0),
        schedule: makeSchedule('overdue'),
      },
      {
        exam: makeSummary('e2', 'book-a', '算法导论', 1),
        schedule: makeSchedule('today'),
      },
      {
        exam: makeSummary('e3', 'book-a', '算法导论', 2),
        schedule: makeSchedule('later'),
      },
    ];
    const graph = buildExamGalaxyGraph(items, {
      mode: 'book',
      bookKey: 'book-a',
      bookTitle: '算法导论',
      selectedId: 'e2',
    });

    const sun = graph.nodes.find((n) => n.id === EXAM_ROOT_ID);
    expect(sun?.kind).toBe('sun');
    expect(sun?.label).toBe('算法导论');
    const clusters = graph.nodes.filter((n) => n.kind === 'cluster');
    expect(clusters).toHaveLength(2); // due + steady
    const focused = graph.nodes.filter((n) => n.isFocus);
    expect(focused.map((n) => n.id)).toEqual(['e2']);
    expect(
      graph.links.some(
        (l) => l.kind === 'sequence' && l.source === 'e1' && l.target === 'e2',
      ),
    ).toBe(true);
  });

  it('builds multi-book library galaxy grouped by bookKey', () => {
    const items = [
      {
        exam: makeSummary('e1', 'book-a', '离散数学', 0),
        schedule: makeSchedule('overdue'),
      },
      {
        exam: makeSummary('e2', 'book-b', '操作系统', 0),
        schedule: makeSchedule('upcoming'),
      },
      {
        exam: makeSummary('e3', 'book-b', '操作系统', 1),
        schedule: makeSchedule('later'),
      },
    ];
    const graph = buildExamGalaxyGraph(items, {
      mode: 'library',
      selectedId: null,
    });

    const clusters = graph.nodes.filter((n) => n.kind === 'cluster');
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.bookKey).sort()).toEqual(['book-a', 'book-b']);
    // Falls back cleanly to a single urgent exam focus when selectedId is null
    const focused = graph.nodes.filter((n) => n.isFocus);
    expect(focused).toHaveLength(1);
    expect(focused[0]?.id).toBe('e1');
  });
});
