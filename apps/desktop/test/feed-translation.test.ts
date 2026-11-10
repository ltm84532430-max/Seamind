import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPromptPieces,
  chunkPromptPieces,
  extractFeedBlockTexts,
  extractHtmlBlockTexts,
  hashFeedBlocks,
  mergePieceTranslations,
  selectChannelTranslationTargets,
  splitLongText,
} from '../src/feed/feed-translation-blocks';
import {
  FeedTranslationCancelled,
  translateChannelArticles,
  translateFeedBlocks,
} from '../src/feed/feed-translation-api';
import type { FeedArticle } from '../src/feed/types';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

function article(
  partial: Partial<FeedArticle> & Pick<FeedArticle, 'id'>,
): FeedArticle {
  return {
    channelId: 'channel-1',
    channelTitle: 'Example',
    guid: partial.id,
    title: 'Title',
    author: null,
    url: 'https://example.com/post',
    content: '',
    summary: '',
    publishedAt: 1,
    readStatus: 'unread',
    starred: false,
    readingTimeMin: 1,
    createdAt: 1,
    ...partial,
  };
}

describe('feed translation blocks', () => {
  it('keeps paragraphs, headings, and inline code, and skips preformatted blocks', () => {
    const texts = extractHtmlBlockTexts(`
      <h2>Intro</h2>
      <p>Use the <code>ssh</code> command.</p>
      <pre><code>secret command</code></pre>
      <ul><li><p>First point</p><p>Second point</p></li></ul>
      <p class="feed-article-placeholder">暂无正文内容</p>
    `);
    expect(texts).toEqual([
      'Intro',
      'Use the ssh command.',
      'First point',
      'Second point',
    ]);
  });

  it('splits flat line breaks into paragraphs and keeps a summary-only article', () => {
    expect(extractHtmlBlockTexts('<div>Alpha<br><br>Beta</div>')).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(
      extractFeedBlockTexts({
        title: 'Show notes',
        contentHtml: '',
        summary: 'A short episode summary.',
      }),
    ).toEqual(['Show notes', 'A short episode summary.']);
  });

  it('turns a long paragraph into ordered pieces and joins the translations', () => {
    const pieces = buildPromptPieces([`短句。${'字'.repeat(3600)}`]);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.blockId === 0)).toBe(true);
    const merged = mergePieceTranslations(
      pieces,
      pieces.map((piece) => ({ id: piece.promptId, translation: piece.text })),
    );
    expect(merged).toEqual([
      { id: 0, translation: pieces.map((piece) => piece.text).join('') },
    ]);
    expect(splitLongText('短句。第二句。', 4).length).toBeGreaterThan(1);
  });

  it('starts a new batch before the prompt grows past the budget', () => {
    const pieces = buildPromptPieces(['甲'.repeat(7000), '乙'.repeat(7000)]);
    const batches = chunkPromptPieces(pieces, 10, 12_000);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const chars = batch.reduce((sum, piece) => sum + piece.text.length, 0);
      expect(chars).toBeLessThanOrEqual(12_000);
    }
  });

  it('hashes the same blocks to the same value and skips translated articles', async () => {
    const first = await hashFeedBlocks(['Title', 'Body']);
    const second = await hashFeedBlocks(['Title', 'Body']);
    expect(first).toBe(second);
    expect(first).toHaveLength(64);

    const articles = [
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `done-${index}`,
        title: 'Done',
        contentHtml: '<p>Already translated.</p>',
        summary: '',
      })),
      ...Array.from({ length: 21 }, (_, index) => ({
        id: `new-${index}`,
        title: `New ${index}`,
        contentHtml: `<p>Fresh ${index}</p>`,
        summary: '',
      })),
    ];
    const savedHash = await hashFeedBlocks(
      extractFeedBlockTexts({
        title: 'Done',
        contentHtml: '<p>Already translated.</p>',
        summary: '',
      }),
    );
    const selected = await selectChannelTranslationTargets(
      articles,
      async (id) =>
        id.startsWith('done-') ? { contentHash: savedHash } : null,
      20,
    );
    expect(selected).toHaveLength(20);
    expect(selected[0]?.article.id).toBe('new-0');
    expect(selected[19]?.article.id).toBe('new-19');
  });
});

describe('feed translation requests', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('sends paragraphs in batches and keeps their ids', async () => {
    mockInvoke.mockImplementation(
      async (
        _command: string,
        args: { paragraphs: Array<{ id: number; text: string }> },
      ) =>
        args.paragraphs.map((item) => ({
          id: item.id,
          translation: `译：${item.text}`,
        })),
    );
    const reports: Array<[number, number]> = [];
    const result = await translateFeedBlocks({
      channelTitle: 'Source',
      articleTitle: 'Post',
      texts: ['One', 'Two', 'Three'],
      provider: { baseUrl: 'https://api.test/v1', model: 'test-model' },
      onProgress: (done, total) => reports.push([done, total]),
    });
    expect(result).toEqual([
      { id: 0, translation: '译：One' },
      { id: 1, translation: '译：Two' },
      { id: 2, translation: '译：Three' },
    ]);
    expect(reports.at(-1)).toEqual([3, 3]);
    expect(mockInvoke).toHaveBeenCalledWith(
      'translate_feed_paragraphs',
      expect.objectContaining({
        baseUrl: 'https://api.test/v1',
        model: 'test-model',
        channelTitle: 'Source',
      }),
    );
  });

  it('stops a channel batch on cancel and saves finished articles', async () => {
    let calls = 0;
    mockInvoke.mockImplementation(
      async (
        command: string,
        args?: { paragraphs?: Array<{ id: number; text: string }> },
      ) => {
        if (command === 'get_feed_article_translation') return null;
        if (command === 'translate_feed_paragraphs') {
          calls += 1;
          if (calls > 1) throw new FeedTranslationCancelled();
          return (args?.paragraphs ?? []).map((item) => ({
            id: item.id,
            translation: '译文',
          }));
        }
        if (command === 'save_feed_article_translation') {
          return { articleId: 'a1' };
        }
        return null;
      },
    );
    const saved: string[] = [];
    const result = await translateChannelArticles({
      articles: [
        article({
          id: 'a1',
          title: 'First',
          content: '<p>Alpha</p>',
        }),
        article({
          id: 'a2',
          title: 'Second',
          content: '<p>Beta</p>',
        }),
      ],
      channelTitle: 'Source',
      provider: { baseUrl: 'https://api.test/v1', model: 'test-model' },
      onArticleSaved: (id) => saved.push(id),
    });
    expect(saved).toEqual(['a1']);
    expect(result.cancelled).toBe(true);
    expect(result.translated).toEqual(['a1']);
  });
});
