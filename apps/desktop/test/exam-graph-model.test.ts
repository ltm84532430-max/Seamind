import { describe, expect, it } from 'vitest';
import { layoutExamGraph } from '../src/exams/exam-graph-model';

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
