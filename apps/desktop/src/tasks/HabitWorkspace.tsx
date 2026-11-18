import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import { habitApi, TASKS_CHANGED_EVENT } from './task-api';
import HabitStatistics from './HabitStatistics';
import {
  compareHabitsByCategory,
  countPendingDueHabits,
  formatBadgeCount,
  habitCategoryColor,
  isHabitDueOn,
  nextCheckStatus,
  nextHabitDueOnOrAfter,
  normalizeHabitScope,
} from './habit-list-model';
import { useConfirmDialog } from './ConfirmDialog';
import {
  RailFolderIcon,
  RailListIcon,
  RailPlusIcon,
  RailSunIcon,
  SidebarCollapseButton,
  useSidebarCollapseShortcut,
  WorkspaceSidebarRail,
} from '../components/WorkspaceSidebarRail';
import type {
  Habit,
  HabitCategory,
  HabitOccurrence,
  HabitOccurrenceStatus,
  HabitSnapshot,
} from './types';
import {
  computeCalendarCellVisibleCount,
  localToday,
  formatCalendarPeriod,
  monthGrid,
  parseDateKey,
  shiftedDateByDays,
  shiftedDateByMonth,
  weekGrid,
} from './calendar-model';
import { useCalendarRowHeight } from './useCalendarRowHeight';
import './habit-workspace.css';

