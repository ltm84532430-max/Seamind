import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  clearPaperTranslations,
  deletePaperPageTranslation,
  getCachedSelectionTranslation,
  getPaperPageTranslation,
  listPaperTranslatedPages,
  savePaperPageTranslation,
  setCachedSelectionTranslation,
  type PaperPageTranslationRecord,
} from '../src/literature/paper-translation-store';

function installMemoryLocalStorage() {
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key) => backing.get(key) ?? null,
    key: (index) => Array.from(backing.keys())[index] ?? null,
    removeItem: (key) => void backing.delete(key),
    setItem: (key, value) => void backing.set(key, String(value)),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
}

describe('paper-translation-store', () => {
  const sha = 'a'.repeat(64);
  const contentHash = 'b'.repeat(64);
  const key = `seamind:paper-trans:v1:${sha}:2`;
  const records = new Map<number, PaperPageTranslationRecord>();

  beforeEach(() => {
    installMemoryLocalStorage();
    records.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        const page = Number(args?.pageNumber);
        if (command === 'get_paper_page_translation')
          return records.get(page) ?? null;
        if (command === 'save_paper_page_translation') {
          const record: PaperPageTranslationRecord = {
            schemaVersion: 1,
            pdfSha256: sha,
            pageNumber: page,
            pageContentHash: String(args?.pageContentHash),
            translatedAt: Date.now(),
            model: String(args?.model),
            paragraphs:
              args?.paragraphs as PaperPageTranslationRecord['paragraphs'],
          };
          records.set(page, record);
          return record;
        }
        if (command === 'delete_paper_page_translation')
          return records.delete(page);
        if (command === 'clear_paper_translations') {
          records.clear();
          return true;
        }
        if (command === 'list_paper_translated_pages') {
          return Array.from(records.values()).map((record) => ({
            pageNumber: record.pageNumber,
            pageContentHash: record.pageContentHash,
            translatedAt: record.translatedAt,
            model: record.model,
            paragraphCount: record.paragraphs.length,
          }));
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
  });

  it('migrates an old browser record into the native store', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: 1,
        pdfSha256: sha,
        pageNumber: 2,
        pageContentHash: contentHash,
        translatedAt: 1,
        model: 'model',
        paragraphs: [{ id: 0, translation: 'translated' }],
      }),
    );

    expect(
      (await getPaperPageTranslation(sha, 2))?.paragraphs[0].translation,
    ).toBe('translated');
    expect(localStorage.getItem(key)).toBeNull();
    expect(records.has(2)).toBe(true);
    expect(
      (await listPaperTranslatedPages(sha)).map((page) => page.pageNumber),
    ).toEqual([2]);
  });

  it('keeps legacy data until native migration succeeds', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: 1,
        pdfSha256: sha,
        pageNumber: 2,
        pageContentHash: contentHash,
        model: 'model',
        paragraphs: [],
      }),
    );
    invokeMock.mockRejectedValue(new Error('database unavailable'));
    await expect(getPaperPageTranslation(sha, 2)).rejects.toThrow(
      'database unavailable',
    );
    expect(localStorage.getItem(key)).not.toBeNull();
    await expect(deletePaperPageTranslation(sha, 2)).rejects.toThrow(
      'database unavailable',
    );
    expect(localStorage.getItem(key)).not.toBeNull();
    await expect(clearPaperTranslations(sha)).rejects.toThrow(
      'database unavailable',
    );
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('replays a newer legacy write over an older native record', async () => {
    records.set(2, {
      schemaVersion: 1,
      pdfSha256: sha,
      pageNumber: 2,
      pageContentHash: contentHash,
      translatedAt: 1,
      model: 'old',
      paragraphs: [{ id: 0, translation: 'old' }],
    });
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: 1,
        pdfSha256: sha,
        pageNumber: 2,
        pageContentHash: contentHash,
        translatedAt: 2,
        model: 'new',
        paragraphs: [{ id: 0, translation: 'new' }],
      }),
    );
    expect(
      (await getPaperPageTranslation(sha, 2))?.paragraphs[0].translation,
    ).toBe('new');
    expect(records.get(2)?.paragraphs[0].translation).toBe('new');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('reports failed saves and retains ephemeral selection cache behavior', async () => {
    invokeMock.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      savePaperPageTranslation(sha, 2, contentHash, 'model', []),
    ).rejects.toThrow('disk full');
    expect(localStorage.getItem(key)).toBeNull();

    setCachedSelectionTranslation(sha, 'word', 'ablation', {
      mode: 'word',
      original: 'ablation',
      translation: 'translation',
    });
    expect(
      getCachedSelectionTranslation(sha, 'word', 'ablation')?.translation,
    ).toBe('translation');
  });
});
