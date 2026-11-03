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
    );

    // Verify Sun node
    const sun = graph.nodes.find((n) => n.kind === 'sun');
    expect(sun).toBeDefined();
    expect(sun?.label).toBe('C Primer Plus');

    // Verify Clusters (2 top level chapters)
    const clusters = graph.nodes.filter((n) => n.kind === 'cluster');
    expect(clusters.length).toBe(2);

    // Verify Planets (4 sub sections)
    const planets = graph.nodes.filter((n) => n.kind === 'planet');
    expect(planets.length).toBe(4);

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
});
