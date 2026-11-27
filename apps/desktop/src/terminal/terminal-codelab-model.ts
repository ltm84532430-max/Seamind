import type { TerminalCodeLabLanguage } from './terminal-types';
import type {
  DataColumnInfo,
  DataDbCustomType,
  DataDbTableSchema,
  DataScalarValue,
  PythonVarSummary,
} from './terminal-api';

export type CodeLabCellKind = 'code' | 'markdown';

export interface CodeLabSourceOrigin {
  kind: 'epub' | 'pdf' | 'mindmap';
  title: string;
  locator: string;
  reference: string;
}

export interface CodeLabTableOutput {
  kind: 'table';
  columns: DataColumnInfo[];
  rows: DataScalarValue[][];
  totalRows?: number | null;
  truncated?: boolean;
  engine?: string;
  boundVar?: string;
  message?: string;
  page?: number | null;
  pageSize?: number | null;
  hasMore?: boolean | null;
  readOnly?: boolean | null;
  exportedRows?: number | null;
}

export type CodeLabOutputItem =
  | { kind: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'image/png'; dataUrl: string }
  | { kind: 'image/svg+xml'; svg: string }
  | { kind: 'text/html'; html: string }
  | { kind: 'text/latex'; latex: string }
  | CodeLabTableOutput
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
  sqlConnectionId?: string;
  sqlResultVar?: string;
  sqlPageSize?: number;
  sqlAttachDbIds?: string[];
  groupId?: string;
  groupTitle?: string;
  groupCollapsed?: boolean;
}

export type NotebookRenderItem =
  | { kind: 'single'; cell: CodeLabCell; index: number }
  | {
      kind: 'group';
      groupId: string;
      title: string;
      collapsed: boolean;
      cells: Array<{ cell: CodeLabCell; index: number }>;
    };

export function makeAnalysisBlockId(): string {
  return `blk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function buildNotebookRenderItems(
  cells: readonly CodeLabCell[],
): NotebookRenderItem[] {
  const items: NotebookRenderItem[] = [];
  let i = 0;
  while (i < cells.length) {
    const cell = cells[i];
    const gid = cell.groupId?.trim();
    if (!gid) {
      items.push({ kind: 'single', cell, index: i });
      i += 1;
      continue;
    }
    const grouped: Array<{ cell: CodeLabCell; index: number }> = [];
    let title = cell.groupTitle?.trim() || '复合数据分析区块';
    let collapsed = Boolean(cell.groupCollapsed);
    while (i < cells.length && cells[i].groupId?.trim() === gid) {
      if (cells[i].groupTitle?.trim()) {
        title = cells[i].groupTitle!.trim();
      }
      if (cells[i].groupCollapsed) {
        collapsed = true;
      }
      grouped.push({ cell: cells[i], index: i });
      i += 1;
    }
    items.push({
      kind: 'group',
      groupId: gid,
      title,
      collapsed,
      cells: grouped,
    });
  }
  return items;
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
  if (language === 'sql') {
    return [
      {
        id: makeCodeLabCellId(),
        kind: 'code',
        language: 'sql',
        source: `-- 提示：可在左侧「数据」面板挂载 CSV / Parquet 文件或连接 SQLite / DuckDB / PostgreSQL / MySQL
SELECT 'Seamind Data Lab' AS engine, 2026 AS year, 'SQL Ready' AS status;`,
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      },
    ];
  }

  if (language === 'r') {
    return [
      {
        id: makeCodeLabCellId(),
        kind: 'code',
        language: 'r',
        source: `# R 语言统计分析与可视化示例
df <- data.frame(
  group = c("A", "B", "C", "D"),
  score = c(84.5, 91.2, 78.6, 95.0)
)
summary(df)
df`,
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      },
    ];
  }

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
            : language === 'sql'
              ? 'SQL (Data Lab)'
              : language === 'r'
                ? 'R (Seamind)'
                : language === 'cpp'
                  ? 'C++ (GCC)'
                  : 'C (GCC)',
        language,
      },
      language_info: { name: language },
    },
    cells: cells.map((cell) => {
      const seamindGroup = cell.groupId
        ? {
            id: cell.groupId,
            title: cell.groupTitle || '复合数据分析区块',
            collapsed: Boolean(cell.groupCollapsed),
          }
        : undefined;
      if (cell.kind === 'markdown') {
        return {
          cell_type: 'markdown',
          metadata: seamindGroup ? { seamindGroup } : {},
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
        } else if (out.kind === 'table') {
          nbOutputs.push({
            output_type: 'execute_result',
            execution_count: cell.executionCount ?? 1,
            metadata: {},
            data: {
              'text/plain': formatTableToMarkdown(out.columns, out.rows),
            },
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
          sqlConnectionId: cell.sqlConnectionId || undefined,
          sqlResultVar: cell.sqlResultVar || undefined,
          seamindGroup,
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
        sqlConnectionId?: string;
        sqlResultVar?: string;
        seamindGroup?: {
          id?: string;
          title?: string;
          collapsed?: boolean;
        };
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
        : langHint === 'sql'
          ? 'sql'
          : langHint === 'r'
            ? 'r'
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
          : cellLangRaw === 'sql'
            ? 'sql'
            : cellLangRaw === 'r'
              ? 'r'
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
      sqlConnectionId: rawCell.metadata?.sqlConnectionId,
      sqlResultVar: rawCell.metadata?.sqlResultVar,
      groupId: rawCell.metadata?.seamindGroup?.id,
      groupTitle: rawCell.metadata?.seamindGroup?.title,
      groupCollapsed: rawCell.metadata?.seamindGroup?.collapsed,
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
      cell.language === 'cpp'
        ? 'cpp'
        : cell.language === 'c'
          ? 'c'
          : cell.language === 'sql'
            ? 'sql'
            : cell.language === 'r'
              ? 'r'
              : 'python';
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
      } else if (out.kind === 'table') {
        parts.push(formatTableToMarkdown(out.columns, out.rows.slice(0, 30)));
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
export const CODELAB_AGENT_PUSH_EVENT = 'seamind:codelab-agent-push-cell';

export interface CodeLabAgentPushPayload {
  kind?: CodeLabCellKind;
  language: TerminalCodeLabLanguage;
  source: string;
  autoRun?: boolean;
  sqlConnectionId?: string;
  sqlResultVar?: string;
  sqlPageSize?: number;
  sqlAttachDbIds?: string[];
  groupId?: string;
  groupTitle?: string;
}

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
    cell.language === 'cpp'
      ? 'cpp'
      : cell.language === 'c'
        ? 'c'
        : cell.language === 'sql'
          ? 'sql'
          : cell.language === 'r'
            ? 'r'
            : 'python';
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
    } else if (out.kind === 'table') {
      parts.push(formatTableToMarkdown(out.columns, out.rows.slice(0, 30)));
    } else if (out.kind === 'error' && out.message.trim()) {
      parts.push(`\`\`\`text\n[Error]\n${out.message.trimEnd()}\n\`\`\``);
    }
  }
  return parts.join('\n\n');
}

