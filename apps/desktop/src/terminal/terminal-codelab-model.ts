import type { TerminalCodeLabLanguage } from './terminal-types';
import type { PythonVarSummary } from './terminal-api';

export type CodeLabCellKind = 'code' | 'markdown';

export type CodeLabOutputItem =
  | { kind: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'image/png'; dataUrl: string }
  | { kind: 'image/svg+xml'; svg: string }
  | { kind: 'text/html'; html: string }
  | { kind: 'text/latex'; latex: string }
  | { kind: 'error'; message: string };

export interface CodeLabCell {
  id: string;
  kind: CodeLabCellKind;
  language: TerminalCodeLabLanguage;
  source: string;
  stdinInput: string;
  executionCount: number | null;
  status: 'idle' | 'running' | 'success' | 'error';
  outputs: CodeLabOutputItem[];
  durationMs?: number;
  stage?: string;
  exitCode?: number | null;
}

export interface CodeLabVariablesState {
  variables: PythonVarSummary[];
}

export const DEFAULT_C_PROLOGUE = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>`;

export const DEFAULT_CPP_PROLOGUE = `#include <iostream>
#include <vector>
#include <string>
#include <algorithm>
using namespace std;`;

export function makeCodeLabCellId(): string {
  return `cell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createStarterCodeLabCells(
  language: TerminalCodeLabLanguage,
): CodeLabCell[] {
  if (language === 'c') {
    return [
      {
        id: makeCodeLabCellId(),
        kind: 'markdown',
        language: 'c',
        source:
          '### C 语言步进实验格\n上方可展开「共享头文件 / 辅助函数前置格」。每个代码格可独立输入测试 `stdin`，或一键发送给右侧 GDB / 终端交互运行。',
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      },
      {
        id: makeCodeLabCellId(),
        kind: 'code',
        language: 'c',
        source: `int n = 6;
int sum = 0;
for (int i = 1; i <= n; i++) {
    sum += i * i;
}
printf("平方和 (1..%d) = %d\\n", n, sum);`,
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      },
    ];
  }

  if (language === 'cpp') {
    return [
      {
        id: makeCodeLabCellId(),
        kind: 'markdown',
        language: 'cpp',
        source:
          '### C++ 交互实验本\n支持省略 `int main()` 直接写算法语句段，也可完整编写类与 STL 容器代码并通过 G++ 实时编译运行。',
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      },
      {
        id: makeCodeLabCellId(),
        kind: 'code',
        language: 'cpp',
        source: `vector<int> nums = {5, 2, 9, 1, 7};
sort(nums.begin(), nums.end());
for (int x : nums) cout << x << " ";
cout << endl;`,
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      },
    ];
  }

  return [
    {
      id: makeCodeLabCellId(),
      kind: 'markdown',
      language: 'python',
      source:
        '### Python Euporie 交互笔记本\n状态变量在格间持久化保存；按 `Shift+Enter` 运行并跳至下一格，`Esc` 切换命令模式（`j/k` 移动、`a/b` 插格、`dd` 删格）。',
      stdinInput: '',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
    {
      id: makeCodeLabCellId(),
      kind: 'code',
      language: 'python',
      source: `import math

radii = [1, 2, 3, 5]
areas = {r: round(math.pi * r * r, 3) for r in radii}
print("圆面积对照:", areas)
areas`,
      stdinInput: '',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
  ];
}

export function hasCMainFunction(source: string): boolean {
  const withoutStrings = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  return /\b(?:int|void)\s+main\s*\(/.test(withoutStrings);
}

/**
 * Safely merges a shared C/C++ prologue header + per-cell code.
 * Deduplicates `#include` directives and auto-wraps snippet-only cells in `int main(void)`.
 */
export function assembleCCellProgram(
  prologue: string,
  cellSource: string,
  isCpp: boolean,
): string {
  const defaultPrologue = isCpp ? DEFAULT_CPP_PROLOGUE : DEFAULT_C_PROLOGUE;
  const effectivePrologue = prologue.trim() || defaultPrologue;
  const cellTrimmed = cellSource.trim();
  if (!cellTrimmed) return effectivePrologue;

  const includeSeen = new Set<string>();
  const topDirectives: string[] = [];
  const prologueRest: string[] = [];

  for (const line of effectivePrologue.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('#include')) {
      if (!includeSeen.has(t)) {
        includeSeen.add(t);
        topDirectives.push(line);
      }
    } else {
      prologueRest.push(line);
    }
  }

  const cellTopDirectives: string[] = [];
  const cellBodyLines: string[] = [];
  for (const line of cellTrimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('#include')) {
      if (!includeSeen.has(t)) {
        includeSeen.add(t);
        cellTopDirectives.push(line);
      }
    } else if (
      isCpp &&
      t === 'using namespace std;' &&
      effectivePrologue.includes('using namespace std;')
    ) {
      continue;
    } else {
      cellBodyLines.push(line);
    }
  }

  const preamble = [...topDirectives, ...cellTopDirectives, ...prologueRest]
    .join('\n')
    .trim();
  const cellCleanBody = cellBodyLines.join('\n').trim();

  if (hasCMainFunction(cellCleanBody)) {
    return preamble
      ? `${preamble}\n\n${cellCleanBody}\n`
      : `${cellCleanBody}\n`;
  }

  const indentedBody = cellCleanBody
    .split('\n')
    .map((line) => (line ? `    ${line}` : ''))
    .join('\n');

  return `${preamble ? `${preamble}\n\n` : ''}int main(void) {\n${indentedBody}\n    return 0;\n}\n`;
}

export function serializeIpynbJson(
  cells: CodeLabCell[],
  language: TerminalCodeLabLanguage,
  title: string,
): string {
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      seamindTitle: title,
      kernelspec: {
        name: language === 'python' ? 'python3' : language,
        display_name:
          language === 'python'
            ? 'Python 3 (Seamind)'
            : language === 'cpp'
              ? 'C++ (GCC)'
              : 'C (GCC)',
        language,
      },
      language_info: { name: language },
    },
    cells: cells.map((cell) => {
      if (cell.kind === 'markdown') {
        return {
          cell_type: 'markdown',
          metadata: {},
          source: cell.source
            .split('\n')
            .map((l, idx, arr) => (idx < arr.length - 1 ? `${l}\n` : l)),
        };
      }
      const nbOutputs: Array<Record<string, unknown>> = [];
      for (const out of cell.outputs) {
        if (out.kind === 'stream') {
          nbOutputs.push({
            output_type: 'stream',
            name: out.name,
            text: out.text,
          });
        } else if (out.kind === 'error') {
          nbOutputs.push({
            output_type: 'error',
            ename: 'RuntimeError',
            evalue: out.message,
            traceback: [out.message],
          });
        } else if (out.kind === 'text') {
          nbOutputs.push({
            output_type: 'execute_result',
            execution_count: cell.executionCount ?? 1,
            metadata: {},
            data: { 'text/plain': out.text },
          });
        } else if (out.kind === 'image/png') {
          const base64 = out.dataUrl.replace(/^data:image\/png;base64,/, '');
          nbOutputs.push({
            output_type: 'display_data',
            metadata: {},
            data: { 'image/png': base64 },
          });
        } else if (out.kind === 'text/html') {
          nbOutputs.push({
            output_type: 'display_data',
            metadata: {},
            data: { 'text/html': out.html },
          });
        } else if (out.kind === 'image/svg+xml') {
          nbOutputs.push({
            output_type: 'display_data',
            metadata: {},
            data: { 'image/svg+xml': out.svg },
          });
        } else if (out.kind === 'text/latex') {
          nbOutputs.push({
            output_type: 'display_data',
            metadata: {},
            data: { 'text/latex': out.latex },
          });
        }
      }
      return {
        cell_type: 'code',
        execution_count: cell.executionCount,
        metadata: {
          language: cell.language,
          stdin: cell.stdinInput || undefined,
        },
        source: cell.source
          .split('\n')
          .map((l, idx, arr) => (idx < arr.length - 1 ? `${l}\n` : l)),
        outputs: nbOutputs,
      };
    }),
  };
  return JSON.stringify(nb, null, 2);
}

