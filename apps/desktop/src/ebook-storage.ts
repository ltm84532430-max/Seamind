import type { EpubBookDocument } from './library';

export interface EpubBookMetadata {
  title: string;
  author: string;
  coverDataUrl?: string;
  progress: number;
  lastReadAt: number;
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
  const next: EpubBookMetadata = {
    title: update.title ?? previous?.title ?? '',
    author: update.author ?? previous?.author ?? '',
    ...((update.coverDataUrl ?? previous?.coverDataUrl)
      ? { coverDataUrl: update.coverDataUrl ?? previous?.coverDataUrl }
      : {}),
    progress: update.progress ?? previous?.progress ?? 0,
    lastReadAt: update.lastReadAt ?? previous?.lastReadAt ?? 0,
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
        progress: next.progress,
        lastReadAt: next.lastReadAt,
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
  } catch {
    // The EPUB file deletion remains successful if browser storage is unavailable.
  }
}
