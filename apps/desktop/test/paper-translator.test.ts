import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const readProviderMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('../src/app/app-storage', () => ({
  readProviderSettings: () => readProviderMock(),
}));

import {
  checkPdf2ZhStatus,
  generateBilingualPaperPdf,
  translatePaperPage,
  translatePaperSelection,
} from '../src/literature/paper-translator';
import type { PaperParagraphBlock } from '../src/literature/paper-pdf-layout';

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

function makeBlocks(count: number): PaperParagraphBlock[] {
  return Array.from({ length: count }, (_, id) => ({
    id,
    pageNumber: 1,
    column: 'full',
    text: `Paragraph ${id} discusses explainability metrics.`,
    bbox: { x: 0.1, y: 0.1 + id * 0.03, width: 0.8, height: 0.02 },
    rects: [{ x: 0.1, y: 0.1 + id * 0.03, width: 0.8, height: 0.02 }],
    isHeading: false,
  }));
}

describe('paper-translator', () => {
  const sha = 'e'.repeat(64);

  beforeEach(() => {
    installMemoryLocalStorage();
    invokeMock.mockReset();
    readProviderMock.mockReset();
    readProviderMock.mockReturnValue({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
    });
  });

  it('auto-detects word mode, caches selection lookups, and validates provider settings', async () => {
    invokeMock.mockResolvedValueOnce({
      mode: 'word',
      original: 'salience',
      translation: '显著性；突出性',
      phoneticOrPos: 'n.',
      termNote: '表示归因权重高低',
    });

    const first = await translatePaperSelection({
      pdfSha256: sha,
      paperTitle: 'XAI Study',
      text: 'salience',
    });
    expect(first.translation).toBe('显著性；突出性');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      'translate_paper_selection',
      expect.objectContaining({ mode: 'word', paperTitle: 'XAI Study' }),
    );

    const second = await translatePaperSelection({
      pdfSha256: sha,
      paperTitle: 'XAI Study',
      text: 'salience',
    });
    expect(second).toEqual(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    readProviderMock.mockReturnValue({ baseUrl: '', model: '' });
    await expect(
      translatePaperSelection({
        pdfSha256: sha,
        paperTitle: 'XAI Study',
        text: 'uncached sentence that requires provider',
      }),
    ).rejects.toThrow(/模型/);
  });

  it('batches paragraphs into slices of 10, retries transient failures, supports cancellation and hits cache on rerun', async () => {
    const blocks = makeBlocks(23);
    let translateCalls = 0;

    invokeMock.mockImplementation(
      async (cmd: string, payload: Record<string, unknown>) => {
        if (cmd === 'get_paper_page_translation') return null;
        if (cmd === 'translate_paper_paragraphs') {
          translateCalls += 1;
          if (translateCalls === 2) {
            throw new Error('temporary network hiccup');
          }
          const batch = payload.paragraphs as Array<{
            id: number;
            text: string;
          }>;
          return batch.map((p) => ({
            id: p.id,
            translation: `中文段落 ${p.id}`,
          }));
        }
        if (cmd === 'save_paper_page_translation') {
          return {
            schemaVersion: 1,
            pdfSha256: payload.pdfSha256,
            pageNumber: payload.pageNumber,
            pageContentHash: payload.pageContentHash,
            translatedAt: 123456,
            model: payload.model,
            paragraphs: payload.paragraphs,
          };
        }
        throw new Error(`unexpected command ${cmd}`);
      },
    );

    const progressEvents: Array<[number, number]> = [];
    const saved = await translatePaperPage({
      paperTitle: 'XAI Study',
      pdfSha256: sha,
      pageNumber: 1,
      blocks,
      onProgress: (done, total) => progressEvents.push([done, total]),
    });

    expect(saved.paragraphs.length).toBe(23);
    expect(translateCalls).toBe(4);
    expect(progressEvents).toEqual([
      [0, 23],
      [10, 23],
      [20, 23],
      [23, 23],
    ]);

    // Rerun hits get_paper_page_translation cache
    invokeMock.mockImplementationOnce(async () => saved);
    const rerun = await translatePaperPage({
      paperTitle: 'XAI Study',
      pdfSha256: sha,
      pageNumber: 1,
      blocks,
    });
    expect(rerun.paragraphs.length).toBe(23);
    expect(translateCalls).toBe(4);

    // Cancelled translate stops before sending batches
    await expect(
      translatePaperPage({
        paperTitle: 'XAI Study',
        pdfSha256: sha,
        pageNumber: 1,
        blocks,
        force: true,
        isCancelled: () => true,
      }),
    ).rejects.toThrow(/已取消/);
  });

  it('forwards Phase 3 pdf2zh commands accurately', async () => {
    invokeMock.mockResolvedValueOnce({
      available: true,
      engine: 'pdf2zh',
      version: '1.9.10',
      message: 'ready',
    });
    const status = await checkPdf2ZhStatus();
    expect(status.available).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('check_pdf2zh_status');

    invokeMock.mockResolvedValueOnce({
      dualPdfPath: 'C:/dual/out-dual.pdf',
      dualPdfSha256: sha,
      cached: false,
      engine: 'pdf2zh',
    });
    const res = await generateBilingualPaperPdf('paper-1', {
      service: 'openai',
      force: true,
    });
    expect(res.dualPdfPath).toBe('C:/dual/out-dual.pdf');
    expect(invokeMock).toHaveBeenCalledWith('generate_bilingual_paper_pdf', {
      paperId: 'paper-1',
      service: 'openai',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      force: true,
    });
  });
});
