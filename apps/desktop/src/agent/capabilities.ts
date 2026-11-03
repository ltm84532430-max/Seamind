import type { MapDocument, OpenedDocument } from '../library';
import {
  MAX_AGENT_BRANCH_CHARS,
  MAX_MARKDOWN_NODE_NOTE_CHARS,
} from '../mindmap/commands';
import type {
  FavoriteCategoryColor,
  FavoritesSnapshot,
  LearningPathDetail,
  LearningPathNodeInput,
  LearningPathNodeKind,
  LearningPathSummary,
  VideoInput,
} from '../player/types';
import {
  parseYouTubeTarget,
  thumbnailUrl,
  videoWatchUrl,
} from '../player/video-links';
import type {
  AgentAnalysisMode,
  ActiveMindmapSnapshot,
  AgentToolDefinition,
  AgentToolDescriptor,
  FavoritesCategorizationProposal,
  LearningPathProposal,
  LearningPathProposalMode,
  NodeEditOperation,
  NodeEditProposal,
} from './types';

export interface ProposeNodeEditInput {
  baseRevision: number;
  nodeId?: string;
  nodePath?: string;
  operation: Exclude<NodeEditOperation, 'add_branch'>;
  text: string;
  rationale: string;
}

export interface ProposeNodeBranchInput {
  baseRevision: number;
  nodeId?: string;
  nodePath?: string;
  analysisMode: AgentAnalysisMode;
  branchMarkdown: string;
  rationale: string;
}

export interface ProposeLearningPathRawNode {
  nodeId: string;
  parentId?: string | null;
  position?: number;
  kind?: LearningPathNodeKind;
  title: string;
  note?: string | null;
  videoUrlOrId?: string | null;
  startSeconds?: number;
  optional?: boolean;
  prerequisiteIds?: string[];
}

export interface ProposeLearningPathInput {
  mode: LearningPathProposalMode;
  pathId?: string;
  title: string;
  description?: string;
  nodes: ProposeLearningPathRawNode[];
  rationale: string;
}

export interface ProposeFavoritesCategorizationInput {
  newCategories?: Array<{
    name: string;
    color?: FavoriteCategoryColor;
  }>;
  assignments: Array<{
    videoId: string;
    categoryName: string;
    note?: string | null;
  }>;
  rationale: string;
}

export interface AgentCapabilities {
  readCurrentEpubChapter?(): Promise<{
    bookKey: string;
    bookTitle: string;
    sectionIndex: number;
    sectionHref: string;
    sectionLabel: string;
    text: string;
    selection: { cfi: string; text: string } | null;
  }>;
  proposeEpubFootnote?(input: {
    selectionCfi: string;
    text: string;
  }): Promise<{ annotationId: string }>;
  readCurrentBookKnowledgeNote?(input?: { chapterTarget?: string }): Promise<{
    bookKey: string;
    bookTitle: string;
    relativePath: string;
    category: string;
    title: string;
    exists: boolean;
    markdown: string;
    isChapterLevel?: boolean;
    chapterLabel?: string;
  }>;
  updateBookKnowledgeNote?(input: {
    content: string;
    mode: 'append' | 'overwrite';
    rationale?: string;
    chapterTarget?: string;
  }): Promise<{
    relativePath: string;
    title: string;
    category: string;
    updated: boolean;
    isChapterLevel?: boolean;
  }>;
  appendBookKnowledgeExcerpt?(input: {
    excerpt: string;
    commentary?: string;
    chapterLabel?: string;
  }): Promise<{
    relativePath: string;
    title: string;
    appended: boolean;
  }>;
  queryBookGalaxy?(): Promise<{
    bookTitle: string;
    totalChapters: number;
    notesCount: number;
    completionPercentage: number;
    currentChapter?: string;
    nodes: Array<{
      id: string;
      label: string;
      kind: string;
      chapterIndex?: string;
      hasNote: boolean;
      notePath?: string;
      isCurrent?: boolean;
    }>;
  }>;
  syncReaderChapter?(input: {
    chapterTarget: string;
    reason?: string;
  }): Promise<{
    synced: boolean;
    targetChapter: string;
    notePath?: string;
  }>;
  getCurrentMindmap(): ActiveMindmapSnapshot;
  searchLibrary(query: string, category?: string): Promise<MapDocument[]>;
  readDocument(relativePath: string): Promise<OpenedDocument>;
  proposeNodeEdit(input: ProposeNodeEditInput): NodeEditProposal;
  proposeNodeBranch(input: ProposeNodeBranchInput): NodeEditProposal;
  searchYouTubeVideos?(query: string, limit?: number): Promise<VideoInput[]>;
  listLearningPaths?(): Promise<LearningPathSummary[]>;
  getLearningPath?(pathId: string): Promise<LearningPathDetail | null>;
  proposeLearningPath?(
    input: ProposeLearningPathInput,
  ): Promise<LearningPathProposal>;
  getFavoritesBoard?(): Promise<FavoritesSnapshot>;
  proposeFavoritesCategorization?(
    input: ProposeFavoritesCategorizationInput,
  ): Promise<FavoritesCategorizationProposal>;
}

