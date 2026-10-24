import type { EpubBookDocument } from './library';

export interface EpubBookMetadata {
  title: string;
  author: string;
  manualCategory?: string;
  coverDataUrl?: string;
  progress: number;
  lastReadAt: number;
  currentChapterHref?: string;
  currentChapterLabel?: string;
  currentChapterIndex?: number;
  chapterCount?: number;
}

export interface EpubReadingActivity {
  furthestProgress: number;
  estimatedTotalWords: number | null;
  dailyWords: Record<string, number>;
  pendingProgress: Record<string, number>;
  wordCountUnavailable: boolean;
}

export interface EpubReadingPlan {
  targetChapters: number;
  dueDate: string;
  startPending: boolean;
  startChapterIndex: number;
  startChapterHref: string;
  startChapterLabel: string;
  furthestChapterIndex: number;
  chapterCount: number;
  reachedBookEnd: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EpubBookmark {
  cfi: string;
  label: string;
  fraction: number;
  createdAt: number;
}

export type EpubAnnotationStyle = 'highlight' | 'underline' | 'squiggly';

export interface EpubAnnotation {
  id: string;
  cfi: string;
  sectionIndex: number;
  text: string;
  note: string;
  aiAnalysis?: string;
  color: string;
  style: EpubAnnotationStyle;
  label: string;
  fraction: number;
  createdAt: number;
  updatedAt: number;
}

const PROGRESS_PREFIX = 'seamind:epub-progress:v1:';
const SETTINGS_PREFIX = 'seamind:epub-settings:v1:';
const METADATA_PREFIX = 'seamind:epub-metadata:v1:';
const BOOKMARK_PREFIX = 'seamind:epub-bookmarks:v1:';
const ANNOTATION_PREFIX = 'seamind:epub-annotations:v1:';
const READING_ACTIVITY_PREFIX = 'seamind:epub-reading-activity:v1:';
const READING_PLAN_PREFIX = 'seamind:epub-reading-plan:v1:';

function suffix(progressKey: string) {
  return encodeURIComponent(progressKey);
}

export function epubProgressKey(book: EpubBookDocument) {
  return `library:${book.relativePath}:${book.fileSize}:${book.updatedAt}`;
}

export function loadEpubBookMetadata(
  progressKey: string,
): EpubBookMetadata | null {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(`${METADATA_PREFIX}${suffix(progressKey)}`) ??
        'null',
    );
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Partial<EpubBookMetadata>;
    return {
      title: typeof value.title === 'string' ? value.title : '',
      author: typeof value.author === 'string' ? value.author : '',
      ...(typeof value.manualCategory === 'string' &&
      value.manualCategory.trim()
        ? { manualCategory: value.manualCategory.trim() }
        : {}),
      ...(typeof value.coverDataUrl === 'string' &&
      value.coverDataUrl.startsWith('data:image/')
        ? { coverDataUrl: value.coverDataUrl }
        : {}),
      progress:
        typeof value.progress === 'number' && Number.isFinite(value.progress)
          ? Math.max(0, Math.min(1, value.progress))
          : 0,
      lastReadAt:
        typeof value.lastReadAt === 'number' &&
        Number.isFinite(value.lastReadAt)
          ? value.lastReadAt
          : 0,
      ...(typeof value.currentChapterHref === 'string'
        ? { currentChapterHref: value.currentChapterHref }
        : {}),
      ...(typeof value.currentChapterLabel === 'string'
        ? { currentChapterLabel: value.currentChapterLabel }
        : {}),
      ...(typeof value.currentChapterIndex === 'number' &&
      Number.isFinite(value.currentChapterIndex)
        ? {
            currentChapterIndex: Math.max(
              0,
              Math.floor(value.currentChapterIndex),
            ),
          }
        : {}),
      ...(typeof value.chapterCount === 'number' &&
      Number.isFinite(value.chapterCount)
        ? { chapterCount: Math.max(0, Math.floor(value.chapterCount)) }
        : {}),
    };
  } catch {
    return null;
  }
}

