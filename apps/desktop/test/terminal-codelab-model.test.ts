import { describe, expect, it } from 'vitest';
import {
  assembleCCellProgram,
  exportCodeLabToMarkdown,
  formatDurationCompact,
  hasCMainFunction,
  moveCodeLabCell,
  parseIpynbJson,
  serializeIpynbJson,
  stripHeavyOutputsForStorage,
  truncateOutputForDisplay,
  type CodeLabCell,
} from '../src/terminal/terminal-codelab-model';

describe('terminal code lab model', () => {
  it('detects C main function while ignoring comments and strings', () => {
    expect(hasCMainFunction('printf("int main()");\nint x = 1;')).toBe(false);
    expect(hasCMainFunction('// int main() {}\nreturn 0;')).toBe(false);
    expect(
      hasCMainFunction('int main(int argc, char** argv) { return 0; }'),
    ).toBe(true);
    expect(hasCMainFunction('void main(void) { }')).toBe(true);
  });

  it('merges shared C/C++ prologue headers and auto-wraps snippet cells in main', () => {
    const prologue = `#include <stdio.h>\n#include <math.h>\nint add(int a, int b) { return a + b; }`;
    const cell = `#include <stdio.h>\nint r = add(2, 3);\nprintf("%d\\n", r);`;
    const assembled = assembleCCellProgram(prologue, cell, false);

    // Deduplicated <stdio.h>
    expect(assembled.match(/#include <stdio\.h>/g)?.length).toBe(1);
    expect(assembled).toContain('int add(int a, int b)');
    expect(assembled).toContain('int main(void) {');
    expect(assembled).toContain('return 0;');

    const fullMainCell = `int main() { cout << "ok"; return 0; }`;
    const cppAssembled = assembleCCellProgram('', fullMainCell, true);
    expect(cppAssembled).toContain('#include <iostream>');
    expect(cppAssembled).not.toContain('int main(void) {');
  });

  it('round-trips standard .ipynb notebooks and exports Markdown notes', () => {
    const cells: CodeLabCell[] = [
      {
        id: 'c1',
        kind: 'markdown',
        language: 'python',
        source: '## 算法实验',
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      },
      {
        id: 'c2',
        kind: 'code',
        language: 'python',
        source: 'x = 2 + 3\nprint(x)',
        stdinInput: '',
        executionCount: 1,
        status: 'success',
        outputs: [
          { kind: 'stream', name: 'stdout', text: '5\n' },
          { kind: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
          { kind: 'text/latex', latex: '$$E = mc^2$$' },
        ],
      },
    ];

    const ipynb = serializeIpynbJson(cells, 'python', '测试实验本');
    const restored = parseIpynbJson(ipynb);
    expect(restored.title).toBe('测试实验本');
    expect(restored.language).toBe('python');
    expect(restored.cells.length).toBe(2);
    expect(restored.cells[1].outputs.map((o) => o.kind)).toEqual([
      'stream',
      'image/png',
      'text/latex',
    ]);

    const md = exportCodeLabToMarkdown('测试实验本', 'python', cells);
    expect(md).toContain('# 测试实验本');
    expect(md).toContain('```python');
    expect(md).toContain('E = mc^2');
  });

  it('truncates long stdout/stderr output while keeping head and tail context', () => {
    const shortSlice = truncateOutputForDisplay('line1\nline2', 10, 500);
    expect(shortSlice.truncated).toBe(false);
    expect(shortSlice.previewText).toBe('line1\nline2');
    expect(shortSlice.hiddenLines).toBe(0);

    const manyLines = Array.from({ length: 500 }, (_, i) => `row-${i}`).join(
      '\n',
    );
    const sliced = truncateOutputForDisplay(manyLines, 20, 50_000);
    expect(sliced.truncated).toBe(true);
    expect(sliced.totalLines).toBe(500);
    expect(sliced.hiddenLines).toBe(480);
    expect(sliced.previewText).toContain('row-0');
    expect(sliced.previewText).toContain('row-499');
    expect(sliced.previewText).toContain('已折叠中间 480 行输出');

    const giantSingleLine = 'A'.repeat(1200) + 'TAIL_END';
    const charSliced = truncateOutputForDisplay(giantSingleLine, 20, 500);
    expect(charSliced.truncated).toBe(true);
    expect(charSliced.previewText).toContain('TAIL_END');
  });

  it('strips heavy media/HTML outputs and truncates oversized text before storage', () => {
    const bigPng = `data:image/png;base64,${'X'.repeat(20_000)}`;
    const bigSvg = `<svg>${'Y'.repeat(20_000)}</svg>`;
    const bigHtml = `<table>${'Z'.repeat(20_000)}</table>`;
    const bigStream = 'L'.repeat(12_000);
    const cells: CodeLabCell[] = [
      {
        id: 'heavy',
        kind: 'code',
        language: 'python',
        source: 'plot()',
        stdinInput: '',
        executionCount: 1,
        status: 'success',
        outputs: [
          { kind: 'image/png', dataUrl: bigPng },
          { kind: 'image/svg+xml', svg: bigSvg },
          { kind: 'text/html', html: bigHtml },
          { kind: 'stream', name: 'stdout', text: bigStream },
          { kind: 'text/latex', latex: 'x^2' },
        ],
      },
    ];

    const stripped = stripHeavyOutputsForStorage(cells);
    expect(stripped[0].outputs[0]).toMatchObject({ kind: 'text' });
    expect(stripped[0].outputs[1]).toMatchObject({ kind: 'text' });
    expect(stripped[0].outputs[2]).toMatchObject({ kind: 'text' });
    expect(stripped[0].outputs[3].kind).toBe('stream');
    if (stripped[0].outputs[3].kind === 'stream') {
      expect(stripped[0].outputs[3].text.length).toBeLessThan(bigStream.length);
      expect(stripped[0].outputs[3].text).toContain('持久化已截断');
    }
    expect(stripped[0].outputs[4]).toEqual({
      kind: 'text/latex',
      latex: 'x^2',
    });
  });

  it('moves cells up and down safely with boundary guards', () => {
    const makeCell = (id: string): CodeLabCell => ({
      id,
      kind: 'code',
      language: 'python',
      source: id,
      stdinInput: '',
      executionCount: null,
      status: 'idle',
      outputs: [],
    });
    const list = [makeCell('a'), makeCell('b'), makeCell('c')];

    expect(moveCodeLabCell(list, 'a', 'up').map((c) => c.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(moveCodeLabCell(list, 'c', 'down').map((c) => c.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(moveCodeLabCell(list, 'b', 'up').map((c) => c.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(moveCodeLabCell(list, 'b', 'down').map((c) => c.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('formats execution durations compactly across ms, s, and min ranges', () => {
    expect(formatDurationCompact(undefined)).toBe('');
    expect(formatDurationCompact(-5)).toBe('');
    expect(formatDurationCompact(42)).toBe('42 ms');
    expect(formatDurationCompact(1540)).toBe('1.54 s');
    expect(formatDurationCompact(75_500)).toBe('1m 15.5s');
  });
});
