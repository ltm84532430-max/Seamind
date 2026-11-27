import { describe, expect, it } from 'vitest';
import type { ActiveWorkspace } from '../src/app/app-storage';
import { agentToolCatalog, executeAgentTool } from '../src/agent/capabilities';
import {
  buildWorkspaceContextPrompt,
  createFallbackTerminalCapabilities,
  formatWorkspaceFocusBadge,
  resolveWorkspaceToolNames,
  selectTerminalAgentToolNames,
} from '../src/agent/tools/terminal-bridge';
import {
  getActiveLabTabSnapshot,
  setActiveLabTabSnapshot,
  subscribeActiveLabTabSnapshot,
} from '../src/terminal/codelab-live-bridge';
import type { AgentWorkspaceContextSnapshot } from '../src/terminal/terminal-types';

function makeKnowledgeDocContext(
  overrides?: Partial<AgentWorkspaceContextSnapshot>,
): AgentWorkspaceContextSnapshot {
  return {
    primaryWorkspace: 'knowledge',
    secondaryWorkspace: 'agent',
    splitActive: true,
    visibleWorkspaces: ['knowledge'],
    targetWorkspace: 'knowledge',
    targetPosition: 'left',
    targetSubView: 'doc',
    activeKnowledgeDoc: {
      title: '1. Introduction, Financial Terms and Concepts',
      relativePath: '视频笔记/1. Introduction, Financial Terms and Concepts.md',
      category: '视频笔记',
      charCount: 56027,
      lineCount: 413,
      openTabs: [
        {
          title: '1. Introduction, Financial Terms and Concepts',
          relativePath:
            '视频笔记/1. Introduction, Financial Terms and Concepts.md',
          active: true,
        },
        {
          title: 'MIT 6.858 Computer Systems',
          relativePath: '视频笔记/MIT 6.858 Computer Systems.md',
          active: false,
        },
      ],
    },
    activeMindmap: {
      title: 'Computer Systems: A Programmer’s Perspective, 2/e',
      relativePath: 'books/CSAPP.md',
    },
    activeLab: null,
    activeBook: null,
    ...overrides,
  };
}

