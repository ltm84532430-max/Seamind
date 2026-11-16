import { useCallback, useEffect, useRef, useState } from 'react';
import { localToday } from './calendar-model';
import { countPendingDueHabits } from './habit-list-model';
import { habitApi, TASKS_CHANGED_EVENT } from './task-api';

/**
 * 追踪当前本地日期尚未完成（且未跳过）的到期习惯数量。
 * 自动监听习惯变更事件与跨日刷新（午夜定时器、休眠唤醒及 30 秒校对）。
 */
export function usePendingHabitCount(): number {
  const [today, setToday] = useState(localToday);
  const [pendingCount, setPendingCount] = useState(0);
  const todayRef = useRef(today);
  todayRef.current = today;
  const requestIdRef = useRef(0);

  const reload = useCallback(async (targetDate = todayRef.current) => {
    const requestId = ++requestIdRef.current;
    try {
      const snapshot = await habitApi.snapshot(targetDate, targetDate);
      if (requestId !== requestIdRef.current) return;
      setPendingCount(countPendingDueHabits(snapshot, targetDate));
    } catch {
      // 保留上一次有效计数，避免启动瞬间或数据库尚未就绪时角标闪烁。
    }
  }, []);

  useEffect(() => {
    void reload(today);
    const onChanged = () => void reload(todayRef.current);
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
  }, [reload, today]);

  useEffect(() => {
    let midnightTimer = 0;
    let clockCheckTimer = 0;
    let resumeRefreshTimer = 0;

    const syncLocalDate = () => {
      const currentDate = localToday();
      if (currentDate === todayRef.current) return false;
      todayRef.current = currentDate;
      setToday(currentDate);
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
        void reload(todayRef.current);
      }, 150);
    };

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
  }, [reload]);

  return pendingCount;
}