export const UNCATEGORIZED_CODELAB_FOLDER = '未归类代码';
export const CODELAB_FOLDERS_STORAGE_KEY = 'seamind.codelab.folders.v1';

export const DEFAULT_CODELAB_FOLDERS: readonly string[] = [
  '书籍伴读验证',
  '算法与数据结构',
  '系统与网络实验',
  UNCATEGORIZED_CODELAB_FOLDER,
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
  {
    id: 'snip-sql-file-agg',
    title: 'SQL 分组聚合与 Top-N 检索',
    language: 'sql',
    category: '数据分析与统计',
    description: '对已挂载 CSV / Parquet 文件或数据表进行分组汇总',
    code: `-- 将表名替换为左侧「数据」面板中的文件别名或数据库表名
SELECT *
FROM dataset
LIMIT 50;`,
  },
  {
    id: 'snip-r-summary-plot',
    title: 'R 语言回归拟合与残差绘图',
    language: 'r',
    category: '数据分析与统计',
    description: '使用内置 lm() 建立线性模型并直接输出散点回归图',
    code: `set.seed(42)
x <- seq(1, 30)
y <- 2.4 * x + rnorm(30, sd = 6)
fit <- lm(y ~ x)
print(summary(fit))
plot(x, y, pch = 19, col = "#2c6e58", main = "Linear Regression Fit")
abline(fit, col = "#d97757", lwd = 2)`,
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
      } else if (out.kind === 'table') {
        slimOutputs.push({
          ...out,
          rows: out.rows.slice(0, 30),
          truncated: out.truncated || out.rows.length > 30,
        });
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
        : source.language === 'sql'
          ? '.sql'
          : source.language === 'r'
            ? '.R'
            : '.ipynb';
  const baseTitle = source.title
    .trim()
    .replace(/(\.ipynb|\.cpp|\.c|\.sql|\.r)$/i, '')
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

export function moveCodeLabFileToFolder(
  fileId: string,
  targetFolder: string,
): {
  files: CodeLabSavedFile[];
  movedFile: CodeLabSavedFile | null;
  fromFolder: string | null;
} {
  const cleanTarget = targetFolder.trim() || UNCATEGORIZED_CODELAB_FOLDER;
  const current = loadCodeLabCollection();
  const existing = current.find((item) => item.id === fileId);
  if (!existing) {
    return { files: current, movedFile: null, fromFolder: null };
  }
  const fromFolder = existing.folder.trim() || UNCATEGORIZED_CODELAB_FOLDER;
  if (fromFolder === cleanTarget) {
    return { files: current, movedFile: null, fromFolder };
  }
  const updatedFile: CodeLabSavedFile = {
    ...existing,
    folder: cleanTarget,
    updatedAt: Date.now(),
  };
  const next = current.map((item) => (item.id === fileId ? updatedFile : item));
  saveCodeLabCollection(next);
  return { files: next, movedFile: updatedFile, fromFolder };
}

function normalizeFolderList(
  folders: readonly string[],
  files: readonly CodeLabSavedFile[] = [],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (raw: string) => {
    const clean = raw.trim();
    if (!clean || clean === UNCATEGORIZED_CODELAB_FOLDER || seen.has(clean)) {
      return;
    }
    seen.add(clean);
    ordered.push(clean);
  };
  for (const folder of folders) push(folder);
  for (const file of files) {
    if (file.folder) push(file.folder);
  }
  ordered.push(UNCATEGORIZED_CODELAB_FOLDER);
  return ordered;
}

export function loadCodeLabFolders(
  files: readonly CodeLabSavedFile[] = [],
): string[] {
  if (typeof localStorage === 'undefined') {
    return normalizeFolderList(DEFAULT_CODELAB_FOLDERS, files);
  }
  try {
    const raw = localStorage.getItem(CODELAB_FOLDERS_STORAGE_KEY);
    if (!raw) {
      return normalizeFolderList(DEFAULT_CODELAB_FOLDERS, files);
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return normalizeFolderList(DEFAULT_CODELAB_FOLDERS, files);
    }
    const valid = parsed.filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    );
    return normalizeFolderList(
      valid.length > 0 ? valid : DEFAULT_CODELAB_FOLDERS,
      files,
    );
  } catch {
    return normalizeFolderList(DEFAULT_CODELAB_FOLDERS, files);
  }
}

export function saveCodeLabFolders(folders: readonly string[]): string[] {
  const normalized = normalizeFolderList(folders);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(
        CODELAB_FOLDERS_STORAGE_KEY,
        JSON.stringify(normalized),
      );
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(CODELAB_COLLECTION_EVENT));
      }
    } catch {
      // ignore storage quota errors
    }
  }
  return normalized;
}

