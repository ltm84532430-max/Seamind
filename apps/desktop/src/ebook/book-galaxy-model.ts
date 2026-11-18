import type { LibrarySnapshot } from '../library/library';
import type { GalaxyLink, GalaxyPhysicsNode } from '../graph/galaxy-physics';
import { bookChapterKnowledgeNoteTitle } from './book-knowledge-target';
import { bookMindmapTitle } from './book-mindmap-target';
import type { EpubAnnotation } from './ebook-storage';
import {
  parseMarkdownFootnotes,
  stripMarkdownToPlainText,
} from '../workbench/markdown-footnotes';

export {
  buildGalaxyAdjacencyMap,
  computeVisibleGalaxyLabelIds,
  createGalaxyPhysicsState,
  DEFAULT_GALAXY_PHYSICS_CONFIG,
  stepGalaxyPhysics,
} from '../graph/galaxy-physics';
export type {
  GalaxyLink,
  GalaxyLinkKind,
  GalaxyNodeKind,
  GalaxyPhysicsConfig,
  GalaxyPhysicsState,
  GalaxySimBody,
} from '../graph/galaxy-physics';

export type BookGalaxyFootnoteSource =
  'epub-note' | 'epub-ai' | 'markdown-footnote';

export interface BookGalaxyFootnoteData {
  source: BookGalaxyFootnoteSource;
  annotationId?: string;
  cfi?: string;
  sectionIndex?: number;
  fraction?: number;
  quote?: string;
  content: string;
  highlightColor?: string;
  createdAt?: number;
  updatedAt?: number;
  footnoteKey?: string;
  notePath?: string;
  noteTitle?: string;
  lineIndex?: number;
  syncedNotePath?: string;
  syncedFootnoteKey?: string;
  syncedLineIndex?: number;
}

export interface GalaxyNode extends GalaxyPhysicsNode {
  label: string;
  bookTitle: string;
  chapterIndex?: string;
  chapterHref?: string;
  parentChapter?: string;
  rootClusterId?: string;
  hierarchy: string[];
  hasNote: boolean;
  notePath?: string;
  noteTitle?: string;
  noteUpdatedAt?: number;
  noteTags?: string[];
  wordEstimate?: number;
  isCurrent?: boolean;
  degree?: number;
  color: string;
  coverDataUrl?: string;
  footnoteData?: BookGalaxyFootnoteData;
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
    footnotesCount: number;
  };
}

