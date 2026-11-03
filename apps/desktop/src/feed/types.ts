export interface FeedChannel {
  id: string;
  url: string;
  title: string;
  description: string | null;
  siteUrl: string | null;
  category: string;
  icon: string | null;
  syncStatus: 'idle' | 'syncing' | 'error';
  errorMessage: string | null;
  lastSyncAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface FeedChannelWithStats extends FeedChannel {
  unreadCount: number;
  totalCount: number;
}

export interface FeedArticle {
  id: string;
  channelId: string;
  channelTitle: string;
  guid: string;
  title: string;
  author: string | null;
  url: string;
  content: string;
  summary: string;
  publishedAt: number;
  readStatus: 'unread' | 'read';
  starred: boolean;
  readingTimeMin: number;
  createdAt: number;
}

export interface ArticleFilter {
  channelId?: string;
  category?: string;
  readStatus?: 'all' | 'unread' | 'read';
  starred?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CategoryStats {
  name: string;
  unreadCount: number;
  channelCount: number;
}

export interface FeedOverview {
  totalUnread: number;
  totalArticles: number;
  totalStarred: number;
  channels: FeedChannelWithStats[];
  categories: CategoryStats[];
}

export interface ChannelInput {
  id?: string;
  url: string;
  title: string;
  description?: string;
  siteUrl?: string;
  category?: string;
}
