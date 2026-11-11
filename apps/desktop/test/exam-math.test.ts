import { describe, expect, it } from 'vitest';
import { inlineMathError, splitInlineMath } from '../src/exams/exam-math';

describe('inline math', () => {
  it('keeps paired formulas and treats a backslash as an escape', () => {
    expect(inlineMathError('力 $F=ma$')).toBeNull();
    expect(inlineMathError('价格 \\$5 与 $x$')).toBeNull();
    expect(inlineMathError('$x\\$y$')).toBeNull();
    expect(splitInlineMath('力 $F=ma$ 结束')).toEqual([
      { kind: 'text', value: '力 ' },
      { kind: 'math', value: 'F=ma' },
      { kind: 'text', value: ' 结束' },
    ]);
    expect(splitInlineMath('价格 \\$5')).toEqual([
      { kind: 'text', value: '价格 $5' },
    ]);
    expect(splitInlineMath('$x\\$y$')).toEqual([
      { kind: 'math', value: 'x\\$y' },
    ]);
  });

  it('rejects display math, empty formulas, and an unclosed dollar', () => {
    expect(inlineMathError('$$F=ma$$')).toMatch(/\$\$/);
    expect(inlineMathError('力 $F=ma')).toMatch(/闭合/);
    expect(inlineMathError('$  $')).toMatch(/空/);
    expect(splitInlineMath('$$F=ma$$')).toEqual([
      { kind: 'text', value: '$$F=ma$$' },
    ]);
  });
});
