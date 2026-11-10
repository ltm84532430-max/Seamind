import { invoke } from '@tauri-apps/api/core';
import {
  buildPromptPieces,
  chunkPromptPieces,
  FEED_CHANNEL_TRANSLATION_LIMIT,
  mergePieceTranslations,
  selectChannelTranslationTargets,
  type PromptPiece,
} from './feed-translation-blocks';
import type { FeedArticle } from './types';

export interface FeedProviderSettings {
  baseUrl: string;
  model: string;
}

export interface FeedParagraphTranslation {
  id: number;
  translation: string;
}

export interface FeedArticleTranslationRecord {
  schemaVersion: number;
  articleId: string;
  channelId: string;
  title: string;
  contentHash: string;
  translatedAt: number;
  model: string;
  paragraphs: FeedParagraphTranslation[];
}

export interface FeedTranslationIndexEntry {
  articleId: string;
  channelId: string;
  contentHash: string;
  translatedAt: number;
  paragraphCount: number;
}

export class FeedTranslationCancelled extends Error {
  constructor() {
    super('已取消翻译');
    this.name = 'FeedTranslationCancelled';
  }
}

export function feedTranslationErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim())
    return error.message.trim();
  return '翻译失败';
}

function assertProvider(provider: FeedProviderSettings) {
  if (!provider.baseUrl.trim() || !provider.model.trim()) {
    throw new Error('请先在模型设置中填写 API 地址和模型名称。');
  }
}

async function translatePieceBatch(
  pieces: PromptPiece[],
  options: {
    channelTitle: string;
    articleTitle: string;
    provider: FeedProviderSettings;
  },
): Promise<FeedParagraphTranslation[]> {
  return invoke<FeedParagraphTranslation[]>('translate_feed_paragraphs', {
    baseUrl: options.provider.baseUrl,
    model: options.provider.model,
    channelTitle: options.channelTitle,
    articleTitle: options.articleTitle,
    paragraphs: pieces.map((piece) => ({
      id: piece.promptId,
      text: piece.text,
    })),
  });
}

function translationsCover(
  pieces: PromptPiece[],
  translated: FeedParagraphTranslation[],
): boolean {
  const byId = new Map(
    translated.map((item) => [item.id, item.translation.trim()]),
  );
  return pieces.every((piece) => Boolean(byId.get(piece.promptId)));
}

