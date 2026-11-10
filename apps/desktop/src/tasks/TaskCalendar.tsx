import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LearningTask, TaskStatus } from './types';
import {
  formatCalendarPeriod,
  localToday,
  monthGrid,
  parseDateKey,
  shiftedDateByDays,
  shiftedDateByMonth,
  weekGrid,
} from './calendar-model';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const STATUS: Record<TaskStatus, string> = {
  todo: '未开始',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
};
const CELL_LIMIT = 3;
const CALENDAR_STATE_KEY = 'seamind:task-calendar:v1';
type CalendarMode = 'month' | 'week';
type AgendaTab = 'date' | 'unscheduled';

function readCalendarState(): {
  date: string;
  mode: CalendarMode;
  tab: AgendaTab;
  restored: boolean;
} {
  try {
    const raw = sessionStorage.getItem(CALENDAR_STATE_KEY);
    const value = JSON.parse(raw ?? '{}');
    return {
      date:
        typeof value.date === 'string' && parseDateKey(value.date)
          ? value.date
          : localToday(),
      mode: value.mode === 'week' ? 'week' : 'month',
      tab: value.tab === 'unscheduled' ? 'unscheduled' : 'date',
      restored: raw != null,
    };
  } catch {
    return { date: localToday(), mode: 'month', tab: 'date', restored: false };
  }
}

function taskKind(task: LearningTask) {
  const kinds = new Set(task.resources.map((resource) => resource.kind));
  if (kinds.has('ebook') && kinds.has('youtube')) return '书籍 · 视频';
  if (kinds.has('ebook')) return '书籍';
  if (kinds.has('youtube')) return '视频';
  return '任务';
}

function compareTasks(a: LearningTask, b: LearningTask) {
  const rank: Record<TaskStatus, number> = {
    doing: 0,
    todo: 1,
    done: 2,
    cancelled: 3,
  };
  return (
    rank[a.status] - rank[b.status] ||
    b.priority - a.priority ||
    a.position - b.position ||
    a.title.localeCompare(b.title, 'zh-CN')
  );
}

