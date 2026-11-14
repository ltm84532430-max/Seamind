import { describe, expect, it } from 'vitest';
import {
  buildFeedGalaxyGraph,
  categoryOrbitRadius,
  FEED_GALAXY_ARTICLE_LIMIT,
  FEED_GALAXY_HIGHLIGHT_LIMIT,
  FEED_GALAXY_PREVIEW_LIMIT,
  FEED_STAR_PALETTE,
  rankUnreadChannels,
  selectFeedGalaxyArticles,
} from '../src/feed/feed-galaxy-model';
import type {
  CategoryStats,
  FeedArticle,
  FeedChannelWithStats,
} from '../src/feed/types';

function category(name: string, color = '#70b89a'): CategoryStats {
  return {
    name,
    color,
    unreadCount: 0,
    channelCount: 1,
    audioCount: 0,
  };
}

function channel(
  id: string,
  categoryName: string,
  index = 0,
): FeedChannelWithStats {
  return {
    id,
    url: `https://example.com/${id}.xml`,
    title: `源 ${id}`,
    description: null,
    siteUrl: null,
    category: categoryName,
    icon: null,
    syncStatus: 'idle',
    errorMessage: null,
    lastSyncAt: 0,
    createdAt: index,
    updatedAt: index,
    unreadCount: index + 1,
    totalCount: 4,
    audioCount: 0,
  };
}

function article(
  id: string,
  channelId: string,
  readStatus: FeedArticle['readStatus'],
  starred: boolean,
  publishedAt: number,
): FeedArticle {
  return {
    id,
    channelId,
    channelTitle: '源',
    guid: id,
    title: `文章 ${id}`,
    author: null,
    url: `https://example.com/${id}`,
    content: '',
    summary: id,
    publishedAt,
    readStatus,
    starred,
    readingTimeMin: 1,
    createdAt: publishedAt,
  };
}

function angleDelta(a: number, b: number) {
  const raw = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(raw, Math.PI * 2 - raw);
}

