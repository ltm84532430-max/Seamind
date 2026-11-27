import type { ActiveWorkspace } from '../../app/app-storage';
import { epubApi } from '../../ebook/epub-api';
import { literatureApi } from '../../literature/literature-api';
import { systemApi } from '../../system/system-api';
import { terminalApi } from '../../terminal/terminal-api';
import type {
  AgentToolScopeMode,
  AgentWorkspaceContextSnapshot,
  AgentWorkspaceSubView,
} from '../../terminal/terminal-types';
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
  'knowledge_get_current_document',
  'knowledge_propose_document_edit',
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

const KNOWLEDGE_DOC_TOOLS: readonly string[] = [
  'knowledge_get_current_document',
  'knowledge_propose_document_edit',
  'library_search',
  'library_read_document',
];

const MINDMAP_TOOLS: readonly string[] = [
  'mindmap_get_current',
  'mindmap_propose_node_edit',
  'mindmap_propose_node_branch',
  'mindmap_propose_code_block',
  'mindmap_run_code_block',
  'library_search',
  'library_read_document',
];

const READER_TOOLS: readonly string[] = [
  'epub_get_current_chapter',
  'epub_propose_footnote',
  'knowledge_get_book_note',
  'knowledge_update_book_note',
  'knowledge_query_book_galaxy',
  'knowledge_sync_reader_chapter',
  'knowledge_append_excerpt',
  'library_search',
  'library_read_document',
];

const PLAYER_TOOLS: readonly string[] = [
  'player_search_youtube',
  'learning_path_list',
  'learning_path_get',
  'learning_path_propose',
  'favorites_get_board',
  'favorites_propose_categorization',
];

const EXAMS_TOOLS: readonly string[] = [
  'exam_list_papers',
  'exam_get_paper',
  'code_run_c',
  'code_run_python',
  'epub_get_current_chapter',
];

const LITERATURE_TOOLS: readonly string[] = [
  'literature_list_papers',
  'library_search',
  'library_read_document',
];

const FEED_TOOLS: readonly string[] = [
  'rss_get_current_article',
  'rss_list_subscriptions',
  'rss_add_subscription',
];

const SHELL_TOOLS: readonly string[] = [
  'terminal_read_pane',
  'terminal_send_command',
  'code_run_c',
  'code_run_python',
  'cli_delegate',
];

const LAB_NOTEBOOK_TOOLS: readonly string[] = [
  'datalab_read_notebook',
  'datalab_update_cell',
  'datalab_push_cell',
  'datalab_run_cell',
  'datalab_delete_cell',
  ...DATALAB_TOOL_NAMES,
  'code_run_c',
];

