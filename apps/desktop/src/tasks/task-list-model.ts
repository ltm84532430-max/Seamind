import type { LibrarySnapshot } from '../library/library';
import {
  epubProgressKey,
  findLibraryEpubForTask,
  getEpubReadingPlanCompleted,
  loadEpubBookMetadata,
  loadEpubReadingActivity,
  loadEpubReadingPlan,
  sameEpubProgressFile,
} from '../ebook/ebook-storage';
import type { WatchState } from '../player/types';
import type {
  LearningTask,
  TaskInput,
  TaskResource,
  TaskStatus,
} from './types';

export type TaskSortBy = 'position' | 'priority' | 'dueDate' | 'updatedAt';

export type TaskQuickFilter = 'all' | 'high' | 'unblocked' | 'cancelled';

export const TASK_PRIORITY_LABELS: Record<number, string> = {
  0: '普通',
  1: '低',
  2: '中',
  3: '高',
};

/** 统计某个计划下未归档的活跃任务数，确保与列表/看板展示口径一致。 */
export function countPlanActiveTasks(
  tasks: ReadonlyArray<Pick<LearningTask, 'planId' | 'archivedAt'>>,
  planId: string,
): number {
  return tasks.filter((item) => !item.archivedAt && item.planId === planId)
    .length;
}

/** 按指定维度比较两个任务的顺序。 */
export function compareTasksBy(
  left: Pick<
    LearningTask,
    'position' | 'createdAt' | 'updatedAt' | 'priority' | 'dueDate' | 'title'
  >,
  right: Pick<
    LearningTask,
    'position' | 'createdAt' | 'updatedAt' | 'priority' | 'dueDate' | 'title'
  >,
  sortBy: TaskSortBy,
): number {
  if (sortBy === 'priority') {
    if (left.priority !== right.priority) return right.priority - left.priority;
  } else if (sortBy === 'dueDate') {
    const leftDate = left.dueDate ?? '\uffff';
    const rightDate = right.dueDate ?? '\uffff';
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
  } else if (sortBy === 'updatedAt') {
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
  }
  return (
    left.position - right.position ||
    left.createdAt - right.createdAt ||
    left.title.localeCompare(right.title, 'zh-CN')
  );
}

