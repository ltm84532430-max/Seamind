import type { MapDocument, OpenedDocument } from '../library';
import {
  MAX_AGENT_BRANCH_CHARS,
  MAX_MARKDOWN_NODE_NOTE_CHARS,
} from '../mindmap/commands';
import type {
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

export interface AgentCapabilities {
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
