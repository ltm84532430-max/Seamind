import type { LibrarySnapshot } from '../library/library';
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
  parentId?: string;
  hierarchy: string[];
  hasNote: boolean;
  notePath?: string;
  noteTitle?: string;
  noteUpdatedAt?: number;
  noteTags?: string[];
  wordEstimate?: number;
  isCurrent?: boolean;
  degree?: number;
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
      parentId: sunNode.id,
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
            parentId: planetId,
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
    },
  };
}

/* ==========================================================================
   Obsidian-Style Topology Spotlight & Force-Directed Physics Engine
   ========================================================================== */

export interface GalaxyPhysicsConfig {
  repelStrength: number; // 0.2 .. 2.5 (default 1.0)
  linkDistanceScale: number; // 0.5 .. 1.8 (default 1.0)
  linkTension: number; // 0.3 .. 2.0 (default 1.0)
  centerGravity: number; // 0.2 .. 2.0 (default 1.0)
}

export const DEFAULT_GALAXY_PHYSICS_CONFIG: GalaxyPhysicsConfig = {
  repelStrength: 1.0,
  linkDistanceScale: 1.0,
  linkTension: 1.0,
  centerGravity: 1.0,
};

export interface GalaxySimBody {
  id: string;
  kind: GalaxyNodeKind;
  parentId?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  anchorX: number;
  anchorY: number;
  fx: number | null;
  fy: number | null;
  radius: number;
  orbitRadius: number;
  orbitAngle: number;
}

export interface GalaxyPhysicsState {
  bodies: Map<string, GalaxySimBody>;
  bodyList: GalaxySimBody[];
  links: GalaxyLink[];
  alpha: number;
}

/**
 * Builds a 1-hop adjacency lookup table for Obsidian-style hover spotlighting.
 * When hovering a cluster node, also includes its direct child planets & their satellites
 * so the entire chapter constellation lights up cleanly.
 */
export function buildGalaxyAdjacencyMap(
  nodes: readonly GalaxyNode[],
  links: readonly GalaxyLink[],
  options?: { includeSequence?: boolean; includeCrossLinks?: boolean },
): Map<string, Set<string>> {
  const includeSequence = options?.includeSequence ?? false;
  const includeCrossLinks = options?.includeCrossLinks ?? true;
  const map = new Map<string, Set<string>>();

  for (const node of nodes) {
    map.set(node.id, new Set([node.id]));
  }

  for (const link of links) {
    if (link.kind === 'sequence' && !includeSequence) continue;
    if (link.kind === 'cross_link' && !includeCrossLinks) continue;
    map.get(link.source)?.add(link.target);
    map.get(link.target)?.add(link.source);
  }

  // If hovering a cluster, also include 2-hop satellites under its planets
  for (const node of nodes) {
    if (node.kind === 'satellite' && node.parentId) {
      const planet = nodes.find((n) => n.id === node.parentId);
      if (planet?.parentId) {
        map.get(planet.parentId)?.add(node.id);
      }
    }
  }

  return map;
}

export function createGalaxyPhysicsState(
  graph: BookGalaxyGraph,
): GalaxyPhysicsState {
  const bodies = new Map<string, GalaxySimBody>();
  const bodyList: GalaxySimBody[] = [];

  for (const node of graph.nodes) {
    const body: GalaxySimBody = {
      id: node.id,
      kind: node.kind,
      parentId: node.parentId,
      x: node.x,
      y: node.y,
      vx: 0,
      vy: 0,
      anchorX: node.x,
      anchorY: node.y,
      fx: null,
      fy: null,
      radius: node.radius,
      orbitRadius: node.orbitRadius ?? Math.hypot(node.x, node.y),
      orbitAngle: node.orbitAngle ?? Math.atan2(node.y, node.x),
    };
    bodies.set(node.id, body);
    bodyList.push(body);
  }

  return {
    bodies,
    bodyList,
    links: graph.links,
    alpha: 0.45,
  };
}

/**
 * Advances the force-directed simulation by one 60fps tick.
 * Returns true if the simulation is still active (alpha > 0.002 or dragging).
 */
