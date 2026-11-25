import type { TerminalCodeLabLanguage } from './terminal-types';
import type { PythonVarSummary } from './terminal-api';

export type CodeLabCellKind = 'code' | 'markdown';

export interface CodeLabSourceOrigin {
  kind: 'epub' | 'pdf' | 'mindmap';
  title: string;
  locator: string;
  reference: string;
}

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
  lastExecutedSource?: string;
  origin?: CodeLabSourceOrigin;
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
          seamindOrigin: cell.origin,
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
      metadata?: {
        language?: string;
        stdin?: string;
        seamindOrigin?: CodeLabSourceOrigin;
      };
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
      origin: rawCell.metadata?.seamindOrigin,
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
    if (cell.origin) {
      parts.push(
        `来源：${cell.origin.title} · ${cell.origin.locator}\n\`${cell.origin.reference}\``,
      );
    }
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

/* ==========================================================================
   Code Lab Persistent Collection Library & Script Assembler
   ========================================================================== */

export interface CodeLabSavedFile {
  id: string;
  title: string;
  folder: string;
  language: TerminalCodeLabLanguage;
  cells: CodeLabCell[];
  prologueSource?: string;
  tags: string[];
  starred: boolean;
  updatedAt: number;
}

export interface CodeLabSnippetItem {
  id: string;
  title: string;
  language: TerminalCodeLabLanguage;
  category: string;
  description: string;
  code: string;
}

export const CODELAB_COLLECTION_STORAGE_KEY =
  'seamind:codelab-collection-files:v1';
export const CODELAB_SNIPPETS_STORAGE_KEY =
  'seamind:codelab-collection-snippets:v1';
export const CODELAB_COLLECTION_EVENT = 'seamind:codelab-collection-changed';
export const CODELAB_SYNC_VIEW_EVENT = 'seamind:codelab-sync-view';

export interface CodeLabSyncViewPayload {
  sourceTabId: string;
  fileId: string;
  title: string;
  folder: string;
  language: TerminalCodeLabLanguage;
  starred: boolean;
  cells: CodeLabCell[];
  prologueSource: string;
  variables?: PythonVarSummary[];
  dirty: boolean;
  revision: number | null;
}

