import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  analyzeCursorContext,
  createKnowledgeCompletionSource,
  extractInlineTags,
  formatRelativeDate,
} from '../src/knowledge-completions';
import { findWikilinkTarget } from '../src/knowledge-markdown';
import type { MapDocument } from '../src/library';

const sampleDoc = (overrides: Partial<MapDocument> = {}): MapDocument => ({
  id: 'doc-1',
  relativePath: '数学/微积分导论.md',
  title: '微积分导论',
  category: '数学',
  mapType: '文档',
  tags: ['微积分', '基础'],
  createdAt: 1_760_000_000,
  updatedAt: 1_760_000_100,
  kind: 'doc',
  ...overrides,
});

function runCompletionAt(
  docWithCaret: string,
  documents: readonly MapDocument[] = [],
  explicit = false,
) {
  const caret = docWithCaret.indexOf('|');
  const cleanDoc =
    caret >= 0
      ? docWithCaret.slice(0, caret) + docWithCaret.slice(caret + 1)
      : docWithCaret;
  const pos = caret >= 0 ? caret : cleanDoc.length;
  const state = EditorState.create({ doc: cleanDoc });
  const context = new CompletionContext(state, pos, explicit);
  return createKnowledgeCompletionSource(() => documents)(context);
}

describe('formatRelativeDate', () => {
  it('handles Unix timestamps in seconds without producing 1970 dates', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(formatRelativeDate(nowSeconds - 15)).toBe('刚刚');
    expect(formatRelativeDate(nowSeconds - 180)).toBe('3分钟前');
    expect(formatRelativeDate(nowSeconds - 7200)).toBe('2小时前');
    expect(formatRelativeDate(1_700_000_000)).not.toContain('1970');
  });

  it('also accepts millisecond timestamps and ignores non-positive values', () => {
    expect(formatRelativeDate(Date.now() - 5_000)).toBe('刚刚');
    expect(formatRelativeDate(0)).toBe('');
    expect(formatRelativeDate(-10)).toBe('');
  });
});

describe('extractInlineTags', () => {
  it('collects inline #tags while ignoring headings and code blocks', () => {
    const md = [
      '# 一级标题',
      '正文包含 #数学 与 (#微积分/极限) 以及 `#忽略行内代码`',
      '```python',
      '# 代码注释不应识别为标签',
      '```',
      '## 二级标题',
      '- 列表中的 #复盘 标签',
    ].join('\n');

    expect(extractInlineTags(md)).toEqual(['数学', '微积分/极限', '复盘']);
  });
});

describe('analyzeCursorContext', () => {
  it('distinguishes inline math, block math, code fences, and inline code', () => {
    expect(analyzeCursorContext('设 $x + \\fr', 10)).toEqual({
      inCodeFence: false,
      inInlineCode: false,
      inMath: true,
    });

    const blockMath = '$$\n\\sum_{i=1}^n\n$$';
    expect(analyzeCursorContext(blockMath, 8)).toEqual({
      inCodeFence: false,
      inInlineCode: false,
      inMath: true,
    });

    const fenced = '```ts\nconst x = "$a$";\n```';
    expect(analyzeCursorContext(fenced, 14)).toEqual({
      inCodeFence: true,
      inInlineCode: false,
      inMath: false,
    });

    expect(analyzeCursorContext('行内代码 `$not_math$` 测试', 10)).toEqual({
      inCodeFence: false,
      inInlineCode: true,
      inMath: false,
    });
  });
});

describe('createKnowledgeCompletionSource', () => {
  const docs = [
    sampleDoc(),
    sampleDoc({
      id: 'map-1',
      relativePath: '系统/Linux内核.md',
      title: 'Linux内核',
      category: '系统',
      tags: ['系统'],
      kind: 'mindmap',
    }),
  ];

  it('matches [[ wikilinks from the opening brackets and preserves/consumes closing ]] cleanly', () => {
    const docText = '参考 [[微|]] 章节';
    const caret = docText.indexOf('|');
    const cleanText = docText.replace('|', '');
    const state = EditorState.create({ doc: cleanText });
    const result = createKnowledgeCompletionSource(() => docs)(
      new CompletionContext(state, caret, false),
    );

    expect(result).not.toBeNull();
    expect(result?.from).toBe(cleanText.indexOf('[['));
    expect(result?.options[0]?.label).toBe('微积分导论');

    // Simulate CodeMirror applying the completion via a mock view dispatch
    const option = result!.options[0];
    expect(typeof option.apply).toBe('function');
    let dispatchedSpec: {
      changes: { from: number; to: number; insert: string };
      selection: { anchor: number };
    } | null = null;
    const mockView = {
      state,
      dispatch: (spec: typeof dispatchedSpec) => {
        dispatchedSpec = spec;
      },
    };
    if (typeof option.apply === 'function') {
      option.apply(mockView as never, option, result!.from, caret);
    }
    expect(dispatchedSpec).not.toBeNull();
    const updated = state.update(dispatchedSpec!).state.doc.toString();
    expect(updated).toBe('参考 [[微积分导论]] 章节');
  });

  it('triggers / slash commands at line start or list items, but never inside URLs', () => {
    const atLineStart = runCompletionAt('/ma|', docs);
    expect(atLineStart?.options.map((o) => o.label)).toContain('/math');

    const inList = runCompletionAt('- /to|', docs);
    expect(inList?.options.map((o) => o.label)).toContain('/todo');

    const inUrl = runCompletionAt('访问 https://example.com/ma| 查看', docs);
    expect(inUrl).toBeNull();
  });

  it('triggers snippet-based LaTeX completions only inside math context', () => {
    const outsideMath = runCompletionAt('\\fra|', docs);
    expect(outsideMath).toBeNull();

    const insideMath = runCompletionAt('公式 $\\fra|$', docs);
    expect(insideMath).not.toBeNull();
    const frac = insideMath!.options.find((item) => item.label === '\\frac');
    expect(frac).toBeDefined();
    // Snippet completions use a function apply handler rather than inserting literal ${1:a}
    expect(typeof frac?.apply).toBe('function');
  });

  it('suggests aggregated #tags inline while avoiding bare # heading at line start', () => {
    expect(runCompletionAt('#|', docs)).toBeNull();
    const tagResult = runCompletionAt('关联主题 #微|', docs);
    expect(tagResult?.options.map((o) => o.label)).toContain('#微积分');
  });
});

describe('findWikilinkTarget', () => {
  it('resolves notes by exact title, preferring doc over mindmap, or by relative path', () => {
    const docItem = sampleDoc({
      title: '线性代数',
      relativePath: '数学/线性代数.md',
    });
    const mapItem = sampleDoc({
      id: 'm2',
      title: '线性代数',
      relativePath: '导图/线性代数.md',
      kind: 'mindmap',
    });

    expect(findWikilinkTarget('线性代数', [mapItem, docItem])).toBe(docItem);
    expect(findWikilinkTarget('导图/线性代数', [mapItem, docItem])).toBe(
      mapItem,
    );
    expect(findWikilinkTarget('不存在的笔记', [docItem])).toBeUndefined();
  });
});
