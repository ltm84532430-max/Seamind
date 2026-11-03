import { useEffect, useState } from 'react';
import { TASKS_CHANGED_EVENT, taskApi } from './task-api';
import type { LearningTask, TaskStatus } from './types';

const labels: Record<TaskStatus, string> = {
  todo: '未开始',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
};

/** Show the canonical task state beside its source without changing reading or playback state. */
export default function ResourceTaskLinks({
  kind,
  identity,
  onOpenTask,
}: {
  kind: 'ebook' | 'youtube';
  identity: string;
  onOpenTask(id: string): void;
}) {
  const [tasks, setTasks] = useState<LearningTask[]>([]);
  useEffect(() => {
    let active = true;
    const load = () => {
      void taskApi
        .snapshot()
        .then((snapshot) => {
          if (active)
            setTasks(
              snapshot.tasks.filter((task) =>
                task.resources.some(
                  (resource) =>
                    resource.kind === kind &&
                    (kind === 'ebook'
                      ? resource.progressKey === identity
                      : resource.resourceId === identity),
                ),
              ),
            );
        })
        .catch(() => {
          if (active) setTasks([]);
        });
    };
    load();
    window.addEventListener(TASKS_CHANGED_EVENT, load);
    return () => {
      active = false;
      window.removeEventListener(TASKS_CHANGED_EVENT, load);
    };
  }, [identity, kind]);

  if (!tasks.length) return null;
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span>关联任务</span>
      <select
        aria-label="查看关联任务"
        value=""
        onChange={(event) => {
          if (event.target.value) onOpenTask(event.target.value);
        }}
        style={{ maxWidth: 180 }}
      >
        <option value="">{tasks.length} 项</option>
        {tasks.map((task) => (
          <option key={task.id} value={task.id}>
            {labels[task.status]} · {task.title}
          </option>
        ))}
      </select>
    </label>
  );
}