export function saveEpubBookMetadata(
  progressKey: string,
  update: Partial<EpubBookMetadata>,
) {
  const previous = loadEpubBookMetadata(progressKey);
  const manualCategory = update.manualCategory ?? previous?.manualCategory;
  const next: EpubBookMetadata = {
    title: update.title ?? previous?.title ?? '',
    author: update.author ?? previous?.author ?? '',
    ...(manualCategory?.trim()
      ? { manualCategory: manualCategory.trim() }
      : {}),
    ...((update.coverDataUrl ?? previous?.coverDataUrl)
      ? { coverDataUrl: update.coverDataUrl ?? previous?.coverDataUrl }
      : {}),
    progress: update.progress ?? previous?.progress ?? 0,
    lastReadAt: update.lastReadAt ?? previous?.lastReadAt ?? 0,
    ...((update.currentChapterHref ?? previous?.currentChapterHref)
      ? {
          currentChapterHref:
            update.currentChapterHref ?? previous?.currentChapterHref,
        }
      : {}),
    ...((update.currentChapterLabel ?? previous?.currentChapterLabel)
      ? {
          currentChapterLabel:
            update.currentChapterLabel ?? previous?.currentChapterLabel,
        }
      : {}),
    ...((update.currentChapterIndex ?? previous?.currentChapterIndex) !==
    undefined
      ? {
          currentChapterIndex:
            update.currentChapterIndex ?? previous?.currentChapterIndex,
        }
      : {}),
    ...((update.chapterCount ?? previous?.chapterCount) !== undefined
      ? { chapterCount: update.chapterCount ?? previous?.chapterCount }
      : {}),
  };
  const key = `${METADATA_PREFIX}${suffix(progressKey)}`;
  try {
    localStorage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    if (!next.coverDataUrl) return false;
    try {
      const withoutCover: Omit<EpubBookMetadata, 'coverDataUrl'> = {
        title: next.title,
        author: next.author,
        ...(next.manualCategory ? { manualCategory: next.manualCategory } : {}),
        progress: next.progress,
        lastReadAt: next.lastReadAt,
        ...(next.currentChapterHref
          ? { currentChapterHref: next.currentChapterHref }
          : {}),
        ...(next.currentChapterLabel
          ? { currentChapterLabel: next.currentChapterLabel }
          : {}),
        ...(next.currentChapterIndex !== undefined
          ? { currentChapterIndex: next.currentChapterIndex }
          : {}),
        ...(next.chapterCount !== undefined
          ? { chapterCount: next.chapterCount }
          : {}),
      };
      localStorage.setItem(key, JSON.stringify(withoutCover));
      return false;
    } catch {
      return false;
    }
  }
}

export function loadEpubBookmarks(progressKey: string): EpubBookmark[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(`${BOOKMARK_PREFIX}${suffix(progressKey)}`) ?? '[]',
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is EpubBookmark =>
        Boolean(value) &&
        typeof value === 'object' &&
        typeof value.cfi === 'string' &&
        typeof value.label === 'string' &&
        typeof value.fraction === 'number' &&
        Number.isFinite(value.fraction) &&
        typeof value.createdAt === 'number' &&
        Number.isFinite(value.createdAt),
    );
  } catch {
    return [];
  }
}

export function saveEpubBookmarks(
  progressKey: string,
  bookmarks: EpubBookmark[],
) {
  try {
    localStorage.setItem(
      `${BOOKMARK_PREFIX}${suffix(progressKey)}`,
      JSON.stringify(bookmarks),
    );
  } catch {
    // Keep the current session usable when browser storage is unavailable.
  }
}

export function loadEpubAnnotations(progressKey: string): EpubAnnotation[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(`${ANNOTATION_PREFIX}${suffix(progressKey)}`) ??
        '[]',
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (value): value is EpubAnnotation =>
          Boolean(value) &&
          typeof value === 'object' &&
          typeof value.id === 'string' &&
          typeof value.cfi === 'string' &&
          typeof value.sectionIndex === 'number' &&
          Number.isFinite(value.sectionIndex) &&
          typeof value.text === 'string' &&
          typeof value.note === 'string' &&
          typeof value.color === 'string' &&
          typeof value.label === 'string' &&
          typeof value.fraction === 'number' &&
          Number.isFinite(value.fraction) &&
          typeof value.createdAt === 'number' &&
          Number.isFinite(value.createdAt) &&
          typeof value.updatedAt === 'number' &&
          Number.isFinite(value.updatedAt),
      )
      .map((annotation): EpubAnnotation => {
        const style: EpubAnnotationStyle =
          annotation.style === 'underline' || annotation.style === 'squiggly'
            ? annotation.style
            : 'highlight';
        const aiAnalysis =
          typeof annotation.aiAnalysis === 'string'
            ? annotation.aiAnalysis.trim().slice(0, 800)
            : '';
        return {
          ...annotation,
          style,
          ...(aiAnalysis ? { aiAnalysis } : {}),
        };
      })
      .slice(0, 500);
  } catch {
    return [];
  }
}