export function formatCellStudyExportMarkdown(
  docTitle: string,
  cell: CodeLabCell,
  cellIndex: number,
): string {
  const heading = `## ${docTitle.trim() || '代码实验'} · 单元格 #${cellIndex + 1}`;
  const parts: string[] = [heading];
  if (cell.origin) {
    const kindLabel =
      cell.origin.kind === 'epub'
        ? 'EPUB'
        : cell.origin.kind === 'pdf'
          ? 'PDF'
          : '思维导图';
    const detail = [cell.origin.title, cell.origin.locator]
      .filter(Boolean)
      .join(' · ');
    parts.push(
      `> 来源（${kindLabel}）：${detail}${cell.origin.reference ? ` (\`${cell.origin.reference}\`)` : ''}`,
    );
  }
  if (cell.kind === 'markdown') {
    if (cell.source.trim()) {
      parts.push(cell.source.trim());
    }
    return parts.join('\n\n');
  }
  const langTag =
    cell.language === 'cpp' ? 'cpp' : cell.language === 'c' ? 'c' : 'python';
  parts.push(`\`\`\`${langTag}\n${cell.source.trimEnd()}\n\`\`\``);
  for (const out of cell.outputs) {
    if (out.kind === 'stream' && out.text.trim()) {
      parts.push(`\`\`\`text\n${out.text.trimEnd()}\n\`\`\``);
    } else if (out.kind === 'text' && out.text.trim()) {
      parts.push(`> 输出：\`${out.text.trim().slice(0, 600)}\``);
    } else if (out.kind === 'image/png') {
      parts.push(`![实验图表](${out.dataUrl})`);
    } else if (out.kind === 'text/latex' && out.latex.trim()) {
      parts.push(`$$\n${out.latex.replace(/^\$+|\$+$/g, '').trim()}\n$$`);
    } else if (out.kind === 'error' && out.message.trim()) {
      parts.push(`\`\`\`text\n[Error]\n${out.message.trimEnd()}\n\`\`\``);
    }
  }
  return parts.join('\n\n');
}

export const DEFAULT_CODELAB_FOLDERS: readonly string[] = [
  '书籍伴读验证',
  '算法与数据结构',
  '系统与网络实验',
  '未归类代码',
];

export const DEFAULT_CODELAB_SNIPPETS: readonly CodeLabSnippetItem[] = [
  {
    id: 'snip-py-math-table',
    title: '数值梯度与误差收敛表',
    language: 'python',
    category: '书籍伴读验证',
    description: '中心差分求导与解析导数误差对比（无需第三方库）',
    code: `import math

def f(x):
    return math.sin(x) * math.exp(-0.2 * x)

def df_exact(x):
    return math.exp(-0.2 * x) * (math.cos(x) - 0.2 * math.sin(x))

x0 = 1.0
for k in range(1, 6):
    h = 10 ** (-k)
    approx = (f(x0 + h) - f(x0 - h)) / (2 * h)
    err = abs(approx - df_exact(x0))
    print(f"h=1e-{k} | 差分={approx:.8f} | 误差={err:.2e}")`,
  },
  {
    id: 'snip-py-svg-curve',
    title: '零依赖 SVG 函数曲线绘制',
    language: 'python',
    category: '书籍伴读验证',
    description: '直接生成高对比度 SVG 曲线并在实验本内联渲染',
    code: `import math

pts = []
for i in range(121):
    x = i / 20.0
    y = math.sin(x) * math.cos(0.5 * x)
    px = 20 + i * 3.5
    py = 90 - y * 65
    pts.append(f"{px:.1f},{py:.1f}")

svg = f"""<svg viewBox="0 0 460 180" width="460" height="180" xmlns="http://www.w3.org/2000/svg">
  <rect width="460" height="180" fill="#0d131a" rx="4"/>
  <line x1="20" y1="90" x2="440" y2="90" stroke="#334155" stroke-dasharray="3 3"/>
  <polyline fill="none" stroke="#d97757" stroke-width="2.2" points="{' '.join(pts)}"/>
</svg>"""
svg`,
  },
  {
    id: 'snip-c-bit-inspect',
    title: 'C 语言 IEEE754 浮点位模式探针',
    language: 'c',
    category: '系统与网络实验',
    description: '按位拆解 float 的符号位、阶码与尾数（CSAPP 伴读）',
    code: `union FloatBits {
    float f;
    unsigned int u;
} fb;
fb.f = 15213.0f;
unsigned int sign = (fb.u >> 31) & 1;
unsigned int exp  = (fb.u >> 23) & 0xFF;
unsigned int frac = fb.u & 0x7FFFFF;
printf("value=%.2f | hex=0x%08X | sign=%u exp=%u (unbiased=%d) frac=0x%06X\\n",
       fb.f, fb.u, sign, exp, (int)exp - 127, frac);`,
  },
  {
    id: 'snip-cpp-dijkstra',
    title: 'C++ 优先队列最短路验证模板',
    language: 'cpp',
    category: '算法与数据结构',
    description: '使用 STL vector 与简易松弛验证图的最短路径',
    code: `const int INF = 1e9;
vector<vector<pair<int, int>>> adj = {
    {{1, 4}, {2, 1}},
    {{3, 1}},
    {{1, 2}, {3, 5}},
    {}
};
vector<int> dist(4, INF);
dist[0] = 0;
for (int step = 0; step < 4; ++step) {
    for (int u = 0; u < 4; ++u) {
        if (dist[u] == INF) continue;
        for (auto [v, w] : adj[u]) dist[v] = min(dist[v], dist[u] + w);
    }
}
for (int i = 0; i < 4; ++i) cout << "0 -> " << i << " shortest = " << dist[i] << endl;`,
  },
];

export function createDefaultCodeLabCollection(): CodeLabSavedFile[] {
  return [
    {
      id: 'codelab-default-py-companion',
      title: '圆面积与微积分收敛实验.ipynb',
      folder: '书籍伴读验证',
      language: 'python',
      cells: createStarterCodeLabCells('python'),
      tags: ['Python', '伴读', '数学'],
      starred: true,
      updatedAt: 1731920000000,
    },
    {
      id: 'codelab-default-c-memory',
      title: 'CSAPP 整数平方和与位探针.c',
      folder: '系统与网络实验',
      language: 'c',
      cells: createStarterCodeLabCells('c'),
      prologueSource: DEFAULT_C_PROLOGUE,
      tags: ['C', 'CSAPP', '系统'],
      starred: true,
      updatedAt: 1731910000000,
    },
    {
      id: 'codelab-default-cpp-stl',
      title: 'STL 排序与区间检索实验.cpp',
      folder: '算法与数据结构',
      language: 'cpp',
      cells: createStarterCodeLabCells('cpp'),
      prologueSource: DEFAULT_CPP_PROLOGUE,
      tags: ['C++', 'STL', '算法'],
      starred: false,
      updatedAt: 1731900000000,
    },
  ];
}

export function loadCodeLabCollection(): CodeLabSavedFile[] {
  if (typeof localStorage === 'undefined') {
    return createDefaultCodeLabCollection();
  }
  try {
    const raw = localStorage.getItem(CODELAB_COLLECTION_STORAGE_KEY);
    if (!raw) {
      const defaults = createDefaultCodeLabCollection();
      localStorage.setItem(
        CODELAB_COLLECTION_STORAGE_KEY,
        JSON.stringify(defaults),
      );
      return defaults;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return createDefaultCodeLabCollection();
    }
    return parsed as CodeLabSavedFile[];
  } catch {
    return createDefaultCodeLabCollection();
  }
}

export function saveCodeLabCollection(files: CodeLabSavedFile[]): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const lightweight = files.map((file) => ({
      ...file,
      cells: stripHeavyOutputsForStorage(file.cells),
    }));
    localStorage.setItem(
      CODELAB_COLLECTION_STORAGE_KEY,
      JSON.stringify(lightweight),
    );
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CODELAB_COLLECTION_EVENT));
    }
    return true;
  } catch {
    return false;
  }
}