describe('agent primary-page-first workspace tool routing', () => {
  const knownTools = new Set(agentToolCatalog.map((t) => t.name));

  it('scopes tools strictly to knowledge document tools when knowledge is the primary split pane', () => {
    const ctx = makeKnowledgeDocContext();
    const tools = selectTerminalAgentToolNames(
      null,
      '可以看见左边的知识库文档吗，你可以翻译它吗',
      { workspaceContext: ctx, scopeMode: 'focused' },
    );

    expect(tools).toEqual([
      'knowledge_get_current_document',
      'knowledge_propose_document_edit',
      'library_search',
      'library_read_document',
    ]);
    expect(tools).not.toContain('mindmap_get_current');
    expect(tools).not.toContain('terminal_read_pane');
    expect(tools).not.toContain('knowledge_get_book_note');
    expect(tools).not.toContain('datalab_query_sql');
  });

  it('appends cli_delegate in hybrid mode while preserving focused workspace isolation', () => {
    const ctx = makeKnowledgeDocContext();
    const tools = selectTerminalAgentToolNames(null, '翻译这篇文档', {
      workspaceContext: ctx,
      scopeMode: 'focused',
      includeCliDelegate: true,
    });

    expect(tools[0]).toBe('knowledge_get_current_document');
    expect(tools).toContain('cli_delegate');
    expect(tools).not.toContain('mindmap_get_current');
    expect(tools).not.toContain('terminal_read_pane');
  });

  it('prioritizes ER tools when lab is displaying ER Studio, and notebook tools when displaying Code Lab', () => {
    const erCtx = makeKnowledgeDocContext({
      primaryWorkspace: 'lab',
      visibleWorkspaces: ['lab'],
      targetWorkspace: 'lab',
      targetSubView: 'er',
      activeLab: {
        mode: 'er',
        title: 'ER · us_market',
        erConnectionId: 'conn-us-market',
      },
    });
    const erTools = selectTerminalAgentToolNames(null, '检查外键关系', {
      workspaceContext: erCtx,
      scopeMode: 'focused',
    });
    expect(erTools.slice(0, 2)).toEqual([
      'datalab_er_get_diagram',
      'datalab_er_annotate',
    ]);
    expect(erTools).not.toContain('mindmap_get_current');
    expect(erTools).not.toContain('knowledge_get_current_document');

    const nbCtx = {
      ...erCtx,
      targetSubView: 'notebook' as const,
      activeLab: { mode: 'notebook' as const, title: '数据库分析.ipynb' },
    };
    const nbTools = selectTerminalAgentToolNames(null, '补全当前分析代码', {
      workspaceContext: nbCtx,
      scopeMode: 'focused',
    });
    expect(nbTools.slice(0, 4)).toEqual([
      'datalab_read_notebook',
      'datalab_update_cell',
      'datalab_push_cell',
      'datalab_run_cell',
    ]);
  });

  it('returns valid catalog tools for every workspace in resolveWorkspaceToolNames', () => {
    const workspaces: ActiveWorkspace[] = [
      'knowledge',
      'mindmap',
      'lab',
      'reader',
      'player',
      'exams',
      'literature',
      'feed',
      'terminal',
      'tasks',
      'agent',
    ];
    for (const ws of workspaces) {
      const names = resolveWorkspaceToolNames(ws);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(knownTools.has(name)).toBe(true);
      }
    }
  });

  it('unions tools when multiple business workspaces are visible or cross-module #mentions are attached', () => {
    const multiPaneCtx = makeKnowledgeDocContext({
      secondaryWorkspace: 'lab',
      visibleWorkspaces: ['knowledge', 'lab'],
    });
    const multiTools = selectTerminalAgentToolNames(
      null,
      '结合左边文档跑 SQL',
      {
        workspaceContext: multiPaneCtx,
        scopeMode: 'focused',
      },
    );
    expect(multiTools[0]).toBe('knowledge_get_current_document');
    expect(multiTools).toContain('datalab_query_sql');
    expect(multiTools).not.toContain('player_search_youtube');

    const mentionTools = selectTerminalAgentToolNames(
      null,
      '结合 #data 验证文档中的金融指标',
      {
        workspaceContext: makeKnowledgeDocContext(),
        scopeMode: 'focused',
        mentions: [{ tag: '#data' }],
      },
    );
    expect(mentionTools[0]).toBe('knowledge_get_current_document');
    expect(mentionTools).toContain('datalab_query_sql');
    expect(mentionTools).toContain('datalab_list_sources');
  });

  it('unlocks full catalog for explicit scopeMode=all or standalone fullscreen agent, and lets /commands override focus', () => {
    const ctx = makeKnowledgeDocContext();
    const allModeTools = selectTerminalAgentToolNames(null, '跨模块分析', {
      workspaceContext: ctx,
      scopeMode: 'all',
    });
    expect(allModeTools.length).toBe(agentToolCatalog.length);

    const standaloneAgentCtx = makeKnowledgeDocContext({
      primaryWorkspace: 'agent',
      secondaryWorkspace: null,
      splitActive: false,
      visibleWorkspaces: [],
      targetWorkspace: null,
      targetPosition: 'none',
      targetSubView: 'default',
    });
    const standaloneTools = selectTerminalAgentToolNames(null, '帮我总结一下', {
      workspaceContext: standaloneAgentCtx,
      scopeMode: 'focused',
    });
    expect(standaloneTools.length).toBe(agentToolCatalog.length);

    const slashOverride = selectTerminalAgentToolNames('/data', '/data 查表', {
      workspaceContext: ctx,
      scopeMode: 'focused',
    });
    expect(slashOverride).toContain('datalab_query_sql');
  });

  it('formats accurate live UI state prompts and topbar focus badges', () => {
    const ctx = makeKnowledgeDocContext();
    const prompt = buildWorkspaceContextPrompt(ctx, 'focused');
    expect(prompt).toContain('左侧主页面：知识库');
    expect(prompt).toContain('1. Introduction, Financial Terms and Concepts');
    expect(prompt).toContain('56,027 字');
    expect(prompt).toContain('knowledge_get_current_document');
    expect(prompt).toContain('knowledge_propose_document_edit');
    expect(prompt).toContain('严禁把后台未显示的思维导图当成当前文档');

    const badge = formatWorkspaceFocusBadge(ctx, 'focused');
    expect(badge.shortLabel).toBe('聚焦 左侧 · 知识库文档');
    expect(badge.isFocusedMode).toBe(true);

    const rightBadge = formatWorkspaceFocusBadge(
      makeKnowledgeDocContext({
        primaryWorkspace: 'agent',
        secondaryWorkspace: 'knowledge',
        targetPosition: 'right',
      }),
      'focused',
    );
    expect(rightBadge.shortLabel).toBe('聚焦 右侧 · 知识库文档');

    const allBadge = formatWorkspaceFocusBadge(ctx, 'all');
    expect(allBadge.shortLabel).toBe('全模块模式');
    expect(allBadge.isFocusedMode).toBe(false);

    const standaloneBadge = formatWorkspaceFocusBadge(
      makeKnowledgeDocContext({
        primaryWorkspace: 'agent',
        secondaryWorkspace: null,
        splitActive: false,
        targetWorkspace: null,
        targetPosition: 'none',
      }),
      'focused',
    );
    expect(standaloneBadge.shortLabel).toBe('独立中枢 · 全模块');
  });

  it('reads long knowledge documents in offset chunks with heading directory and builds edit proposals', async () => {
    const section1 = `# 1. Introduction, Financial Terms and Concepts\n\n${'Financial markets overview. '.repeat(600)}\n\n`;
    const section2 = `## 00:00 - 03:35 · Course Intro\n\n${'Arbitrage and risk-free rate details. '.repeat(800)}\n\n`;
    const section3 = `### Risk Premium\n\nFinal summary paragraph.`;
    const fullMarkdown = `${section1}${section2}${section3}`;

    const caps = {
      ...createFallbackTerminalCapabilities('CSAPP'),
      readCurrentKnowledgeDocument: () => ({
        title: '1. Introduction, Financial Terms and Concepts',
        relativePath:
          '视频笔记/1. Introduction, Financial Terms and Concepts.md',
        category: '视频笔记',
        kind: 'doc' as const,
        markdown: fullMarkdown,
        dirty: false,
        openTabs: [
          {
            title: '1. Introduction, Financial Terms and Concepts',
            relativePath:
              '视频笔记/1. Introduction, Financial Terms and Concepts.md',
            active: true,
          },
        ],
      }),
    };

    const chunk1 = await executeAgentTool(
      'knowledge_get_current_document',
      JSON.stringify({ offset: 0, maxChars: 10000 }),
      caps,
    );
    expect(chunk1.permission).toBe('read');
    expect(chunk1.result.totalChars).toBe(fullMarkdown.length);
    expect((chunk1.result.content as string).length).toBe(10000);
    expect(chunk1.result.nextOffset).toBe(10000);
    expect(
      (chunk1.result.headings as Array<{ text: string }>).map((h) => h.text),
    ).toEqual([
      '1. Introduction, Financial Terms and Concepts',
      '00:00 - 03:35 · Course Intro',
      'Risk Premium',
    ]);

    const chunk2 = await executeAgentTool(
      'knowledge_get_current_document',
      JSON.stringify({ offset: chunk1.result.nextOffset, maxChars: 24000 }),
      caps,
    );
    expect(chunk2.result.offset).toBe(10000);
    expect(chunk2.result.nextOffset).toBe(34000);
    expect((chunk2.result.content as string).length).toBe(24000);

    const proposalRes = await executeAgentTool(
      'knowledge_propose_document_edit',
      JSON.stringify({
        mode: 'create_copy',
        newTitle: '1. 金融术语与概念导论（中文译文）',
        content: '# 1. 金融术语与概念导论\n\n中文翻译正文。',
        rationale: '将左侧英文视频笔记完整翻译并另存为中文副本，保留原文不变。',
      }),
      caps,
    );
    expect(proposalRes.permission).toBe('user_approval');
    expect(proposalRes.knowledgeDocumentProposal).toEqual({
      mode: 'create_copy',
      targetTitle: '1. Introduction, Financial Terms and Concepts',
      targetRelativePath:
        '视频笔记/1. Introduction, Financial Terms and Concepts.md',
      targetCategory: '视频笔记',
      newTitle: '1. 金融术语与概念导论（中文译文）',
      content: '# 1. 金融术语与概念导论\n\n中文翻译正文。',
      rationale: '将左侧英文视频笔记完整翻译并另存为中文副本，保留原文不变。',
    });

    await expect(
      executeAgentTool(
        'knowledge_get_current_document',
        '{}',
        createFallbackTerminalCapabilities('CSAPP'),
      ),
    ).rejects.toThrow('当前知识库工作区尚未打开任何 Markdown 文档');
  });

  it('tracks and notifies active Lab tab mode changes (notebook vs er)', () => {
    let calls = 0;
    const unsub = subscribeActiveLabTabSnapshot(() => {
      calls += 1;
    });
    setActiveLabTabSnapshot({
      mode: 'er',
      title: 'ER · us_market',
      erConnectionId: 'conn-1',
    });
    expect(getActiveLabTabSnapshot()).toEqual({
      mode: 'er',
      title: 'ER · us_market',
      erConnectionId: 'conn-1',
    });
    const afterFirst = calls;
    // Duplicate identical snapshot should not fire redundant notifications
    setActiveLabTabSnapshot({
      mode: 'er',
      title: 'ER · us_market',
      erConnectionId: 'conn-1',
    });
    expect(calls).toBe(afterFirst);

    setActiveLabTabSnapshot({
      mode: 'notebook',
      title: '数据库分析.ipynb',
      erConnectionId: null,
    });
    expect(calls).toBe(afterFirst + 1);
    expect(getActiveLabTabSnapshot()?.mode).toBe('notebook');
    unsub();
    setActiveLabTabSnapshot(null);
  });
});
