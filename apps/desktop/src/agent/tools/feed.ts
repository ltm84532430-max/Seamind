import type { AgentCapabilities, AgentToolResult } from '../tool-api';
import type { AgentToolDescriptor } from '../types';
import {
  assertOnlyKeys,
  MAX_TOOL_READ_CHARS,
  optionalString,
  requireInteger,
  requireString,
  schema,
} from './parse';

export const feedToolCatalog: AgentToolDescriptor[] = [
  {
    version: 1,
    name: 'rss_get_current_article',
    description:
      '读取订阅页面当前选中文章由 RSS 源提供的原始正文；若源只提供摘要则返回摘要。按 offset 分段读取直到 nextOffset 为 null。仅在订阅页面可用。',
    permission: 'read',
    inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }),
  },
  {
    version: 1,
    name: 'rss_list_subscriptions',
    description:
      '列出本机当前 RSS 订阅源及分类，供分析和添加订阅时查重。仅在订阅页面可用。',
    permission: 'read',
    inputSchema: schema({}),
  },
  {
    version: 1,
    name: 'rss_add_subscription',
    description:
      '添加 RSS 或 Atom 订阅源。会先在 Seamind 中显示确认，用户同意后才写入本机订阅库。仅在订阅页面可用。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        url: { type: 'string', format: 'uri', maxLength: 2048 },
        category: { type: 'string', maxLength: 100 },
        title: { type: 'string', maxLength: 200 },
      },
      ['url'],
    ),
  },
];

async function rss_get_current_article(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'rss_get_current_article';

  assertOnlyKeys(input, ['offset']);
  if (!capabilities.readCurrentFeedArticle)
    throw new Error('当前环境无法读取 RSS 文章。');
  const offset =
    input.offset === undefined ? 0 : requireInteger(input, 'offset');
  const article = await capabilities.readCurrentFeedArticle();
  // 返回订阅源保存的完整原文，分段读取避免长文章超过单次工具输出上限。
  const original = article.content || article.summary;
  const start = Math.min(offset, original.length);
  const content = original.slice(start, start + MAX_TOOL_READ_CHARS);
  const nextOffset = start + content.length;
  return {
    version: 1,
    permission: 'read',
    name,
    label: '当前 RSS 原文',
    summary: article.title,
    result: {
      articleId: article.id,
      title: article.title,
      channelTitle: article.channelTitle,
      author: article.author,
      url: article.url,
      publishedAt: article.publishedAt,
      contentSource: article.content ? 'feed_content' : 'feed_summary',
      contentFormat: article.content ? 'html' : 'text',
      totalChars: original.length,
      offset: start,
      content,
      nextOffset: nextOffset < original.length ? nextOffset : null,
    },
  };
}

async function rss_list_subscriptions(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'rss_list_subscriptions';

  assertOnlyKeys(input, []);
  if (!capabilities.listFeedSubscriptions)
    throw new Error('当前环境无法列出 RSS 订阅源。');
  const channels = await capabilities.listFeedSubscriptions();
  return {
    version: 1,
    permission: 'read',
    name,
    label: 'RSS 订阅源',
    summary: `共 ${channels.length} 个订阅源`,
    result: {
      channels: channels.map(({ id, url, title, category, siteUrl }) => ({
        id,
        url,
        title,
        category,
        siteUrl,
      })),
    },
  };
}

async function rss_add_subscription(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'rss_add_subscription';

  assertOnlyKeys(input, ['url', 'category', 'title']);
  if (!capabilities.addFeedSubscription)
    throw new Error('当前环境无法添加 RSS 订阅源。');
  const url = requireString(input, 'url', 2048);
  if (!/^https?:\/\//i.test(url))
    throw new Error('订阅地址必须是 http 或 https URL。');
  const category = optionalString(input, 'category', 100);
  const title = optionalString(input, 'title', 200);
  const channel = await capabilities.addFeedSubscription({
    url,
    category,
    title,
  });
  return {
    version: 1,
    permission: 'user_approval',
    name,
    label: '添加 RSS 订阅',
    summary: `已订阅 ${channel.title}`,
    result: {
      id: channel.id,
      title: channel.title,
      url: channel.url,
      category: channel.category,
    },
  };
}

export const feedHandlers = {
  rss_get_current_article,
  rss_list_subscriptions,
  rss_add_subscription,
};
