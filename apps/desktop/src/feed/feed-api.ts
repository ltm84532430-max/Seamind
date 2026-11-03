import { invoke } from '@tauri-apps/api/core';
import type {
  ArticleFilter,
  FeedArticle,
  FeedChannel,
  FeedOverview,
} from './types';

export const feedApi = {
  async getOverview(): Promise<FeedOverview> {
    return invoke<FeedOverview>('feed_get_overview');
  },

  async listChannels(): Promise<FeedChannel[]> {
    return invoke<FeedChannel[]>('feed_list_channels');
  },

  async addChannel(
    url: string,
    category?: string,
    customTitle?: string,
  ): Promise<FeedChannel> {
    return invoke<FeedChannel>('feed_add_channel', {
      url,
      category: category || null,
      customTitle: customTitle || null,
    });
  },

  async updateChannel(
    id: string,
    title: string,
    category?: string,
  ): Promise<FeedChannel> {
    return invoke<FeedChannel>('feed_update_channel', {
      id,
      title,
      category: category || null,
    });
  },

  async deleteChannel(id: string): Promise<void> {
    return invoke<void>('feed_delete_channel', { id });
  },

  async refreshChannel(id: string): Promise<number> {
    return invoke<number>('feed_refresh_channel', { id });
  },

  async refreshAllChannels(): Promise<number> {
    return invoke<number>('feed_refresh_all_channels');
  },

  async listArticles(filter: ArticleFilter = {}): Promise<FeedArticle[]> {
    return invoke<FeedArticle[]>('feed_list_articles', { filter });
  },

  async getArticle(id: string): Promise<FeedArticle | null> {
    return invoke<FeedArticle | null>('feed_get_article', { id });
  },

  async setArticleRead(
    id: string,
    readStatus: 'read' | 'unread',
  ): Promise<void> {
    return invoke<void>('feed_set_article_read', { id, readStatus });
  },

  async setArticleStarred(id: string, starred: boolean): Promise<void> {
    return invoke<void>('feed_set_article_starred', { id, starred });
  },

  async markAllRead(channelId?: string, category?: string): Promise<void> {
    return invoke<void>('feed_mark_all_read', {
      channelId: channelId || null,
      category: category || null,
    });
  },

  async articleToMindmap(id: string): Promise<string> {
    return invoke<string>('feed_article_to_mindmap', { id });
  },

  async importOpml(opmlXml: string): Promise<number> {
    return invoke<number>('feed_import_opml', { opmlXml });
  },

  async exportOpml(): Promise<string> {
    return invoke<string>('feed_export_opml');
  },
};
