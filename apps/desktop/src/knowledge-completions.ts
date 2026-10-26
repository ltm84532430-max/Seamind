import {
  autocompletion,
  pickedCompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { MapDocument } from './library';

/**
 * Formats a Unix timestamp (either seconds from Rust backend or milliseconds from JS)
 * into a concise Chinese relative timestamp.
 */
export function formatRelativeDate(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return '';
  const ms = timestamp < 1e11 ? timestamp * 1000 : timestamp;
  const now = Date.now();
  const diff = Math.max(0, now - ms);

  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;

  const targetDate = new Date(ms);
  const nowDate = new Date(now);
  const startOfToday = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
  ).getTime();
  const startOfTarget = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate(),
  ).getTime();
  const dayDiff = Math.round((startOfToday - startOfTarget) / 86_400_000);

  if (dayDiff === 1) return '昨天';
  if (dayDiff > 1 && dayDiff < 7) return `${dayDiff}天前`;

  const month = String(targetDate.getMonth() + 1).padStart(2, '0');
  const day = String(targetDate.getDate()).padStart(2, '0');
  if (targetDate.getFullYear() === nowDate.getFullYear()) {
    return `${month}-${day}`;
  }
  return `${targetDate.getFullYear()}-${month}-${day}`;
}

/**
 * Extracts inline `#tags` from Markdown source while skipping code fences and ATX headings.
 */