export interface AgentToolResult {
  version: 1;
  permission: 'read' | 'user_approval';
  name: string;
  label: string;
  summary: string;
  result: Record<string, unknown>;
  proposal?: NodeEditProposal;
  learningPathProposal?: LearningPathProposal;
  favoritesCategorizationProposal?: FavoritesCategorizationProposal;
}

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const agentToolCatalog: AgentToolDescriptor[] = [
  {
    version: 1,
    name: 'epub_get_current_chapter',
    description:
      '读取电子书阅读器当前章节的完整正文，可用 offset 分段读取直到 nextOffset 为 null；每次调用都从当前阅读位置重新读取。返回当前选区的 CFI 和文字，添加脚注时使用该 CFI。',
    permission: 'read',
    inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }),
  },
  {
    version: 1,
    name: 'epub_propose_footnote',
    description:
      '针对阅读器当前选区提交 AI 脚注预览。selectionCfi 必须来自 epub_get_current_chapter 返回的当前选区。用户在阅读器中确认后才会保存；取消或选区变化时失败。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        selectionCfi: { type: 'string', minLength: 1, maxLength: 1000 },
        text: { type: 'string', minLength: 1, maxLength: 800 },
      },
      ['selectionCfi', 'text'],
    ),
  },
  {
    version: 1,
    name: 'knowledge_get_book_note',
    description:
      '读取当前电子书或指定章节对应的知识库 Markdown 读书笔记全文、标题、分类与相对路径。可指定 chapterTarget（如 "8.1" 或 "第8章"），留空则默认读取当前正在阅读的章节。',
    permission: 'read',
    inputSchema: schema({
      chapterTarget: {
        type: 'string',
        description:
          '可选：指定章节序号或标题（如 "8.1" 或 "第8章 字符输入"）。若省略则取当前正文章节。',
      },
    }),
  },
  {
    version: 1,
    name: 'knowledge_update_book_note',
    description:
      '更新当前电子书或指定章节的知识库 Markdown 笔记。mode 为 "append" 时在文末或章节后追加内容，mode 为 "overwrite" 时全量重写。修改会实时同步到知识库工作区与并排笔记编辑器中。',
    permission: 'read',
    inputSchema: schema(
      {
        content: {
          type: 'string',
          minLength: 1,
          description: '待写入或追加的 Markdown 笔记正文。',
        },
        mode: {
          type: 'string',
          enum: ['append', 'overwrite'],
          description: '写入模式：append 追加或 overwrite 覆盖。',
        },
        chapterTarget: {
          type: 'string',
          description:
            '可选：指定章节序号或标题（如 "8.1" 或 "第8章"）。若省略则归属于当前正文章节。',
        },
        rationale: {
          type: 'string',
          maxLength: 300,
          description: '本次知识沉淀或修改的意图说明。',
        },
      },
      ['content', 'mode'],
    ),
  },
  {
    version: 1,
    name: 'knowledge_query_book_galaxy',
    description:
      '查询当前电子书的完整章节目录树拓扑、星系图节点以及各章节关联知识库笔记的覆盖度与状态，用于全书知识鸟瞰与章节定位。',
    permission: 'read',
    inputSchema: schema({}),
  },
  {
    version: 1,
    name: 'knowledge_sync_reader_chapter',
    description:
      '将电子书阅读器同步翻页/跳转到指定章节（如 "8.1" 或 "第8章"），同时联动切换右侧知识库笔记。',
    permission: 'read',
    inputSchema: schema(
      {
        chapterTarget: {
          type: 'string',
          description: '目标章节的编号、标题或名称（如 "8.1" 或 "第8章"）。',
        },
        reason: {
          type: 'string',
          description: '跳转该章节的教学、伴读或复习意图。',
        },
      },
      ['chapterTarget'],
    ),
  },
  {
    version: 1,
    name: 'knowledge_append_excerpt',
    description:
      '快速将电子书的重点摘录、概念代码或思考洞察沉淀为知识库笔记中的标准引用块与深度要点。',
    permission: 'read',
    inputSchema: schema(
      {
        excerpt: {
          type: 'string',
          minLength: 1,
          description: '从书中选取的关键段落或代码。',
        },
        commentary: {
          type: 'string',
          description: 'AI 或用户的思考、解析或扩展洞见。',
        },
        chapterLabel: {
          type: 'string',
          description: '当前章节名称（用于结构化归类）。',
        },
      },
      ['excerpt'],
    ),
  },
  {
    version: 1,
    name: 'mindmap_get_current',
    description:
      '读取当前打开的思维导图结构和完整 Markdown 原文。每个节点包含持久 nodeId（旧节点可能为空）、allowedOperations 和 noteTruncated；只对 allowedOperations 中列出的操作提出修改。节点路径只在返回的 revision 版本内有效；树结构若 truncated 为 true 表示节点树只列出部分节点，markdown 字段仍是完整原文。修改前必须先调用此工具。',
    permission: 'read',
    inputSchema: schema({}),
  },
  {
    version: 1,
    name: 'library_search',
    description:
      '只读搜索本地文件库中的思维导图，返回标题、分类和相对路径。需要正文时再调用 library_read_document。',
    permission: 'read',
    inputSchema: schema(
      {
        query: { type: 'string', minLength: 1, maxLength: 120 },
        category: { type: 'string', maxLength: 200 },
      },
      ['query'],
    ),
  },
  {
    version: 1,
    name: 'library_read_document',
    description:
      '只读打开文件库中的一个 Markdown 思维导图。relativePath 应来自 library_search；可用 offset 分段读取较长内容。',
    permission: 'read',
    inputSchema: schema(
      {
        relativePath: { type: 'string', minLength: 1, maxLength: 1000 },
        offset: { type: 'integer', minimum: 0 },
      },
      ['relativePath'],
    ),
  },
  {
    version: 1,
    name: 'mindmap_propose_node_edit',
    description:
      '为当前思维导图提出节点改名、增删节点或编辑 Markdown/数学公式备注的提案。只能执行目标节点 allowedOperations 中允许的操作。必须使用 mindmap_get_current 返回的 revision；优先提供节点 nodeId，旧节点尚无持久 ID 时可使用 nodePath。set_note 的 text 最长 8,000 字符。此工具只生成预览，必须由用户确认后才会修改。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        baseRevision: { type: 'integer', minimum: 0 },
        nodeId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description:
            '目标节点的持久 ID；优先使用 mindmap_get_current 返回的 nodeId。',
        },
        nodePath: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            '仅当目标 nodeId 为空时使用；必须来自同一 revision 的节点快照。',
        },
        operation: {
          type: 'string',
          enum: ['rename', 'add_child', 'add_sibling', 'delete', 'set_note'],
        },
        text: {
          type: 'string',
          maxLength: MAX_MARKDOWN_NODE_NOTE_CHARS,
          description:
            '改名或新增时的节点文字；set_note 时为 Markdown 备注；delete 时传空字符串。',
        },
        rationale: { type: 'string', maxLength: 500 },
      },
      ['baseRevision', 'operation', 'text', 'rationale'],
    ),
  },
  {
    version: 1,
    name: 'mindmap_propose_node_branch',
    description:
      '在指定节点下生成一组 Markdown 标题层级作为子节点分支。节点标题尽量不超过 20 个汉字（英文 40 个字符）；每个标题或列表项保持单行，禁止在单个节点文字中手动插入换行；长解释用简短父节点加必要子节点表达，一个节点只放一个要点，保留关键条件和公式。数学公式不得放进标题或列表项标签：行内用 $...$，独立公式单独成段使用 $$...$$，每个公式块只放一个完整表达式且不在 LaTeX 内手动换行；推导按假设/定义、代入/变形、结论拆成短节点，每步最多一个公式。较长公式按等价变形分步，不得省略数学内容；静态推导使用 KaTeX，只有绘图或交互时才使用 seamind-math。analysisMode=drilldown 时按定义、起源、实际工程应用与意义、例子组织内容，理学主题按需包含推导，并提炼可迁移结构与元认知案例；analysisMode=visualization 时可用 Mermaid、echarts、python、svg、独立 html 代码块或 YouTube 链接，按主题选择适合的表达。必须基于 mindmap_get_current 的 revision 和目标 nodeId/nodePath。工具只返回预览提案，必须由用户确认后才会修改。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        baseRevision: { type: 'integer', minimum: 0 },
        nodeId: { type: 'string', minLength: 1, maxLength: 128 },
        nodePath: { type: 'string', minLength: 1, maxLength: 200 },
        analysisMode: { type: 'string', enum: ['drilldown', 'visualization'] },
        branchMarkdown: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_AGENT_BRANCH_CHARS,
          description:
            '以 Markdown 标题开头的子树内容；可在标题下包含说明、数学公式和支持的可视化代码块。',
        },
        rationale: { type: 'string', maxLength: 500 },
      },
      ['baseRevision', 'analysisMode', 'branchMarkdown', 'rationale'],
    ),
  },
  {
    version: 1,
    name: 'player_search_youtube',
    description:
      '只读搜索 YouTube 视频，返回真实的 11 位 videoId、观看链接、标题、频道名称、时长（秒）与观看量。为学习路径挑选视频前必须先调用此工具获取真实视频编号，严禁凭记忆编造 videoId。',
    permission: 'read',
    inputSchema: schema(
      {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          description:
            'YouTube 搜索关键词（中英文皆可，可包含频道名或课程主题）。',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 15,
          description: '最多返回条数，默认 8。',
        },
      },
      ['query'],
    ),
  },
  {
    version: 1,
    name: 'learning_path_list',
    description:
      '只读列出播放器中的所有学习路径摘要（pathId、标题、说明、节点数、视频数、已看完数）。',
    permission: 'read',
    inputSchema: schema({}),
  },
  {
    version: 1,
    name: 'learning_path_get',
    description:
      '只读读取指定学习路径（pathId）的完整节点树、视频信息、前置依赖与观看进度。在现有路径上修改或追加节点前请先调用此工具。',
    permission: 'read',
    inputSchema: schema(
      {
        pathId: { type: 'string', minLength: 1, maxLength: 64 },
      },
      ['pathId'],
    ),
  },
  {
    version: 1,
    name: 'learning_path_propose',
    description:
      '为播放器提出创建（create）、整体替换（replace）或向已有学习路径追加节点（append_nodes）的提案。支持从左向右延伸的阶段树（parentId 指向所属阶段或上级节点）以及多分支汇合的前置依赖（prerequisiteIds）。每个视频节点的 videoUrlOrId 必须来自 player_search_youtube、现有路径或用户明确提供的真实 YouTube 链接/11位编号。此工具只打开预览弹窗，必须经用户点击确认后才会写入数据库并打开路径。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        mode: {
          type: 'string',
          enum: ['create', 'replace', 'append_nodes'],
        },
        pathId: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description:
            'replace 或 append_nodes 时必填目标路径 ID；create 时可选自定义短横线 ID（留空则自动生成）。',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: '学习路径标题。',
        },
        description: {
          type: 'string',
          maxLength: 2000,
          description: '学习路径简介、适用人群或学习目标。',
        },
        nodes: {
          type: 'array',
          minItems: 1,
          maxItems: 120,
          items: schema(
            {
              nodeId: {
                type: 'string',
                minLength: 1,
                maxLength: 64,
                description:
                  '路径内唯一节点 ID（仅字母、数字、_、-、:），例如 stage-1、vid-ownership。',
              },
              parentId: {
                type: ['string', 'null'],
                maxLength: 64,
                description:
                  '父节点 ID（例如阶段节点 ID 或上级视频节点 ID）；顶层主干节点传 null 或省略。',
              },
              position: {
                type: 'integer',
                minimum: 0,
                description: '同级或整体排序序号（0 开始递增）。',
              },
              kind: {
                type: 'string',
                enum: ['stage', 'video', 'checkpoint'],
                description:
                  'stage 表示阶段分组节点；video 表示具体视频课；checkpoint 表示里程碑/综合实战节点。',
              },
              title: {
                type: 'string',
                minLength: 1,
                maxLength: 200,
                description: '节点显示标题。',
              },
              note: {
                type: 'string',
                maxLength: 1500,
                description: '学习要点、看点提示或练习要求。',
              },
              videoUrlOrId: {
                type: ['string', 'null'],
                maxLength: 300,
                description:
                  '真实 11 位 YouTube videoId 或完整 YouTube 观看链接；纯阶段分组节点可省略或传 null。',
              },
              startSeconds: {
                type: 'integer',
                minimum: 0,
                description: '可选起始播放秒数。',
              },
              optional: {
                type: 'boolean',
                description:
                  '是否为选修/支线拓展内容（默认 false 为主线必修）。',
              },
              prerequisiteIds: {
                type: 'array',
                maxItems: 16,
                items: { type: 'string', minLength: 1, maxLength: 64 },
                description:
                  '前置依赖节点 ID 列表（用于技能拓扑图和多分支汇合节点）。',
              },
            },
            ['nodeId', 'title'],
          ),
        },
        rationale: {
          type: 'string',
          maxLength: 500,
          description: '简要说明学习路径阶段设计与选片理由。',
        },
      },
      ['mode', 'title', 'nodes', 'rationale'],
    ),
  },
  {
    version: 1,
    name: 'favorites_get_board',
    description:
      '只读读取播放器「收藏」看板中的已有分类与全部收藏视频（包含 videoId、标题、频道名称、当前所属主分类 categoryId/categoryName、是否看完及收藏备注）。在为用户收藏视频整理归类前必须先调用此工具。',
    permission: 'read',
    inputSchema: schema({}),
  },
  {
    version: 1,
    name: 'favorites_propose_categorization',
    description:
      '为播放器的油管收藏视频提交「单主分类」批量归类提案。每个收藏视频至多归入一个主分类（保证竖栏看板一视频一卡不重复）；优先复用 favorites_get_board 中的已有分类，确有必要时可在 newCategories 中提议创建精简的新分类（可选颜色：terracotta、ocean、sage、amber、plum、teal、rose、slate）。此工具只生成预览弹窗，经用户点击确认后才会应用。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        newCategories: {
          type: 'array',
          maxItems: 20,
          items: schema(
            {
              name: {
                type: 'string',
                minLength: 1,
                maxLength: 60,
                description: '新建分类名称（不可为“未分类”）。',
              },
              color: {
                type: 'string',
                enum: [
                  'terracotta',
                  'ocean',
                  'sage',
                  'amber',
                  'plum',
                  'teal',
                  'rose',
                  'slate',
                ],
                description: '分类色标主题色。',
              },
            },
            ['name'],
          ),
        },
        assignments: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: schema(
            {
              videoId: {
                type: 'string',
                minLength: 1,
                maxLength: 32,
                description:
                  '来自 favorites_get_board 的真实收藏视频 11 位 videoId。',
              },
              categoryName: {
                type: 'string',
                minLength: 1,
                maxLength: 60,
                description:
                  '目标主分类名称（匹配已有分类名或 newCategories 中的分类名）。',
              },
              note: {
                type: ['string', 'null'],
                maxLength: 500,
                description: '可选的一句话看点备注（留空则保留原备注）。',
              },
            },
            ['videoId', 'categoryName'],
          ),
        },
        rationale: {
          type: 'string',
          maxLength: 500,
          description: '简要说明分类划分维度与归类理由。',
        },
      },
      ['assignments', 'rationale'],
    ),
  },
];

