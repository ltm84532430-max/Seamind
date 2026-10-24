import { invoke } from '@tauri-apps/api/core';

export type EpubExamStatus = 'inProgress' | 'submitted';
export type EpubExamDifficulty = 'easy' | 'medium' | 'hard';
export type EpubExamQuestionType =
  | 'singleChoice'
  | 'multipleChoice'
  | 'trueFalse'
  | 'shortAnswer';
export type EpubExamAnswer = string | string[];
export type EpubExamSelfReview = 'mastered' | 'partial' | 'review';

export interface EpubExamQuestion {
  id: string;
  type: EpubExamQuestionType;
  prompt: string;
  options?: string[];
  answer: EpubExamAnswer;
  explanation: string;
}

export interface EpubExamAttempt {
  completedAt: number;
  answers: Record<string, EpubExamAnswer>;
  selfReviews: Record<string, EpubExamSelfReview>;
}

export interface EpubExam {
  schemaVersion: number;
  id: string;
  bookKey: string;
  bookTitle: string;
  sourceFileFingerprint: string;
  sourceSectionIndex: number;
  sourceSectionHref: string;
  sourceSectionLabel: string;
  createdAt: number;
  questionCount: number;
  difficulty: EpubExamDifficulty;
  status: EpubExamStatus;
  submittedAt: number | null;
  questions: EpubExamQuestion[];
  answers: Record<string, EpubExamAnswer>;
  selfReviews: Record<string, EpubExamSelfReview>;
  attempts: EpubExamAttempt[];
}

export interface EpubExamSummary {
  id: string;
  bookKey: string;
  bookTitle: string;
  sourceSectionLabel: string;
  createdAt: number;
  questionCount: number;
  status: EpubExamStatus;
}

export interface EpubExamGenerationResult {
  exam: EpubExam;
  saved: boolean;
  saveError: string | null;
}

export const MAX_EPUB_EXAM_SOURCE_CHARS = 50_000;

export function extractEpubSectionText(source: string): string {
  const document = new DOMParser().parseFromString(source, 'text/html');
  document
    .querySelectorAll(
      'script, style, noscript, svg, nav, [hidden], [aria-hidden="true"]',
    )
    .forEach((element) => element.remove());
  const text = (
    document.body?.textContent ??
    document.documentElement?.textContent ??
    ''
  )
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Error('当前阅读段落没有可用于出题的正文。');
  if (Array.from(text).length > MAX_EPUB_EXAM_SOURCE_CHARS) {
    throw new Error('当前阅读段落超过 50,000 字，请换到较短的段落后生成。');
  }
  return text;
}

export function formatEpubExamDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function listEpubExams(
  bookKey?: string,
): Promise<EpubExamSummary[]> {
  return invoke<EpubExamSummary[]>('list_epub_exams', {
    bookKey: bookKey ?? null,
  });
}
