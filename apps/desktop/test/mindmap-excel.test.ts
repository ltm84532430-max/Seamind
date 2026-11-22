import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Transformer } from 'markmap-lib';
import { pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import {
  applyInsertExcelTableCommand,
  applyMarkdownNodeBranch,
  buildMarkdownNodeSourceMap,
  markdownForMindmap,
} from '../src/mindmap/commands';
import {
  buildExcelMarkdownTable,
  buildExcelTreeBranchMarkdown,
  buildExternalExcelFence,
  columnIndexToLetters,
  isExcelFilePath,
  parseExcelFenceDescriptor,
  shouldExternalizeExcelTable,
  sliceExcelSheet,
  type ParsedExcelSheet,
} from '../src/mindmap/mindmap-excel';

const transformer = new Transformer([pluginFrontmatter, pluginSourceLines]);

describe('mindmap-excel helpers', () => {
  const sampleSheet: ParsedExcelSheet = {
    name: '季度营收',
    rowCount: 4,
    colCount: 4,
    truncated: false,
    rows: [
      ['部门', '产品 | 线', 'Q1', '备注'],
      ['量化', 'TqSdk', '1200', '主力\n产品'],
      ['量化', 'Pro', '2500', ''],
      ['资讯', '研报流', '800', '内测'],
    ],
  };

  it('converts column indices to Excel letters', () => {
    expect(columnIndexToLetters(0)).toBe('A');
    expect(columnIndexToLetters(25)).toBe('Z');
    expect(columnIndexToLetters(26)).toBe('AA');
    expect(columnIndexToLetters(51)).toBe('AZ');
    expect(columnIndexToLetters(52)).toBe('BA');
  });

  it('detects supported Excel/delimited file paths', () => {
    expect(isExcelFilePath('report.xlsx')).toBe(true);
    expect(isExcelFilePath('C:\\data\\macro.XLSM')).toBe(true);
    expect(isExcelFilePath('export.csv')).toBe(true);
    expect(isExcelFilePath('data.tsv')).toBe(true);
    expect(isExcelFilePath('notes.md')).toBe(false);
  });

  it('slices sheet ranges with or without first row as header', () => {
    const sliced = sliceExcelSheet(sampleSheet, {
      startRow: 1,
      endRow: 3,
      startCol: 1,
      endCol: 3,
      firstRowAsHeader: true,
    });
    expect(sliced.headers).toEqual(['部门', '产品 | 线', 'Q1']);
    expect(sliced.rows).toEqual([
      ['量化', 'TqSdk', '1200'],
      ['量化', 'Pro', '2500'],
    ]);

    const noHeader = sliceExcelSheet(sampleSheet, {
      startRow: 2,
      endRow: 3,
      startCol: 2,
      endCol: 3,
      firstRowAsHeader: false,
    });
    expect(noHeader.headers).toEqual(['列 B', '列 C']);
    expect(noHeader.rows).toEqual([
      ['TqSdk', '1200'],
      ['Pro', '2500'],
    ]);
  });

  it('escapes pipes and multiline cells when building Markdown tables', () => {
    const sliced = sliceExcelSheet(sampleSheet, {
      startRow: 1,
      endRow: 4,
      startCol: 1,
      endCol: 4,
      firstRowAsHeader: true,
    });
    const md = buildExcelMarkdownTable(sliced.headers, sliced.rows);
    expect(md).toContain('| 部门 | 产品 \\| 线 | Q1 | 备注 |');
    expect(md).toContain('| 量化 | TqSdk | 1200 | 主力<br>产品 |');
  });

  it('flags large tables for externalization above row or col limits', () => {
    const small = shouldExternalizeExcelTable({
      headers: ['A', 'B'],
      rows: [['1', '2']],
      rowCount: 1,
      colCount: 2,
    });
    expect(small.externalize).toBe(false);

    const manyRows = shouldExternalizeExcelTable({
      headers: ['A', 'B'],
      rows: Array.from({ length: 85 }, (_, i) => [String(i), 'v']),
      rowCount: 85,
      colCount: 2,
    });
    expect(manyRows.externalize).toBe(true);
  });

  it('round-trips seamind-excel fence descriptors safely', () => {
    const assetId = 'a'.repeat(64);
    const fence = buildExternalExcelFence({
      assetId,
      title: '成交明细',
      fileName: 'trades.xlsx',
      sheetName: 'Trades',
      rowCount: 320,
      colCount: 5,
      headers: ['日期', '品种'],
      previewRows: [['2026-01-01', 'rb2605']],
    });
    const inner = fence
      .replace(/^```seamind-excel\n/, '')
      .replace(/\n```$/, '');
    const parsed = parseExcelFenceDescriptor(inner);
    expect(parsed).toEqual({
      assetId,
      title: '成交明细',
      fileName: 'trades.xlsx',
      sheetName: 'Trades',
      rowCount: 320,
      colCount: 5,
      headers: ['日期', '品种'],
      previewRows: [['2026-01-01', 'rb2605']],
    });
    expect(
      parseExcelFenceDescriptor('{"assetId":"not-hex","title":"bad"}'),
    ).toBeNull();
  });

  it('builds flat and grouped mindmap branch Markdown from rows', () => {
    const grouped = buildExcelTreeBranchMarkdown({
      rootTitle: '季度营收',
      headers: ['部门', '产品', 'Q1', '备注'],
      rows: [
        ['量化', 'TqSdk', '1200', '主力'],
        ['量化', 'Pro', '2500', ''],
        ['资讯', '研报流', '800', '内测'],
      ],
      labelColIndex: 1,
      groupColIndex: 0,
    });
    expect(grouped.importedRowCount).toBe(3);
    expect(grouped.markdown).toBe(
      [
        '# 季度营收',
        '## 量化',
        '### TqSdk',
        '#### Q1: 1200',
        '#### 备注: 主力',
        '### Pro',
        '#### Q1: 2500',
        '## 资讯',
        '### 研报流',
        '#### Q1: 800',
        '#### 备注: 内测',
      ].join('\n'),
    );
  });
});

describe('mindmap-excel commands insertion', () => {
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

  it('inserts inline Markdown table and tree branch cleanly under heading and list nodes', () => {
    const markdown = [
      '# 数据中心 <!-- seamind:id=root-1 -->',
      '## 财务表 <!-- seamind:id=sec-1 -->',
      '- 子项 <!-- seamind:id=item-1 -->',
    ].join('\n');
    const { root } = transformer.transform(markdownForMindmap(markdown));
    const sources = buildMarkdownNodeSourceMap(markdown, root);
    const secSource = [...sources.values()].find((s) => s.id === 'sec-1')!;
    const itemSource = [...sources.values()].find((s) => s.id === 'item-1')!;

    const withTable = applyInsertExcelTableCommand(markdown, secSource, {
      title: 'Q1 明细',
      tableMarkdown: '| 指标 | 数值 |\n| --- | --- |\n| 营收 | 1200 |',
    });
    expect(withTable.markdown).toContain('### Q1 明细');
    expect(withTable.markdown).toContain('| 指标 | 数值 |');

    const withExternalUnderList = applyInsertExcelTableCommand(
      markdown,
      itemSource,
      {
        title: '大表外链',
        excelFence: '```seamind-excel\n{"title":"Big"}\n```',
      },
    );
    expect(withExternalUnderList.markdown).toContain('  - 大表外链');
    expect(withExternalUnderList.markdown).toContain('    ```seamind-excel');

    const withTree = applyMarkdownNodeBranch(
      markdown,
      secSource,
      '# 营收树\n## 量化\n### 营收: 1200',
    );
    expect(withTree.markdown).toContain('### 营收树');
    expect(withTree.markdown).toContain('#### 量化');
  });
});