export function createCodeLabFolder(name: string): {
  folders: string[];
  createdName: string | null;
} {
  const clean = name.trim();
  const current = loadCodeLabFolders();
  if (!clean || current.includes(clean)) {
    return { folders: current, createdName: null };
  }
  const withoutUncat = current.filter(
    (f) => f !== UNCATEGORIZED_CODELAB_FOLDER,
  );
  const next = saveCodeLabFolders([
    ...withoutUncat,
    clean,
    UNCATEGORIZED_CODELAB_FOLDER,
  ]);
  return { folders: next, createdName: clean };
}

export function renameCodeLabFolder(
  oldName: string,
  newName: string,
): {
  folders: string[];
  files: CodeLabSavedFile[];
  renamedTo: string | null;
} {
  const cleanOld = oldName.trim();
  const cleanNew = newName.trim();
  const currentFolders = loadCodeLabFolders();
  const currentFiles = loadCodeLabCollection();
  if (
    !cleanOld ||
    !cleanNew ||
    cleanOld === UNCATEGORIZED_CODELAB_FOLDER ||
    cleanOld === cleanNew ||
    currentFolders.includes(cleanNew)
  ) {
    return { folders: currentFolders, files: currentFiles, renamedTo: null };
  }
  const nextFolders = saveCodeLabFolders(
    currentFolders.map((f) => (f === cleanOld ? cleanNew : f)),
  );
  const nextFiles = currentFiles.map((file) =>
    file.folder === cleanOld ? { ...file, folder: cleanNew } : file,
  );
  saveCodeLabCollection(nextFiles);
  return { folders: nextFolders, files: nextFiles, renamedTo: cleanNew };
}

