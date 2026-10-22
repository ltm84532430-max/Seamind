import type { EpubBookMetadata, EpubReadingActivity } from './ebook-storage';

export interface LearningPathBook {
  id: string;
  progressKey: string;
  title: string;
  targetWords: number;
  baselineProgress: number;
  manualWords: number;
  dueDate: string;
}

export interface LearningPathStage {
  id: string;
  title: string;
  books: LearningPathBook[];
}

export interface LearningPath {
  id: string;
  title: string;
  stages: LearningPathStage[];
  createdAt: number;
}

const STORAGE_PREFIX = 'seamind:ebook-learning-paths:v1:';

export function learningPathId() {
  return crypto.randomUUID();
}

function validText(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function validWords(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100_000_000, Math.floor(value)))
    : 0;
}

export function loadLearningPaths(rootPath: string): LearningPath[] {
  if (!rootPath) return [];
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(
        `${STORAGE_PREFIX}${encodeURIComponent(rootPath)}`,
      ) ?? '[]',
    );
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 100).flatMap((path: unknown): LearningPath[] => {
      if (!path || typeof path !== 'object') return [];
      const value = path as Record<string, unknown>;
      const id = validText(value.id, 100);
      const title = validText(value.title, 120);
      if (!id || !title || !Array.isArray(value.stages)) return [];
      const stages = value.stages
        .slice(0, 100)
        .flatMap((stage: unknown): LearningPathStage[] => {
          if (!stage || typeof stage !== 'object') return [];
          const value = stage as Record<string, unknown>;
          const stageId = validText(value.id, 100);
          const stageTitle = validText(value.title, 120);
          if (!stageId || !stageTitle || !Array.isArray(value.books)) return [];
          const books = value.books
            .slice(0, 200)
            .flatMap((book: unknown): LearningPathBook[] => {
              if (!book || typeof book !== 'object') return [];
              const value = book as Record<string, unknown>;
              const bookId = validText(value.id, 100);
              const progressKey = validText(value.progressKey, 1000);
              const bookTitle = validText(value.title, 200);
              const targetWords = validWords(value.targetWords);
              if (!bookId || !progressKey || !bookTitle || !targetWords)
                return [];
              return [
                {
                  id: bookId,
                  progressKey,
                  title: bookTitle,
                  targetWords,
                  baselineProgress:
                    typeof value.baselineProgress === 'number' &&
                    Number.isFinite(value.baselineProgress)
                      ? Math.max(0, Math.min(1, value.baselineProgress))
                      : 0,
                  manualWords: validWords(value.manualWords),
                  dueDate:
                    typeof value.dueDate === 'string' &&
                    /^\d{4}-\d{2}-\d{2}$/.test(value.dueDate)
                      ? value.dueDate
                      : '',
                },
              ];
            });
          return [{ id: stageId, title: stageTitle, books }];
        });
      return [
        {
          id,
          title,
          stages,
          createdAt:
            typeof value.createdAt === 'number' &&
            Number.isFinite(value.createdAt)
              ? value.createdAt
              : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function saveLearningPaths(rootPath: string, paths: LearningPath[]) {
  if (!rootPath) return false;
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${encodeURIComponent(rootPath)}`,
      JSON.stringify(paths),
    );
    return true;
  } catch {
    return false;
  }
}

export function learningPathBookProgress(
  book: LearningPathBook,
  metadata: EpubBookMetadata | null,
  activity: EpubReadingActivity | null,
) {
  const furthest = Math.max(
    metadata?.progress ?? 0,
    activity?.furthestProgress ?? 0,
  );
  const estimatedWords = activity?.estimatedTotalWords ?? 0;
  const automaticWords = Math.max(
    0,
    Math.round((furthest - book.baselineProgress) * estimatedWords),
  );
  const completedWords = Math.min(
    book.targetWords,
    Math.max(book.manualWords, automaticWords),
  );
  return { completedWords, automaticWords, estimatedWords };
}