export interface BuildBookGalaxyOptions {
  annotations?: readonly EpubAnnotation[];
  chapterMarkdownByPath?: Readonly<Record<string, string>>;
  tocSectionByHref?: Readonly<Record<string, number>>;
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

function truncateFootnoteLabel(text: string, maxChars = 16): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '脚注';
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

function lookupHrefSection(
  href: string | undefined,
  tocSectionByHref: Readonly<Record<string, number>> | undefined,
): number | undefined {
  if (!href || !tocSectionByHref) return undefined;
  if (typeof tocSectionByHref[href] === 'number') {
    return tocSectionByHref[href];
  }
  const baseHref = href.split('#')[0] ?? href;
  if (typeof tocSectionByHref[baseHref] === 'number') {
    return tocSectionByHref[baseHref];
  }
  const normBase = normalizePath(baseHref);
  for (const [key, value] of Object.entries(tocSectionByHref)) {
    const normKey = normalizePath(key.split('#')[0] ?? key);
    if (
      normKey === normBase ||
      normKey.endsWith(`/${normBase}`) ||
      normBase.endsWith(`/${normKey}`)
    ) {
      return value;
    }
  }
  return undefined;
}

function resolveParentNodeForEpubAnnotation(
  ann: EpubAnnotation,
  chapterNodes: readonly GalaxyNode[],
  tocSectionByHref: Readonly<Record<string, number>> | undefined,
  sunNode: GalaxyNode,
): GalaxyNode {
  if (chapterNodes.length === 0) return sunNode;

  const annLabel = ann.label?.trim() ?? '';
  const depthRank = (node: GalaxyNode) =>
    node.kind === 'satellite' ? 3 : node.kind === 'planet' ? 2 : 1;

  if (annLabel) {
    const exactMatches = chapterNodes.filter(
      (node) =>
        node.label.trim() === annLabel ||
        node.hierarchy[node.hierarchy.length - 1]?.trim() === annLabel,
    );
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1) {
      let best = exactMatches[0];
      let bestScore = Number.POSITIVE_INFINITY;
      for (const candidate of exactMatches) {
        const sec = lookupHrefSection(candidate.chapterHref, tocSectionByHref);
        const dist = sec !== undefined ? Math.abs(sec - ann.sectionIndex) : 1e6;
        const score = dist * 10 - depthRank(candidate);
        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      return best;
    }

    const partialMatches = chapterNodes.filter(
      (node) =>
        node.label.trim().length >= 2 &&
        (annLabel.includes(node.label.trim()) ||
          node.label.trim().includes(annLabel)),
    );
    if (partialMatches.length > 0) {
      partialMatches.sort((a, b) => depthRank(b) - depthRank(a));
      return partialMatches[0];
    }
  }

  if (tocSectionByHref && Number.isFinite(ann.sectionIndex)) {
    let bestExact: GalaxyNode | undefined;
    let bestPreceding: GalaxyNode | undefined;
    let bestPrecedingSec = -1;

    for (const node of chapterNodes) {
      const sec = lookupHrefSection(node.chapterHref, tocSectionByHref);
      if (sec === undefined) continue;
      if (sec === ann.sectionIndex) {
        if (!bestExact || depthRank(node) >= depthRank(bestExact)) {
          bestExact = node;
        }
      } else if (sec < ann.sectionIndex && sec >= bestPrecedingSec) {
        bestPrecedingSec = sec;
        bestPreceding = node;
      }
    }
    if (bestExact) return bestExact;
    if (bestPreceding) return bestPreceding;
  }

  if (Number.isFinite(ann.fraction)) {
    const clamped = Math.max(0, Math.min(0.9999, ann.fraction));
    const idx = Math.floor(clamped * chapterNodes.length);
    if (chapterNodes[idx]) return chapterNodes[idx];
  }

  return sunNode;
}

function buildFootnoteOrbitPosition(
  idx: number,
  count: number,
  parent: GalaxyNode,
): { x: number; y: number; dist: number; angle: number } {
  const ring = Math.floor(idx / 6);
  const posInRing = idx % 6;
  const ringCount = Math.min(6, Math.max(1, count - ring * 6));

  if (parent.kind === 'sun') {
    const dist = 76 + ring * 18;
    const angle =
      (2 * Math.PI * posInRing) / ringCount - Math.PI / 2 + ring * 0.28;
    return {
      x: Math.round(parent.x + dist * Math.cos(angle)),
      y: Math.round(parent.y + dist * Math.sin(angle)),
      dist,
      angle,
    };
  }

  const baseDist =
    parent.kind === 'cluster' ? 40 : parent.kind === 'planet' ? 27 : 22;
  const dist = baseDist + ring * 14;
  const baseAngle = parent.orbitAngle ?? 0;

  if (parent.kind === 'cluster') {
    const angle =
      baseAngle +
      (2 * Math.PI * posInRing) / ringCount +
      ring * 0.35 +
      Math.PI / 5;
    return {
      x: Math.round(parent.x + dist * Math.cos(angle)),
      y: Math.round(parent.y + dist * Math.sin(angle)),
      dist,
      angle,
    };
  }

  const span =
    ringCount <= 1 ? 0 : Math.min(Math.PI * 1.15, (ringCount - 1) * 0.44);
  const angle =
    ringCount === 1
      ? baseAngle + 0.36
      : baseAngle - span / 2 + (span * posInRing) / (ringCount - 1);
  return {
    x: Math.round(parent.x + dist * Math.cos(angle)),
    y: Math.round(parent.y + dist * Math.sin(angle)),
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
  options?: BuildBookGalaxyOptions,
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
  const chapterNodes: GalaxyNode[] = [];
  const nodeByNotePath = new Map<string, GalaxyNode>();

  const sunDoc = bookDocs.find(
    (d) =>
      d.title === `${cleanBook} 读书笔记` ||
      normalizePath(d.relativePath).endsWith('/_index.md'),
  );

  // 1. Central Book Node (Circular Cover Cutout, radius 40 for crisp clear presentation)
  const sunNode: GalaxyNode = {
    id: 'sun-root',
    label: cleanBook,
    kind: 'sun',
    bookTitle: cleanBook,
    hierarchy: [],
    hasNote: Boolean(sunDoc),
    notePath:
      sunDoc?.relativePath ?? `读书笔记/${cleanBook}/${cleanBook} 读书笔记.md`,
    noteTitle: sunDoc?.title ?? `${cleanBook} 读书笔记`,
    x: 0,
    y: 0,
    radius: 40,
    color: '#e05638',
    coverDataUrl,
  };
  nodes.push(sunNode);
  if (sunDoc?.relativePath) {
    nodeByNotePath.set(normalizePath(sunDoc.relativePath), sunNode);
  }

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
      parentId: sunNode.id,
      rootClusterId: clusterId,
      hierarchy: clusterHierarchy,
      hasNote: Boolean(clusterDoc),
      notePath: clusterDoc?.relativePath,
      noteTitle: clusterDoc?.title,
      noteUpdatedAt: clusterDoc?.updatedAt,
      noteTags: clusterDoc?.tags,
      isCurrent: isClusterCurrent,
      x: clusterX,
      y: clusterY,
      radius: 18,
      orbitRadius,
      orbitAngle: clusterAngle,
      color: chapterColor,
    };
    nodes.push(clusterNode);
    chapterNodes.push(clusterNode);
    if (clusterDoc?.relativePath) {
      nodeByNotePath.set(normalizePath(clusterDoc.relativePath), clusterNode);
    }

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
        parentId: clusterId,
        rootClusterId: clusterId,
        hierarchy: subHierarchy,
        hasNote: Boolean(subDoc),
        notePath: subDoc?.relativePath,
        noteTitle: subDoc?.title,
        noteUpdatedAt: subDoc?.updatedAt,
        noteTags: subDoc?.tags,
        isCurrent: isSubCurrent,
        x: subLayout.x,
        y: subLayout.y,
        radius: 12,
        orbitRadius: Math.round(subLayout.dist),
        orbitAngle: subLayout.angle,
        color: chapterColor, // Strictly inherit Chapter Color!
      };
      nodes.push(planetNode);
      chapterNodes.push(planetNode);
      if (subDoc?.relativePath) {
        nodeByNotePath.set(normalizePath(subDoc.relativePath), planetNode);
      }

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
          const satelliteNode: GalaxyNode = {
            id: satelliteId,
            label: deepLabel,
            kind: 'satellite',
            bookTitle: cleanBook,
            chapterIndex: deepIndexStr,
            chapterHref: deepItem.href,
            parentChapter: subLabel,
            parentId: planetId,
            rootClusterId: clusterId,
            hierarchy: satHierarchy,
            hasNote: Boolean(satDoc),
            notePath: satDoc?.relativePath,
            noteTitle: satDoc?.title,
            noteUpdatedAt: satDoc?.updatedAt,
            noteTags: satDoc?.tags,
            isCurrent: isSatCurrent,
            x: satX,
            y: satY,
            radius: 8,
            orbitRadius: satelliteDist,
            orbitAngle: satAngle,
            color: chapterColor, // Also inherits chapter color
          };
          nodes.push(satelliteNode);
          chapterNodes.push(satelliteNode);
          if (satDoc?.relativePath) {
            nodeByNotePath.set(
              normalizePath(satDoc.relativePath),
              satelliteNode,
            );
          }

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

