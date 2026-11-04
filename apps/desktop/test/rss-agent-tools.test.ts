import { describe, expect, it, vi } from 'vitest';
import { executeAgentTool } from '../src/agent/capabilities';
import type { AgentCapabilities } from '../src/agent/capabilities';
import type { FeedArticle, FeedChannel } from '../src/feed/types';

const article = {
  id: 'article-1',
  channelId: 'feed-1',
  channelTitle: '示例博客',
  guid: 'entry-1',
  title: '长文',
  author: '作者',
  url: 'https://example.com/entry',
  content: '<p>正文</p>'.repeat(3000),
  summary: '摘要',
  publishedAt: 1,
  readStatus: 'read',
  starred: false,
  readingTimeMin: 12,
  createdAt: 1,
} satisfies FeedArticle;

describe('RSS MCP tools', () => {
  it('只向终端返回订阅源的公开标识字段', async () => {
    const channel = {
      id: 'feed-1',
      url: 'https://example.com/rss',
      title: '示例博客',
      category: '技术',
      siteUrl: 'https://example.com',
      errorMessage: '内部错误详情',
    } as FeedChannel;
    const response = await executeAgentTool('rss_list_subscriptions', '{}', {
      listFeedSubscriptions: async () => [channel],
    } as AgentCapabilities);
    expect(response.result.channels).toEqual([
      {
        id: channel.id,
        url: channel.url,
        title: channel.title,
        category: channel.category,
        siteUrl: channel.siteUrl,
      },
    ]);
  });

  it('逐段返回完整原文与来源信息', async () => {
    const readCurrentFeedArticle = vi.fn(async () => article);
    const api = { readCurrentFeedArticle } as AgentCapabilities;
    const parts: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const response = await executeAgentTool(
        'rss_get_current_article',
        JSON.stringify({ offset }),
        api,
      );
      expect(response.result.url).toBe(article.url);
      expect(response.result.contentFormat).toBe('html');
      parts.push(response.result.content as string);
      offset = response.result.nextOffset as number | null;
    }
    expect(parts.join('')).toBe(article.content);
    expect(readCurrentFeedArticle).toHaveBeenCalledTimes(parts.length);
  });

  it('添加订阅前校验地址并传递分类', async () => {
    const channel = {
      id: 'feed-2',
      url: 'https://example.com/rss',
      title: '示例博客',
      category: '技术',
    } as FeedChannel;
    const addFeedSubscription = vi.fn(async () => channel);
    const api = { addFeedSubscription } as AgentCapabilities;
    await expect(
      executeAgentTool(
        'rss_add_subscription',
        JSON.stringify({ url: 'file:///secret' }),
        api,
      ),
    ).rejects.toThrow('http 或 https');
    expect(addFeedSubscription).not.toHaveBeenCalled();
    const response = await executeAgentTool(
      'rss_add_subscription',
      JSON.stringify({ url: channel.url, category: channel.category }),
      api,
    );
    expect(response.permission).toBe('user_approval');
    expect(addFeedSubscription).toHaveBeenCalledWith({
      url: channel.url,
      category: channel.category,
      title: undefined,
    });
  });
});
