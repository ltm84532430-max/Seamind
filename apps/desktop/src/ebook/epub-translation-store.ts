import { invoke } from '@tauri-apps/api/core';

export interface EpubParagraphTranslation {
  id: number;
  translation: string;
}

export interface EpubChapterTranslationRecord {
  schemaVersion: number;
  bookKey: string;
  sectionIndex: number;
  sectionHref?: string;
  chapterTitle?: string;
  translatedAt: number;
  model: string;
  paragraphs: EpubParagraphTranslation[];
}

export interface EpubChapterTranslationSummary {
  sectionIndex: number;
  sectionHref?: string;
  chapterTitle?: string;
  translatedAt: number;
  model: string;
  paragraphCount: number;
}

const LOCAL_STORAGE_PREFIX = 'seamind:epub-trans:v1:';

function getFallbackKey(bookKey: string, sectionIndex: number): string {
  return `${LOCAL_STORAGE_PREFIX}${encodeURIComponent(bookKey)}:${sectionIndex}`;
}

export async function getChapterTranslation(
  bookKey: string,
  sectionIndex: number,
): Promise<EpubChapterTranslationRecord | null> {
  try {
    const remote = await invoke<EpubChapterTranslationRecord | null>(
      'get_epub_chapter_translation',
      {
        bookKey,
        sectionIndex,
      },
    );
    if (remote) return remote;
  } catch {
    // Fall back to local storage if running in browser or backend unavailable
  }

  try {
    const raw = localStorage.getItem(getFallbackKey(bookKey, sectionIndex));
    if (raw) {
      return JSON.parse(raw) as EpubChapterTranslationRecord;
    }
  } catch {
    // Ignore parse error
  }
  return null;
}

export async function saveChapterTranslation(input: {
  bookKey: string;
  sectionIndex: number;
  sectionHref?: string;
  chapterTitle?: string;
  model: string;
  paragraphs: EpubParagraphTranslation[];
}): Promise<EpubChapterTranslationRecord> {
  try {
    const saved = await invoke<EpubChapterTranslationRecord>(
      'save_epub_chapter_translation',
      {
        bookKey: input.bookKey,
        sectionIndex: input.sectionIndex,
        sectionHref: input.sectionHref ?? null,
        chapterTitle: input.chapterTitle ?? null,
        model: input.model,
        paragraphs: input.paragraphs,
      },
    );
    // Also save a fallback copy in local storage
    try {
      localStorage.setItem(
        getFallbackKey(input.bookKey, input.sectionIndex),
        JSON.stringify(saved),
      );
    } catch {
      // Ignore quota error
    }
    return saved;
  } catch (error) {
    // Fallback to local storage
    const fallback: EpubChapterTranslationRecord = {
      schemaVersion: 1,
      bookKey: input.bookKey,
      sectionIndex: input.sectionIndex,
      sectionHref: input.sectionHref,
      chapterTitle: input.chapterTitle,
      translatedAt: Date.now(),
      model: input.model,
      paragraphs: input.paragraphs,
    };
    try {
      localStorage.setItem(
        getFallbackKey(input.bookKey, input.sectionIndex),
        JSON.stringify(fallback),
      );
      return fallback;
    } catch {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

export async function deleteChapterTranslation(
  bookKey: string,
  sectionIndex: number,
): Promise<boolean> {
  try {
    localStorage.removeItem(getFallbackKey(bookKey, sectionIndex));
  } catch {
    // Ignore
  }
  try {
    return await invoke<boolean>('delete_epub_chapter_translation', {
      bookKey,
      sectionIndex,
    });
  } catch {
    return true;
  }
}

export async function listBookTranslations(
  bookKey: string,
): Promise<EpubChapterTranslationSummary[]> {
  try {
    return await invoke<EpubChapterTranslationSummary[]>(
      'list_epub_book_translations',
      {
        bookKey,
      },
    );
  } catch {
    // Search localStorage
    const summaries: EpubChapterTranslationSummary[] = [];
    const prefix = `${LOCAL_STORAGE_PREFIX}${encodeURIComponent(bookKey)}:`;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          const raw = localStorage.getItem(key);
          if (raw) {
            const item = JSON.parse(raw) as EpubChapterTranslationRecord;
            summaries.push({
              sectionIndex: item.sectionIndex,
              sectionHref: item.sectionHref,
              chapterTitle: item.chapterTitle,
              translatedAt: item.translatedAt,
              model: item.model,
              paragraphCount: item.paragraphs?.length ?? 0,
            });
          }
        }
      }
    } catch {
      // Ignore
    }
    summaries.sort((a, b) => a.sectionIndex - b.sectionIndex);
    return summaries;
  }
}
