import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { habitApi, TASKS_CHANGED_EVENT } from './task-api';
import HabitStatistics from './HabitStatistics';
import type {
  Habit,
  HabitCategory,
  HabitOccurrence,
  HabitOccurrenceStatus,
  HabitSnapshot,
} from './types';
import {
  dateKey,
  localToday,
  monthGrid,
  parseDateKey,
  shiftedDateByDays,
  shiftedDateByMonth,
  weekGrid,
} from './calendar-model';
import './habit-workspace.css';

type HabitView = 'list' | 'calendar' | 'stats';
type HabitScope = 'today' | 'all' | 'inactive';
type HabitUiState = {
  date: string;
  scope: HabitScope;
  category: string;
  view: HabitView;
  query: string;
  calendarMode: 'month' | 'week';
};
type HabitDraft = {
  id: string | null;
  title: string;
  note: string;
  categoryId: string;
  repeatMode: 'daily' | 'interval';
  intervalDays: number;
  startDate: string;
  active: boolean;
};

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const EMPTY_SNAPSHOT: HabitSnapshot = {
  categories: [],
  habits: [],
  occurrences: [],
};
const HABIT_UI_KEY = 'seamind:habit-ui:v1';
type HabitCalendarMode = 'month' | 'week';

function readHabitUiState(): HabitUiState {
  const fallback: HabitUiState = {
    date: localToday(),
    scope: 'today',
    category: 'all',
    view: 'list',
    query: '',
    calendarMode: 'month',
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(HABIT_UI_KEY) ?? '{}');
    return {
      date:
        typeof saved.date === 'string' && parseDateKey(saved.date)
          ? saved.date
          : fallback.date,
      scope: ['today', 'all', 'inactive'].includes(saved.scope)
        ? (saved.scope as HabitScope)
        : fallback.scope,
      category:
        typeof saved.category === 'string' ? saved.category : fallback.category,
      view: ['list', 'calendar', 'stats'].includes(saved.view)
        ? (saved.view as HabitView)
        : fallback.view,
      query: typeof saved.query === 'string' ? saved.query : fallback.query,
      calendarMode:
        saved.calendarMode === 'week' ? ('week' as const) : ('month' as const),
    };
  } catch {
    return fallback;
  }
}

function dateOrdinal(value: string): number | null {
  const parsed = parseDateKey(value);
  if (!parsed) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
  utc.setUTCHours(0, 0, 0, 0);
  return Math.floor(utc.getTime() / 86_400_000);
}

