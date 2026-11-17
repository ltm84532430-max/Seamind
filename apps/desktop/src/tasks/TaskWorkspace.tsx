import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LibrarySnapshot } from '../library/library';
import {
  epubBookIdentity,
  epubProgressKey,
  findLibraryEpubForTask,
  loadEpubBookMetadata,
  sameEpubProgressFile,
} from '../ebook/ebook-storage';
import { playerApi } from '../player/player-api';
import type { WatchState } from '../player/types';
import { parseYouTubeTarget } from '../player/video-links';
import { dateStamp, downloadTextFile } from '../player/download';
import HabitWorkspace from './HabitWorkspace';
import TaskCalendar from './TaskCalendar';
import { formatBadgeCount } from './habit-list-model';
import { useConfirmDialog } from './ConfirmDialog';
import {
  RailArchiveIcon,
  RailClockIcon,
  RailEyeIcon,
  RailFolderIcon,
  RailInboxIcon,
  RailListIcon,
  RailPlusIcon,
  SidebarCollapseButton,
  useSidebarCollapseShortcut,
  WorkspaceSidebarRail,
} from '../components/WorkspaceSidebarRail';
import { localToday } from './calendar-model';
import {
  blankTask,
  collectTaskDescendantIds,
  compareTasksBy,
  countPlanActiveTasks,
  errorText,
  extractSortedVideoIds,
  formatTimestamp,
  generateMindmapMarkdown,
  groupArchivedTasks,
  readCollapsedTaskState,
  readTaskSidebarCollapsed,
  readTaskView,
  readWorkspaceMode,
  resourceDraft,
  resourceProgress,
  taskTargetsReached,
  TASK_PRIORITY_LABELS,
  writeCollapsedTaskState,
  writeTaskSidebarCollapsed,
  writeTaskView,
  writeWorkspaceMode,
} from './task-list-model';
import type {
  ResourceTargetUnit,
  StatusUndo,
  TaskQuickFilter,
  TaskResourceDraft,
  TaskSortBy,
  TaskSourceGroup,
  TaskTreeEntry,
} from './task-list-model';
import { ebookImportCandidates, videoImportCandidate } from './legacy-import';
import type { ImportCandidate } from './legacy-import';
import {
  RESOURCE_PROGRESS_EVENT,
  TASKS_CHANGED_EVENT,
  taskApi,
} from './task-api';
import { editTask } from './types';
import type {
  LearningTask,
  TaskInput,
  TaskResource,
  TaskSnapshot,
  TaskStatus,
} from './types';
import './task-workspace.css';

export interface TaskCreateRequest {
  id: number;
  resource: TaskResource;
  title?: string;
}

interface Props {
  library: LibrarySnapshot | null;
  active?: boolean;
  pendingHabitCount?: number;
  createRequest: TaskCreateRequest | null;
  openTaskId: string | null;
  onOpenTaskHandled(): void;
  onCreateRequestHandled(id: number): void;
  onOpenResource(resource: TaskResource): Promise<boolean>;
}

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: 'todo', label: '未开始' },
  { status: 'doing', label: '进行中' },
  { status: 'done', label: '已完成' },
];
const statusName: Record<TaskStatus, string> = {
  todo: '未开始',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
};
const emptySnapshot: TaskSnapshot = { plans: [], tasks: [], sources: [] };

