import type { EpubBookDocument } from '../library';
import {
  epubBookIdentity,
  epubProgressKey,
  loadEpubReadingPlan,
} from '../ebook-storage';
import { loadLearningPaths } from '../ebook-learning-path';
import type { LearningPathDetail } from '../player/types';
import type { ImportPlan, TaskInput, TaskResource } from './types';

export interface ImportCandidate {
  key: string;
  label: string;
  source: '电子书技能路径' | '单书阅读计划' | '视频学习路径';
  draft: ImportPlan;
  missingBooks: number;
}

const sourceKey = (...parts: string[]) => JSON.stringify(parts);
const freshId = () => crypto.randomUUID();

function task(
  id: string,
  title: string,
  originKey: string,
  position: number,
): TaskInput {
  return {
    id,
    title: title.trim().slice(0, 240) || '未命名任务',
    status: 'todo',
    priority: 0,
    position,
    optional: false,
    resources: [],
    prerequisiteIds: [],
    originKey,
  };
}

function bookResource(
  rootPath: string,
  progressKey: string,
  title: string,
  books: EpubBookDocument[],
): { resource: TaskResource | null; missing: boolean } {
  const book = books.find((item) => epubProgressKey(item) === progressKey);
  const savedPath = /^library:(.*):\d+:\d+$/.exec(progressKey)?.[1];
  const relativePath = book?.relativePath || savedPath;
  if (!relativePath) return { resource: null, missing: true };
  return {
    resource: {
      kind: 'ebook',
      resourceId: `ebook:${epubBookIdentity(relativePath)}`,
      title,
      rootPath,
      relativePath,
      progressKey,
      bookId: epubBookIdentity(relativePath),
    },
    missing: !book,
  };
}

/** Builds a reviewable copy. The legacy browser records remain intact. */
export function ebookImportCandidates(
  rootPath: string,
  books: EpubBookDocument[],
): ImportCandidate[] {
  if (!rootPath) return [];
  const candidates: ImportCandidate[] = [];
  for (const path of loadLearningPaths(rootPath)) {
    const planOrigin = sourceKey('ebook-path', rootPath, path.id);
    const tasks: TaskInput[] = [];
    let missingBooks = 0;
    path.stages.forEach((stage, stageIndex) => {
      const stageId = freshId();
      tasks.push(
        task(
          stageId,
          stage.title,
          sourceKey('ebook-stage', rootPath, path.id, stage.id),
          stageIndex * 1000,
        ),
      );
      stage.books.forEach((entry, index) => {
        const result = bookResource(
          rootPath,
          entry.progressKey,
          entry.title,
          books,
        );
        if (result.missing) missingBooks += 1;
        const child = task(
          freshId(),
          entry.title,
          sourceKey('ebook-book', rootPath, path.id, stage.id, entry.id),
          stageIndex * 1000 + index + 1,
        );
        child.parentId = stageId;
        child.dueDate = entry.dueDate || null;
        if (result.resource) {
          child.resources = [
            {
              ...result.resource,
              targetUnit: 'words',
              targetValue: entry.targetWords,
              baseline: entry.baselineProgress,
              manualValue: entry.manualWords,
            },
          ];
        } else {
          child.note = '原计划中的电子书无法定位，请重新关联。';
        }
        tasks.push(child);
      });
    });
    candidates.push({
      key: planOrigin,
      label: path.title,
      source: '电子书技能路径',
      missingBooks,
      draft: {
        plan: { title: path.title.slice(0, 160), originKey: planOrigin },
        tasks,
      },
    });
  }

  for (const book of books) {
    const progressKey = epubProgressKey(book);
    const plan = loadEpubReadingPlan(progressKey);
    if (!plan) continue;
    const planOrigin = sourceKey('ebook-single', rootPath, progressKey);
    const entry = task(
      freshId(),
      `阅读 ${book.title}`,
      sourceKey('ebook-single-task', rootPath, progressKey),
      0,
    );
    entry.dueDate = plan.dueDate || null;
    entry.resources = [
      {
        kind: 'ebook',
        resourceId: `ebook:${epubBookIdentity(book.relativePath)}`,
        title: book.title,
        rootPath,
        relativePath: book.relativePath,
        progressKey,
        bookId: epubBookIdentity(book.relativePath),
        href: plan.startChapterHref || null,
        targetUnit: 'chapters',
        targetValue: plan.targetChapters,
        baseline: plan.startChapterIndex,
      },
    ];
    candidates.push({
      key: planOrigin,
      label: `${book.title} 阅读计划`,
      source: '单书阅读计划',
      missingBooks: 0,
      draft: {
        plan: {
          title: `${book.title} 阅读计划`.slice(0, 160),
          originKey: planOrigin,
        },
        tasks: [entry],
      },
    });
  }
  return candidates;
}

export function videoImportCandidate(
  detail: LearningPathDetail,
): ImportCandidate {
  const planOrigin = sourceKey('video-path', detail.summary.pathId);
  const ids = new Map(detail.nodes.map((node) => [node.nodeId, freshId()]));
  const tasks = detail.nodes.map((node) => {
    const current = task(
      ids.get(node.nodeId)!,
      node.title,
      sourceKey('video-node', detail.summary.pathId, node.nodeId),
      node.position,
    );
    current.note = node.note;
    current.optional = node.optional;
    if (node.parentId) {
      const parentId = ids.get(node.parentId);
      if (!parentId)
        throw new Error(`视频路径节点 ${node.title} 的父节点不存在。`);
      current.parentId = parentId;
    }
    current.prerequisiteIds = node.prerequisiteIds.map((id) => {
      const prerequisite = ids.get(id);
      if (!prerequisite)
        throw new Error(`视频路径节点 ${node.title} 的前置节点不存在。`);
      return prerequisite;
    });
    if (node.videoId)
      current.resources = [
        {
          kind: 'youtube',
          resourceId: node.videoId,
          title: node.video?.title || node.title,
          startSeconds: node.startSeconds,
        },
      ];
    return current;
  });
  return {
    key: planOrigin,
    label: detail.summary.title,
    source: '视频学习路径',
    missingBooks: 0,
    draft: {
      plan: {
        title: detail.summary.title.slice(0, 160),
        description: detail.summary.description,
        originKey: planOrigin,
      },
      tasks,
    },
  };
}
