import { describe, expect, it, vi, beforeEach } from 'vitest';
import { feedApi } from '../src/feed/feed-api';
import type { FeedChannel, FeedOverview } from '../src/feed/types';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('Feed Workspace API & Flow', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches overview with unread and categories', async () => {
    const mockOverview: FeedOverview = {
      totalUnread: 12,
      totalArticles: 48,
      totalStarred: 3,
      channels: [
        {
          id: 'ch-1',
          url: 'https://example.com/rss.xml',
          title: '示例技术博客',
          description: '分享前端与系统架构',
          siteUrl: 'https://example.com',
          category: '技术博客',
          icon: null,
          syncStatus: 'idle',
          errorMessage: null,
          lastSyncAt: 1700000000,
          createdAt: 1700000000,
          updatedAt: 1700000000,
          unreadCount: 5,
          totalCount: 20,
        },
      ],
      categories: [
        {
          name: '技术博客',
          unreadCount: 5,
          channelCount: 1,
        },
      ],
    };

    mockInvoke.mockResolvedValueOnce(mockOverview);

    const result = await feedApi.getOverview();
    expect(result.totalUnread).toBe(12);
    expect(result.channels[0].title).toBe('示例技术博客');
    expect(result.categories[0].name).toBe('技术博客');
    expect(mockInvoke).toHaveBeenCalledWith('feed_get_overview');
  });

  it('invokes addChannel with custom metadata', async () => {
    const mockChannel: FeedChannel = {
      id: 'ch-2',
      url: 'https://blog.rust-lang.org/feed.xml',
      title: 'Rust Blog',
      description: 'Official Rust Blog',
      siteUrl: 'https://blog.rust-lang.org',
      category: 'Rust',
      icon: null,
      syncStatus: 'idle',
      errorMessage: null,
      lastSyncAt: 1700000000,
      createdAt: 1700000000,
      updatedAt: 1700000000,
    };

    mockInvoke.mockResolvedValueOnce(mockChannel);

    const res = await feedApi.addChannel(
      'https://blog.rust-lang.org/feed.xml',
      'Rust',
      'Rust Blog',
    );

    expect(res.id).toBe('ch-2');
    expect(mockInvoke).toHaveBeenCalledWith('feed_add_channel', {
      url: 'https://blog.rust-lang.org/feed.xml',
      category: 'Rust',
      customTitle: 'Rust Blog',
    });
  });

  it('generates mindmap markdown from article', async () => {
    const sampleMarkdown =
      '# 示例博客文章\n\n## 来源信息\n- 来源：Rust Blog\n\n## 核心摘要\n- 重点更新速览';
    mockInvoke.mockResolvedValueOnce(sampleMarkdown);

    const md = await feedApi.articleToMindmap('art-1');
    expect(md).toContain('# 示例博客文章');
    expect(md).toContain('## 来源信息');
    expect(mockInvoke).toHaveBeenCalledWith('feed_article_to_mindmap', {
      id: 'art-1',
    });
  });

  it('handles OPML import and export', async () => {
    mockInvoke.mockResolvedValueOnce(4);
    const count = await feedApi.importOpml('<opml>...</opml>');
    expect(count).toBe(4);
    expect(mockInvoke).toHaveBeenCalledWith('feed_import_opml', {
      opmlXml: '<opml>...</opml>',
    });

    const exportXml = '<opml version="2.0">...</opml>';
    mockInvoke.mockResolvedValueOnce(exportXml);
    const exported = await feedApi.exportOpml();
    expect(exported).toBe(exportXml);
    expect(mockInvoke).toHaveBeenCalledWith('feed_export_opml');
  });

  it('toggles article read and star status', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await feedApi.setArticleRead('art-1', 'read');
    expect(mockInvoke).toHaveBeenCalledWith('feed_set_article_read', {
      id: 'art-1',
      readStatus: 'read',
    });

    mockInvoke.mockResolvedValueOnce(undefined);
    await feedApi.setArticleStarred('art-1', true);
    expect(mockInvoke).toHaveBeenCalledWith('feed_set_article_starred', {
      id: 'art-1',
      starred: true,
    });
  });
});