function joinNotebookSource(source: unknown): string {
  if (typeof source === 'string') return source;
  if (Array.isArray(source)) {
    return source.map((s) => String(s)).join('');
  }
  return '';
}

export function parseIpynbJson(rawText: string): {
  title: string;
  language: TerminalCodeLabLanguage;
  cells: CodeLabCell[];
} {
  const parsed = JSON.parse(rawText) as {
    metadata?: {
      seamindTitle?: string;
      kernelspec?: { language?: string; name?: string };
      language_info?: { name?: string };
    };
    cells?: Array<{
      cell_type?: string;
      execution_count?: number | null;
      metadata?: { language?: string; stdin?: string };
      source?: unknown;
      outputs?: Array<{
        output_type?: string;
        name?: string;
        text?: unknown;
        evalue?: string;
        traceback?: string[];
        data?: Record<string, unknown>;
      }>;
    }>;
  };

  const langHint = (
    parsed.metadata?.language_info?.name ??
    parsed.metadata?.kernelspec?.language ??
    'python'
  ).toLowerCase();
  const defaultLanguage: TerminalCodeLabLanguage =
    langHint === 'c'
      ? 'c'
      : langHint === 'cpp' || langHint === 'c++'
        ? 'cpp'
        : 'python';

  const cells: CodeLabCell[] = (parsed.cells ?? []).map((rawCell) => {
    const isMarkdown = rawCell.cell_type === 'markdown';
    const cellLangRaw = (
      rawCell.metadata?.language ?? defaultLanguage
    ).toLowerCase();
    const cellLanguage: TerminalCodeLabLanguage =
      cellLangRaw === 'c'
        ? 'c'
        : cellLangRaw === 'cpp' || cellLangRaw === 'c++'
          ? 'cpp'
          : 'python';

    const outputs: CodeLabOutputItem[] = [];
    for (const out of rawCell.outputs ?? []) {
      if (out.output_type === 'stream') {
        const text = joinNotebookSource(out.text);
        if (text) {
          outputs.push({
            kind: 'stream',
            name: out.name === 'stderr' ? 'stderr' : 'stdout',
            text,
          });
        }
      } else if (out.output_type === 'error') {
        const tb = Array.isArray(out.traceback)
          ? out.traceback.join('\n')
          : (out.evalue ?? 'Error');
        outputs.push({ kind: 'error', message: tb });
      } else if (out.data) {
        const png = out.data['image/png'];
        if (png) {
          const b64 = joinNotebookSource(png).trim();
          outputs.push({
            kind: 'image/png',
            dataUrl: b64.startsWith('data:')
              ? b64
              : `data:image/png;base64,${b64}`,
          });
        }
        const svg = out.data['image/svg+xml'];
        if (svg) {
          outputs.push({ kind: 'image/svg+xml', svg: joinNotebookSource(svg) });
        }
        const html = out.data['text/html'];
        if (html) {
          outputs.push({ kind: 'text/html', html: joinNotebookSource(html) });
        }
        const latex = out.data['text/latex'];
        if (latex) {
          outputs.push({
            kind: 'text/latex',
            latex: joinNotebookSource(latex),
          });
        }
        const plain = out.data['text/plain'];
        if (plain && !html && !svg && !png) {
          outputs.push({ kind: 'text', text: joinNotebookSource(plain) });
        }
      }
    }

    return {
      id: makeCodeLabCellId(),
      kind: isMarkdown ? 'markdown' : 'code',
      language: cellLanguage,
      source: joinNotebookSource(rawCell.source),
      stdinInput: rawCell.metadata?.stdin ?? '',
      executionCount:
        typeof rawCell.execution_count === 'number'
          ? rawCell.execution_count
          : null,
      status: outputs.some((o) => o.kind === 'error')
        ? 'error'
        : outputs.length > 0
          ? 'success'
          : 'idle',
      outputs,
    };
  });

  return {
    title: parsed.metadata?.seamindTitle?.trim() || '导入实验本',
    language: defaultLanguage,
    cells:
      cells.length > 0 ? cells : createStarterCodeLabCells(defaultLanguage),
  };
}