export function saveEpubAnnotations(
  progressKey: string,
  annotations: EpubAnnotation[],
) {
  try {
    localStorage.setItem(
      `${ANNOTATION_PREFIX}${suffix(progressKey)}`,
      JSON.stringify(annotations),
    );
  } catch {
    // Keep the current session usable when browser storage is unavailable.
  }
}

export function clearEpubReaderData(progressKey: string) {
  const key = suffix(progressKey);
  try {
    localStorage.removeItem(`${PROGRESS_PREFIX}${key}`);
    localStorage.removeItem(`${SETTINGS_PREFIX}${key}`);
    localStorage.removeItem(`${METADATA_PREFIX}${key}`);
    localStorage.removeItem(`${BOOKMARK_PREFIX}${key}`);
    localStorage.removeItem(`${ANNOTATION_PREFIX}${key}`);
    localStorage.removeItem(`${READING_ACTIVITY_PREFIX}${key}`);
    localStorage.removeItem(`${READING_PLAN_PREFIX}${key}`);
  } catch {
    // The EPUB file deletion remains successful if browser storage is unavailable.
  }
}

function clampProgress(progress: number) {
  return Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
}

function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readActivity(progressKey: string): EpubReadingActivity | null {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(
        `${READING_ACTIVITY_PREFIX}${suffix(progressKey)}`,
      ) ?? 'null',
    );
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Partial<EpubReadingActivity>;
    const dailyWords: Record<string, number> = {};
    if (value.dailyWords && typeof value.dailyWords === 'object') {
      for (const [date, words] of Object.entries(value.dailyWords)) {
        if (
          /^\d{4}-\d{2}-\d{2}$/.test(date) &&
          typeof words === 'number' &&
          Number.isFinite(words) &&
          words > 0
        ) {
          dailyWords[date] = Math.round(words);
        }
      }
    }
    const pendingProgress: Record<string, number> = {};
    if (value.pendingProgress && typeof value.pendingProgress === 'object') {
      for (const [date, progress] of Object.entries(value.pendingProgress)) {
        if (
          /^\d{4}-\d{2}-\d{2}$/.test(date) &&
          typeof progress === 'number' &&
          Number.isFinite(progress) &&
          progress > 0
        ) {
          pendingProgress[date] = progress;
        }
      }
    }
    return {
      furthestProgress: clampProgress(
        typeof value.furthestProgress === 'number' ? value.furthestProgress : 0,
      ),
      estimatedTotalWords:
        typeof value.estimatedTotalWords === 'number' &&
        Number.isFinite(value.estimatedTotalWords)
          ? Math.max(0, Math.floor(value.estimatedTotalWords))
          : null,
      dailyWords,
      pendingProgress,
      wordCountUnavailable: value.wordCountUnavailable === true,
    };
  } catch {
    return null;
  }
}

function saveActivity(progressKey: string, activity: EpubReadingActivity) {
  try {
    localStorage.setItem(
      `${READING_ACTIVITY_PREFIX}${suffix(progressKey)}`,
      JSON.stringify(activity),
    );
  } catch {
    // Reading remains available when local storage is full or disabled.
  }
}

export function loadEpubReadingActivity(
  progressKey: string,
): EpubReadingActivity | null {
  return readActivity(progressKey);
}

export function recordEpubReadingProgress(
  progressKey: string,
  progress: number,
  baselineProgress: number,
) {
  const current = clampProgress(progress);
  const activity = readActivity(progressKey) ?? {
    furthestProgress: clampProgress(baselineProgress),
    estimatedTotalWords: null,
    dailyWords: {},
    pendingProgress: {},
    wordCountUnavailable: false,
  };
  const delta = current - activity.furthestProgress;
  if (delta <= 0) {
    saveActivity(progressKey, activity);
    return activity;
  }

  activity.furthestProgress = current;
  const date = localDateKey();
  if (activity.estimatedTotalWords === null) {
    activity.pendingProgress[date] =
      (activity.pendingProgress[date] ?? 0) + delta;
  } else if (activity.estimatedTotalWords > 0) {
    activity.dailyWords[date] =
      (activity.dailyWords[date] ?? 0) +
      Math.max(1, Math.round(delta * activity.estimatedTotalWords));
  }
  saveActivity(progressKey, activity);
  return activity;
}

