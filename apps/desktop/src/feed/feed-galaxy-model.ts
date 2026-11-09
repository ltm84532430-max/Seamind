import type { GalaxyLink, GalaxyPhysicsNode } from '../graph/galaxy-physics';
import type { CategoryStats, FeedArticle, FeedChannelWithStats } from './types';

export interface FeedGalaxyNode extends GalaxyPhysicsNode {
  label: string;
  sublabel?: string;
  color: string;
  unreadCount: number;
  totalCount: number;
  audioCount: number;
  channelCount?: number;
  categoryName?: string;
  channelId?: string;
  articleId?: string;
  url?: string;
  readStatus?: FeedArticle['readStatus'];
  starred?: boolean;
  audioUrl?: string | null;
  publishedAt?: number;
  summary?: string;
  imageUrl?: string | null;
}

export interface FeedGalaxyGraph {
  nodes: FeedGalaxyNode[];
  links: GalaxyLink[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  stats: {
    categoryCount: number;
    channelCount: number;
    unreadCount: number;
    articleCount: number;
    audioCount: number;
  };
}

const ROOT_ID = 'sun-root';
const CATEGORY_ORBIT = 380;
const CATEGORY_PALETTE = [
  '#7f9db3',
  '#7f9b8c',
  '#b19769',
  '#9087aa',
  '#b27c6b',
  '#6e98a1',
];

function categoryColor(category: CategoryStats | undefined, index: number) {
  return category?.color || CATEGORY_PALETTE[index % CATEGORY_PALETTE.length];
}

function trimText(value: string | null | undefined, limit: number) {
  const text = value?.trim() || '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** 构造稳定的 RSS 层级；只有展开的订阅源才会附加文章卫星节点。 */
export function buildFeedGalaxyGraph(
  categories: CategoryStats[],
  channels: FeedChannelWithStats[],
  expandedChannelId?: string | null,
  articles: FeedArticle[] = [],
): FeedGalaxyGraph {
  const categoryStats = new Map(
    categories.map((category) => [category.name, category]),
  );
  const categoryNames = [
    ...categories.map((category) => category.name),
    ...channels.map((channel) => channel.category || '未分类'),
  ].filter((name, index, all) => name && all.indexOf(name) === index);
  const categoryCount = Math.max(1, categoryNames.length);
  const nodes: FeedGalaxyNode[] = [];
  const links: GalaxyLink[] = [];
  const categoryIds = new Map<string, string>();

  const unreadCount = channels.reduce(
    (sum, channel) => sum + channel.unreadCount,
    0,
  );
  const totalCount = channels.reduce(
    (sum, channel) => sum + channel.totalCount,
    0,
  );
  const audioCount = channels.reduce(
    (sum, channel) => sum + channel.audioCount,
    0,
  );

  nodes.push({
    id: ROOT_ID,
    kind: 'sun',
    label: '订阅总览',
    sublabel: 'RSS / ATOM',
    x: 0,
    y: 0,
    radius: 30,
    color: '#cf6047',
    unreadCount,
    totalCount,
    audioCount,
  });

  categoryNames.forEach((name, index) => {
    const stat = categoryStats.get(name);
    const memberChannels = channels.filter(
      (channel) => (channel.category || '未分类') === name,
    );
    const angle = (Math.PI * 2 * index) / categoryCount - Math.PI / 2;
    const x = Math.round(Math.cos(angle) * CATEGORY_ORBIT);
    const y = Math.round(Math.sin(angle) * CATEGORY_ORBIT);
    const id = `category:${name}`;
    const color = categoryColor(stat, index);
    const categoryUnread = memberChannels.reduce(
      (sum, channel) => sum + channel.unreadCount,
      0,
    );
    const categoryArticles = memberChannels.reduce(
      (sum, channel) => sum + channel.totalCount,
      0,
    );
    const categoryAudio = memberChannels.reduce(
      (sum, channel) => sum + channel.audioCount,
      0,
    );

    categoryIds.set(name, id);
    nodes.push({
      id,
      kind: 'cluster',
      parentId: ROOT_ID,
      label: name,
      sublabel: `${memberChannels.length} 个订阅源 · ${categoryUnread} 篇未读`,
      x,
      y,
      radius: Math.min(
        27,
        Math.max(20, 20 + Math.log2(memberChannels.length + 1) * 2),
      ),
      orbitRadius: CATEGORY_ORBIT,
      orbitAngle: angle,
      color,
      unreadCount: categoryUnread,
      totalCount: categoryArticles,
      audioCount: categoryAudio,
      channelCount: memberChannels.length,
      categoryName: name,
    });
    links.push({ source: ROOT_ID, target: id, kind: 'orbit', color });
  });

  for (const name of categoryNames) {
    const parentId = categoryIds.get(name);
    const parent = nodes.find((node) => node.id === parentId);
    if (!parentId || !parent) continue;
    const memberChannels = channels.filter(
      (channel) => (channel.category || '未分类') === name,
    );
    const count = memberChannels.length;
    const sectorSpan = Math.min(
      1.9,
      Math.max(1.05, (Math.PI * 1.4) / categoryCount),
    );
    const centerAngle = Math.atan2(parent.y, parent.x);

    memberChannels.forEach((channel, index) => {
      const layerSize = Math.max(5, Math.ceil(Math.sqrt(count)));
      const layer = Math.floor(index / layerSize);
      const indexInLayer = index % layerSize;
      const layerCount = Math.min(layerSize, count - layer * layerSize);
      const localAngle =
        layerCount <= 1
          ? centerAngle
          : centerAngle -
            sectorSpan / 2 +
            (indexInLayer / (layerCount - 1)) * sectorSpan;
      const orbitRadius = 122 + layer * 58;
      const x = Math.round(parent.x + Math.cos(localAngle) * orbitRadius);
      const y = Math.round(parent.y + Math.sin(localAngle) * orbitRadius);
      const id = `feed:${channel.id}`;
      const node: FeedGalaxyNode = {
        id,
        kind: 'planet',
        parentId,
        label: channel.title,
        sublabel: channel.url,
        x,
        y,
        radius: Math.min(15, 11 + Math.log2(channel.totalCount + 1)),
        orbitRadius,
        orbitAngle: localAngle,
        color: parent.color,
        unreadCount: channel.unreadCount,
        totalCount: channel.totalCount,
        audioCount: channel.audioCount,
        categoryName: name,
        channelId: channel.id,
        url: channel.url,
      };
      nodes.push(node);
      links.push({
        source: parentId,
        target: id,
        kind: 'orbit',
        color: parent.color,
      });
    });
  }

  if (expandedChannelId) {
    const parentId = `feed:${expandedChannelId}`;
    const parent = nodes.find((node) => node.id === parentId);
    const channel = channels.find((item) => item.id === expandedChannelId);
    if (parent && channel) {
      const selectedArticles = articles
        .filter((article) => article.channelId === expandedChannelId)
        .slice(0, 20);
      const satellitesPerLayer = 8;
      selectedArticles.forEach((article, index) => {
        const layer = Math.floor(index / satellitesPerLayer);
        const indexInLayer = index % satellitesPerLayer;
        const layerCount = Math.min(
          satellitesPerLayer,
          selectedArticles.length - layer * satellitesPerLayer,
        );
        const orbitAngle =
          (Math.PI * 2 * indexInLayer) / Math.max(1, layerCount) - Math.PI / 2;
        const orbitRadius = 68 + layer * 42;
        const id = `article:${article.id}`;
        nodes.push({
          id,
          kind: 'satellite',
          parentId,
          label: article.title,
          sublabel: article.channelTitle,
          x: Math.round(parent.x + Math.cos(orbitAngle) * orbitRadius),
          y: Math.round(parent.y + Math.sin(orbitAngle) * orbitRadius),
          radius: 7,
          orbitRadius,
          orbitAngle,
          color: parent.color,
          unreadCount: article.readStatus === 'unread' ? 1 : 0,
          totalCount: 1,
          audioCount: article.audioUrl ? 1 : 0,
          categoryName: channel.category,
          channelId: channel.id,
          articleId: article.id,
          readStatus: article.readStatus,
          starred: article.starred,
          audioUrl: article.audioUrl,
          publishedAt: article.publishedAt,
          summary: trimText(article.summary || article.content, 240),
          imageUrl: article.imageUrl,
        });
        links.push({
          source: parentId,
          target: id,
          kind: 'orbit',
          color: parent.color,
        });
      });
    }
  }

  const minX = Math.min(...nodes.map((node) => node.x - node.radius));
  const maxX = Math.max(...nodes.map((node) => node.x + node.radius));
  const minY = Math.min(...nodes.map((node) => node.y - node.radius));
  const maxY = Math.max(...nodes.map((node) => node.y + node.radius));
  const padding = 100;

  return {
    nodes,
    links,
    bounds: {
      minX: Math.floor(minX - padding),
      maxX: Math.ceil(maxX + padding),
      minY: Math.floor(minY - padding),
      maxY: Math.ceil(maxY + padding),
    },
    stats: {
      categoryCount: categoryNames.length,
      channelCount: channels.length,
      unreadCount,
      articleCount: totalCount,
      audioCount,
    },
  };
}