export function deleteCodeLabFolder(name: string): {
  folders: string[];
  files: CodeLabSavedFile[];
} {
  const clean = name.trim();
  const currentFolders = loadCodeLabFolders();
  const currentFiles = loadCodeLabCollection();
  if (!clean || clean === UNCATEGORIZED_CODELAB_FOLDER) {
    return { folders: currentFolders, files: currentFiles };
  }
  const nextFiles = currentFiles.map((file) =>
    file.folder === clean
      ? { ...file, folder: UNCATEGORIZED_CODELAB_FOLDER }
      : file,
  );
  saveCodeLabCollection(nextFiles);
  const nextFolders = saveCodeLabFolders(
    currentFolders.filter((f) => f !== clean),
  );
  return { folders: nextFolders, files: nextFiles };
}

export function createCodeLabSavedFile(
  language: TerminalCodeLabLanguage,
  folder?: string,
  customTitle?: string,
): {
  file: CodeLabSavedFile;
  files: CodeLabSavedFile[];
  folders: string[];
} {
  const currentFiles = loadCodeLabCollection();
  const targetFolder = folder?.trim() || UNCATEGORIZED_CODELAB_FOLDER;
  const ext =
    language === 'cpp'
      ? '.cpp'
      : language === 'c'
        ? '.c'
        : language === 'sql'
          ? '.sql'
          : language === 'r'
            ? '.R'
            : '.ipynb';
  const baseLabel =
    customTitle?.trim() ||
    (language === 'python'
      ? 'Python 笔记'
      : language === 'sql'
        ? 'SQL 笔记'
        : language === 'r'
          ? 'R 统计笔记'
          : language === 'cpp'
            ? 'C++ 实验笔记'
            : 'C 实验笔记');
  const existingTitles = new Set(currentFiles.map((f) => f.title));
  let title = baseLabel.endsWith(ext) ? baseLabel : `${baseLabel}${ext}`;
  let suffix = 2;
  while (existingTitles.has(title)) {
    const stem = baseLabel.replace(/(\.ipynb|\.cpp|\.c|\.sql|\.r)$/i, '');
    title = `${stem} ${suffix}${ext}`;
    suffix += 1;
  }

  const newId = `codelab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const cells = createStarterCodeLabCells(language);
  const files = upsertCodeLabFile({
    id: newId,
    title,
    folder: targetFolder,
    language,
    cells,
    prologueSource:
      language === 'cpp'
        ? DEFAULT_CPP_PROLOGUE
        : language === 'c'
          ? DEFAULT_C_PROLOGUE
          : undefined,
    tags: [language.toUpperCase()],
    starred: false,
  });
  const currentFolders = loadCodeLabFolders(files);
  const folders = currentFolders.includes(targetFolder)
    ? saveCodeLabFolders(currentFolders)
    : createCodeLabFolder(targetFolder).folders;
  const created =
    files.find((item) => item.id === newId) ??
    ({
      id: newId,
      title,
      folder: targetFolder,
      language,
      cells,
      tags: [language.toUpperCase()],
      starred: false,
      updatedAt: Date.now(),
    } satisfies CodeLabSavedFile);
  return { file: created, files, folders };
}

export function groupCodeLabFilesByFolder(
  files: readonly CodeLabSavedFile[],
  query: string,
  filter: 'all' | TerminalCodeLabLanguage | 'starred' = 'all',
  knownFolders?: readonly string[],
): Array<{ folder: string; items: CodeLabSavedFile[] }> {
  const cleanQuery = query.trim().toLowerCase();
  const filtered = files.filter((file) => {
    if (filter === 'starred' && !file.starred) return false;
    if (
      (filter === 'python' ||
        filter === 'sql' ||
        filter === 'r' ||
        filter === 'c' ||
        filter === 'cpp') &&
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
  const baseFolders =
    knownFolders && knownFolders.length > 0
      ? knownFolders
      : loadCodeLabFolders(files);
  for (const folder of baseFolders) {
    folderMap.set(folder, []);
  }
  for (const item of filtered) {
    const folder = item.folder.trim() || UNCATEGORIZED_CODELAB_FOLDER;
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
  const commentPrefix =
    language === 'sql'
      ? '-- '
      : language === 'python' || language === 'r'
        ? '# '
        : '// ';
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
  if (language === 'sql') {
    return combinedBody || '-- 空 SQL 查询脚本\n';
  }
  if (language === 'r') {
    return combinedBody || '# 空 R 语言分析脚本\n';
  }
  return assembleCCellProgram(
    prologueSource ??
      (language === 'cpp' ? DEFAULT_CPP_PROLOGUE : DEFAULT_C_PROLOGUE),
    combinedBody,
    language === 'cpp',
  );
}

/* ==========================================================================
   Data Lab Persistence: Mounted Files, DB Connections & Custom Env Paths
   ========================================================================== */

export interface DataLabMountedFile {
  id: string;
  alias: string;
  path: string;
  format: string;
  sizeBytes?: number;
  rowCount?: number | null;
  columns?: DataColumnInfo[];
  engine?: string;
  updatedAt: number;
}

export type DbSslMode =
  'prefer' | 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface DataLabDbConnection {
  id: string;
  name: string;
  dbType: 'sqlite' | 'duckdb' | 'postgres' | 'mysql';
  filePath?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  hasPassword?: boolean;
  pythonPath?: string;
  readOnly?: boolean;
  sslMode?: DbSslMode;
  statementTimeoutSec?: number;
  tables?: DataDbTableSchema[];
  customTypes?: DataDbCustomType[];
  lastTestedAt?: number;
  lastStatus?: string;
}

export interface DataLabCustomEnvPaths {
  pythonPaths: string[];
  rPaths: string[];
}

export interface DataLabBaseProfile {
  pythonPath: string;
  pythonLabel?: string;
  rscriptPath: string;
  rLabel?: string;
  defaultConnectionId: string;
  preferredPythonLibs: string[];
  preferredRLibs: string[];
  updatedAt: number;
}

export const DEFAULT_PYTHON_STABLE_LIBS: readonly string[] = [
  'pandas',
  'numpy',
  'pyarrow',
  'duckdb',
  'matplotlib',
  'seaborn',
  'scipy',
  'statsmodels',
  'openpyxl',
  'sqlalchemy',
];

export const DEFAULT_R_STABLE_LIBS: readonly string[] = [
  'tidyverse',
  'ggplot2',
  'data.table',
  'arrow',
  'DBI',
  'duckdb',
];

export const DATALAB_FILES_STORAGE_KEY = 'seamind:datalab-mounted-files:v1';
export const DATALAB_CONNS_STORAGE_KEY = 'seamind:datalab-db-connections:v1';
export const DATALAB_CUSTOM_ENVS_KEY = 'seamind:datalab-custom-env-paths:v1';
export const DATALAB_BASE_PROFILE_KEY = 'seamind:datalab-base-profile:v1';
export const DATALAB_STORAGE_EVENT = 'seamind:datalab-sources-changed';

export function createDefaultBaseProfile(): DataLabBaseProfile {
  return {
    pythonPath: '',
    rscriptPath: '',
    defaultConnectionId: '',
    preferredPythonLibs: [...DEFAULT_PYTHON_STABLE_LIBS],
    preferredRLibs: [...DEFAULT_R_STABLE_LIBS],
    updatedAt: 0,
  };
}

export function loadDataLabBaseProfile(): DataLabBaseProfile {
  const defaults = createDefaultBaseProfile();
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem(DATALAB_BASE_PROFILE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<DataLabBaseProfile>;
    return {
      pythonPath:
        typeof parsed.pythonPath === 'string' ? parsed.pythonPath.trim() : '',
      pythonLabel:
        typeof parsed.pythonLabel === 'string'
          ? parsed.pythonLabel.trim()
          : undefined,
      rscriptPath:
        typeof parsed.rscriptPath === 'string' ? parsed.rscriptPath.trim() : '',
      rLabel:
        typeof parsed.rLabel === 'string' ? parsed.rLabel.trim() : undefined,
      defaultConnectionId:
        typeof parsed.defaultConnectionId === 'string'
          ? parsed.defaultConnectionId.trim()
          : '',
      preferredPythonLibs:
        Array.isArray(parsed.preferredPythonLibs) &&
        parsed.preferredPythonLibs.length > 0
          ? parsed.preferredPythonLibs.filter(
              (v): v is string => typeof v === 'string' && v.trim().length > 0,
            )
          : [...DEFAULT_PYTHON_STABLE_LIBS],
      preferredRLibs:
        Array.isArray(parsed.preferredRLibs) && parsed.preferredRLibs.length > 0
          ? parsed.preferredRLibs.filter(
              (v): v is string => typeof v === 'string' && v.trim().length > 0,
            )
          : [...DEFAULT_R_STABLE_LIBS],
      updatedAt:
        typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return defaults;
  }
}

export function saveDataLabBaseProfile(profile: DataLabBaseProfile): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: DataLabBaseProfile = {
      ...profile,
      pythonPath: profile.pythonPath.trim(),
      rscriptPath: profile.rscriptPath.trim(),
      defaultConnectionId: profile.defaultConnectionId.trim(),
      updatedAt: Date.now(),
    };
    localStorage.setItem(DATALAB_BASE_PROFILE_KEY, JSON.stringify(payload));
    dispatchDataLabChanged();
  } catch {
    // ignore storage errors
  }
}

export function createEmptyAnalysisBlockCells(
  title = '新建复合分析区块',
  defaultSqlConnId?: string,
): CodeLabCell[] {
  const groupId = makeAnalysisBlockId();
  return [
    {
      id: makeCodeLabCellId(),
      kind: 'code',
      language: 'sql',
      sqlConnectionId: defaultSqlConnId || undefined,
      sqlResultVar: 'stage_data',
      groupId,
      groupTitle: title,
      source: `-- 分区 1 · SQL 抽数（结果自动写入共享总线 stage_data）\nSELECT * FROM your_table LIMIT 100;`,
      stdinInput: '',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
    {
      id: makeCodeLabCellId(),
      kind: 'code',
      language: 'python',
      groupId,
      groupTitle: title,
      source: `# 分区 2 · Python 清洗与可视化（自动激活已指定的基座虚拟环境）\nimport matplotlib.pyplot as plt\ndf = sm_load("stage_data")\ndf.head()`,
      stdinInput: '',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
  ];
}

