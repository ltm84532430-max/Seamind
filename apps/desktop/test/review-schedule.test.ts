import { describe, expect, it } from 'vitest';
import type { EpubExamSummary } from '../src/exams/epub-exams';
import { scheduleExamReview } from '../src/exams/review-schedule';

const day = (value: string) => new Date(`${value}T12:00:00`).getTime();
const base: EpubExamSummary = {
  id: 'exam',
  bookKey: 'book.epub',
  bookTitle: 'Book',
  sourceSectionLabel: '1',
  createdAt: day('2026-11-01'),
  questionCount: 10,
  status: 'submitted',
  attemptsCount: 0,
  lastCompletedAt: day('2026-11-01'),
  reviewStreak: 1,
};

describe('exam review schedule', () => {
  it('schedules from the latest completed local calendar day', () => {
    const review = scheduleExamReview(base, day('2026-11-02'));
    expect(review.intervalDays).toBe(1);
    expect(review.daysUntil).toBe(0);
    expect(review.urgency).toBe('today');
    expect(scheduleExamReview(base, day('2026-11-04')).urgency).toBe('overdue');
  });

  it('expands after consecutive strong reviews and resets after weak reviews', () => {
    expect(scheduleExamReview({ ...base, reviewStreak: 3 }).intervalDays).toBe(
      7,
    );
    expect(scheduleExamReview({ ...base, reviewStreak: 0 }).intervalDays).toBe(
      1,
    );
    expect(scheduleExamReview({ ...base, reviewStreak: 20 }).intervalDays).toBe(
      60,
    );
  });

  it('keeps unfinished retakes visible without inventing a new completion', () => {
    const retake = { ...base, status: 'inProgress' as const, attemptsCount: 1 };
    expect(scheduleExamReview(retake, day('2026-11-04')).urgency).toBe(
      'overdue',
    );
    expect(scheduleExamReview({ ...retake, attemptsCount: 0 }).urgency).toBe(
      'notStarted',
    );
  });
});