export function extractInlineTags(markdown: string): string[] {
  if (!markdown) return [];
  const found = new Set<string>();
  const lines = markdown.split(/\r?\n/);
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || /^#{1,6}\s/.test(trimmed)) continue;

    const stripped = line.replace(/`[^`]*`/g, ' ');
    const regex =
      /(?:^|[\s(（])#([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5\-_/]{0,38})/g;
    let match = regex.exec(stripped);
    while (match) {
      found.add(match[1]);
      match = regex.exec(stripped);
    }
  }
  return [...found];
}

const SECTION_WIKILINK: CompletionSection = { name: '双链引用', rank: 1 };
const SECTION_SLASH_BLOCK: CompletionSection = {
  name: '内容块与排版',
  rank: 1,
};
const SECTION_SLASH_CALLOUT: CompletionSection = { name: '提示卡片', rank: 2 };
const SECTION_TAG: CompletionSection = { name: '知识标签', rank: 1 };
const SECTION_MATH_STRUCT: CompletionSection = {
  name: '常用分式与算子',
  rank: 1,
};
const SECTION_MATH_GREEK: CompletionSection = { name: '希腊字母', rank: 2 };
const SECTION_MATH_REL: CompletionSection = { name: '关系与集合符号', rank: 3 };
const SECTION_MATH_ENV: CompletionSection = { name: '矩阵与多行环境', rank: 4 };

/**
 * Pre-built LaTeX completions using CodeMirror's `snippetCompletion` with escaped literal braces.
 */
const LATEX_COMPLETIONS: readonly Completion[] = [
  // Structures with Tab-stops
  snippetCompletion('\\frac\\{${1:a}\\}\\{${2:b}\\}', {
    label: '\\frac',
    detail: '分式 a/b',
    section: SECTION_MATH_STRUCT,
    boost: 98,
  }),
  snippetCompletion('\\sqrt\\{${1:x}\\}', {
    label: '\\sqrt',
    detail: '平方根',
    section: SECTION_MATH_STRUCT,
    boost: 96,
  }),
  snippetCompletion('\\sum_\\{${1:i=1}\\}^\\{${2:n}\\} ${0}', {
    label: '\\sum',
    detail: '求和 ∑',
    section: SECTION_MATH_STRUCT,
    boost: 95,
  }),
  snippetCompletion('\\int_\\{${1:a}\\}^\\{${2:b}\\} ${3:f(x)}\\,d${4:x}', {
    label: '\\int',
    detail: '定积分 ∫',
    section: SECTION_MATH_STRUCT,
    boost: 94,
  }),
  snippetCompletion('\\prod_\\{${1:i=1}\\}^\\{${2:n}\\} ${0}', {
    label: '\\prod',
    detail: '连乘 ∏',
    section: SECTION_MATH_STRUCT,
    boost: 92,
  }),
  snippetCompletion('\\lim_\\{${1:x} \\to ${2:\\infty}\\} ${0}', {
    label: '\\lim',
    detail: '极限 lim',
    section: SECTION_MATH_STRUCT,
    boost: 91,
  }),
  snippetCompletion('\\mathbf\\{${1:x}\\}', {
    label: '\\mathbf',
    detail: '粗体向量',
    section: SECTION_MATH_STRUCT,
    boost: 89,
  }),
  snippetCompletion('\\mathbb\\{${1:R}\\}', {
    label: '\\mathbb',
    detail: '黑板粗体 ℝ/ℕ/ℤ',
    section: SECTION_MATH_STRUCT,
    boost: 88,
  }),
  snippetCompletion('\\mathcal\\{${1:O}\\}(${2:n})', {
    label: '\\mathcal',
    detail: '花体 𝒪(n)',
    section: SECTION_MATH_STRUCT,
    boost: 87,
  }),
  snippetCompletion('\\text\\{${1:说明}\\}', {
    label: '\\text',
    detail: '公式内正文字段',
    section: SECTION_MATH_STRUCT,
    boost: 86,
  }),
  snippetCompletion('\\hat\\{${1:x}\\}', {
    label: '\\hat',
    detail: '估计量 x̂',
    section: SECTION_MATH_STRUCT,
    boost: 85,
  }),
  snippetCompletion('\\vec\\{${1:v}\\}', {
    label: '\\vec',
    detail: '向量箭头 v⃗',
    section: SECTION_MATH_STRUCT,
    boost: 84,
  }),

  // Greek letters
  { label: '\\alpha', detail: 'α', section: SECTION_MATH_GREEK, boost: 82 },
  { label: '\\beta', detail: 'β', section: SECTION_MATH_GREEK, boost: 82 },
  { label: '\\gamma', detail: 'γ', section: SECTION_MATH_GREEK, boost: 82 },
  { label: '\\delta', detail: 'δ', section: SECTION_MATH_GREEK, boost: 82 },
  { label: '\\Delta', detail: 'Δ', section: SECTION_MATH_GREEK, boost: 82 },
  { label: '\\epsilon', detail: 'ε', section: SECTION_MATH_GREEK, boost: 81 },
  {
    label: '\\varepsilon',
    detail: 'ε (花体)',
    section: SECTION_MATH_GREEK,
    boost: 81,
  },
  { label: '\\theta', detail: 'θ', section: SECTION_MATH_GREEK, boost: 81 },
  { label: '\\Theta', detail: 'Θ', section: SECTION_MATH_GREEK, boost: 80 },
  { label: '\\lambda', detail: 'λ', section: SECTION_MATH_GREEK, boost: 81 },
  { label: '\\Lambda', detail: 'Λ', section: SECTION_MATH_GREEK, boost: 80 },
  { label: '\\mu', detail: 'μ', section: SECTION_MATH_GREEK, boost: 80 },
  { label: '\\pi', detail: 'π', section: SECTION_MATH_GREEK, boost: 80 },
  { label: '\\rho', detail: 'ρ', section: SECTION_MATH_GREEK, boost: 79 },
  { label: '\\sigma', detail: 'σ', section: SECTION_MATH_GREEK, boost: 80 },
  { label: '\\Sigma', detail: 'Σ', section: SECTION_MATH_GREEK, boost: 79 },
  { label: '\\tau', detail: 'τ', section: SECTION_MATH_GREEK, boost: 79 },
  { label: '\\phi', detail: 'φ', section: SECTION_MATH_GREEK, boost: 79 },
  {
    label: '\\varphi',
    detail: 'φ (常用)',
    section: SECTION_MATH_GREEK,
    boost: 79,
  },
  { label: '\\psi', detail: 'ψ', section: SECTION_MATH_GREEK, boost: 78 },
  { label: '\\omega', detail: 'ω', section: SECTION_MATH_GREEK, boost: 78 },
  { label: '\\Omega', detail: 'Ω', section: SECTION_MATH_GREEK, boost: 78 },

  // Operators & relations
  { label: '\\infty', detail: '∞ 无穷', section: SECTION_MATH_REL, boost: 76 },
  {
    label: '\\partial',
    detail: '∂ 偏导',
    section: SECTION_MATH_REL,
    boost: 76,
  },
  { label: '\\nabla', detail: '∇ 梯度', section: SECTION_MATH_REL, boost: 76 },
  { label: '\\cdot', detail: '· 点乘', section: SECTION_MATH_REL, boost: 75 },
  { label: '\\times', detail: '× 叉乘', section: SECTION_MATH_REL, boost: 75 },
  { label: '\\pm', detail: '± 正负', section: SECTION_MATH_REL, boost: 75 },
  {
    label: '\\leq',
    detail: '≤ 小于等于',
    section: SECTION_MATH_REL,
    boost: 75,
  },
  {
    label: '\\geq',
    detail: '≥ 大于等于',
    section: SECTION_MATH_REL,
    boost: 75,
  },
  { label: '\\neq', detail: '≠ 不等于', section: SECTION_MATH_REL, boost: 75 },
  {
    label: '\\approx',
    detail: '≈ 约等于',
    section: SECTION_MATH_REL,
    boost: 74,
  },
  {
    label: '\\equiv',
    detail: '≡ 恒等于',
    section: SECTION_MATH_REL,
    boost: 74,
  },
  {
    label: '\\to',
    detail: '→ 趋于/映射',
    section: SECTION_MATH_REL,
    boost: 74,
  },
  {
    label: '\\Rightarrow',
    detail: '⇒ 推出',
    section: SECTION_MATH_REL,
    boost: 74,
  },
  {
    label: '\\iff',
    detail: '⟺ 当且仅当',
    section: SECTION_MATH_REL,
    boost: 73,
  },
  { label: '\\in', detail: '∈ 属于', section: SECTION_MATH_REL, boost: 73 },
  {
    label: '\\notin',
    detail: '∉ 不属于',
    section: SECTION_MATH_REL,
    boost: 72,
  },
  {
    label: '\\subset',
    detail: '⊂ 真子集',
    section: SECTION_MATH_REL,
    boost: 72,
  },
  {
    label: '\\subseteq',
    detail: '⊆ 子集',
    section: SECTION_MATH_REL,
    boost: 72,
  },
  { label: '\\cup', detail: '∪ 并集', section: SECTION_MATH_REL, boost: 72 },
  { label: '\\cap', detail: '∩ 交集', section: SECTION_MATH_REL, boost: 72 },
  { label: '\\forall', detail: '∀ 任意', section: SECTION_MATH_REL, boost: 71 },
  { label: '\\exists', detail: '∃ 存在', section: SECTION_MATH_REL, boost: 71 },

  // Environments
  snippetCompletion(
    '\\begin\\{pmatrix\\}\n  ${1:a} & ${2:b} \\\\\\\\\n  ${3:c} & ${4:d}\n\\end\\{pmatrix\\}',
    {
      label: '\\begin{pmatrix}',
      detail: '圆括号矩阵',
      section: SECTION_MATH_ENV,
      boost: 70,
    },
  ),
  snippetCompletion(
    '\\begin\\{bmatrix\\}\n  ${1:a} & ${2:b} \\\\\\\\\n  ${3:c} & ${4:d}\n\\end\\{bmatrix\\}',
    {
      label: '\\begin{bmatrix}',
      detail: '方括号矩阵',
      section: SECTION_MATH_ENV,
      boost: 70,
    },
  ),
  snippetCompletion(
    '\\begin\\{cases\\}\n  ${1:x}, & ${2:x > 0} \\\\\\\\\n  ${3:0}, & ${4:\\text\\{其他\\}}\n\\end\\{cases\\}',
    {
      label: '\\begin{cases}',
      detail: '分段函数',
      section: SECTION_MATH_ENV,
      boost: 69,
    },
  ),
  snippetCompletion(
    '\\begin\\{aligned\\}\n  ${1:f(x)} &= ${2:ax + b} \\\\\\\\\n  &= ${3:0}\n\\end\\{aligned\\}',
    {
      label: '\\begin{aligned}',
      detail: '多行等式对齐',
      section: SECTION_MATH_ENV,
      boost: 69,
    },
  ),
];

function buildSlashCommands(): Completion[] {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  return [
    snippetCompletion('$$\n${1}\n$$', {
      label: '/math',
      detail: 'KaTeX 独立公式块',
      section: SECTION_SLASH_BLOCK,
      boost: 99,
    }),
    snippetCompletion('```${1:typescript}\n${2}\n```', {
      label: '/code',
      detail: '代码块',
      section: SECTION_SLASH_BLOCK,
      boost: 97,
    }),
    snippetCompletion('```python\n${1}\n```', {
      label: '/python',
      detail: '可执行 Python 代码块',
      section: SECTION_SLASH_BLOCK,
      boost: 95,
    }),
    snippetCompletion(
      '```mermaid\nflowchart TD\n  ${1:A[开始]} --> ${2:B[结束]}\n```',
      {
        label: '/mermaid',
        detail: '流程图代码块',
        section: SECTION_SLASH_BLOCK,
        boost: 94,
      },
    ),
    snippetCompletion(
      '| ${1:列 1} | ${2:列 2} | ${3:列 3} |\n| :--- | :--- | :--- |\n| ${4:内容} | ${5:内容} | ${6:内容} |',
      {
        label: '/table',
        detail: '三列 Markdown 表格',
        section: SECTION_SLASH_BLOCK,
        boost: 93,
      },
    ),
    {
      label: '/todo',
      detail: '待办任务项 - [ ]',
      section: SECTION_SLASH_BLOCK,
      boost: 92,
      apply: '- [ ] ',
    },
    {
      label: '/h1',
      detail: '一级标题 #',
      section: SECTION_SLASH_BLOCK,
      boost: 86,
      apply: '# ',
    },
    {
      label: '/h2',
      detail: '二级标题 ##',
      section: SECTION_SLASH_BLOCK,
      boost: 85,
      apply: '## ',
    },
    {
      label: '/h3',
      detail: '三级标题 ###',
      section: SECTION_SLASH_BLOCK,
      boost: 84,
      apply: '### ',
    },
    {
      label: '/divider',
      detail: '水平分割线 ---',
      section: SECTION_SLASH_BLOCK,
      boost: 80,
      apply: '---\n',
    },
    {
      label: '/date',
      detail: `${dateStr} ${timeStr}`,
      section: SECTION_SLASH_BLOCK,
      boost: 78,
      apply: `${dateStr} ${timeStr}`,
    },
    snippetCompletion('> [!NOTE] ${1:说明}\n> ${2:在此输入内容}', {
      label: '/note',
      detail: '说明提示框 [!NOTE]',
      section: SECTION_SLASH_CALLOUT,
      boost: 90,
    }),
    snippetCompletion('> [!TIP] ${1:技巧}\n> ${2:在此输入建议}', {
      label: '/tip',
      detail: '技巧提示框 [!TIP]',
      section: SECTION_SLASH_CALLOUT,
      boost: 89,
    }),
    snippetCompletion('> [!IMPORTANT] ${1:重点}\n> ${2:关键结论或前置条件}', {
      label: '/important',
      detail: '重要提示框 [!IMPORTANT]',
      section: SECTION_SLASH_CALLOUT,
      boost: 88,
    }),
    snippetCompletion('> [!WARNING] ${1:注意}\n> ${2:潜在风险或边界事项}', {
      label: '/warning',
      detail: '警告提示框 [!WARNING]',
      section: SECTION_SLASH_CALLOUT,
      boost: 87,
    }),
  ];
}

/**
 * Scans Markdown up to `pos` to determine whether the cursor sits inside a fenced code block
 * or inside inline `$...$` / display `$$...$$` math.
 */
export function analyzeCursorContext(
  docText: string,
  pos: number,
): { inCodeFence: boolean; inInlineCode: boolean; inMath: boolean } {
  const before = docText.slice(0, pos);
  const lines = before.split(/\r?\n/);
  let inCodeFence = false;
  let inBlockMath = false;

  for (let idx = 0; idx < lines.length - 1; idx += 1) {
    const trimmed = lines[idx].trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    let cursor = 0;
    while (cursor < lines[idx].length) {
      if (lines[idx][cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (lines[idx][cursor] === '$' && lines[idx][cursor + 1] === '$') {
        inBlockMath = !inBlockMath;
        cursor += 2;
        continue;
      }
      cursor += 1;
    }
  }

  if (inCodeFence) {
    return { inCodeFence: true, inInlineCode: false, inMath: false };
  }

  const currentLine = lines[lines.length - 1] ?? '';
  let inInlineCode = false;
  let inInlineMath = false;
  let i = 0;
  while (i < currentLine.length) {
    const ch = currentLine[i];
    if (ch === '\\' && !inInlineCode) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      inInlineCode = !inInlineCode;
      i += 1;
      continue;
    }
    if (!inInlineCode && ch === '$') {
      if (currentLine[i + 1] === '$') {
        inBlockMath = !inBlockMath;
        i += 2;
        continue;
      }
      if (!inBlockMath) {
        inInlineMath = !inInlineMath;
      }
    }
    i += 1;
  }

  return {
    inCodeFence: false,
    inInlineCode,
    inMath: !inInlineCode && (inBlockMath || inInlineMath),
  };
}

/**
 * Builds the context-aware CodeMirror CompletionSource for SeaMind Knowledge Workspace.
 */
export function createKnowledgeCompletionSource(
  getDocuments: () => readonly MapDocument[],
) {
  return (context: CompletionContext): CompletionResult | null => {
    const { state, pos } = context;
    const docText = state.doc.toString();
    const cursorCtx = analyzeCursorContext(docText, pos);

    if (cursorCtx.inCodeFence || cursorCtx.inInlineCode) {
      return null;
    }

    // 1. LaTeX commands inside `$ ... $` or `$$ ... $$`
    if (cursorCtx.inMath) {
      const latexMatch = context.matchBefore(/\\[a-zA-Z{]*$/);
      if (latexMatch) {
        const query = latexMatch.text.slice(1).toLowerCase();
        const options = LATEX_COMPLETIONS.filter(
          (item) =>
            !query ||
            item.label.slice(1).toLowerCase().includes(query) ||
            (item.detail?.toLowerCase().includes(query) ?? false),
        );
        if (options.length === 0) return null;
        return {
          from: latexMatch.from,
          options,
          validFor: /^\\[a-zA-Z]*$/,
        };
      }
      return null;
    }

    // 2. Wikilink `[[note]]` or `[[note|alias]]`
    const wikilinkMatch = context.matchBefore(/\[\[([^\]\n|]*)$/);
    if (wikilinkMatch) {
      const rawQuery = wikilinkMatch.text.slice(2).trim().toLowerCase();
      const docs = getDocuments();
      const matched = docs.filter((doc) => {
        if (!rawQuery) return true;
        return (
          doc.title.toLowerCase().includes(rawQuery) ||
          doc.relativePath.toLowerCase().includes(rawQuery) ||
          doc.category.toLowerCase().includes(rawQuery)
        );
      });

      if (matched.length === 0) return null;

      const options: Completion[] = matched.map((doc) => {
        const kindLabel = doc.kind === 'doc' ? '笔记' : '导图';
        const folderLabel = doc.category || '未分类';
        const timeLabel = doc.updatedAt
          ? ` · ${formatRelativeDate(doc.updatedAt)}`
          : '';
        return {
          label: doc.title,
          detail: `${kindLabel} · ${folderLabel}${timeLabel}`,
          section: SECTION_WIKILINK,
          boost:
            (doc.kind === 'doc' ? 10 : 0) +
            (rawQuery && doc.title.toLowerCase().startsWith(rawQuery) ? 20 : 0),
          apply: (view, completion, from, to) => {
            const after = view.state.doc.sliceString(to, to + 2);
            const replaceTo = after === ']]' ? to + 2 : to;
            const inserted = `[[${doc.title}]]`;
            view.dispatch({
              changes: { from, to: replaceTo, insert: inserted },
              selection: { anchor: from + inserted.length },
              annotations: pickedCompletion.of(completion),
              userEvent: 'input.complete',
            });
          },
        };
      });

      return {
        from: wikilinkMatch.from,
        options,
        filter: false,
      };
    }

    // 3. Line-start Slash Commands (`/math`, `/table`, `/note` ...)
    const line = state.doc.lineAt(pos);
    const textBeforeCursorInLine = line.text.slice(0, pos - line.from);
    const slashLineMatch = textBeforeCursorInLine.match(
      /^(?:\s*(?:[-*+]|\d+\.|>)\s+|\s*)\/([a-zA-Z0-9\u4e00-\u9fa5]*)$/,
    );
    if (slashLineMatch) {
      const tokenLength = slashLineMatch[1].length + 1; // include `/`
      const slashFrom = pos - tokenLength;
      const query = slashLineMatch[1].toLowerCase();
      const commands = buildSlashCommands().filter(
        (cmd) =>
          !query ||
          cmd.label.slice(1).toLowerCase().includes(query) ||
          (cmd.detail?.toLowerCase().includes(query) ?? false),
      );
      if (commands.length > 0) {
        return {
          from: slashFrom,
          options: commands,
          filter: false,
        };
      }
    }

    // 4. Tag Completion (`#tag`) — avoids ATX heading `# ` at column 0 when empty
    const tagMatch = textBeforeCursorInLine.match(
      /(?:^|[\s(（])#([\w\u4e00-\u9fa5\-_/]*)$/,
    );
    if (tagMatch) {
      const query = tagMatch[1].toLowerCase();
      const isLineHeadingCandidate =
        /^\s*#$/.test(textBeforeCursorInLine) && !context.explicit;
      if (!isLineHeadingCandidate) {
        const counts = new Map<string, number>();
        for (const doc of getDocuments()) {
          for (const tag of doc.tags ?? []) {
            const clean = tag.trim();
            if (clean) counts.set(clean, (counts.get(clean) ?? 0) + 1);
          }
        }
        for (const inlineTag of extractInlineTags(docText)) {
          if (!counts.has(inlineTag)) counts.set(inlineTag, 1);
        }

        const matchedTags = [...counts.entries()]
          .filter(([tag]) => !query || tag.toLowerCase().includes(query))
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));

        if (matchedTags.length > 0) {
          const hashFrom = pos - tagMatch[1].length - 1;
          const options: Completion[] = matchedTags.map(([tag, count]) => ({
            label: `#${tag}`,
            detail: `${count} 处引用`,
            section: SECTION_TAG,
            boost: 85,
            apply: (view, completion, from, to) => {
              const inserted = `#${tag} `;
              view.dispatch({
                changes: { from, to, insert: inserted },
                selection: { anchor: from + inserted.length },
                annotations: pickedCompletion.of(completion),
                userEvent: 'input.complete',
              });
            },
          }));
          return {
            from: hashFrom,
            options,
            filter: false,
          };
        }
      }
    }

    return null;
  };
}

/**
 * Creates stable CodeMirror extensions for knowledge autocompletion.
 * Call once per editor mount using a ref-backed `getDocuments` callback.
 */
export function createKnowledgeEditorExtensions(
  getDocuments: () => readonly MapDocument[],
): Extension[] {
  return [
    autocompletion({
      override: [createKnowledgeCompletionSource(getDocuments)],
      defaultKeymap: true,
      selectOnOpen: true,
      icons: false,
      maxRenderedOptions: 40,
      tooltipClass: () => 'seamind-cm-autocomplete',
    }),
  ];
}