export function saveEpubReadingWordEstimate(
  progressKey: string,
  totalWords: number,
  baselineProgress: number,
) {
  const activity = readActivity(progressKey) ?? {
    furthestProgress: clampProgress(baselineProgress),
    estimatedTotalWords: null,
    dailyWords: {},
    pendingProgress: {},
    wordCountUnavailable: false,
  };
  const estimate = Math.max(0, Math.floor(totalWords));
  activity.estimatedTotalWords = estimate;
  activity.wordCountUnavailable = estimate === 0;
  if (estimate > 0) {
    for (const [date, delta] of Object.entries(activity.pendingProgress)) {
      const words = Math.round(delta * estimate);
      if (words > 0) {
        activity.dailyWords[date] = (activity.dailyWords[date] ?? 0) + words;
      }
    }
  }
  activity.pendingProgress = {};
  saveActivity(progressKey, activity);
  return activity;
}

export function loadEpubReadingPlan(
  progressKey: string,
): EpubReadingPlan | null {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(`${READING_PLAN_PREFIX}${suffix(progressKey)}`) ??
        'null',
    );
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Partial<EpubReadingPlan>;
    if (
      typeof value.targetChapters !== 'number' ||
      !Number.isFinite(value.targetChapters) ||
      typeof value.dueDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.dueDate)
    ) {
      return null;
    }
    return {
      targetChapters: Math.max(1, Math.floor(value.targetChapters)),
      dueDate: value.dueDate,
      startPending: value.startPending === true,
      startChapterIndex:
        typeof value.startChapterIndex === 'number' &&
        Number.isFinite(value.startChapterIndex)
          ? Math.max(0, Math.floor(value.startChapterIndex))
          : 0,
      startChapterHref:
        typeof value.startChapterHref === 'string'
          ? value.startChapterHref
          : '',
      startChapterLabel:
        typeof value.startChapterLabel === 'string'
          ? value.startChapterLabel
          : '',
      furthestChapterIndex:
        typeof value.furthestChapterIndex === 'number' &&
        Number.isFinite(value.furthestChapterIndex)
          ? Math.max(0, Math.floor(value.furthestChapterIndex))
          : 0,
      chapterCount:
        typeof value.chapterCount === 'number' &&
        Number.isFinite(value.chapterCount)
          ? Math.max(0, Math.floor(value.chapterCount))
          : 0,
      reachedBookEnd: value.reachedBookEnd === true,
      createdAt:
        typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
          ? value.createdAt
          : Date.now(),
      updatedAt:
        typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
          ? value.updatedAt
          : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveEpubReadingPlan(
  progressKey: string,
  plan: EpubReadingPlan,
): boolean {
  try {
    localStorage.setItem(
      `${READING_PLAN_PREFIX}${suffix(progressKey)}`,
      JSON.stringify(plan),
    );
    return true;
  } catch {
    return false;
  }
}

export function deleteEpubReadingPlan(progressKey: string) {
  try {
    localStorage.removeItem(`${READING_PLAN_PREFIX}${suffix(progressKey)}`);
  } catch {
    // Ignore unavailable browser storage.
  }
}

export function recordEpubChapterProgress(
  progressKey: string,
  chapterIndex: number,
  chapterCount: number,
  progress: number,
  chapterHref = '',
  chapterLabel = '',
) {
  const plan = loadEpubReadingPlan(progressKey);
  if (!plan) return;
  const index = Math.max(0, Math.floor(chapterIndex));
  if (plan.startPending) {
    plan.startPending = false;
    plan.startChapterIndex = index;
    plan.startChapterHref = chapterHref;
    plan.startChapterLabel = chapterLabel || `第 ${index + 1} 章`;
    plan.furthestChapterIndex = index;
    plan.chapterCount = Math.max(plan.chapterCount, Math.floor(chapterCount));
    plan.updatedAt = Date.now();
    saveEpubReadingPlan(progressKey, plan);
    return;
  }
  plan.furthestChapterIndex = Math.max(plan.furthestChapterIndex, index);
  plan.chapterCount = Math.max(plan.chapterCount, Math.floor(chapterCount));
  plan.reachedBookEnd = plan.reachedBookEnd || progress >= 0.999;
  plan.updatedAt = Date.now();
  saveEpubReadingPlan(progressKey, plan);
}

export function getEpubReadingPlanCompleted(plan: EpubReadingPlan) {
  const passed = Math.max(
    0,
    plan.furthestChapterIndex - plan.startChapterIndex,
  );
  const completedAtEnd = plan.reachedBookEnd
    ? Math.max(0, plan.chapterCount - plan.startChapterIndex)
    : 0;
  return Math.min(plan.targetChapters, Math.max(passed, completedAtEnd));
}