export const agentTools: AgentToolDefinition[] = agentToolCatalog.map(
  ({ name, description, inputSchema }) => ({
    type: 'function',
    function: { name, description, parameters: inputSchema },
  }),
);

const MAX_TOOL_READ_CHARS = 12_000;
const MAX_SEARCH_RESULTS = 8;

function parseObject(raw: string): Record<string, unknown> {
  if (raw.length > 300_000) throw new Error('工具参数过长。');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('工具参数不是有效 JSON。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('工具参数必须是 JSON 对象。');
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  input: Record<string, unknown>,
  allowed: string[],
): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`不支持的参数：${unexpected}`);
}

function requireString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
  minLength = 1,
): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是文本。`);
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new Error(
      `参数 ${key} 长度必须为 ${minLength} 到 ${maxLength} 个字符。`,
    );
  }
  return normalized;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是文本。`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`参数 ${key} 长度不得超过 ${maxLength} 个字符。`);
  }
  return normalized;
}

function requireText(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
  minLength = 0,
): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是文本。`);
  if (value.trim().length < minLength || value.length > maxLength) {
    throw new Error(
      `参数 ${key} 长度必须为 ${minLength} 到 ${maxLength} 个字符。`,
    );
  }
  return value;
}

function requireInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`参数 ${key} 必须是非负整数。`);
  }
  return value as number;
}

function previewDocument(opened: OpenedDocument, offset: number) {
  const markdown = opened.markdown;
  const start = Math.min(offset, markdown.length);
  const content = markdown.slice(start, start + MAX_TOOL_READ_CHARS);
  const nextOffset = start + content.length;
  return {
    document: {
      title: opened.document.title,
      category: opened.document.category,
      relativePath: opened.document.relativePath,
    },
    totalChars: markdown.length,
    offset: start,
    content,
    nextOffset: nextOffset < markdown.length ? nextOffset : null,
  };
}

export async function executeAgentTool(
  name: string,
  rawArguments: string,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const input = parseObject(rawArguments);

  if (name === 'epub_get_current_chapter') {
    assertOnlyKeys(input, ['offset']);
    if (!capabilities.readCurrentEpubChapter)
      throw new Error('当前环境无法读取电子书。');
    const offset =
      input.offset === undefined ? 0 : requireInteger(input, 'offset');
    const chapter = await capabilities.readCurrentEpubChapter();
    const start = Math.min(offset, chapter.text.length);
    const content = chapter.text.slice(start, start + MAX_TOOL_READ_CHARS);
    const nextOffset = start + content.length;
    return {
      version: 1,
      permission: 'read',
      name,
      label: '当前电子书章节',
      summary: `${chapter.bookTitle} · ${chapter.sectionLabel}`,
      result: {
        bookKey: chapter.bookKey,
        bookTitle: chapter.bookTitle,
        sectionIndex: chapter.sectionIndex,
        sectionHref: chapter.sectionHref,
        sectionLabel: chapter.sectionLabel,
        totalChars: chapter.text.length,
        offset: start,
        content,
        nextOffset: nextOffset < chapter.text.length ? nextOffset : null,
        selection: chapter.selection,
      },
    };
  }

  if (name === 'epub_propose_footnote') {
    assertOnlyKeys(input, ['selectionCfi', 'text']);
    if (!capabilities.proposeEpubFootnote)
      throw new Error('当前环境无法添加电子书脚注。');
    const selectionCfi = requireString(input, 'selectionCfi', 1000);
    const footnoteText = requireText(input, 'text', 800, 1).trim();
    const saved = await capabilities.proposeEpubFootnote({
      selectionCfi,
      text: footnoteText,
    });
    return {
      version: 1,
      permission: 'user_approval',
      name,
      label: '电子书脚注',
      summary: '用户已确认并保存脚注。',
      result: { annotationId: saved.annotationId, saved: true },
    };
  }

  if (name === 'knowledge_get_book_note') {
    assertOnlyKeys(input, ['chapterTarget']);
    if (!capabilities.readCurrentBookKnowledgeNote)
      throw new Error('当前环境未处于电子书阅读状态，无法获取书籍知识库笔记。');
    const chapterTarget = optionalString(input, 'chapterTarget', 200);
    const note = await capabilities.readCurrentBookKnowledgeNote({
      chapterTarget,
    });
    return {
      version: 1,
      permission: 'read',
      name,
      label: '电子书读书笔记',
      summary: `${note.bookTitle} · ${note.title} (${note.exists ? '已存在' : '新文件'})`,
      result: {
        bookKey: note.bookKey,
        bookTitle: note.bookTitle,
        relativePath: note.relativePath,
        category: note.category,
        title: note.title,
        exists: note.exists,
        markdown: note.markdown,
        isChapterLevel: note.isChapterLevel,
        chapterLabel: note.chapterLabel,
      },
    };
  }

  if (name === 'knowledge_update_book_note') {
    assertOnlyKeys(input, ['content', 'mode', 'rationale', 'chapterTarget']);
    if (!capabilities.updateBookKnowledgeNote)
      throw new Error('当前环境未处于电子书阅读状态，无法更新知识库笔记。');
    const content = requireText(input, 'content', 150_000, 1);
    const mode = requireString(input, 'mode', 20) as 'append' | 'overwrite';
    if (mode !== 'append' && mode !== 'overwrite') {
      throw new Error('mode 仅支持 "append" 或 "overwrite"。');
    }
    const rationale = optionalString(input, 'rationale', 300) ?? '';
    const chapterTarget = optionalString(input, 'chapterTarget', 200);
    const res = await capabilities.updateBookKnowledgeNote({
      content,
      mode,
      rationale,
      chapterTarget,
    });
    return {
      version: 1,
      permission: 'read',
      name,
      label: '更新读书笔记',
      summary: `已成功${mode === 'append' ? '追加内容至' : '更新'}「${res.title}」。`,
      result: {
        relativePath: res.relativePath,
        title: res.title,
        category: res.category,
        updated: res.updated,
        isChapterLevel: res.isChapterLevel,
      },
    };
  }

  if (name === 'knowledge_query_book_galaxy') {
    assertOnlyKeys(input, []);
    if (!capabilities.queryBookGalaxy)
      throw new Error('当前环境未处于电子书阅读状态，无法查询星系图数据。');
    const galaxy = await capabilities.queryBookGalaxy();
    return {
      version: 1,
      permission: 'read',
      name,
      label: '全书知识星系',
      summary: `${galaxy.bookTitle} · 共 ${galaxy.totalChapters} 章节 (笔记覆盖 ${galaxy.notesCount})`,
      result: galaxy,
    };
  }

  if (name === 'knowledge_sync_reader_chapter') {
    assertOnlyKeys(input, ['chapterTarget', 'reason']);
    if (!capabilities.syncReaderChapter)
      throw new Error('当前环境无法跳转电子书章节。');
    const chapterTarget = requireString(input, 'chapterTarget', 200);
    const reason = optionalString(input, 'reason', 300) ?? '';
    const res = await capabilities.syncReaderChapter({
      chapterTarget,
      reason,
    });
    return {
      version: 1,
      permission: 'read',
      name,
      label: '同步阅读章节',
      summary: `已将电子书同步跳转至「${res.targetChapter}」${reason ? `：${reason}` : ''}。`,
      result: res,
    };
  }

  if (name === 'knowledge_append_excerpt') {
    assertOnlyKeys(input, ['excerpt', 'commentary', 'chapterLabel']);
    if (!capabilities.appendBookKnowledgeExcerpt)
      throw new Error('当前环境未处于电子书阅读状态，无法沉淀摘录至知识库。');
    const excerpt = requireText(input, 'excerpt', 10_000, 1);
    const commentary = optionalString(input, 'commentary', 5_000) ?? '';
    const chapterLabel = optionalString(input, 'chapterLabel', 200) ?? '';
    const res = await capabilities.appendBookKnowledgeExcerpt({
      excerpt,
      commentary,
      chapterLabel,
    });
    return {
      version: 1,
      permission: 'read',
      name,
      label: '知识库摘录沉淀',
      summary: `已将摘录沉淀至「${res.title}」。`,
      result: {
        relativePath: res.relativePath,
        title: res.title,
        appended: res.appended,
      },
    };
  }

  if (name === 'mindmap_get_current') {
    assertOnlyKeys(input, []);
    const current = capabilities.getCurrentMindmap();
    if (new TextEncoder().encode(current.markdown).byteLength > 250_000) {
      throw new Error(
        '当前导图超过 250 KB 的完整上下文上限；为避免静默截断，未返回部分导图。请拆分主题后重试。',
      );
    }
    return {
      version: 1,
      permission: 'read',
      name,
      label: '读取当前导图',
      summary: current.truncated
        ? `读取「${current.title}」的部分结构，当前快照包含 ${current.nodeCount} 个节点，结果已截断。`
        : `读取「${current.title}」，共 ${current.nodeCount} 个节点。`,
      result: current as unknown as Record<string, unknown>,
    };
  }

  if (name === 'library_search') {
    assertOnlyKeys(input, ['query', 'category']);
    const query = requireString(input, 'query', 120);
    const category =
      input.category === undefined
        ? undefined
        : requireString(input, 'category', 200, 0);
    const documents = await capabilities.searchLibrary(query, category);
    const results = documents.slice(0, MAX_SEARCH_RESULTS).map((document) => ({
      title: document.title,
      category: document.category,
      mapType: document.mapType,
      relativePath: document.relativePath,
      updatedAt: document.updatedAt,
    }));
    return {
      version: 1,
      permission: 'read',
      name,
      label: '搜索文件库',
      summary: `找到 ${results.length} 个相关导图。`,
      result: { results, truncated: documents.length > results.length },
    };
  }

  if (name === 'library_read_document') {
    assertOnlyKeys(input, ['relativePath', 'offset']);
    const relativePath = requireString(input, 'relativePath', 1000);
    const offset =
      input.offset === undefined ? 0 : requireInteger(input, 'offset');
    const opened = await capabilities.readDocument(relativePath);
    const result = previewDocument(opened, offset);
    return {
      version: 1,
      permission: 'read',
      name,
      label: `读取导图「${opened.document.title}」`,
      summary: `读取 ${result.offset}–${result.offset + result.content.length} / ${result.totalChars} 字符。`,
      result,
    };
  }

  if (name === 'mindmap_propose_node_edit') {
    assertOnlyKeys(input, [
      'baseRevision',
      'nodeId',
      'nodePath',
      'operation',
      'text',
      'rationale',
    ]);
    const operation = input.operation;
    if (
      operation !== 'rename' &&
      operation !== 'add_child' &&
      operation !== 'add_sibling' &&
      operation !== 'delete' &&
      operation !== 'set_note'
    ) {
      throw new Error('操作类型不受支持。');
    }
    const nodeId =
      input.nodeId === undefined
        ? undefined
        : requireString(input, 'nodeId', 128);
    const nodePath =
      input.nodePath === undefined
        ? undefined
        : requireString(input, 'nodePath', 200);
    if (!nodeId && !nodePath) throw new Error('必须提供 nodeId 或 nodePath。');
    const proposal = capabilities.proposeNodeEdit({
      baseRevision: requireInteger(input, 'baseRevision'),
      nodeId,
      nodePath,
      operation: operation as Exclude<NodeEditOperation, 'add_branch'>,
      text: requireText(
        input,
        'text',
        operation === 'set_note' ? MAX_MARKDOWN_NODE_NOTE_CHARS : 300,
        operation === 'delete' || operation === 'set_note' ? 0 : 1,
      ),
      rationale: requireString(input, 'rationale', 500, 0),
    });
    return {
      version: 1,
      permission: 'user_approval',
      name,
      label: '提出节点修改',
      summary:
        proposal.operation === 'rename'
          ? `将「${proposal.previousLabel}」改为「${proposal.nextLabel}」，等待你确认。`
          : proposal.operation === 'add_child'
            ? `在「${proposal.previousLabel}」下添加「${proposal.nextLabel}」，等待你确认。`
            : proposal.operation === 'add_sibling'
              ? `在「${proposal.previousLabel}」旁添加「${proposal.nextLabel}」，等待你确认。`
              : proposal.operation === 'delete'
                ? `删除「${proposal.previousLabel}」及其子节点，等待你确认。`
                : `更新「${proposal.previousLabel}」的备注，等待你确认。`,
      result: {
        status: 'awaiting_user_approval',
        nodeId: proposal.nodeId,
        nodePath: proposal.nodePath,
        operation: proposal.operation,
        previousLabel: proposal.previousLabel,
        nextLabel: proposal.nextLabel,
        previousNote: proposal.previousNote,
        nextNote: proposal.nextNote,
        rationale: proposal.rationale,
      },
      proposal,
    };
  }

  if (name === 'mindmap_propose_node_branch') {
    assertOnlyKeys(input, [
      'baseRevision',
      'nodeId',
      'nodePath',
      'analysisMode',
      'branchMarkdown',
      'rationale',
    ]);
    const analysisMode = input.analysisMode;
    if (analysisMode !== 'drilldown' && analysisMode !== 'visualization') {
      throw new Error('分析模式不受支持。');
    }
    const nodeId =
      input.nodeId === undefined
        ? undefined
        : requireString(input, 'nodeId', 128);
    const nodePath =
      input.nodePath === undefined
        ? undefined
        : requireString(input, 'nodePath', 200);
    if (!nodeId && !nodePath) throw new Error('必须提供 nodeId 或 nodePath。');
    const proposal = await capabilities.proposeNodeBranch({
      baseRevision: requireInteger(input, 'baseRevision'),
      nodeId,
      nodePath,
      analysisMode,
      branchMarkdown: requireText(
        input,
        'branchMarkdown',
        MAX_AGENT_BRANCH_CHARS,
        1,
      ),
      rationale: requireString(input, 'rationale', 500, 0),
    });
    const modeLabel = analysisMode === 'drilldown' ? '节点下探' : '可视化分析';
    return {
      version: 1,
      permission: 'user_approval',
      name,
      label: `预览${modeLabel}分支`,
      summary: `为「${proposal.previousLabel}」生成${modeLabel}分支，等待你确认。`,
      result: {
        status: 'awaiting_user_approval',
        nodeId: proposal.nodeId,
        nodePath: proposal.nodePath,
        analysisMode,
        previousLabel: proposal.previousLabel,
        nextLabel: proposal.nextLabel,
        rationale: proposal.rationale,
        htmlAssetCount: proposal.htmlAssets?.length || 0,
      },
      proposal,
    };
  }

  if (name === 'player_search_youtube') {
    assertOnlyKeys(input, ['query', 'limit']);
    if (!capabilities.searchYouTubeVideos) {
      throw new Error('当前环境尚未启用播放器 YouTube 搜索能力。');
    }
    const query = requireString(input, 'query', 160);
    const limit =
      input.limit === undefined
        ? 8
        : Math.max(1, Math.min(15, requireInteger(input, 'limit')));
    const videos = await capabilities.searchYouTubeVideos(query, limit);
    const results = videos.map((video) => ({
      videoId: video.videoId,
      url: videoWatchUrl(video.videoId),
      title: video.title,
      channelId: video.channelId ?? null,
      channelName: video.channelName ?? null,
      durationSeconds: video.durationSeconds ?? null,
      viewCount: video.viewCount ?? null,
      viewText: video.viewText ?? null,
      thumbnailUrl: video.thumbnailUrl ?? thumbnailUrl(video.videoId, 'mq'),
    }));
    return {
      version: 1,
      permission: 'read',
      name,
      label: `搜索 YouTube「${query}」`,
      summary: `搜索「${query}」，找到 ${results.length} 个可播放视频。`,
      result: { query, results },
    };
  }

  if (name === 'learning_path_list') {
    assertOnlyKeys(input, []);
    if (!capabilities.listLearningPaths) {
      throw new Error('当前环境尚未启用学习路径读取能力。');
    }
    const paths = await capabilities.listLearningPaths();
    return {
      version: 1,
      permission: 'read',
      name,
      label: '列出学习路径',
      summary: `当前共有 ${paths.length} 条学习路径。`,
      result: { paths },
    };
  }

  if (name === 'learning_path_get') {
    assertOnlyKeys(input, ['pathId']);
    if (!capabilities.getLearningPath) {
      throw new Error('当前环境尚未启用学习路径读取能力。');
    }
    const pathId = requireString(input, 'pathId', 64);
    const detail = await capabilities.getLearningPath(pathId);
    if (!detail) {
      throw new Error(`找不到学习路径：${pathId}`);
    }
    return {
      version: 1,
      permission: 'read',
      name,
      label: `读取学习路径「${detail.summary.title}」`,
      summary: `读取「${detail.summary.title}」，共 ${detail.nodes.length} 个节点（已完成 ${detail.summary.finishedCount}/${detail.summary.videoCount} 个视频）。`,
      result: detail as unknown as Record<string, unknown>,
    };
  }

  if (name === 'learning_path_propose') {
    assertOnlyKeys(input, [
      'mode',
      'pathId',
      'title',
      'description',
      'nodes',
      'rationale',
    ]);
    if (!capabilities.proposeLearningPath) {
      throw new Error('当前环境尚未启用学习路径提案能力。');
    }
    const mode = input.mode;
    if (mode !== 'create' && mode !== 'replace' && mode !== 'append_nodes') {
      throw new Error('参数 mode 必须是 create、replace 或 append_nodes。');
    }
    const pathId =
      input.pathId === undefined || input.pathId === null
        ? undefined
        : requireString(input, 'pathId', 64);
    if ((mode === 'replace' || mode === 'append_nodes') && !pathId) {
      throw new Error(`${mode} 模式必须提供目标 pathId。`);
    }
    const title = requireString(input, 'title', 120);
    const description =
      input.description === undefined || input.description === null
        ? undefined
        : requireString(input, 'description', 2000, 0);
    const rationale = requireString(input, 'rationale', 500, 0);
    if (
      !Array.isArray(input.nodes) ||
      input.nodes.length === 0 ||
      input.nodes.length > 120
    ) {
      throw new Error('参数 nodes 必须是包含 1 到 120 个节点的数组。');
    }
    const parsedNodes: ProposeLearningPathRawNode[] = input.nodes.map(
      (rawItem, index) => {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          throw new Error(`nodes[${index}] 必须是对象。`);
        }
        const item = rawItem as Record<string, unknown>;
        assertOnlyKeys(item, [
          'nodeId',
          'parentId',
          'position',
          'kind',
          'title',
          'note',
          'videoUrlOrId',
          'startSeconds',
          'optional',
          'prerequisiteIds',
        ]);
        const nodeId = requireString(item, 'nodeId', 64);
        const nodeTitle = requireString(item, 'title', 200);
        const parentId =
          item.parentId === undefined || item.parentId === null
            ? null
            : requireString(item, 'parentId', 64, 0) || null;
        const position =
          item.position === undefined
            ? index
            : requireInteger(item, 'position');
        let kind: LearningPathNodeKind | undefined;
        if (item.kind !== undefined) {
          if (
            item.kind !== 'stage' &&
            item.kind !== 'video' &&
            item.kind !== 'checkpoint'
          ) {
            throw new Error(`节点 ${nodeId} 的 kind 无效。`);
          }
          kind = item.kind;
        }
        const note =
          item.note === undefined || item.note === null
            ? null
            : requireString(item, 'note', 1500, 0) || null;
        const videoUrlOrId =
          item.videoUrlOrId === undefined || item.videoUrlOrId === null
            ? null
            : requireString(item, 'videoUrlOrId', 300, 0) || null;
        const startSeconds =
          item.startSeconds === undefined
            ? undefined
            : requireInteger(item, 'startSeconds');
        const optional =
          item.optional === undefined ? false : Boolean(item.optional);
        let prerequisiteIds: string[] = [];
        if (item.prerequisiteIds !== undefined) {
          if (
            !Array.isArray(item.prerequisiteIds) ||
            item.prerequisiteIds.length > 16
          ) {
            throw new Error(`节点 ${nodeId} 的 prerequisiteIds 格式无效。`);
          }
          prerequisiteIds = item.prerequisiteIds.map((req, reqIdx) => {
            if (typeof req !== 'string' || !req.trim()) {
              throw new Error(
                `节点 ${nodeId} 的 prerequisiteIds[${reqIdx}] 必须是非空字符串。`,
              );
            }
            return req.trim();
          });
        }
        return {
          nodeId,
          parentId,
          position,
          kind,
          title: nodeTitle,
          note,
          videoUrlOrId,
          startSeconds,
          optional,
          prerequisiteIds,
        };
      },
    );

    const learningPathProposal = await capabilities.proposeLearningPath({
      mode,
      pathId,
      title,
      description,
      nodes: parsedNodes,
      rationale,
    });
    const modeLabel =
      mode === 'create'
        ? '新建学习路径'
        : mode === 'replace'
          ? '更新学习路径'
          : '扩展学习路径';
    return {
      version: 1,
      permission: 'user_approval',
      name,
      label: `预览${modeLabel}「${learningPathProposal.input.title}」`,
      summary: `${modeLabel}「${learningPathProposal.input.title}」（共 ${learningPathProposal.input.nodes.length} 个节点、${learningPathProposal.videoCount} 个视频），等待你确认。`,
      result: {
        status: 'awaiting_user_approval',
        mode,
        pathId: learningPathProposal.input.pathId ?? null,
        title: learningPathProposal.input.title,
        nodeCount: learningPathProposal.input.nodes.length,
        addedNodeCount: learningPathProposal.addedNodeCount,
        videoCount: learningPathProposal.videoCount,
        stageCount: learningPathProposal.stageCount,
        rationale: learningPathProposal.rationale,
      },
      learningPathProposal,
    };
  }

  if (name === 'favorites_get_board') {
    assertOnlyKeys(input, []);
    if (!capabilities.getFavoritesBoard) {
      throw new Error('当前环境尚未启用播放器收藏看板读取能力。');
    }
    const snapshot = await capabilities.getFavoritesBoard();
    const categoryNameById = new Map(
      snapshot.categories.map((cat) => [cat.categoryId, cat.name]),
    );
    const items = snapshot.items.map((entry) => ({
      videoId: entry.video.videoId,
      title: entry.video.title,
      channelName: entry.video.channelName,
      channelId: entry.video.channelId,
      categoryId: entry.categoryId,
      categoryName: entry.categoryId
        ? (categoryNameById.get(entry.categoryId) ?? null)
        : null,
      finished: entry.video.finished,
      note: entry.note,
    }));
    const uncategorizedCount = items.filter(
      (item) => item.categoryId === null,
    ).length;
    return {
      version: 1,
      permission: 'read',
      name,
      label: '读取收藏视频与分类',
      summary: `当前共有 ${snapshot.categories.length} 个分类、${items.length} 个收藏视频（其中未分类 ${uncategorizedCount} 个）。`,
      result: {
        categories: snapshot.categories.map((cat) => ({
          categoryId: cat.categoryId,
          name: cat.name,
          color: cat.color,
          itemCount: cat.itemCount,
          channelIds: cat.channelIds,
        })),
        uncategorizedCount,
        items,
      },
    };
  }

  if (name === 'favorites_propose_categorization') {
    assertOnlyKeys(input, ['newCategories', 'assignments', 'rationale']);
    if (!capabilities.proposeFavoritesCategorization) {
      throw new Error('当前环境尚未启用收藏视频智能归类能力。');
    }
    const allowedColors = new Set<FavoriteCategoryColor>([
      'terracotta',
      'ocean',
      'sage',
      'amber',
      'plum',
      'teal',
      'rose',
      'slate',
    ]);
    let newCategories:
      | Array<{ name: string; color?: FavoriteCategoryColor }>
      | undefined;
    if (input.newCategories !== undefined) {
      if (
        !Array.isArray(input.newCategories) ||
        input.newCategories.length > 20
      ) {
        throw new Error('参数 newCategories 必须是最多 20 项的分类数组。');
      }
      newCategories = input.newCategories.map((rawCat, idx) => {
        if (!rawCat || typeof rawCat !== 'object' || Array.isArray(rawCat)) {
          throw new Error(`第 ${idx + 1} 个新分类格式无效。`);
        }
        const catObj = rawCat as Record<string, unknown>;
        assertOnlyKeys(catObj, ['name', 'color']);
        const catName = requireString(catObj, 'name', 60);
        let color: FavoriteCategoryColor | undefined;
        if (catObj.color !== undefined && catObj.color !== null) {
          const rawColor = requireString(catObj, 'color', 24);
          if (!allowedColors.has(rawColor as FavoriteCategoryColor)) {
            throw new Error(`不支持的分类颜色：${rawColor}`);
          }
          color = rawColor as FavoriteCategoryColor;
        }
        return { name: catName, color };
      });
    }

    if (
      !Array.isArray(input.assignments) ||
      input.assignments.length === 0 ||
      input.assignments.length > 200
    ) {
      throw new Error('参数 assignments 必须是包含 1 到 200 条记录的数组。');
    }
    const assignments = input.assignments.map((rawAssign, idx) => {
      if (
        !rawAssign ||
        typeof rawAssign !== 'object' ||
        Array.isArray(rawAssign)
      ) {
        throw new Error(`第 ${idx + 1} 条归类记录格式无效。`);
      }
      const assignObj = rawAssign as Record<string, unknown>;
      assertOnlyKeys(assignObj, ['videoId', 'categoryName', 'note']);
      const videoId = requireString(assignObj, 'videoId', 32);
      const categoryName = requireString(assignObj, 'categoryName', 60);
      const note =
        assignObj.note === undefined || assignObj.note === null
          ? null
          : requireString(assignObj, 'note', 500, 0);
      return { videoId, categoryName, note };
    });
    const rationale = requireString(input, 'rationale', 500, 0);

    const proposal = await capabilities.proposeFavoritesCategorization({
      newCategories,
      assignments,
      rationale,
    });
    return {
      version: 1,
      permission: 'user_approval',
      name,
      label: '预览收藏视频分类整理',
      summary: `提议新建 ${proposal.newCategories.length} 个分类、归类 ${proposal.assignments.length} 个收藏视频，等待你确认。`,
      result: {
        status: 'awaiting_user_approval',
        newCategoryCount: proposal.newCategories.length,
        assignmentCount: proposal.assignments.length,
        rationale: proposal.rationale,
      },
      favoritesCategorizationProposal: proposal,
    };
  }

  throw new Error(`模型请求了未注册的工具：${name}`);
}

const NODE_ID_PATTERN = /^[A-Za-z0-9_:-]{1,64}$/;

export function buildValidatedLearningPathNodes(
  rawNodes: ProposeLearningPathRawNode[],
  existingDetail: LearningPathDetail | null,
  mode: LearningPathProposalMode,
): LearningPathNodeInput[] {
  const baseNodes: LearningPathNodeInput[] =
    mode === 'append_nodes' && existingDetail
      ? existingDetail.nodes.map((node) => ({
          nodeId: node.nodeId,
          parentId: node.parentId,
          position: node.position,
          kind: node.kind,
          title: node.title,
          note: node.note,
          videoId: node.videoId,
          startSeconds: node.startSeconds,
          optional: node.optional,
          prerequisiteIds: [...node.prerequisiteIds],
        }))
      : [];

  const maxExistingPosition = baseNodes.reduce(
    (max, node) => Math.max(max, node.position),
    -1,
  );

  const incomingNodes: LearningPathNodeInput[] = rawNodes.map((raw, index) => {
    const nodeId = raw.nodeId.trim();
    if (!NODE_ID_PATTERN.test(nodeId)) {
      throw new Error(
        `节点编号「${nodeId}」无效，仅限字母、数字、下划线、短横线或冒号。`,
      );
    }
    let videoId: string | null = null;
    let parsedStart = 0;
    if (raw.videoUrlOrId && raw.videoUrlOrId.trim()) {
      const target = parseYouTubeTarget(raw.videoUrlOrId.trim());
      if (!target || target.kind !== 'video') {
        throw new Error(
          `节点「${raw.title}」的 videoUrlOrId 不是有效的 YouTube 视频链接或 11 位编号：${raw.videoUrlOrId}`,
        );
      }
      videoId = target.videoId;
      parsedStart = target.startSeconds;
    }
    const kind: LearningPathNodeKind =
      raw.kind ?? (videoId ? 'video' : 'stage');
    const position =
      mode === 'append_nodes'
        ? maxExistingPosition + 1 + index
        : (raw.position ?? index);

    return {
      nodeId,
      parentId: raw.parentId?.trim() || null,
      position,
      kind,
      title: raw.title.trim(),
      note: raw.note?.trim() || null,
      videoId,
      startSeconds:
        raw.startSeconds !== undefined ? raw.startSeconds : parsedStart,
      optional: Boolean(raw.optional),
      prerequisiteIds: Array.from(
        new Set(
          (raw.prerequisiteIds ?? []).map((id) => id.trim()).filter(Boolean),
        ),
      ),
    };
  });

  const merged = [...baseNodes, ...incomingNodes];
  if (merged.length > 200) {
    throw new Error('合并后的学习路径超过 200 个节点上限。');
  }
  const seen = new Set<string>();
  for (const node of merged) {
    if (seen.has(node.nodeId)) {
      throw new Error(`节点编号重复：${node.nodeId}`);
    }
    seen.add(node.nodeId);
  }
  const adj = new Map<string, string[]>();
  for (const node of merged) adj.set(node.nodeId, []);
  for (const node of merged) {
    if (node.parentId) {
      if (node.parentId === node.nodeId) {
        throw new Error(`节点「${node.title}」不能将自身设为父节点。`);
      }
      if (!seen.has(node.parentId)) {
        throw new Error(
          `节点「${node.title}」引用了不存在的父节点：${node.parentId}`,
        );
      }
      adj.get(node.parentId)!.push(node.nodeId);
    }
    for (const req of node.prerequisiteIds ?? []) {
      if (req === node.nodeId) {
        throw new Error(`节点「${node.title}」不能将自身设为前置依赖。`);
      }
      if (!seen.has(req)) {
        throw new Error(
          `节点「${node.title}」引用了不存在的前置依赖节点：${req}`,
        );
      }
      adj.get(req)!.push(node.nodeId);
    }
  }

  const color = new Map<string, number>();
  const hasCycle = (id: string): boolean => {
    const state = color.get(id) ?? 0;
    if (state === 1) return true;
    if (state === 2) return false;
    color.set(id, 1);
    for (const next of adj.get(id) ?? []) {
      if (hasCycle(next)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const node of merged) {
    if ((color.get(node.nodeId) ?? 0) === 0 && hasCycle(node.nodeId)) {
      throw new Error('学习路径存在循环依赖（父子或前置关系成环）。');
    }
  }

  return merged;
}
