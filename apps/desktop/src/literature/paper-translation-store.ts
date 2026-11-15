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

function legacyPage(
  pdfSha256: string,
  pageNumber: number,
): PaperPageTranslationRecord | null {
  try {
    const raw = localStorage.getItem(pageFallbackKey(pdfSha256, pageNumber));
    if (!raw) return null;
    const record = JSON.parse(raw) as PaperPageTranslationRecord;
    return record.pdfSha256 === pdfSha256.toLowerCase() &&
      record.pageNumber === pageNumber &&
      typeof record.pageContentHash === 'string' &&
      Number.isFinite(record.translatedAt) &&
      typeof record.model === 'string' &&
      Array.isArray(record.paragraphs) &&
      record.paragraphs.every(
        (paragraph) =>
          Number.isSafeInteger(paragraph.id) &&
          typeof paragraph.translation === 'string',
      )
      ? record
      : null;
  } catch {
    return null;
  }
}

function removeLegacyPage(pdfSha256: string, pageNumber: number): void {
  try {
    localStorage.removeItem(pageFallbackKey(pdfSha256, pageNumber));
  } catch {
    // The native store already holds the durable record.
  }
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
  const native = await invoke<PaperPageTranslationRecord | null>(
    'get_paper_page_translation',
    { pdfSha256, pageNumber },
  );
  const legacy = legacyPage(pdfSha256, pageNumber);
  if (native && (!legacy || native.translatedAt >= legacy.translatedAt)) {
    removeLegacyPage(pdfSha256, pageNumber);
    return native;
  }
  if (!legacy) return null;
  const migrated = await invoke<PaperPageTranslationRecord>(
    'save_paper_page_translation',
    {
      pdfSha256,
      pageNumber,
      pageContentHash: legacy.pageContentHash,
      model: legacy.model,
      paragraphs: legacy.paragraphs,
    },
  );
  removeLegacyPage(pdfSha256, pageNumber);
  return migrated;
}

export async function savePaperPageTranslation(
  pdfSha256: string,
  pageNumber: number,
  pageContentHash: string,
  model: string,
  paragraphs: TranslatedPaperParagraph[],
): Promise<PaperPageTranslationRecord> {
  const saved = await invoke<PaperPageTranslationRecord>(
    'save_paper_page_translation',
    { pdfSha256, pageNumber, pageContentHash, model, paragraphs },
  );
  removeLegacyPage(pdfSha256, pageNumber);
  return saved;
}

export async function deletePaperPageTranslation(
  pdfSha256: string,
  pageNumber: number,
): Promise<boolean> {
  const hadLegacy = legacyPage(pdfSha256, pageNumber) !== null;
  const deleted = await invoke<boolean>('delete_paper_page_translation', {
    pdfSha256,
    pageNumber,
  });
  removeLegacyPage(pdfSha256, pageNumber);
  return deleted || hadLegacy;
}

export async function clearPaperTranslations(
  pdfSha256: string,
): Promise<boolean> {
  const cleared = await invoke<boolean>('clear_paper_translations', {
    pdfSha256,
  });
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
    // The native store has already been cleared.
  }
  return cleared;
}

export async function listPaperTranslatedPages(
  pdfSha256: string,
): Promise<PaperPageTranslationSummary[]> {
  if (!pdfSha256) return [];
  const legacyPages: number[] = [];
  const prefix = `${LOCAL_PAGE_PREFIX}${pdfSha256.toLowerCase()}:`;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        const pageNumber = Number(key.slice(prefix.length));
        if (Number.isSafeInteger(pageNumber) && pageNumber > 0) {
          legacyPages.push(pageNumber);
        }
      }
    }
  } catch {
    // The native store remains available even if browser storage is blocked.
  }
  for (const pageNumber of legacyPages) {
    await getPaperPageTranslation(pdfSha256, pageNumber);
  }
  return invoke<PaperPageTranslationSummary[]>('list_paper_translated_pages', {
    pdfSha256,
  });
}
