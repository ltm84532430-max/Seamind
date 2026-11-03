import { invoke } from '@tauri-apps/api/core';
import type {
  ImportPlan,
  ImportResult,
  LearningTask,
  PlanInput,
  TaskInput,
  TaskSnapshot,
} from './types';

export const TASKS_CHANGED_EVENT = 'seamind:tasks-changed';
export const RESOURCE_PROGRESS_EVENT = 'seamind:resource-progress';

export function notifyResourceProgress() {
  window.dispatchEvent(new Event(RESOURCE_PROGRESS_EVENT));
}

function tasksChanged() {
  window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
}

export const taskApi = {
  snapshot: () => invoke<TaskSnapshot>('learning_tasks_snapshot'),
  savePlan: async (input: PlanInput) => {
    const result = await invoke<TaskSnapshot>('learning_tasks_save_plan', {
      input,
    });
    tasksChanged();
    return result;
  },
  saveTask: async (input: TaskInput) => {
    const result = await invoke<LearningTask>('learning_tasks_save_task', {
      input,
    });
    tasksChanged();
    return result;
  },
  deleteTask: async (id: string) => {
    await invoke<void>('learning_tasks_delete_task', { id });
    tasksChanged();
  },
  importPlan: async (draft: ImportPlan) => {
    const result = await invoke<ImportResult>('learning_tasks_import_plan', {
      draft,
    });
    tasksChanged();
    return result;
  },
};
