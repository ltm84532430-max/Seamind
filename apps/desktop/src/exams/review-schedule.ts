import type { EpubExamSummary } from './epub-exams';

export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30, 60] as const;
export type ReviewUrgency =
  'notStarted' | 'inProgress' | 'overdue' | 'today' | 'upcoming' | 'later';

export interface ExamReviewSchedule {
  urgency: ReviewUrgency;
  dueAt: number | null;
  daysUntil: number | null;
  intervalDays: number | null;
  completedRounds: number;
  quality: number | null;
}

function localDayOrdinal(timestamp: number): number {
  const date = new Date(timestamp);
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000,
  );
}

export function scheduleExamReview(
  exam: EpubExamSummary,
  now = Date.now(),
): ExamReviewSchedule {
  const completedRounds = Math.max(
    0,
    (exam.attemptsCount ?? 0) + (exam.status === 'submitted' ? 1 : 0),
  );
  const lastCompletedAt = exam.lastCompletedAt;
  if (
    !completedRounds ||
    !lastCompletedAt ||
    !Number.isFinite(lastCompletedAt)
  ) {
    return {
      urgency: 'notStarted',
      dueAt: null,
      daysUntil: null,
      intervalDays: null,
      completedRounds,
      quality: null,
    };
  }

  // 成绩不足或无自评时保持短间隔；连续达到掌握标准才逐级拉开复习日期。
  const streak = Math.max(0, Math.floor(exam.reviewStreak ?? 0));
  const intervalDays =
    REVIEW_INTERVAL_DAYS[
      Math.min(Math.max(streak - 1, 0), REVIEW_INTERVAL_DAYS.length - 1)
    ];
  const completed = new Date(lastCompletedAt);
  const due = new Date(
    completed.getFullYear(),
    completed.getMonth(),
    completed.getDate() + intervalDays,
  );
  const daysUntil = localDayOrdinal(due.getTime()) - localDayOrdinal(now);
  // 重做尚未交卷时，到期提醒仍须保留；只有未来才显示为“重做进行中”。
  const urgency: ReviewUrgency =
    daysUntil < 0
      ? 'overdue'
      : daysUntil === 0
        ? 'today'
        : exam.status === 'inProgress'
          ? 'inProgress'
          : daysUntil <= 3
            ? 'upcoming'
            : 'later';
  return {
    urgency,
    dueAt: due.getTime(),
    daysUntil,
    intervalDays,
    completedRounds,
    quality:
      typeof exam.lastReviewQuality === 'number' &&
      Number.isFinite(exam.lastReviewQuality)
        ? Math.max(0, Math.min(1, exam.lastReviewQuality))
        : null,
  };
}

export function reviewUrgencyRank(urgency: ReviewUrgency): number {
  switch (urgency) {
    case 'overdue':
      return 0;
    case 'today':
      return 1;
    case 'inProgress':
      return 2;
    case 'upcoming':
      return 3;
    case 'later':
      return 4;
    case 'notStarted':
      return 5;
  }
}

export function reviewCurvePoints(
  intervalDays: number,
  width = 280,
  height = 112,
) {
  const span = Math.max(2, intervalDays * 2);
  return Array.from({ length: 41 }, (_, index) => {
    const day = (span * index) / 40;
    // 仅用于展示排程节奏，80% 是图中的提示线，并非实测记忆率。
    const remaining = Math.pow(0.8, day / intervalDays);
    return {
      x: (width * index) / 40,
      y: (height * (1 - remaining)) / 0.36,
      day,
    };
  });
}
