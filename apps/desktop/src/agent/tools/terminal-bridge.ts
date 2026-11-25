import { epubApi } from '../../ebook/epub-api';
import { literatureApi } from '../../literature/literature-api';
import { systemApi } from '../../system/system-api';
import { terminalApi } from '../../terminal/terminal-api';
import type {
  AgentCapabilities,
  AgentToolResult,
  ToolHandler,
} from '../tool-api';
import type { AgentToolDescriptor } from '../types';
import {
  DATALAB_TOOL_NAMES,
  datalabHandlers,
  datalabToolCatalog,
} from './datalab-tools';
import { assertOnlyKeys, requireString, schema } from './parse';

export function createFallbackTerminalCapabilities(
  activeMindmapTitle?: string | null,
): AgentCapabilities {
  const title = activeMindmapTitle || '当前未打开导图';
  return {
    getCurrentMindmap: () => ({
      title,
      revision: 0,
      relativePath: null,
      nodeCount: 0,
      truncated: false,
      markdown: '',
      root: {
        path: '0',
        nodeId: null,
        label: title,
        note: '',
        noteTruncated: false,
        allowedOperations: [],
        editable: false,
        children: [],
      },
    }),
    searchLibrary: async () => [],
    readDocument: async () => {
      throw new Error('文档读取能力未初始化');
    },
    proposeNodeEdit: () => {
      throw new Error('导图节点能力未初始化');
    },
    proposeNodeBranch: () => {
      throw new Error('导图分支能力未初始化');
    },
  };
}

const terminalSystemToolCatalog: AgentToolDescriptor[] = [
  {
    version: 1,
    name: 'code_run_c',
    description:
      '使用本机 GCC / G++ 编译器沙盒编译并运行 C 或 C++ 代码，支持可选 stdin 输入，返回编译期或运行期输出与耗时。',
    permission: 'read',
    inputSchema: schema(
      {
        source: { type: 'string', minLength: 1, maxLength: 32_000 },
        stdinInput: { type: 'string', maxLength: 8_000 },
        isCpp: { type: 'boolean' },
      },
      ['source'],
    ),
  },
  {
    version: 1,
    name: 'exam_list_papers',
    description:
      '列出电子书试卷中心已保存的试卷（包含书名、章节、得分、及复习状态）。',
    permission: 'read',
    inputSchema: schema({
      bookKey: { type: 'string', maxLength: 300 },
    }),
  },
  {
    version: 1,
    name: 'exam_get_paper',
    description:
      '按 examId 读取单份电子书试卷的完整题目、得分、用户答案及错题解析。',
    permission: 'read',
    inputSchema: schema(
      {
        examId: { type: 'string', minLength: 1, maxLength: 160 },
        bookKey: { type: 'string', maxLength: 300 },
      },
      ['examId'],
    ),
  },
  {
    version: 1,
    name: 'literature_list_papers',
    description:
      '从 Seamind 论文库检索已收藏论文的标题、作者、年份、阅读状态与备注。',
    permission: 'read',
    inputSchema: schema({
      query: { type: 'string', maxLength: 200 },
    }),
  },
  {
    version: 1,
    name: 'terminal_read_pane',
    description:
      '只读抓取当前终端工作区某个分屏窗格（#pane:1..#pane:4）的近期屏幕文本输出与当前工作目录，用于诊断报错。',
    permission: 'read',
    inputSchema: schema({
      paneIndex: { type: 'integer', minimum: 1, maximum: 4 },
      maxLines: { type: 'integer', minimum: 10, maximum: 200 },
    }),
  },
  {
    version: 1,
    name: 'terminal_send_command',
    description:
      '向终端工作区的指定 Shell 窗格发送一条待执行命令提案，提交后会在界面弹出确认按钮，用户确认后才会实际键入执行。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        command: { type: 'string', minLength: 1, maxLength: 2_000 },
        paneIndex: { type: 'integer', minimum: 1, maximum: 4 },
        reason: { type: 'string', maxLength: 400 },
      },
      ['command'],
    ),
  },
  {
    version: 1,
    name: 'cli_delegate',
    description:
      '套娃协同工具：把需要深度读写代码仓库、本地系统命令或专项长程推理的子任务委派给本机无头 CLI 模型（claude / codex / agy），CLI 仍可通过 MCP 访问 Seamind 数据，完成后返回汇总结果。',
    permission: 'read',
    inputSchema: schema(
      {
        engine: {
          type: 'string',
          enum: ['claude', 'codex', 'agy', 'gemini'],
        },
        prompt: { type: 'string', minLength: 1, maxLength: 12_000 },
        attachMcp: { type: 'boolean' },
        model: {
          type: 'string',
          maxLength: 160,
          description: '可选：指定该 CLI 使用的模型名',
        },
      },
      ['engine', 'prompt'],
    ),
  },
];