function dateFromOrdinal(value: number): string {
  const date = new Date(value * 86_400_000);
  return dateKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function isDueOn(habit: Habit, date: string): boolean {
  const start = dateOrdinal(habit.startDate);
  const current = dateOrdinal(date);
  if (start == null || current == null || current < start) return false;
  return (current - start) % habit.intervalDays === 0;
}

function nextDueOnOrAfter(habit: Habit, date: string): string {
  const start = dateOrdinal(habit.startDate);
  const current = dateOrdinal(date);
  if (start == null || current == null || current <= start)
    return habit.startDate;
  const elapsed = current - start;
  return dateFromOrdinal(
    current +
      ((habit.intervalDays - (elapsed % habit.intervalDays)) %
        habit.intervalDays),
  );
}

function nextDueAfter(habit: Habit, date: string): string {
  const start = dateOrdinal(habit.startDate);
  const current = dateOrdinal(date);
  if (start == null || current == null || current < start)
    return habit.startDate;
  const elapsed = current - start;
  const offset = habit.intervalDays - (elapsed % habit.intervalDays);
  return dateFromOrdinal(current + offset);
}

function occurrenceKey(habitId: string, date: string) {
  return `${habitId}:${date}`;
}

function repeatLabel(intervalDays: number) {
  return intervalDays === 1 ? '每天' : `每 ${intervalDays} 天`;
}

function formatDate(value: string) {
  const parsed = parseDateKey(value);
  return parsed ? `${parsed.month}月${parsed.day}日` : value;
}

function formatCompletionTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function habitDraft(habit?: Habit): HabitDraft {
  return {
    id: habit?.id ?? null,
    title: habit?.title ?? '',
    note: habit?.note ?? '',
    categoryId: habit?.categoryId ?? '',
    repeatMode: habit && habit.intervalDays > 1 ? 'interval' : 'daily',
    intervalDays: habit?.intervalDays ?? 3,
    startDate: habit?.startDate ?? localToday(),
    active: habit?.active ?? true,
  };
}

function HabitRow({
  habit,
  categoryName,
  date,
  occurrence,
  due,
  busy,
  allowRepeat = false,
  onMark,
  onEdit,
  onSetActive,
}: {
  habit: Habit;
  categoryName: string;
  date: string;
  occurrence?: HabitOccurrence;
  due: boolean;
  busy: boolean;
  allowRepeat?: boolean;
  onMark(status: HabitOccurrenceStatus | null): void;
  onEdit(): void;
  onSetActive(active: boolean): void;
}) {
  const canMark = due && date <= localToday() && habit.active;
  const stateLabel = !habit.active
    ? '已暂停'
    : occurrence?.status === 'done'
      ? '已完成'
      : occurrence?.status === 'skipped'
        ? '已跳过'
        : due
          ? date > localToday()
            ? '未到期'
            : '待打卡'
          : `下次 ${formatDate(nextDueOnOrAfter(habit, localToday()))}`;
  const scheduleLabel = occurrence
    ? `下次 ${formatDate(nextDueAfter(habit, date))}`
    : due
      ? `到期 ${formatDate(date)}`
      : `下次 ${formatDate(nextDueOnOrAfter(habit, localToday()))}`;

  return (
    <article
      className={`habit-row${occurrence?.status === 'done' ? ' is-done' : ''}${!habit.active ? ' is-paused' : ''}`}
    >
      <span
        className={`habit-row-state${occurrence?.status ? ` is-${occurrence.status}` : due ? ' is-due' : ''}`}
      >
        {stateLabel}
      </span>
      <div className="habit-row-main">
        <div className="habit-row-title-line">
          <strong>{habit.title}</strong>
          <span className="habit-category-badge">{categoryName}</span>
        </div>
        <div className="habit-row-meta">
          <span>{repeatLabel(habit.intervalDays)}</span>
          <span>开始于 {formatDate(habit.startDate)}</span>
          <span>{scheduleLabel}</span>
          {occurrence?.status === 'done' && occurrence.completedAt != null && (
            <span>完成于 {formatCompletionTime(occurrence.completedAt)}</span>
          )}
          {habit.note && <span className="habit-row-note">{habit.note}</span>}
        </div>
      </div>
      <div className="habit-row-actions">
        {habit.active &&
          due &&
          canMark &&
          (occurrence?.status === 'done' ? (
            <>
              {allowRepeat && (
                <button
                  type="button"
                  className="task-primary"
                  disabled={busy || !canMark}
                  onClick={() => onMark('done')}
                  title="更新今天最后一次打卡时间"
                >
                  再打卡
                </button>
              )}
              <button
                type="button"
                disabled={busy || !canMark}
                onClick={() => onMark(null)}
                title="撤销本次记录"
              >
                撤销
              </button>
            </>
          ) : occurrence?.status === 'skipped' ? (
            <button
              type="button"
              disabled={busy || !canMark}
              onClick={() => onMark(null)}
            >
              恢复
            </button>
          ) : (
            <>
              <button
                type="button"
                className="task-primary"
                disabled={busy || !canMark}
                onClick={() => onMark('done')}
              >
                完成
              </button>
              <button
                type="button"
                disabled={busy || !canMark}
                onClick={() => onMark('skipped')}
              >
                跳过
              </button>
            </>
          ))}
        <button type="button" disabled={busy} onClick={onEdit}>
          编辑
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSetActive(!habit.active)}
        >
          {habit.active ? '暂停' : '启用'}
        </button>
      </div>
    </article>
  );
}

