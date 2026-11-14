import type { GalaxyLink, GalaxyPhysicsNode } from '../graph/galaxy-physics';
import type { CategoryStats, FeedArticle, FeedChannelWithStats } from './types';

export interface FeedGalaxyNode extends GalaxyPhysicsNode {
  label: string;
  sublabel?: string;
  shortCode?: string;
  degree?: number;
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
  /** 唯一焦点源（未读最多），对应课程星图的「下一节」，只有它带脉冲。 */
  isFocus?: boolean;
  /** 未读排名靠前的源，常驻标签并放大，对应课程星图的已完成/检查点。 */
  isHighlighted?: boolean;
}

export interface FeedGalaxyBuildOptions {
  /** 非展开订阅源默认挂载的文章卫星数。 */
  previewLimit?: number;
  /** 使用分类自定义颜色；默认与课程星图共用高饱和色板。 */
  useCategoryColors?: boolean;
  /** 常驻标签的未读源数量。 */
  highlightLimit?: number;
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
export const FEED_GALAXY_ARTICLE_LIMIT = 8;
export const FEED_GALAXY_PREVIEW_LIMIT = 3;
export const FEED_GALAXY_HIGHLIGHT_LIMIT = 6;

/** 与课程路径星图同一套高饱和色，只在分类没有自有颜色时使用。 */
export const FEED_STAR_PALETTE = [
  '#f97316',
  '#06b6d4',
  '#a855f7',
  '#10b981',
  '#f43f5e',
  '#eab308',
  '#3b82f6',
  '#ec4899',
  '#14b8a6',
  '#8b5cf6',
];

interface FanPlacement {
  x: number;
  y: number;
  orbitRadius: number;
  orbitAngle: number;
}

/**
 * 分类轨道与课程路径的阶段轨道一致：少量单环，变多后交错到外层，避免挤在同一圈。
 */
export function categoryOrbitRadius(index: number, count: number): number {
  if (count <= 5) return 340;
  if (count <= 12) return index % 2 === 0 ? 330 : 490;
  const tier = index % 3;
  return tier === 0 ? 330 : tier === 1 ? 480 : 630;
}

function categoryColor(
  category: CategoryStats | undefined,
  index: number,
  useCategoryColors: boolean,
) {
  const paletteColor = FEED_STAR_PALETTE[index % FEED_STAR_PALETTE.length];
  return useCategoryColors ? category?.color || paletteColor : paletteColor;
}

/** 未读最多的源排在前面；并列时按文章总数和标题稳定排序。 */
export function rankUnreadChannels(
  channels: readonly FeedChannelWithStats[],
): FeedChannelWithStats[] {
  return channels
    .filter((channel) => channel.unreadCount > 0)
    .sort(
      (a, b) =>
        b.unreadCount - a.unreadCount ||
        b.totalCount - a.totalCount ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    );
}

function trimText(value: string | null | undefined, limit: number) {
  const text = value?.trim() || '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** 未读优先，其次标星，再按发布时间。星系上每个订阅源最多挂 8 篇文章。 */
export function selectFeedGalaxyArticles(
  articles: readonly FeedArticle[],
  limit = FEED_GALAXY_ARTICLE_LIMIT,
): FeedArticle[] {
  return [...articles]
    .sort((a, b) => {
      const unreadDelta =
        Number(a.readStatus !== 'unread') - Number(b.readStatus !== 'unread');
      if (unreadDelta !== 0) return unreadDelta;
      const starredDelta = Number(!a.starred) - Number(!b.starred);
      if (starredDelta !== 0) return starredDelta;
      const publishedDelta = (b.publishedAt || 0) - (a.publishedAt || 0);
      if (publishedDelta !== 0) return publishedDelta;
      return a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

function placeInFan(
  originX: number,
  originY: number,
  centerAngle: number,
  index: number,
  count: number,
  baseDistance: number,
  tierSize: number,
  tierGap: number,
  arcFactor: number,
): FanPlacement {
  const tier = Math.floor(index / tierSize);
  const indexInTier = index % tierSize;
  const countInTier = Math.min(tierSize, count - tier * tierSize);
  const orbitRadius = baseDistance + tier * tierGap;
  const arcSpan =
    countInTier <= 1 ? 0 : Math.min(1.18, arcFactor * (countInTier - 1));
  const orbitAngle =
    countInTier <= 1
      ? centerAngle
      : centerAngle - arcSpan / 2 + (indexInTier / (countInTier - 1)) * arcSpan;
  return {
    x: Math.round(originX + Math.cos(orbitAngle) * orbitRadius),
    y: Math.round(originY + Math.sin(orbitAngle) * orbitRadius),
    orbitRadius,
    orbitAngle,
  };
}

/**
 * 构造与课程路径星图同构的 RSS 层级。
 * 已加载文章的订阅源都会挂文章卫星：展开的源最多 8 篇，其余源预览 3 篇。
 */
export function buildFeedGalaxyGraph(
  categories: CategoryStats[],
  channels: FeedChannelWithStats[],
  expandedChannelId?: string | null,
  articles: FeedArticle[] = [],
  options: FeedGalaxyBuildOptions = {},
): FeedGalaxyGraph {
  const previewLimit = options.previewLimit ?? FEED_GALAXY_PREVIEW_LIMIT;
  const useCategoryColors = options.useCategoryColors ?? false;
  const highlightLimit = options.highlightLimit ?? FEED_GALAXY_HIGHLIGHT_LIMIT;
  const rankedUnread = rankUnreadChannels(channels);
  const focusChannelId = rankedUnread[0]?.id;
  const highlightedChannelIds = new Set(
    rankedUnread.slice(0, highlightLimit).map((channel) => channel.id),
  );
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
    shortCode: 'CORE',
    x: 0,
    y: 0,
    radius: 32,
    color: '#e05638',
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
    const orbitRadius = categoryOrbitRadius(index, categoryNames.length);
    const x = Math.round(Math.cos(angle) * orbitRadius);
    const y = Math.round(Math.sin(angle) * orbitRadius);
    const id = `category:${name}`;
    const color = categoryColor(stat, index, useCategoryColors);
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
      shortCode: `分类 ${index + 1}`,
      x,
      y,
      radius: 16,
      orbitRadius,
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

  for (const [categoryIndex, name] of categoryNames.entries()) {
    const parentId = categoryIds.get(name);
    const parent = nodes.find((node) => node.id === parentId);
    if (!parentId || !parent) continue;
    const memberChannels = channels.filter(
      (channel) => (channel.category || '未分类') === name,
    );
    const count = memberChannels.length;
    const centerAngle = Math.atan2(parent.y, parent.x);
    const tierSize = count <= 4 ? 3 : 4;

    memberChannels.forEach((channel, index) => {
      const placement = placeInFan(
        parent.x,
        parent.y,
        centerAngle,
        index,
        count,
        112,
        tierSize,
        76,
        0.48,
      );
      const id = `feed:${channel.id}`;
      const node: FeedGalaxyNode = {
        id,
        kind: 'planet',
        parentId,
        label: channel.title,
        sublabel: channel.url,
        shortCode: `${categoryIndex + 1}.${index + 1}`,
        x: placement.x,
        y: placement.y,
        radius: 10,
        orbitRadius: placement.orbitRadius,
        orbitAngle: placement.orbitAngle,
        color: parent.color,
        unreadCount: channel.unreadCount,
        totalCount: channel.totalCount,
        audioCount: channel.audioCount,
        categoryName: name,
        channelId: channel.id,
        url: channel.url,
        isFocus: channel.id === focusChannelId,
        isHighlighted: highlightedChannelIds.has(channel.id),
      };
      nodes.push(node);
      links.push({
        source: parentId,
        target: id,
        kind: 'orbit',
        color: parent.color,
      });
      // 同分类相邻订阅源之间的弧线，对应课程星图的前置依赖弧线；不参与物理受力。
      if (index > 0) {
        links.push({
          source: `feed:${memberChannels[index - 1].id}`,
          target: id,
          kind: 'sequence',
          color: parent.color,
        });
      }
    });
  }

  const articlesByChannel = new Map<string, FeedArticle[]>();
  for (const article of articles) {
    const bucket = articlesByChannel.get(article.channelId);
    if (bucket) bucket.push(article);
    else articlesByChannel.set(article.channelId, [article]);
  }

  for (const channel of channels) {
    const channelArticles = articlesByChannel.get(channel.id);
    if (!channelArticles?.length) continue;
    const parentId = `feed:${channel.id}`;
    const parent = nodes.find((node) => node.id === parentId);
    if (!parent) continue;
    const isExpanded = channel.id === expandedChannelId;
    const selectedArticles = selectFeedGalaxyArticles(
      channelArticles,
      isExpanded ? FEED_GALAXY_ARTICLE_LIMIT : previewLimit,
    );
    const centerAngle = parent.orbitAngle ?? Math.atan2(parent.y, parent.x);
    selectedArticles.forEach((article, index) => {
      const placement = placeInFan(
        parent.x,
        parent.y,
        centerAngle,
        index,
        selectedArticles.length,
        62,
        4,
        28,
        0.42,
      );
      const id = `article:${article.id}`;
      nodes.push({
        id,
        kind: 'satellite',
        parentId,
        label: article.title,
        sublabel: article.channelTitle,
        shortCode: `${parent.shortCode ?? '1'}.${index + 1}`,
        x: placement.x,
        y: placement.y,
        radius: 6,
        orbitRadius: placement.orbitRadius,
        orbitAngle: placement.orbitAngle,
        color: article.starred ? '#38bdf8' : parent.color,
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
        color: article.starred ? '#38bdf8' : parent.color,
      });
    });
  }

  const degree = new Map<string, number>();
  for (const link of links) {
    if (link.kind === 'sequence') continue;
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }
  for (const node of nodes) node.degree = degree.get(node.id) ?? 1;

  const minX = Math.min(...nodes.map((node) => node.x - node.radius));
  const maxX = Math.max(...nodes.map((node) => node.x + node.radius));
  const minY = Math.min(...nodes.map((node) => node.y - node.radius));
  const maxY = Math.max(...nodes.map((node) => node.y + node.radius));
  const padding = 90;

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