export default function TaskCalendar({
  tasks,
  onOpenTask,
  onCreateTask,
  onMoveTask,
  onToggleTaskCompletion,
  statusSavingIds,
  today,
}: {
  tasks: LearningTask[];
  onOpenTask(id: string): void;
  onCreateTask(date: string): void;
  onMoveTask(task: LearningTask, date: string | null): Promise<boolean>;
  onToggleTaskCompletion(task: LearningTask): void;
  statusSavingIds: ReadonlySet<string>;
  today: string;
}) {
  const [savedState] = useState(readCalendarState);
  const initial = parseDateKey(savedState.date)!;
  const [visibleMonth, setVisibleMonth] = useState({
    year: initial.year,
    month: initial.month,
  });
  const [selectedDate, setSelectedDate] = useState(savedState.date);
  const [mode, setMode] = useState<CalendarMode>(savedState.mode);
  const [agendaTab, setAgendaTab] = useState<AgendaTab>(savedState.tab);
  const [editingDateId, setEditingDateId] = useState<string | null>(null);
  const [dateDraft, setDateDraft] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [navHost, setNavHost] = useState<HTMLElement | null>(null);
  const agendaTouched = useRef(savedState.restored);
  useLayoutEffect(() => {
    setNavHost(document.getElementById('task-calendar-toolbar-slot'));
  }, []);
  const previousToday = useRef(today);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const cells = useMemo(
    () =>
      mode === 'week'
        ? weekGrid(selectedDate)
        : monthGrid(visibleMonth.year, visibleMonth.month),
    [mode, selectedDate, visibleMonth],
  );
  useEffect(() => {
    try {
      sessionStorage.setItem(
        CALENDAR_STATE_KEY,
        JSON.stringify({ date: selectedDate, mode, tab: agendaTab }),
      );
    } catch {
      // 禁用存储时仍保留当前窗口内的交互状态。
    }
  }, [selectedDate, mode, agendaTab]);
  useEffect(() => {
    const previous = previousToday.current;
    previousToday.current = today;
    if (previous === today || selectedDate !== previous) return;
    const parsed = parseDateKey(today);
    if (!parsed) return;
    setSelectedDate(today);
    setVisibleMonth({ year: parsed.year, month: parsed.month });
    setAgendaTab('date');
  }, [today, selectedDate]);
  const { byDate, unscheduled } = useMemo(() => {
    const byDate = new Map<string, LearningTask[]>();
    const unscheduled: LearningTask[] = [];
    for (const task of tasks) {
      if (task.status === 'cancelled') continue;
      if (!task.dueDate || !parseDateKey(task.dueDate)) {
        unscheduled.push(task);
      } else {
        const list = byDate.get(task.dueDate) ?? [];
        list.push(task);
        byDate.set(task.dueDate, list);
      }
    }
    for (const list of byDate.values()) list.sort(compareTasks);
    unscheduled.sort(compareTasks);
    return { byDate, unscheduled };
  }, [tasks]);
  const selectedTasks = byDate.get(selectedDate) ?? [];
  useEffect(() => {
    if (
      !agendaTouched.current &&
      unscheduled.length > 0 &&
      selectedTasks.length === 0
    ) {
      setAgendaTab('unscheduled');
      agendaTouched.current = true;
    }
  }, [selectedTasks.length, unscheduled.length]);

  const movePeriod = (delta: number) => {
    const next =
      mode === 'week'
        ? shiftedDateByDays(selectedDate, delta * 7)
        : shiftedDateByMonth(selectedDate, delta);
    chooseDate(next);
  };
  const chooseDate = (date: string) => {
    const parsed = parseDateKey(date);
    if (!parsed) return;
    setSelectedDate(date);
    setVisibleMonth({ year: parsed.year, month: parsed.month });
    setAgendaTab('date');
    agendaTouched.current = true;
  };
  const dropTask = async (id: string, date: string | null) => {
    setDraggingId(null);
    const task = tasks.find((item) => item.id === id);
    if (!task || (date && !parseDateKey(date))) return;
    if (task.dueDate === date) {
      setEditingDateId(null);
      return;
    }
    setMovingId(id);
    try {
      const saved = await onMoveTask(task, date);
      if (saved) {
        if (date) chooseDate(date);
        else setAgendaTab('unscheduled');
        setEditingDateId(null);
      }
    } finally {
      setMovingId(null);
    }
  };
  const taskButton = (task: LearningTask, compact: boolean) => (
    <div
      key={task.id}
      className={`task-calendar-item is-${task.status}${compact ? ' is-compact' : ' is-agenda-item'}`}
      draggable={!movingId && !statusSavingIds.has(task.id)}
      role="group"
      aria-label={`${task.title}，${STATUS[task.status]}，${taskKind(task)}`}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id);
        event.dataTransfer.effectAllowed = 'move';
        setDraggingId(task.id);
      }}
      onDragEnd={() => setDraggingId(null)}
    >
      <button
        type="button"
        className={`task-calendar-item-toggle is-${task.status}`}
        aria-label={
          task.status === 'done'
            ? `重新打开任务 ${task.title}`
            : `标记任务完成 ${task.title}`
        }
        aria-pressed={task.status === 'done'}
        title={task.status === 'done' ? '重新打开任务' : '标记为已完成'}
        disabled={movingId === task.id || statusSavingIds.has(task.id)}
        onClick={(event) => {
          event.stopPropagation();
          onToggleTaskCompletion(task);
        }}
      >
        {task.status === 'done' ? '✓' : '○'}
      </button>
      <button
        type="button"
        className="task-calendar-item-open"
        onClick={(event) => {
          event.stopPropagation();
          onOpenTask(task.id);
        }}
        title={`${task.title} · ${STATUS[task.status]} · ${taskKind(task)}`}
        aria-label={`${task.title}，${STATUS[task.status]}，${taskKind(task)}`}
        disabled={movingId === task.id}
      >
        <span className="task-calendar-item-mark" aria-hidden="true" />
        <span className="task-calendar-item-title">{task.title}</span>
        {!compact && (
          <span className="task-calendar-item-kind">{taskKind(task)}</span>
        )}
      </button>
      {!compact &&
        (editingDateId === task.id ? (
          <div className="task-calendar-date-edit">
            <input
              type="date"
              value={dateDraft}
              onChange={(event) => setDateDraft(event.target.value)}
              aria-label={`安排 ${task.title} 的截止日期`}
              autoFocus
            />
            <button
              type="button"
              disabled={!parseDateKey(dateDraft) || movingId === task.id}
              onClick={() => void dropTask(task.id, dateDraft)}
            >
              保存
            </button>
            {task.dueDate && (
              <button
                type="button"
                disabled={movingId === task.id}
                onClick={() => void dropTask(task.id, null)}
              >
                清除
              </button>
            )}
            <button type="button" onClick={() => setEditingDateId(null)}>
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="task-calendar-schedule"
            onClick={() => {
              setDateDraft(task.dueDate ?? selectedDate);
              setEditingDateId(task.id);
            }}
            aria-label={`安排 ${task.title} 的截止日期`}
          >
            {task.dueDate ? '改期' : '排期'}
          </button>
        ))}
    </div>
  );

  const periodTitle = formatCalendarPeriod(
    mode,
    visibleMonth,
    cells[0]?.date,
    cells[6]?.date,
  );
  const navigation = (
    <div className="task-calendar-toolbar-nav">
      <div className="task-calendar-nav">
        <button
          type="button"
          className="task-calendar-nav-button"
          onClick={() => movePeriod(-1)}
          aria-label={mode === 'week' ? '上周' : '上个月'}
        >
          ‹
        </button>
        <strong>{periodTitle}</strong>
        <button
          type="button"
          className="task-calendar-nav-button"
          onClick={() => movePeriod(1)}
          aria-label={mode === 'week' ? '下周' : '下个月'}
        >
          ›
        </button>
        <button
          type="button"
          className="task-calendar-nav-button"
          onClick={() => chooseDate(today)}
        >
          今天
        </button>
      </div>
      <div className="task-calendar-view-actions">
        <div
          className="task-workspace-switch task-calendar-view-switch"
          role="group"
          aria-label="日历范围"
        >
          <button
            type="button"
            className={mode === 'week' ? 'is-active' : ''}
            aria-pressed={mode === 'week'}
            onClick={() => setMode('week')}
          >
            周
          </button>
          <button
            type="button"
            className={mode === 'month' ? 'is-active' : ''}
            aria-pressed={mode === 'month'}
            onClick={() => setMode('month')}
          >
            月
          </button>
        </div>
        <button
          type="button"
          className="task-calendar-panel-toggle task-calendar-nav-button"
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
        >
          {panelOpen ? '关闭日程' : `日程 · 未排期 ${unscheduled.length}`}
        </button>
      </div>
    </div>
  );

  return (
    <div
      className={`task-calendar${mode === 'week' ? ' is-week' : ''}${panelOpen ? ' is-panel-open' : ''}`}
    >
      {navHost ? createPortal(navigation, navHost) : null}
      <div className="task-calendar-content">
        <div className="task-calendar-grid-wrap">
          <div className="task-calendar-weekdays" aria-hidden="true">
            {WEEKDAYS.map((day) => (
              <div className="task-calendar-weekday" key={day}>
                {day}
              </div>
            ))}
          </div>
          <div
            className="task-calendar-grid"
            style={{
              gridTemplateRows: `repeat(${cells.length / 7}, minmax(76px, 1fr))`,
            }}
            role="region"
            aria-label={
              mode === 'week'
                ? `${cells[0]?.date} 至 ${cells[6]?.date} 任务周历`
                : `${visibleMonth.year} 年 ${visibleMonth.month} 月任务日历`
            }
          >
            {cells.map((cell) => {
              const entries = byDate.get(cell.date) ?? [];
              const validDay = parseDateKey(cell.date) !== null;
              return (
                <div
                  key={cell.date}
                  className={`task-calendar-day${cell.inMonth ? '' : ' is-outside'}${cell.date === today ? ' is-today' : ''}${cell.date === selectedDate ? ' is-selected' : ''}${draggingId ? ' is-drop-target' : ''}`}
                  role="group"
                  aria-label={`${cell.date}，${entries.length} 项任务`}
                  onClick={(event) => {
                    if (
                      !(event.target instanceof HTMLElement) ||
                      !event.target.closest('button')
                    )
                      chooseDate(cell.date);
                  }}
                  onDragOver={(event) => {
                    if (draggingId && validDay) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggingId) void dropTask(draggingId, cell.date);
                  }}
                >
                  <div className="task-calendar-day-head">
                    <button
                      type="button"
                      className="task-calendar-day-number"
                      onClick={() => chooseDate(cell.date)}
                      disabled={!validDay}
                      aria-label={`选择 ${cell.date}`}
                      aria-pressed={cell.date === selectedDate}
                      aria-current={cell.date === today ? 'date' : undefined}
                      data-task-date={cell.date}
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
                              `[data-task-date="${next}"]`,
                            )
                            ?.focus(),
                        );
                      }}
                    >
                      {cell.day}
                    </button>
                    {entries.length > 0 && (
                      <span
                        className="task-calendar-day-count"
                        aria-hidden="true"
                      >
                        {entries.length}
                      </span>
                    )}
                    <button
                      type="button"
                      className="task-calendar-day-add"
                      onClick={() => {
                        chooseDate(cell.date);
                        onCreateTask(cell.date);
                      }}
                      disabled={!validDay}
                      aria-label={`${cell.date} 新建任务`}
                    >
                      +
                    </button>
                  </div>
                  <div className="task-calendar-day-items">
                    {entries
                      .slice(0, CELL_LIMIT)
                      .map((task) => taskButton(task, true))}
                    {entries.length > CELL_LIMIT && (
                      <button
                        type="button"
                        className="task-calendar-more"
                        onClick={() => chooseDate(cell.date)}
                      >
                        另有 {entries.length - CELL_LIMIT} 项
                      </button>
                    )}
                  </div>
                  {entries.length === 0 && (
                    <button
                      type="button"
                      className="task-calendar-empty-day"
                      onClick={() => chooseDate(cell.date)}
                      disabled={!validDay}
                      aria-label={`选择 ${cell.date}`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <aside className="task-calendar-agenda">
          <div
            className="task-calendar-agenda-tabs"
            role="group"
            aria-label="日程内容"
          >
            <button
              type="button"
              aria-pressed={agendaTab === 'date'}
              className={agendaTab === 'date' ? 'is-active' : ''}
              onClick={() => {
                setAgendaTab('date');
                agendaTouched.current = true;
              }}
            >
              {selectedDate === today ? '今天' : selectedDate}{' '}
              <span>{selectedTasks.length}</span>
            </button>
            <button
              type="button"
              aria-pressed={agendaTab === 'unscheduled'}
              className={agendaTab === 'unscheduled' ? 'is-active' : ''}
              onClick={() => {
                setAgendaTab('unscheduled');
                agendaTouched.current = true;
              }}
            >
              未排期 <span>{unscheduled.length}</span>
            </button>
          </div>
          {agendaTab === 'date' ? (
            <div className="task-calendar-agenda-pane">
              <div className="task-calendar-agenda-head">
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => chooseDate(event.target.value)}
                  aria-label="选择日程日期"
                />
                <button
                  type="button"
                  onClick={() => onCreateTask(selectedDate)}
                >
                  + 新建
                </button>
              </div>
              <div className="task-calendar-agenda-list">
                {selectedTasks.length ? (
                  selectedTasks.map((task) => taskButton(task, false))
                ) : (
                  <div className="task-calendar-empty-state">
                    <strong>这一天没有截止任务</strong>
                    <span>可从未排期列表安排任务，或直接新建。</span>
                    {unscheduled.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setAgendaTab('unscheduled')}
                      >
                        查看未排期 {unscheduled.length} 项
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div
              className="task-calendar-agenda-pane task-calendar-unscheduled"
              onDragOver={(event) => {
                if (draggingId) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (draggingId) void dropTask(draggingId, null);
              }}
            >
              <div className="task-calendar-agenda-subhead">
                选择任务的“排期”，或拖到日历日期。
              </div>
              <div className="task-calendar-agenda-list">
                {unscheduled.length ? (
                  unscheduled.map((task) => taskButton(task, false))
                ) : (
                  <div className="task-muted">没有未安排日期的任务。</div>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
