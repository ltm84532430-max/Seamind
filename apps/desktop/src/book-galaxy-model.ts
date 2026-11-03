import type { LibrarySnapshot } from './library';
import { bookChapterKnowledgeNoteTitle } from './book-knowledge-target';
import { bookMindmapTitle } from './book-mindmap-target';

export type GalaxyNodeKind = 'sun' | 'cluster' | 'planet' | 'satellite';

export interface GalaxyNode {
  id: string;
  label: string;
  kind: GalaxyNodeKind;
  bookTitle: string;
  chapterIndex?: string;
  chapterHref?: string;
  parentChapter?: string;
  hierarchy: string[];
  hasNote: boolean;
  notePath?: string;
  noteTitle?: string;
  noteUpdatedAt?: number;
  wordEstimate?: number;
  isCurrent?: boolean;
  // Spatial coordinates
  x: number;
  y: number;
  radius: number;
  orbitRadius?: number;
  orbitAngle?: number;
  color: string;
}

export type GalaxyLinkKind = 'orbit' | 'sequence' | 'cross_link';

export interface GalaxyLink {
  source: string;
  target: string;
  kind: GalaxyLinkKind;
  label?: string;
}

export interface BookGalaxyGraph {
  bookTitle: string;
  bookKey: string;
  nodes: GalaxyNode[];
  links: GalaxyLink[];
  stats: {
    totalChapters: number;
    notesCount: number;
    completionPercentage: number;
  };
}

export interface TocLikeItem {
  href: string;
  label: string | Record<string, string>;
  subitems?: TocLikeItem[];
  id?: number;
}

function resolveTocLabel(label: string | Record<string, string>): string {
  if (typeof label === 'string') return label.trim();
  if (!label || typeof label !== 'object') return '未命名章节';
  return (
    label['zh'] ||
    label['zh-CN'] ||
    label['en'] ||
    Object.values(label)[0] ||
    '未命名章节'
  ).trim();
}

function normalizePath(path: string) {
  return path.replaceAll('\\', '/').toLowerCase();
}

/**
 * Extracts a numeric index (e.g. "8.1" or "第8章") from a chapter title.
 */
export function extractChapterIndex(label: string): string {
  const match =
    /^(\d+(\.\d+)*|第\s*[0-9一二三四五六七八九十百]+\s*[章节篇回])/u.exec(
      label.trim(),
    );
  return match ? match[1].replace(/\s+/g, '') : '';
}

/**
 * Palette generator for galaxy nodes (calm, architectural celestial tones).
 */
const CLUSTER_COLORS = [
  '#d9573b', // SeaMind vermilion
  '#e28a47', // Solar amber
  '#4a90e2', // Cyan deep space
  '#50b796', // Emerald nebula
  '#9b59b6', // Amethyst violet
  '#3498db', // Cosmic blue
  '#e67e22', // Planetary rust
  '#1abc9c', // Teal aurora
];