describe('feed galaxy model', () => {
  it('places categories on the same layered orbits as the path star map', () => {
    const names = Array.from({ length: 13 }, (_, index) => `分类${index + 1}`);
    const graph = buildFeedGalaxyGraph(
      names.map((name) => category(name)),
      names.map((name, index) => channel(`ch-${index}`, name, index)),
    );

    names.forEach((name, index) => {
      const node = graph.nodes.find((item) => item.id === `category:${name}`);
      expect(node?.orbitRadius).toBe(categoryOrbitRadius(index, names.length));
    });

    const radii = new Set(
      graph.nodes
        .filter((node) => node.kind === 'cluster')
        .map((node) => node.orbitRadius),
    );
    expect([...radii].sort()).toEqual([330, 480, 630]);
  });

  it('fans channels outward from their category in a narrow arc', () => {
    const graph = buildFeedGalaxyGraph(
      [category('技术')],
      Array.from({ length: 7 }, (_, index) =>
        channel(`ch-${index}`, '技术', index),
      ),
    );
    const parent = graph.nodes.find((node) => node.id === 'category:技术');
    const planets = graph.nodes.filter((node) => node.kind === 'planet');
    expect(parent).toBeDefined();
    expect(planets).toHaveLength(7);

    const center = Math.atan2(parent!.y, parent!.x);
    for (const planet of planets) {
      const dx = planet.x - parent!.x;
      const dy = planet.y - parent!.y;
      const distance = Math.hypot(dx, dy);
      expect(distance).toBeGreaterThan(110);
      expect(distance).toBeLessThan(112 + 76 * 2 + 2);
      expect(angleDelta(Math.atan2(dy, dx), center)).toBeLessThanOrEqual(0.7);
      expect(Math.hypot(planet.x, planet.y)).toBeGreaterThan(
        Math.hypot(parent!.x, parent!.y),
      );
    }
  });

  it('keeps at most eight article satellites and prefers unread then starred', () => {
    const articles = [
      article('read-late', 'ch', 'read', false, 500),
      article('read-star', 'ch', 'read', true, 400),
      article('unread-old', 'ch', 'unread', false, 100),
      article('unread-new', 'ch', 'unread', false, 300),
      article('unread-star-old', 'ch', 'unread', true, 150),
      article('unread-star-new', 'ch', 'unread', true, 350),
      article('read-plain', 'ch', 'read', false, 50),
      article('read-star-new', 'ch', 'read', true, 450),
      article('unread-mid', 'ch', 'unread', false, 200),
      article('unread-star-mid', 'ch', 'unread', true, 250),
      article('other', 'elsewhere', 'unread', true, 999),
    ];

    expect(
      selectFeedGalaxyArticles(
        articles.filter((item) => item.channelId === 'ch'),
      ).map((item) => item.id),
    ).toEqual([
      'unread-star-new',
      'unread-star-mid',
      'unread-star-old',
      'unread-new',
      'unread-mid',
      'unread-old',
      'read-star-new',
      'read-star',
    ]);

    const graph = buildFeedGalaxyGraph(
      [category('技术')],
      [channel('ch', '技术')],
      'ch',
      articles,
    );
    const satellites = graph.nodes.filter((node) => node.kind === 'satellite');
    expect(satellites).toHaveLength(FEED_GALAXY_ARTICLE_LIMIT);
    expect(satellites.map((node) => node.articleId)).toEqual([
      'unread-star-new',
      'unread-star-mid',
      'unread-star-old',
      'unread-new',
      'unread-mid',
      'unread-old',
      'read-star-new',
      'read-star',
    ]);
    expect(
      satellites
        .filter((node) => node.starred)
        .every((node) => node.color === '#38bdf8'),
    ).toBe(true);

    const parent = graph.nodes.find((node) => node.id === 'feed:ch')!;
    for (const satellite of satellites) {
      const dx = satellite.x - parent.x;
      const dy = satellite.y - parent.y;
      expect(Math.hypot(dx, dy)).toBeGreaterThan(60);
      expect(Math.hypot(dx, dy)).toBeLessThan(92);
      expect(
        angleDelta(Math.atan2(dy, dx), parent.orbitAngle ?? 0),
      ).toBeLessThanOrEqual(0.7);
    }
  });

  it('previews a few articles on every loaded channel and keeps eight on the expanded one', () => {
    const articles = [
      ...Array.from({ length: 6 }, (_, index) =>
        article(`a-${index}`, 'a', 'unread', false, index),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        article(`b-${index}`, 'b', 'unread', false, index),
      ),
    ];
    const graph = buildFeedGalaxyGraph(
      [category('技术')],
      [channel('a', '技术', 0), channel('b', '技术', 1)],
      'a',
      articles,
    );
    const satellitesOf = (parentId: string) =>
      graph.nodes.filter(
        (node) => node.kind === 'satellite' && node.parentId === parentId,
      );
    expect(satellitesOf('feed:a')).toHaveLength(6);
    expect(satellitesOf('feed:b')).toHaveLength(FEED_GALAXY_PREVIEW_LIMIT);
  });

  it('marks a single focus channel and highlights only the top unread ones', () => {
    const channels = Array.from({ length: 9 }, (_, index) =>
      channel(`ch-${index}`, '技术', index),
    );
    channels.push({ ...channel('done', '技术', 20), unreadCount: 0 });
    const graph = buildFeedGalaxyGraph([category('技术')], channels);
    const planets = graph.nodes.filter((node) => node.kind === 'planet');

    const focus = planets.filter((node) => node.isFocus);
    expect(focus.map((node) => node.channelId)).toEqual(['ch-8']);
    const highlighted = planets.filter((node) => node.isHighlighted);
    expect(highlighted).toHaveLength(FEED_GALAXY_HIGHLIGHT_LIMIT);
    expect(highlighted.some((node) => node.channelId === 'done')).toBe(false);
    expect(rankUnreadChannels(channels)[0].id).toBe('ch-8');
  });

  it('uses the shared star palette unless category colors are requested', () => {
    const categories = [category('技术', '#123456')];
    const channels = [channel('a', '技术')];
    const paletteGraph = buildFeedGalaxyGraph(categories, channels);
    const customGraph = buildFeedGalaxyGraph(categories, channels, null, [], {
      useCategoryColors: true,
    });
    const colorOf = (graph: typeof paletteGraph) =>
      graph.nodes.find((node) => node.id === 'category:技术')?.color;
    expect(colorOf(paletteGraph)).toBe(FEED_STAR_PALETTE[0]);
    expect(colorOf(customGraph)).toBe('#123456');
  });

  it('links sibling channels with non-physical sequence arcs', () => {
    const graph = buildFeedGalaxyGraph(
      [category('技术')],
      Array.from({ length: 3 }, (_, index) =>
        channel(`ch-${index}`, '技术', index),
      ),
    );
    const arcs = graph.links.filter((link) => link.kind === 'sequence');
    expect(arcs.map((link) => `${link.source}>${link.target}`)).toEqual([
      'feed:ch-0>feed:ch-1',
      'feed:ch-1>feed:ch-2',
    ]);
  });
});
