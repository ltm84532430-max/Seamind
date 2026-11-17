import { describe, expect, it } from 'vitest';
import {
  assembleCCellProgram,
  exportCodeLabToMarkdown,
  hasCMainFunction,
  parseIpynbJson,
  serializeIpynbJson,
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
});
