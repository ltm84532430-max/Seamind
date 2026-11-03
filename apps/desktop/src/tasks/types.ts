export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled';

export interface TaskResource {
  kind: 'ebook' | 'youtube';
  resourceId: string;
  title: string;
  rootPath?: string | null;
  relativePath?: string | null;
  progressKey?: string | null;
  bookId?: string | null;
  href?: string | null;
  startSeconds?: number | null;
  targetUnit?: 'chapters' | 'words' | 'seconds' | null;
  targetValue?: number | null;
  baseline?: number | null;
  manualValue?: number | null;
}

export interface LearningPlan {
  id: string;
  title: string;
  description: string | null;
  originKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LearningTask {
  id: string;
  planId: string | null;
  parentId: string | null;
  title: string;
  note: string | null;
  status: TaskStatus;
  priority: number;
  dueDate: string | null;
  position: number;
  optional: boolean;
  resources: TaskResource[];
  prerequisiteIds: string[];
  originKey: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  archivedAt: number | null;
  sourceKey: string | null;
  sourcePresent: boolean;
}

export interface PlanSource {
  sourceKey: string;
  planId: string;
  sourceKind: string;
  title: string;
  lastSyncedAt: number;
  sortOrder: number;
  taskCount: number;
  removedCount: number;
}

export interface TaskInput {
  id?: string | null;
  planId?: string | null;
  parentId?: string | null;
  title: string;
  note?: string | null;
  status: TaskStatus;
  priority: number;
  dueDate?: string | null;
  position: number;
  optional: boolean;
  resources: TaskResource[];
  prerequisiteIds: string[];
  originKey?: string | null;
  expectedRevision?: number | null;
  completedAt?: number | null;
  archivedAt?: number | null;
}

export interface PlanInput {
  id?: string | null;
  title: string;
  description?: string | null;
  originKey?: string | null;
}

export interface TaskSnapshot {
  plans: LearningPlan[];
  tasks: LearningTask[];
  sources: PlanSource[];
}

export interface ImportPlan {
  plan: PlanInput;
  tasks: TaskInput[];
}

export interface ImportResult {
  planId: string;
  added: number;
  alreadyPresent: number;
  updated: number;
  conflicts: number;
  removed: number;
}

export function editTask(task: LearningTask): TaskInput {
  return {
    id: task.id,
    planId: task.planId,
    parentId: task.parentId,
    title: task.title,
    note: task.note,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    position: task.position,
    optional: task.optional,
    resources: task.resources,
    prerequisiteIds: task.prerequisiteIds,
    originKey: task.originKey,
    expectedRevision: task.revision,
    completedAt: task.completedAt,
    archivedAt: task.archivedAt,
  };
}