const LAB_ER_TOOLS: readonly string[] = [
  'datalab_er_get_diagram',
  'datalab_er_annotate',
  'datalab_inspect_db',
  'datalab_profile_table',
  'datalab_query_sql',
  'datalab_list_sources',
  ...DATALAB_TOOL_NAMES,
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

/**
 * Returns the focused, primary tool set for a specific Seamind workspace & sub-view.
 * Prevents unrelated background tools (e.g., mindmap_get_current or terminal_read_pane)
 * from polluting the model when the user is working in a specific page.
 */
export function resolveWorkspaceToolNames(
  workspace: ActiveWorkspace,
  subView?: AgentWorkspaceSubView,
): string[] {
  switch (workspace) {
    case 'knowledge':
      return dedupeToolNames(KNOWLEDGE_DOC_TOOLS);
    case 'mindmap':
      return dedupeToolNames(MINDMAP_TOOLS);
    case 'lab':
      return dedupeToolNames(
        subView === 'er' ? LAB_ER_TOOLS : LAB_NOTEBOOK_TOOLS,
      );
    case 'reader':
      return dedupeToolNames(READER_TOOLS);
    case 'player':
      return dedupeToolNames(PLAYER_TOOLS);
    case 'exams':
      return dedupeToolNames(EXAMS_TOOLS);
    case 'literature':
      return dedupeToolNames(LITERATURE_TOOLS);
    case 'feed':
      return dedupeToolNames(FEED_TOOLS);
    case 'terminal':
      return dedupeToolNames(SHELL_TOOLS);
    case 'tasks':
      return dedupeToolNames([
        'library_search',
        'library_read_document',
        'learning_path_list',
        'exam_list_papers',
      ]);
    case 'agent':
    default:
      return dedupeToolNames(CROSS_SURFACE_FULL_TOOL_NAMES);
  }
}

function extraToolsForMentions(
  mentions?: ReadonlyArray<{ tag: string }>,
): string[] {
  if (!mentions || mentions.length === 0) return [];
  const extra: string[] = [];
  for (const m of mentions) {
    switch (m.tag) {
      case '#doc':
      case '#kb':
        extra.push(...KNOWLEDGE_DOC_TOOLS);
        break;
      case '#map':
        extra.push(...MINDMAP_TOOLS);
        break;
      case '#data':
      case '#lab':
      case '#env':
        extra.push(...LAB_NOTEBOOK_TOOLS);
        break;
      case '#book':
      case '#chapter':
        extra.push(...READER_TOOLS);
        break;
      case '#exam':
        extra.push(...EXAMS_TOOLS);
        break;
      case '#video':
        extra.push(...PLAYER_TOOLS);
        break;
      case '#paper':
        extra.push(...LITERATURE_TOOLS);
        break;
      case '#rss':
        extra.push(...FEED_TOOLS);
        break;
      case '#pane':
      case '#last-error':
        extra.push(...SHELL_TOOLS);
        break;
      default:
        break;
    }
  }
  return extra;
}

const WORKSPACE_LABEL_ZH: Record<ActiveWorkspace, string> = {
  knowledge: '知识库',
  mindmap: '思维导图',
  lab: '编辑器',
  agent: 'Agent',
  terminal: '系统终端',
  reader: '电子书',
  exams: '试卷',
  player: '播放器',
  literature: '论文',
  feed: 'RSS 订阅',
  tasks: '任务',
};

export function formatWorkspaceFocusBadge(
  workspaceContext?: AgentWorkspaceContextSnapshot | null,
  scopeMode: AgentToolScopeMode = 'focused',
): {
  shortLabel: string;
  detailTitle: string;
  isFocusedMode: boolean;
} {
  if (scopeMode === 'all') {
    return {
      shortLabel: '全模块模式',
      detailTitle:
        '当前为全软件跨模块模式（已开放全部 46 个工具）；点击切回「仅聚焦当前主页面」',
      isFocusedMode: false,
    };
  }
  if (!workspaceContext || !workspaceContext.targetWorkspace) {
    return {
      shortLabel: '独立中枢 · 全模块',
      detailTitle:
        '当前处于独立 Agent 全屏视图（未与业务页分屏），可自由调用各模块工具；开启分屏后将自动聚焦对应主页面',
      isFocusedMode: false,
    };
  }
  const ws = workspaceContext.targetWorkspace;
  const posPrefix =
    workspaceContext.targetPosition === 'left'
      ? '左侧 · '
      : workspaceContext.targetPosition === 'right'
        ? '右侧 · '
        : '';
  let pageLabel = WORKSPACE_LABEL_ZH[ws] || ws;
  if (ws === 'knowledge') {
    pageLabel =
      workspaceContext.targetSubView === 'doc' ? '知识库文档' : '知识库概览';
  } else if (ws === 'lab') {
    pageLabel =
      workspaceContext.targetSubView === 'er' ? '数据库 ER 图谱' : '代码实验本';
  } else if (ws === 'reader') {
    pageLabel =
      workspaceContext.targetSubView === 'pdf' ? 'PDF 书籍' : '电子书阅读';
  }
  const activeTitle =
    ws === 'knowledge'
      ? workspaceContext.activeKnowledgeDoc?.title
      : ws === 'mindmap'
        ? workspaceContext.activeMindmap?.title
        : ws === 'lab'
          ? workspaceContext.activeLab?.title
          : ws === 'reader'
            ? workspaceContext.activeBook?.title
            : null;
  return {
    shortLabel: `聚焦 ${posPrefix}${pageLabel}`,
    detailTitle: `当前优先调用「${pageLabel}」模块工具${activeTitle ? `（当前打开：${activeTitle}）` : ''}；使用 /命令、#资源 或点击此处可切换全软件跨模块`,
    isFocusedMode: true,
  };
}

/**
 * Generates a concise live UI state header injected into the Agent system prompt
 * (and CLI prompt) so the model knows with 100% accuracy what page & document the user sees.
 */
export function buildWorkspaceContextPrompt(
  workspaceContext?: AgentWorkspaceContextSnapshot | null,
  scopeMode: AgentToolScopeMode = 'focused',
): string {
  if (!workspaceContext) return '';
  const target = workspaceContext.targetWorkspace;
  const posText =
    workspaceContext.targetPosition === 'left'
      ? '左侧主页面'
      : workspaceContext.targetPosition === 'right'
        ? '右侧分屏页面'
        : workspaceContext.targetPosition === 'main'
          ? '当前主页面'
          : '无并排业务页面';

  const lines: string[] = [
    '[Seamind 实时界面状态（以此为准，切勿猜错当前页面）]',
  ];
  if (workspaceContext.splitActive && target) {
    lines.push(
      `- 当前窗口布局：分屏模式（${posText}：${WORKSPACE_LABEL_ZH[target]} | 对侧：Agent）`,
    );
  } else if (target) {
    lines.push(`- 当前主页面：${WORKSPACE_LABEL_ZH[target]}`);
  } else {
    lines.push(
      '- 当前窗口布局：独立全屏 Agent 视图（当前未与具体业务页面分屏，切勿默认假设后台旧导图或终端就是用户正在看的内容）。',
    );
  }

  lines.push(
    `- 工具作用域：${scopeMode === 'all' || !target ? '全软件跨模块模式' : `主页面优先聚焦（仅优先暴露「${WORKSPACE_LABEL_ZH[target]}」模块工具，除非用户显式跨页点名）`}`,
  );

  if (target === 'knowledge') {
    const doc = workspaceContext.activeKnowledgeDoc;
    if (doc) {
      lines.push(
        `- 当前正在阅读的知识库文档：《${doc.title}》`,
        `  - 相对路径：${doc.relativePath ?? '未命名草稿'} | 分类：${doc.category || '未分类'} | 规模：${doc.lineCount} 行 · ${doc.charCount.toLocaleString()} 字`,
      );
      if (doc.openTabs.length > 1) {
        lines.push(
          `  - 同页已打开的其他文档标签：${doc.openTabs
            .filter((t) => !t.active)
            .slice(0, 6)
            .map((t) => `《${t.title}》(${t.relativePath})`)
            .join('、')}`,
        );
      }
      lines.push(
        '- 行动约束：用户提及「左边 / 这篇文档 / 当前文件 / 翻译它 / 总结它」时，**必须调用 `knowledge_get_current_document` 读取正文**（文档超过 12,000 字时先读开头与 headings 目录，按需用 offset 分段读取）；如需生成译文或落盘修改，请调用 `knowledge_propose_document_edit`（长文翻译优先用 `mode="create_copy"` 保留原文）。严禁把后台未显示的思维导图当成当前文档！',
      );
    } else {
      lines.push(
        '- 当前知识库正停留在「概览首页」，尚未打开具体 Markdown 文档；如需查阅某篇笔记请先调用 `library_search` 再 `library_read_document`。',
      );
    }
  } else if (target === 'mindmap') {
    const mm = workspaceContext.activeMindmap;
    lines.push(
      `- 当前思维导图：${mm ? `《${mm.title}》(${mm.relativePath ?? '草稿'})` : '未加载'}`,
      '- 行动约束：涉及查看或修改当前导图时，先调用 `mindmap_get_current` 获取最新 revision 与 nodeId。',
    );
  } else if (target === 'lab') {
    const lab = workspaceContext.activeLab;
    if (lab?.mode === 'er') {
      lines.push(
        `- 当前编辑器子视图：数据库 ER 关系图谱（${lab.title || 'ER Studio'}${lab.erConnectionId ? ` · connId=${lab.erConnectionId}` : ''}）`,
        '- 行动约束：优先调用 `datalab_er_get_diagram`、`datalab_er_annotate`、`datalab_profile_table`、`datalab_query_sql` 完成实库研究与图谱批注。',
      );
    } else {
      lines.push(
        `- 当前编辑器子视图：Code Lab 多语言科研实验本（${lab?.title || '当前实验本'}）`,
        '- 行动约束：优先调用 `datalab_read_notebook`、`datalab_update_cell`、`datalab_push_cell`、`datalab_run_cell`、`datalab_query_sql`。',
      );
    }
  } else if (target === 'reader') {
    const bk = workspaceContext.activeBook;
    lines.push(
      `- 当前电子书阅读器：${bk ? `《${bk.title}》${bk.chapterLabel ? ` · 当前章：${bk.chapterLabel}` : ''}` : '书架概览（尚未打开书籍）'}`,
      '- 行动约束：优先调用 `epub_get_current_chapter`、`knowledge_get_book_note`、`knowledge_query_book_galaxy` 进行伴读与笔记联动。',
    );
  } else if (target === 'player') {
    lines.push(
      '- 行动约束：当前在播放器工作区，优先调用 `player_search_youtube`、`learning_path_*`、`favorites_*`。',
    );
  } else if (target === 'exams') {
    lines.push(
      '- 行动约束：当前在试卷中心工作区，优先调用 `exam_list_papers`、`exam_get_paper`、`code_run_c`、`code_run_python`。',
    );
  } else if (target === 'literature') {
    lines.push(
      '- 行动约束：当前在论文文献工作区，优先调用 `literature_list_papers`、`library_search`、`library_read_document`。',
    );
  } else if (target === 'feed') {
    lines.push(
      '- 行动约束：当前在 RSS 订阅工作区，优先调用 `rss_get_current_article`、`rss_list_subscriptions`、`rss_add_subscription`。',
    );
  } else if (target === 'terminal') {
    lines.push(
      '- 行动约束：当前在系统终端工作区，优先调用 `terminal_read_pane`、`terminal_send_command`、`cli_delegate`。',
    );
  }

  return lines.join('\n');
}

export interface SelectTerminalAgentToolsOptions {
  workspaceContext?: AgentWorkspaceContextSnapshot | null;
  scopeMode?: AgentToolScopeMode;
  mentions?: ReadonlyArray<{ tag: string }>;
  includeCliDelegate?: boolean;
}

export function selectTerminalAgentToolNames(
  slashCommand: string | null,
  promptText: string,
  options?: SelectTerminalAgentToolsOptions,
): string[] {
  const mentionExtras = extraToolsForMentions(options?.mentions);
  const withMentions = (
    base: readonly string[],
    fallback?: readonly string[],
  ) =>
    dedupeToolNames(
      mentionExtras.length > 0 ? [...base, ...mentionExtras] : base,
      fallback,
    );

  switch (slashCommand) {
    case '/book':
      return withMentions([...READER_TOOLS, 'cli_delegate']);
    case '/kb':
      return withMentions([
        ...KNOWLEDGE_DOC_TOOLS,
        'knowledge_get_book_note',
        'knowledge_update_book_note',
        'cli_delegate',
      ]);
    case '/map':
      return withMentions([
        ...MINDMAP_TOOLS,
        'knowledge_get_current_document',
        'cli_delegate',
      ]);
    case '/exam':
      return withMentions([...EXAMS_TOOLS, 'library_search', 'cli_delegate']);
    case '/player':
      return withMentions(PLAYER_TOOLS);
    case '/paper':
      return withMentions([
        ...LITERATURE_TOOLS,
        'mindmap_propose_node_branch',
        'cli_delegate',
      ]);
    case '/rss':
      return withMentions([...FEED_TOOLS, 'library_search', 'cli_delegate']);
    case '/data':
      return withMentions([
        ...DATALAB_TOOL_NAMES,
        'terminal_read_pane',
        'terminal_send_command',
        'cli_delegate',
      ]);
    case '/code':
    case '/exec':
      return withMentions([
        ...DATALAB_TOOL_NAMES,
        'code_run_c',
        'terminal_read_pane',
        'terminal_send_command',
        'library_search',
        'library_read_document',
        'cli_delegate',
      ]);
    default: {
      const ctx = options?.workspaceContext;
      const scopeMode = options?.scopeMode ?? 'focused';

      // Primary-page-first scoping: when a business workspace is visibly paired with Agent
      // and the user stays in default 'focused' mode, expose ONLY the visible page(s)' tools
      // plus any explicitly #mentioned modules (zero unrelated tool noise or misfires!).
      if (scopeMode === 'focused' && ctx && ctx.targetWorkspace) {
        const visibleTargets =
          ctx.visibleWorkspaces.length > 0
            ? ctx.visibleWorkspaces
            : [ctx.targetWorkspace];
        const scoped: string[] = [];
        // Always place primary targetWorkspace tools FIRST
        scoped.push(
          ...resolveWorkspaceToolNames(ctx.targetWorkspace, ctx.targetSubView),
        );
        // If user opened additional visible business panes, include their tools too
        for (const ws of visibleTargets) {
          if (ws !== ctx.targetWorkspace && ws !== 'agent') {
            scoped.push(...resolveWorkspaceToolNames(ws));
          }
        }
        if (options?.includeCliDelegate) {
          scoped.push('cli_delegate');
        }
        return withMentions(scoped);
      }

      // Full cross-module mode (standalone fullscreen Agent or explicit 'all' toggle)
      const lower = promptText.toLowerCase();
      if (
        lower.includes('youtube') ||
        lower.includes('视频') ||
        lower.includes('学习路径')
      ) {
        return withMentions(PLAYER_TOOLS, CROSS_SURFACE_FULL_TOOL_NAMES);
      }
      if (
        lower.includes('知识库') ||
        lower.includes('文档') ||
        lower.includes('翻译')
      ) {
        return withMentions(KNOWLEDGE_DOC_TOOLS, CROSS_SURFACE_FULL_TOOL_NAMES);
      }
      return withMentions(CROSS_SURFACE_FULL_TOOL_NAMES);
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