export default function TaskWorkspace({
  library,
  active = true,
  pendingHabitCount = 0,
  createRequest,
  openTaskId,
  onOpenTaskHandled,
  onCreateRequestHandled,
  onOpenResource,
}: Props) {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [databaseConnected, setDatabaseConnected] = useState<boolean | null>(
    null,
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [statusSavingIds, setStatusSavingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [statusUndo, setStatusUndo] = useState<StatusUndo | null>(null);
  const statusSavingIdsRef = useRef(new Set<string>());
  const previousActiveStatusRef = useRef(new Map<string, TaskStatus>());
  const [planFilter, setPlanFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'board' | 'list' | 'calendar'>(readTaskView);
  const [workspaceMode, setWorkspaceMode] = useState<'tasks' | 'habits'>(
    readWorkspaceMode,
  );
  const [habitsMounted, setHabitsMounted] = useState(
    () => readWorkspaceMode() === 'habits',
  );
  const [sortBy, setSortBy] = useState<TaskSortBy>('position');
  const [quickFilter, setQuickFilter] = useState<TaskQuickFilter>('all');
  const [todayKey, setTodayKey] = useState(localToday);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    readTaskSidebarCollapsed,
  );
  const [collapsedSourceGroups, setCollapsedSourceGroups] = useState(
    () => readCollapsedTaskState().sources,
  );
  const [collapsedTasks, setCollapsedTasks] = useState(
    () => readCollapsedTaskState().tasks,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newPlan, setNewPlan] = useState('');
  const [renamingPlanId, setRenamingPlanId] = useState<string | null>(null);
  const [renamePlanTitle, setRenamePlanTitle] = useState('');
  const [savingPlan, setSavingPlan] = useState(false);
  const { askConfirm, confirmDialog } = useConfirmDialog();
  const [draft, setDraft] = useState<TaskInput | null>(null);
  const [resourceDrafts, setResourceDrafts] = useState<TaskResourceDraft[]>([]);
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selectedCandidateKeys, setSelectedCandidateKeys] = useState<string[]>(
    [],
  );
  const [mergeTargetPlanId, setMergeTargetPlanId] = useState('new');
  const [newPlanTitle, setNewPlanTitle] = useState('');
  const [importBusy, setImportBusy] = useState('');
  const [playerConnected, setPlayerConnected] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [watch, setWatch] = useState<
    Record<string, WatchState | null | 'error'>
  >({});
  const [progressRevision, setProgressRevision] = useState(0);

  useEffect(() => {
    if (!statusUndo) return;
    const timeout = window.setTimeout(() => setStatusUndo(null), 8000);
    return () => window.clearTimeout(timeout);
  }, [statusUndo]);

  useEffect(() => {
    if (workspaceMode === 'habits') setHabitsMounted(true);
    writeWorkspaceMode(workspaceMode);
  }, [workspaceMode]);

  useEffect(() => {
    let midnightTimer = 0;
    const syncDate = () => setTodayKey(localToday());
    const scheduleMidnight = () => {
      const now = new Date();
      const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      );
      midnightTimer = window.setTimeout(
        () => {
          syncDate();
          scheduleMidnight();
        },
        Math.max(1_000, next.getTime() - now.getTime() + 50),
      );
    };
    scheduleMidnight();
    // 休眠恢复和系统日期调整后，今日筛选也要立即更新。
    const clockCheck = window.setInterval(syncDate, 30_000);
    window.addEventListener('focus', syncDate);
    document.addEventListener('visibilitychange', syncDate);
    return () => {
      window.clearTimeout(midnightTimer);
      window.clearInterval(clockCheck);
      window.removeEventListener('focus', syncDate);
      document.removeEventListener('visibilitychange', syncDate);
    };
  }, []);

  useEffect(() => {
    writeCollapsedTaskState(collapsedSourceGroups, collapsedTasks);
  }, [collapsedSourceGroups, collapsedTasks]);

  const reload = useCallback(async () => {
    try {
      const next = await taskApi.snapshot();
      setSnapshot(next);
      setDatabaseConnected(true);
      setError('');
    } catch (reason) {
      setDatabaseConnected(false);
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshConnections = useCallback(async () => {
    await reload();
    try {
      await playerApi.overview();
      setPlayerConnected(true);
    } catch {
      setPlayerConnected(false);
    }
  }, [reload]);

  useEffect(() => {
    void refreshConnections();
    const refresh = () => void reload();
    const refreshProgress = () => setProgressRevision((value) => value + 1);
    window.addEventListener(TASKS_CHANGED_EVENT, refresh);
    window.addEventListener(RESOURCE_PROGRESS_EVENT, refreshProgress);
    window.addEventListener('focus', refreshProgress);
    return () => {
      window.removeEventListener(TASKS_CHANGED_EVENT, refresh);
      window.removeEventListener(RESOURCE_PROGRESS_EVENT, refreshProgress);
      window.removeEventListener('focus', refreshProgress);
    };
  }, [reload, refreshConnections]);

  const videoIdsKey = useMemo(
    () => extractSortedVideoIds(snapshot.tasks),
    [snapshot.tasks],
  );

  useEffect(() => {
    let current = true;
    const ids = videoIdsKey ? videoIdsKey.split(',') : [];
    if (ids.length === 0) {
      setWatch({});
      return;
    }
    void (async () => {
      const values: Record<string, WatchState | null | 'error'> = {};
      for (let offset = 0; offset < ids.length; offset += 20) {
        const batch = ids.slice(offset, offset + 20);
        const result = await Promise.all(
          batch.map((id) =>
            playerApi.watchState(id).catch(() => 'error' as const),
          ),
        );
        batch.forEach((id, index) => {
          values[id] = result[index];
        });
      }
      if (current) setWatch(values);
    })();
    return () => {
      current = false;
    };
  }, [videoIdsKey, progressRevision]);

  const openDraft = useCallback((input: TaskInput) => {
    setDraft(input);
    setResourceDrafts(
      input.resources.map((resource) => resourceDraft(resource)),
    );
    setDraftError('');
  }, []);

  const updateResourceDraft = (
    key: string,
    update: Partial<TaskResourceDraft>,
  ) => {
    setResourceDrafts((current) =>
      current.map((resource) =>
        resource.key === key ? { ...resource, ...update } : resource,
      ),
    );
  };

  const addResourceDraft = (kind: TaskResource['kind']) => {
    if (resourceDrafts.length >= 20) {
      setDraftError('一个任务最多关联 20 个资源。');
      return;
    }
    setResourceDrafts((current) => [
      ...current,
      resourceDraft(undefined, kind),
    ]);
  };

  const removeResourceDraft = (key: string) => {
    setResourceDrafts((current) =>
      current.filter((resource) => resource.key !== key),
    );
  };

  useEffect(() => {
    if (!createRequest) return;
    const input = blankTask(null, createRequest.resource);
    if (createRequest.title) input.title = createRequest.title;
    openDraft(input);
    onCreateRequestHandled(createRequest.id);
  }, [createRequest, onCreateRequestHandled, openDraft]);

  useEffect(() => {
    if (!openTaskId) return;
    setPlanFilter('all');
    setQuery('');
    setSelectedId(openTaskId);
    onOpenTaskHandled();
  }, [openTaskId, onOpenTaskHandled]);

  const byId = useMemo(
    () =>
      new Map<string, LearningTask>(
        snapshot.tasks.map((entry) => [entry.id, entry]),
      ),
    [snapshot.tasks],
  );
  const term = query.trim().toLocaleLowerCase();
  const baseFiltered = useMemo(
    () =>
      snapshot.tasks.filter((entry) => {
        if (planFilter === 'archived') {
          if (!entry.archivedAt) return false;
        } else {
          if (entry.archivedAt) return false;
          const inPlan =
            planFilter === 'all' ||
            (planFilter === 'today'
              ? Boolean(
                  entry.dueDate &&
                  entry.dueDate <= todayKey &&
                  entry.status !== 'done' &&
                  entry.status !== 'cancelled',
                )
              : planFilter === 'unplanned'
                ? !entry.planId
                : entry.planId === planFilter);
          if (!inPlan) return false;
        }
        return true;
      }),
    [snapshot.tasks, planFilter, todayKey],
  );
  const matchingTasks = useMemo(() => {
    if (!term) return baseFiltered;
    const sourcesByKey = new Map(
      snapshot.sources.map((source) => [source.sourceKey, source]),
    );
    const plansById = new Map(snapshot.plans.map((plan) => [plan.id, plan]));
    return baseFiltered.filter((entry) => {
      const source = entry.sourceKey
        ? sourcesByKey.get(entry.sourceKey)
        : undefined;
      const plan = entry.planId ? plansById.get(entry.planId) : undefined;
      return [
        entry.title,
        entry.note,
        plan?.title,
        source?.title,
        ...entry.resources.map((resource) => resource.title),
      ].some((value) => value?.toLocaleLowerCase().includes(term));
    });
  }, [baseFiltered, snapshot.plans, snapshot.sources, term]);
  const isBlocked = useCallback(
    (entry: LearningTask) =>
      entry.prerequisiteIds.some((id) => byId.get(id)?.status !== 'done'),
    [byId],
  );
  const cancelledCount = useMemo(
    () => matchingTasks.filter((entry) => entry.status === 'cancelled').length,
    [matchingTasks],
  );
  const quickMatchingTasks = useMemo(() => {
    if (planFilter === 'archived' || quickFilter === 'all')
      return matchingTasks;
    if (quickFilter === 'high') {
      return matchingTasks.filter((entry) => entry.priority >= 2);
    }
    if (quickFilter === 'unblocked') {
      return matchingTasks.filter(
        (entry) =>
          entry.status !== 'done' &&
          entry.status !== 'cancelled' &&
          !isBlocked(entry),
      );
    }
    return matchingTasks.filter((entry) => entry.status === 'cancelled');
  }, [isBlocked, matchingTasks, planFilter, quickFilter]);
  const contextTaskIds = useMemo(() => {
    const ids = new Set<string>();
    if (!term) return ids;
    quickMatchingTasks.forEach((entry) => {
      let parentId = entry.parentId;
      const visited = new Set<string>([entry.id]);
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent || parent.planId !== entry.planId) break;
        if (
          (planFilter === 'archived' && !parent.archivedAt) ||
          (planFilter !== 'archived' && parent.archivedAt)
        )
          break;
        ids.add(parent.id);
        parentId = parent.parentId;
      }
    });
    return ids;
  }, [byId, planFilter, quickMatchingTasks, term]);
  const filtered = useMemo(() => {
    if (!term && (quickFilter === 'all' || planFilter === 'archived')) {
      return baseFiltered;
    }
    const displayed = new Map<string, LearningTask>();
    quickMatchingTasks.forEach((entry) => displayed.set(entry.id, entry));
    contextTaskIds.forEach((id) => {
      const parent = byId.get(id);
      if (parent) displayed.set(id, parent);
    });
    return Array.from(displayed.values());
  }, [
    baseFiltered,
    byId,
    contextTaskIds,
    planFilter,
    quickFilter,
    quickMatchingTasks,
    term,
  ]);
  const selected =
    snapshot.tasks.find((entry) => entry.id === selectedId) ?? null;
  const taskGroups = useMemo(() => {
    const sourcesByKey = new Map(
      snapshot.sources.map((source) => [source.sourceKey, source]),
    );
    const plansById = new Map(snapshot.plans.map((plan) => [plan.id, plan]));
    const planOrder = new Map(
      snapshot.plans.map((plan, index) => [plan.id, index]),
    );
    const groups = new Map<string, TaskSourceGroup>();
    const effectiveSourceKey = (entry: LearningTask) => {
      let current: LearningTask | undefined = entry;
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        if (current.sourceKey) return current.sourceKey;
        const parent: LearningTask | undefined = current.parentId
          ? byId.get(current.parentId)
          : undefined;
        current = parent?.planId === entry.planId ? parent : undefined;
      }
      return null;
    };

    filtered.forEach((entry) => {
      const sourceKey = effectiveSourceKey(entry);
      const groupKey = JSON.stringify([entry.planId, sourceKey]);
      let group = groups.get(groupKey);
      if (!group) {
        const source = sourceKey ? sourcesByKey.get(sourceKey) : undefined;
        const planTitle = entry.planId
          ? (plansById.get(entry.planId)?.title ?? '未知计划')
          : '未归类任务';
        group = {
          key: groupKey,
          collapseKey: sourceKey
            ? 'source:' + sourceKey
            : 'manual:' + (entry.planId ?? 'unplanned'),
          planId: entry.planId,
          planTitle,
          sourceKey,
          sourceTitle: source?.title ?? (sourceKey ? '来源任务' : '手动任务'),
          sourceKind: source?.sourceKind ?? null,
          tasks: [],
          entries: [],
        };
        groups.set(groupKey, group);
      }
      group.tasks.push(entry);
    });

    const orderedGroups = Array.from(groups.values()).sort((a, b) => {
      const planA = a.planId
        ? (planOrder.get(a.planId) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
      const planB = b.planId
        ? (planOrder.get(b.planId) ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
      if (planA !== planB) return planA - planB;
      if (a.planId !== b.planId)
        return (a.planId ?? '').localeCompare(b.planId ?? '');
      const sourceA = a.sourceKey
        ? (sourcesByKey.get(a.sourceKey)?.sortOrder ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
      const sourceB = b.sourceKey
        ? (sourcesByKey.get(b.sourceKey)?.sortOrder ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER;
      if (sourceA !== sourceB) return sourceA - sourceB;
      return a.sourceTitle.localeCompare(b.sourceTitle);
    });

    orderedGroups.forEach((group) => {
      const groupTaskIds = new Set(group.tasks.map((entry) => entry.id));
      const children = new Map<string, LearningTask[]>();
      group.tasks.forEach((entry) => {
        if (entry.parentId && groupTaskIds.has(entry.parentId)) {
          const siblings = children.get(entry.parentId) ?? [];
          siblings.push(entry);
          children.set(entry.parentId, siblings);
        }
      });
      const compareTasks = (a: LearningTask, b: LearningTask) =>
        compareTasksBy(a, b, sortBy);
      const visited = new Set<string>();
      const isSourceCollapsed =
        !term && collapsedSourceGroups.has(group.collapseKey);
      const flatten = (entry: LearningTask, depth: number) => {
        if (visited.has(entry.id)) return;
        visited.add(entry.id);
        const descendants = (children.get(entry.id) ?? []).sort(compareTasks);
        group.entries.push({
          task: entry,
          depth,
          hasChildren: descendants.length > 0,
          context: contextTaskIds.has(entry.id),
        });
        if (!term && collapsedTasks.has(entry.id)) return;
        descendants.forEach((child) => flatten(child, depth + 1));
      };
      if (!isSourceCollapsed) {
        group.tasks
          .filter(
            (entry) => !entry.parentId || !groupTaskIds.has(entry.parentId),
          )
          .sort(compareTasks)
          .forEach((entry) => flatten(entry, 0));
        group.tasks
          .filter((entry) => !visited.has(entry.id))
          .sort(compareTasks)
          .forEach((entry) => flatten(entry, 0));
      }
    });
    return orderedGroups;
  }, [
    byId,
    collapsedSourceGroups,
    collapsedTasks,
    contextTaskIds,
    filtered,
    snapshot.plans,
    snapshot.sources,
    sortBy,
    term,
  ]);
  const allResources = snapshot.tasks.flatMap((entry) => entry.resources);
  const ebookResources = allResources.filter(
    (resource) => resource.kind === 'ebook',
  );
  const linkedEbook = (resource: TaskResource) =>
    library ? findLibraryEpubForTask(library.books, resource) : undefined;
  const unlinkedEbookCount = ebookResources.filter(
    (resource) => !linkedEbook(resource),
  ).length;
  const ebookRebindCount = ebookResources.filter((resource) => {
    const book = linkedEbook(resource);
    return Boolean(
      book &&
      (resource.rootPath !== library?.rootPath ||
        (resource.progressKey &&
          !sameEpubProgressFile(epubProgressKey(book), resource.progressKey))),
    );
  }).length;
  const videoResources = allResources.filter(
    (resource) => resource.kind === 'youtube',
  );
  const videoErrorCount = videoResources.filter(
    (resource) => watch[resource.resourceId] === 'error',
  ).length;
  const videoPendingCount = videoResources.filter(
    (resource) => watch[resource.resourceId] === undefined,
  ).length;
  const removedSourceTaskCount = snapshot.sources.reduce(
    (count, source) => count + source.removedCount,
    0,
  );
  const ebookLinkNeedsRepair = (resource: TaskResource) => {
    if (resource.kind !== 'ebook') return false;
    const book = library
      ? findLibraryEpubForTask(library.books, resource)
      : undefined;
    return Boolean(
      !book ||
      resource.rootPath !== library?.rootPath ||
      (resource.progressKey &&
        !sameEpubProgressFile(epubProgressKey(book), resource.progressKey)),
    );
  };
  const retryVideoProgress = async (resourceId: string) => {
    setWatch((current) => {
      const next = { ...current };
      delete next[resourceId];
      return next;
    });
    try {
      const state = await playerApi.watchState(resourceId);
      setWatch((current) => ({ ...current, [resourceId]: state }));
      setPlayerConnected(true);
    } catch {
      setWatch((current) => ({ ...current, [resourceId]: 'error' }));
      setPlayerConnected(false);
    }
  };

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeTaskSidebarCollapsed(next);
      return next;
    });
  }, []);

  const addPlanInputRef = useRef<HTMLInputElement>(null);
  useSidebarCollapseShortcut(
    toggleSidebarCollapsed,
    active && workspaceMode === 'tasks',
  );

  const changeView = (next: typeof view) => {
    setView(next);
    writeTaskView(next);
  };

  const createTaskForDate = (date: string) => {
    const planId = !['all', 'today', 'unplanned'].includes(planFilter)
      ? planFilter
      : null;
    openDraft({ ...blankTask(planId), dueDate: date });
  };

  const moveTaskDate = async (entry: LearningTask, date: string | null) => {
    try {
      await taskApi.saveTask({ ...editTask(entry), dueDate: date });
      setNotice(date ? `截止日期已改为 ${date}` : '已移除截止日期');
      return true;
    } catch (reason) {
      await reload();
      setError(errorText(reason));
      return false;
    }
  };

  const changeStatus = async (
    entry: LearningTask,
    status: TaskStatus,
    recordUndo = true,
  ): Promise<boolean> => {
    const current =
      snapshot.tasks.find((task) => task.id === entry.id) ?? entry;
    if (current.status === status) return true;
    if (statusSavingIdsRef.current.has(entry.id)) return false;

    statusSavingIdsRef.current.add(entry.id);
    setStatusSavingIds(new Set(statusSavingIdsRef.current));
    setError('');
    setStatusUndo(null);
    const previousStatus = current.status;
    const previousRestoreStatus = previousActiveStatusRef.current.get(entry.id);
    if (status === 'done') {
      previousActiveStatusRef.current.set(entry.id, previousStatus);
    } else {
      previousActiveStatusRef.current.delete(entry.id);
    }
    setSnapshot((currentSnapshot) => ({
      ...currentSnapshot,
      tasks: currentSnapshot.tasks.map((task) =>
        task.id === entry.id ? { ...task, status } : task,
      ),
    }));

    try {
      const saved = await taskApi.saveTask({ ...editTask(current), status });
      setSnapshot((currentSnapshot) => ({
        ...currentSnapshot,
        tasks: currentSnapshot.tasks.map((task) =>
          task.id === saved.id ? saved : task,
        ),
      }));
      if (recordUndo) {
        setStatusUndo({
          taskId: current.id,
          previousStatus,
          nextStatus: status,
          title: current.title,
        });
      }
      setNotice(
        status === 'done'
          ? `已完成「${current.title}」`
          : `「${current.title}」已更新为${statusName[status]}`,
      );
      return true;
    } catch (reason) {
      if (previousRestoreStatus) {
        previousActiveStatusRef.current.set(entry.id, previousRestoreStatus);
      } else {
        previousActiveStatusRef.current.delete(entry.id);
      }
      setSnapshot((currentSnapshot) => ({
        ...currentSnapshot,
        tasks: currentSnapshot.tasks.map((task) =>
          task.id === entry.id ? { ...task, status: previousStatus } : task,
        ),
      }));
      setError(errorText(reason));
      void reload();
      return false;
    } finally {
      statusSavingIdsRef.current.delete(entry.id);
      setStatusSavingIds(new Set(statusSavingIdsRef.current));
    }
  };

  const toggleTaskCompletion = (entry: LearningTask) => {
    const current =
      snapshot.tasks.find((task) => task.id === entry.id) ?? entry;
    if (current.status === 'done') {
      void changeStatus(
        current,
        previousActiveStatusRef.current.get(current.id) ?? 'todo',
      );
      return;
    }
    void changeStatus(
      current,
      current.status === 'cancelled' ? 'todo' : 'done',
    );
  };

  const undoStatusChange = async () => {
    if (!statusUndo) return;
    const undo = statusUndo;
    const task = snapshot.tasks.find((entry) => entry.id === undo.taskId);
    setStatusUndo(null);
    if (!task || task.status !== undo.nextStatus) return;
    const undone = await changeStatus(task, undo.previousStatus, false);
    if (undone) setNotice(`已撤销「${undo.title}」的状态更改`);
  };

  const openResource = async (entry: LearningTask, resource: TaskResource) => {
    try {
      let linkedResource = resource;
      if (resource.kind === 'ebook') {
        if (!library?.rootPath) {
          throw new Error('先打开电子书库，再重试此关联。');
        }
        const book = findLibraryEpubForTask(library.books, resource);
        if (!book) {
          throw new Error('找不到这本书。请编辑任务并从当前书库重新关联。');
        }
        const nextProgressKey = epubProgressKey(book);
        const rootChanged = resource.rootPath !== library.rootPath;
        const storedProgressKey = resource.progressKey;
        const fileChanged = Boolean(
          storedProgressKey &&
          !sameEpubProgressFile(storedProgressKey, nextProgressKey),
        );
        if (rootChanged || fileChanged) {
          const message = rootChanged
            ? '这本书已在另一个书库中找到。重新关联后会使用当前书库路径，是否继续？'
            : '书籍文件已更新。重新关联后会从当前文件版本读取进度，是否继续？';
          const confirmed = await askConfirm({
            title: '重新关联书籍',
            message,
            confirmLabel: '继续打开',
          });
          if (!confirmed) return;
        }
        const identityChanged =
          resource.bookId !== epubBookIdentity(book.relativePath);
        if (rootChanged || fileChanged || identityChanged) {
          const metadata = loadEpubBookMetadata(nextProgressKey);
          const rebound: TaskResource = {
            ...resource,
            title: book.title,
            rootPath: library.rootPath,
            relativePath: book.relativePath,
            progressKey: nextProgressKey,
            bookId: epubBookIdentity(book.relativePath),
            baseline: fileChanged
              ? resource.targetUnit === 'chapters'
                ? (metadata?.currentChapterIndex ?? 0)
                : (metadata?.progress ?? 0)
              : resource.baseline,
          };
          const resources = entry.resources.map((item) =>
            item === resource ? rebound : item,
          );
          await taskApi.saveTask({ ...editTask(entry), resources });
          linkedResource = rebound;
          await reload();
        }
      }
      await onOpenResource(linkedResource);
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  const addPlan = async (event: FormEvent) => {
    event.preventDefault();
    if (!newPlan.trim() || savingPlan) return;
    setSavingPlan(true);
    try {
      const next = await taskApi.savePlan({ title: newPlan.trim() });
      setSnapshot(next);
      setNewPlan('');
      setNotice('计划已创建');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSavingPlan(false);
    }
  };

  const savePlanRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renamingPlanId || savingPlan) return;
    const plan = snapshot.plans.find((item) => item.id === renamingPlanId);
    const trimmed = renamePlanTitle.trim();
    if (!plan || !trimmed) return;
    setSavingPlan(true);
    try {
      const next = await taskApi.savePlan({
        id: plan.id,
        title: trimmed,
        description: plan.description,
        originKey: plan.originKey,
      });
      setSnapshot(next);
      setRenamingPlanId(null);
      setRenamePlanTitle('');
      setNotice(`计划已重命名为「${trimmed}」`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSavingPlan(false);
    }
  };

  const deletePlan = async (plan: { id: string; title: string }) => {
    const confirmed = await askConfirm({
      title: '删除计划',
      message: `删除计划「${plan.title}」？其中的任务不会删除，将转为“未归类”。`,
      confirmLabel: '删除计划',
      danger: true,
    });
    if (!confirmed) return;
    setSavingPlan(true);
    try {
      const next = await taskApi.deletePlan(plan.id);
      setSnapshot(next);
      if (planFilter === plan.id) setPlanFilter('all');
      if (renamingPlanId === plan.id) setRenamingPlanId(null);
      setNotice(`已删除计划「${plan.title}」`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSavingPlan(false);
    }
  };

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || saving) return;
    setDraftError('');
    const resources: TaskResource[] = [];
    const resourceKeys = new Set<string>();
    for (const item of resourceDrafts) {
      const old = item.original;
      const numericTarget = item.targetValue.trim()
        ? Number(item.targetValue)
        : null;
      const numericManual = item.manualValue.trim()
        ? Number(item.manualValue)
        : null;
      if (
        (numericTarget !== null &&
          (!Number.isFinite(numericTarget) || numericTarget <= 0)) ||
        (numericManual !== null &&
          (!Number.isFinite(numericManual) || numericManual < 0))
      ) {
        setDraftError('目标与手动进度必须是有效的非负数字，目标必须大于零。');
        return;
      }
      if (item.kind === 'ebook') {
        const book = library?.books.find(
          (candidate) => candidate.relativePath === item.bookPath,
        );
        if (book && library?.rootPath) {
          const bookId = epubBookIdentity(book.relativePath);
          const progressKey = epubProgressKey(book);
          const sameBook =
            old?.kind === 'ebook' &&
            (old.bookId ||
              (old.relativePath ? epubBookIdentity(old.relativePath) : '')) ===
              bookId;
          const sameRevision = sameBook && old?.progressKey === progressKey;
          const metadata = loadEpubBookMetadata(progressKey);
          resources.push({
            kind: 'ebook',
            resourceId: sameBook ? old.resourceId : 'ebook:' + bookId,
            title: book.title,
            rootPath: library.rootPath,
            relativePath: book.relativePath,
            progressKey,
            bookId,
            href: item.chapterHref.trim() || null,
            targetUnit:
              item.targetUnit === 'chapters' || item.targetUnit === 'words'
                ? item.targetUnit
                : null,
            targetValue: numericTarget,
            baseline:
              sameRevision && old?.targetUnit === item.targetUnit
                ? old.baseline
                : item.targetUnit === 'chapters'
                  ? (metadata?.currentChapterIndex ?? 0)
                  : (metadata?.progress ?? 0),
            manualValue: numericManual,
          });
        } else if (
          old?.kind === 'ebook' &&
          old.relativePath === item.bookPath
        ) {
          resources.push({
            ...old,
            href: item.chapterHref.trim() || null,
            targetUnit:
              item.targetUnit === 'chapters' || item.targetUnit === 'words'
                ? item.targetUnit
                : null,
            targetValue: numericTarget,
            manualValue: numericManual,
          });
        } else {
          setDraftError('请选择当前书库中的书籍，或移除这条失效关联。');
          return;
        }
      } else {
        const parsed = parseYouTubeTarget(item.videoInput);
        if (!parsed || parsed.kind !== 'video') {
          setDraftError('请输入有效的 YouTube 视频链接或视频 ID。');
          return;
        }
        const start = Number(item.startSeconds);
        if (!Number.isFinite(start) || start < 0) {
          setDraftError('视频起始秒数必须是非负数字。');
          return;
        }
        resources.push({
          kind: 'youtube',
          resourceId: parsed.videoId,
          title:
            old?.kind === 'youtube' && old.resourceId === parsed.videoId
              ? old.title
              : draft.title.trim(),
          startSeconds: Math.floor(start),
          targetUnit: item.targetUnit === 'seconds' ? 'seconds' : null,
          targetValue: numericTarget,
          manualValue: numericManual,
        });
      }
    }
    if (resources.length > 20) {
      setDraftError('一个任务最多关联 20 个资源。');
      return;
    }
    for (const resource of resources) {
      const key =
        resource.kind === 'ebook'
          ? 'ebook:' + (resource.bookId || resource.relativePath || '')
          : 'youtube:' + resource.resourceId;
      if (resourceKeys.has(key)) {
        setDraftError('同一任务不能重复关联相同的书籍或视频。');
        return;
      }
      resourceKeys.add(key);
    }
    setSaving(true);
    try {
      const saved = await taskApi.saveTask({
        ...draft,
        title: draft.title.trim(),
        resources,
      });
      setSelectedId(saved.id);
      setDraft(null);
      setResourceDrafts([]);
      setNotice('任务已保存');
    } catch (reason) {
      setDraftError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };
  const reviewExistingPlans = async () => {
    setImportBusy('loading');
    setError('');
    const items = ebookImportCandidates(
      library?.rootPath ?? '',
      library?.books ?? [],
    );
    try {
      const overview = await playerApi.overview();
      const details = await Promise.all(
        overview.learningPaths.map((summary) =>
          playerApi.learningPathGet(summary.pathId).catch(() => null),
        ),
      );
      details.forEach((detail) => {
        if (detail) items.push(videoImportCandidate(detail));
      });
      setPlayerConnected(true);
    } catch (reason) {
      setPlayerConnected(false);
      setError('读取视频学习路径失败：' + errorText(reason));
    }
    const linkedPlanIds = items.map(
      (candidate) =>
        snapshot.sources.find((source) => source.sourceKey === candidate.key)
          ?.planId ??
        snapshot.plans.find((plan) => plan.originKey === candidate.key)?.id ??
        null,
    );
    const firstLinkedPlan = linkedPlanIds[0];
    const allAlreadyInOnePlan =
      typeof firstLinkedPlan === 'string' &&
      linkedPlanIds.every((planId) => planId === firstLinkedPlan);
    if (allAlreadyInOnePlan) {
      const originalOrder = new Map(
        items.map((candidate, index) => [candidate.key, index]),
      );
      const sourceOrder = new Map(
        snapshot.sources.map((source) => [source.sourceKey, source.sortOrder]),
      );
      items.sort(
        (a, b) =>
          (sourceOrder.get(a.key) ?? originalOrder.get(a.key) ?? 0) -
          (sourceOrder.get(b.key) ?? originalOrder.get(b.key) ?? 0),
      );
    }
    setCandidates(items);
    setSelectedCandidateKeys(items.map((candidate) => candidate.key));
    setMergeTargetPlanId(allAlreadyInOnePlan ? firstLinkedPlan : 'new');
    setNewPlanTitle(
      items.length > 1 ? '综合学习计划' : (items[0]?.label ?? '综合学习计划'),
    );
    setImportBusy('');
  };

  const moveCandidate = (candidateKey: string, direction: -1 | 1) => {
    setCandidates((current) => {
      if (!current) return current;
      const index = current.findIndex(
        (candidate) => candidate.key === candidateKey,
      );
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const syncSelectedCandidates = async () => {
    if (!candidates || importBusy) return;
    const selectedCandidates = candidates.filter((candidate) =>
      selectedCandidateKeys.includes(candidate.key),
    );
    if (!selectedCandidates.length) return;
    setImportBusy('sync');
    setError('');
    let targetPlanId = mergeTargetPlanId === 'new' ? null : mergeTargetPlanId;
    const createNew = mergeTargetPlanId === 'new';
    const totals = { added: 0, updated: 0, conflicts: 0, removed: 0 };
    try {
      for (const candidate of selectedCandidates) {
        const result = await taskApi.syncPlan(
          candidate.draft,
          targetPlanId,
          createNew && !targetPlanId
            ? newPlanTitle.trim() || candidate.label
            : null,
          createNew && !targetPlanId,
          candidates.findIndex((item) => item.key === candidate.key),
        );
        targetPlanId = result.planId;
        totals.added += result.added;
        totals.updated += result.updated;
        totals.conflicts += result.conflicts;
        totals.removed += result.removed;
      }
      await reload();
      setCandidates(null);
      setSelectedCandidateKeys([]);
      setNotice(
        '已同步 ' +
          selectedCandidates.length +
          ' 个来源：新增 ' +
          totals.added +
          '，更新 ' +
          totals.updated +
          '，保留用户改动 ' +
          totals.conflicts +
          ' 处，来源移除节点 ' +
          totals.removed +
          ' 项（未删除）。',
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setImportBusy('');
    }
  };
  const archiveDoneTasks = async () => {
    try {
      const targetPlan =
        planFilter !== 'all' &&
        planFilter !== 'today' &&
        planFilter !== 'unplanned' &&
        planFilter !== 'archived'
          ? planFilter
          : null;
      const count = await taskApi.archiveDone(targetPlan);
      if (count > 0) {
        setNotice(`已归档 ${count} 项已完成任务`);
      } else {
        setNotice('没有可归档的已完成任务');
      }
      await reload();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const unarchiveTask = async (entry: LearningTask) => {
    try {
      await taskApi.unarchiveTask(entry.id);
      setNotice(`已恢复任务「${entry.title}」至进行中看板`);
      await reload();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const archiveSingleTask = async (entry: LearningTask) => {
    try {
      await taskApi.archiveTask(entry.id);
      setNotice(`已归档「${entry.title}」`);
      await reload();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const exportArchiveMindmap = () => {
    if (filtered.length === 0) return;
    const md = generateMindmapMarkdown(filtered, snapshot.plans);
    const fileName = `复盘归档_${dateStamp()}.md`;
    downloadTextFile(fileName, md, 'text/markdown;charset=utf-8');
    setNotice(`已导出复盘导图「${fileName}」，可在导图工作台中打开`);
  };

  const deleteTask = async (entry: LearningTask) => {
    const confirmed = await askConfirm({
      title: '删除任务',
      message: `删除任务「${entry.title}」？关联的书籍和视频会保留。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await taskApi.deleteTask(entry.id);
      setSelectedId(null);
      setNotice('任务已删除');
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const toggleSourceGroup = (key: string) => {
    setCollapsedSourceGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleTask = (id: string) => {
    setCollapsedTasks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderSourceHeader = (group: TaskSourceGroup) => {
    const expanded =
      Boolean(term) || !collapsedSourceGroups.has(group.collapseKey);
    const kindLabel = group.sourceKind?.startsWith('ebook')
      ? '电子书'
      : group.sourceKind === 'youtube' || group.sourceKind?.startsWith('video')
        ? 'YouTube'
        : group.sourceKind
          ? '来源计划'
          : '手动任务';
    return (
      <header className="task-source-group-head">
        <button
          type="button"
          className="task-source-group-toggle"
          aria-expanded={expanded}
          disabled={Boolean(term)}
          onClick={() => toggleSourceGroup(group.collapseKey)}
        >
          <span className="task-disclosure-mark" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="task-source-group-labels">
            <strong>{group.sourceTitle}</strong>
            <small>
              {group.planTitle} · {kindLabel} · {group.tasks.length} 项
            </small>
          </span>
          <span className="task-source-group-count">{group.tasks.length}</span>
        </button>
      </header>
    );
  };

  const renderCard = ({
    task: entry,
    depth,
    hasChildren,
    context,
    detachedParentTitle,
  }: TaskTreeEntry & { detachedParentTitle?: string }) => (
    <article
      key={entry.id}
      className={
        'task-card' +
        (selectedId === entry.id ? ' is-selected' : '') +
        (context ? ' is-search-context' : '') +
        (entry.status === 'cancelled' ? ' is-cancelled' : '')
      }
      style={{ marginInlineStart: depth * 14 }}
      draggable
      onDragStart={() => setDragging(entry.id)}
      onDragEnd={() => setDragging(null)}
      onClick={() => setSelectedId(entry.id)}
    >
      <div className="task-card-heading">
        {hasChildren ? (
          <button
            type="button"
            className="task-disclosure-toggle"
            disabled={Boolean(term)}
            aria-label={
              (collapsedTasks.has(entry.id) && !term ? '展开' : '收起') +
              '任务 ' +
              entry.title
            }
            aria-expanded={Boolean(term) || !collapsedTasks.has(entry.id)}
            onClick={(event) => {
              event.stopPropagation();
              toggleTask(entry.id);
            }}
          >
            {Boolean(term) || !collapsedTasks.has(entry.id) ? '▾' : '▸'}
          </button>
        ) : (
          <span className="task-disclosure-placeholder" aria-hidden="true" />
        )}
        <button
          type="button"
          className={`task-completion-toggle is-${entry.status}`}
          disabled={statusSavingIds.has(entry.id)}
          aria-label={
            entry.status === 'done'
              ? `重新打开任务 ${entry.title}`
              : entry.status === 'cancelled'
                ? `恢复任务 ${entry.title}`
                : `标记任务完成 ${entry.title}`
          }
          aria-pressed={entry.status === 'done'}
          title={entry.status === 'done' ? '重新打开任务' : '标记为已完成'}
          onClick={(event) => {
            event.stopPropagation();
            toggleTaskCompletion(entry);
          }}
        >
          {entry.status === 'done'
            ? '✓'
            : entry.status === 'cancelled'
              ? '↻'
              : '○'}
        </button>
        <div className="task-card-title">{entry.title}</div>
        {entry.status === 'done' && !entry.archivedAt && (
          <button
            type="button"
            className="task-card-archive-btn"
            disabled={statusSavingIds.has(entry.id)}
            title="归档此已完成任务"
            onClick={(event) => {
              event.stopPropagation();
              void archiveSingleTask(entry);
            }}
          >
            归档
          </button>
        )}
      </div>
      <div className="task-card-meta">
        {entry.priority > 0 && (
          <span className={`task-priority-badge is-p${entry.priority}`}>
            {TASK_PRIORITY_LABELS[entry.priority] ?? `P${entry.priority}`}
          </span>
        )}
        {detachedParentTitle && (
          <span
            className="task-detached-parent"
            title={`所属父任务: ${detachedParentTitle}`}
          >
            ↳ {detachedParentTitle}
          </span>
        )}
        {entry.resources.map((resource) => (
          <span key={`${resource.kind}:${resource.resourceId}`}>
            {resource.kind === 'ebook' ? '电子书' : 'YouTube'}
          </span>
        ))}
        {entry.dueDate && <span>截止 {entry.dueDate}</span>}
        {entry.optional && <span>可选</span>}
        {entry.sourceKey && !entry.sourcePresent && (
          <span className="task-source-removed-badge">来源已移除</span>
        )}
        {isBlocked(entry) && entry.status !== 'done' && (
          <span className="task-blocked">前置未完成</span>
        )}
      </div>
      {entry.resources.length > 0 && (
        <div className="task-card-progress">
          {entry.resources.map((resource) => (
            <span key={`${resource.kind}:${resource.resourceId}`}>
              {resource.title} · {resourceProgress(resource, library, watch)}
            </span>
          ))}
        </div>
      )}
    </article>
  );

  const allTaskCount = snapshot.tasks.filter((item) => !item.archivedAt).length;
  const todayDueTaskCount = snapshot.tasks.filter(
    (item) =>
      !item.archivedAt &&
      item.dueDate &&
      item.dueDate <= todayKey &&
      item.status !== 'done' &&
      item.status !== 'cancelled',
  ).length;
  const unplannedTaskCount = snapshot.tasks.filter(
    (item) => !item.archivedAt && !item.planId,
  ).length;
  const archivedTaskCount = snapshot.tasks.filter((item) =>
    Boolean(item.archivedAt),
  ).length;

  return (
    <div className="task-workspace-root">
      <div className="task-workspace" hidden={workspaceMode === 'habits'}>
        {sidebarCollapsed ? (
          <aside
            className="task-sidebar is-collapsed"
            id="task-sidebar"
            aria-label="学习计划导航"
          >
            <WorkspaceSidebarRail
              ariaLabel="已收起的学习计划导航"
              expandTitle="展开任务侧栏 (快捷键 Ctrl+B)"
              expandAriaLabel="展开任务侧栏"
              ariaControls="task-sidebar"
              headerHeight={48}
              onExpand={toggleSidebarCollapsed}
              sections={[
                {
                  key: 'filters',
                  items: [
                    {
                      key: 'all',
                      label: `全部任务 (${allTaskCount})`,
                      active: planFilter === 'all',
                      icon: <RailListIcon />,
                      onClick: () => setPlanFilter('all'),
                    },
                    {
                      key: 'today',
                      label: `今日及逾期 (${todayDueTaskCount})`,
                      active: planFilter === 'today',
                      icon: <RailClockIcon filled={planFilter === 'today'} />,
                      dot: todayDueTaskCount > 0,
                      onClick: () => setPlanFilter('today'),
                    },
                    {
                      key: 'unplanned',
                      label: `未归类 (${unplannedTaskCount})`,
                      active: planFilter === 'unplanned',
                      icon: <RailInboxIcon />,
                      onClick: () => setPlanFilter('unplanned'),
                    },
                    {
                      key: 'archived',
                      label: `历史归档 (${archivedTaskCount})`,
                      active: planFilter === 'archived',
                      icon: <RailArchiveIcon />,
                      onClick: () => setPlanFilter('archived'),
                    },
                  ],
                },
                {
                  key: 'plans',
                  items: snapshot.plans.map((plan) => ({
                    key: `plan:${plan.id}`,
                    label: `${plan.title} (${countPlanActiveTasks(snapshot.tasks, plan.id)})`,
                    active: planFilter === plan.id,
                    thumb: { name: plan.title, shape: 'circle' },
                    onClick: () => setPlanFilter(plan.id),
                  })),
                },
              ]}
              footerItems={[
                {
                  key: 'new-task',
                  label: '新建任务',
                  icon: <RailPlusIcon />,
                  onClick: () => {
                    const activePlanId = ![
                      'all',
                      'today',
                      'unplanned',
                      'archived',
                    ].includes(planFilter)
                      ? planFilter
                      : null;
                    openDraft(blankTask(activePlanId));
                  },
                },
                {
                  key: 'add-plan',
                  label: '添加新计划',
                  icon: <RailFolderIcon />,
                  onClick: () => {
                    toggleSidebarCollapsed();
                    window.requestAnimationFrame(() =>
                      addPlanInputRef.current?.focus(),
                    );
                  },
                },
                {
                  key: 'review-plans',
                  label: '预览已有计划',
                  icon: <RailEyeIcon />,
                  disabled: Boolean(importBusy),
                  onClick: () => void reviewExistingPlans(),
                },
              ]}
            />
          </aside>
        ) : (
          <aside className="task-sidebar" id="task-sidebar">
            <header className="task-sidebar-heading">
              <div className="task-sidebar-title">学习计划</div>
              <SidebarCollapseButton
                collapsed={false}
                title="收起任务侧栏 (快捷键 Ctrl+B)"
                ariaLabel="收起任务侧栏"
                ariaControls="task-sidebar"
                className="task-sidebar-toggle"
                onClick={toggleSidebarCollapsed}
              />
            </header>
            <button
              type="button"
              className={`task-filter${planFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => setPlanFilter('all')}
            >
              全部任务 <span>{allTaskCount}</span>
            </button>
            <button
              type="button"
              className={`task-filter${planFilter === 'today' ? ' is-active' : ''}`}
              onClick={() => setPlanFilter('today')}
            >
              今日及逾期 <span>{todayDueTaskCount}</span>
            </button>
            <button
              type="button"
              className={`task-filter${planFilter === 'unplanned' ? ' is-active' : ''}`}
              onClick={() => setPlanFilter('unplanned')}
            >
              未归类 <span>{unplannedTaskCount}</span>
            </button>
            <button
              type="button"
              className={`task-filter${planFilter === 'archived' ? ' is-active' : ''}`}
              onClick={() => setPlanFilter('archived')}
            >
              历史归档 <span>{archivedTaskCount}</span>
            </button>
            <div className="task-section-label">计划</div>
            <div className="task-plan-list">
              {snapshot.plans.map((plan) =>
                renamingPlanId === plan.id ? (
                  <form
                    key={plan.id}
                    className="task-plan-rename"
                    onSubmit={(event) => void savePlanRename(event)}
                  >
                    <input
                      value={renamePlanTitle}
                      autoFocus
                      maxLength={120}
                      onChange={(event) =>
                        setRenamePlanTitle(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setRenamingPlanId(null);
                          setRenamePlanTitle('');
                        }
                      }}
                    />
                    <button
                      type="submit"
                      className="task-primary"
                      disabled={savingPlan || !renamePlanTitle.trim()}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingPlanId(null);
                        setRenamePlanTitle('');
                      }}
                    >
                      取消
                    </button>
                  </form>
                ) : (
                  <div
                    key={plan.id}
                    className={`task-plan-row${planFilter === plan.id ? ' is-active' : ''}`}
                  >
                    <button
                      type="button"
                      className={`task-filter${planFilter === plan.id ? ' is-active' : ''}`}
                      onClick={() => setPlanFilter(plan.id)}
                    >
                      <span>{plan.title}</span>
                      <span>
                        {countPlanActiveTasks(snapshot.tasks, plan.id)}
                      </span>
                    </button>
                    <div className="task-plan-actions">
                      <button
                        type="button"
                        aria-label={`重命名计划 ${plan.title}`}
                        title="重命名计划"
                        onClick={() => {
                          setRenamingPlanId(plan.id);
                          setRenamePlanTitle(plan.title);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="task-plan-delete"
                        aria-label={`删除计划 ${plan.title}`}
                        title="删除计划"
                        onClick={() => void deletePlan(plan)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ),
              )}
              {snapshot.plans.length === 0 && (
                <div className="task-muted">还没有计划</div>
              )}
            </div>
            <form className="task-add-plan" onSubmit={addPlan}>
              <input
                ref={addPlanInputRef}
                aria-label="新计划名称"
                placeholder="新计划名称"
                value={newPlan}
                onChange={(event) => setNewPlan(event.target.value)}
              />
              <button type="submit" disabled={!newPlan.trim()}>
                添加
              </button>
            </form>
            <button
              type="button"
              className="task-plain-button"
              onClick={() => void reviewExistingPlans()}
              disabled={Boolean(importBusy)}
            >
              预览已有计划
            </button>
          </aside>
        )}

        <main className="task-main">
          <header className="task-toolbar">
            <div className="task-toolbar-heading">
              <div
                className="task-workspace-switch"
                role="group"
                aria-label="工作台"
              >
                <button type="button" className="is-active" aria-pressed="true">
                  任务
                </button>
                <button
                  type="button"
                  aria-pressed="false"
                  onClick={() => setWorkspaceMode('habits')}
                  title={
                    pendingHabitCount > 0
                      ? `今日还有 ${pendingHabitCount} 个习惯未打卡`
                      : undefined
                  }
                >
                  <span>习惯</span>
                  {pendingHabitCount > 0 && (
                    <span
                      className="task-switch-badge"
                      aria-label={`今日还有 ${pendingHabitCount} 个习惯未打卡`}
                    >
                      {formatBadgeCount(pendingHabitCount)}
                    </span>
                  )}
                </button>
              </div>
              <span className="task-toolbar-count">
                {
                  snapshot.tasks.filter(
                    (item) => !item.archivedAt && item.status === 'doing',
                  ).length
                }{' '}
                进行中 ·{' '}
                {
                  snapshot.tasks.filter(
                    (item) => !item.archivedAt && item.status === 'done',
                  ).length
                }{' '}
                已完成
                {snapshot.tasks.some((item) => item.archivedAt) && (
                  <>
                    {' '}
                    · {
                      snapshot.tasks.filter((item) => item.archivedAt).length
                    }{' '}
                    已归档
                  </>
                )}
              </span>
              {view === 'calendar' && (
                <div
                  id="task-calendar-toolbar-slot"
                  className="task-calendar-toolbar-slot"
                />
              )}
            </div>
            <div className="task-toolbar-actions">
              <input
                aria-label="搜索任务"
                placeholder="搜索任务或资源"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                type="button"
                className={view === 'board' ? 'is-active' : ''}
                onClick={() => changeView('board')}
              >
                看板
              </button>
              <button
                type="button"
                className={view === 'list' ? 'is-active' : ''}
                onClick={() => changeView('list')}
              >
                列表
              </button>
              <button
                type="button"
                className={view === 'calendar' ? 'is-active' : ''}
                onClick={() => changeView('calendar')}
              >
                日历
              </button>
              <button
                type="button"
                className="task-primary"
                onClick={() =>
                  openDraft(
                    blankTask(
                      planFilter !== 'all' &&
                        planFilter !== 'unplanned' &&
                        planFilter !== 'today' &&
                        planFilter !== 'archived'
                        ? planFilter
                        : null,
                    ),
                  )
                }
              >
                新建任务
              </button>
            </div>
          </header>
          <section
            className="task-connection-panel"
            aria-label="任务数据连接状态"
          >
            <div className="task-connection-item">
              <span
                className={`task-connection-dot ${databaseConnected === true ? 'is-connected' : databaseConnected === false ? 'is-error' : 'is-pending'}`}
              />
              任务库：
              {databaseConnected === true
                ? '已连接'
                : databaseConnected === false
                  ? '连接失败'
                  : '检测中'}
            </div>
            <div className="task-connection-item">
              <span
                className={`task-connection-dot ${library?.rootPath ? 'is-connected' : 'is-pending'}`}
              />
              书库：
              {library?.rootPath ? `${library.books.length} 本` : '未连接'}
              {unlinkedEbookCount > 0 && ` · ${unlinkedEbookCount} 条未关联`}
              {ebookRebindCount > 0 && ` · ${ebookRebindCount} 条需确认重绑`}
            </div>
            <div className="task-connection-item">
              <span
                className={`task-connection-dot ${playerConnected === true ? 'is-connected' : playerConnected === false ? 'is-error' : 'is-pending'}`}
              />
              播放器：
              {playerConnected === true
                ? '已连接'
                : playerConnected === false
                  ? '不可用'
                  : '检测中'}
              {videoErrorCount > 0 && ` · ${videoErrorCount} 条进度读取失败`}
              {videoPendingCount > 0 && ` · ${videoPendingCount} 条检测中`}
            </div>
            <div className="task-connection-item">
              计划来源：{snapshot.sources.length} 个
              {removedSourceTaskCount > 0 &&
                ` · ${removedSourceTaskCount} 个已移除节点已保留`}
            </div>
            <button
              type="button"
              className="task-connection-refresh"
              onClick={() => void refreshConnections()}
            >
              重新检测
            </button>
          </section>
          {planFilter !== 'archived' && (
            <div className="task-view-controls">
              <div
                className="task-quick-filters"
                role="group"
                aria-label="快捷筛选"
              >
                {(
                  [
                    ['all', '全部'],
                    ['high', '中高优先级'],
                    ['unblocked', '当前可执行'],
                    [
                      'cancelled',
                      `已取消${cancelledCount > 0 ? ` (${cancelledCount})` : ''}`,
                    ],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`task-quick-chip${quickFilter === value ? ' is-active' : ''}`}
                    aria-pressed={quickFilter === value}
                    onClick={() => setQuickFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="task-sort-select">
                <span>排序</span>
                <select
                  value={sortBy}
                  onChange={(event) =>
                    setSortBy(event.target.value as TaskSortBy)
                  }
                >
                  <option value="position">默认排序</option>
                  <option value="priority">按优先级</option>
                  <option value="dueDate">按截止日期</option>
                  <option value="updatedAt">按最近更新</option>
                </select>
              </label>
            </div>
          )}
          {error && (
            <div className="task-message is-error" role="alert">
              {error}
              <button type="button" onClick={() => setError('')}>
                关闭
              </button>
            </div>
          )}
          {notice && (
            <div className="task-message">
              {notice}
              {statusUndo &&
                (notice === `已完成「${statusUndo.title}」` ||
                  notice ===
                    `「${statusUndo.title}」已更新为${statusName[statusUndo.nextStatus]}`) && (
                  <button
                    type="button"
                    disabled={statusSavingIds.has(statusUndo.taskId)}
                    onClick={() => void undoStatusChange()}
                  >
                    撤销
                  </button>
                )}
              <button type="button" onClick={() => setNotice('')}>
                关闭
              </button>
            </div>
          )}
          {loading ? (
            <div className="task-empty">正在加载任务…</div>
          ) : planFilter === 'archived' ? (
            <div className="task-archive-view">
              <div className="task-archive-summary">
                <div className="task-archive-summary-left">
                  <div className="task-archive-title">历史归档审阅</div>
                  <div className="task-archive-stats">
                    <span className="task-archive-stat-item">
                      总归档 <strong>{filtered.length}</strong> 项
                    </span>
                    <span className="task-archive-stat-item">
                      关联电子书{' '}
                      <strong>
                        {
                          filtered.filter((t) =>
                            t.resources.some((r) => r.kind === 'ebook'),
                          ).length
                        }
                      </strong>{' '}
                      项
                    </span>
                    <span className="task-archive-stat-item">
                      关联视频{' '}
                      <strong>
                        {
                          filtered.filter((t) =>
                            t.resources.some((r) => r.kind === 'youtube'),
                          ).length
                        }
                      </strong>{' '}
                      项
                    </span>
                  </div>
                </div>
                <div className="task-archive-summary-right">
                  <button
                    type="button"
                    className="task-archive-export-btn"
                    onClick={exportArchiveMindmap}
                    disabled={filtered.length === 0}
                  >
                    导出复盘导图
                  </button>
                </div>
              </div>

              {filtered.length === 0 ? (
                <div className="task-empty">
                  暂无归档任务。在「看板」或「任务详情」中可一键归档已完成的任务。
                </div>
              ) : (
                <div className="task-archive-timeline">
                  {groupArchivedTasks(filtered).map((group) => (
                    <section key={group.dateKey} className="task-archive-group">
                      <div className="task-archive-group-header">
                        <span className="task-archive-group-date">
                          {group.dateLabel}
                        </span>
                        <span className="task-archive-group-count">
                          {group.tasks.length} 项
                        </span>
                      </div>
                      <div className="task-archive-group-list">
                        {group.tasks.map((entry) => (
                          <article
                            key={entry.id}
                            className={`task-archive-card${selectedId === entry.id ? ' is-selected' : ''}`}
                            onClick={() => setSelectedId(entry.id)}
                          >
                            <div className="task-archive-card-top">
                              <span className="task-archive-card-title">
                                {entry.title}
                              </span>
                              <div
                                className="task-archive-card-actions"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className="task-archive-unarchive-btn"
                                  onClick={() => void unarchiveTask(entry)}
                                >
                                  取消归档
                                </button>
                              </div>
                            </div>
                            <div className="task-archive-card-meta">
                              {entry.completedAt && (
                                <span className="task-archive-meta-time">
                                  完成时间：{formatTimestamp(entry.completedAt)}
                                </span>
                              )}
                              {entry.planId && (
                                <span className="task-archive-meta-plan">
                                  计划：
                                  {snapshot.plans.find(
                                    (p) => p.id === entry.planId,
                                  )?.title || '已删除计划'}
                                </span>
                              )}
                            </div>
                            {entry.note && (
                              <div className="task-archive-card-note">
                                {entry.note}
                              </div>
                            )}
                            {entry.resources.length > 0 && (
                              <div
                                className="task-archive-card-resources"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {entry.resources.map((resource) => (
                                  <div
                                    key={`${resource.kind}:${resource.resourceId}`}
                                    className="task-archive-resource-row"
                                  >
                                    <span className="task-archive-resource-name">
                                      {resource.kind === 'ebook'
                                        ? '电子书'
                                        : 'YouTube'}{' '}
                                      · {resource.title}
                                    </span>
                                    <button
                                      type="button"
                                      className="task-archive-resource-btn"
                                      onClick={() =>
                                        void openResource(entry, resource)
                                      }
                                    >
                                      打开资源
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          ) : view === 'board' ? (
            (() => {
              const showCancelledColumn =
                quickFilter === 'cancelled' || cancelledCount > 0;
              const columnsToRender = showCancelledColumn
                ? [
                    ...COLUMNS,
                    { status: 'cancelled' as const, label: '已取消' },
                  ]
                : COLUMNS;
              return (
                <div
                  className={`task-board${showCancelledColumn ? ' has-cancelled' : ''}`}
                >
                  {columnsToRender.map((column) => {
                    const entries = filtered.filter(
                      (entry) => entry.status === column.status,
                    );
                    return (
                      <section
                        key={column.status}
                        className="task-column"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          const entry = snapshot.tasks.find(
                            (item) => item.id === dragging,
                          );
                          if (entry && entry.status !== column.status)
                            void changeStatus(entry, column.status);
                          setDragging(null);
                        }}
                      >
                        <header className="task-column-head">
                          <div className="task-column-head-title">
                            <span>{column.label}</span>
                            <span className="task-column-count">
                              {entries.length}
                            </span>
                          </div>
                          {column.status === 'done' && (
                            <button
                              type="button"
                              className="task-column-archive-btn"
                              title="归档当前已完成任务"
                              disabled={entries.length === 0}
                              onClick={() => void archiveDoneTasks()}
                            >
                              归档已完成
                            </button>
                          )}
                        </header>
                        <div className="task-column-items">
                          {taskGroups
                            .filter((group) =>
                              group.tasks.some(
                                (entry) => entry.status === column.status,
                              ),
                            )
                            .map((group) => {
                              const columnEntries = group.entries.filter(
                                (treeEntry) =>
                                  treeEntry.task.status === column.status,
                              );
                              const columnIds = new Set(
                                columnEntries.map(
                                  (treeEntry) => treeEntry.task.id,
                                ),
                              );
                              return (
                                <section
                                  className="task-source-group task-source-group-board"
                                  key={group.key}
                                >
                                  {renderSourceHeader(group)}
                                  <div className="task-source-group-items">
                                    {columnEntries.map((treeEntry) => {
                                      const parentInSameCol = Boolean(
                                        treeEntry.task.parentId &&
                                        columnIds.has(treeEntry.task.parentId),
                                      );
                                      const parentTitle = treeEntry.task
                                        .parentId
                                        ? byId.get(treeEntry.task.parentId)
                                            ?.title
                                        : undefined;
                                      return renderCard({
                                        ...treeEntry,
                                        depth: parentInSameCol
                                          ? treeEntry.depth
                                          : 0,
                                        detachedParentTitle:
                                          !parentInSameCol && parentTitle
                                            ? parentTitle
                                            : undefined,
                                      });
                                    })}
                                  </div>
                                </section>
                              );
                            })}
                          {entries.length === 0 && (
                            <div className="task-column-empty">暂无任务</div>
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              );
            })()
          ) : view === 'calendar' ? (
            <TaskCalendar
              tasks={quickMatchingTasks}
              onOpenTask={setSelectedId}
              onCreateTask={createTaskForDate}
              onMoveTask={moveTaskDate}
              onToggleTaskCompletion={toggleTaskCompletion}
              statusSavingIds={statusSavingIds}
              today={todayKey}
              detailOpen={Boolean(selected)}
              showCancelled={quickFilter === 'cancelled'}
              filterHint={
                planFilter === 'today'
                  ? '当前仅显示「今日到期与逾期」任务，其余日期暂被隐藏'
                  : undefined
              }
              onClearFilter={
                planFilter === 'today' ? () => setPlanFilter('all') : undefined
              }
            />
          ) : (
            <div className="task-list">
              {taskGroups.length ? (
                taskGroups.map((group) => (
                  <section className="task-source-group" key={group.key}>
                    {renderSourceHeader(group)}
                    <div className="task-source-group-items">
                      {group.entries.map(renderCard)}
                    </div>
                  </section>
                ))
              ) : (
                <div className="task-empty">
                  还没有任务。可以新建任务或预览已有计划。
                </div>
              )}
            </div>
          )}
        </main>

        {selected && (
          <aside
            className={`task-detail${view === 'calendar' ? ' is-calendar-slot' : ''}`}
          >
            <div className="task-detail-head">
              <strong>任务详情</strong>
              <button
                type="button"
                className={view === 'calendar' ? 'task-detail-back' : undefined}
                onClick={() => setSelectedId(null)}
                aria-label={view === 'calendar' ? '返回日程' : '关闭任务详情'}
              >
                {view === 'calendar' ? '返回日程' : '×'}
              </button>
            </div>
            <div className="task-detail-body">
              <h2>{selected.title}</h2>
              <div className="task-detail-status-row">
                <span>状态</span>
                <div className="task-detail-status-controls">
                  <span className={`task-status-current is-${selected.status}`}>
                    {statusName[selected.status]}
                  </span>
                  <button
                    type="button"
                    className={
                      selected.status === 'done'
                        ? 'task-status-reopen'
                        : 'task-primary task-completion-action'
                    }
                    disabled={statusSavingIds.has(selected.id)}
                    onClick={() => toggleTaskCompletion(selected)}
                  >
                    {selected.status === 'done' ||
                    selected.status === 'cancelled'
                      ? '重新打开'
                      : '✓ 标记完成'}
                  </button>
                  <details className="task-status-menu">
                    <summary
                      aria-label={`当前状态：${statusName[selected.status]}，更改状态`}
                    >
                      更多
                    </summary>
                    <div role="group" aria-label="更改任务状态">
                      {Object.entries(statusName).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={selected.status === value}
                          disabled={
                            selected.status === value ||
                            statusSavingIds.has(selected.id)
                          }
                          onClick={(event) => {
                            event.currentTarget
                              .closest('details')
                              ?.removeAttribute('open');
                            void changeStatus(selected, value as TaskStatus);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </details>
                </div>
              </div>
              <div className="task-detail-row">
                <span>计划</span>
                <span>
                  {snapshot.plans.find((plan) => plan.id === selected.planId)
                    ?.title || '未归类'}
                </span>
              </div>
              <div className="task-detail-row">
                <span>优先级</span>
                <span>
                  {TASK_PRIORITY_LABELS[selected.priority] ??
                    `P${selected.priority}`}
                </span>
              </div>
              {selected.parentId && (
                <div className="task-detail-row">
                  <span>父任务</span>
                  <button
                    type="button"
                    className="task-detail-link"
                    onClick={() => setSelectedId(selected.parentId)}
                  >
                    {byId.get(selected.parentId)?.title ?? '父任务不存在'}
                  </button>
                </div>
              )}
              {selected.dueDate && (
                <div className="task-detail-row">
                  <span>截止</span>
                  <span>{selected.dueDate}</span>
                </div>
              )}
              {selected.note && <p className="task-note">{selected.note}</p>}
              {selected.sourceKey && !selected.sourcePresent && (
                <span className="task-source-removed">
                  原计划已移除此节点；任务和进度保留
                </span>
              )}
              {selected.prerequisiteIds.length > 0 && (
                <div className="task-detail-section">
                  <strong>前置任务</strong>
                  {selected.prerequisiteIds.map((id) => (
                    <div key={id}>
                      {byId.get(id)?.status === 'done' ? '✓' : '○'}{' '}
                      {byId.get(id)?.title ?? '任务不存在'}
                    </div>
                  ))}
                </div>
              )}
              {selected.resources.map((resource) => (
                <div
                  className="task-resource"
                  key={`${resource.kind}:${resource.resourceId}`}
                >
                  <strong>
                    {resource.kind === 'ebook' ? '电子书' : 'YouTube'} ·{' '}
                    {resource.title}
                  </strong>
                  <span>{resourceProgress(resource, library, watch)}</span>
                  <button
                    type="button"
                    className="task-primary"
                    onClick={() => void openResource(selected, resource)}
                  >
                    打开资源
                  </button>
                  {ebookLinkNeedsRepair(resource) && (
                    <button
                      type="button"
                      onClick={() => openDraft(editTask(selected))}
                    >
                      重新关联书籍
                    </button>
                  )}
                  {resource.kind === 'youtube' &&
                    watch[resource.resourceId] === 'error' && (
                      <button
                        type="button"
                        onClick={() =>
                          void retryVideoProgress(resource.resourceId)
                        }
                      >
                        重试读取进度
                      </button>
                    )}
                </div>
              ))}
              {taskTargetsReached(selected, library, watch) && (
                <div className="task-target-ready" role="status">
                  <span>已达到所有关联资源的目标。</span>
                  {selected.status !== 'done' && (
                    <button
                      type="button"
                      disabled={statusSavingIds.has(selected.id)}
                      onClick={() => void changeStatus(selected, 'done')}
                    >
                      确认标记完成
                    </button>
                  )}
                </div>
              )}
              <div className="task-detail-actions">
                <button
                  type="button"
                  onClick={() => openDraft(editTask(selected))}
                >
                  编辑
                </button>
                {!selected.archivedAt && (
                  <button
                    type="button"
                    onClick={() =>
                      openDraft({
                        ...blankTask(selected.planId),
                        parentId: selected.id,
                      })
                    }
                  >
                    + 添加子任务
                  </button>
                )}
                {selected.status === 'done' && !selected.archivedAt && (
                  <button
                    type="button"
                    disabled={statusSavingIds.has(selected.id)}
                    onClick={() => void archiveSingleTask(selected)}
                  >
                    归档
                  </button>
                )}
                <button type="button" onClick={() => void deleteTask(selected)}>
                  删除任务
                </button>
              </div>
            </div>
          </aside>
        )}

        {draft && (
          <div
            className="task-modal-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !saving)
                setDraft(null);
            }}
          >
            <form
              className="task-modal"
              onSubmit={(event) => void saveDraft(event)}
              role="dialog"
              aria-modal="true"
              aria-label={draft.id ? '编辑任务' : '新建任务'}
            >
              <header>
                <strong>{draft.id ? '编辑任务' : '新建任务'}</strong>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  disabled={saving}
                >
                  关闭
                </button>
              </header>
              <div className="task-modal-body">
                <label>
                  标题
                  <input
                    value={draft.title}
                    required
                    maxLength={240}
                    onChange={(event) =>
                      setDraft({ ...draft, title: event.target.value })
                    }
                  />
                </label>
                <div className="task-form-row">
                  <label>
                    计划
                    <select
                      value={draft.planId ?? ''}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          planId: event.target.value || null,
                        })
                      }
                    >
                      <option value="">未归类</option>
                      {snapshot.plans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    父任务
                    <select
                      value={draft.parentId ?? ''}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          parentId: event.target.value || null,
                        })
                      }
                    >
                      <option value="">无（顶级任务）</option>
                      {(() => {
                        const excluded = draft.id
                          ? collectTaskDescendantIds(snapshot.tasks, draft.id)
                          : new Set<string>();
                        return snapshot.tasks
                          .filter(
                            (item) =>
                              !item.archivedAt &&
                              item.id !== draft.id &&
                              !excluded.has(item.id),
                          )
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.title}
                            </option>
                          ));
                      })()}
                    </select>
                  </label>
                  <label>
                    截止日期
                    <input
                      type="date"
                      value={draft.dueDate ?? ''}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          dueDate: event.target.value || null,
                        })
                      }
                    />
                  </label>
                </div>
                <div className="task-form-row">
                  <label>
                    状态
                    <select
                      value={draft.status}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          status: event.target.value as TaskStatus,
                        })
                      }
                    >
                      {Object.entries(statusName).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    优先级
                    <select
                      value={draft.priority}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          priority: Number(event.target.value),
                        })
                      }
                    >
                      <option value={0}>普通</option>
                      <option value={1}>低</option>
                      <option value={2}>中</option>
                      <option value={3}>高</option>
                    </select>
                  </label>
                </div>
                <section className="task-resource-editor">
                  <div className="task-resource-editor-heading">
                    <div>
                      <strong>关联资源</strong>
                      <span>
                        各资源进度分别统计；所有目标达成后由你确认完成。
                      </span>
                    </div>
                    <div className="task-resource-add-actions">
                      <button
                        type="button"
                        onClick={() => addResourceDraft('ebook')}
                      >
                        + 电子书
                      </button>
                      <button
                        type="button"
                        onClick={() => addResourceDraft('youtube')}
                      >
                        + YouTube
                      </button>
                    </div>
                  </div>
                  {resourceDrafts.map((item) => (
                    <fieldset
                      className="task-resource-edit-card"
                      key={item.key}
                    >
                      <div className="task-resource-edit-heading">
                        <label>
                          资源类型
                          <select
                            value={item.kind}
                            onChange={(event) => {
                              const kind = event.target
                                .value as TaskResource['kind'];
                              updateResourceDraft(item.key, {
                                kind,
                                original: null,
                                bookPath: '',
                                chapterHref: '',
                                videoInput: '',
                                startSeconds: '0',
                                targetUnit: '',
                                targetValue: '',
                                manualValue: '',
                              });
                            }}
                          >
                            <option value="ebook">电子书</option>
                            <option value="youtube">YouTube 视频</option>
                          </select>
                        </label>
                        <button
                          type="button"
                          className="task-resource-remove"
                          onClick={() => removeResourceDraft(item.key)}
                        >
                          移除资源
                        </button>
                      </div>
                      {item.kind === 'ebook' ? (
                        <>
                          <label>
                            书籍
                            <select
                              value={item.bookPath}
                              onChange={(event) =>
                                updateResourceDraft(item.key, {
                                  bookPath: event.target.value,
                                })
                              }
                            >
                              <option value="">选择书籍</option>
                              {item.bookPath &&
                                !library?.books.some(
                                  (book) => book.relativePath === item.bookPath,
                                ) && (
                                  <option value={item.bookPath}>
                                    未找到：{item.bookPath}
                                  </option>
                                )}
                              {library?.books.map((book) => (
                                <option
                                  key={book.relativePath}
                                  value={book.relativePath}
                                >
                                  {book.title}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            章节链接（可选）
                            <input
                              value={item.chapterHref}
                              onChange={(event) =>
                                updateResourceDraft(item.key, {
                                  chapterHref: event.target.value,
                                })
                              }
                              placeholder="从阅读器创建任务时自动带入"
                            />
                          </label>
                        </>
                      ) : (
                        <div className="task-form-row">
                          <label>
                            视频链接或 ID
                            <input
                              value={item.videoInput}
                              onChange={(event) =>
                                updateResourceDraft(item.key, {
                                  videoInput: event.target.value,
                                })
                              }
                              placeholder="YouTube 视频链接或 11 位 ID"
                            />
                          </label>
                          <label>
                            起始秒数
                            <input
                              type="number"
                              min="0"
                              value={item.startSeconds}
                              onChange={(event) =>
                                updateResourceDraft(item.key, {
                                  startSeconds: event.target.value,
                                })
                              }
                            />
                          </label>
                        </div>
                      )}
                      <div className="task-form-row">
                        <label>
                          目标单位
                          <select
                            value={item.targetUnit}
                            onChange={(event) =>
                              updateResourceDraft(item.key, {
                                targetUnit: event.target
                                  .value as ResourceTargetUnit,
                              })
                            }
                          >
                            <option value="">无目标</option>
                            {item.kind === 'ebook' ? (
                              <>
                                <option value="chapters">章节</option>
                                <option value="words">字数（估算）</option>
                              </>
                            ) : (
                              <option value="seconds">秒</option>
                            )}
                          </select>
                        </label>
                        <label>
                          目标
                          <input
                            type="number"
                            min="1"
                            value={item.targetValue}
                            onChange={(event) =>
                              updateResourceDraft(item.key, {
                                targetValue: event.target.value,
                              })
                            }
                            disabled={!item.targetUnit}
                          />
                        </label>
                        {(item.targetUnit === 'words' ||
                          item.targetUnit === 'seconds') && (
                          <label>
                            手动进度
                            <input
                              type="number"
                              min="0"
                              value={item.manualValue}
                              onChange={(event) =>
                                updateResourceDraft(item.key, {
                                  manualValue: event.target.value,
                                })
                              }
                            />
                          </label>
                        )}
                      </div>
                      {item.original && (
                        <p className="task-resource-current-progress">
                          当前：
                          {resourceProgress(item.original, library, watch)}
                        </p>
                      )}
                    </fieldset>
                  ))}
                </section>{' '}
                <label>
                  备注
                  <textarea
                    rows={3}
                    value={draft.note ?? ''}
                    onChange={(event) =>
                      setDraft({ ...draft, note: event.target.value })
                    }
                  />
                </label>
                {snapshot.tasks.filter(
                  (item) =>
                    item.id !== draft.id &&
                    (!draft.planId || item.planId === draft.planId),
                ).length > 0 && (
                  <fieldset className="task-prerequisites">
                    <legend>前置任务</legend>
                    {snapshot.tasks
                      .filter(
                        (item) =>
                          item.id !== draft.id &&
                          (!draft.planId || item.planId === draft.planId),
                      )
                      .map((item) => (
                        <label key={item.id}>
                          <input
                            type="checkbox"
                            checked={draft.prerequisiteIds.includes(item.id)}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                prerequisiteIds: event.target.checked
                                  ? [...draft.prerequisiteIds, item.id]
                                  : draft.prerequisiteIds.filter(
                                      (id) => id !== item.id,
                                    ),
                              })
                            }
                          />
                          {item.title}
                        </label>
                      ))}
                  </fieldset>
                )}
                {draftError && (
                  <div className="task-error" role="alert">
                    {draftError}
                  </div>
                )}
              </div>
              <footer>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  disabled={saving}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="task-primary"
                  disabled={saving || !draft.title.trim()}
                >
                  {saving ? '保存中…' : '保存任务'}
                </button>
              </footer>
            </form>
          </div>
        )}

        {candidates && (
          <div
            className="task-modal-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !importBusy)
                setCandidates(null);
            }}
          >
            <div
              className="task-modal"
              role="dialog"
              aria-modal="true"
              aria-label="预览已有计划"
            >
              <header>
                <strong>预览已有计划</strong>
                <button type="button" onClick={() => setCandidates(null)}>
                  关闭
                </button>
              </header>
              <div className="task-modal-body">
                {error && (
                  <div className="task-error" role="alert">
                    {error}
                  </div>
                )}
                <p className="task-muted">
                  预览来源节点后确认同步。已有任务状态和资源进度会保留；来源更新只覆盖未被本地修改的字段，冲突会保留本地内容并计入结果。来源移除的节点会保留并标记，不会删除。
                </p>
                {candidates.length === 0 && (
                  <p className="task-muted">
                    当前书库和播放器没有可导入的计划。
                  </p>
                )}
                {candidates.length > 0 && (
                  <>
                    <div className="task-import-selection-actions">
                      <strong>选择来源</strong>
                      <small>
                        默认按电子书、视频分组；可用箭头调整导入顺序。
                      </small>
                      <button
                        type="button"
                        disabled={Boolean(importBusy)}
                        onClick={() =>
                          setSelectedCandidateKeys(
                            candidates.map((candidate) => candidate.key),
                          )
                        }
                      >
                        全选
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(importBusy)}
                        onClick={() => setSelectedCandidateKeys([])}
                      >
                        清空
                      </button>
                    </div>
                    <div className="task-import-target">
                      <label>
                        同步到计划
                        <select
                          value={mergeTargetPlanId}
                          disabled={Boolean(importBusy)}
                          onChange={(event) =>
                            setMergeTargetPlanId(event.target.value)
                          }
                        >
                          <option value="new">
                            新建一个计划并合并所选来源
                          </option>
                          {snapshot.plans.map((plan) => (
                            <option key={plan.id} value={plan.id}>
                              {plan.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      {mergeTargetPlanId === 'new' && (
                        <label>
                          新计划名称
                          <input
                            value={newPlanTitle}
                            maxLength={160}
                            disabled={Boolean(importBusy)}
                            onChange={(event) =>
                              setNewPlanTitle(event.target.value)
                            }
                          />
                        </label>
                      )}
                    </div>
                    {candidates.map((candidate, candidateIndex) => {
                      const sourceLink = snapshot.sources.find(
                        (source) => source.sourceKey === candidate.key,
                      );
                      const linkedPlan = snapshot.plans.find(
                        (plan) =>
                          plan.id ===
                          (sourceLink?.planId ??
                            snapshot.plans.find(
                              (plan) => plan.originKey === candidate.key,
                            )?.id),
                      );
                      const existingNodeCount = candidate.draft.tasks.filter(
                        (item) =>
                          snapshot.tasks.some(
                            (task) => task.originKey === item.originKey,
                          ),
                      ).length;
                      const selectedCandidate = selectedCandidateKeys.includes(
                        candidate.key,
                      );
                      return (
                        <article
                          className={`task-import-card${selectedCandidate ? ' is-selected' : ''}`}
                          key={candidate.key}
                        >
                          <label className="task-import-card-select">
                            <input
                              type="checkbox"
                              checked={selectedCandidate}
                              disabled={Boolean(importBusy)}
                              onChange={(event) =>
                                setSelectedCandidateKeys((current) =>
                                  event.target.checked
                                    ? [...current, candidate.key]
                                    : current.filter(
                                        (key) => key !== candidate.key,
                                      ),
                                )
                              }
                            />
                            <span>
                              <strong>{candidate.label}</strong>
                              <small>
                                {candidate.source} ·{' '}
                                {candidate.draft.tasks.length} 个节点
                                {candidate.missingBooks
                                  ? ` · ${candidate.missingBooks} 本书需重新关联`
                                  : ''}
                              </small>
                            </span>
                          </label>
                          <div className="task-import-order-controls">
                            <button
                              type="button"
                              aria-label="上移来源"
                              title="上移来源"
                              disabled={
                                Boolean(importBusy) || candidateIndex === 0
                              }
                              onClick={() => moveCandidate(candidate.key, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              aria-label="下移来源"
                              title="下移来源"
                              disabled={
                                Boolean(importBusy) ||
                                candidateIndex === candidates.length - 1
                              }
                              onClick={() => moveCandidate(candidate.key, 1)}
                            >
                              ↓
                            </button>
                          </div>
                          <div className="task-import-connection">
                            {linkedPlan
                              ? `已连接到「${linkedPlan.title}」`
                              : '尚未连接'}
                            {` · 已有 ${existingNodeCount} / ${candidate.draft.tasks.length} 项`}
                            {sourceLink?.removedCount
                              ? ` · ${sourceLink.removedCount} 个来源移除节点已保留`
                              : ''}
                          </div>
                          <details>
                            <summary>查看节点与依赖</summary>
                            <ul>
                              {candidate.draft.tasks.map((item) => (
                                <li key={item.id}>
                                  {item.title}
                                  {item.prerequisiteIds.length
                                    ? ` · ${item.prerequisiteIds.length} 个前置`
                                    : ''}
                                  {item.optional ? ' · 可选' : ''}
                                </li>
                              ))}
                            </ul>
                          </details>
                        </article>
                      );
                    })}
                  </>
                )}
              </div>
              <footer className="task-modal-footer">
                <button
                  type="button"
                  onClick={() => setCandidates(null)}
                  disabled={Boolean(importBusy)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="task-primary"
                  onClick={() => void syncSelectedCandidates()}
                  disabled={
                    Boolean(importBusy) || selectedCandidateKeys.length === 0
                  }
                >
                  {importBusy === 'sync'
                    ? '同步中…'
                    : `确认同步 ${selectedCandidateKeys.length} 个来源`}
                </button>
              </footer>
            </div>
          </div>
        )}
        {confirmDialog}
      </div>
      {habitsMounted && (
        <div
          className="task-workspace-host"
          hidden={workspaceMode !== 'habits'}
        >
          <HabitWorkspace
            active={active && workspaceMode === 'habits'}
            onShowTasks={() => setWorkspaceMode('tasks')}
          />
        </div>
      )}
    </div>
  );
}