/** 收集某任务的全部后代节点 ID，避免编辑父任务时形成循环引用。 */
export function collectTaskDescendantIds(
  tasks: ReadonlyArray<Pick<LearningTask, 'id' | 'parentId'>>,
  rootId: string,
): Set<string> {
  const childrenMap = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const list = childrenMap.get(task.parentId) ?? [];
    list.push(task.id);
    childrenMap.set(task.parentId, list);
  }
  const result = new Set<string>();
  const stack = [...(childrenMap.get(rootId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (result.has(next) || next === rootId) continue;
    result.add(next);
    const grandchildren = childrenMap.get(next);
    if (grandchildren) stack.push(...grandchildren);
  }
  return result;
}

/** 提取排序且去重后的 YouTube 视频 ID 键，用于仅在关联视频变化时再拉取播放进度。 */
export function extractSortedVideoIds(
  tasks: ReadonlyArray<Pick<LearningTask, 'resources'>>,
): string {
  const ids = new Set<string>();
  for (const task of tasks) {
    for (const resource of task.resources) {
      if (resource.kind === 'youtube' && resource.resourceId) {
        ids.add(resource.resourceId);
      }
    }
  }
  return [...ids].sort().join(',');
}

export type ResourceTargetUnit = '' | 'chapters' | 'words' | 'seconds';
export type TaskResourceDraft = {
  key: string;
  kind: TaskResource['kind'];
  original: TaskResource | null;
  bookPath: string;
  chapterHref: string;
  videoInput: string;
  startSeconds: string;
  targetUnit: ResourceTargetUnit;
  targetValue: string;
  manualValue: string;
};

export type StatusUndo = {
  taskId: string;
  previousStatus: TaskStatus;
  nextStatus: TaskStatus;
  title: string;
};

export function resourceDraft(
  resource?: TaskResource,
  kind: TaskResource['kind'] = 'ebook',
): TaskResourceDraft {
  return {
    key: crypto.randomUUID(),
    kind: resource?.kind ?? kind,
    original: resource ?? null,
    bookPath: resource?.kind === 'ebook' ? (resource.relativePath ?? '') : '',
    chapterHref: resource?.kind === 'ebook' ? (resource.href ?? '') : '',
    videoInput: resource?.kind === 'youtube' ? resource.resourceId : '',
    startSeconds: String(resource?.startSeconds ?? 0),
    targetUnit: resource?.targetUnit ?? '',
    targetValue:
      resource?.targetValue == null ? '' : String(resource.targetValue),
    manualValue:
      resource?.manualValue == null ? '' : String(resource.manualValue),
  };
}

const TASK_VIEW_KEY = 'seamind:task-view:v1';
const TASK_WORKSPACE_MODE_KEY = 'seamind:task-workspace-mode:v1';
const TASK_COLLAPSE_KEY = 'seamind:task-collapse:v1';
const TASK_SIDEBAR_COLLAPSED_KEY = 'seamind:task-sidebar-collapsed:v1';

export function readTaskSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(TASK_SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function readWorkspaceMode(): 'tasks' | 'habits' {
  try {
    return sessionStorage.getItem(TASK_WORKSPACE_MODE_KEY) === 'habits'
      ? 'habits'
      : 'tasks';
  } catch {
    return 'tasks';
  }
}

export function writeTaskSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(TASK_SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Keep the current state for this session when storage is unavailable.
  }
}

export function writeWorkspaceMode(mode: 'tasks' | 'habits'): void {
  try {
    sessionStorage.setItem(TASK_WORKSPACE_MODE_KEY, mode);
  } catch {
    // 禁用存储时只保留当前组件的视图状态。
  }
}

export function writeCollapsedTaskState(
  sources: Iterable<string>,
  tasks: Iterable<string>,
): void {
  try {
    localStorage.setItem(
      TASK_COLLAPSE_KEY,
      JSON.stringify({
        sources: [...sources],
        tasks: [...tasks],
      }),
    );
  } catch {
    // Storage may be unavailable.
  }
}

export function writeTaskView(view: 'board' | 'list' | 'calendar'): void {
  try {
    localStorage.setItem(TASK_VIEW_KEY, view);
  } catch {
    // Storage may be unavailable.
  }
}

export interface TaskTreeEntry {
  task: LearningTask;
  depth: number;
  hasChildren: boolean;
  context: boolean;
}

export interface TaskSourceGroup {
  key: string;
  collapseKey: string;
  planId: string | null;
  planTitle: string;
  sourceKey: string | null;
  sourceTitle: string;
  sourceKind: string | null;
  tasks: LearningTask[];
  entries: TaskTreeEntry[];
}

export function readCollapsedTaskState() {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TASK_COLLAPSE_KEY) ?? '{}',
    ) as { sources?: unknown; tasks?: unknown };
    return {
      sources: new Set(
        Array.isArray(parsed.sources)
          ? parsed.sources.filter(
              (key): key is string => typeof key === 'string',
            )
          : [],
      ),
      tasks: new Set(
        Array.isArray(parsed.tasks)
          ? parsed.tasks.filter((key): key is string => typeof key === 'string')
          : [],
      ),
    };
  } catch {
    return { sources: new Set<string>(), tasks: new Set<string>() };
  }
}

export function readTaskView(): 'board' | 'list' | 'calendar' {
  try {
    const stored = localStorage.getItem(TASK_VIEW_KEY);
    return stored === 'list' || stored === 'calendar' ? stored : 'board';
  } catch {
    return 'board';
  }
}