export default function HabitWorkspace({
  onShowTasks,
}: {
  onShowTasks(): void;
}) {
  const [savedUi] = useState(readHabitUiState);
  const [today, setToday] = useState(() => localToday());
  const todayRef = useRef(today);
  const reloadRef = useRef<(() => Promise<void>) | null>(null);
  const snapshotRequestRef = useRef(0);
  const initialDate = parseDateKey(savedUi.date)!;
  const [visibleMonth, setVisibleMonth] = useState({
    year: initialDate.year,
    month: initialDate.month,
  });
  const [selectedDate, setSelectedDate] = useState(savedUi.date);
  const [scope, setScope] = useState<HabitScope>(savedUi.scope);
  const [categoryFilter, setCategoryFilter] = useState(savedUi.category);
  const [view, setView] = useState<HabitView>(savedUi.view);
  const [query, setQuery] = useState(savedUi.query);
  const [calendarMode, setCalendarMode] = useState<HabitCalendarMode>(
    savedUi.calendarMode,
  );
  const [calendarPanelOpen, setCalendarPanelOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<HabitDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(() => new Set());
  const [newCategory, setNewCategory] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);

  const cells = useMemo(
    () =>
      calendarMode === 'week'
        ? weekGrid(selectedDate)
        : monthGrid(visibleMonth.year, visibleMonth.month),
    [calendarMode, selectedDate, visibleMonth],
  );
  useEffect(() => {
    try {
      sessionStorage.setItem(
        HABIT_UI_KEY,
        JSON.stringify({
          date: selectedDate,
          scope,
          category: categoryFilter,
          view,
          query,
          calendarMode,
        }),
      );
    } catch {
      // 禁用存储时仍保留当前工作台状态。
    }
  }, [selectedDate, scope, categoryFilter, view, query, calendarMode]);
  const rangeStart = cells[0]?.date ?? today;
  const rangeEnd = cells[cells.length - 1]?.date ?? today;
  const reload = useCallback(async () => {
    const requestId = ++snapshotRequestRef.current;
    try {
      const todayInRange = today >= rangeStart && today <= rangeEnd;
      const [calendarSnapshot, todaySnapshot] = await Promise.all([
        habitApi.snapshot(rangeStart, rangeEnd),
        todayInRange ? Promise.resolve(null) : habitApi.snapshot(today, today),
      ]);
      if (requestId === snapshotRequestRef.current) {
        setSnapshot(
          todaySnapshot
            ? {
                ...calendarSnapshot,
                occurrences: [
                  ...calendarSnapshot.occurrences,
                  ...todaySnapshot.occurrences,
                ],
              }
            : calendarSnapshot,
        );
        setError('');
      }
    } catch (reason) {
      if (requestId === snapshotRequestRef.current) setError(errorText(reason));
    } finally {
      if (requestId === snapshotRequestRef.current) setLoading(false);
    }
  }, [rangeEnd, rangeStart, today]);

  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    void reload();
    window.addEventListener(TASKS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, reload);
  }, [reload]);

  useEffect(() => {
    let midnightTimer = 0;
    let clockCheckTimer = 0;
    let resumeRefreshTimer = 0;

    const syncLocalDate = () => {
      const currentDate = localToday();
      const previousDate = todayRef.current;
      if (currentDate === previousDate) return false;

      // 到期状态由本地日期计算；跨日只刷新快照，保留每一天独立的打卡历史。
      todayRef.current = currentDate;
      const current = parseDateKey(currentDate);
      const previous = parseDateKey(previousDate);
      setToday(currentDate);
      setSelectedDate((selected) =>
        selected === previousDate ? currentDate : selected,
      );
      if (current && previous) {
        setVisibleMonth((month) =>
          month.year === previous.year && month.month === previous.month
            ? { year: current.year, month: current.month }
            : month,
        );
      }
      return true;
    };

    const scheduleMidnightCheck = () => {
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      );
      midnightTimer = window.setTimeout(
        () => {
          syncLocalDate();
          scheduleMidnightCheck();
        },
        Math.max(1_000, nextMidnight.getTime() - now.getTime() + 50),
      );
    };

    const refreshOnReturn = () => {
      if (document.visibilityState === 'hidden') return;
      if (syncLocalDate()) return;
      window.clearTimeout(resumeRefreshTimer);
      resumeRefreshTimer = window.setTimeout(() => {
        void reloadRef.current?.();
      }, 150);
    };

    // 午夜定时器处理正常跨日；焦点/可见性事件处理休眠恢复，轮询兜底系统时钟调整。
    scheduleMidnightCheck();
    clockCheckTimer = window.setInterval(syncLocalDate, 30_000);
    window.addEventListener('focus', refreshOnReturn);
    window.addEventListener('pageshow', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);

    return () => {
      window.clearTimeout(midnightTimer);
      window.clearInterval(clockCheckTimer);
      window.clearTimeout(resumeRefreshTimer);
      window.removeEventListener('focus', refreshOnReturn);
      window.removeEventListener('pageshow', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, []);

  const categoriesById = useMemo(
    () =>
      new Map(snapshot.categories.map((category) => [category.id, category])),
    [snapshot.categories],
  );
  const occurrencesByKey = useMemo(
    () =>
      new Map(
        snapshot.occurrences.map((item) => [
          occurrenceKey(item.habitId, item.dueDate),
          item,
        ]),
      ),
    [snapshot.occurrences],
  );
  const activeHabits = useMemo(
    () =>
      snapshot.habits.filter(
        (habit) =>
          habit.active &&
          (categoryFilter === 'all' || habit.categoryId === categoryFilter),
      ),
    [categoryFilter, snapshot.habits],
  );
  const term = query.trim().toLocaleLowerCase();
  const searchedHabits = snapshot.habits.filter(
    (habit) =>
      (categoryFilter === 'all' || habit.categoryId === categoryFilter) &&
      (!term ||
        `${habit.title} ${habit.note ?? ''}`
          .toLocaleLowerCase()
          .includes(term)),
  );
  const searchedActiveHabits = activeHabits.filter(
    (habit) =>
      !term ||
      `${habit.title} ${habit.note ?? ''}`.toLocaleLowerCase().includes(term),
  );
  const todayDue = searchedActiveHabits.filter((habit) =>
    isDueOn(habit, today),
  );
  const todayDone = todayDue.filter(
    (habit) =>
      occurrencesByKey.get(occurrenceKey(habit.id, today))?.status === 'done',
  ).length;
  const todaySkipped = todayDue.filter(
    (habit) =>
      occurrencesByKey.get(occurrenceKey(habit.id, today))?.status ===
      'skipped',
  ).length;
  const todayCompletedHabits = searchedActiveHabits.filter(
    (habit) =>
      isDueOn(habit, today) &&
      occurrencesByKey.get(occurrenceKey(habit.id, today))?.status === 'done',
  );
  const todaySkippedHabits = searchedActiveHabits.filter(
    (habit) =>
      isDueOn(habit, today) &&
      occurrencesByKey.get(occurrenceKey(habit.id, today))?.status ===
        'skipped',
  );
  // 同一习惯当天再次打卡会更新原记录的完成时间，并从待打卡列表移入今日完成区。
  const visibleHabits = searchedHabits.filter((habit) => {
    if (scope === 'today' && (!habit.active || !isDueOn(habit, today)))
      return false;
    if (scope === 'all' && !habit.active) return false;
    if (scope === 'inactive' && habit.active) return false;
    if (
      scope !== 'inactive' &&
      habit.active &&
      isDueOn(habit, today) &&
      occurrencesByKey.get(occurrenceKey(habit.id, today))?.status != null
    )
      return false;
    return true;
  });
  const calendarHabits = scope === 'inactive' ? [] : searchedActiveHabits;
  const statisticsHabitIds = searchedHabits
    .filter((habit) =>
      scope === 'inactive'
        ? !habit.active
        : habit.active && (scope !== 'today' || isDueOn(habit, today)),
    )
    .map((habit) => habit.id);
  const selectedDateHabits = calendarHabits.filter((habit) =>
    isDueOn(habit, selectedDate),
  );

  const chooseDate = (date: string) => {
    const parsed = parseDateKey(date);
    if (!parsed) return;
    setSelectedDate(date);
    setVisibleMonth({ year: parsed.year, month: parsed.month });
  };

  const movePeriod = (delta: number) => {
    chooseDate(
      calendarMode === 'week'
        ? shiftedDateByDays(selectedDate, delta * 7)
        : shiftedDateByMonth(selectedDate, delta),
    );
  };

  const saveDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    try {
      await habitApi.save({
        id: draft.id,
        title: draft.title,
        note: draft.note || null,
        categoryId: draft.categoryId || null,
        intervalDays: draft.repeatMode === 'daily' ? 1 : draft.intervalDays,
        startDate: draft.startDate,
        active: draft.active,
      });
      setDraft(null);
      setNotice(draft.id ? '习惯已更新。' : '习惯已创建。');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };

  const markOccurrence = async (
    habit: Habit,
    dueDate: string,
    status: HabitOccurrenceStatus | null,
  ) => {
    const key = occurrenceKey(habit.id, dueDate);
    if (savingKeys.has(key)) return;
    setSavingKeys((current) => new Set(current).add(key));
    try {
      await habitApi.setOccurrence({ habitId: habit.id, dueDate, status });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSavingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const setHabitActive = async (habit: Habit, active: boolean) => {
    try {
      await habitApi.setActive(habit.id, active);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const createCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newCategory.trim() || savingCategory) return;
    setSavingCategory(true);
    try {
      const category = await habitApi.saveCategory({ name: newCategory });
      setNewCategory('');
      setCategoryFilter(category.id);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSavingCategory(false);
    }
  };

  const deleteCategory = async (category: HabitCategory) => {
    if (category.isBuiltin) return;
    if (!window.confirm(`删除“${category.name}”分类？习惯会保留在未分类中。`))
      return;
    try {
      await habitApi.deleteCategory(category.id);
      if (categoryFilter === category.id) setCategoryFilter('all');
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const renderHabitRow = (
    habit: Habit,
    date: string,
    due: boolean,
    allowRepeat = false,
  ) => {
    const occurrence = occurrencesByKey.get(occurrenceKey(habit.id, date));
    const key = occurrenceKey(habit.id, date);
    return (
      <HabitRow
        key={`${habit.id}:${date}`}
        habit={habit}
        categoryName={
          (habit.categoryId && categoriesById.get(habit.categoryId)?.name) ||
          '未分类'
        }
        date={date}
        occurrence={occurrence}
        due={due}
        busy={savingKeys.has(key)}
        allowRepeat={allowRepeat}
        onMark={(status) => void markOccurrence(habit, date, status)}
        onEdit={() => setDraft(habitDraft(habit))}
        onSetActive={(active) => void setHabitActive(habit, active)}
      />
    );
  };

  return (
    <div className="task-workspace habit-workspace">
      <aside className="task-sidebar habit-sidebar" aria-label="习惯导航">
        <header className="task-sidebar-heading">
          <div className="task-sidebar-title">习惯管理</div>
        </header>
        <button
          type="button"
          className={`task-filter${scope === 'today' ? ' is-active' : ''}`}
          onClick={() => setScope('today')}
        >
          今日到期 <span>{todayDue.length}</span>
        </button>
        <button
          type="button"
          className={`task-filter${scope === 'all' ? ' is-active' : ''}`}
          onClick={() => setScope('all')}
        >
          全部习惯 <span>{searchedActiveHabits.length}</span>
        </button>
        <button
          type="button"
          className={`task-filter${scope === 'inactive' ? ' is-active' : ''}`}
          onClick={() => setScope('inactive')}
        >
          已暂停{' '}
          <span>{searchedHabits.filter((habit) => !habit.active).length}</span>
        </button>
        <div className="habit-category-heading">
          <span className="task-section-label">分类</span>
          <button
            type="button"
            className="habit-category-reset"
            disabled={categoryFilter === 'all'}
            onClick={() => setCategoryFilter('all')}
          >
            全部分类
          </button>
        </div>
        <div className="task-plan-list habit-category-list">
          {snapshot.categories.map((category) => {
            const count = snapshot.habits.filter(
              (habit) =>
                habit.categoryId === category.id &&
                (scope === 'inactive'
                  ? !habit.active
                  : habit.active &&
                    (scope !== 'today' || isDueOn(habit, today))) &&
                (!term ||
                  `${habit.title} ${habit.note ?? ''}`
                    .toLocaleLowerCase()
                    .includes(term)),
            ).length;
            return (
              <div className="habit-category-row" key={category.id}>
                <button
                  type="button"
                  className={`task-filter${categoryFilter === category.id ? ' is-active' : ''}`}
                  onClick={() => setCategoryFilter(category.id)}
                >
                  <span className="habit-category-name">
                    <span className="habit-category-mark" />
                    {category.name}
                  </span>
                  <span>{count}</span>
                </button>
                {!category.isBuiltin && (
                  <button
                    type="button"
                    className="habit-category-delete"
                    title={`删除${category.name}分类`}
                    aria-label={`删除${category.name}分类`}
                    onClick={() => void deleteCategory(category)}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <form className="habit-category-create" onSubmit={createCategory}>
          <input
            aria-label="新分类名称"
            maxLength={32}
            placeholder="新分类名称"
            value={newCategory}
            onChange={(event) => setNewCategory(event.target.value)}
          />
          <button
            type="submit"
            disabled={savingCategory || !newCategory.trim()}
          >
            添加
          </button>
        </form>
      </aside>

      <main className="task-main habit-main">
        <header className="task-toolbar">
          <div className="task-toolbar-heading">
            <div
              className="task-workspace-switch"
              role="group"
              aria-label="工作台"
            >
              <button type="button" aria-pressed="false" onClick={onShowTasks}>
                任务
              </button>
              <button type="button" className="is-active" aria-pressed="true">
                习惯
              </button>
            </div>
            <span className="task-toolbar-count">
              今日完成 {todayDone} / {todayDue.length}
            </span>
          </div>
          <div className="task-toolbar-actions">
            <input
              aria-label="搜索习惯"
              placeholder="搜索习惯"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              type="button"
              className={view === 'list' ? 'is-active' : ''}
              onClick={() => setView('list')}
            >
              清单
            </button>
            <button
              type="button"
              className={view === 'calendar' ? 'is-active' : ''}
              onClick={() => setView('calendar')}
            >
              日历
            </button>
            <button
              type="button"
              className={view === 'stats' ? 'is-active' : ''}
              onClick={() => setView('stats')}
            >
              统计
            </button>
            <button
              type="button"
              className="task-primary"
              onClick={() => setDraft(habitDraft())}
            >
              新建习惯
            </button>
          </div>
        </header>

        <div className="habit-summary" aria-label="今日习惯进度">
          <span>
            今日到期 <strong>{todayDue.length}</strong>
          </span>
          <span>
            已完成 <strong>{todayDone}</strong>
          </span>
          <span>
            已跳过 <strong>{todaySkipped}</strong>
          </span>
          <span>
            待处理{' '}
            <strong>
              {Math.max(0, todayDue.length - todayDone - todaySkipped)}
            </strong>
          </span>
          <span className="habit-summary-date">按本机日历日期统计</span>
        </div>

        {error && (
          <div className="task-message is-error" role="alert">
            {error}
            <button type="button" onClick={() => setError('')}>
              关闭
            </button>
          </div>
        )}
        {notice && (
          <div className="task-message" role="status">
            {notice}
            <button type="button" onClick={() => setNotice('')}>
              关闭
            </button>
          </div>
        )}

        {loading ? (
          <div className="task-empty">正在加载习惯…</div>
        ) : view === 'stats' ? (
          <HabitStatistics
            today={today}
            categoryFilter={categoryFilter}
            habitIds={statisticsHabitIds}
            scopeLabel={
              scope === 'today'
                ? '今日到期'
                : scope === 'inactive'
                  ? '已暂停'
                  : '全部活跃'
            }
            onSelectDate={(date) => {
              chooseDate(date);
              setView('calendar');
            }}
          />
        ) : view === 'calendar' ? (
          <section
            className={`task-calendar habit-calendar${calendarMode === 'week' ? ' is-week' : ''}${calendarPanelOpen ? ' is-panel-open' : ''}`}
          >
            <div className="task-calendar-topbar">
              <div className="task-calendar-nav">
                <button
                  type="button"
                  onClick={() => movePeriod(-1)}
                  aria-label={calendarMode === 'week' ? '上周' : '上个月'}
                >
                  ‹
                </button>
                <strong>
                  {calendarMode === 'week'
                    ? `${cells[0]?.date} — ${cells[6]?.date}`
                    : `${visibleMonth.year} 年 ${visibleMonth.month} 月`}
                </strong>
                <button
                  type="button"
                  onClick={() => movePeriod(1)}
                  aria-label={calendarMode === 'week' ? '下周' : '下个月'}
                >
                  ›
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const current = parseDateKey(today)!;
                    setVisibleMonth({
                      year: current.year,
                      month: current.month,
                    });
                    setSelectedDate(today);
                  }}
                >
                  今天
                </button>
              </div>
              <div className="task-calendar-view-actions">
                <div
                  className="task-calendar-view-switch"
                  role="group"
                  aria-label="习惯日历范围"
                >
                  <button
                    type="button"
                    className={calendarMode === 'week' ? 'is-active' : ''}
                    aria-pressed={calendarMode === 'week'}
                    onClick={() => setCalendarMode('week')}
                  >
                    周
                  </button>
                  <button
                    type="button"
                    className={calendarMode === 'month' ? 'is-active' : ''}
                    aria-pressed={calendarMode === 'month'}
                    onClick={() => setCalendarMode('month')}
                  >
                    月
                  </button>
                </div>
                <button
                  type="button"
                  className="task-calendar-panel-toggle"
                  aria-expanded={calendarPanelOpen}
                  onClick={() => setCalendarPanelOpen((open) => !open)}
                >
                  {calendarPanelOpen ? '关闭日程' : '查看当日'}
                </button>
              </div>
            </div>
            <div className="task-calendar-content">
              <div className="task-calendar-grid-wrap">
                <div
                  className="task-calendar-grid"
                  role="region"
                  aria-label="习惯日历"
                  style={{
                    gridTemplateRows: `28px repeat(${cells.length / 7}, minmax(76px, 1fr))`,
                  }}
                >
                  {WEEKDAYS.map((day) => (
                    <div className="task-calendar-weekday" key={day}>
                      {day}
                    </div>
                  ))}
                  {cells.map((cell) => {
                    const entries = calendarHabits.filter((habit) =>
                      isDueOn(habit, cell.date),
                    );
                    return (
                      <div
                        className={`task-calendar-day${cell.inMonth ? '' : ' is-outside'}${cell.date === today ? ' is-today' : ''}${cell.date === selectedDate ? ' is-selected' : ''}`}
                        role="group"
                        aria-label={`${cell.date}，${entries.length} 项习惯`}
                        key={cell.date}
                        onClick={(event) => {
                          if (
                            !(event.target instanceof HTMLElement) ||
                            !event.target.closest('button')
                          )
                            chooseDate(cell.date);
                        }}
                      >
                        <div className="task-calendar-day-head">
                          <button
                            type="button"
                            className="task-calendar-day-number"
                            onClick={() => chooseDate(cell.date)}
                            aria-label={`选择 ${cell.date}`}
                            aria-pressed={cell.date === selectedDate}
                            aria-current={
                              cell.date === today ? 'date' : undefined
                            }
                            data-habit-date={cell.date}
                            onKeyDown={(event) => {
                              const offset = {
                                ArrowLeft: -1,
                                ArrowRight: 1,
                                ArrowUp: -7,
                                ArrowDown: 7,
                              }[
                                event.key as
                                  | 'ArrowLeft'
                                  | 'ArrowRight'
                                  | 'ArrowUp'
                                  | 'ArrowDown'
                              ];
                              if (offset == null) return;
                              event.preventDefault();
                              const next = shiftedDateByDays(cell.date, offset);
                              chooseDate(next);
                              requestAnimationFrame(() =>
                                document
                                  .querySelector<HTMLButtonElement>(
                                    `[data-habit-date="${next}"]`,
                                  )
                                  ?.focus(),
                              );
                            }}
                          >
                            {cell.day}
                          </button>
                          {entries.length > 0 && (
                            <span className="habit-day-count">
                              {entries.length}
                            </span>
                          )}
                        </div>
                        <div className="task-calendar-day-items">
                          {entries.slice(0, 3).map((habit) => {
                            const occurrence = occurrencesByKey.get(
                              occurrenceKey(habit.id, cell.date),
                            );
                            return (
                              <button
                                type="button"
                                className={`habit-calendar-marker${occurrence ? ` is-${occurrence.status}` : ''}`}
                                title={`${habit.title} · ${occurrence?.status === 'done' ? '已完成' : occurrence?.status === 'skipped' ? '已跳过' : '待打卡'}`}
                                key={habit.id}
                                onClick={() => chooseDate(cell.date)}
                              >
                                <span>{habit.title}</span>
                              </button>
                            );
                          })}
                          {entries.length > 3 && (
                            <span className="task-calendar-more">
                              另有 {entries.length - 3} 项
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <aside className="task-calendar-agenda habit-agenda">
                <div className="task-calendar-agenda-head">
                  <strong>
                    {selectedDate === today ? '今天' : formatDate(selectedDate)}
                  </strong>
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(event) => chooseDate(event.target.value)}
                    aria-label="选择日期"
                  />
                </div>
                <div className="task-calendar-agenda-list">
                  {selectedDateHabits.length ? (
                    selectedDateHabits.map((habit) =>
                      renderHabitRow(habit, selectedDate, true),
                    )
                  ) : (
                    <div className="task-muted">
                      {scope === 'inactive'
                        ? '已暂停习惯不生成日程；可在清单中管理。'
                        : '这一天没有到期习惯。'}
                    </div>
                  )}
                </div>
              </aside>
            </div>
          </section>
        ) : (
          <section className="habit-list-view">
            <div className="habit-list-toolbar">
              <div className="habit-list-date">
                <strong>
                  {scope === 'today'
                    ? '今日清单'
                    : scope === 'inactive'
                      ? '已暂停习惯'
                      : '全部习惯'}
                </strong>
                <span>
                  {categoryFilter === 'all'
                    ? '全部分类'
                    : (categoriesById.get(categoryFilter)?.name ??
                      '所选分类')}{' '}
                  · {today}
                </span>
              </div>
            </div>
            {scope !== 'inactive' && (
              <section
                className="habit-today-completed"
                aria-label="今日完成的习惯"
              >
                <header>
                  <strong>今日完成</strong>
                  <span>{todayCompletedHabits.length}</span>
                </header>
                {todayCompletedHabits.length ? (
                  <div className="habit-today-completed-list">
                    {todayCompletedHabits.map((habit) =>
                      renderHabitRow(habit, today, true, true),
                    )}
                  </div>
                ) : (
                  <div className="habit-today-completed-empty">
                    今天完成的习惯会移到这里；再次打卡会更新今天最后一次完成时间。
                  </div>
                )}
              </section>
            )}
            <div className="habit-list">
              {visibleHabits.length ? (
                visibleHabits.map((habit) =>
                  renderHabitRow(habit, today, isDueOn(habit, today)),
                )
              ) : (
                <div className="task-empty">
                  {scope === 'today'
                    ? '今天没有待处理的习惯。'
                    : scope === 'inactive'
                      ? '当前筛选下没有已暂停习惯。'
                      : '当前筛选下没有待处理习惯。'}
                </div>
              )}
            </div>
            {scope !== 'inactive' && todaySkippedHabits.length > 0 && (
              <section
                className="habit-today-skipped"
                aria-label="今日跳过的习惯"
              >
                <header>
                  <strong>今日跳过</strong>
                  <span>{todaySkippedHabits.length}</span>
                </header>
                <div className="habit-today-skipped-list">
                  {todaySkippedHabits.map((habit) =>
                    renderHabitRow(habit, today, true),
                  )}
                </div>
              </section>
            )}
          </section>
        )}
      </main>

      {draft && (
        <div
          className="task-modal-backdrop habit-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) setDraft(null);
          }}
        >
          <form
            className="task-modal habit-modal"
            onSubmit={(event) => void saveDraft(event)}
            role="dialog"
            aria-modal="true"
            aria-label={draft.id ? '编辑习惯' : '新建习惯'}
          >
            <header>
              <strong>{draft.id ? '编辑习惯' : '新建习惯'}</strong>
              <button
                type="button"
                disabled={saving}
                onClick={() => setDraft(null)}
              >
                关闭
              </button>
            </header>
            <div className="task-modal-body">
              <label>
                名称
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={draft.title}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                />
              </label>
              <div className="task-form-row">
                <label>
                  分类
                  <select
                    value={draft.categoryId}
                    onChange={(event) =>
                      setDraft({ ...draft, categoryId: event.target.value })
                    }
                  >
                    <option value="">未分类</option>
                    {snapshot.categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  开始日期
                  <input
                    type="date"
                    required
                    value={draft.startDate}
                    onChange={(event) =>
                      setDraft({ ...draft, startDate: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="task-form-row habit-repeat-row">
                <label>
                  重复周期
                  <select
                    value={draft.repeatMode}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        repeatMode: event.target
                          .value as HabitDraft['repeatMode'],
                      })
                    }
                  >
                    <option value="daily">每天</option>
                    <option value="interval">每隔几天</option>
                  </select>
                </label>
                {draft.repeatMode === 'interval' && (
                  <label>
                    间隔天数
                    <input
                      type="number"
                      min="2"
                      max="365"
                      required
                      value={draft.intervalDays}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          intervalDays: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                )}
              </div>
              <label>
                备注
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={draft.note}
                  onChange={(event) =>
                    setDraft({ ...draft, note: event.target.value })
                  }
                />
              </label>
            </div>
            <footer>
              <button
                type="button"
                disabled={saving}
                onClick={() => setDraft(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="task-primary"
                disabled={saving || !draft.title.trim() || !draft.startDate}
              >
                {saving ? '保存中…' : '保存习惯'}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}