type HabitView = 'list' | 'calendar' | 'stats';
type HabitScope = 'today' | 'library';
type HabitUiState = {
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
const HABIT_SIDEBAR_COLLAPSED_KEY = 'seamind:habit-sidebar-collapsed:v1';
type HabitCalendarMode = 'month' | 'week';

function readHabitSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(HABIT_SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHabitSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(HABIT_SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage may be unavailable.
  }
}

function readHabitUiState(): HabitUiState {
  const fallback: HabitUiState = {
    scope: 'today',
    category: 'all',
    view: 'list',
    query: '',
    calendarMode: 'month',
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(HABIT_UI_KEY) ?? '{}');
    return {
      scope: normalizeHabitScope(saved.scope),
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

function formatAgendaHeading(date: string): string {
  const parsed = parseDateKey(date);
  if (!parsed) return date;
  const weekday =
    WEEKDAYS[
      (new Date(
        Date.UTC(parsed.year, parsed.month - 1, parsed.day),
      ).getUTCDay() +
        6) %
        7
    ];
  return `${parsed.month}月${parsed.day}日 · ${weekday ?? ''}`;
}

function formatCompletionTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function habitDraft(habit?: Habit, defaultStartDate?: string): HabitDraft {
  return {
    id: habit?.id ?? null,
    title: habit?.title ?? '',
    note: habit?.note ?? '',
    categoryId: habit?.categoryId ?? '',
    repeatMode: habit && habit.intervalDays > 1 ? 'interval' : 'daily',
    intervalDays: habit?.intervalDays ?? 3,
    startDate: habit?.startDate ?? defaultStartDate ?? localToday(),
    active: habit?.active ?? true,
  };
}

function HabitRowMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
  });

  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!rect || !panel) return;
    const width = 148;
    const height = panel.offsetHeight;
    const left = Math.max(
      8,
      Math.min(rect.right - width, window.innerWidth - width - 8),
    );
    const openUp =
      window.innerHeight - rect.bottom < height + 8 && rect.top > height + 8;
    setStyle({
      position: 'fixed',
      left,
      top: openUp ? rect.top - height - 4 : rect.bottom + 4,
      width,
      zIndex: 40,
      visibility: 'visible',
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="habit-row-menu">
      <button
        ref={buttonRef}
        type="button"
        className="habit-row-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={panelRef}
          className="habit-row-menu-panel"
          role="menu"
          style={style}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('button')) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function HabitCheckRow({
  habit,
  categoryName,
  categoryColor,
  occurrence,
  canMark,
  busy,
  targeted,
  onMark,
  onEdit,
  onSetActive,
  onDelete,
}: {
  habit: Habit;
  categoryName: string;
  categoryColor: string | null;
  occurrence?: HabitOccurrence;
  canMark: boolean;
  busy: boolean;
  targeted: boolean;
  onMark(status: HabitOccurrenceStatus | null): void;
  onEdit(): void;
  onSetActive(active: boolean): void;
  onDelete(): void;
}) {
  const status = occurrence?.status;
  const meta =
    canMark && status === 'done' && occurrence?.completedAt != null
      ? formatCompletionTime(occurrence.completedAt)
      : !canMark && status === 'done'
        ? `已完成${occurrence?.completedAt != null ? ` ${formatCompletionTime(occurrence.completedAt)}` : ''}`
        : !canMark && status === 'skipped'
          ? '已跳过'
          : !habit.active
            ? `已暂停 · ${repeatLabel(habit.intervalDays)}`
            : repeatLabel(habit.intervalDays);
  const checkLabel =
    status === 'done'
      ? `撤销${habit.title}`
      : status === 'skipped'
        ? `完成${habit.title}`
        : `完成${habit.title}`;

  return (
    <article
      className={`habit-check-row${status === 'done' ? ' is-done' : ''}${status === 'skipped' ? ' is-skipped' : ''}${targeted ? ' is-targeted' : ''}${canMark ? '' : ' is-readonly'}`}
      data-habit-agenda={habit.id}
    >
      {canMark && (
        <button
          type="button"
          className={`habit-check${status ? ` is-${status}` : ''}`}
          aria-pressed={status === 'done'}
          aria-label={checkLabel}
          disabled={busy}
          onClick={() => onMark(nextCheckStatus(status))}
        >
          {status === 'done' ? '✓' : status === 'skipped' ? '—' : ''}
        </button>
      )}
      <div className="habit-row-main">
        <div className="habit-row-title-line">
          <strong>{habit.title}</strong>
          <span
            className="habit-category-badge"
            style={
              categoryColor
                ? { borderColor: categoryColor, color: categoryColor }
                : undefined
            }
          >
            {categoryName}
          </span>
        </div>
        {habit.note && (
          <p className="habit-row-note" title={habit.note}>
            {habit.note}
          </p>
        )}
        <div className="habit-row-meta">
          <span>{meta}</span>
        </div>
      </div>
      {canMark && (
        <HabitRowMenu label={`${habit.title}的更多操作`}>
          {status !== 'skipped' && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => onMark('skipped')}
            >
              跳过
            </button>
          )}
          {status != null && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => onMark(null)}
            >
              撤销
            </button>
          )}
          {status === 'done' && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => onMark('done')}
            >
              更新完成时间
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={onEdit}
          >
            编辑
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => onSetActive(false)}
          >
            暂停
          </button>
          <button
            type="button"
            role="menuitem"
            className="habit-row-menu-danger"
            disabled={busy}
            onClick={onDelete}
          >
            删除
          </button>
        </HabitRowMenu>
      )}
    </article>
  );
}

function HabitDefinitionRow({
  habit,
  categoryName,
  categoryColor,
  nextDue,
  busy,
  onEdit,
  onSetActive,
  onDelete,
}: {
  habit: Habit;
  categoryName: string;
  categoryColor: string | null;
  nextDue: string;
  busy: boolean;
  onEdit(): void;
  onSetActive(active: boolean): void;
  onDelete(): void;
}) {
  return (
    <article
      className={`habit-definition-row${!habit.active ? ' is-paused' : ''}`}
    >
      <button type="button" className="habit-definition-open" onClick={onEdit}>
        <span className="habit-row-title-line">
          <strong>{habit.title}</strong>
          <span
            className="habit-category-badge"
            style={
              categoryColor
                ? { borderColor: categoryColor, color: categoryColor }
                : undefined
            }
          >
            {categoryName}
          </span>
        </span>
        {habit.note && (
          <span className="habit-row-note" title={habit.note}>
            {habit.note}
          </span>
        )}
        <span className="habit-row-meta">
          <span>{repeatLabel(habit.intervalDays)}</span>
          <span>下次 {formatDate(nextDue)}</span>
        </span>
      </button>
      <div className="habit-definition-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSetActive(!habit.active)}
        >
          {habit.active ? '暂停' : '启用'}
        </button>
        <button
          type="button"
          className="habit-definition-delete"
          disabled={busy}
          onClick={onDelete}
        >
          删除
        </button>
      </div>
    </article>
  );
}