export function blankTask(
  planId: string | null,
  resource?: TaskResource,
): TaskInput {
  return {
    title: resource
      ? resource.kind === 'ebook'
        ? `阅读 ${resource.title}`
        : `观看 ${resource.title}`
      : '',
    status: 'todo',
    priority: 0,
    position: Date.now(),
    optional: false,
    planId,
    resources: resource ? [resource] : [],
    prerequisiteIds: [],
  };
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function formatTimestamp(t: number | null | undefined): string {
  if (!t) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateOnly(t: number | null | undefined): string {
  if (!t) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface ArchiveGroup {
  dateKey: string;
  dateLabel: string;
  tasks: LearningTask[];
}

export function groupArchivedTasks(tasks: LearningTask[]): ArchiveGroup[] {
  const sorted = [...tasks].sort((a, b) => {
    const timeA = a.archivedAt ?? a.completedAt ?? a.position;
    const timeB = b.archivedAt ?? b.completedAt ?? b.position;
    return timeB - timeA;
  });

  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const groupsMap = new Map<string, { label: string; tasks: LearningTask[] }>();

  sorted.forEach((task) => {
    const t = task.archivedAt ?? task.completedAt ?? Date.now();
    const d = new Date(t);
    const dateKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const label = dateKey === todayKey ? `今日归档 (${dateKey})` : dateKey;

    const current = groupsMap.get(dateKey) ?? { label, tasks: [] };
    current.tasks.push(task);
    groupsMap.set(dateKey, current);
  });

  return Array.from(groupsMap.entries()).map(([dateKey, val]) => ({
    dateKey,
    dateLabel: val.label,
    tasks: val.tasks,
  }));
}

export function generateMindmapMarkdown(
  archivedTasks: LearningTask[],
  plans: Array<{ id: string; title: string }>,
): string {
  const planMap = new Map(plans.map((p) => [p.id, p.title]));
  const lines: string[] = ['# 学习任务复盘与归档', ''];
  const grouped = new Map<string, LearningTask[]>();
  archivedTasks.forEach((t) => {
    const planName = (t.planId && planMap.get(t.planId)) || '未归类任务';
    const list = grouped.get(planName) ?? [];
    list.push(t);
    grouped.set(planName, list);
  });
  grouped.forEach((tasks, planName) => {
    lines.push(`## ${planName} (${tasks.length})`);
    tasks.forEach((t) => {
      const timeStr = t.completedAt
        ? ` [完成于 ${formatDateOnly(t.completedAt)}]`
        : '';
      lines.push(`- ${t.title}${timeStr}`);
      if (t.note) {
        lines.push(`  - 备注: ${t.note.replace(/\r?\n+/g, ' ')}`);
      }
      t.resources.forEach((r) => {
        const kind = r.kind === 'ebook' ? '电子书' : 'YouTube';
        lines.push(`  - 关联${kind}: ${r.title}`);
      });
    });
    lines.push('');
  });
  return lines.join('\n');
}

function formatSeconds(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function resourceTargetProgress(
  resource: TaskResource,
  library: LibrarySnapshot | null,
  watch: Record<string, WatchState | null | 'error'>,
): number | null {
  if (!resource.targetUnit || !resource.targetValue) return null;
  if (resource.kind === 'youtube') {
    const state = watch[resource.resourceId];
    if (!state || state === 'error') return null;
    return Math.max(state.progressSeconds, resource.manualValue ?? 0);
  }
  if (!library?.rootPath || library.rootPath !== resource.rootPath) return null;
  const book = findLibraryEpubForTask(library.books, resource);
  if (!book) return null;
  const currentKey = epubProgressKey(book);
  const key =
    resource.progressKey &&
    !sameEpubProgressFile(currentKey, resource.progressKey)
      ? resource.progressKey
      : currentKey;
  const metadata = loadEpubBookMetadata(key);
  const activity = loadEpubReadingActivity(key);
  if (resource.targetUnit === 'words') {
    const furthest = Math.max(
      metadata?.progress ?? 0,
      activity?.furthestProgress ?? 0,
    );
    const estimate = Math.max(
      0,
      Math.round(
        (furthest - (resource.baseline ?? 0)) *
          (activity?.estimatedTotalWords ?? 0),
      ),
    );
    return Math.max(resource.manualValue ?? 0, estimate);
  }
  if (resource.targetUnit === 'chapters') {
    const readingPlan = loadEpubReadingPlan(key);
    const matchesPlan =
      readingPlan &&
      readingPlan.targetChapters === resource.targetValue &&
      readingPlan.startChapterIndex === resource.baseline;
    return matchesPlan
      ? getEpubReadingPlanCompleted(readingPlan)
      : Math.max(
          0,
          (metadata?.currentChapterIndex ?? 0) - (resource.baseline ?? 0),
        );
  }
  return null;
}

export function taskTargetsReached(
  task: LearningTask,
  library: LibrarySnapshot | null,
  watch: Record<string, WatchState | null | 'error'>,
) {
  return (
    task.resources.length > 0 &&
    task.resources.every((resource) => {
      if (!resource.targetUnit || !resource.targetValue) return false;
      const progress = resourceTargetProgress(resource, library, watch);
      return progress !== null && progress >= resource.targetValue;
    })
  );
}

export function resourceProgress(
  resource: TaskResource,
  library: LibrarySnapshot | null,
  watch: Record<string, WatchState | null | 'error'>,
): string {
  if (resource.kind === 'youtube') {
    const state = watch[resource.resourceId];
    if (state === undefined) return '正在读取观看进度';
    if (state === 'error') return '观看进度暂时不可用';
    if (!state) return '暂无观看记录';
    const targetProgress = resourceTargetProgress(resource, library, watch);
    if (resource.targetUnit === 'seconds' && resource.targetValue) {
      const completed = targetProgress ?? 0;
      return `目标进度 ${formatSeconds(completed)} / ${formatSeconds(resource.targetValue)}${completed >= resource.targetValue ? ' · 已达成' : ''}`;
    }
    const duration = state.durationSeconds
      ? ` / ${formatSeconds(state.durationSeconds)}`
      : '';
    return `观看 ${formatSeconds(state.progressSeconds)}${duration}${state.finished ? ' · 视频已看完' : ''}`;
  }
  if (!library?.rootPath || library.rootPath !== resource.rootPath)
    return '书库未打开或已切换';
  const book = findLibraryEpubForTask(library.books, resource);
  if (!book) return '书籍未找到，可编辑任务重新关联';
  const currentKey = epubProgressKey(book);
  if (
    resource.progressKey &&
    !sameEpubProgressFile(currentKey, resource.progressKey)
  )
    return '书籍文件已变化，请确认并重新关联';
  const key = resource.progressKey || currentKey;
  const metadata = loadEpubBookMetadata(key);
  if (resource.targetUnit === 'words' && resource.targetValue) {
    const estimate = resourceTargetProgress(resource, library, watch) ?? 0;
    const completed = Math.min(resource.targetValue, estimate);
    return `估算 / 手动 ${completed.toLocaleString()} / ${resource.targetValue.toLocaleString()} 字`;
  }
  if (resource.targetUnit === 'chapters' && resource.targetValue) {
    const readingPlan = loadEpubReadingPlan(key);
    const matchesPlan =
      readingPlan &&
      readingPlan.targetChapters === resource.targetValue &&
      readingPlan.startChapterIndex === resource.baseline;
    const chapters = resourceTargetProgress(resource, library, watch) ?? 0;
    return `${matchesPlan ? '章节进度' : '当前章节估算'} ${Math.min(chapters, resource.targetValue)} / ${resource.targetValue}`;
  }
  return metadata
    ? `阅读位置 ${Math.round(metadata.progress * 100)}%`
    : '暂无阅读记录';
}
