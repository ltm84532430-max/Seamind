import { describe, expect, it } from 'vitest';
import {
  buildBookGalaxyGraph,
  buildGalaxyAdjacencyMap,
  computeVisibleGalaxyLabelIds,
  createGalaxyPhysicsState,
  DEFAULT_GALAXY_PHYSICS_CONFIG,
  extractChapterIndex,
  stepGalaxyPhysics,
  type TocLikeItem,
} from '../src/ebook/book-galaxy-model';
import type { LibrarySnapshot, MapDocument } from '../src/library/library';

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

  it('supports Obsidian-style cross-chapter links, adjacency spotlight, and force physics dragging', () => {
    const toc: TocLikeItem[] = [
      {
        href: 'text/ch01.xhtml',
        label: '第1章 概览',
        subitems: [
          {
            href: 'text/ch01.xhtml#s1',
            label: '1.1 指针导论',
            subitems: [
              { href: 'text/ch01.xhtml#s1_1', label: '1.1.1 地址概念' },
            ],
          },
        ],
      },
      {
        href: 'text/ch02.xhtml',
        label: '第2章 内存',
        subitems: [{ href: 'text/ch02.xhtml#s2', label: '2.1 动态分配' }],
      },
    ];

    const doc1: MapDocument = {
      id: 'doc-1',
      relativePath: '读书笔记/C Book/第1章 概览/1.1 指针导论.md',
      title: '1.1 指针导论',
      category: '读书笔记/C Book/第1章 概览',
      mapType: '文档',
      tags: ['读书笔记', '内存模型'],
      createdAt: 1000,
      updatedAt: 2000,
      kind: 'doc',
    };
    const doc2: MapDocument = {
      id: 'doc-2',
      relativePath: '读书笔记/C Book/第2章 内存/2.1 动态分配.md',
      title: '2.1 动态分配',
      category: '读书笔记/C Book/第2章 内存',
      mapType: '文档',
      tags: ['读书笔记', '内存模型'],
      createdAt: 1000,
      updatedAt: 2000,
      kind: 'doc',
    };

    const snapshot: LibrarySnapshot = {
      rootPath: 'C:/books',
      documents: [doc1, doc2],
      books: [],
      plantumlFiles: [],
      textDocuments: [],
      categories: [],
    };

    const graph = buildBookGalaxyGraph('C Book', 'c-book', toc, snapshot);
    const crossLinks = graph.links.filter((l) => l.kind === 'cross_link');
    expect(crossLinks.length).toBe(1);
    expect(crossLinks[0].label).toBe('#内存模型');

    // Adjacency map spotlight check: hovering cluster-0 highlights sun-root, planet-0-0, and satellite-0-0-0
    const adjacency = buildGalaxyAdjacencyMap(graph.nodes, graph.links);
    const cluster0Neighbors = adjacency.get('cluster-0');
    expect(cluster0Neighbors?.has('sun-root')).toBe(true);
    expect(cluster0Neighbors?.has('planet-0-0')).toBe(true);
    expect(cluster0Neighbors?.has('satellite-0-0-0')).toBe(true);

    // Force physics check: dragging cluster-0 pulls its child planet-0-0 elastically
    const sim = createGalaxyPhysicsState(graph);
    const clusterBody = sim.bodies.get('cluster-0')!;
    const planetBody = sim.bodies.get('planet-0-0')!;
    const initialPlanetX = planetBody.x;

    clusterBody.fx = clusterBody.x + 180;
    clusterBody.fy = clusterBody.y;

    for (let step = 0; step < 15; step++) {
      stepGalaxyPhysics(sim);
    }

    expect(planetBody.x).toBeGreaterThan(initialPlanetX + 25);
  });

  it('builds deduplicated EPUB + Markdown footnote diamond children with cluster adjacency and collapsed tracking', () => {
    const toc: TocLikeItem[] = [
      {
        href: 'text/ch01.xhtml',
        label: '第1章 概览',
        subitems: [
          {
            href: 'text/ch01.xhtml#s1',
            label: '1.1 指针导论',
          },
        ],
      },
      {
        href: 'text/ch02.xhtml',
        label: '第2章 内存',
        subitems: [{ href: 'text/ch02.xhtml#s2', label: '2.1 动态分配' }],
      },
    ];

    const doc1: MapDocument = {
      id: 'doc-1',
      relativePath: '读书笔记/C Book/第1章 概览/1.1 指针导论.md',
      title: '1.1 指针导论',
      category: '读书笔记/C Book/第1章 概览',
      mapType: '文档',
      tags: ['读书笔记'],
      createdAt: 1000,
      updatedAt: 2000,
      kind: 'doc',
    };

    const snapshot: LibrarySnapshot = {
      rootPath: 'C:/books',
      documents: [doc1],
      books: [],
      plantumlFiles: [],
      textDocuments: [],
      categories: [],
    };

    const graph = buildBookGalaxyGraph(
      'C Book',
      'c-book',
      toc,
      snapshot,
      'text/ch01.xhtml#s1',
      undefined,
      {
        tocSectionByHref: {
          'text/ch01.xhtml': 0,
          'text/ch01.xhtml#s1': 0,
          'text/ch02.xhtml': 1,
          'text/ch02.xhtml#s2': 2,
        },
        annotations: [
          {
            id: 'ann-synced',
            cfi: 'epubcfi(/6/2!/4/2)',
            sectionIndex: 0,
            text: 'int *ptr',
            note: '声明指针变量',
            color: '#f59e0b',
            style: 'highlight',
            label: '1.1 指针导论',
            fraction: 0.1,
            createdAt: 100,
            updatedAt: 200,
          },
          {
            id: 'ann-ai-only',
            cfi: 'epubcfi(/6/6!/4/4)',
            sectionIndex: 2,
            text: 'malloc(n * sizeof(int))',
            note: '',
            aiAnalysis: '【要点】申请未初始化堆内存',
            color: '#8b5cf6',
            style: 'underline',
            label: '',
            fraction: 0.8,
            createdAt: 150,
            updatedAt: 250,
          },
          {
            id: 'ann-highlight-only',
            cfi: 'epubcfi(/6/6!/4/8)',
            sectionIndex: 2,
            text: 'free(p)',
            note: '   ',
            color: '#f59e0b',
            style: 'highlight',
            label: '2.1 动态分配',
            fraction: 0.9,
            createdAt: 180,
            updatedAt: 180,
          },
        ],
        chapterMarkdownByPath: {
          [doc1.relativePath]: [
            '# 1.1 指针导论',
            '',
            '> “int *ptr”[^epub-1]',
            '',
            '补充笔记[^md-note]。',
            '',
            '[^epub-1]: <!-- epub:ann-synced --> **1.1 指针导论** · 声明指针变量',
            '[^md-note]: 指针加法会自动乘以 `sizeof(*ptr)`。',
          ].join('\n'),
        },
      },
    );

    const footnotes = graph.nodes.filter((n) => n.kind === 'footnote');
    expect(graph.stats.footnotesCount).toBe(3);
    expect(footnotes).toHaveLength(3);
    // Chapter coverage remains 1 note / 4 TOC entries = 25% (not inflated by footnotes)
    expect(graph.stats.completionPercentage).toBe(25);

    const syncedNode = footnotes.find(
      (n) => n.footnoteData?.annotationId === 'ann-synced',
    )!;
    expect(syncedNode).toBeDefined();
    expect(syncedNode.parentId).toBe('planet-0-0');
    expect(syncedNode.rootClusterId).toBe('cluster-0');
    expect(syncedNode.isCurrent).toBe(true);
    expect(syncedNode.footnoteData?.source).toBe('epub-note');
    expect(syncedNode.footnoteData?.syncedNotePath).toBe(doc1.relativePath);
    expect(syncedNode.footnoteData?.syncedFootnoteKey).toBe('epub-1');

    const aiNode = footnotes.find(
      (n) => n.footnoteData?.annotationId === 'ann-ai-only',
    )!;
    expect(aiNode).toBeDefined();
    expect(aiNode.parentId).toBe('planet-1-0');
    expect(aiNode.rootClusterId).toBe('cluster-1');
    expect(aiNode.footnoteData?.source).toBe('epub-ai');

    const mdNode = footnotes.find(
      (n) => n.footnoteData?.source === 'markdown-footnote',
    )!;
    expect(mdNode).toBeDefined();
    expect(mdNode.parentId).toBe('planet-0-0');
    expect(mdNode.footnoteData?.footnoteKey).toBe('md-note');
    expect(mdNode.footnoteData?.notePath).toBe(doc1.relativePath);

    // Highlight without note or AI explanation does not create a footnote child
    expect(
      footnotes.some(
        (n) => n.footnoteData?.annotationId === 'ann-highlight-only',
      ),
    ).toBe(false);

    // Adjacency map bridges cluster-0 <-> footnote grandchildren
    const adjacency = buildGalaxyAdjacencyMap(graph.nodes, graph.links);
    expect(adjacency.get('cluster-0')?.has(syncedNode.id)).toBe(true);
    expect(adjacency.get('cluster-0')?.has(mdNode.id)).toBe(true);
    expect(adjacency.get(syncedNode.id)?.has('cluster-0')).toBe(true);

    // Collapsed Choice-B footnotes follow moved parents without drifting behind
    const sim = createGalaxyPhysicsState(graph);
    const planet1 = sim.bodies.get('planet-1-0')!;
    const collapsedAi = sim.bodies.get(aiNode.id)!;
    const visibleWithoutCh2Footnotes = new Set(
      graph.nodes.filter((n) => n.id !== aiNode.id).map((n) => n.id),
    );

    planet1.x += 120;
    planet1.y -= 60;
    stepGalaxyPhysics(
      sim,
      DEFAULT_GALAXY_PHYSICS_CONFIG,
      visibleWithoutCh2Footnotes,
    );

    const expectedX =
      planet1.x + Math.cos(collapsedAi.orbitAngle) * collapsedAi.orbitRadius;
    const expectedY =
      planet1.y + Math.sin(collapsedAi.orbitAngle) * collapsedAi.orbitRadius;
    expect(
      Math.hypot(collapsedAi.x - expectedX, collapsedAi.y - expectedY),
    ).toBeLessThan(1.5);
  });

  it('culls colliding secondary labels in screen space while preserving priority nodes', () => {
    const nodes = [
      {
        id: 'sun',
        kind: 'sun' as const,
        label: 'Root',
        x: 0,
        y: 0,
        radius: 36,
      },
      {
        id: 'p1',
        kind: 'planet' as const,
        label: '1.1 紧密相邻的第一小节',
        x: 120,
        y: 80,
        radius: 6,
      },
      {
        id: 'p2',
        kind: 'satellite' as const,
        label: '1.1.1 叠在正下方的子节',
        x: 121,
        y: 81,
        radius: 3,
      },
      {
        id: 'p3',
        kind: 'planet' as const,
        label: '2.1 远离的独立小节',
        x: -240,
        y: -180,
        radius: 6,
      },
    ];
    const visibleIds = new Set(nodes.map((n) => n.id));
    const culled = computeVisibleGalaxyLabelIds({
      nodes,
      positions: {},
      scale: 0.5,
      visibleIds,
    });
    expect(culled.has('sun')).toBe(true);
    expect(culled.has('p1')).toBe(true);
    expect(culled.has('p2')).toBe(false);
    expect(culled.has('p3')).toBe(true);

    const forced = computeVisibleGalaxyLabelIds({
      nodes,
      positions: {},
      scale: 0.5,
      visibleIds,
      priorityIds: new Set(['p2']),
    });
    expect(forced.has('p2')).toBe(true);
  });
});
