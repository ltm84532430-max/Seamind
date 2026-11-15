import { invoke } from '@tauri-apps/api/core';

export interface TranslatedPaperParagraph {
  id: number;
  translation: string;
}

export interface PaperPageTranslationRecord {
  schemaVersion: number;
  pdfSha256: string;
  pageNumber: number;
  pageContentHash: string;
  translatedAt: number;
  model: string;
  paragraphs: TranslatedPaperParagraph[];
}

export interface PaperPageTranslationSummary {
  pageNumber: number;
  pageContentHash: string;
  translatedAt: number;
  model: string;
  paragraphCount: number;
}

export interface PaperSelectionTranslation {
  mode: 'word' | 'passage' | string;
  original: string;
  translation: string;
  phoneticOrPos?: string | null;
  termNote?: string | null;
}

export interface Pdf2ZhStatus {
  available: boolean;
  engine?: string | null;
  version?: string | null;
  message: string;
}

export interface DualPdfResult {
  dualPdfPath: string;
  dualPdfSha256: string;
  cached: boolean;
  engine: string;
}

const LOCAL_PAGE_PREFIX = 'seamind:paper-trans:v1:';
const LOCAL_SELECTION_PREFIX = 'seamind:paper-sel-trans:v1:';
const MEMORY_SELECTION_CACHE = new Map<string, PaperSelectionTranslation>();

function pageFallbackKey(pdfSha256: string, pageNumber: number): string {
  return `${LOCAL_PAGE_PREFIX}${pdfSha256.toLowerCase()}:${pageNumber}`;
}

function selectionCacheKey(
  pdfSha256: string,
  mode: string,
  text: string,
): string {
  const compact = text.replace(/\s+/g, ' ').trim().slice(0, 500);
  return `${LOCAL_SELECTION_PREFIX}${pdfSha256.toLowerCase()}:${mode}:${compact}`;
}

export function getCachedSelectionTranslation(
  pdfSha256: string,
  mode: string,
  text: string,
): PaperSelectionTranslation | null {
  const key = selectionCacheKey(pdfSha256, mode, text);
  const inMemory = MEMORY_SELECTION_CACHE.get(key);
  if (inMemory) return inMemory;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PaperSelectionTranslation;
    if (!parsed || typeof parsed.translation !== 'string') return null;
    MEMORY_SELECTION_CACHE.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function setCachedSelectionTranslation(
  pdfSha256: string,
  mode: string,
  text: string,
  result: PaperSelectionTranslation,
): void {
  const key = selectionCacheKey(pdfSha256, mode, text);
  if (MEMORY_SELECTION_CACHE.size > 200) {
    const oldestKey = MEMORY_SELECTION_CACHE.keys().next().value;
    if (oldestKey) MEMORY_SELECTION_CACHE.delete(oldestKey);
  }
  MEMORY_SELECTION_CACHE.set(key, result);
  try {
    localStorage.setItem(key, JSON.stringify(result));
  } catch {
    // Ignore quota errors
  }
}

export async function getPaperPageTranslation(
  pdfSha256: string,
  pageNumber: number,
): Promise<PaperPageTranslationRecord | null> {
  if (!pdfSha256) return null;
  try {
    return await invoke<PaperPageTranslationRecord | null>(
      'get_paper_page_translation',
      { pdfSha256, pageNumber },
    );
  } catch {
    try {
      const raw = localStorage.getItem(pageFallbackKey(pdfSha256, pageNumber));
      return raw ? (JSON.parse(raw) as PaperPageTranslationRecord) : null;
    } catch {
      return null;
    }
  }
}

export async function savePaperPageTranslation(
  pdfSha256: string,
  pageNumber: number,
  pageContentHash: string,
  model: string,
  paragraphs: TranslatedPaperParagraph[],
): Promise<PaperPageTranslationRecord> {
  const fallbackRecord: PaperPageTranslationRecord = {
    schemaVersion: 1,
    pdfSha256: pdfSha256.toLowerCase(),
    pageNumber,
    pageContentHash: pageContentHash.toLowerCase(),
    translatedAt: Date.now(),
    model,
    paragraphs,
  };
  try {
    localStorage.setItem(
      pageFallbackKey(pdfSha256, pageNumber),
      JSON.stringify(fallbackRecord),
    );
  } catch {
    // Ignore quota errors
  }
  try {
    return await invoke<PaperPageTranslationRecord>(
      'save_paper_page_translation',
      {
        pdfSha256,
        pageNumber,
        pageContentHash,
        model,
        paragraphs,
      },
    );
  } catch {
    return fallbackRecord;
  }
}

export async function deletePaperPageTranslation(
  pdfSha256: string,
  pageNumber: number,
): Promise<boolean> {
  try {
    localStorage.removeItem(pageFallbackKey(pdfSha256, pageNumber));
  } catch {
    // Ignore
  }
  try {
    return await invoke<boolean>('delete_paper_page_translation', {
      pdfSha256,
      pageNumber,
    });
  } catch {
    return true;
  }
}

export async function clearPaperTranslations(
  pdfSha256: string,
): Promise<boolean> {
  try {
    const prefix = `${LOCAL_PAGE_PREFIX}${pdfSha256.toLowerCase()}:`;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        toRemove.push(key);
      }
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Ignore
  }
  try {
    return await invoke<boolean>('clear_paper_translations', { pdfSha256 });
  } catch {
    return true;
  }
}

export async function listPaperTranslatedPages(
  pdfSha256: string,
): Promise<PaperPageTranslationSummary[]> {
  if (!pdfSha256) return [];
  try {
    return await invoke<PaperPageTranslationSummary[]>(
      'list_paper_translated_pages',
      { pdfSha256 },
    );
  } catch {
    const summaries: PaperPageTranslationSummary[] = [];
    const prefix = `${LOCAL_PAGE_PREFIX}${pdfSha256.toLowerCase()}:`;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const item = JSON.parse(raw) as PaperPageTranslationRecord;
          summaries.push({
            pageNumber: item.pageNumber,
            pageContentHash: item.pageContentHash,
            translatedAt: item.translatedAt,
            model: item.model,
            paragraphCount: item.paragraphs?.length ?? 0,
          });
        }
      }
    } catch {
      // Ignore
    }
    summaries.sort((a, b) => a.pageNumber - b.pageNumber);
    return summaries;
  }
}
