import type { LearningPathProposal } from '../agent/types';
import type {
  LearningPathInput,
  LearningPathNodeInput,
  VideoInput,
} from './types';
import { parseYouTubeTarget } from './video-links';

/**
 * Extracts a structured LearningPathProposal from an AI reply or Markdown text.
 * Handles headings (### 阶段 1: ...), numbered lists, bullet points, and YouTube URLs/IDs.
 */
export function extractProposalFromText(
  defaultTitle: string,
  text: string,
): LearningPathProposal | null {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  const lines = raw.split(/\r?\n/);
  const nodes: LearningPathNodeInput[] = [];
  const videos: VideoInput[] = [];
  const seenVideoIds = new Set<string>();

  let currentStageId: string | null = null;
  let stageCount = 0;
  let videoCount = 0;
  let nodeIndex = 0;

  // Regexes for stage headings:
  // e.g. "### 阶段 1: 入门", "## 1. 基础知识", "**阶段一：核心概念**", "第 1 阶段：..."
  const stageHeaderRegex =
    /^(?:#{1,4}\s*|\*{1,2}\s*|\d+[.、:]\s*)?(?:第\s*[\d一二三四五六七八九十]+\s*阶段|阶段\s*[\d一二三四五六七八九十]+|Stage\s*\d+|Step\s*\d+)[\s:：、.-]*(.+)$/i;
  // Alternate heading check: "### 1. xxx" or "## xxx"
  const alternateHeadingRegex =
    /^#{2,4}\s+(?:[\d一二三四五六七八九十]+[.、\s]*)?(.+)$/;

  // Check for bullet point or list line with possible YouTube links
  // e.g. "- [Title](https://www.youtube.com/watch?v=xxx)", "* Title: https://youtu.be/xxx", "1. Title (xxx)"
  const urlRegex = /(https?:\/\/[^\s)>\]]+|[\w-]{11})/g;

  const cleanTitle = (str: string): string => {
    return str
      .replace(/^[\s*#\-–—\d.、:(（[【]+/, '')
      .replace(/[)）\]】*#]+$/, '')
      .trim();
  };

  const getOrCreateDefaultStage = (): string => {
    if (currentStageId) return currentStageId;
    stageCount += 1;
    const stageId = `stage-${stageCount}`;
    nodes.push({
      nodeId: stageId,
      parentId: null,
      position: nodeIndex++,
      kind: 'stage',
      title: '核心课程阶段',
      note: 'AI 推荐学习阶段',
    });
    currentStageId = stageId;
    return stageId;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if this line is a stage boundary
    const stageMatch =
      trimmed.match(stageHeaderRegex) ||
      (trimmed.startsWith('##') ? trimmed.match(alternateHeadingRegex) : null);

    if (stageMatch) {
      const stageTitle = cleanTitle(stageMatch[1] || stageMatch[0]);
      if (stageTitle && stageTitle.length > 1) {
        stageCount += 1;
        const stageId = `stage-${stageCount}`;
        nodes.push({
          nodeId: stageId,
          parentId: null,
          position: nodeIndex++,
          kind: 'stage',
          title: stageTitle,
          note: null,
        });
        currentStageId = stageId;
        continue;
      }
    }

    // Look for video links or IDs in this line
    const matches = Array.from(trimmed.matchAll(urlRegex));
    let detectedVideoId: string | null = null;

    for (const m of matches) {
      const candidate = m[1];
      const target = parseYouTubeTarget(candidate);
      if (target && target.kind === 'video') {
        detectedVideoId = target.videoId;
        break;
      }
    }

    // If a video was detected on this line
    if (detectedVideoId) {
      const stageId = getOrCreateDefaultStage();
      videoCount += 1;
      const nodeId = `vid-${videoCount}`;

      // Extract a clean title from the line (removing URL parts)
      let videoTitle = trimmed
        .replace(urlRegex, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^[\s*#\-–—\d.、:(（[【]+/, '')
        .replace(/[)）\]】*#:\s]+$/, '')
        .trim();

      if (!videoTitle || videoTitle.length < 2) {
        videoTitle = `课时 ${videoCount}`;
      }

      nodes.push({
        nodeId,
        parentId: stageId,
        position: nodeIndex++,
        kind: 'video',
        title: videoTitle,
        videoId: detectedVideoId,
        startSeconds: 0,
        optional: false,
      });

      if (!seenVideoIds.has(detectedVideoId)) {
        seenVideoIds.add(detectedVideoId);
        videos.push({
          videoId: detectedVideoId,
          title: videoTitle,
          channelName: null,
          durationSeconds: null,
        });
      }
      continue;
    }

    // If it's a bullet item under a stage without a URL, see if it looks like a lesson topic
    if (
      currentStageId &&
      (trimmed.startsWith('- ') ||
        trimmed.startsWith('* ') ||
        /^\d+\.\s/.test(trimmed))
    ) {
      const topicTitle = cleanTitle(trimmed);
      if (
        topicTitle &&
        topicTitle.length > 2 &&
        !topicTitle.includes('阶段') &&
        !topicTitle.includes('http')
      ) {
        videoCount += 1;
        const nodeId = `topic-${videoCount}`;
        nodes.push({
          nodeId,
          parentId: currentStageId,
          position: nodeIndex++,
          kind: 'video',
          title: topicTitle,
          videoId: null,
          startSeconds: 0,
          optional: false,
          note: '可后续手动挂载 YouTube 视频',
        });
      }
    }
  }

  // Must have at least 1 stage or 2 nodes to be a useful proposal
  if (nodes.length < 2 && videoCount === 0) {
    return null;
  }

  // Add a final completion milestone if not already present
  const hasCheckpoint = nodes.some((n) => n.kind === 'checkpoint');
  if (!hasCheckpoint && nodes.length > 0) {
    nodes.push({
      nodeId: 'checkpoint-finish',
      parentId: null,
      position: nodeIndex++,
      kind: 'checkpoint',
      title: '学成通关 · 知识体系收官',
      note: '恭喜完成该学习路径的所有模块',
    });
  }

  const input: LearningPathInput = {
    title: defaultTitle.trim() || 'AI 规划学习路径',
    description: `从 AI 规划内容自动解析生成，包含 ${stageCount} 个阶段，${videoCount} 个课程节点。`,
    nodes,
    videos: videos.length > 0 ? videos : undefined,
  };

  return {
    mode: 'create',
    input,
    rationale: `从 AI 输出内容解析提取：检测到 ${stageCount} 个阶段和 ${videoCount} 个课程节点。`,
    stageCount: Math.max(1, stageCount),
    videoCount,
    addedNodeCount: nodes.length,
  };
}