export function buildBookGalaxyGraph(
  bookTitle: string,
  bookKey: string,
  toc: TocLikeItem[],
  snapshot: LibrarySnapshot,
  currentChapterHref?: string,
): BookGalaxyGraph {
  const cleanBook = bookMindmapTitle(bookTitle);
  const normalizedBookCategory = normalizePath(`读书笔记/${cleanBook}`);

  // Find all documents belonging to this book
  const bookDocs = snapshot.documents.filter((doc) => {
    if (doc.kind !== 'doc') return false;
    const cat = normalizePath(doc.category);
    return (
      cat === normalizedBookCategory ||
      cat.startsWith(`${normalizedBookCategory}/`)
    );
  });

  const nodes: GalaxyNode[] = [];
  const links: GalaxyLink[] = [];

  // 1. Central Sun Node (Book Root)
  const sunNode: GalaxyNode = {
    id: 'sun-root',
    label: bookTitle,
    kind: 'sun',
    bookTitle,
    hierarchy: [],
    hasNote: bookDocs.some(
      (d) =>
        d.title === `${cleanBook} 读书笔记` ||
        normalizePath(d.relativePath).endsWith('/_index.md'),
    ),
    notePath: `读书笔记/${cleanBook}/${cleanBook} 读书笔记.md`,
    noteTitle: `${cleanBook} 读书笔记`,
    x: 0,
    y: 0,
    radius: 28,
    color: '#d9573b',
  };
  nodes.push(sunNode);

  // 2. Traverse TOC to create Clusters (top chapters) and Planets (sub sections)
  let totalChapterCount = 0;
  let notesCount = 0;

  const topLevelCount = Math.max(1, toc.length);
  const clusterBaseRadius = 240;

  toc.forEach((topItem, topIndex) => {
    totalChapterCount++;
    const clusterLabel = resolveTocLabel(topItem.label);
    const clusterIndex = extractChapterIndex(clusterLabel);
    const clusterAngle = (2 * Math.PI * topIndex) / topLevelCount - Math.PI / 2;
    const clusterX = Math.round(clusterBaseRadius * Math.cos(clusterAngle));
    const clusterY = Math.round(clusterBaseRadius * Math.sin(clusterAngle));
    const clusterColor =
      CLUSTER_COLORS[topIndex % CLUSTER_COLORS.length] || '#4a90e2';

    const clusterHierarchy = [clusterLabel];
    const clusterExpectedTitle = bookChapterKnowledgeNoteTitle(clusterLabel);

    const clusterDoc = bookDocs.find((doc) => {
      const matchTitle =
        doc.title === clusterExpectedTitle ||
        doc.title.includes(clusterLabel) ||
        normalizePath(doc.relativePath).endsWith(
          `/${normalizePath(clusterExpectedTitle)}.md`,
        );
      return matchTitle;
    });

    if (clusterDoc) notesCount++;

    const isClusterCurrent =
      Boolean(currentChapterHref) &&
      Boolean(topItem.href) &&
      (currentChapterHref === topItem.href ||
        topItem.href.includes(currentChapterHref || ''));

    const clusterId = `cluster-${topIndex}`;
    const clusterNode: GalaxyNode = {
      id: clusterId,
      label: clusterLabel,
      kind: 'cluster',
      bookTitle,
      chapterIndex: clusterIndex,
      chapterHref: topItem.href,
      parentChapter: '',
      hierarchy: clusterHierarchy,
      hasNote: Boolean(clusterDoc),
      notePath: clusterDoc?.relativePath,
      noteTitle: clusterDoc?.title,
      noteUpdatedAt: clusterDoc?.updatedAt,
      isCurrent: isClusterCurrent,
      x: clusterX,
      y: clusterY,
      radius: 18,
      orbitRadius: clusterBaseRadius,
      orbitAngle: clusterAngle,
      color: clusterColor,
    };
    nodes.push(clusterNode);

    // Link Sun -> Cluster
    links.push({
      source: sunNode.id,
      target: clusterId,
      kind: 'orbit',
    });

    // Sub-items (Planets)
    const subitems = topItem.subitems ?? [];
    const subCount = subitems.length;
    const planetOrbitRadius = 80;

    subitems.forEach((subItem, subIndex) => {
      totalChapterCount++;
      const subLabel = resolveTocLabel(subItem.label);
      const subIndexStr = extractChapterIndex(subLabel);
      const planetAngle =
        subCount === 1
          ? clusterAngle
          : clusterAngle -
            Math.PI / 3 +
            (2 * Math.PI * subIndex) / (3 * Math.max(1, subCount - 1));

      const planetX = Math.round(
        clusterX + planetOrbitRadius * Math.cos(planetAngle),
      );
      const planetY = Math.round(
        clusterY + planetOrbitRadius * Math.sin(planetAngle),
      );

      const subHierarchy = [clusterLabel, subLabel];
      const subExpectedTitle = bookChapterKnowledgeNoteTitle(subLabel);

      const subDoc = bookDocs.find((doc) => {
        const matchTitle =
          doc.title === subExpectedTitle ||
          doc.title.includes(subLabel) ||
          normalizePath(doc.relativePath).endsWith(
            `/${normalizePath(subExpectedTitle)}.md`,
          );
        return matchTitle;
      });

      if (subDoc) notesCount++;

      const isSubCurrent =
        Boolean(currentChapterHref) &&
        Boolean(subItem.href) &&
        (currentChapterHref === subItem.href ||
          subItem.href.includes(currentChapterHref || ''));

      const planetId = `planet-${topIndex}-${subIndex}`;
      const planetNode: GalaxyNode = {
        id: planetId,
        label: subLabel,
        kind: 'planet',
        bookTitle,
        chapterIndex: subIndexStr,
        chapterHref: subItem.href,
        parentChapter: clusterLabel,
        hierarchy: subHierarchy,
        hasNote: Boolean(subDoc),
        notePath: subDoc?.relativePath,
        noteTitle: subDoc?.title,
        noteUpdatedAt: subDoc?.updatedAt,
        isCurrent: isSubCurrent,
        x: planetX,
        y: planetY,
        radius: 12,
        orbitRadius: planetOrbitRadius,
        orbitAngle: planetAngle,
        color: clusterColor,
      };
      nodes.push(planetNode);

      // Link Cluster -> Planet
      links.push({
        source: clusterId,
        target: planetId,
        kind: 'orbit',
      });
    });
  });

  // 3. Connect sequential top-level chapters
  for (let i = 0; i < toc.length - 1; i++) {
    links.push({
      source: `cluster-${i}`,
      target: `cluster-${i + 1}`,
      kind: 'sequence',
    });
  }

  // 4. Calculate stats
  const completionPercentage =
    totalChapterCount > 0
      ? Math.round((notesCount / totalChapterCount) * 100)
      : 0;

  return {
    bookTitle,
    bookKey,
    nodes,
    links,
    stats: {
      totalChapters: totalChapterCount,
      notesCount,
      completionPercentage,
    },
  };
}
