import type { LearningTask } from './types';

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