export function stepGalaxyPhysics(
  state: GalaxyPhysicsState,
  config: GalaxyPhysicsConfig = DEFAULT_GALAXY_PHYSICS_CONFIG,
  visibleIds?: Set<string>,
): boolean {
  const { bodies, bodyList, links } = state;
  const hasPinned = bodyList.some((b) => b.fx !== null || b.fy !== null);
  if (state.alpha < 0.002 && !hasPinned) {
    return false;
  }

  const activeAlpha = hasPinned ? Math.max(state.alpha, 0.28) : state.alpha;
  const distScale = config.linkDistanceScale;
  const tension = config.linkTension;
  const repel = config.repelStrength;
  const gravity = config.centerGravity;

  const activeBodies = visibleIds
    ? bodyList.filter((b) => visibleIds.has(b.id))
    : bodyList;
  const n = activeBodies.length;

  // 1. Pairwise Many-Body Charge Repulsion (Spatial window pruned for O(N) fast performance on 600+ nodes)
  const maxRepelDist = 210;
  const maxRepelDistSq = maxRepelDist * maxRepelDist;

  for (let i = 0; i < n; i++) {
    const a = activeBodies[i];
    for (let j = i + 1; j < n; j++) {
      const b = activeBodies[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) > maxRepelDist || Math.abs(dy) > maxRepelDist) continue;
      const dSq = dx * dx + dy * dy;
      if (dSq > maxRepelDistSq) continue;

      const dist = Math.max(8, Math.sqrt(dSq));
      const minGap = (a.radius + b.radius + 22) * Math.sqrt(repel);
      const charge =
        a.kind === 'sun' || b.kind === 'sun'
          ? 2400 * repel
          : a.kind === 'cluster' && b.kind === 'cluster'
            ? 1450 * repel
            : 460 * repel;

      let force = (charge / (dSq + 120)) * activeAlpha;
      if (dist < minGap) {
        force += (minGap - dist) * 0.22 * activeAlpha;
      }

      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (a.fx === null && a.kind !== 'sun') {
        a.vx -= fx;
        a.vy -= fy;
      }
      if (b.fx === null && b.kind !== 'sun') {
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  // 2. Hookean Spring Forces along Topological Links
  for (const link of links) {
    if (
      visibleIds &&
      (!visibleIds.has(link.source) || !visibleIds.has(link.target))
    ) {
      continue;
    }
    const src = bodies.get(link.source);
    const tgt = bodies.get(link.target);
    if (!src || !tgt) continue;

    const dx = tgt.x - src.x;
    const dy = tgt.y - src.y;
    const dist = Math.max(1, Math.hypot(dx, dy));

    if (link.kind === 'orbit') {
      const restLength = (tgt.orbitRadius || 100) * distScale;
      const k =
        (tgt.kind === 'cluster' ? 0.065 : tgt.kind === 'planet' ? 0.14 : 0.18) *
        tension *
        activeAlpha;
      const delta = (dist - restLength) * k;
      const fx = (dx / dist) * delta;
      const fy = (dy / dist) * delta;

      if (src.fx === null && src.kind !== 'sun') {
        // Parent feels lighter pull from child unless child is actively dragged
        const parentWeight = tgt.fx !== null ? 0.55 : 0.22;
        src.vx += fx * parentWeight;
        src.vy += fy * parentWeight;
      }
      if (tgt.fx === null) {
        const childWeight = src.fx !== null ? 0.92 : 0.78;
        tgt.vx -= fx * childWeight;
        tgt.vy -= fy * childWeight;
      }
    } else if (link.kind === 'cross_link') {
      const restLength = 240 * distScale;
      const k = 0.015 * tension * activeAlpha;
      const delta = (dist - restLength) * k;
      const fx = (dx / dist) * delta;
      const fy = (dy / dist) * delta;
      if (src.fx === null) {
        src.vx += fx;
        src.vy += fy;
      }
      if (tgt.fx === null) {
        tgt.vx -= fx;
        tgt.vy -= fy;
      }
    }
  }

  // 3. Soft Anchor & Radial Orientation Gravity (prevents subtrees from inverting while staying elastic)
  const sun = bodies.get('sun-root');
  if (sun && sun.fx === null) {
    sun.vx += (0 - sun.x) * 0.18 * gravity;
    sun.vy += (0 - sun.y) * 0.18 * gravity;
  }

  for (let i = 0; i < n; i++) {
    const body = activeBodies[i];
    if (body.fx !== null && body.fy !== null) {
      body.x = body.fx;
      body.y = body.fy;
      body.vx = 0;
      body.vy = 0;
      continue;
    }

    if (body.kind === 'cluster' && sun) {
      const targetX = sun.x + body.anchorX * distScale;
      const targetY = sun.y + body.anchorY * distScale;
      body.vx += (targetX - body.x) * 0.042 * gravity * activeAlpha;
      body.vy += (targetY - body.y) * 0.042 * gravity * activeAlpha;
    } else if (body.kind === 'planet' && body.parentId) {
      const parent = bodies.get(body.parentId);
      if (parent) {
        // Desired position relative to parent's current live position
        const relX = Math.cos(body.orbitAngle) * body.orbitRadius * distScale;
        const relY = Math.sin(body.orbitAngle) * body.orbitRadius * distScale;
        const targetX = parent.x + relX;
        const targetY = parent.y + relY;
        const pull = parent.fx !== null ? 0.16 : 0.055 * gravity * activeAlpha;
        body.vx += (targetX - body.x) * pull;
        body.vy += (targetY - body.y) * pull;
      }
    } else if (body.kind === 'satellite' && body.parentId) {
      const parent = bodies.get(body.parentId);
      if (parent) {
        const relX = Math.cos(body.orbitAngle) * body.orbitRadius * distScale;
        const relY = Math.sin(body.orbitAngle) * body.orbitRadius * distScale;
        const targetX = parent.x + relX;
        const targetY = parent.y + relY;
        const pull = parent.fx !== null ? 0.2 : 0.075 * gravity * activeAlpha;
        body.vx += (targetX - body.x) * pull;
        body.vy += (targetY - body.y) * pull;
      }
    }

    // Damping and velocity clamping
    body.vx *= 0.76;
    body.vy *= 0.76;

    const speed = Math.hypot(body.vx, body.vy);
    if (speed > 28) {
      body.vx = (body.vx / speed) * 28;
      body.vy = (body.vy / speed) * 28;
    }

    body.x += body.vx;
    body.y += body.vy;
  }

  if (!hasPinned) {
    state.alpha *= 0.965;
  }

  return true;
}