  // 3.5. Build cross-chapter semantic links (Obsidian shared tags / knowledge notes)
  const GENERIC_TAGS = new Set([
    '读书笔记',
    '电子书',
    '笔记',
    cleanBook.toLowerCase(),
  ]);
  const noteNodes = nodes.filter((n) => n.kind !== 'sun' && n.hasNote);
  const existingPairs = new Set(
    links.map((l) =>
      l.source < l.target
        ? `${l.source}::${l.target}`
        : `${l.target}::${l.source}`,
    ),
  );

  for (let i = 0; i < noteNodes.length; i++) {
    const a = noteNodes[i];
    const tagsA = (a.noteTags ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t && !GENERIC_TAGS.has(t));
    for (let j = i + 1; j < noteNodes.length; j++) {
      const b = noteNodes[j];
      if (a.parentId === b.id || b.parentId === a.id) continue;
      const pairKey = a.id < b.id ? `${a.id}::${b.id}` : `${b.id}::${a.id}`;
      if (existingPairs.has(pairKey)) continue;

      const tagsB = (b.noteTags ?? [])
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t && !GENERIC_TAGS.has(t));
      const sharedTag = tagsA.find((t) => tagsB.includes(t));

      if (sharedTag) {
        existingPairs.add(pairKey);
        links.push({
          source: a.id,
          target: b.id,
          kind: 'cross_link',
          label: `#${sharedTag}`,
          color: a.color,
        });
      } else if (a.hierarchy[0] !== b.hierarchy[0] && noteNodes.length <= 24) {
        // Connect cross-chapter documented nodes so sparse note sets form a connected Obsidian web
        existingPairs.add(pairKey);
        links.push({
          source: a.id,
          target: b.id,
          kind: 'cross_link',
          label: '知识联动',
          color: a.color,
        });
      }
    }
  }

  // 3.6. Build chapter/book footnote nodes (EPUB handwritten/AI footnotes + Markdown footnotes)
  const nodeById = new Map<string, GalaxyNode>(nodes.map((n) => [n.id, n]));
  const epubFootnoteByAnnotationId = new Map<string, GalaxyNode>();
  const pendingFootnotesByParent = new Map<string, GalaxyNode[]>();
  const pushFootnote = (parent: GalaxyNode, fnNode: GalaxyNode) => {
    const bucket = pendingFootnotesByParent.get(parent.id);
    if (bucket) {
      bucket.push(fnNode);
    } else {
      pendingFootnotesByParent.set(parent.id, [fnNode]);
    }
  };

  for (let i = 0; i < (options?.annotations ?? []).length; i++) {
    const ann = options!.annotations![i];
    const noteBody = ann.note?.trim() ?? '';
    const aiBody = ann.aiAnalysis
      ? stripMarkdownToPlainText(ann.aiAnalysis)
      : '';
    if (!noteBody && !aiBody) continue;

    const source: BookGalaxyFootnoteSource = noteBody ? 'epub-note' : 'epub-ai';
    const content = noteBody || aiBody;
    const parent = resolveParentNodeForEpubAnnotation(
      ann,
      chapterNodes,
      options?.tocSectionByHref,
      sunNode,
    );
    const shortText = truncateFootnoteLabel(content || ann.text, 16);
    const fnNode: GalaxyNode = {
      id: `fn-epub-${ann.id || i}`,
      label: source === 'epub-ai' ? `AI·${shortText}` : shortText,
      kind: 'footnote',
      bookTitle: cleanBook,
      chapterIndex: parent.chapterIndex,
      chapterHref: parent.chapterHref,
      parentChapter: parent.label,
      parentId: parent.id,
      rootClusterId: parent.rootClusterId,
      hierarchy: [
        ...parent.hierarchy,
        truncateFootnoteLabel(content || ann.text, 18),
      ],
      hasNote: true,
      noteUpdatedAt: ann.updatedAt,
      isCurrent: Boolean(parent.isCurrent),
      x: parent.x,
      y: parent.y,
      radius: 5.5,
      color: parent.color,
      footnoteData: {
        source,
        annotationId: ann.id,
        cfi: ann.cfi,
        sectionIndex: ann.sectionIndex,
        fraction: ann.fraction,
        quote: ann.text?.trim() || undefined,
        content,
        highlightColor: ann.color,
        createdAt: ann.createdAt,
        updatedAt: ann.updatedAt,
      },
    };
    if (ann.id) {
      epubFootnoteByAnnotationId.set(ann.id, fnNode);
    }
    pushFootnote(parent, fnNode);
  }

  const chapterMarkdownByPath = options?.chapterMarkdownByPath;
  if (chapterMarkdownByPath) {
    const markdownLookup = new Map<string, string>();
    for (const [rawPath, md] of Object.entries(chapterMarkdownByPath)) {
      markdownLookup.set(normalizePath(rawPath), md);
    }

    const handledPaths = new Set<string>();
    const markdownTargets: Array<{
      relativePath: string;
      title: string;
      updatedAt?: number;
      markdown: string;
    }> = [];

    for (const doc of bookDocs) {
      const norm = normalizePath(doc.relativePath);
      const md =
        chapterMarkdownByPath[doc.relativePath] ?? markdownLookup.get(norm);
      if (typeof md !== 'string') continue;
      handledPaths.add(norm);
      markdownTargets.push({
        relativePath: doc.relativePath,
        title: doc.title,
        updatedAt: doc.updatedAt,
        markdown: md,
      });
    }

    for (const [rawPath, md] of Object.entries(chapterMarkdownByPath)) {
      const norm = normalizePath(rawPath);
      if (handledPaths.has(norm) || typeof md !== 'string') continue;
      const matchedNode = nodeByNotePath.get(norm);
      if (!matchedNode && !norm.includes(normalizedBookCategory)) continue;
      handledPaths.add(norm);
      markdownTargets.push({
        relativePath: rawPath,
        title: matchedNode?.noteTitle ?? matchedNode?.label ?? cleanBook,
        updatedAt: matchedNode?.noteUpdatedAt,
        markdown: md,
      });
    }

    for (const target of markdownTargets) {
      const parsed = parseMarkdownFootnotes(target.markdown);
      if (parsed.footnotes.length === 0) continue;

      const normPath = normalizePath(target.relativePath);
      const parent =
        nodeByNotePath.get(normPath) ??
        chapterNodes.find(
          (node) =>
            target.title === bookChapterKnowledgeNoteTitle(node.label) ||
            target.title.includes(node.label),
        ) ??
        sunNode;

      const safePathKey =
        normPath.replace(/[^a-z0-9]+/gi, '_').slice(-36) || 'doc';

      for (const fn of parsed.footnotes) {
        if (
          fn.epubAnnotationId &&
          epubFootnoteByAnnotationId.has(fn.epubAnnotationId)
        ) {
          const existing = epubFootnoteByAnnotationId.get(fn.epubAnnotationId)!;
          existing.notePath = target.relativePath;
          existing.noteTitle = target.title;
          if (!existing.noteUpdatedAt && target.updatedAt) {
            existing.noteUpdatedAt = target.updatedAt;
          }
          existing.footnoteData = {
            ...existing.footnoteData!,
            syncedNotePath: target.relativePath,
            syncedFootnoteKey: fn.id,
            syncedLineIndex: fn.lineIndex,
          };
          continue;
        }

        const content =
          fn.plainText ||
          stripMarkdownToPlainText(fn.content) ||
          fn.content.trim();
        const fnNode: GalaxyNode = {
          id: `fn-md-${safePathKey}-${fn.id}-${fn.lineIndex}`,
          label: truncateFootnoteLabel(`[^${fn.id}] ${content}`, 18),
          kind: 'footnote',
          bookTitle: cleanBook,
          chapterIndex: parent.chapterIndex,
          chapterHref: parent.chapterHref,
          parentChapter: parent.label,
          parentId: parent.id,
          rootClusterId: parent.rootClusterId,
          hierarchy: [...parent.hierarchy, `[^${fn.id}]`],
          hasNote: true,
          notePath: target.relativePath,
          noteTitle: target.title,
          noteUpdatedAt: target.updatedAt,
          isCurrent: Boolean(parent.isCurrent),
          x: parent.x,
          y: parent.y,
          radius: 5.5,
          color: parent.color,
          footnoteData: {
            source: 'markdown-footnote',
            footnoteKey: fn.id,
            notePath: target.relativePath,
            noteTitle: target.title,
            lineIndex: fn.lineIndex,
            content,
            createdAt: target.updatedAt,
            updatedAt: target.updatedAt,
          },
        };
        pushFootnote(parent, fnNode);
      }
    }
  }

  let footnotesCount = 0;
  for (const [parentId, fnList] of pendingFootnotesByParent.entries()) {
    const parent = nodeById.get(parentId) ?? sunNode;
    fnList.forEach((fnNode, idx) => {
      const layout = buildFootnoteOrbitPosition(idx, fnList.length, parent);
      fnNode.x = layout.x;
      fnNode.y = layout.y;
      fnNode.orbitRadius = Math.round(layout.dist);
      fnNode.orbitAngle = layout.angle;
      nodes.push(fnNode);
      links.push({
        source: parent.id,
        target: fnNode.id,
        kind: 'orbit',
        color: fnNode.color,
      });
      footnotesCount++;
    });
  }

  // Compute node degree (number of topological edges)
  const degreeMap = new Map<string, number>();
  for (const link of links) {
    if (link.kind === 'sequence') continue;
    degreeMap.set(link.source, (degreeMap.get(link.source) ?? 0) + 1);
    degreeMap.set(link.target, (degreeMap.get(link.target) ?? 0) + 1);
  }
  for (const node of nodes) {
    node.degree = degreeMap.get(node.id) ?? 0;
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
      footnotesCount,
    },
  };
}
