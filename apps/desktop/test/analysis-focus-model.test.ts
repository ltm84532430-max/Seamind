import { describe, expect, it } from 'vitest';
import {
  clampFocusRatio,
  collectAnalysisCharts,
} from '../src/terminal/analysis-focus-model';
import type { CodeLabCell } from '../src/terminal/terminal-codelab-model';

function cell(
  id: string,
  groupId: string,
  outputs: CodeLabCell['outputs'],
  source = 'plot()',
): CodeLabCell {
  return {
    id,
    groupId,
    kind: 'code',
    language: 'python',
    source,
    lastExecutedSource: 'plot()',
    stdinInput: '',
    executionCount: 1,
    status: 'success',
    outputs,
  };
}

describe('analysis focus model', () => {
  it('collects only the focused block charts in cell and output order', () => {
    const cells = [
      cell('a', 'one', [
        { kind: 'text', text: 'ready' },
        { kind: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
        { kind: 'image/svg+xml', svg: '<svg />' },
      ]),
      cell('b', 'other', [{ kind: 'image/png', dataUrl: 'hidden' }]),
      cell('c', 'one', [{ kind: 'image/png', dataUrl: 'second' }], 'edited'),
    ];

    expect(collectAnalysisCharts(cells, 'one')).toEqual([
      expect.objectContaining({ id: 'a:1', cellNumber: 1, stale: false }),
      expect.objectContaining({
        id: 'a:2',
        cellNumber: 1,
        kind: 'image/svg+xml',
      }),
      expect.objectContaining({ id: 'c:0', cellNumber: 3, stale: true }),
    ]);
    expect(collectAnalysisCharts(cells, 'missing')).toEqual([]);
  });

  it('keeps splitter ratios inside their allowed range', () => {
    expect(clampFocusRatio(12, 35, 75)).toBe(35);
    expect(clampFocusRatio(60, 35, 75)).toBe(60);
    expect(clampFocusRatio(90, 35, 75)).toBe(75);
    expect(clampFocusRatio(Number.NaN, 35, 75)).toBe(35);
  });
});
