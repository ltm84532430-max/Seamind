import { describe, expect, it } from 'vitest';
import {
  buildFeedGalaxyGraph,
  categoryOrbitRadius,
  FEED_GALAXY_ARTICLE_LIMIT,
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
});