export default function HabitWorkspace({
  onShowTasks,
  active = true,
}: {
  onShowTasks(): void;
  active?: boolean;
}) {
  const [savedUi] = useState(readHabitUiState);
  const [today, setToday] = useState(() => localToday());
  const todayRef = useRef(today);
  const reloadRef = useRef<(() => Promise<void>) | null>(null);
  const snapshotRequestRef = useRef(0);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const parsed = parseDateKey(today);
    const now = new Date();
    return parsed
      ? { year: parsed.year, month: parsed.month }
      : { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [selectedDate, setSelectedDate] = useState(today);
  const [scope, setScope] = useState<HabitScope>(savedUi.scope);
  const [categoryFilter, setCategoryFilter] = useState(savedUi.category);
  const [view, setView] = useState<HabitView>(savedUi.view);
  const [query, setQuery] = useState(savedUi.query);
  const [calendarMode, setCalendarMode] = useState<HabitCalendarMode>(
    savedUi.calendarMode,
  );
  const [calendarPanelOpen, setCalendarPanelOpen] = useState(false);
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const [agendaFocusId, setAgendaFocusId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<HabitDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(() => new Set());
  const [newCategory, setNewCategory] = useState('');
  const [savingCategory, setSavingCategory] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    readHabitSidebarCollapsed,
  );
  const { askConfirm, confirmDialog } = useConfirmDialog();
  const openDraftModal = useCallback((nextDraft: HabitDraft) => {
    setDraftError('');
    setDraft(nextDraft);
  }, []);
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeHabitSidebarCollapsed(next);
      return next;
    });
  }, []);

  useSidebarCollapseShortcut(toggleSidebarCollapsed, active);

  const cells = useMemo(
    () =>
      calendarMode === 'week'
        ? weekGrid(selectedDate)
        : monthGrid(visibleMonth.year, visibleMonth.month),
    [calendarMode, selectedDate, visibleMonth],
  );
  const calendarGridRef = useRef<HTMLDivElement | null>(null);
  const calendarRowHeight = useCalendarRowHeight(
    calendarGridRef,
    cells.length / 7,
    !loading && view === 'calendar' && !focusedDate,
  );
  useEffect(() => {
    try {
      sessionStorage.setItem(
        HABIT_UI_KEY,
        JSON.stringify({
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
  }, [scope, categoryFilter, view, query, calendarMode]);
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
    isHabitDueOn(habit, today),
  );
  const todayDone = todayDue.filter(
    (habit) =>
      occurrencesByKey.get(occurrenceKey(habit.id, today))?.status === 'done',
  ).length;
  const todayPendingCount = useMemo(
    () => countPendingDueHabits(snapshot, today),
    [snapshot, today],
  );
  const sortHabits = useCallback(
    (habits: Habit[]) =>
      [...habits].sort((left, right) =>
        compareHabitsByCategory(snapshot.categories, left, right),
      ),
    [snapshot.categories],
  );
  const todayHabits = sortHabits(todayDue);
  const libraryActive = sortHabits(
    searchedHabits.filter((habit) => habit.active),
  );
  const libraryPaused = sortHabits(
    searchedHabits.filter((habit) => !habit.active),
  );
  const calendarHabits = searchedHabits;
  const hasHabitEntryOn = useCallback(
    (habit: Habit, date: string) =>
      (habit.active && isHabitDueOn(habit, date)) ||
      occurrencesByKey.has(occurrenceKey(habit.id, date)),
    [occurrencesByKey],
  );
  const statisticsHabitIds = searchedHabits.map((habit) => habit.id);
  const selectedDateHabits = sortHabits(
    calendarHabits.filter((habit) => hasHabitEntryOn(habit, selectedDate)),
  );
  const focusedHabits = sortHabits(
    focusedDate
      ? calendarHabits.filter((habit) => hasHabitEntryOn(habit, focusedDate))
      : [],
  );

  const chooseDate = (date: string) => {
    const parsed = parseDateKey(date);
    if (!parsed) return;
    setSelectedDate(date);
    setVisibleMonth({ year: parsed.year, month: parsed.month });
    setAgendaFocusId(null);
  };
  const openDay = (date: string) => {
    if (!parseDateKey(date)) return;
    chooseDate(date);
    setFocusedDate(date);
  };
  const stepFocusedDay = (delta: number) => {
    if (!focusedDate) return;
    const next = shiftedDateByDays(focusedDate, delta);
    if (!parseDateKey(next)) return;
    chooseDate(next);
    setFocusedDate(next);
  };
  const closeDay = () => {
    if (focusedDate) chooseDate(focusedDate);
    setFocusedDate(null);
  };
  useEffect(() => {
    if (!focusedDate) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, select')
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      chooseDate(focusedDate);
      setFocusedDate(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedDate]);

  const showAgenda = (date: string, habitId: string | null) => {
    const parsed = parseDateKey(date);
    if (!parsed) return;
    setSelectedDate(date);
    setVisibleMonth({ year: parsed.year, month: parsed.month });
    setAgendaFocusId(habitId);
    setCalendarPanelOpen(true);
  };

  useEffect(() => {
    if (!agendaFocusId || view !== 'calendar') return;
    document
      .querySelector<HTMLElement>(
        `[data-habit-agenda="${CSS.escape(agendaFocusId)}"]`,
      )
      ?.scrollIntoView({ block: 'nearest' });
  }, [agendaFocusId, selectedDate, view, calendarPanelOpen, focusedDate]);

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
    setDraftError('');
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
      setDraftError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };

  const deleteHabit = async (habit: { id: string; title: string }) => {
    const confirmed = await askConfirm({
      title: '删除习惯',
      message: `删除习惯「${habit.title}」？该习惯的所有历史打卡记录也将一并移除，且无法恢复。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await habitApi.delete(habit.id);
      setDraft((current) => (current?.id === habit.id ? null : current));
      setNotice(`已删除习惯「${habit.title}」。`);
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
    const confirmed = await askConfirm({
      title: '删除分类',
      message: `删除“${category.name}”分类？原有习惯会保留在未分类中。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await habitApi.deleteCategory(category.id);
      if (categoryFilter === category.id) setCategoryFilter('all');
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const categoryNameOf = (habit: Habit) =>
    (habit.categoryId && categoriesById.get(habit.categoryId)?.name) ||
    '未分类';

  const renderCheckRow = (habit: Habit, date: string) => {
    const key = occurrenceKey(habit.id, date);
    return (
      <HabitCheckRow
        key={key}
        habit={habit}
        categoryName={categoryNameOf(habit)}
        categoryColor={habitCategoryColor(
          habit.categoryId,
          snapshot.categories,
        )}
        occurrence={occurrencesByKey.get(key)}
        canMark={date <= today && habit.active}
        busy={savingKeys.has(key)}
        targeted={agendaFocusId === habit.id && date === selectedDate}
        onMark={(status) => void markOccurrence(habit, date, status)}
        onEdit={() => openDraftModal(habitDraft(habit))}
        onSetActive={(active) => void setHabitActive(habit, active)}
        onDelete={() => void deleteHabit(habit)}
      />
    );
  };

  const renderDefinitionRow = (habit: Habit) => (
    <HabitDefinitionRow
      key={habit.id}
      habit={habit}
      categoryName={categoryNameOf(habit)}
      categoryColor={habitCategoryColor(habit.categoryId, snapshot.categories)}
      nextDue={nextHabitDueOnOrAfter(habit, today)}
      busy={saving}
      onEdit={() => openDraftModal(habitDraft(habit))}
      onSetActive={(active) => void setHabitActive(habit, active)}
      onDelete={() => void deleteHabit(habit)}
    />
  );

  return (
    <div className="task-workspace habit-workspace">
      {sidebarCollapsed ? (
        <aside
          className="task-sidebar habit-sidebar is-collapsed"
          id="habit-sidebar"
          aria-label="习惯导航"
        >
          <WorkspaceSidebarRail
            ariaLabel="已收起的习惯导航"
            expandTitle="展开习惯侧栏 (快捷键 Ctrl+B)"
            expandAriaLabel="展开习惯侧栏"
            ariaControls="habit-sidebar"
            headerHeight={48}
            onExpand={toggleSidebarCollapsed}
            sections={[
              {
                key: 'scope',
                items: [
                  {
                    key: 'today',
                    label: `今天 (${todayDue.length})`,
                    active: scope === 'today',
                    icon: <RailSunIcon />,
                    dot: todayPendingCount > 0,
                    onClick: () => setScope('today'),
                  },
                  {
                    key: 'library',
                    label: `全部 (${searchedHabits.length})`,
                    active: scope === 'library',
                    icon: <RailListIcon />,
                    onClick: () => setScope('library'),
                  },
                ],
              },
              {
                key: 'categories',
                items: [
                  {
                    key: 'cat-all',
                    label: '全部分类',
                    active: categoryFilter === 'all',
                    icon: <RailFolderIcon />,
                    onClick: () => setCategoryFilter('all'),
                  },
                  ...snapshot.categories.map((category) => {
                    const count = snapshot.habits.filter(
                      (habit) =>
                        habit.categoryId === category.id &&
                        (scope === 'today'
                          ? habit.active && isHabitDueOn(habit, today)
                          : true) &&
                        (!term ||
                          `${habit.title} ${habit.note ?? ''}`
                            .toLocaleLowerCase()
                            .includes(term)),
                    ).length;
                    return {
                      key: `cat:${category.id}`,
                      label: `${category.name} (${count})`,
                      active: categoryFilter === category.id,
                      thumb: {
                        name: category.name,
                        shape: 'square' as const,
                        tone: 'index' as const,
                      },
                      onClick: () => setCategoryFilter(category.id),
                    };
                  }),
                ],
              },
            ]}
            footerItems={[
              {
                key: 'new-habit',
                label: '新建习惯',
                icon: <RailPlusIcon />,
                onClick: () => openDraftModal(habitDraft()),
              },
            ]}
          />
        </aside>
      ) : (
        <aside
          className="task-sidebar habit-sidebar"
          id="habit-sidebar"
          aria-label="习惯导航"
        >
          <header className="task-sidebar-heading">
            <div className="task-sidebar-title">习惯</div>
            <SidebarCollapseButton
              collapsed={false}
              title="收起习惯侧栏 (快捷键 Ctrl+B)"
              ariaLabel="收起习惯侧栏"
              ariaControls="habit-sidebar"
              className="task-sidebar-toggle"
              onClick={toggleSidebarCollapsed}
            />
          </header>
          <button
            type="button"
            className={`task-filter${scope === 'today' ? ' is-active' : ''}`}
            onClick={() => setScope('today')}
          >
            今天 <span>{todayDue.length}</span>
          </button>
          <button
            type="button"
            className={`task-filter${scope === 'library' ? ' is-active' : ''}`}
            onClick={() => setScope('library')}
          >
            全部 <span>{searchedHabits.length}</span>
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
              const categoryColor = habitCategoryColor(
                category.id,
                snapshot.categories,
              );
              const count = snapshot.habits.filter(
                (habit) =>
                  habit.categoryId === category.id &&
                  (scope === 'today'
                    ? habit.active && isHabitDueOn(habit, today)
                    : true) &&
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
                      <span
                        className="habit-category-mark"
                        style={
                          categoryColor
                            ? { backgroundColor: categoryColor }
                            : undefined
                        }
                      />
                      {category.name}
                    </span>
                    <span>{count}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
      )}

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
                <span>习惯</span>
                {todayPendingCount > 0 && (
                  <span
                    className="task-switch-badge"
                    aria-label={`今日还有 ${todayPendingCount} 个习惯未打卡`}
                  >
                    {formatBadgeCount(todayPendingCount)}
                  </span>
                )}
              </button>
            </div>
            <span className="task-toolbar-count">
              今日 {todayDone}/{todayDue.length}
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
              onClick={() => {
                closeDay();
                setView('list');
              }}
            >
              清单
            </button>
            <button
              type="button"
              className={view === 'calendar' ? 'is-active' : ''}
              onClick={() => {
                if (view !== 'calendar') {
                  closeDay();
                  chooseDate(today);
                }
                setView('calendar');
              }}
            >
              日历
            </button>
            <button
              type="button"
              className={view === 'stats' ? 'is-active' : ''}
              onClick={() => {
                closeDay();
                setView('stats');
              }}
            >
              统计
            </button>
            <button
              type="button"
              className="task-primary"
              onClick={() => openDraftModal(habitDraft())}
            >
              新建习惯
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
            onSelectDate={(date) => {
              showAgenda(date, null);
              setView('calendar');
            }}
          />
        ) : view === 'calendar' ? (
          <section
            className={`task-calendar habit-calendar${calendarMode === 'week' ? ' is-week' : ''}${calendarPanelOpen ? ' is-panel-open' : ''}${focusedDate ? ' is-day-focus' : ''}`}
          >
            <div className="task-calendar-topbar">
              <div className="task-calendar-nav">
                <button
                  type="button"
                  className="task-calendar-nav-button"
                  onClick={() => movePeriod(-1)}
                  aria-label={calendarMode === 'week' ? '上周' : '上个月'}
                >
                  ‹
                </button>
                <strong>
                  {formatCalendarPeriod(
                    calendarMode,
                    visibleMonth,
                    cells[0]?.date,
                    cells[6]?.date,
                  )}
                </strong>
                <button
                  type="button"
                  className="task-calendar-nav-button"
                  onClick={() => movePeriod(1)}
                  aria-label={calendarMode === 'week' ? '下周' : '下个月'}
                >
                  ›
                </button>
                <button
                  type="button"
                  className="task-calendar-nav-button"
                  onClick={() => {
                    chooseDate(today);
                    if (focusedDate) setFocusedDate(today);
                  }}
                >
                  今天
                </button>
              </div>
              <div className="task-calendar-view-actions">
                <div
                  className="task-workspace-switch task-calendar-view-switch"
                  role="group"
                  aria-label="习惯日历范围"
                >
                  <button
                    type="button"
                    className={calendarMode === 'week' ? 'is-active' : ''}
                    aria-pressed={calendarMode === 'week'}
                    onClick={() => {
                      closeDay();
                      setCalendarMode('week');
                    }}
                  >
                    周
                  </button>
                  <button
                    type="button"
                    className={calendarMode === 'month' ? 'is-active' : ''}
                    aria-pressed={calendarMode === 'month'}
                    onClick={() => {
                      closeDay();
                      setCalendarMode('month');
                    }}
                  >
                    月
                  </button>
                </div>
                <button
                  type="button"
                  className="task-calendar-panel-toggle task-calendar-nav-button"
                  aria-expanded={calendarPanelOpen}
                  onClick={() => setCalendarPanelOpen((open) => !open)}
                >
                  {calendarPanelOpen ? '关闭日程' : '当天日程'}
                </button>
              </div>
            </div>
            <div className="task-calendar-content">
              {focusedDate ? (
                <section
                  className="task-calendar-day-focus"
                  aria-label={`${formatAgendaHeading(focusedDate)}的习惯`}
                >
                  <div className="task-calendar-day-focus-head">
                    <button
                      type="button"
                      className="task-calendar-nav-button"
                      onClick={() => stepFocusedDay(-1)}
                      aria-label="前一天"
                    >
                      ‹
                    </button>
                    <strong className="task-calendar-day-focus-title">
                      {formatAgendaHeading(focusedDate)} ·{' '}
                      {focusedHabits.length} 项
                    </strong>
                    <div className="task-calendar-day-focus-actions">
                      <button
                        type="button"
                        onClick={closeDay}
                        aria-label={
                          calendarMode === 'week' ? '返回周历' : '返回月历'
                        }
                      >
                        返回
                      </button>
                      <button
                        type="button"
                        className="task-calendar-nav-button"
                        onClick={() => stepFocusedDay(1)}
                        aria-label="后一天"
                      >
                        ›
                      </button>
                    </div>
                  </div>
                  <div className="task-calendar-agenda-list">
                    {focusedHabits.length ? (
                      focusedHabits.map((habit) =>
                        renderCheckRow(habit, focusedDate),
                      )
                    ) : (
                      <div className="task-muted">这一天没有到期习惯。</div>
                    )}
                  </div>
                </section>
              ) : (
                <>
                  <div className="task-calendar-grid-wrap">
                    <div className="task-calendar-weekdays" aria-hidden="true">
                      {WEEKDAYS.map((day) => (
                        <div className="task-calendar-weekday" key={day}>
                          {day}
                        </div>
                      ))}
                    </div>
                    <div
                      ref={calendarGridRef}
                      className="task-calendar-grid"
                      role="region"
                      aria-label="习惯日历"
                      style={{
                        gridTemplateRows: `repeat(${cells.length / 7}, minmax(76px, 1fr))`,
                      }}
                    >
                      {cells.map((cell) => {
                        const entries = sortHabits(
                          calendarHabits.filter((habit) =>
                            hasHabitEntryOn(habit, cell.date),
                          ),
                        );
                        const visibleLimit = computeCalendarCellVisibleCount(
                          calendarMode,
                          calendarRowHeight,
                          entries.length,
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
                                showAgenda(cell.date, null);
                            }}
                            onDoubleClick={(event) => {
                              const target = event.target;
                              if (
                                !(target instanceof HTMLElement) ||
                                target.closest('.habit-calendar-marker')
                              ) {
                                return;
                              }
                              openDay(cell.date);
                            }}
                          >
                            <div className="task-calendar-day-head">
                              <button
                                type="button"
                                className="task-calendar-day-number"
                                onClick={() => showAgenda(cell.date, null)}
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
                                  const next = shiftedDateByDays(
                                    cell.date,
                                    offset,
                                  );
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
                              <button
                                type="button"
                                className="task-calendar-day-add"
                                onClick={() => {
                                  chooseDate(cell.date);
                                  openDraftModal(
                                    habitDraft(undefined, cell.date),
                                  );
                                }}
                                aria-label={`${cell.date} 新建习惯`}
                              >
                                +
                              </button>
                            </div>
                            <div className="task-calendar-day-items">
                              {entries.slice(0, visibleLimit).map((habit) => {
                                const key = occurrenceKey(habit.id, cell.date);
                                const occurrence = occurrencesByKey.get(key);
                                const categoryColor = habitCategoryColor(
                                  habit.categoryId,
                                  snapshot.categories,
                                );
                                const canQuickCheck =
                                  cell.date <= today && habit.active;
                                const status = occurrence?.status;
                                const markerTitle = `${habit.title} · ${status === 'done' ? '已完成' : status === 'skipped' ? '已跳过' : habit.active ? '待打卡' : '已暂停'}`;
                                return (
                                  <div
                                    key={habit.id}
                                    className={`habit-calendar-marker${status ? ` is-${status}` : ''}${!habit.active ? ' is-paused' : ''}`}
                                    style={
                                      !status && categoryColor
                                        ? ({
                                            '--habit-category-color':
                                              categoryColor,
                                          } as CSSProperties)
                                        : undefined
                                    }
                                    title={markerTitle}
                                  >
                                    {canQuickCheck && (
                                      <button
                                        type="button"
                                        className={`habit-calendar-quick-check${status ? ` is-${status}` : ''}`}
                                        disabled={savingKeys.has(key)}
                                        aria-pressed={status === 'done'}
                                        aria-label={`${status === 'done' ? '撤销' : '打卡'} ${habit.title}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void markOccurrence(
                                            habit,
                                            cell.date,
                                            nextCheckStatus(status),
                                          );
                                        }}
                                      >
                                        {status === 'done'
                                          ? '✓'
                                          : status === 'skipped'
                                            ? '—'
                                            : ''}
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className="habit-calendar-marker-open"
                                      onClick={() =>
                                        showAgenda(cell.date, habit.id)
                                      }
                                    >
                                      <span>{habit.title}</span>
                                    </button>
                                  </div>
                                );
                              })}
                              {entries.length > visibleLimit && (
                                <button
                                  type="button"
                                  className="task-calendar-more"
                                  title="展开查看这一天"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openDay(cell.date);
                                  }}
                                >
                                  另有 {entries.length - visibleLimit} 项
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <aside className="task-calendar-agenda habit-agenda">
                    <div className="task-calendar-agenda-head">
                      <strong>{formatAgendaHeading(selectedDate)}</strong>
                    </div>
                    <div className="task-calendar-agenda-list">
                      {selectedDateHabits.length ? (
                        selectedDateHabits.map((habit) =>
                          renderCheckRow(habit, selectedDate),
                        )
                      ) : (
                        <div className="task-muted">这一天没有到期习惯。</div>
                      )}
                    </div>
                  </aside>
                </>
              )}
            </div>
          </section>
        ) : (
          <section className="habit-list-view">
            <div className="habit-list-toolbar">
              <div className="habit-list-date">
                <strong>{scope === 'today' ? '今天' : '全部习惯'}</strong>
                <span>
                  {categoryFilter === 'all'
                    ? '全部分类'
                    : (categoriesById.get(categoryFilter)?.name ?? '所选分类')}
                  {scope === 'today' ? ` · ${formatAgendaHeading(today)}` : ''}
                </span>
              </div>
            </div>
            {scope === 'library' && (
              <details className="habit-category-admin">
                <summary>管理分类</summary>
                <div className="habit-category-admin-body">
                  {snapshot.categories.map((category) => (
                    <div className="habit-category-admin-row" key={category.id}>
                      <span>{category.name}</span>
                      {!category.isBuiltin && (
                        <button
                          type="button"
                          onClick={() => void deleteCategory(category)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  ))}
                  <form
                    className="habit-category-admin-create"
                    onSubmit={createCategory}
                  >
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
                </div>
              </details>
            )}
            <div className="habit-list">
              {scope === 'today' ? (
                todayHabits.length ? (
                  todayHabits.map((habit) => renderCheckRow(habit, today))
                ) : (
                  <div className="task-empty">今天没有到期的习惯。</div>
                )
              ) : libraryActive.length || libraryPaused.length ? (
                <>
                  {libraryActive.map((habit) => renderDefinitionRow(habit))}
                  {libraryPaused.length > 0 && (
                    <div className="habit-library-paused">
                      <header>
                        <strong>已暂停</strong>
                        <span>{libraryPaused.length}</span>
                      </header>
                      {libraryPaused.map((habit) => renderDefinitionRow(habit))}
                    </div>
                  )}
                </>
              ) : (
                <div className="task-empty">当前筛选下没有习惯。</div>
              )}
            </div>
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
              <label className="habit-draft-active">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(event) =>
                    setDraft({ ...draft, active: event.target.checked })
                  }
                />
                启用
              </label>
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
              {draftError && (
                <div className="task-error" role="alert">
                  {draftError}
                </div>
              )}
            </div>
            <footer>
              {draft.id && (
                <button
                  type="button"
                  className="task-danger habit-modal-delete"
                  disabled={saving}
                  onClick={() =>
                    void deleteHabit({
                      id: draft.id!,
                      title: draft.title.trim() || '未命名习惯',
                    })
                  }
                >
                  删除习惯
                </button>
              )}
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
      {confirmDialog}
    </div>
  );
}
