import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { LibrarySnapshot } from '../library';
import {
  epubProgressKey,
  getEpubReadingPlanCompleted,
  loadEpubBookMetadata,
  loadEpubReadingActivity,
  loadEpubReadingPlan,
} from '../ebook-storage';
import { playerApi } from '../player/player-api';
import type { WatchState } from '../player/types';
import { parseYouTubeTarget } from '../player/video-links';
import TaskCalendar from './TaskCalendar';
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
const emptySnapshot: TaskSnapshot = { plans: [], tasks: [] };
const TASK_VIEW_KEY = 'seamind:task-view:v1';

function readTaskView(): 'board' | 'list' | 'calendar' {
  try {
    const stored = localStorage.getItem(TASK_VIEW_KEY);
    return stored === 'list' || stored === 'calendar' ? stored : 'board';
  } catch {
    return 'board';
  }
}

function blankTask(planId: string | null, resource?: TaskResource): TaskInput {
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

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatSeconds(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function resourceProgress(
  resource: TaskResource,
  library: LibrarySnapshot | null,
  watch: Record<string, WatchState | null | 'error'>,
): string {
  if (resource.kind === 'youtube') {
    const state = watch[resource.resourceId];
    if (state === undefined) return '正在读取观看进度';
    if (state === 'error') return '观看进度暂时不可用';
    if (!state) return '暂无观看记录';
    const duration = state.durationSeconds
      ? ` / ${formatSeconds(state.durationSeconds)}`
      : '';
    return `观看 ${formatSeconds(state.progressSeconds)}${duration}${state.finished ? ' · 视频已看完' : ''}`;
  }
  if (!library?.rootPath || library.rootPath !== resource.rootPath)
    return '书库未打开或已切换';
  const book = library.books.find(
    (item) => item.relativePath === resource.relativePath,
  );
  if (!book) return '书籍未找到，可编辑任务重新关联';
  const currentKey = epubProgressKey(book);
  if (resource.progressKey && currentKey !== resource.progressKey)
    return '书籍文件已变化，请确认并重新关联';
  const key = resource.progressKey || currentKey;
  const metadata = loadEpubBookMetadata(key);
  const activity = loadEpubReadingActivity(key);
  if (resource.targetUnit === 'words' && resource.targetValue) {
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
    const completed = Math.min(
      resource.targetValue,
      Math.max(resource.manualValue ?? 0, estimate),
    );
    return `估算 / 手动 ${completed.toLocaleString()} / ${resource.targetValue.toLocaleString()} 字`;
  }
  if (resource.targetUnit === 'chapters' && resource.targetValue) {
    const readingPlan = loadEpubReadingPlan(key);
    const matchesPlan =
      readingPlan &&
      readingPlan.targetChapters === resource.targetValue &&
      readingPlan.startChapterIndex === resource.baseline;
    const chapters = matchesPlan
      ? getEpubReadingPlanCompleted(readingPlan)
      : Math.max(
          0,
          (metadata?.currentChapterIndex ?? 0) - (resource.baseline ?? 0),
        );
    return `${matchesPlan ? '章节进度' : '当前章节估算'} ${Math.min(chapters, resource.targetValue)} / ${resource.targetValue}`;
  }
  return metadata
    ? `阅读位置 ${Math.round(metadata.progress * 100)}%`
    : '暂无阅读记录';
}

export default function TaskWorkspace({
  library,
  createRequest,
  openTaskId,
  onOpenTaskHandled,
  onCreateRequestHandled,
  onOpenResource,
}: Props) {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [planFilter, setPlanFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'board' | 'list' | 'calendar'>(readTaskView);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newPlan, setNewPlan] = useState('');
  const [draft, setDraft] = useState<TaskInput | null>(null);
  const [sourceKind, setSourceKind] = useState<'none' | 'ebook' | 'youtube'>(
    'none',
  );
  const [bookPath, setBookPath] = useState('');
  const [chapterHref, setChapterHref] = useState('');
  const [videoInput, setVideoInput] = useState('');
  const [startSeconds, setStartSeconds] = useState('0');
  const [targetUnit, setTargetUnit] = useState<
    '' | 'chapters' | 'words' | 'seconds'
  >('');
  const [targetValue, setTargetValue] = useState('');
  const [manualValue, setManualValue] = useState('');
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [importBusy, setImportBusy] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [watch, setWatch] = useState<
    Record<string, WatchState | null | 'error'>
  >({});
  const [progressRevision, setProgressRevision] = useState(0);

  const reload = useCallback(async () => {
    try {
      const next = await taskApi.snapshot();
      setSnapshot(next);
      setError('');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
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
  }, [reload]);

  useEffect(() => {
    let current = true;
    const ids = Array.from(
      new Set(
        snapshot.tasks.flatMap((entry) =>
          entry.resources
            .filter((resource) => resource.kind === 'youtube')
            .map((resource) => resource.resourceId),
        ),
      ),
    );
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
  }, [snapshot.tasks, progressRevision]);

  const openDraft = useCallback((input: TaskInput) => {
    const resource = input.resources[0];
    setDraft(input);
    setSourceKind(resource?.kind ?? 'none');
    setBookPath(
      resource?.kind === 'ebook' ? (resource.relativePath ?? '') : '',
    );
    setChapterHref(resource?.kind === 'ebook' ? (resource.href ?? '') : '');
    setVideoInput(resource?.kind === 'youtube' ? resource.resourceId : '');
    setStartSeconds(String(resource?.startSeconds ?? 0));
    setTargetUnit(resource?.targetUnit ?? '');
    setTargetValue(
      resource?.targetValue == null ? '' : String(resource.targetValue),
    );
    setManualValue(
      resource?.manualValue == null ? '' : String(resource.manualValue),
    );
    setDraftError('');
  }, []);

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

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const filtered = useMemo(
    () =>
      snapshot.tasks.filter((entry) => {
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
        const term = query.trim().toLocaleLowerCase();
        return (
          inPlan &&
          (!term ||
            [
              entry.title,
              entry.note,
              ...entry.resources.map((resource) => resource.title),
            ].some((value) => value?.toLocaleLowerCase().includes(term)))
        );
      }),
    [snapshot.tasks, planFilter, query, todayKey],
  );
  const selected =
    snapshot.tasks.find((entry) => entry.id === selectedId) ?? null;
  const byId = useMemo(
    () => new Map(snapshot.tasks.map((entry) => [entry.id, entry])),
    [snapshot.tasks],
  );
  const isBlocked = (entry: LearningTask) =>
    entry.prerequisiteIds.some((id) => byId.get(id)?.status !== 'done');

  const changeView = (next: typeof view) => {
    setView(next);
    try {
      localStorage.setItem(TASK_VIEW_KEY, next);
    } catch {
      /* Storage may be unavailable. */
    }
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
    } catch (reason) {
      await reload();
      setError(errorText(reason));
    }
  };

  const changeStatus = async (entry: LearningTask, status: TaskStatus) => {
    try {
      await taskApi.saveTask({ ...editTask(entry), status });
      setNotice('任务状态已更新');
    } catch (reason) {
      setError(errorText(reason));
      void reload();
    }
  };

  const openResource = async (resource: TaskResource) => {
    try {
      await onOpenResource(resource);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const addPlan = async (event: FormEvent) => {
    event.preventDefault();
    if (!newPlan.trim()) return;
    try {
      const next = await taskApi.savePlan({ title: newPlan.trim() });
      setSnapshot(next);
      setNewPlan('');
      setNotice('计划已创建');
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const saveDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || saving) return;
    setDraftError('');
    let resources: TaskResource[] = [];
    const old = draft.resources[0];
    const numericTarget = targetValue.trim() ? Number(targetValue) : null;
    const numericManual = manualValue.trim() ? Number(manualValue) : null;
    if (
      (numericTarget !== null &&
        (!Number.isFinite(numericTarget) || numericTarget <= 0)) ||
      (numericManual !== null &&
        (!Number.isFinite(numericManual) || numericManual < 0))
    ) {
      setDraftError('目标和手动进度需要填写有效的非负数字。');
      return;
    }
    if (sourceKind === 'ebook') {
      const book = library?.books.find(
        (item) => item.relativePath === bookPath,
      );
      if (book && library?.rootPath) {
        const key = epubProgressKey(book);
        const same =
          old?.kind === 'ebook' &&
          old.rootPath === library.rootPath &&
          old.relativePath === book.relativePath &&
          old.progressKey === key;
        const metadata = loadEpubBookMetadata(key);
        resources = [
          {
            kind: 'ebook',
            resourceId: same ? old.resourceId : crypto.randomUUID(),
            title: book.title,
            rootPath: library.rootPath,
            relativePath: book.relativePath,
            progressKey: key,
            href: chapterHref.trim() || null,
            targetUnit:
              targetUnit === 'chapters' || targetUnit === 'words'
                ? targetUnit
                : null,
            targetValue: numericTarget,
            baseline:
              same && old.targetUnit === targetUnit
                ? old.baseline
                : targetUnit === 'chapters'
                  ? (metadata?.currentChapterIndex ?? 0)
                  : (metadata?.progress ?? 0),
            manualValue: numericManual,
          },
        ];
      } else if (old?.kind === 'ebook' && old.relativePath === bookPath) {
        resources = [
          {
            ...old,
            href: chapterHref.trim() || null,
            targetUnit:
              targetUnit === 'chapters' || targetUnit === 'words'
                ? targetUnit
                : null,
            targetValue: numericTarget,
            manualValue: numericManual,
          },
        ];
      } else {
        setDraftError('请选择可用电子书。');
        return;
      }
    } else if (sourceKind === 'youtube') {
      const parsed = parseYouTubeTarget(videoInput);
      if (!parsed || parsed.kind !== 'video') {
        setDraftError('请输入有效的 YouTube 视频链接或 ID。');
        return;
      }
      const start = Number(startSeconds);
      if (!Number.isFinite(start) || start < 0) {
        setDraftError('视频起始秒数无效。');
        return;
      }
      resources = [
        {
          kind: 'youtube',
          resourceId: parsed.videoId,
          title:
            old?.kind === 'youtube' && old.resourceId === parsed.videoId
              ? old.title
              : draft.title,
          startSeconds: Math.floor(start || parsed.startSeconds),
          targetUnit: targetUnit === 'seconds' ? 'seconds' : null,
          targetValue: numericTarget,
          manualValue: numericManual,
        },
      ];
    }
    if (draft.resources.length > 1) resources.push(...draft.resources.slice(1));
    setSaving(true);
    try {
      const saved = await taskApi.saveTask({
        ...draft,
        title: draft.title.trim(),
        resources,
      });
      setSelectedId(saved.id);
      setDraft(null);
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
        overview.learningPaths.map((path) =>
          playerApi.learningPathGet(path.pathId),
        ),
      );
      details.forEach((detail) => {
        if (detail) items.push(videoImportCandidate(detail));
      });
    } catch (reason) {
      setError(`视频学习路径读取失败：${errorText(reason)}`);
    }
    setCandidates(items);
    setImportBusy('');
  };

  const importCandidate = async (candidate: ImportCandidate) => {
    setImportBusy(candidate.key);
    try {
      const result = await taskApi.importPlan(candidate.draft);
      setPlanFilter(result.planId);
      setCandidates(null);
      setNotice(`已导入 ${result.added} 项，已有 ${result.alreadyPresent} 项`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setImportBusy('');
    }
  };

  const deleteTask = async (entry: LearningTask) => {
    if (!window.confirm(`删除任务「${entry.title}」？关联的书籍和视频会保留。`))
      return;
    try {
      await taskApi.deleteTask(entry.id);
      setSelectedId(null);
      setNotice('任务已删除');
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const renderCard = (entry: LearningTask) => (
    <article
      key={entry.id}
      className={`task-card${selectedId === entry.id ? ' is-selected' : ''}`}
      draggable
      onDragStart={() => setDragging(entry.id)}
      onDragEnd={() => setDragging(null)}
      onClick={() => setSelectedId(entry.id)}
    >
      <div className="task-card-title">{entry.title}</div>
      <div className="task-card-meta">
        {entry.resources.map((resource) => (
          <span key={`${resource.kind}:${resource.resourceId}`}>
            {resource.kind === 'ebook' ? '电子书' : 'YouTube'}
          </span>
        ))}
        {entry.dueDate && <span>截止 {entry.dueDate}</span>}
        {entry.optional && <span>可选</span>}
        {isBlocked(entry) && entry.status !== 'done' && (
          <span className="task-blocked">前置未完成</span>
        )}
      </div>
      {entry.resources[0] && (
        <div className="task-card-progress">
          {resourceProgress(entry.resources[0], library, watch)}
        </div>
      )}
    </article>
  );

  return (
    <div className="task-workspace">
      <aside className="task-sidebar">
        <div className="task-sidebar-title">学习计划</div>
        <button
          type="button"
          className={`task-filter${planFilter === 'all' ? ' is-active' : ''}`}
          onClick={() => setPlanFilter('all')}
        >
          全部任务 <span>{snapshot.tasks.length}</span>
        </button>
        <button
          type="button"
          className={`task-filter${planFilter === 'today' ? ' is-active' : ''}`}
          onClick={() => setPlanFilter('today')}
        >
          今日及逾期{' '}
          <span>
            {
              snapshot.tasks.filter(
                (item) =>
                  item.dueDate &&
                  item.dueDate <= todayKey &&
                  item.status !== 'done' &&
                  item.status !== 'cancelled',
              ).length
            }
          </span>
        </button>
        <button
          type="button"
          className={`task-filter${planFilter === 'unplanned' ? ' is-active' : ''}`}
          onClick={() => setPlanFilter('unplanned')}
        >
          未归类{' '}
          <span>{snapshot.tasks.filter((item) => !item.planId).length}</span>
        </button>
        <div className="task-section-label">计划</div>
        <div className="task-plan-list">
          {snapshot.plans.map((plan) => (
            <button
              key={plan.id}
              type="button"
              className={`task-filter${planFilter === plan.id ? ' is-active' : ''}`}
              onClick={() => setPlanFilter(plan.id)}
            >
              <span>{plan.title}</span>
              <span>
                {
                  snapshot.tasks.filter((item) => item.planId === plan.id)
                    .length
                }
              </span>
            </button>
          ))}
          {snapshot.plans.length === 0 && (
            <div className="task-muted">还没有计划</div>
          )}
        </div>
        <form className="task-add-plan" onSubmit={addPlan}>
          <input
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

      <main className="task-main">
        <header className="task-toolbar">
          <div>
            <strong>任务工作台</strong>
            <span className="task-toolbar-count">
              {snapshot.tasks.filter((item) => item.status === 'doing').length}{' '}
              进行中 ·{' '}
              {snapshot.tasks.filter((item) => item.status === 'done').length}{' '}
              已完成
            </span>
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
                      planFilter !== 'today'
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
            <button type="button" onClick={() => setNotice('')}>
              关闭
            </button>
          </div>
        )}
        {loading ? (
          <div className="task-empty">正在加载任务…</div>
        ) : view === 'board' ? (
          <div className="task-board">
            {COLUMNS.map((column) => {
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
                  <header>
                    {column.label}
                    <span>{entries.length}</span>
                  </header>
                  <div className="task-column-items">
                    {entries.map(renderCard)}
                    {entries.length === 0 && (
                      <div className="task-column-empty">暂无任务</div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        ) : view === 'calendar' ? (
          <TaskCalendar
            tasks={filtered}
            onOpenTask={setSelectedId}
            onCreateTask={createTaskForDate}
            onMoveTask={moveTaskDate}
          />
        ) : (
          <div className="task-list">
            {filtered.length ? (
              filtered.map(renderCard)
            ) : (
              <div className="task-empty">
                还没有任务。可以新建任务或预览已有计划。
              </div>
            )}
          </div>
        )}
      </main>

      {selected && (
        <aside className="task-detail">
          <div className="task-detail-head">
            <strong>任务详情</strong>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              aria-label="关闭任务详情"
            >
              ×
            </button>
          </div>
          <div className="task-detail-body">
            <h2>{selected.title}</h2>
            <div className="task-detail-row">
              <span>状态</span>
              <select
                value={selected.status}
                onChange={(event) =>
                  void changeStatus(selected, event.target.value as TaskStatus)
                }
              >
                {Object.entries(statusName).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="task-detail-row">
              <span>计划</span>
              <span>
                {snapshot.plans.find((plan) => plan.id === selected.planId)
                  ?.title || '未归类'}
              </span>
            </div>
            {selected.dueDate && (
              <div className="task-detail-row">
                <span>截止</span>
                <span>{selected.dueDate}</span>
              </div>
            )}
            {selected.note && <p className="task-note">{selected.note}</p>}
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
                  onClick={() => void openResource(resource)}
                >
                  打开资源
                </button>
              </div>
            ))}
            <div className="task-detail-actions">
              <button
                type="button"
                onClick={() => openDraft(editTask(selected))}
              >
                编辑
              </button>
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
            if (event.target === event.currentTarget && !saving) setDraft(null);
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
                      setDraft({ ...draft, planId: event.target.value || null })
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
              <label>
                关联资源
                <select
                  value={sourceKind}
                  onChange={(event) => {
                    setSourceKind(event.target.value as typeof sourceKind);
                    setTargetUnit('');
                    setTargetValue('');
                  }}
                >
                  <option value="none">普通任务</option>
                  <option value="ebook">电子书</option>
                  <option value="youtube">YouTube 视频</option>
                </select>
              </label>
              {sourceKind === 'ebook' && (
                <>
                  <label>
                    书籍
                    <select
                      value={bookPath}
                      onChange={(event) => setBookPath(event.target.value)}
                    >
                      <option value="">选择书籍</option>
                      {bookPath &&
                        !library?.books.some(
                          (item) => item.relativePath === bookPath,
                        ) && (
                          <option value={bookPath}>未找到：{bookPath}</option>
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
                      value={chapterHref}
                      onChange={(event) => setChapterHref(event.target.value)}
                      placeholder="从阅读器创建任务时自动带入"
                    />
                  </label>
                </>
              )}
              {sourceKind === 'youtube' && (
                <div className="task-form-row">
                  <label>
                    视频链接或 ID
                    <input
                      value={videoInput}
                      onChange={(event) => setVideoInput(event.target.value)}
                    />
                  </label>
                  <label>
                    起始秒数
                    <input
                      type="number"
                      min="0"
                      value={startSeconds}
                      onChange={(event) => setStartSeconds(event.target.value)}
                    />
                  </label>
                </div>
              )}
              {sourceKind !== 'none' && (
                <div className="task-form-row">
                  <label>
                    目标单位
                    <select
                      value={targetUnit}
                      onChange={(event) =>
                        setTargetUnit(event.target.value as typeof targetUnit)
                      }
                    >
                      <option value="">无目标</option>
                      {sourceKind === 'ebook' ? (
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
                      value={targetValue}
                      onChange={(event) => setTargetValue(event.target.value)}
                      disabled={!targetUnit}
                    />
                  </label>
                  {targetUnit === 'words' && (
                    <label>
                      手动字数
                      <input
                        type="number"
                        min="0"
                        value={manualValue}
                        onChange={(event) => setManualValue(event.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}
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
                选择要导入的计划。原计划和阅读、观看记录会保留；重复导入不会重复创建任务。导入后原计划的修改不会自动同步，重复导入仅补充新节点。
              </p>
              {candidates.length === 0 && (
                <p className="task-muted">当前书库和播放器没有可导入的计划。</p>
              )}
              {candidates.map((candidate) => (
                <article className="task-import-card" key={candidate.key}>
                  <div>
                    <strong>{candidate.label}</strong>
                    <span>
                      {candidate.source} · {candidate.draft.tasks.length} 个节点
                      {candidate.missingBooks
                        ? ` · ${candidate.missingBooks} 本书需重新关联`
                        : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="task-primary"
                    disabled={Boolean(importBusy)}
                    onClick={() => void importCandidate(candidate)}
                  >
                    {importBusy === candidate.key
                      ? '导入中…'
                      : snapshot.plans.some(
                            (plan) => plan.originKey === candidate.key,
                          )
                        ? '再次核对并导入'
                        : '确认导入'}
                  </button>
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
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
