import type { Transformer } from 'markmap-lib';
import type { EditorDraft } from '../app/app-storage';
import {
  buildMarkdownNodeSourceMap,
  applyMarkdownNodeBranch,
  applyMarkdownNodeCommand,
  getMarkdownNodeNote,
  markdownForMindmap,
  MAX_AGENT_BRANCH_CHARS,
  normalizeMindmapText,
} from '../mindmap/commands';
import { normalizeMindmapPureTree } from '../library/app-tree-utils';
import {
  buildAgentMindmapTree,
  findAgentMindmapNode,
  markdownTitle,
  prepareGeneratedBranchAssets,
} from '../mindmap/app-mindmap-utils';
import { playerApi } from '../player/player-api';
import type { VideoInput } from '../player/types';
import { buildValidatedLearningPathNodes } from './tools/learning-path';
import type {
  ProposeLearningPathInput,
  ProposeNodeEditInput,
} from './tool-api';
import type {
  ActiveMindmapSnapshot,
  AgentAnalysisMode,
  LearningPathProposal,
  NodeEditProposal,
} from './types';

type EnsureAiMathRenderable = (
  markdown: string,
  source: string,
  checkNodeLabels?: boolean,
) => void;

export interface AgentNodeBranchInput {
  baseRevision: number;
  nodeId?: string;
  nodePath?: string;
  analysisMode: AgentAnalysisMode;
  branchMarkdown: string;
  rationale: string;
}

export function readAgentMindmap(
  draft: EditorDraft,
  transformer: Transformer,
): ActiveMindmapSnapshot {
  const root = normalizeMindmapPureTree(
    transformer.transform(markdownForMindmap(draft.markdown)).root,
  );
  const sources = buildMarkdownNodeSourceMap(draft.markdown, root);
  const tree = buildAgentMindmapTree(root, sources, draft.markdown);
  return {
    title: draft.title,
    revision: draft.revision,
    relativePath: draft.relativePath,
    nodeCount: tree.nodeCount,
    truncated: tree.truncated,
    markdown: draft.markdown,
    root: tree.root,
  };
}

export function buildAgentNodeEditProposal(args: {
  draft: EditorDraft;
  transformer: Transformer;
  input: ProposeNodeEditInput;
  ensureAiMathRenderable: EnsureAiMathRenderable;
}): NodeEditProposal {
  const { draft, transformer, input, ensureAiMathRenderable } = args;
  if (draft.revision !== input.baseRevision) {
    throw new Error('当前导图已变化，请重新读取后再提出修改。');
  }
  const root = normalizeMindmapPureTree(
    transformer.transform(markdownForMindmap(draft.markdown)).root,
  );
  const sources = buildMarkdownNodeSourceMap(draft.markdown, root);
  const targetEntry = input.nodeId
    ? [...sources.entries()].find(([, source]) => source.id === input.nodeId)
    : input.nodePath
      ? ([input.nodePath, sources.get(input.nodePath)] as const)
      : undefined;
  const [nodePath, source] = targetEntry || [];
  if (!nodePath || !source) {
    throw new Error('找不到这个节点的 Markdown 源位置，请重新读取导图。');
  }
  const targetSnapshot = findAgentMindmapNode(
    buildAgentMindmapTree(root, sources, draft.markdown).root,
    nodePath,
  );
  if (!targetSnapshot?.allowedOperations.includes(input.operation)) {
    throw new Error(
      '此节点不支持该操作，请按当前导图快照中的 allowedOperations 修改。',
    );
  }
  const command = applyMarkdownNodeCommand(
    draft.markdown,
    source,
    input.operation,
    input.text,
  );
  if (command.markdown === draft.markdown) {
    throw new Error('提案没有产生任何 Markdown 变化。');
  }
  if (input.operation !== 'delete') {
    if (input.operation === 'set_note') {
      ensureAiMathRenderable(input.text, 'AI 节点备注', false);
    } else {
      const nodeLabel = input.text.replace(/\s*\n+\s*/g, ' ').trim();
      ensureAiMathRenderable(`- ${nodeLabel}`, 'AI 节点修改');
    }
  }
  const previousNote = source.id
    ? getMarkdownNodeNote(draft.markdown, source.id)
    : '';
  const nextLabel =
    input.operation === 'delete'
      ? '删除该节点及其子节点'
      : input.operation === 'set_note'
        ? '更新节点备注'
        : input.operation === 'rename'
          ? input.text.replace(/\s*\n+\s*/g, ' ').trim()
          : input.text.replace(/\s*\n+\s*/g, ' ').trim() || '新主题';
  return {
    baseRevision: draft.revision,
    baseRelativePath: draft.relativePath,
    baseMarkdown: draft.markdown,
    baseTitle: draft.title,
    markdown: command.markdown,
    title: markdownTitle(command.markdown),
    nodeId: command.nodeId || source.id || null,
    nodePath,
    operation: input.operation,
    previousLabel: source.label,
    nextLabel,
    ...(input.operation === 'set_note'
      ? { previousNote, nextNote: input.text }
      : {}),
    rationale: input.rationale,
  };
}