export function exportCodeLabToMarkdown(
  title: string,
  language: TerminalCodeLabLanguage,
  cells: CodeLabCell[],
): string {
  const parts: string[] = [`# ${title.trim() || 'Code Lab 实验笔记'}\n`];
  for (const cell of cells) {
    if (cell.kind === 'markdown') {
      if (cell.source.trim()) parts.push(cell.source.trim());
      continue;
    }
    const langTag =
      cell.language === 'cpp' ? 'cpp' : cell.language === 'c' ? 'c' : 'python';
    parts.push(`\`\`\`${langTag}\n${cell.source.trimEnd()}\n\`\`\``);
    for (const out of cell.outputs) {
      if (out.kind === 'stream' && out.text.trim()) {
        parts.push(`\`\`\`text\n${out.text.trimEnd()}\n\`\`\``);
      } else if (out.kind === 'text' && out.text.trim()) {
        parts.push(`> 输出：\`${out.text.trim().slice(0, 400)}\``);
      } else if (out.kind === 'image/png') {
        parts.push(`![实验图表](${out.dataUrl})`);
      } else if (out.kind === 'text/latex' && out.latex.trim()) {
        parts.push(`$$\n${out.latex.replace(/^\$+|\$+$/g, '').trim()}\n$$`);
      } else if (out.kind === 'error' && out.message.trim()) {
        parts.push(`\`\`\`text\n[Error]\n${out.message.trimEnd()}\n\`\`\``);
      }
    }
  }
  return parts.join('\n\n') + `\n\n<!-- language: ${language} -->\n`;
}
