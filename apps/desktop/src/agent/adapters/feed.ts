import { feedApi } from '../../feed/feed-api';
import type { ActiveWorkspace } from '../../app/app-storage';
import type { AgentCapabilities } from '../tool-api';

export interface FeedCapabilityDeps {
  getWorkspace(): ActiveWorkspace;
  getSelectedArticleId(): string | null;
  notifySubscriptionsChanged(): void;
}

export function createFeedCapabilities(
  deps: FeedCapabilityDeps,
): Pick<
  AgentCapabilities,
  'readCurrentFeedArticle' | 'listFeedSubscriptions' | 'addFeedSubscription'
> {
  return {
    readCurrentFeedArticle: async () => {
      if (deps.getWorkspace() !== 'feed') throw new Error('请先打开订阅页面。');
      const id = deps.getSelectedArticleId();
      if (!id) throw new Error('请先在订阅页面选择一篇文章。');
      const article = await feedApi.getArticle(id);
      if (!article) throw new Error('当前文章已不存在，请重新选择。');
      return article;
    },
    listFeedSubscriptions: () => {
      if (deps.getWorkspace() !== 'feed') throw new Error('请先打开订阅页面。');
      return feedApi.listChannels();
    },
    addFeedSubscription: async ({ url, category, title }) => {
      if (deps.getWorkspace() !== 'feed') throw new Error('请先打开订阅页面。');
      const channels = await feedApi.listChannels();
      if (channels.some((channel) => channel.url === url))
        throw new Error('该 RSS 地址已在本机订阅。');
      if (
        !window.confirm(
          `确认添加 RSS 订阅源？\n标题：${title || '使用订阅源标题'}\n分类：${category || '默认分类'}\n地址：${url}`,
        )
      )
        throw new Error('用户取消了添加订阅。');
      const channel = await feedApi.addChannel(url, category, title);
      deps.notifySubscriptionsChanged();
      return channel;
    },
  };
}