export function buildAgentNodeBranchProposal(args: {
  draft: EditorDraft;
  transformer: Transformer;
  input: AgentNodeBranchInput;
  ensureAiMathRenderable: EnsureAiMathRenderable;
}): NodeEditProposal {
  const { draft, transformer, input, ensureAiMathRenderable } = args;
  if (draft.revision !== input.baseRevision) {
    throw new Error('当前导图已变化，请重新读取后再生成下探分支。');
  }
  if (input.branchMarkdown.length > MAX_AGENT_BRANCH_CHARS) {
    throw new Error('生成的下探分支超过字符上限，请缩小主题后重试。');
  }
  const root = normalizeMindmapPureTree(
    transformer.transform(markdownForMindmap(draft.markdown)).root,
  );
  const sources = buildMarkdownNodeSourceMap(draft.markdown, root);
  const targetEntry = input.nodeId
    ? [...sources.entries()].find(([, source]) => source.id === input.nodeId)
    : input.nodePath
      ? ([input.nodePath, sources.get(input.nodePath)] as const)
      : undefined;
  const [nodePath, source] = targetEntry || [];
  if (!nodePath || !source) {
    throw new Error('找不到目标节点的 Markdown 源位置，请重新选择节点。');
  }
  const target = findAgentMindmapNode(
    buildAgentMindmapTree(root, sources, draft.markdown).root,
    nodePath,
  );
  if (!target?.allowedOperations.includes('add_branch')) {
    throw new Error('该节点不支持添加下探分支，请选择普通标题或列表节点。');
  }
  const prepared = prepareGeneratedBranchAssets(input.branchMarkdown);
  ensureAiMathRenderable(prepared.markdown, 'AI 分支');
  const command = applyMarkdownNodeBranch(
    draft.markdown,
    source,
    prepared.markdown,
  );
  const firstHeading = prepared.markdown.match(/^\s*#{1,6}\s+(.+)$/m)?.[1];
  const nextLabel = firstHeading
    ? normalizeMindmapText(firstHeading)
    : '下探分支';
  return {
    baseRevision: draft.revision,
    baseRelativePath: draft.relativePath,
    baseMarkdown: draft.markdown,
    baseTitle: draft.title,
    markdown: command.markdown,
    title: markdownTitle(command.markdown),
    nodeId: command.nodeId || source.id || null,
    nodePath,
    operation: 'add_branch',
    previousLabel: source.label,
    nextLabel,
    rationale: input.rationale,
    analysisMode: input.analysisMode,
    branchMarkdown: prepared.markdown,
    ...(prepared.assets.length ? { htmlAssets: prepared.assets } : {}),
  };
}

export async function buildLearningPathProposal(args: {
  input: ProposeLearningPathInput;
  cachedVideo: (videoId: string) => VideoInput | undefined;
}): Promise<LearningPathProposal> {
  const { input, cachedVideo } = args;
  const requestedPathId = input.pathId?.trim() || undefined;
  if (
    (input.mode === 'replace' || input.mode === 'append_nodes') &&
    !requestedPathId
  ) {
    throw new Error('替换或扩展路径时必须指定目标路径。');
  }
  const existingDetail = requestedPathId
    ? await playerApi.learningPathGet(requestedPathId)
    : null;
  if (
    (input.mode === 'replace' || input.mode === 'append_nodes') &&
    !existingDetail
  ) {
    throw new Error(`找不到目标学习路径：${requestedPathId}`);
  }
  if (input.mode === 'create' && existingDetail) {
    throw new Error(`路径编号已存在：${requestedPathId}`);
  }

  const nodes = buildValidatedLearningPathNodes(
    input.nodes,
    existingDetail,
    input.mode,
  );
  const videoIds = Array.from(
    new Set(
      nodes
        .map((node) => node.videoId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const videosById = new Map<string, VideoInput>();
  for (const id of videoIds) {
    const cached = cachedVideo(id);
    if (cached) videosById.set(id, cached);
  }
  const knownVideos = await playerApi.videoItems(videoIds).catch(() => []);
  for (const video of knownVideos) {
    if (!videosById.has(video.videoId)) {
      videosById.set(video.videoId, {
        videoId: video.videoId,
        channelId: video.channelId,
        channelName: video.channelName,
        title: video.title,
        publishedAt: video.publishedAt,
        publishedApprox: video.publishedApprox,
        durationSeconds: video.durationSeconds,
        viewCount: video.viewCount,
        viewText: video.viewText,
        thumbnailUrl: video.thumbnailUrl,
      });
    }
  }
  for (const id of videoIds) {
    if (videosById.has(id)) continue;
    const basics = await playerApi.fetchVideoInfo(id);
    if (!basics.title.trim()) {
      throw new Error(`无法从 YouTube 读取视频 ${id} 的标题。`);
    }
    videosById.set(id, {
      videoId: id,
      title: basics.title,
      channelName: basics.channelName,
    });
  }

  const videos = videoIds.map((id) => videosById.get(id)!);
  const newNodeCount =
    input.mode === 'append_nodes'
      ? Math.max(0, nodes.length - (existingDetail?.nodes.length ?? 0))
      : nodes.length;
  return {
    mode: input.mode,
    existingTitle: existingDetail?.summary.title ?? null,
    existingNodeCount: existingDetail?.nodes.length ?? 0,
    input: {
      ...(input.mode === 'create'
        ? requestedPathId
          ? { pathId: requestedPathId }
          : {}
        : { pathId: requestedPathId }),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      nodes,
      videos,
    },
    addedNodeCount: newNodeCount,
    videoCount: videoIds.length,
    stageCount: nodes.filter((node) => node.kind === 'stage').length,
    rationale: input.rationale.trim(),
  };
}