export const terminalBridgeToolCatalog: AgentToolDescriptor[] = [
  ...datalabToolCatalog,
  ...terminalSystemToolCatalog,
];

const CROSS_SURFACE_FULL_TOOL_NAMES: readonly string[] = [
  ...DATALAB_TOOL_NAMES,
  'code_run_c',
  'terminal_read_pane',
  'terminal_send_command',
  'cli_delegate',
  'library_search',
  'library_read_document',
  'mindmap_get_current',
  'mindmap_propose_node_edit',
  'mindmap_propose_node_branch',
  'mindmap_propose_code_block',
  'mindmap_run_code_block',
  'epub_get_current_chapter',
  'epub_propose_footnote',
  'knowledge_get_book_note',
  'knowledge_update_book_note',
  'knowledge_query_book_galaxy',
  'knowledge_sync_reader_chapter',
  'knowledge_append_excerpt',
  'exam_list_papers',
  'exam_get_paper',
  'literature_list_papers',
  'rss_get_current_article',
  'rss_list_subscriptions',
  'rss_add_subscription',
  'player_search_youtube',
  'learning_path_list',
  'learning_path_get',
  'learning_path_propose',
  'favorites_get_board',
  'favorites_propose_categorization',
];

function dedupeToolNames(
  prioritized: readonly string[],
  fallback?: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of fallback ? [prioritized, fallback] : [prioritized]) {
    for (const name of list) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

export function selectTerminalAgentToolNames(
  slashCommand: string | null,
  promptText: string,
): string[] {
  switch (slashCommand) {
    case '/book':
      return dedupeToolNames([
        'epub_get_current_chapter',
        'knowledge_get_book_note',
        'knowledge_query_book_galaxy',
        'knowledge_update_book_note',
        'knowledge_append_excerpt',
        'knowledge_sync_reader_chapter',
        'epub_propose_footnote',
        'library_search',
        'library_read_document',
        'cli_delegate',
      ]);
    case '/kb':
    case '/map':
      return dedupeToolNames([
        'mindmap_get_current',
        'library_search',
        'library_read_document',
        'mindmap_propose_node_edit',
        'mindmap_propose_node_branch',
        'mindmap_propose_code_block',
        'mindmap_run_code_block',
        'knowledge_get_book_note',
        'knowledge_update_book_note',
        'cli_delegate',
      ]);
    case '/exam':
      return dedupeToolNames([
        'exam_list_papers',
        'exam_get_paper',
        'epub_get_current_chapter',
        'library_search',
        'code_run_c',
        'code_run_python',
        'cli_delegate',
      ]);
    case '/player':
      return dedupeToolNames([
        'player_search_youtube',
        'learning_path_list',
        'learning_path_get',
        'learning_path_propose',
        'favorites_get_board',
        'favorites_propose_categorization',
      ]);
    case '/paper':
      return dedupeToolNames([
        'literature_list_papers',
        'library_search',
        'library_read_document',
        'mindmap_propose_node_branch',
        'cli_delegate',
      ]);
    case '/rss':
      return dedupeToolNames([
        'rss_get_current_article',
        'rss_list_subscriptions',
        'rss_add_subscription',
        'library_search',
        'cli_delegate',
      ]);
    case '/data':
      return dedupeToolNames([
        ...DATALAB_TOOL_NAMES,
        'terminal_read_pane',
        'terminal_send_command',
        'cli_delegate',
      ]);
    case '/code':
    case '/exec':
      return dedupeToolNames([
        ...DATALAB_TOOL_NAMES,
        'code_run_c',
        'terminal_read_pane',
        'terminal_send_command',
        'library_search',
        'library_read_document',
        'cli_delegate',
      ]);
    default: {
      const lower = promptText.toLowerCase();
      if (
        lower.includes('youtube') ||
        lower.includes('视频') ||
        lower.includes('学习路径')
      ) {
        return dedupeToolNames(
          [
            'player_search_youtube',
            'learning_path_list',
            'learning_path_get',
            'learning_path_propose',
            'favorites_get_board',
            'favorites_propose_categorization',
          ],
          CROSS_SURFACE_FULL_TOOL_NAMES,
        );
      }
      return dedupeToolNames(CROSS_SURFACE_FULL_TOOL_NAMES);
    }
  }
}

export const terminalBridgeHandlers: Record<string, ToolHandler> = {
  ...datalabHandlers,

  async code_run_c(input, capabilities): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['source', 'stdinInput', 'isCpp']);
    const source = requireString(input, 'source', 32_000);
    const stdinInput =
      typeof input.stdinInput === 'string' ? input.stdinInput : '';
    const isCpp = input.isCpp === true;
    const result = capabilities.runCSnippet
      ? await capabilities.runCSnippet({ source, stdin: stdinInput, isCpp })
      : await systemApi.runCCode({
          source,
          stdinInput: stdinInput || null,
          isCpp,
        });
    return {
      version: 1,
      permission: 'read',
      name: 'code_run_c',
      label: isCpp ? '编译运行 C++' : '编译运行 C',
      summary: (result as { success?: boolean }).success
        ? '编译并运行成功'
        : '编译或运行返回非零状态',
      result: result as Record<string, unknown>,
    };
  },

  async exam_list_papers(input, capabilities): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['bookKey']);
    const bookKey =
      typeof input.bookKey === 'string' && input.bookKey.trim()
        ? input.bookKey.trim()
        : undefined;
    if (capabilities.listExams) {
      const result = await capabilities.listExams({ bookKey });
      return {
        version: 1,
        permission: 'read',
        name: 'exam_list_papers',
        label: '读取试卷清单',
        summary: '已获取电子书试卷记录',
        result,
      };
    }
    const exams = await epubApi.listExams({ bookKey: bookKey ?? null });
    return {
      version: 1,
      permission: 'read',
      name: 'exam_list_papers',
      label: '读取试卷清单',
      summary: `已读取 ${exams.length} 份试卷`,
      result: {
        count: exams.length,
        exams: exams.slice(0, 25),
      },
    };
  },

  async exam_get_paper(input, capabilities): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['examId', 'bookKey']);
    const examId = requireString(input, 'examId', 160);
    if (capabilities.getExamDetail) {
      const result = await capabilities.getExamDetail({ examId });
      return {
        version: 1,
        permission: 'read',
        name: 'exam_get_paper',
        label: '读取试卷详情',
        summary: '已加载试卷题目与作答记录',
        result,
      };
    }
    let bookKey =
      typeof input.bookKey === 'string' && input.bookKey.trim()
        ? input.bookKey.trim()
        : '';
    if (!bookKey) {
      const all = await epubApi.listExams({ bookKey: null });
      bookKey = all.find((item) => item.id === examId)?.bookKey ?? '';
    }
    if (!bookKey) {
      throw new Error(`未找到试卷 ${examId} 所属的书籍标识 (bookKey)。`);
    }
    const exam = await epubApi.getExam({ bookKey, examId });
    return {
      version: 1,
      permission: 'read',
      name: 'exam_get_paper',
      label: '读取试卷详情',
      summary: `已读取试卷《${exam.bookTitle} · ${exam.sourceSectionLabel}》`,
      result: { exam },
    };
  },

  async literature_list_papers(input, capabilities): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['query']);
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (capabilities.listLiteraturePapers) {
      const result = await capabilities.listLiteraturePapers({ query });
      return {
        version: 1,
        permission: 'read',
        name: 'literature_list_papers',
        label: '检索论文库',
        summary: '已检索本地论文库',
        result,
      };
    }
    const papers = await literatureApi.list(query ? { query } : {});
    return {
      version: 1,
      permission: 'read',
      name: 'literature_list_papers',
      label: '检索论文库',
      summary: `匹配到 ${papers.length} 篇论文`,
      result: {
        count: papers.length,
        papers: papers.slice(0, 20).map((p) => ({
          id: p.id,
          title: p.title,
          authors: p.authors,
          year: p.year,
          venue: p.venue,
          readStatus: p.readStatus,
          notes: p.notes?.slice(0, 400) ?? '',
        })),
      },
    };
  },

  async terminal_read_pane(input, capabilities): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['paneIndex', 'maxLines']);
    const paneIndex =
      typeof input.paneIndex === 'number' && Number.isFinite(input.paneIndex)
        ? Math.max(1, Math.min(4, Math.floor(input.paneIndex)))
        : 1;
    const maxLines =
      typeof input.maxLines === 'number' && Number.isFinite(input.maxLines)
        ? Math.max(10, Math.min(200, Math.floor(input.maxLines)))
        : 80;
    if (!capabilities.readTerminalPane) {
      throw new Error('当前终端工作区暂未打开可读窗格。');
    }
    const result = await capabilities.readTerminalPane({ paneIndex, maxLines });
    return {
      version: 1,
      permission: 'read',
      name: 'terminal_read_pane',
      label: `读取终端窗格 #${paneIndex}`,
      summary: `已截取窗格 #${paneIndex} 最近屏幕输出`,
      result,
    };
  },

  async terminal_send_command(input, capabilities): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['command', 'paneIndex', 'reason']);
    const command = requireString(input, 'command', 2_000);
    const paneIndex =
      typeof input.paneIndex === 'number' && Number.isFinite(input.paneIndex)
        ? Math.max(1, Math.min(4, Math.floor(input.paneIndex)))
        : 1;
    const reason =
      typeof input.reason === 'string' && input.reason.trim()
        ? input.reason.trim()
        : '终端智能体建议执行的命令';
    if (!capabilities.proposeTerminalCommand) {
      throw new Error('当前终端窗格不支持外部命令写入提案。');
    }
    await capabilities.proposeTerminalCommand({ command, paneIndex, reason });
    return {
      version: 1,
      permission: 'user_approval',
      name: 'terminal_send_command',
      label: `向窗格 #${paneIndex} 发送命令`,
      summary: `等待确认命令：${command.slice(0, 60)}`,
      result: {
        status: 'pending_approval',
        paneIndex,
        command,
        reason,
      },
      terminalCommandProposal: {
        command,
        paneIndex,
        reason,
      },
    };
  },

  async cli_delegate(input, capabilities): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['engine', 'prompt', 'attachMcp', 'model']);
    const engine = requireString(input, 'engine', 24).toLowerCase();
    if (
      engine !== 'claude' &&
      engine !== 'codex' &&
      engine !== 'agy' &&
      engine !== 'gemini'
    ) {
      throw new Error(
        'cli_delegate 仅支持 claude / codex / agy / gemini 引擎。',
      );
    }
    const prompt = requireString(input, 'prompt', 12_000);
    const attachMcp = input.attachMcp !== false;
    const model =
      typeof input.model === 'string' && input.model.trim()
        ? input.model.trim()
        : undefined;
    if (capabilities.delegateCliAgent) {
      const result = await capabilities.delegateCliAgent({
        engine,
        prompt,
        attachMcp,
        model,
      });
      return {
        version: 1,
        permission: 'read',
        name: 'cli_delegate',
        label: `套娃协同 · ${engine.toUpperCase()} CLI`,
        summary: `已完成 ${engine} 子智能体执行`,
        result,
      };
    }
    const runId = `subcli-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const runRes = await terminalApi.runCliAgent({
      runId,
      engine,
      prompt,
      attachMcp,
      model: model ?? null,
    });
    return {
      version: 1,
      permission: 'read',
      name: 'cli_delegate',
      label: `套娃协同 · ${engine.toUpperCase()} CLI`,
      summary: runRes.success
        ? `${engine} CLI 完成协同（${runRes.durationMs}ms）`
        : `${engine} CLI 返回非零退出码`,
      result: {
        engine: runRes.engine,
        success: runRes.success,
        exitCode: runRes.exitCode ?? null,
        durationMs: runRes.durationMs,
        usedMcp: runRes.usedMcp,
        reply: runRes.reply.slice(0, 12_000),
        stderr: runRes.stderr.slice(0, 3_000),
      },
    };
  },
};
