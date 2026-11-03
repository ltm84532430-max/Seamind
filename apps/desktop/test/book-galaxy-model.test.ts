import { describe, expect, it } from 'vitest';
import {
  buildBookGalaxyGraph,
  extractChapterIndex,
  type TocLikeItem,
} from '../src/book-galaxy-model';
import type { LibrarySnapshot, MapDocument } from '../src/library';

describe('Book Galaxy Model', () => {
  it('extracts chapter index patterns accurately', () => {
    expect(extractChapterIndex('8.1 单字符I/O')).toBe('8.1');
    expect(extractChapterIndex('8.1.2 进阶操作')).toBe('8.1.2');
    expect(extractChapterIndex('第8章 字符输入输出')).toBe('第8章');
    expect(extractChapterIndex('前言')).toBe('');
  });

  it('builds a topological galaxy graph with Sun, Clusters and Planets', () => {
    const bookTitle = 'C Primer Plus';
    const bookKey = 'test-book-key';
    const fakeCover = 'data:image/png;base64,fake-cover-bytes';
    const toc: TocLikeItem[] = [
      {
        href: 'text/ch07.xhtml',
        label: '第7章 C控制语句：分支和跳转',
        subitems: [
          { href: 'text/ch07.xhtml#sec7_1', label: '7.1 if语句' },
          { href: 'text/ch07.xhtml#sec7_2', label: '7.2 逻辑运算符' },
        ],
      },
      {
        href: 'text/ch08.xhtml',
        label: '第8章 字符输入/输出和输入验证',
        subitems: [
          {
            href: 'text/ch08.xhtml#sec8_1',
            label: '8.1 单字符I/O: getchar()和putchar()',
          },
          { href: 'text/ch08.xhtml#sec8_2', label: '8.2 缓冲区' },
        ],
      },
    ];

    const noteDoc: MapDocument = {
      id: 'doc-ch8-1',
      relativePath:
        '读书笔记/C Primer Plus/第8章 字符输入 输出和输入验证/8.1 单字符I O getchar()和putchar().md',
      title: '8.1 单字符I O getchar()和putchar()',
      category: '读书笔记/C Primer Plus/第8章 字符输入 输出和输入验证',
      mapType: '文档',
      tags: ['读书笔记'],
      createdAt: 1000,
      updatedAt: 2000,
      kind: 'doc',
    };

    const snapshot: LibrarySnapshot = {
      rootPath: 'C:/books',
      documents: [noteDoc],
      books: [],
      plantumlFiles: [],
      textDocuments: [],
      categories: [],
    };

    const graph = buildBookGalaxyGraph(
      bookTitle,
      bookKey,
      toc,
      snapshot,
      'text/ch08.xhtml#sec8_1',
      fakeCover,
    );

    // Verify Sun node: displays book title, radius 40 and holds cover url
    const sun = graph.nodes.find((n) => n.kind === 'sun');
    expect(sun).toBeDefined();
    expect(sun?.label).toBe('C Primer Plus');
    expect(sun?.bookTitle).toBe('C Primer Plus');
    expect(sun?.coverDataUrl).toBe(fakeCover);
    expect(sun?.radius).toBe(40);

    // Verify Clusters (2 top level chapters)
    const clusters = graph.nodes.filter((n) => n.kind === 'cluster');
    expect(clusters.length).toBe(2);

    // Verify Planets (4 sub sections)
    const planets = graph.nodes.filter((n) => n.kind === 'planet');
    expect(planets.length).toBe(4);

    // Verify Chapter 8 Color Unification:
    // Chapter 8 cluster and all its subitems (8.1, 8.2) MUST strictly share the exact same color!
    const cluster8 = clusters.find((c) => c.label.includes('第8章'));
    expect(cluster8).toBeDefined();
    const planetsUnder8 = planets.filter((p) =>
      p.parentChapter?.includes('第8章'),
    );
    expect(planetsUnder8.length).toBe(2);
    for (const p of planetsUnder8) {
      expect(p.color).toBe(cluster8?.color);
    }

    // Verify Chapter 7 and Chapter 8 have distinct colors
    const cluster7 = clusters.find((c) => c.label.includes('第7章'));
    expect(cluster7?.color).not.toBe(cluster8?.color);

    // Verify matched note on 8.1
    const planet81 = planets.find((p) => p.chapterHref?.includes('sec8_1'));
    expect(planet81).toBeDefined();
    expect(planet81?.hasNote).toBe(true);
    expect(planet81?.isCurrent).toBe(true);
    expect(planet81?.notePath).toBe(noteDoc.relativePath);

    // Verify links: Sun -> Clusters (2), Clusters -> Planets (4), Cluster 0 -> Cluster 1 (1 sequence)
    expect(graph.links.some((l) => l.kind === 'sequence')).toBe(true);
    expect(graph.links.filter((l) => l.kind === 'orbit').length).toBe(6);

    // Stats
    expect(graph.stats.totalChapters).toBe(6); // 2 chapters + 4 sub sections
    expect(graph.stats.notesCount).toBe(1);
    expect(graph.stats.completionPercentage).toBe(17);
  });

  it('guarantees ample spacing and no collisions among child nodes', () => {
    // Generate a chapter with 6 subitems simulating user Chapter 2
    const toc: TocLikeItem[] = [
      {
        href: 'text/ch02.xhtml',
        label: '第2章 文本操作与处理',
        subitems: [
          { href: 'text/ch02.xhtml#sec1', label: '2.1 正则基础' },
          { href: 'text/ch02.xhtml#sec2', label: '2.2 grep 检索' },
          { href: 'text/ch02.xhtml#sec3', label: '2.3 sed 流编辑' },
          { href: 'text/ch02.xhtml#sec4', label: '2.4 awk 脚本' },
          { href: 'text/ch02.xhtml#sec5', label: '2.5 cut 裁剪' },
          { href: 'text/ch02.xhtml#sec6', label: '2.6 paste 拼接' },
        ],
      },
    ];

    const snapshot: LibrarySnapshot = {
      rootPath: 'C:/books',
      documents: [],
      books: [],
      plantumlFiles: [],
      textDocuments: [],
      categories: [],
    };

    const graph = buildBookGalaxyGraph(
      'Text Tools',
      'text-tools',
      toc,
      snapshot,
    );
    const planets = graph.nodes.filter((n) => n.kind === 'planet');
    expect(planets.length).toBe(6);

    // Pairwise distance check: every pair of child nodes must have distance >= 40px
    for (let i = 0; i < planets.length; i++) {
      for (let j = i + 1; j < planets.length; j++) {
        const p1 = planets[i];
        const p2 = planets[j];
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        // Both have radius 12, so diameter sum is 24px. Minimum center distance >= 40 ensures clearance >= 16px!
        expect(dist).toBeGreaterThanOrEqual(40);
      }
    }
  });

  it('distributes dense chapter sets across multi-tier orbits in permanent wide mode', () => {
    // Generate 24 chapters simulating a dense technical book
    const toc: TocLikeItem[] = Array.from({ length: 24 }, (_, i) => ({
      href: `text/ch${i + 1}.xhtml`,
      label: `第${i + 1}章 模块${i + 1}`,
      subitems: [
        { href: `text/ch${i + 1}.xhtml#sec1`, label: `${i + 1}.1 基础` },
        { href: `text/ch${i + 1}.xhtml#sec2`, label: `${i + 1}.2 深入` },
      ],
    }));

    const snapshot: LibrarySnapshot = {
      rootPath: 'C:/books',
      documents: [],
      books: [],
      plantumlFiles: [],
      textDocuments: [],
      categories: [],
    };

    const graph = buildBookGalaxyGraph(
      'Large Book',
      'large-key',
      toc,
      snapshot,
    );
    const clusters = graph.nodes.filter((n) => n.kind === 'cluster');

    // Clusters must have 3 distinct orbital tiers
    const distinctOrbits = new Set(clusters.map((c) => c.orbitRadius));
    expect(distinctOrbits.size).toBe(3);

    // Subnodes must fan outward: distance from sun must be greater than cluster distance
    clusters.forEach((cluster) => {
      const clusterDist = Math.hypot(cluster.x, cluster.y);
      const childPlanets = graph.nodes.filter(
        (n) => n.kind === 'planet' && n.parentChapter === cluster.label,
      );
      childPlanets.forEach((planet) => {
        const planetDist = Math.hypot(planet.x, planet.y);
        expect(planetDist).toBeGreaterThan(clusterDist);
      });
    });
  });
});
