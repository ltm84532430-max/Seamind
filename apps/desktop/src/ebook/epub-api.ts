import { invoke } from '@tauri-apps/api/core';
import type { ExamCodeResult } from '../exams/EpubExamQuestion';
import type {
  EpubExam,
  EpubExamAnswer,
  EpubExamDifficulty,
  EpubExamGrade,
  EpubExamQuestion,
  EpubExamSelfReview,
  EpubExamSummary,
} from '../exams/epub-exams';
import type { ExamBatch, ExamMix } from '../exams/epub-exam-generation';
import type {
  EpubChapterTranslationRecord,
  EpubChapterTranslationSummary,
  EpubParagraphTranslation,
} from './epub-translation-store';

export interface EpubOutline {
  title: string;
  markdown: string;
  chapterCount: number;
  sectionCount: number;
  enrichedChapterCount: number;
  skippedChapterCount: number;
  warnings: string[];
  sourceFile: string;
}

export interface EpubSummaryResult {
  markdown: string;
  summarizedChapterCount: number;
  unavailableChapterCount: number;
  omittedChapterCount: number;
  truncatedChapterCount: number;
  notSummarizedChapterCount: number;
}

export const epubApi = {
  importToc: (args: { path: string }) =>
    invoke<EpubOutline>('import_epub_toc', args),
  summarizeChapters: (args: {
    path: string;
    baseUrl: string;
    model: string;
    markdown: string;
  }) => invoke<EpubSummaryResult>('summarize_epub_chapters', args),
  analyzeHighlight: (args: {
    baseUrl: string;
    model: string;
    chapterLabel: string;
    selectionText: string;
    context: string;
    responseFormat: string;
    userQuestion: string;
  }) => invoke<string>('analyze_epub_highlight', args),
  generateExamBatch: (args: {
    bookTitle: string;
    scopeLabel: string;
    sources: ExamBatch['sources'];
    mix: ExamMix;
    avoidPrompts: string[];
    difficulty: EpubExamDifficulty;
    baseUrl: string;
    model: string;
  }) => invoke<EpubExamQuestion[]>('generate_epub_exam_batch', args),
  saveExam: (args: { exam: EpubExam }) => invoke<void>('save_epub_exam', args),
  listExams: (args: { bookKey: string | null }) =>
    invoke<EpubExamSummary[]>('list_epub_exams', args),
  getExam: (args: { bookKey: string; examId: string }) =>
    invoke<EpubExam>('get_epub_exam', args),
  saveExamProgress: (args: {
    bookKey: string;
    examId: string;
    answers: Record<string, EpubExamAnswer>;
    selfReviews: Record<string, EpubExamSelfReview>;
    submitted: boolean;
  }) => invoke<EpubExam>('save_epub_exam_progress', args),
  runExamCode: (args: {
    bookKey: string;
    examId: string;
    questionId: string;
    source: string;
  }) => invoke<ExamCodeResult>('run_epub_exam_code', args),
  gradeSubjective: (args: {
    bookKey: string;
    examId: string;
    baseUrl: string;
    model: string;
  }) =>
    invoke<Record<string, EpubExamGrade>>('grade_epub_exam_subjective', args),
  overrideGrade: (args: {
    bookKey: string;
    examId: string;
    questionId: string;
    earned: number;
  }) => invoke<EpubExamGrade>('override_epub_exam_grade', args),
  restartExam: (args: { bookKey: string; examId: string }) =>
    invoke<EpubExam>('restart_epub_exam', args),
  deleteExam: (args: { bookKey: string; examId: string }) =>
    invoke<void>('delete_epub_exam', args),
  getChapterTranslation: (args: { bookKey: string; sectionIndex: number }) =>
    invoke<EpubChapterTranslationRecord | null>(
      'get_epub_chapter_translation',
      args,
    ),
  saveChapterTranslation: (args: {
    bookKey: string;
    sectionIndex: number;
    sectionHref: string | null;
    chapterTitle: string | null;
    model: string;
    paragraphs: EpubParagraphTranslation[];
  }) =>
    invoke<EpubChapterTranslationRecord>('save_epub_chapter_translation', args),
  deleteChapterTranslation: (args: { bookKey: string; sectionIndex: number }) =>
    invoke<boolean>('delete_epub_chapter_translation', args),
  listBookTranslations: (args: { bookKey: string }) =>
    invoke<EpubChapterTranslationSummary[]>(
      'list_epub_book_translations',
      args,
    ),
  translateParagraphs: (args: {
    baseUrl: string;
    model: string;
    bookTitle: string;
    chapterTitle: string;
    paragraphs: Array<{ id: number; text: string }>;
  }) => invoke<EpubParagraphTranslation[]>('translate_epub_paragraphs', args),
};
