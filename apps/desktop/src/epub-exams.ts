import { invoke } from '@tauri-apps/api/core';

export type EpubExamStatus = 'inProgress' | 'submitted';
export type EpubExamDifficulty = 'easy' | 'medium' | 'hard';
export type EpubExamQuestionType =
  | 'singleChoice'
  | 'multipleChoice'
  | 'trueFalse'
  | 'shortAnswer'
  | 'comprehensive'
  | 'engineering'
  | 'cProgramming';
export type EpubExamAnswer = string | string[];
export type EpubExamSelfReview = 'mastered' | 'partial' | 'review';

export interface EpubExamQuestion {
  id: string;
  type: EpubExamQuestionType;
  prompt: string;
  options?: string[];
  answer: EpubExamAnswer;
  explanation: string;
  sourceRefs?: Array<{ href: string; label: string }>;
  points?: number;
  rubric?: Array<{ criterion: string; points: number }>;
  codeSpec?: {
    starterCode: string;
    cases: Array<{ stdin: string; expectedStdout: string; hidden: boolean }>;
  } | null;
}

export interface EpubExamGrade {
  earned: number;
  maximum: number;
  feedback: string;
  passedCases?: number | null;
  totalCases?: number | null;
  provisional?: boolean;
}

export interface EpubExamAttempt {
  completedAt: number;
  answers: Record<string, EpubExamAnswer>;
  selfReviews: Record<string, EpubExamSelfReview>;
  grades?: Record<string, EpubExamGrade>;
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
  scope?: { kind: 'section' | 'chapter'; label: string; href: string };
  createdAt: number;
  questionCount: number;
  difficulty: EpubExamDifficulty;
  status: EpubExamStatus;
  submittedAt: number | null;
  questions: EpubExamQuestion[];
  answers: Record<string, EpubExamAnswer>;
  selfReviews: Record<string, EpubExamSelfReview>;
  grades?: Record<string, EpubExamGrade>;
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
  sourceSectionIndex?: number;
  difficulty?: EpubExamDifficulty;
  attemptsCount?: number;
  masteredCount?: number;
  partialCount?: number;
  reviewCount?: number;
}

export interface EpubExamGenerationResult {
  exam: EpubExam;
  saved: boolean;
  saveError: string | null;
}

export const MAX_EPUB_EXAM_SOURCE_CHARS = 50_000;

export function extractEpubSectionPlainText(source: string): string {
  const document = new DOMParser().parseFromString(source, 'text/html');
  document
    .querySelectorAll(
      'script, style, noscript, svg, nav, [hidden], [aria-hidden="true"]',
    )
    .forEach((element) => element.remove());
  const blocks = new Set([
    'ADDRESS',
    'ARTICLE',
    'BLOCKQUOTE',
    'DIV',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'LI',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'TD',
    'TH',
    'TR',
    'UL',
  ]);
  const chunks: string[] = [];
  const walk = (node: Node, preformatted = false) => {
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push(
        (node.textContent ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(preformatted ? /\r\n?/g : /\s+/g, preformatted ? '\n' : ' '),
      );
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.tagName === 'BR') {
      chunks.push('\n');
      return;
    }
    const block = blocks.has(element.tagName);
    if (block) chunks.push('\n');
    for (const child of element.childNodes)
      walk(child, preformatted || element.tagName === 'PRE');
    if (block) chunks.push('\n');
  };
  walk(document.body ?? document.documentElement);
  const text = chunks
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error('当前阅读段落没有可用于出题的正文。');
  return text;
}

export function extractEpubSectionText(source: string): string {
  const text = extractEpubSectionPlainText(source).replace(/\s+/g, ' ').trim();
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
