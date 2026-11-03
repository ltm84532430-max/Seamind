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
  coverDataUrl?: string;
}

export type GalaxyLinkKind = 'orbit' | 'sequence' | 'cross_link';

export interface GalaxyLink {
  source: string;
  target: string;
  kind: GalaxyLinkKind;
  label?: string;
  color?: string;
}

export interface BookGalaxyGraph {
  bookTitle: string;
  bookKey: string;
  coverDataUrl?: string;
  nodes: GalaxyNode[];
  links: GalaxyLink[];
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
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

export function resolveTocLabel(
  label: string | Record<string, string>,
): string {
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
 * Extracts a numeric or chapter index (e.g. "8.1" or "第8章") from a chapter title.
 */
export function extractChapterIndex(label: string): string {
  const match =
    /^(\d+(\.\d+)*|第\s*[0-9一二三四五六七八九十百]+\s*[章节篇回])/u.exec(
      label.trim(),
    );
  return match ? match[1].replace(/\s+/g, '') : '';
}

/**
 * Expanded 16-color celestial palette with high aesthetic harmony and clear distinction between adjacent chapters.
 */
export const CHAPTER_GALAXY_PALETTE = [
  '#e05638', // SeaMind Vermilion (Ch 1)
  '#2563eb', // Royal Blue (Ch 2)
  '#16a34a', // Emerald Green (Ch 3)
  '#d97706', // Solar Amber (Ch 4)
  '#9333ea', // Cosmic Purple (Ch 5)
  '#0284c7', // Sky Azure (Ch 6)
  '#ea580c', // Bright Rust (Ch 7)
  '#0d9488', // Deep Teal (Ch 8)
  '#4f46e5', // Twilight Indigo (Ch 9)
  '#c026d3', // Magenta Nebula (Ch 10)
  '#059669', // Jade Forest (Ch 11)
  '#ca8a04', // Golden Star (Ch 12)
  '#e11d48', // Crimson Flare (Ch 13)
  '#0891b2', // Oceanic Cyan (Ch 14)
  '#7c3aed', // Violet Pulsar (Ch 15)
  '#b45309', // Warm Bronze (Ch 16)
];

/**
 * Calculates generous outward petal layout coordinates for subnodes (planets).
 * Ensures every single subnode has at least 35px - 75px of clear clearance from all neighbors.
 */
function calculateSubnodeCoords(
  subIndex: number,
  subCount: number,
  clusterX: number,
  clusterY: number,
  clusterAngle: number,
) {
  if (subCount === 1) {
    const dist = 110;
    return {
      x: Math.round(clusterX + dist * Math.cos(clusterAngle)),
      y: Math.round(clusterY + dist * Math.sin(clusterAngle)),
      dist,
      angle: clusterAngle,
    };
  }

  // Multi-tier layered fan-out: max 3 items per layer to guarantee ample spacing
  const itemsPerLayer = subCount <= 4 ? 2 : subCount <= 8 ? 3 : 4;
  const layerIndex = Math.floor(subIndex / itemsPerLayer);
  const indexInLayer = subIndex % itemsPerLayer;
  const countInLayer = Math.min(
    itemsPerLayer,
    subCount - layerIndex * itemsPerLayer,
  );

  const baseDist = 110;
  const layerDistStep = 75; // 75px radial separation between layers
  const dist = baseDist + layerIndex * layerDistStep;

  // Generous angular fan for items in the same layer
  const totalArc =
    countInLayer === 1 ? 0 : Math.min(1.1, 0.48 * (countInLayer - 1));
  const angle =
    countInLayer === 1
      ? clusterAngle
      : clusterAngle -
        totalArc / 2 +
        (indexInLayer / (countInLayer - 1)) * totalArc;

  return {
    x: Math.round(clusterX + dist * Math.cos(angle)),
    y: Math.round(clusterY + dist * Math.sin(angle)),
    dist,
    angle,
  };
}

export function buildBookGalaxyGraph(
  bookTitle: string,
  bookKey: string,
  toc: TocLikeItem[],
  snapshot: LibrarySnapshot,
  currentChapterHref?: string,
  coverDataUrl?: string,
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

  // 1. Central Book Node (Circular Cover Cutout, radius 40 for crisp clear presentation)
  const sunNode: GalaxyNode = {
    id: 'sun-root',
    label: cleanBook,
    kind: 'sun',
    bookTitle: cleanBook,
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
    radius: 40,
    color: '#e05638',
    coverDataUrl,
  };
  nodes.push(sunNode);

  // 2. Multi-tier spacious orbital calculations (Permanent Wide Mode)
  let totalChapterCount = 0;
  let notesCount = 0;

  const N = Math.max(1, toc.length);

  // Generous orbits: wide mode is permanent and default
  const getClusterOrbitRadius = (index: number): number => {
    if (N <= 8) {
      return 360;
    }
    if (N <= 18) {
      // 2 alternating orbits
      return index % 2 === 0 ? 340 : 540;
    }
    // 3 alternating orbits for dense chapter sets (e.g. 20-35 chapters)
    const tier = index % 3;
    return tier === 0 ? 340 : tier === 1 ? 520 : 700;
  };

  toc.forEach((topItem, topIndex) => {
    totalChapterCount++;
    const clusterLabel = resolveTocLabel(topItem.label);
    const clusterIndex = extractChapterIndex(clusterLabel);

    // Angular distribution across full circle
    const clusterAngle = (2 * Math.PI * topIndex) / N - Math.PI / 2;
    const orbitRadius = getClusterOrbitRadius(topIndex);
    const clusterX = Math.round(orbitRadius * Math.cos(clusterAngle));
    const clusterY = Math.round(orbitRadius * Math.sin(clusterAngle));

    // Thematic chapter color: ALL subnodes under this chapter strictly inherit this color!
    const chapterColor =
      CHAPTER_GALAXY_PALETTE[topIndex % CHAPTER_GALAXY_PALETTE.length];

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
      bookTitle: cleanBook,
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
      orbitRadius,
      orbitAngle: clusterAngle,
      color: chapterColor,
    };
    nodes.push(clusterNode);

    // Link Sun -> Cluster
    links.push({
      source: sunNode.id,
      target: clusterId,
      kind: 'orbit',
      color: chapterColor,
    });

    // Sub-items (Planets): Fan outward with generous clearance
    const subitems = topItem.subitems ?? [];
    const subCount = subitems.length;

    subitems.forEach((subItem, subIndex) => {
      totalChapterCount++;
      const subLabel = resolveTocLabel(subItem.label);
      const subIndexStr = extractChapterIndex(subLabel);

      const subLayout = calculateSubnodeCoords(
        subIndex,
        subCount,
        clusterX,
        clusterY,
        clusterAngle,
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
        bookTitle: cleanBook,
        chapterIndex: subIndexStr,
        chapterHref: subItem.href,
        parentChapter: clusterLabel,
        hierarchy: subHierarchy,
        hasNote: Boolean(subDoc),
        notePath: subDoc?.relativePath,
        noteTitle: subDoc?.title,
        noteUpdatedAt: subDoc?.updatedAt,
        isCurrent: isSubCurrent,
        x: subLayout.x,
        y: subLayout.y,
        radius: 12,
        orbitRadius: Math.round(subLayout.dist),
        orbitAngle: subLayout.angle,
        color: chapterColor, // Strictly inherit Chapter Color!
      };
      nodes.push(planetNode);

      // Link Cluster -> Planet
      links.push({
        source: clusterId,
        target: planetId,
        kind: 'orbit',
        color: chapterColor,
      });

      // Nested 3rd-level subitems (Satellites) if present
      const deepSubitems = subItem.subitems ?? [];
      const deepCount = deepSubitems.length;
      if (deepCount > 0) {
        const satelliteDist = 55;
        deepSubitems.forEach((deepItem, deepIndex) => {
          totalChapterCount++;
          const deepLabel = resolveTocLabel(deepItem.label);
          const deepIndexStr = extractChapterIndex(deepLabel);
          const satAngle =
            deepCount === 1
              ? subLayout.angle
              : subLayout.angle -
                0.35 +
                (0.7 * deepIndex) / Math.max(1, deepCount - 1);
          const satX = Math.round(
            subLayout.x + satelliteDist * Math.cos(satAngle),
          );
          const satY = Math.round(
            subLayout.y + satelliteDist * Math.sin(satAngle),
          );

          const satHierarchy = [clusterLabel, subLabel, deepLabel];
          const satExpectedTitle = bookChapterKnowledgeNoteTitle(deepLabel);
          const satDoc = bookDocs.find((doc) => {
            return (
              doc.title === satExpectedTitle ||
              doc.title.includes(deepLabel) ||
              normalizePath(doc.relativePath).endsWith(
                `/${normalizePath(satExpectedTitle)}.md`,
              )
            );
          });
          if (satDoc) notesCount++;

          const isSatCurrent =
            Boolean(currentChapterHref) &&
            Boolean(deepItem.href) &&
            (currentChapterHref === deepItem.href ||
              deepItem.href.includes(currentChapterHref || ''));

          const satelliteId = `satellite-${topIndex}-${subIndex}-${deepIndex}`;
          nodes.push({
            id: satelliteId,
            label: deepLabel,
            kind: 'satellite',
            bookTitle: cleanBook,
            chapterIndex: deepIndexStr,
            chapterHref: deepItem.href,
            parentChapter: subLabel,
            hierarchy: satHierarchy,
            hasNote: Boolean(satDoc),
            notePath: satDoc?.relativePath,
            noteTitle: satDoc?.title,
            noteUpdatedAt: satDoc?.updatedAt,
            isCurrent: isSatCurrent,
            x: satX,
            y: satY,
            radius: 8,
            orbitRadius: satelliteDist,
            orbitAngle: satAngle,
            color: chapterColor, // Also inherits chapter color
          });

          links.push({
            source: planetId,
            target: satelliteId,
            kind: 'orbit',
            color: chapterColor,
          });
        });
      }
    });
  });

  // 3. Connect sequential top-level chapters with graceful sequence curve
  for (let i = 0; i < toc.length - 1; i++) {
    links.push({
      source: `cluster-${i}`,
      target: `cluster-${i + 1}`,
      kind: 'sequence',
    });
  }

  // 4. Calculate bounds for auto-fit zoom
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;

  nodes.forEach((n) => {
    if (n.x - n.radius < minX) minX = n.x - n.radius;
    if (n.x + n.radius > maxX) maxX = n.x + n.radius;
    if (n.y - n.radius < minY) minY = n.y - n.radius;
    if (n.y + n.radius > maxY) maxY = n.y + n.radius;
  });

  // 5. Calculate stats
  const completionPercentage =
    totalChapterCount > 0
      ? Math.round((notesCount / totalChapterCount) * 100)
      : 0;

  return {
    bookTitle: cleanBook,
    bookKey,
    coverDataUrl,
    nodes,
    links,
    bounds: {
      minX: Math.floor(minX - 60),
      maxX: Math.ceil(maxX + 60),
      minY: Math.floor(minY - 60),
      maxY: Math.ceil(maxY + 60),
    },
    stats: {
      totalChapters: totalChapterCount,
      notesCount,
      completionPercentage,
    },
  };
}
