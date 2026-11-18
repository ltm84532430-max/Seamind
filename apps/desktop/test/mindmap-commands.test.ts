import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Transformer } from 'markmap-lib';
import { pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import { errorMessage } from '../src/mindmap/app-mindmap-utils';
import { normalizeMindmapPureTree } from '../src/library/app-tree-utils';
import {
  applyMarkdownNodeBranch,
  applyMarkdownNodeCommand,
  buildMarkdownNodeSourceMap,
  findSourcePathForLine,
  markdownForMindmap,
} from '../src/mindmap/commands';

const transformer = new Transformer([pluginFrontmatter, pluginSourceLines]);

const originalDocument = globalThis.document;

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => {
        let html = '';
        return {
          set innerHTML(v: string) {
            html = String(v);
          },
          get value() {
            return html;
          },
        };
      },
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

function buildSources(markdown: string) {
  const { root } = transformer.transform(markdownForMindmap(markdown));
  return {
    root,
    sources: buildMarkdownNodeSourceMap(markdown, root),
  };
}

function findSourceByLabel(
  sources: ReturnType<typeof buildMarkdownNodeSourceMap>,
  label: string,
) {
  return [...sources.entries()].find(([, src]) => src.label === label);
}

describe('mindmap deep hierarchy & node commands', () => {
  it('surfaces Error.message in errorMessage instead of dropping to fallback', () => {
    expect(errorMessage(new Error('具体报错原因'), '兜底文本')).toBe(
      '具体报错原因',
    );
    expect(errorMessage('字符串报错', '兜底文本')).toBe('字符串报错');
    expect(errorMessage({}, '兜底文本')).toBe('兜底文本');
  });

  it('adds unlimited-depth children beneath ###### (H6) headings via nested lists', () => {
    let md = [
      '# 量化系统',
      '## 数据',
      '### 数据获取',
      '#### API获取',
      '##### 落地步骤',
      '###### API Client（请求客户端）',
      '###### Collector（采集控制器）',
      '',
      '##### 后续阶段',
    ].join('\n');

    // Step 1: add child under H6 Collector
    let parsed = buildSources(md);
    const collector = findSourceByLabel(
      parsed.sources,
      'Collector（采集控制器）',
    );
    expect(collector).toBeDefined();
    expect(collector![1].level).toBe(6);

    const cmd1 = applyMarkdownNodeCommand(
      md,
      collector![1],
      'add_child',
      '断点续传模块',
    );
    md = cmd1.markdown;
    expect(md).toContain('- 断点续传模块 <!-- seamind:id=');

    // Step 2: add child under Depth 7 list node -> Depth 8
    parsed = buildSources(md);
    const depth7 = findSourceByLabel(parsed.sources, '断点续传模块');
    expect(depth7).toBeDefined();
    expect(depth7![1].kind).toBe('list');
    // Must sit hierarchically beneath Collector
    expect(depth7![0].startsWith(`${collector![0]}.`)).toBe(true);

    const cmd2 = applyMarkdownNodeCommand(
      md,
      depth7![1],
      'add_child',
      '游标持久化',
    );
    md = cmd2.markdown;
    expect(md).toContain('  - 游标持久化 <!-- seamind:id=');

    // Step 3: add child under Depth 8 -> Depth 9
    parsed = buildSources(md);
    const depth8 = findSourceByLabel(parsed.sources, '游标持久化');
    expect(depth8).toBeDefined();
    expect(depth8![0].startsWith(`${depth7![0]}.`)).toBe(true);

    const cmd3 = applyMarkdownNodeCommand(
      md,
      depth8![1],
      'add_child',
      'Redis Checkpoint',
    );
    md = cmd3.markdown;
    expect(md).toContain('    - Redis Checkpoint <!-- seamind:id=');

    // Verify shortest-range lookup selects Depth 9 node when cursor is on cmd3.lineIndex
    parsed = buildSources(md);
    const selectedPath = findSourcePathForLine(cmd3.lineIndex, parsed.sources);
    expect(parsed.sources.get(selectedPath!)?.label).toBe('Redis Checkpoint');
  });

  it('indents ordered list children by marker width so nested items stay children in CommonMark', () => {
    const md = '# Root\n1. First Step\n2. Second Step\n';
    const parsed = buildSources(md);
    const first = findSourceByLabel(parsed.sources, 'First Step');
    expect(first).toBeDefined();

    const cmd = applyMarkdownNodeCommand(md, first![1], 'add_child', 'Substep');
    const nextParsed = buildSources(cmd.markdown);
    const sub = findSourceByLabel(nextParsed.sources, 'Substep');
    expect(sub).toBeDefined();
    expect(sub![0].startsWith(`${first![0]}.`)).toBe(true);
  });

  it('ignores headings inside code fences when computing subtree end', () => {
    const md = [
      '## Section A',
      '```python',
      '# Python comment should not close Section A',
      'x = 1',
      '```',
      '## Section B',
    ].join('\n');
    const parsed = buildSources(md);
    const secA = findSourceByLabel(parsed.sources, 'Section A');
    expect(secA).toBeDefined();

    const cmd = applyMarkdownNodeCommand(md, secA![1], 'add_child', 'Child A1');
    const lines = cmd.markdown.split('\n');
    const secBIndex = lines.findIndex((l) => l.startsWith('## Section B'));
    const childIndex = lines.findIndex((l) => l.includes('### Child A1'));
    expect(childIndex).toBeGreaterThan(
      lines.findIndex((l) => l.trim() === '```' && lines.indexOf(l) > 1),
    );
    expect(childIndex).toBeLessThan(secBIndex);
  });

  it('converts deep AI branch headings (> H6) into nested list hierarchy', () => {
    const md = '###### Collector\n';
    const parsed = buildSources(md);
    const collector = findSourceByLabel(parsed.sources, 'Collector');
    expect(collector).toBeDefined();

    const result = applyMarkdownNodeBranch(
      md,
      collector![1],
      '# 限流器\n## 令牌桶参数\n说明正文',
    );
    expect(result.markdown).toContain('- 限流器 <!-- seamind:id=');
    expect(result.markdown).toContain('  - 令牌桶参数 <!-- seamind:id=');
  });

  it('unwraps empty <ul>/<ol> wrappers when mixing list styles under a heading', () => {
    const md = [
      '# 系统架构',
      '## 数据库选择',
      '1. PostgreSQL',
      '- Redis <!-- seamind:id=r1 -->',
    ].join('\n');
    const { root } = transformer.transform(markdownForMindmap(md));
    const normalized = normalizeMindmapPureTree(root);
    const dbNode = normalized.children[0];
    expect(
      dbNode?.children.every((child) => child.content.trim().length > 0),
    ).toBe(true);
    expect(dbNode?.children.map((child) => child.content)).toEqual([
      '1. PostgreSQL',
      'Redis',
    ]);
  });

  it('maps empty heading/list nodes so they remain selectable and deletable, and blocks blank rename', () => {
    const md = [
      '##### 数据库选择',
      '###### <!-- seamind:id=empty-h6 -->',
      '###### 正常子节点 <!-- seamind:id=ok-h6 -->',
      '- ',
      '- 正常列表项 <!-- seamind:id=ok-li -->',
    ].join('\n');
    const parsed = buildSources(md);
    const emptySources = [...parsed.sources.values()].filter(
      (s) => s.label === '',
    );
    expect(emptySources.length).toBe(2);

    const emptyHeading = emptySources.find((s) => s.kind === 'heading');
    const emptyList = emptySources.find((s) => s.kind === 'list');
    expect(emptyHeading).toBeDefined();
    expect(emptyList).toBeDefined();

    const deletedHeading = applyMarkdownNodeCommand(
      md,
      emptyHeading!,
      'delete',
    );
    expect(deletedHeading.markdown).not.toContain('empty-h6');

    const deletedList = applyMarkdownNodeCommand(md, emptyList!, 'delete');
    expect(deletedList.markdown).not.toContain('\n- \n');

    const okNode = findSourceByLabel(parsed.sources, '正常子节点');
    expect(okNode).toBeDefined();
    expect(() =>
      applyMarkdownNodeCommand(md, okNode![1], 'rename', '   '),
    ).toThrow('节点文本不能为空');
  });
});
