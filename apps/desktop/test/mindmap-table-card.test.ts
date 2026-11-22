import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Transformer } from 'markmap-lib';
import { pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import {
  applyMarkdownNodeCommand,
  buildMarkdownNodeSourceMap,
  markdownForMindmap,
} from '../src/mindmap/commands';
import {
  formatTablePasteForMarkdownEditor,
  parseNodeTableInput,
  tsvToMarkdownTable,
} from '../src/mindmap/mindmap-table-paste';
import {
  tableMatrixToCsv,
  tableMatrixToMarkdown,
} from '../src/workbench/mindmap-table-card';

const transformer = new Transformer([pluginFrontmatter, pluginSourceLines]);

describe('mindmap-table-card serialization helpers', () => {
  it('formats markdown table with alignments and escaped pipes', () => {
    const md = tableMatrixToMarkdown({
      headers: [
        { text: '数据源', align: 'left' },
        { text: '品种 | 市场', align: 'center' },
        { text: '年费', align: 'right' },
      ],
      rows: [
        [
          { text: '天勤量化' },
          { text: '期货 / 期权 | Tick' },
          { text: '1500' },
        ],
        [{ text: 'AkShare' }, { text: 'A股' }],
      ],
    });

    expect(md).toBe(
      [
        '| 数据源 | 品种 \\| 市场 | 年费 |',
        '| :--- | :---: | ---: |',
        '| 天勤量化 | 期货 / 期权 \\| Tick | 1500 |',
        '| AkShare | A股 |  |',
      ].join('\n'),
    );
  });

  it('returns empty string for empty matrix', () => {
    expect(tableMatrixToMarkdown({ headers: [], rows: [] })).toBe('');
  });

  it('formats RFC 4180 CSV with commas, quotes and newlines escaped', () => {
    const csv = tableMatrixToCsv([
      ['数据源', '说明', '价格'],
      ['TqSdk', '包含, 逗号和"引号"', '0'],
      ['Wind', '第一行\n第二行', '按席位'],
    ]);

    expect(csv).toBe(
      [
        '数据源,说明,价格',
        'TqSdk,"包含, 逗号和""引号""",0',
        'Wind,"第一行\n第二行",按席位',
      ].join('\n'),
    );
  });
});

describe('mindmap encoded table & paste recovery', () => {
  const originalDocument = globalThis.document;

  beforeAll(() => {
    if (typeof globalThis.document === 'undefined') {
      (globalThis as unknown as { document: unknown }).document = {
        createElement: () => ({
          set innerHTML(v: string) {
            this._v = v;
          },
          get value() {
            return this._v ?? '';
          },
          _v: '',
        }),
      };
    }
  });

  afterAll(() => {
    if (originalDocument === undefined) {
      delete (globalThis as unknown as { document?: unknown }).document;
    } else {
      (globalThis as unknown as { document: unknown }).document =
        originalDocument;
    }
  });

  it('parses legacy &#10;-flattened table beneath ##### heading into real <table> node without shifting later lines', () => {
    const markdown = [
      '# 量化系统',
      '#### 对比 <!-- seamind:id=parent-1 -->',
      '##### | 数据 / 能力维度 | 免费账户 | 专业版 (Pro) | &#10; | --- | --- | --- | &#10; | 期货品种 | 全部合约 | 同左 | &#10; | A股指数 | 仅4大指数 | 全市场 `A股` | <!-- seamind:id=tbl-1 -->',
      '#### 后续章节 <!-- seamind:id=next-1 -->',
    ].join('\n');

    const { root } = transformer.transform(markdownForMindmap(markdown));
    const compareNode = root.children[0];
    expect(compareNode.children.length).toBe(1);
    const tableNode = compareNode.children[0];
    expect(tableNode.content).toContain('<table');
    expect(tableNode.content).toMatch(/<thead\b/);
    expect(tableNode.content).toContain('<code>');
    expect(tableNode.payload?.tag).toBe('table');

    const sources = buildMarkdownNodeSourceMap(markdown, root);
    const nextEntry = [...sources.entries()].find(
      ([, src]) => src.id === 'next-1',
    );
    expect(nextEntry?.[1].lineIndex).toBe(3);
  });

  it('converts TSV clipboard text to Markdown table while ignoring tab-indented code', () => {
    const tsv = '数据源\t周期\t费用\n天勤\tTick\t免费\nWind\t日线\t商业';
    expect(tsvToMarkdownTable(tsv)).toBe(
      [
        '| 数据源 | 周期 | 费用 |',
        '| --- | --- | --- |',
        '| 天勤 | Tick | 免费 |',
        '| Wind | 日线 | 商业 |',
      ].join('\n'),
    );

    const indentedCode = '\tconst a = 1;\n\tconst b = 2;';
    expect(tsvToMarkdownTable(indentedCode)).toBeNull();
  });

  it('promotes pasted multi-line table on canvas node rename into standalone GFM table block', () => {
    const originalDocument = globalThis.document;
    if (typeof globalThis.document === 'undefined') {
      (globalThis as unknown as { document: unknown }).document = {
        createElement: () => ({
          set innerHTML(v: string) {
            this._v = v;
          },
          get value() {
            return this._v ?? '';
          },
          _v: '',
        }),
      };
    }
    try {
      const md = [
        '# 量化系统',
        '#### 对比 <!-- seamind:id=parent-1 -->',
        '##### 新主题 <!-- seamind:id=node-2 -->',
        '#### 后续章节',
      ].join('\n');

      const { root } = transformer.transform(markdownForMindmap(md));
      const sources = buildMarkdownNodeSourceMap(md, root);
      const targetSource = [...sources.values()].find(
        (src) => src.id === 'node-2',
      )!;

      const pastedTable = [
        '| 数据维度 | 免费版 | 专业版 |',
        '| --- | --- | --- |',
        '| 期货 | 支持 | 支持 |',
      ].join('\n');

      const result = applyMarkdownNodeCommand(
        md,
        targetSource,
        'rename',
        pastedTable,
      );

      expect(result.markdown).not.toContain('##### |');
      expect(result.markdown).not.toContain('&#10;');
      expect(result.markdown).toContain(
        '<!-- seamind:id=node-2 -->\n| 数据维度',
      );
      const { root: nextRoot } = transformer.transform(
        markdownForMindmap(result.markdown),
      );
      expect(nextRoot.children[0].children[0].content).toContain('<table');
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as unknown as { document?: unknown }).document;
      } else {
        (globalThis as unknown as { document: unknown }).document =
          originalDocument;
      }
    }
  });

  it('strips placeholder heading prefix and pads blank lines in Markdown editor paste', () => {
    const doc = '# 标题\n##### 新主题 <!-- seamind:id=abc-123 -->\n后续段落';
    const placeholderStart = doc.indexOf('新主题');
    const placeholderEnd = placeholderStart + '新主题'.length;

    const pasted = '| 列A | 列B |\n| --- | --- |\n| 1 | 2 |';
    const pasteEdit = formatTablePasteForMarkdownEditor(
      doc,
      placeholderStart,
      placeholderEnd,
      pasted,
    );
    expect(pasteEdit).not.toBeNull();
    const updated =
      doc.slice(0, pasteEdit!.replaceFrom) +
      pasteEdit!.text +
      doc.slice(pasteEdit!.replaceTo);

    expect(updated).toContain('<!-- seamind:id=abc-123 -->\n| 列A | 列B |');
    expect(updated).not.toContain('#####');
    expect(updated).toContain('| 1 | 2 |\n\n后续段落');

    expect(
      parseNodeTableInput('    | A | B |\n    | --- | --- |\n    | 1 | 2 |')
        ?.tableMarkdown,
    ).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });
});
