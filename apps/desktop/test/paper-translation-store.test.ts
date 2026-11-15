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
} from '../src/literature/paper-translation-store';

function installMemoryLocalStorage() {
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(key: string) {
      return backing.has(key) ? backing.get(key)! : null;
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null;
    },
    removeItem(key: string) {
      backing.delete(key);
    },
    setItem(key: string, value: string) {
      backing.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
}

describe('paper-translation-store', () => {
  const sha = 'a'.repeat(64);
  const contentHash = 'b'.repeat(64);

  beforeEach(() => {
    installMemoryLocalStorage();
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error('no tauri runtime in unit test'));
  });

  it('persists and retrieves page translations via localStorage fallback', async () => {
    const saved = await savePaperPageTranslation(
      sha,
      2,
      contentHash,
      'gpt-4o-mini',
      [{ id: 0, translation: '第一段中文译文' }],
    );
    expect(saved.pageNumber).toBe(2);

    const loaded = await getPaperPageTranslation(sha, 2);
    expect(loaded?.paragraphs).toEqual([
      { id: 0, translation: '第一段中文译文' },
    ]);

    const pages = await listPaperTranslatedPages(sha);
    expect(pages.length).toBe(1);
    expect(pages[0].pageNumber).toBe(2);

    await deletePaperPageTranslation(sha, 2);
    expect(await getPaperPageTranslation(sha, 2)).toBeNull();
  });

  it('clears all cached pages for a PDF and caches selection lookups', async () => {
    await savePaperPageTranslation(sha, 1, contentHash, 'm', [
      { id: 0, translation: '一' },
    ]);
    await savePaperPageTranslation(sha, 3, contentHash, 'm', [
      { id: 0, translation: '三' },
    ]);
    await clearPaperTranslations(sha);
    expect(await listPaperTranslatedPages(sha)).toEqual([]);

    setCachedSelectionTranslation(sha, 'word', 'ablation', {
      mode: 'word',
      original: 'ablation',
      translation: '消融实验',
      phoneticOrPos: 'n.',
      termNote: '移除某模块以验证其贡献',
    });
    const hit = getCachedSelectionTranslation(sha, 'word', 'ablation');
    expect(hit?.translation).toBe('消融实验');
  });
});
