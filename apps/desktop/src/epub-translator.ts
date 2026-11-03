import { invoke } from '@tauri-apps/api/core';
import type { EpubParagraphTranslation } from './epub-translation-store';

export interface TranslateChapterOptions {
  bookTitle: string;
  chapterTitle: string;
  paragraphs: Array<{ id: number; text: string }>;
  provider: { baseUrl: string; model: string };
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function translateChapterBatch(
  batch: Array<{ id: number; text: string }>,
  options: {
    bookTitle: string;
    chapterTitle: string;
    provider: { baseUrl: string; model: string };
  },
): Promise<EpubParagraphTranslation[]> {
  return invoke<EpubParagraphTranslation[]>('translate_epub_paragraphs', {
    baseUrl: options.provider.baseUrl,
    model: options.provider.model,
    bookTitle: options.bookTitle,
    chapterTitle: options.chapterTitle,
    paragraphs: batch,
  });
}

export async function translateChapterAll(
  options: TranslateChapterOptions,
): Promise<EpubParagraphTranslation[]> {
  const {
    bookTitle,
    chapterTitle,
    paragraphs,
    provider,
    batchSize = 12,
    onProgress,
  } = options;

  if (paragraphs.length === 0) return [];

  const results: EpubParagraphTranslation[] = [];
  const total = paragraphs.length;
  let done = 0;

  for (let i = 0; i < paragraphs.length; i += batchSize) {
    const chunk = paragraphs.slice(i, i + batchSize);
    let attempts = 0;
    let translated: EpubParagraphTranslation[] | null = null;
    let lastError: unknown = null;

    while (attempts < 2 && !translated) {
      attempts += 1;
      try {
        translated = await translateChapterBatch(chunk, {
          bookTitle,
          chapterTitle,
          provider,
        });
      } catch (error) {
        lastError = error;
        // Short delay before retry
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    if (!translated) {
      throw (
        lastError ??
        new Error(`第 ${i + 1} 至 ${i + chunk.length} 段翻译失败，请重试。`)
      );
    }

    // Merge translated results, matching by id
    for (const item of translated) {
      results.push(item);
    }
    done += chunk.length;
    onProgress?.(Math.min(done, total), total);
  }

  // Sort by id to maintain sequence
  results.sort((a, b) => a.id - b.id);
  return results;
}