export function createPolyglotAnalysisTemplateCells(
  title = '区域营收与利润归因分析',
): CodeLabCell[] {
  const groupId = makeAnalysisBlockId();
  return [
    {
      id: makeCodeLabCellId(),
      kind: 'code',
      language: 'sql',
      sqlResultVar: 'analysis_base',
      groupId,
      groupTitle: title,
      source: `-- 步骤 1/4 [SQL 抽数 -> 写入共享数据总线 analysis_base]
-- 可直接替换为你的挂载文件别名（见左侧「数据」面板）或默认数据库表
SELECT '华东' AS region, 'Q1' AS quarter, 128.5 AS revenue, 31.2 AS profit
UNION ALL SELECT '华东', 'Q2', 146.0, 38.5
UNION ALL SELECT '华北', 'Q1', 96.4, 21.8
UNION ALL SELECT '华北', 'Q2', 112.8, 27.4
UNION ALL SELECT '华南', 'Q1', 118.2, 29.0
UNION ALL SELECT '华南', 'Q2', 139.6, 36.1;`,
      stdinInput: '',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
    {
      id: makeCodeLabCellId(),
      kind: 'code',
      language: 'python',
      groupId,
      groupTitle: title,
      source: `# 步骤 2/4 [Python 从总线读取 -> 清洗衍生指标 -> 中文图表 -> 写回总线]
import matplotlib.pyplot as plt

df = sm_load("analysis_base")
df["margin_pct"] = (df["profit"] / df["revenue"] * 100).round(2)
sm_save("analysis_clean", df)

fig, ax = plt.subplots(figsize=(6.8, 3.8))
for reg, grp in df.groupby("region"):
    ax.plot(grp["quarter"], grp["revenue"], marker="o", linewidth=2, label=reg)
ax.set_title("各区域季度营收趋势 (Python 基座)")
ax.set_xlabel("季度")
ax.set_ylabel("营收")
ax.legend()
ax.grid(alpha=0.25)
df`,
      stdinInput: '',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
    {
      id: makeCodeLabCellId(),
      kind: 'code',
      language: 'r',
      groupId,
      groupTitle: title,
      source: `# 步骤 3/4 [R 语言从同一总线读取 Python 清洗结果 -> 统计建模与可视化]
df <- sm_load("analysis_clean")
fit <- lm(profit ~ revenue, data = df)
print(summary(fit)$coefficients)

if (requireNamespace("ggplot2", quietly = TRUE)) {
  library(ggplot2)
  ggplot(df, aes(x = revenue, y = profit, color = region)) +
    geom_point(size = 3.2) +
    geom_smooth(method = "lm", se = FALSE, linetype = "dashed") +
    labs(title = "营收与利润线性关系 (R 基座)", x = "营收", y = "利润") +
    theme_minimal()
} else {
  plot(df$revenue, df$profit, pch = 19, col = "#2563eb",
       main = "营收与利润关系 (R Base)", xlab = "营收", ylab = "利润")
  abline(fit, col = "#dc2626", lwd = 2)
}`,
      stdinInput: '',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
    {
      id: makeCodeLabCellId(),
      kind: 'markdown',
      language: 'python',
      groupId,
      groupTitle: title,
      source: `### 步骤 4/4 分析结论摘要
- **数据流转**：\`SQL (analysis_base)\` → \`Python sm_load / sm_save (analysis_clean)\` → \`R sm_load\` 全部共享同一底座与 Parquet 总线。
- **Agent 协同**：在右侧 Agent 输入 \`/data 结合 #lab 和共享表 analysis_clean 总结趋势并提出下一步假设\`，Agent 可直接调用相同基座环境继续分析。`,
      stdinInput: '',
      executionCount: null,
      status: 'idle',
      outputs: [],
    },
  ];
}

export function sanitizeDataAlias(raw: string): string {
  const cleaned = raw
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!cleaned) return 'dataset';
  return /^[0-9]/.test(cleaned) ? `t_${cleaned}` : cleaned;
}

export function formatFileSizeCompact(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatTableToCsv(
  columns: readonly DataColumnInfo[],
  rows: readonly DataScalarValue[][],
): string {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const header = columns.map((c) => escape(c.name)).join(',');
  const body = rows.map((r) => r.map(escape).join(','));
  return [header, ...body].join('\n');
}

export function formatTableToMarkdown(
  columns: readonly DataColumnInfo[],
  rows: readonly DataScalarValue[][],
): string {
  if (columns.length === 0) return '';
  const cellStr = (val: unknown): string => {
    if (val === null || val === undefined) return 'NULL';
    return String(val).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  };
  const head = `| ${columns.map((c) => cellStr(c.name)).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map(
    (r) => `| ${columns.map((_, i) => cellStr(r[i])).join(' | ')} |`,
  );
  return [head, sep, ...body].join('\n');
}

function dispatchDataLabChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DATALAB_STORAGE_EVENT));
  }
}

export function loadDataLabFiles(): DataLabMountedFile[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DATALAB_FILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DataLabMountedFile[]) : [];
  } catch {
    return [];
  }
}

export function saveDataLabFiles(files: DataLabMountedFile[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DATALAB_FILES_STORAGE_KEY, JSON.stringify(files));
    dispatchDataLabChanged();
  } catch {
    // ignore storage errors
  }
}

export function loadDataLabConnections(): DataLabDbConnection[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(DATALAB_CONNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DataLabDbConnection[]) : [];
  } catch {
    return [];
  }
}

export function saveDataLabConnections(conns: DataLabDbConnection[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DATALAB_CONNS_STORAGE_KEY, JSON.stringify(conns));
    dispatchDataLabChanged();
  } catch {
    // ignore storage errors
  }
}

export function loadCustomEnvPaths(): DataLabCustomEnvPaths {
  if (typeof localStorage === 'undefined') {
    return { pythonPaths: [], rPaths: [] };
  }
  try {
    const raw = localStorage.getItem(DATALAB_CUSTOM_ENVS_KEY);
    if (!raw) return { pythonPaths: [], rPaths: [] };
    const parsed = JSON.parse(raw) as Partial<DataLabCustomEnvPaths>;
    return {
      pythonPaths: Array.isArray(parsed.pythonPaths)
        ? parsed.pythonPaths.filter((p): p is string => typeof p === 'string')
        : [],
      rPaths: Array.isArray(parsed.rPaths)
        ? parsed.rPaths.filter((p): p is string => typeof p === 'string')
        : [],
    };
  } catch {
    return { pythonPaths: [], rPaths: [] };
  }
}

export function saveCustomEnvPaths(paths: DataLabCustomEnvPaths): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DATALAB_CUSTOM_ENVS_KEY, JSON.stringify(paths));
    dispatchDataLabChanged();
  } catch {
    // ignore storage errors
  }
}

export interface CodeLabNotebookSnapshot {
  source: 'live' | 'draft' | 'saved';
  tabId?: string;
  fileId: string | null;
  title: string;
  folder: string;
  language: TerminalCodeLabLanguage;
  cells: Array<{
    cellId: string;
    index: number;
    kind: CodeLabCellKind;
    language: TerminalCodeLabLanguage;
    status: CodeLabCell['status'];
    executionCount: number | null;
    groupId?: string;
    groupTitle?: string;
    sqlConnectionId?: string;
    sqlResultVar?: string;
    source: string;
    outputs: string[];
  }>;
}

export function summarizeCellOutputsForAgent(
  outputs: readonly CodeLabOutputItem[],
): string[] {
  const result: string[] = [];
  for (const out of outputs) {
    if (out.kind === 'stream' && out.text.trim()) {
      result.push(`[${out.name}] ${out.text.trim().slice(0, 2000)}`);
    } else if (out.kind === 'text' && out.text.trim()) {
      result.push(out.text.trim().slice(0, 2000));
    } else if (out.kind === 'table') {
      const md = formatTableToMarkdown(out.columns, out.rows.slice(0, 30));
      result.push(
        `[TABLE ${out.engine ?? 'SQL'} · ${out.rows.length}×${out.columns.length}${out.boundVar ? ` -> ${out.boundVar}` : ''}]\n${md}`,
      );
    } else if (out.kind === 'error' && out.message.trim()) {
      result.push(`[ERROR] ${out.message.trim().slice(0, 1500)}`);
    } else if (out.kind === 'image/png') {
      result.push('[IMAGE/PNG chart output]');
    } else if (out.kind === 'text/html') {
      result.push(`[HTML output · ${out.html.length} chars]`);
    } else if (out.kind === 'text/latex') {
      result.push(`[LATEX] ${out.latex.slice(0, 500)}`);
    }
  }
  return result;
}

export function readCodeLabNotebookSnapshot(selector?: {
  fileId?: string;
  title?: string;
}): CodeLabNotebookSnapshot | null {
  const targetId = selector?.fileId?.trim() || '';
  const targetTitle = selector?.title?.trim().toLowerCase() || '';

  const drafts: Array<{
    fileId: string | null;
    title: string;
    folder: string;
    language: TerminalCodeLabLanguage;
    cells: CodeLabCell[];
  }> = [];

  if (typeof localStorage !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('seamind:codelab-draft:v1:')) continue;
        if (
          key.endsWith(':vars') ||
          key.endsWith(':console') ||
          key.endsWith(':scroll')
        ) {
          continue;
        }
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as {
          fileId?: string | null;
          title?: string;
          folder?: string;
          language?: TerminalCodeLabLanguage;
          cells?: CodeLabCell[];
        };
        if (Array.isArray(parsed.cells)) {
          drafts.push({
            fileId: parsed.fileId ?? null,
            title: parsed.title || '未命名实验本',
            folder: parsed.folder || '未归类代码',
            language: parsed.language || 'python',
            cells: parsed.cells,
          });
        }
      }
    } catch {
      // ignore draft read errors
    }
  }

  const matchedDraft = drafts.find((d) => {
    if (targetId && d.fileId === targetId) return true;
    if (targetTitle && d.title.toLowerCase().includes(targetTitle)) return true;
    return !targetId && !targetTitle;
  });

  if (matchedDraft) {
    return {
      source: 'draft',
      fileId: matchedDraft.fileId,
      title: matchedDraft.title,
      folder: matchedDraft.folder,
      language: matchedDraft.language,
      cells: matchedDraft.cells.map((c, idx) => ({
        cellId: c.id,
        index: idx + 1,
        kind: c.kind,
        language: c.language,
        status: c.status,
        executionCount: c.executionCount,
        groupId: c.groupId,
        groupTitle: c.groupTitle,
        sqlConnectionId: c.sqlConnectionId,
        sqlResultVar: c.sqlResultVar,
        source: c.source,
        outputs: summarizeCellOutputsForAgent(c.outputs),
      })),
    };
  }

  const saved = loadCodeLabCollection();
  const matchedSaved =
    saved.find((f) => {
      if (targetId && f.id === targetId) return true;
      if (targetTitle && f.title.toLowerCase().includes(targetTitle))
        return true;
      return !targetId && !targetTitle;
    }) ?? saved[0];

  if (!matchedSaved) return null;

  return {
    source: 'saved',
    fileId: matchedSaved.id,
    title: matchedSaved.title,
    folder: matchedSaved.folder,
    language: matchedSaved.language,
    cells: matchedSaved.cells.map((c, idx) => ({
      cellId: c.id,
      index: idx + 1,
      kind: c.kind,
      language: c.language,
      status: c.status,
      executionCount: c.executionCount,
      groupId: c.groupId,
      groupTitle: c.groupTitle,
      sqlConnectionId: c.sqlConnectionId,
      sqlResultVar: c.sqlResultVar,
      source: c.source,
      outputs: summarizeCellOutputsForAgent(c.outputs),
    })),
  };
}
