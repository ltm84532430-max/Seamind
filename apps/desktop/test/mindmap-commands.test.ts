import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Transformer } from 'markmap-lib';
import { pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import { errorMessage } from '../src/mindmap/app-mindmap-utils';
import { normalizeMindmapPureTree } from '../src/library/app-tree-utils';
import {
  applyConvertNodeToCodeBlockCommand,
  applyInsertCodeBlockCommand,
  applyInsertImagesCommand,
  applyMarkdownNodeBranch,
  applyMarkdownNodeCommand,
  applyReplaceCodeBlockCommand,
  buildMarkdownNodeSourceMap,
  extractMarkdownCodeFences,
  findSourcePathForLine,
  markdownForMindmap,
} from '../src/mindmap/commands';
import {
  computeCodeBlockResultKey,
  detectCodeLanguageFromSource,
  getCachedCodeBlockResult,
  looksLikeMultiLineCodeSnippet,
  setCachedCodeBlockResult,
  subscribeCodeBlockResult,
  tokenizeUniversalCodeLine,
} from '../src/workbench/code-execution-service';
import { executeAgentTool } from '../src/agent/capabilities';
import { createFallbackTerminalCapabilities } from '../src/agent/tools/terminal-bridge';

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

  it('inserts, extracts, converts, and replaces fenced code blocks cleanly across depths', () => {
    const base = [
      '# 量化系统',
      '## API Client',
      '### import json&#10;import requests&#10;def fetch():&#10;    return requests.get("https://example.com")',
    ].join('\n');

    // 1. Insert titled Python code block under heading
    let parsed = buildSources(base);
    const apiNode = findSourceByLabel(parsed.sources, 'API Client');
    expect(apiNode).toBeDefined();
    const inserted = applyInsertCodeBlockCommand(base, apiNode![1], {
      language: 'python',
      title: 'K线拉取',
      code: 'import math\nprint(math.pi)',
    });
    expect(inserted.markdown).toContain('### K线拉取 <!-- seamind:id=');
    expect(inserted.markdown).toContain(
      '```python\nimport math\nprint(math.pi)\n```',
    );

    // 2. Convert legacy multi-line &#10; plain node into a proper fenced code block
    parsed = buildSources(inserted.markdown);
    const legacyNode = [...parsed.sources.values()].find((s) =>
      s.label.includes('import json'),
    );
    expect(legacyNode).toBeDefined();
    const converted = applyConvertNodeToCodeBlockCommand(
      inserted.markdown,
      legacyNode!,
    );
    const fences = extractMarkdownCodeFences(converted.markdown);
    expect(fences.length).toBe(2);
    expect(fences[0].language).toBe('python');
    expect(fences[0].source).toContain('def fetch():');
    expect(fences[1].source).toContain('print(math.pi)');

    // 3. Replace code block by blockIndex and change language
    const replaced = applyReplaceCodeBlockCommand(converted.markdown, {
      blockIndex: 1,
      language: 'cpp',
      code: 'int x = 42;\ncout << x << endl;',
    });
    const nextFences = extractMarkdownCodeFences(replaced.markdown);
    expect(nextFences[1].language).toBe('cpp');
    expect(nextFences[1].source).toBe('int x = 42;\ncout << x << endl;');
  });

  it('detects languages, tokenizes code lines, and broadcasts cached execution results', () => {
    expect(
      detectCodeLanguageFromSource('import requests\ndef run():\n    pass'),
    ).toBe('python');
    expect(
      detectCodeLanguageFromSource('#include <iostream>\nstd::cout << 1;'),
    ).toBe('cpp');
    expect(
      detectCodeLanguageFromSource(
        'SELECT symbol, close FROM klines WHERE close > 1;',
      ),
    ).toBe('sql');
    expect(
      looksLikeMultiLineCodeSnippet(
        'import json\nimport sqlite3\ndef run():\n    return 1',
      ),
    ).toBe(true);
    expect(looksLikeMultiLineCodeSnippet('普通笔记文本')).toBe(false);

    const tokens = tokenizeUniversalCodeLine('def fetch(x): # ok', 'python');
    expect(tokens.some((t) => t.kind === 'kw' && t.text === 'def')).toBe(true);
    expect(tokens.some((t) => t.kind === 'fn' && t.text === 'fetch')).toBe(
      true,
    );
    expect(
      tokens.some((t) => t.kind === 'com' && t.text.includes('# ok')),
    ).toBe(true);

    const key = computeCodeBlockResultKey('python', 'print(1)', {
      lineIndex: 2,
      endLineIndex: 5,
    });
    const received: boolean[] = [];
    const unsub = subscribeCodeBlockResult(key, (res) => {
      received.push(Boolean(res?.ok));
    });
    setCachedCodeBlockResult(key, {
      ok: true,
      language: 'python',
      runtimeLabel: 'Pyodide WASM',
      outputs: [{ kind: 'stream', name: 'stdout', text: '1\n' }],
      durationMs: 12,
      plainSummary: '1',
      errorText: '',
      timestamp: Date.now(),
    });
    expect(getCachedCodeBlockResult(key)?.plainSummary).toBe('1');
    expect(received).toEqual([true]);
    setCachedCodeBlockResult(key, null);
    unsub();
  });

  it('executes mindmap_propose_code_block and mindmap_run_code_block via agent tool router', async () => {
    const caps = {
      ...createFallbackTerminalCapabilities('量化系统'),
      proposeCodeBlock: (input: {
        baseRevision: number;
        mode: 'add_child' | 'replace';
        language: string;
        title?: string;
        code: string;
        rationale: string;
      }) => ({
        baseRevision: input.baseRevision,
        baseRelativePath: 'quant.md',
        baseMarkdown: '# 量化系统',
        baseTitle: '量化系统',
        markdown: `# 量化系统\n\n## ${input.title || '脚本'}\n\`\`\`${input.language}\n${input.code}\n\`\`\``,
        title: '量化系统',
        nodeId: 'n1',
        nodePath: '1',
        operation:
          input.mode === 'replace'
            ? ('update_code_block' as const)
            : ('add_code_block' as const),
        previousLabel: '量化系统',
        nextLabel: input.title || '脚本',
        rationale: input.rationale,
      }),
      runMindmapCodeBlock: async () => ({
        ok: true,
        language: 'python',
        runtimeLabel: 'Pyodide WASM',
        durationMs: 15,
        output: '42',
        error: '',
      }),
    };

    const proposeRes = await executeAgentTool(
      'mindmap_propose_code_block',
      JSON.stringify({
        baseRevision: 3,
        mode: 'add_child',
        nodeId: 'n1',
        language: 'python',
        title: '计算收益',
        code: 'print(42)',
        rationale: '补充验证脚本',
      }),
      caps,
    );
    expect(proposeRes.permission).toBe('user_approval');
    expect(proposeRes.proposal?.operation).toBe('add_code_block');

    const runRes = await executeAgentTool(
      'mindmap_run_code_block',
      JSON.stringify({
        language: 'python',
        code: 'print(42)',
      }),
      caps,
    );
    expect(runRes.permission).toBe('read');
    expect(runRes.result.ok).toBe(true);
    expect(runRes.result.output).toBe('42');
  });

  it('inserts images directly into placeholder 新主题 nodes and as children under populated nodes', () => {
    const base = ['# 数据获取', '## 免费版', '- 新主题'].join('\n');
    const parsed = buildSources(base);

    const placeholder = findSourceByLabel(parsed.sources, '新主题');
    expect(placeholder).toBeDefined();
    const replaced = applyInsertImagesCommand(base, placeholder![1], [
      { markdown: '![架构图](seamind-media:abc123)' },
    ]);
    expect(replaced.markdown).toContain('- ![架构图](seamind-media:abc123)');
    expect(replaced.markdown).not.toContain('新主题');

    const parsedAfter = buildSources(replaced.markdown);
    const heading = findSourceByLabel(parsedAfter.sources, '免费版');
    expect(heading).toBeDefined();
    const appended = applyInsertImagesCommand(replaced.markdown, heading![1], [
      { markdown: '![图1](seamind-media:img1)' },
      { markdown: '![图2](seamind-media:img2)' },
    ]);
    expect(appended.markdown).toContain('### ![图1](seamind-media:img1)');
    expect(appended.markdown).toContain('### ![图2](seamind-media:img2)');
  });
});