export interface OutputDisplaySlice {
  previewText: string;
  truncated: boolean;
  totalLines: number;
  totalChars: number;
  hiddenLines: number;
}

const DEFAULT_OUTPUT_MAX_LINES = 240;
const DEFAULT_OUTPUT_MAX_CHARS = 24_000;
const STORAGE_MAX_TEXT_OUTPUT_CHARS = 8_000;
const STORAGE_MAX_MEDIA_CHARS = 16_000;

/**
 * Prevents massive stdout/stderr dumps from freezing the WebView DOM layout.
 * Keeps head + tail slices so both initial context and trailing summaries stay visible.
 */
export function truncateOutputForDisplay(
  text: string,
  maxLines = DEFAULT_OUTPUT_MAX_LINES,
  maxChars = DEFAULT_OUTPUT_MAX_CHARS,
): OutputDisplaySlice {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const totalLines = lines.length;
  const totalChars = normalized.length;

  if (totalLines <= maxLines && totalChars <= maxChars) {
    return {
      previewText: normalized,
      truncated: false,
      totalLines,
      totalChars,
      hiddenLines: 0,
    };
  }

  if (totalLines > maxLines) {
    const headCount = Math.max(1, Math.floor(maxLines * 0.62));
    const tailCount = Math.max(1, maxLines - headCount);
    const hiddenLines = Math.max(0, totalLines - headCount - tailCount);
    let preview = [
      ...lines.slice(0, headCount),
      `\n… 已折叠中间 ${hiddenLines} 行输出（共 ${totalLines} 行）…\n`,
      ...lines.slice(totalLines - tailCount),
    ].join('\n');
    if (preview.length > maxChars) {
      const half = Math.max(200, Math.floor(maxChars / 2));
      preview = `${preview.slice(0, half)}\n… 输出过长已截断（共 ${totalChars.toLocaleString()} 字符）…\n${preview.slice(-half)}`;
    }
    return {
      previewText: preview,
      truncated: true,
      totalLines,
      totalChars,
      hiddenLines,
    };
  }

  const headChars = Math.max(200, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(200, maxChars - headChars);
  return {
    previewText: `${normalized.slice(0, headChars)}\n… 已折叠中间输出（共 ${totalChars.toLocaleString()} 字符）…\n${normalized.slice(-tailChars)}`,
    truncated: true,
    totalLines,
    totalChars,
    hiddenLines: 0,
  };
}

/**
 * Strips heavy binary/image/HTML outputs before synchronous localStorage writes
 * to avoid main-thread JSON.stringify jank and quota overflow while preserving code.
 */
export function stripHeavyOutputsForStorage(
  cells: readonly CodeLabCell[],
): CodeLabCell[] {
  return cells.map((cell) => {
    if (cell.outputs.length === 0) return cell;
    const slimOutputs: CodeLabOutputItem[] = [];
    for (const out of cell.outputs) {
      if (out.kind === 'image/png') {
        if (out.dataUrl.length <= STORAGE_MAX_MEDIA_CHARS) {
          slimOutputs.push(out);
        } else {
          slimOutputs.push({
            kind: 'text',
            text: '[图表输出已省略持久化 · 重新运行此格即可生成]',
          });
        }
      } else if (out.kind === 'image/svg+xml') {
        if (out.svg.length <= STORAGE_MAX_MEDIA_CHARS) {
          slimOutputs.push(out);
        } else {
          slimOutputs.push({
            kind: 'text',
            text: '[大型 SVG 输出已省略持久化 · 重新运行此格即可生成]',
          });
        }
      } else if (out.kind === 'text/html') {
        if (out.html.length <= STORAGE_MAX_MEDIA_CHARS) {
          slimOutputs.push(out);
        } else {
          slimOutputs.push({
            kind: 'text',
            text: '[大型 HTML 表格输出已省略持久化 · 重新运行此格即可生成]',
          });
        }
      } else if (out.kind === 'stream') {
        slimOutputs.push(
          out.text.length > STORAGE_MAX_TEXT_OUTPUT_CHARS
            ? {
                ...out,
                text: `${out.text.slice(0, STORAGE_MAX_TEXT_OUTPUT_CHARS)}\n… [持久化已截断]`,
              }
            : out,
        );
      } else if (out.kind === 'text') {
        slimOutputs.push(
          out.text.length > STORAGE_MAX_TEXT_OUTPUT_CHARS
            ? {
                ...out,
                text: `${out.text.slice(0, STORAGE_MAX_TEXT_OUTPUT_CHARS)}\n… [持久化已截断]`,
              }
            : out,
        );
      } else {
        slimOutputs.push(out);
      }
    }
    return { ...cell, outputs: slimOutputs };
  });
}

export function moveCodeLabCell(
  cells: readonly CodeLabCell[],
  cellId: string,
  direction: 'up' | 'down',
): CodeLabCell[] {
  const index = cells.findIndex((c) => c.id === cellId);
  if (index < 0) return [...cells];
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= cells.length) return [...cells];
  const next = [...cells];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

export function duplicateCodeLabCell(
  cells: readonly CodeLabCell[],
  cellId: string,
): { cells: CodeLabCell[]; duplicatedCellId: string | null } {
  const index = cells.findIndex((c) => c.id === cellId);
  if (index < 0) return { cells: [...cells], duplicatedCellId: null };
  const target = cells[index];
  const clone: CodeLabCell = {
    ...target,
    id: makeCodeLabCellId(),
    outputs: target.outputs.map((out) => ({ ...out })),
    origin: target.origin ? { ...target.origin } : undefined,
  };
  const next = [...cells.slice(0, index + 1), clone, ...cells.slice(index + 1)];
  return { cells: next, duplicatedCellId: clone.id };
}

export function duplicateCodeLabFile(
  source: Omit<CodeLabSavedFile, 'updatedAt'> & { updatedAt?: number },
): CodeLabSavedFile {
  const ext =
    source.language === 'cpp'
      ? '.cpp'
      : source.language === 'c'
        ? '.c'
        : '.ipynb';
  const baseTitle = source.title
    .trim()
    .replace(/(\.ipynb|\.cpp|\.c)$/i, '')
    .trim();
  const copyTitle = `${baseTitle || '未命名实验'} 副本${ext}`;
  const copyId = `codelab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const clonedCells = source.cells.map((cell) => ({
    ...cell,
    id: makeCodeLabCellId(),
    outputs: cell.outputs.map((out) => ({ ...out })),
    origin: cell.origin ? { ...cell.origin } : undefined,
  }));
  const list = upsertCodeLabFile({
    id: copyId,
    title: copyTitle,
    folder: source.folder || '未归类代码',
    language: source.language,
    cells: clonedCells,
    prologueSource: source.prologueSource,
    tags: [...source.tags],
    starred: false,
  });
  return (
    list.find((item) => item.id === copyId) ?? {
      id: copyId,
      title: copyTitle,
      folder: source.folder || '未归类代码',
      language: source.language,
      cells: clonedCells,
      prologueSource: source.prologueSource,
      tags: [...source.tags],
      starred: false,
      updatedAt: Date.now(),
    }
  );
}

export function formatDurationCompact(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(1);
  return `${mins}m ${secs}s`;
}

export function upsertCodeLabFile(
  input: Omit<CodeLabSavedFile, 'updatedAt'> & { updatedAt?: number },
  expectedUpdatedAt?: number | null,
): CodeLabSavedFile[] {
  const current = loadCodeLabCollection();
  const nextItem: CodeLabSavedFile = {
    ...input,
    title: input.title.trim() || '未命名代码实验',
    folder: input.folder.trim() || '未归类代码',
    updatedAt: input.updatedAt ?? Date.now(),
  };
  const existsIdx = current.findIndex((item) => item.id === nextItem.id);
  if (
    existsIdx >= 0 &&
    expectedUpdatedAt !== undefined &&
    current[existsIdx].updatedAt !== expectedUpdatedAt
  ) {
    throw new Error('CODELAB_REVISION_CONFLICT');
  }
  const next =
    existsIdx >= 0
      ? current.map((item, idx) => (idx === existsIdx ? nextItem : item))
      : [nextItem, ...current];
  if (!saveCodeLabCollection(next)) {
    throw new Error('CODELAB_SAVE_FAILED');
  }
  return next;
}

export function deleteCodeLabFile(fileId: string): CodeLabSavedFile[] {
  const current = loadCodeLabCollection();
  const next = current.filter((item) => item.id !== fileId);
  saveCodeLabCollection(next);
  return next;
}

export function toggleStarCodeLabFile(fileId: string): CodeLabSavedFile[] {
  const current = loadCodeLabCollection();
  const next = current.map((item) =>
    item.id === fileId ? { ...item, starred: !item.starred } : item,
  );
  saveCodeLabCollection(next);
  return next;
}

export function groupCodeLabFilesByFolder(
  files: readonly CodeLabSavedFile[],
  query: string,
  filter: 'all' | TerminalCodeLabLanguage | 'starred' = 'all',
): Array<{ folder: string; items: CodeLabSavedFile[] }> {
  const cleanQuery = query.trim().toLowerCase();
  const filtered = files.filter((file) => {
    if (filter === 'starred' && !file.starred) return false;
    if (
      (filter === 'python' || filter === 'c' || filter === 'cpp') &&
      file.language !== filter
    ) {
      return false;
    }
    if (!cleanQuery) return true;
    const inTitle = file.title.toLowerCase().includes(cleanQuery);
    const inFolder = file.folder.toLowerCase().includes(cleanQuery);
    const inTags = file.tags.some((t) => t.toLowerCase().includes(cleanQuery));
    const inSource = file.cells.some((c) =>
      c.source.toLowerCase().includes(cleanQuery),
    );
    return inTitle || inFolder || inTags || inSource;
  });

  const folderMap = new Map<string, CodeLabSavedFile[]>();
  for (const folder of DEFAULT_CODELAB_FOLDERS) {
    folderMap.set(folder, []);
  }
  for (const item of filtered) {
    const folder = item.folder.trim() || '未归类代码';
    const bucket = folderMap.get(folder) ?? [];
    bucket.push(item);
    folderMap.set(folder, bucket);
  }

  const groups: Array<{ folder: string; items: CodeLabSavedFile[] }> = [];
  for (const [folder, items] of folderMap.entries()) {
    if (items.length === 0 && cleanQuery) continue;
    items.sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    groups.push({ folder, items });
  }
  return groups;
}

/**
 * Assembles all cells of a notebook into a single executable source script (.py / .c / .cpp)
 * for the "完整源码视图 (Script)" mode.
 */
export function assembleFullScriptSource(
  cells: readonly CodeLabCell[],
  language: TerminalCodeLabLanguage,
  prologueSource?: string,
): string {
  const commentPrefix = language === 'python' ? '# ' : '// ';
  const codeSegments: string[] = [];

  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    const trimmed = cell.source.trim();
    if (!trimmed) continue;
    if (cell.kind === 'markdown') {
      const commented = trimmed
        .split(/\r?\n/)
        .map((line) => `${commentPrefix}${line}`)
        .join('\n');
      codeSegments.push(
        `${commentPrefix}--- [笔记 #${i + 1}] ---\n${commented}`,
      );
    } else {
      codeSegments.push(
        `${commentPrefix}--- [代码格 #${i + 1}] ---\n${trimmed}`,
      );
    }
  }

  const combinedBody = codeSegments.join('\n\n');
  if (language === 'python') {
    return combinedBody || '# 空 Python 实验脚本\n';
  }
  return assembleCCellProgram(
    prologueSource ??
      (language === 'cpp' ? DEFAULT_CPP_PROLOGUE : DEFAULT_C_PROLOGUE),
    combinedBody,
    language === 'cpp',
  );
}
