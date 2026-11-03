import { useMemo, useState } from 'react';
import type { LearningTask, TaskStatus } from './types';
import {
  dateKey,
  localToday,
  monthGrid,
  parseDateKey,
  shiftedMonth,
} from './calendar-model';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const STATUS: Record<TaskStatus, string> = {
  todo: '未开始',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
};
const CELL_LIMIT = 3;

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
}: {
  tasks: LearningTask[];
  onOpenTask(id: string): void;
  onCreateTask(date: string): void;
  onMoveTask(task: LearningTask, date: string | null): Promise<void>;
  onToggleTaskCompletion(task: LearningTask): void;
  statusSavingIds: ReadonlySet<string>;
}) {
  const today = localToday();
  const initial = parseDateKey(today)!;
  const [visibleMonth, setVisibleMonth] = useState({
    year: initial.year,
    month: initial.month,
  });
  const [selectedDate, setSelectedDate] = useState(today);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const cells = useMemo(
    () => monthGrid(visibleMonth.year, visibleMonth.month),
    [visibleMonth],
  );
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

  const moveMonth = (delta: number) => {
    const next = shiftedMonth(visibleMonth.year, visibleMonth.month, delta);
    setVisibleMonth(next);
    setSelectedDate(dateKey(next.year, next.month, 1));
  };
  const chooseDate = (date: string) => {
    const parsed = parseDateKey(date);
    if (!parsed) return;
    setSelectedDate(date);
    setVisibleMonth({ year: parsed.year, month: parsed.month });
  };
  const dropTask = async (id: string, date: string | null) => {
    setDraggingId(null);
    const task = tasks.find((item) => item.id === id);
    if (!task || task.dueDate === date || (date && !parseDateKey(date))) return;
    setMovingId(id);
    try {
      await onMoveTask(task, date);
    } finally {
      setMovingId(null);
    }
  };
  const taskButton = (task: LearningTask, compact: boolean) => (
    <div
      key={task.id}
      className={`task-calendar-item is-${task.status}${compact ? ' is-compact' : ''}`}
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
    </div>
  );

  return (
    <div className="task-calendar">
      <div className="task-calendar-topbar">
        <div className="task-calendar-nav">
          <button
            type="button"
            onClick={() => moveMonth(-1)}
            aria-label="上个月"
          >
            ‹
          </button>
          <strong>
            {visibleMonth.year} 年 {visibleMonth.month} 月
          </strong>
          <button
            type="button"
            onClick={() => moveMonth(1)}
            aria-label="下个月"
          >
            ›
          </button>
          <button type="button" onClick={() => chooseDate(today)}>
            今天
          </button>
        </div>
        <span className="task-calendar-hint">显示任务截止日 · 拖动可改期</span>
      </div>
      <div className="task-calendar-content">
        <div className="task-calendar-grid-wrap">
          <div
            className="task-calendar-grid"
            role="region"
            aria-label={`${visibleMonth.year} 年 ${visibleMonth.month} 月任务日历`}
          >
            {WEEKDAYS.map((day) => (
              <div className="task-calendar-weekday" key={day}>
                {day}
              </div>
            ))}
            {cells.map((cell) => {
              const entries = byDate.get(cell.date) ?? [];
              const validDay = parseDateKey(cell.date) !== null;
              return (
                <div
                  key={cell.date}
                  className={`task-calendar-day${cell.inMonth ? '' : ' is-outside'}${cell.date === today ? ' is-today' : ''}${cell.date === selectedDate ? ' is-selected' : ''}${draggingId ? ' is-drop-target' : ''}`}
                  role="group"
                  aria-label={`${cell.date}，${entries.length} 项任务`}
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
                      aria-current={cell.date === today ? 'date' : undefined}
                    >
                      {cell.day}
                    </button>
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
                      onClick={() => {
                        chooseDate(cell.date);
                        onCreateTask(cell.date);
                      }}
                      disabled={!validDay}
                      aria-label={`${cell.date} 新建任务`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <aside className="task-calendar-agenda">
          <label className="task-calendar-date-picker">
            选择日期
            <input
              type="date"
              value={selectedDate}
              onChange={(event) => chooseDate(event.target.value)}
            />
          </label>
          <div className="task-calendar-agenda-head">
            <strong>{selectedDate === today ? '今天' : selectedDate}</strong>
            <button type="button" onClick={() => onCreateTask(selectedDate)}>
              + 新建
            </button>
          </div>
          <div className="task-calendar-agenda-list">
            {selectedTasks.length ? (
              selectedTasks.map((task) => taskButton(task, false))
            ) : (
              <div className="task-muted">这一天没有截止任务。</div>
            )}
          </div>
          <div
            className="task-calendar-unscheduled"
            onDragOver={(event) => {
              if (draggingId) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggingId) void dropTask(draggingId, null);
            }}
          >
            <strong>
              未安排日期 <span>{unscheduled.length}</span>
            </strong>
            <div className="task-calendar-agenda-list">
              {unscheduled.length ? (
                unscheduled.map((task) => taskButton(task, false))
              ) : (
                <div className="task-muted">没有未安排日期的任务。</div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
