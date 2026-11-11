import type {
  LearningPathDetail,
  LearningPathNodeInput,
  LearningPathNodeKind,
} from '../../player/types';
import {
  parseYouTubeTarget,
  thumbnailUrl,
  videoWatchUrl,
} from '../../player/video-links';
import { LEARNING_PATH_BUDGET } from '../learning-path-budget';
import type {
  AgentCapabilities,
  AgentToolResult,
  ProposeLearningPathRawNode,
} from '../tool-api';
import type { AgentToolDescriptor, LearningPathProposalMode } from '../types';
import { assertOnlyKeys, requireInteger, requireString, schema } from './parse';

export const learningPathToolCatalog: AgentToolDescriptor[] = [
  {
    version: 1,
    name: 'player_search_youtube',
    description: `只读搜索 YouTube 视频，返回真实的 11 位 videoId、观看链接、标题、频道名称、时长（秒）与观看量。构建深度学习路径时必须采用「学术理论（MIT/CMU/Stanford/ETH/pwn.college 公开课、形式化模型、RFC/论文）× 底层工程实践（内核/编译器源码剖析、GDB/Wireshark/eBPF 调试、USENIX/DEF CON/Black Hat 顶会演讲、经典 Lab 靶场）」双螺旋正交检索策略，本会话只搜索 ${LEARNING_PATH_BUDGET.minSearches}–${LEARNING_PATH_BUDGET.maxSearches} 次，每次 limit 为 ${LEARNING_PATH_BUDGET.searchLimit}，用来准备第一段路径；更大的星图等用户确认后再追加。严禁凭记忆编造 videoId。`,
    permission: 'read',
    inputSchema: schema(
      {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          description:
            'YouTube 搜索关键词（建议分别检索英文名校课程号/顶会名如 "MIT 6.824 lecture"、"CMU 15-445"、"USENIX Security"、"Linux kernel internals" 与中文深度源码/工程解析关键词）。',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description: `最多返回条数。本会话请传 ${LEARNING_PATH_BUDGET.searchLimit}（接口最大 30）。`,
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
    description: `为播放器提出创建（create）、整体替换（replace）或向已有学习路径追加节点（append_nodes）的提案。这一轮提交第一段路径（${LEARNING_PATH_BUDGET.minStages}–${LEARNING_PATH_BUDGET.maxStages} 个知识星域 stage、${LEARNING_PATH_BUDGET.minNodes}–${LEARNING_PATH_BUDGET.maxNodes} 个节点）以及跨领域前置依赖拓扑（prerequisiteIds）。更大的星图在用户确认后再追加。每个阶段内部需兼顾「学术理论基座」与「底层工程实现/实验靶场」，每个视频节点的 videoUrlOrId 必须来自 player_search_youtube、现有路径或用户明确提供的真实 YouTube 链接/11位编号。此工具只打开预览弹窗，必须经用户点击确认后才会写入数据库并打开路径。`,
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
          description: '学习路径简介、学术对标课程与工程实践目标。',
        },
        nodes: {
          type: 'array',
          minItems: 1,
          maxItems: 260,
          items: schema(
            {
              nodeId: {
                type: 'string',
                minLength: 1,
                maxLength: 64,
                description:
                  '路径内唯一节点 ID（仅字母、数字、_、-、:），例如 stage-kernel、vid-vm-pagetable。',
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
                  'stage 表示阶段/星域分组节点；video 表示具体视频课；checkpoint 表示阶段里程碑/综合工程靶场节点。',
              },
              title: {
                type: 'string',
                minLength: 1,
                maxLength: 200,
                description: '节点显示标题（建议使用精准学术与工程术语）。',
              },
              note: {
                type: 'string',
                maxLength: 1500,
                description:
                  '学习要点与三级知识卫星点：建议以【学术理论】/【工程实现】/【源码实验】标注定位，并用顿号「、」或逗号列出 3–6 个核心底层概念（星图视图会自动将其解析为第三级知识微粒点）。',
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

async function player_search_youtube(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'player_search_youtube';

  assertOnlyKeys(input, ['query', 'limit']);
  if (!capabilities.searchYouTubeVideos) {
    throw new Error('当前环境尚未启用播放器 YouTube 搜索能力。');
  }
  const query = requireString(input, 'query', 160);
  const limit =
    input.limit === undefined
      ? LEARNING_PATH_BUDGET.searchLimit
      : Math.max(1, Math.min(30, requireInteger(input, 'limit')));
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

async function learning_path_list(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'learning_path_list';

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

async function learning_path_get(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'learning_path_get';

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

async function learning_path_propose(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'learning_path_propose';

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
    input.nodes.length > 260
  ) {
    throw new Error('参数 nodes 必须是包含 1 到 260 个节点的数组。');
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
        item.position === undefined ? index : requireInteger(item, 'position');
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

export const learningPathHandlers = {
  player_search_youtube,
  learning_path_list,
  learning_path_get,
  learning_path_propose,
};

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