export async function translateFeedBlocks(options: {
  channelTitle: string;
  articleTitle: string;
  texts: string[];
  provider: FeedProviderSettings;
  onProgress?: (done: number, total: number) => void;
  shouldCancel?: () => boolean;
}): Promise<FeedParagraphTranslation[]> {
  assertProvider(options.provider);
  const pieces = buildPromptPieces(options.texts);
  if (pieces.length === 0) return [];
  const batches = chunkPromptPieces(pieces);
  const translated: FeedParagraphTranslation[] = [];
  const finishedBlocks = new Set<number>();
  const totalBlocks = new Set(pieces.map((piece) => piece.blockId)).size;

  for (const batch of batches) {
    if (options.shouldCancel?.()) throw new FeedTranslationCancelled();
    let attempt = 0;
    let batchResult: FeedParagraphTranslation[] | null = null;
    let lastError: unknown = null;
    while (attempt < 2 && !batchResult) {
      if (options.shouldCancel?.()) throw new FeedTranslationCancelled();
      attempt += 1;
      try {
        const result = await translatePieceBatch(batch, options);
        if (!translationsCover(batch, result)) {
          throw new Error('译文缺少部分段落。');
        }
        batchResult = result;
      } catch (error) {
        if (error instanceof FeedTranslationCancelled) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    if (!batchResult) {
      throw lastError instanceof Error
        ? lastError
        : new Error(feedTranslationErrorMessage(lastError));
    }
    translated.push(...batchResult);
    for (const piece of batch) finishedBlocks.add(piece.blockId);
    options.onProgress?.(finishedBlocks.size, totalBlocks);
  }

  return mergePieceTranslations(pieces, translated);
}

export async function getFeedArticleTranslation(
  articleId: string,
): Promise<FeedArticleTranslationRecord | null> {
  return invoke<FeedArticleTranslationRecord | null>(
    'get_feed_article_translation',
    { articleId },
  );
}

export async function saveFeedArticleTranslation(input: {
  articleId: string;
  channelId: string;
  title: string;
  contentHash: string;
  model: string;
  paragraphs: FeedParagraphTranslation[];
}): Promise<FeedArticleTranslationRecord> {
  return invoke<FeedArticleTranslationRecord>('save_feed_article_translation', {
    articleId: input.articleId,
    channelId: input.channelId,
    title: input.title,
    contentHash: input.contentHash,
    model: input.model,
    paragraphs: input.paragraphs,
  });
}

export async function deleteFeedArticleTranslation(
  articleId: string,
): Promise<boolean> {
  return invoke<boolean>('delete_feed_article_translation', { articleId });
}

export async function listFeedTranslationIndex(): Promise<
  FeedTranslationIndexEntry[]
> {
  return invoke<FeedTranslationIndexEntry[]>('list_feed_translation_index');
}

export interface FeedChannelTranslationProgress {
  done: number;
  total: number;
  title: string;
  paragraphDone: number;
  paragraphTotal: number;
}

export async function translateChannelArticles(options: {
  articles: FeedArticle[];
  channelTitle: string;
  provider: FeedProviderSettings;
  shouldCancel?: () => boolean;
  onProgress?: (progress: FeedChannelTranslationProgress) => void;
  onArticleSaved?: (articleId: string) => void;
}): Promise<{ translated: string[]; cancelled: boolean }> {
  assertProvider(options.provider);
  const sources = options.articles.map((article) => ({
    id: article.id,
    channelId: article.channelId,
    title: article.title,
    contentHtml: article.content,
    summary: article.summary,
  }));
  const pending = await selectChannelTranslationTargets(
    sources,
    async (articleId) => getFeedArticleTranslation(articleId),
    FEED_CHANNEL_TRANSLATION_LIMIT,
    options.shouldCancel,
  );
  if (options.shouldCancel?.()) return { translated: [], cancelled: true };
  const translated: string[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    if (options.shouldCancel?.()) {
      return { translated, cancelled: true };
    }
    const item = pending[index];
    if (!item) continue;
    options.onProgress?.({
      done: index,
      total: pending.length,
      title: item.article.title,
      paragraphDone: 0,
      paragraphTotal: item.texts.length,
    });
    let paragraphs;
    try {
      paragraphs = await translateFeedBlocks({
        channelTitle: options.channelTitle,
        articleTitle: item.article.title,
        texts: item.texts,
        provider: options.provider,
        shouldCancel: options.shouldCancel,
        onProgress: (paragraphDone, paragraphTotal) => {
          options.onProgress?.({
            done: index,
            total: pending.length,
            title: item.article.title,
            paragraphDone,
            paragraphTotal,
          });
        },
      });
    } catch (error) {
      if (
        error instanceof FeedTranslationCancelled ||
        options.shouldCancel?.()
      ) {
        return { translated, cancelled: true };
      }
      throw error;
    }
    if (options.shouldCancel?.()) return { translated, cancelled: true };
    await saveFeedArticleTranslation({
      articleId: item.article.id,
      channelId: item.article.channelId,
      title: item.article.title,
      contentHash: item.hash,
      model: options.provider.model,
      paragraphs,
    });
    translated.push(item.article.id);
    options.onArticleSaved?.(item.article.id);
    options.onProgress?.({
      done: index + 1,
      total: pending.length,
      title: item.article.title,
      paragraphDone: item.texts.length,
      paragraphTotal: item.texts.length,
    });
  }
  return { translated, cancelled: false };
}
