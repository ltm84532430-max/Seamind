import { applyOverlay } from './queue';
import type { Overlay } from './queue';
import type { LearningPathDetail, LearningPathNode, VideoItem } from './types';
import { videoWatchUrl } from './video-links';

export type LearningPathLayoutMode =
  | 'tree'
  | 'metro'
  | 'dag'
  | 'lanes'
  | 'radial';

export type LearningPathTheme =
  | 'terracotta'
  | 'blueprint'
  | 'cyber'
  | 'botanical'
  | 'minimal';

export type LearningPathConnectorStyle = 'curve' | 'orthogonal' | 'metro';

export type NodeUnlockStatus = 'completed' | 'in_progress' | 'ready' | 'locked';

export interface PositionedPathNode {
  node: LearningPathNode;
  video: VideoItem | null;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
  row: number;
  stageIndex: number;
  orderIndex: number | null;
  status: NodeUnlockStatus;
  progressRatio: number;
  isNextUp: boolean;
}

export interface PositionedPathEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: 'hierarchy' | 'spine' | 'prerequisite' | 'siding';
  active: boolean;
  optional: boolean;
  pathD: string;
}

export interface StageColumnHeader {
  stageNodeId: string;
  title: string;
  note: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  completedCount: number;
  totalCount: number;
}

export interface LearningPathLayoutResult {
  width: number;
  height: number;
  nodes: PositionedPathNode[];
  edges: PositionedPathEdge[];
  laneHeaders: StageColumnHeader[];
  orderedPlayableNodes: PositionedPathNode[];
  nextUpNodeId: string | null;
}

export interface LearningPathStageOverview {
  nodeId: string;
  title: string;
  note: string | null;
  index: number;
  completedCount: number;
  videoCount: number;
  optionalCount: number;
  isCurrent: boolean;
}

export function buildLearningPathStageOverview(
  detail: LearningPathDetail,
  layout: LearningPathLayoutResult,
): LearningPathStageOverview[] {
  const nodes = [...detail.nodes].sort(
    (a, b) => a.position - b.position || a.nodeId.localeCompare(b.nodeId),
  );
  const ids = new Set(nodes.map((node) => node.nodeId));
  const roots = nodes.filter(
    (node) => !node.parentId || !ids.has(node.parentId),
  );

  return roots.map((root, index) => {
    const lessons = layout.nodes.filter(
      (item) => item.stageIndex === index && item.video,
    );
    return {
      nodeId: root.nodeId,
      title: root.title,
      note: root.note ?? null,
      index,
      completedCount: lessons.filter((item) => item.status === 'completed')
        .length,
      videoCount: lessons.length,
      optionalCount: lessons.filter((item) => item.node.optional).length,
      isCurrent: lessons.some((item) => item.isNextUp),
    };
  });
}

const NODE_WIDTH_VIDEO = 276;
const NODE_HEIGHT_VIDEO = 148;
const NODE_WIDTH_STAGE = 276;
const NODE_HEIGHT_STAGE = 108;
const PADDING_X = 64;
const PADDING_Y = 64;

export function buildConnectorPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  style: LearningPathConnectorStyle,
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.abs(dy) < 1.5 && dx >= 0) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  if (style === 'orthogonal') {
    const midX = x1 + Math.max(28, dx * 0.5);
    const radius = Math.min(14, Math.abs(dy) / 2, Math.abs(midX - x1));
    const signY = dy >= 0 ? 1 : -1;
    if (dx < 24) {
      const detourX = Math.max(x1, x2) + 32;
      return `M ${x1} ${y1} L ${detourX} ${y1} L ${detourX} ${y2} L ${x2} ${y2}`;
    }
    return [
      `M ${x1} ${y1}`,
      `L ${midX - radius} ${y1}`,
      `Q ${midX} ${y1} ${midX} ${y1 + signY * radius}`,
      `L ${midX} ${y2 - signY * radius}`,
      `Q ${midX} ${y2} ${midX + radius} ${y2}`,
      `L ${x2} ${y2}`,
    ].join(' ');
  }

  if (style === 'metro') {
    const absDy = Math.abs(dy);
    const signY = dy >= 0 ? 1 : -1;
    const diag = Math.min(absDy, Math.max(24, Math.abs(dx) * 0.45));
    const lead = Math.max(18, (dx - diag) * 0.35);
    if (dx >= diag + 16) {
      const turnX = x1 + lead;
      const endDiagX = turnX + diag;
      if (Math.abs(y1 + signY * diag - y2) < 1.5) {
        return `M ${x1} ${y1} L ${turnX} ${y1} L ${endDiagX} ${y2} L ${x2} ${y2}`;
      }
      return `M ${x1} ${y1} L ${turnX} ${y1} L ${endDiagX} ${y1 + signY * diag} L ${endDiagX} ${y2} L ${x2} ${y2}`;
    }
  }

  const tension = Math.max(54, Math.abs(dx) * 0.48);
  return `M ${x1} ${y1} C ${x1 + tension} ${y1}, ${x2 - tension} ${y2}, ${x2} ${y2}`;
}

function nodeDimensions(node: LearningPathNode): {
  width: number;
  height: number;
} {
  if (node.kind === 'stage' && !node.videoId) {
    return { width: NODE_WIDTH_STAGE, height: NODE_HEIGHT_STAGE };
  }
  return { width: NODE_WIDTH_VIDEO, height: NODE_HEIGHT_VIDEO };
}

function isNodeDone(
  node: LearningPathNode,
  videoMap: Map<string, VideoItem | null>,
  childrenMap: Map<string, LearningPathNode[]>,
  memo: Map<string, boolean>,
): boolean {
  const cached = memo.get(node.nodeId);
  if (cached !== undefined) return cached;
  memo.set(node.nodeId, false);
  const video = videoMap.get(node.nodeId) ?? null;
  if (video) {
    memo.set(node.nodeId, video.finished);
    return video.finished;
  }
  const children = (childrenMap.get(node.nodeId) ?? []).filter(
    (child) => !child.optional,
  );
  if (children.length === 0) {
    const allChildren = childrenMap.get(node.nodeId) ?? [];
    if (allChildren.length === 0) {
      memo.set(node.nodeId, false);
      return false;
    }
    const doneAll = allChildren.every((child) =>
      isNodeDone(child, videoMap, childrenMap, memo),
    );
    memo.set(node.nodeId, doneAll);
    return doneAll;
  }
  const done = children.every((child) =>
    isNodeDone(child, videoMap, childrenMap, memo),
  );
  memo.set(node.nodeId, done);
  return done;
}

export function computeLearningPathLayout(
  detail: LearningPathDetail,
  overlay: Overlay,
  mode: LearningPathLayoutMode,
  connectorStyle: LearningPathConnectorStyle,
): LearningPathLayoutResult {
  const sortedNodes = [...detail.nodes].sort(
    (a, b) => a.position - b.position || a.nodeId.localeCompare(b.nodeId),
  );
  if (sortedNodes.length === 0) {
    return {
      width: 720,
      height: 420,
      nodes: [],
      edges: [],
      laneHeaders: [],
      orderedPlayableNodes: [],
      nextUpNodeId: null,
    };
  }

  const nodeById = new Map<string, LearningPathNode>();
  const videoByNodeId = new Map<string, VideoItem | null>();
  const childrenMap = new Map<string, LearningPathNode[]>();
  for (const node of sortedNodes) {
    nodeById.set(node.nodeId, node);
    videoByNodeId.set(
      node.nodeId,
      node.video ? applyOverlay(node.video, overlay) : null,
    );
    childrenMap.set(node.nodeId, []);
  }

  const roots: LearningPathNode[] = [];
  for (const node of sortedNodes) {
    if (node.parentId && childrenMap.has(node.parentId)) {
      childrenMap.get(node.parentId)!.push(node);
    } else {
      roots.push(node);
    }
  }

  // Compute completion & unlock statuses
  const doneMemo = new Map<string, boolean>();
  for (const node of sortedNodes) {
    isNodeDone(node, videoByNodeId, childrenMap, doneMemo);
  }

  // Determine stage index for each node (inherited from root ancestor)
  const stageIndexById = new Map<string, number>();
  const assignStage = (node: LearningPathNode, stageIdx: number) => {
    stageIndexById.set(node.nodeId, stageIdx);
    for (const child of childrenMap.get(node.nodeId) ?? []) {
      assignStage(child, stageIdx);
    }
  };
  roots.forEach((root, idx) => assignStage(root, idx));
  for (const node of sortedNodes) {
    if (!stageIndexById.has(node.nodeId)) stageIndexById.set(node.nodeId, 0);
  }

  // Traversal order for playback queue (mainline first within each stage subtree, then optional)
  const traversalOrder: LearningPathNode[] = [];
  const visitedTraversal = new Set<string>();
  const walkSubtree = (node: LearningPathNode) => {
    if (visitedTraversal.has(node.nodeId)) return;
    visitedTraversal.add(node.nodeId);
    traversalOrder.push(node);
    const kids = childrenMap.get(node.nodeId) ?? [];
    const mainKids = kids.filter((k) => !k.optional);
    const optKids = kids.filter((k) => k.optional);
    for (const child of mainKids) walkSubtree(child);
    for (const child of optKids) walkSubtree(child);
  };
  for (const root of roots) walkSubtree(root);
  for (const node of sortedNodes) walkSubtree(node);

  let orderCounter = 0;
  const orderIndexById = new Map<string, number | null>();
  for (const node of traversalOrder) {
    if (videoByNodeId.get(node.nodeId)) {
      orderCounter += 1;
      orderIndexById.set(node.nodeId, orderCounter);
    } else {
      orderIndexById.set(node.nodeId, null);
    }
  }

  const statusById = new Map<string, NodeUnlockStatus>();
  const progressRatioById = new Map<string, number>();
  for (const node of sortedNodes) {
    const video = videoByNodeId.get(node.nodeId);
    const done = doneMemo.get(node.nodeId) ?? false;
    let ratio = done ? 1 : 0;
    if (!done && video && video.progressSeconds && video.durationSeconds) {
      ratio = Math.max(
        0,
        Math.min(0.98, video.progressSeconds / video.durationSeconds),
      );
    } else if (!video) {
      const kids = childrenMap.get(node.nodeId) ?? [];
      if (kids.length > 0) {
        const finishedKids = kids.filter((k) => doneMemo.get(k.nodeId)).length;
        ratio = finishedKids / kids.length;
      }
    }
    progressRatioById.set(node.nodeId, ratio);

    if (done) {
      statusById.set(node.nodeId, 'completed');
      continue;
    }
    const prereqsMet = node.prerequisiteIds.every(
      (reqId) => doneMemo.get(reqId) ?? true,
    );
    if (!prereqsMet) {
      statusById.set(node.nodeId, 'locked');
    } else if (ratio > 0) {
      statusById.set(node.nodeId, 'in_progress');
    } else {
      statusById.set(node.nodeId, 'ready');
    }
  }

  const nextUpNode =
    traversalOrder.find((node) => {
      if (!videoByNodeId.get(node.nodeId) || node.optional) return false;
      const st = statusById.get(node.nodeId);
      return st === 'in_progress' || st === 'ready';
    }) ??
    traversalOrder.find((node) => {
      if (!videoByNodeId.get(node.nodeId)) return false;
      return statusById.get(node.nodeId) !== 'completed';
    }) ??
    null;
  const nextUpNodeId = nextUpNode?.nodeId ?? null;

  // Coordinates & raw edge specs per layout mode
  const coords = new Map<
    string,
    { x: number; y: number; column: number; row: number }
  >();
  const rawEdges: {
    fromId: string;
    toId: string;
    kind: PositionedPathEdge['kind'];
  }[] = [];
  const laneHeaders: StageColumnHeader[] = [];

  if (mode === 'tree') {
    layoutLeftToRightTree(roots, childrenMap, sortedNodes, coords, rawEdges);
  } else if (mode === 'metro') {
    layoutMetroTrack(roots, childrenMap, traversalOrder, coords, rawEdges);
  } else if (mode === 'dag') {
    layoutSkillDag(roots, childrenMap, sortedNodes, coords, rawEdges);
  } else if (mode === 'radial') {
    layoutRadialConstellation(
      roots,
      childrenMap,
      sortedNodes,
      coords,
      rawEdges,
    );
  } else {
    layoutStageLanes(
      roots,
      childrenMap,
      doneMemo,
      videoByNodeId,
      coords,
      rawEdges,
      laneHeaders,
    );
  }

  // Normalize positive bounding box with padding
  let minX = Infinity;
  let minY = Infinity;
  for (const pos of coords.values()) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
  }
  for (const header of laneHeaders) {
    minX = Math.min(minX, header.x);
    minY = Math.min(minY, header.y);
  }
  const shiftX = Number.isFinite(minX) ? PADDING_X - minX : 0;
  const shiftY = Number.isFinite(minY) ? PADDING_Y - minY : 0;

  let maxX = 0;
  let maxY = 0;
  const positionedNodes: PositionedPathNode[] = sortedNodes.map((node) => {
    const raw = coords.get(node.nodeId) ?? {
      x: 0,
      y: 0,
      column: 0,
      row: 0,
    };
    const { width, height } = nodeDimensions(node);
    const x = Math.round(raw.x + shiftX);
    const y = Math.round(raw.y + shiftY);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
    return {
      node,
      video: videoByNodeId.get(node.nodeId) ?? null,
      x,
      y,
      width,
      height,
      column: raw.column,
      row: raw.row,
      stageIndex: stageIndexById.get(node.nodeId) ?? 0,
      orderIndex: orderIndexById.get(node.nodeId) ?? null,
      status: statusById.get(node.nodeId) ?? 'ready',
      progressRatio: progressRatioById.get(node.nodeId) ?? 0,
      isNextUp: node.nodeId === nextUpNodeId,
    };
  });

  const shiftedHeaders = laneHeaders.map((header) => {
    const x = Math.round(header.x + shiftX);
    const y = Math.round(header.y + shiftY);
    maxX = Math.max(maxX, x + header.width);
    maxY = Math.max(maxY, y + header.height);
    return { ...header, x, y };
  });

  const posMap = new Map(
    positionedNodes.map((item) => [item.node.nodeId, item]),
  );
  const seenEdgeKeys = new Set<string>();
  const positionedEdges: PositionedPathEdge[] = [];
  const effectiveConnector: LearningPathConnectorStyle =
    mode === 'metro' && connectorStyle === 'curve' ? 'metro' : connectorStyle;

  for (const spec of rawEdges) {
    if (spec.fromId === spec.toId) continue;
    const key = `${spec.fromId}->${spec.toId}`;
    if (seenEdgeKeys.has(key)) continue;
    const source = posMap.get(spec.fromId);
    const target = posMap.get(spec.toId);
    if (!source || !target) continue;
    seenEdgeKeys.add(key);

    const x1 =
      mode === 'radial'
        ? source.x + Math.round(source.width / 2)
        : source.x + source.width;
    const y1 = source.y + Math.round(source.height / 2);
    const x2 =
      mode === 'radial' ? target.x + Math.round(target.width / 2) : target.x;
    const y2 = target.y + Math.round(target.height / 2);

    positionedEdges.push({
      id: key,
      fromId: spec.fromId,
      toId: spec.toId,
      kind: spec.kind,
      active: source.status === 'completed',
      optional: target.node.optional,
      pathD:
        mode === 'radial'
          ? `M ${x1} ${y1} Q ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2 - 28)} ${x2} ${y2}`
          : buildConnectorPath(x1, y1, x2, y2, effectiveConnector),
    });
  }

  const orderedPlayableNodes = traversalOrder
    .map((node) => posMap.get(node.nodeId))
    .filter((item): item is PositionedPathNode => Boolean(item?.video));

  return {
    width: Math.max(720, maxX + PADDING_X),
    height: Math.max(420, maxY + PADDING_Y),
    nodes: positionedNodes,
    edges: positionedEdges,
    laneHeaders: shiftedHeaders,
    orderedPlayableNodes,
    nextUpNodeId,
  };
}

function layoutLeftToRightTree(
  roots: LearningPathNode[],
  childrenMap: Map<string, LearningPathNode[]>,
  allNodes: LearningPathNode[],
  coords: Map<string, { x: number; y: number; column: number; row: number }>,
  edges: { fromId: string; toId: string; kind: PositionedPathEdge['kind'] }[],
) {
  const COL_STEP = 348;
  const V_GAP = 28;
  let currentStartCol = 0;

  const measureMaxRelDepth = (
    node: LearningPathNode,
    seen: Set<string>,
  ): number => {
    if (seen.has(node.nodeId)) return 0;
    seen.add(node.nodeId);
    const kids = childrenMap.get(node.nodeId) ?? [];
    if (kids.length === 0) return 0;
    return (
      1 + Math.max(...kids.map((child) => measureMaxRelDepth(child, seen)))
    );
  };

  let prevRoot: LearningPathNode | null = null;
  for (const root of roots) {
    const seen = new Set<string>();
    let leafCursorY = 0;
    let leafRow = 0;

    const placeSubtree = (
      node: LearningPathNode,
      relCol: number,
    ): { centerY: number } => {
      const col = currentStartCol + relCol;
      const { height } = nodeDimensions(node);
      const kids = (childrenMap.get(node.nodeId) ?? []).filter(
        (child) => !seen.has(child.nodeId),
      );
      seen.add(node.nodeId);

      if (kids.length === 0) {
        const y = leafCursorY;
        const centerY = y + height / 2;
        coords.set(node.nodeId, {
          x: col * COL_STEP,
          y,
          column: col,
          row: leafRow,
        });
        leafCursorY += height + V_GAP;
        leafRow += 1;
        return { centerY };
      }

      const childCenters: number[] = [];
      for (const child of kids) {
        edges.push({
          fromId: node.nodeId,
          toId: child.nodeId,
          kind: child.optional ? 'siding' : 'hierarchy',
        });
        childCenters.push(placeSubtree(child, relCol + 1).centerY);
      }
      const midCenter =
        (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
      const y = midCenter - height / 2;
      coords.set(node.nodeId, {
        x: col * COL_STEP,
        y,
        column: col,
        row: 0,
      });
      return { centerY: midCenter };
    };

    const rootCenter = placeSubtree(root, 0).centerY;
    // Shift this stage subtree vertically so root aligns cleanly with horizontal centerline (y = 0)
    const offsetY = -rootCenter;
    for (const id of seen) {
      const existing = coords.get(id);
      if (existing) {
        coords.set(id, { ...existing, y: existing.y + offsetY });
      }
    }

    if (prevRoot) {
      edges.push({
        fromId: prevRoot.nodeId,
        toId: root.nodeId,
        kind: 'spine',
      });
    }
    prevRoot = root;
    const maxRel = measureMaxRelDepth(root, new Set());
    currentStartCol += maxRel + 1;
  }

  for (const node of allNodes) {
    for (const reqId of node.prerequisiteIds) {
      if (reqId !== node.parentId) {
        edges.push({
          fromId: reqId,
          toId: node.nodeId,
          kind: 'prerequisite',
        });
      }
    }
  }
}

function layoutMetroTrack(
  roots: LearningPathNode[],
  childrenMap: Map<string, LearningPathNode[]>,
  traversalOrder: LearningPathNode[],
  coords: Map<string, { x: number; y: number; column: number; row: number }>,
  edges: { fromId: string; toId: string; kind: PositionedPathEdge['kind'] }[],
) {
  const STATION_STEP = 336;
  const MAIN_CENTER_Y = 220;
  const SIDING_DELTA_Y = 205;

  const mainline = traversalOrder.filter((node) => !node.optional);
  const optionals = traversalOrder.filter((node) => node.optional);

  // If every node was marked optional, treat all as mainline so canvas isn't empty
  const effectiveMain = mainline.length > 0 ? mainline : traversalOrder;
  const effectiveOpt = mainline.length > 0 ? optionals : [];

  const mainColById = new Map<string, number>();
  effectiveMain.forEach((node, idx) => {
    const { height } = nodeDimensions(node);
    mainColById.set(node.nodeId, idx);
    coords.set(node.nodeId, {
      x: idx * STATION_STEP,
      y: MAIN_CENTER_Y - height / 2,
      column: idx,
      row: 0,
    });
    if (idx > 0) {
      edges.push({
        fromId: effectiveMain[idx - 1].nodeId,
        toId: node.nodeId,
        kind: 'spine',
      });
    }
  });

  // Place optional branches on upper/lower metro sidings anchored to parent or prerequisite
  const occupiedSlots = new Set<string>();
  let toggleDirection = 1;
  for (const opt of effectiveOpt) {
    const anchorId =
      opt.parentId ?? opt.prerequisiteIds[0] ?? roots[0]?.nodeId ?? null;
    const anchorPos = anchorId ? coords.get(anchorId) : undefined;
    let baseCol = anchorPos ? anchorPos.column + 1 : 0;
    let laneRow = toggleDirection;
    toggleDirection = toggleDirection === 1 ? -1 : 1;

    while (occupiedSlots.has(`${baseCol}:${laneRow}`)) {
      if (!occupiedSlots.has(`${baseCol}:${-laneRow}`)) {
        laneRow = -laneRow;
      } else {
        baseCol += 1;
      }
    }
    occupiedSlots.add(`${baseCol}:${laneRow}`);
    const { height } = nodeDimensions(opt);
    const centerY = MAIN_CENTER_Y + laneRow * SIDING_DELTA_Y;
    coords.set(opt.nodeId, {
      x: baseCol * STATION_STEP,
      y: centerY - height / 2,
      column: baseCol,
      row: laneRow,
    });
    if (anchorId) {
      edges.push({
        fromId: anchorId,
        toId: opt.nodeId,
        kind: 'siding',
      });
    }
    for (const child of childrenMap.get(opt.nodeId) ?? []) {
      edges.push({
        fromId: opt.nodeId,
        toId: child.nodeId,
        kind: 'siding',
      });
    }
  }

  for (const node of traversalOrder) {
    for (const reqId of node.prerequisiteIds) {
      edges.push({
        fromId: reqId,
        toId: node.nodeId,
        kind: 'prerequisite',
      });
    }
  }
}

function layoutSkillDag(
  roots: LearningPathNode[],
  childrenMap: Map<string, LearningPathNode[]>,
  allNodes: LearningPathNode[],
  coords: Map<string, { x: number; y: number; column: number; row: number }>,
  edges: { fromId: string; toId: string; kind: PositionedPathEdge['kind'] }[],
) {
  const COL_STEP = 352;
  const ROW_STEP = 192;

  const incoming = new Map<string, Set<string>>();
  for (const node of allNodes) incoming.set(node.nodeId, new Set());

  for (let i = 0; i < roots.length - 1; i += 1) {
    // Only chain consecutive root stages if the next root has no explicit prerequisites
    if (roots[i + 1].prerequisiteIds.length === 0) {
      incoming.get(roots[i + 1].nodeId)?.add(roots[i].nodeId);
      edges.push({
        fromId: roots[i].nodeId,
        toId: roots[i + 1].nodeId,
        kind: 'spine',
      });
    }
  }

  for (const node of allNodes) {
    if (node.parentId && incoming.has(node.parentId)) {
      incoming.get(node.nodeId)!.add(node.parentId);
      edges.push({
        fromId: node.parentId,
        toId: node.nodeId,
        kind: node.optional ? 'siding' : 'hierarchy',
      });
    }
    for (const reqId of node.prerequisiteIds) {
      if (incoming.has(reqId)) {
        incoming.get(node.nodeId)!.add(reqId);
        edges.push({
          fromId: reqId,
          toId: node.nodeId,
          kind: 'prerequisite',
        });
      }
    }
  }

  // Longest-path rank calculation (cycle-safe via visiting guard)
  const rankMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const computeRank = (id: string): number => {
    const cached = rankMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let rank = 0;
    for (const pred of incoming.get(id) ?? []) {
      rank = Math.max(rank, computeRank(pred) + 1);
    }
    visiting.delete(id);
    rankMemo.set(id, rank);
    return rank;
  };

  const columns = new Map<number, LearningPathNode[]>();
  for (const node of allNodes) {
    const r = computeRank(node.nodeId);
    const bucket = columns.get(r) ?? [];
    bucket.push(node);
    columns.set(r, bucket);
  }

  const maxBucketSize = Math.max(
    1,
    ...Array.from(columns.values()).map((b) => b.length),
  );
  const canvasCenterY = (maxBucketSize * ROW_STEP) / 2;

  for (const [col, bucket] of columns.entries()) {
    // Barycenter heuristic: sort by average Y of predecessors so crossing edges are minimized
    bucket.sort((a, b) => {
      const avgPredY = (n: LearningPathNode) => {
        const preds = Array.from(incoming.get(n.nodeId) ?? [])
          .map((pid) => coords.get(pid)?.y)
          .filter((v): v is number => v !== undefined);
        if (preds.length === 0) return n.position * 10;
        return preds.reduce((sum, y) => sum + y, 0) / preds.length;
      };
      return avgPredY(a) - avgPredY(b) || a.position - b.position;
    });

    const totalHeight =
      bucket.reduce((acc, n) => acc + nodeDimensions(n).height, 0) +
      Math.max(0, bucket.length - 1) * 32;
    let cursorY = canvasCenterY - totalHeight / 2;
    bucket.forEach((node, rowIdx) => {
      const { height } = nodeDimensions(node);
      coords.set(node.nodeId, {
        x: col * COL_STEP,
        y: cursorY,
        column: col,
        row: rowIdx,
      });
      cursorY += height + 32;
    });
  }

  void childrenMap;
}

function layoutStageLanes(
  roots: LearningPathNode[],
  childrenMap: Map<string, LearningPathNode[]>,
  doneMemo: Map<string, boolean>,
  videoMap: Map<string, VideoItem | null>,
  coords: Map<string, { x: number; y: number; column: number; row: number }>,
  edges: { fromId: string; toId: string; kind: PositionedPathEdge['kind'] }[],
  laneHeaders: StageColumnHeader[],
) {
  const LANE_WIDTH = 312;
  const LANE_GAP = 56;
  const HEADER_HEIGHT = 68;
  const CARD_GAP = 22;

  roots.forEach((root, colIdx) => {
    const laneX = colIdx * (LANE_WIDTH + LANE_GAP);
    const items: LearningPathNode[] = [];
    const seen = new Set<string>();
    const collect = (node: LearningPathNode) => {
      if (seen.has(node.nodeId)) return;
      seen.add(node.nodeId);
      items.push(node);
      for (const child of childrenMap.get(node.nodeId) ?? []) {
        collect(child);
      }
    };
    collect(root);

    // If root is a pure stage node (no video) and has children, promote root to column header
    const hasPureStageRoot =
      root.kind === 'stage' && !root.videoId && items.length > 1;
    const laneCards = hasPureStageRoot ? items.slice(1) : items;

    const playableInLane = items.filter((n) => Boolean(videoMap.get(n.nodeId)));
    const completedInLane = playableInLane.filter((n) =>
      doneMemo.get(n.nodeId),
    ).length;

    laneHeaders.push({
      stageNodeId: root.nodeId,
      title: hasPureStageRoot ? root.title : `阶段 ${colIdx + 1}`,
      note: hasPureStageRoot ? root.note : null,
      x: laneX,
      y: 0,
      width: LANE_WIDTH,
      height: HEADER_HEIGHT,
      completedCount: completedInLane,
      totalCount: playableInLane.length,
    });

    let cursorY = HEADER_HEIGHT + 24;
    laneCards.forEach((cardNode, rowIdx) => {
      const { width, height } = nodeDimensions(cardNode);
      const centeredX = laneX + Math.round((LANE_WIDTH - width) / 2);
      coords.set(cardNode.nodeId, {
        x: centeredX,
        y: cursorY,
        column: colIdx,
        row: rowIdx,
      });
      cursorY += height + CARD_GAP;
    });

    // If root was promoted to header, still give it header coordinates so edges from/to it resolve cleanly
    if (hasPureStageRoot) {
      coords.set(root.nodeId, {
        x: laneX,
        y: 0,
        column: colIdx,
        row: -1,
      });
    }

    // Intra-lane vertical sequence & cross-lane prerequisite edges
    for (let i = 0; i < laneCards.length - 1; i += 1) {
      edges.push({
        fromId: laneCards[i].nodeId,
        toId: laneCards[i + 1].nodeId,
        kind: laneCards[i + 1].optional ? 'siding' : 'hierarchy',
      });
    }
    for (const cardNode of laneCards) {
      for (const reqId of cardNode.prerequisiteIds) {
        edges.push({
          fromId: reqId,
          toId: cardNode.nodeId,
          kind: 'prerequisite',
        });
      }
    }
  });

  // Remove positioned node entries for pure stage roots ONLY? Wait: keeping pure stage roots hidden or positioned?
  // Better: in lanes mode, if root is pure stage with children, place root at top of column as normal stage card OR skip duplicate header!
  // Let's keep laneHeaders purely decorative column banners above `y = -88` so every node card remains clickable and editable in every mode!
  laneHeaders.forEach((header) => {
    header.y = -92;
  });
  roots.forEach((root, colIdx) => {
    const hasPureStageRoot =
      root.kind === 'stage' &&
      !root.videoId &&
      (childrenMap.get(root.nodeId)?.length ?? 0) > 0;
    if (hasPureStageRoot) {
      const laneX = colIdx * (LANE_WIDTH + LANE_GAP);
      const { width, height } = nodeDimensions(root);
      const centeredX = laneX + Math.round((LANE_WIDTH - width) / 2);
      coords.set(root.nodeId, {
        x: centeredX,
        y: 0,
        column: colIdx,
        row: 0,
      });
      // Shift descendants down below root stage card
      let cursorY = height + CARD_GAP;
      const seen = new Set<string>([root.nodeId]);
      const descendants: LearningPathNode[] = [];
      const walk = (n: LearningPathNode) => {
        for (const c of childrenMap.get(n.nodeId) ?? []) {
          if (!seen.has(c.nodeId)) {
            seen.add(c.nodeId);
            descendants.push(c);
            walk(c);
          }
        }
      };
      walk(root);
      descendants.forEach((cardNode, idx) => {
        const dims = nodeDimensions(cardNode);
        coords.set(cardNode.nodeId, {
          x: laneX + Math.round((LANE_WIDTH - dims.width) / 2),
          y: cursorY,
          column: colIdx,
          row: idx + 1,
        });
        cursorY += dims.height + CARD_GAP;
      });
      if (descendants.length > 0) {
        edges.push({
          fromId: root.nodeId,
          toId: descendants[0].nodeId,
          kind: 'hierarchy',
        });
      }
    }
    if (colIdx > 0) {
      edges.push({
        fromId: roots[colIdx - 1].nodeId,
        toId: root.nodeId,
        kind: 'spine',
      });
    }
  });
}

export function learningPathToMarkdown(detail: LearningPathDetail): string {
  const lines: string[] = [`# ${detail.summary.title}`];
  if (detail.summary.description) {
    lines.push('', detail.summary.description);
  }
  const byParent = new Map<string | null, LearningPathNode[]>();
  const sorted = [...detail.nodes].sort(
    (a, b) => a.position - b.position || a.nodeId.localeCompare(b.nodeId),
  );
  const validIds = new Set(sorted.map((n) => n.nodeId));
  for (const node of sorted) {
    const key =
      node.parentId && validIds.has(node.parentId) ? node.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }

  const visited = new Set<string>();
  const emitNode = (node: LearningPathNode, depth: number) => {
    if (visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    const headingPrefix = '#'.repeat(Math.min(6, depth + 2));
    const optTag = node.optional ? '（选修）' : '';
    lines.push('', `${headingPrefix} ${node.title}${optTag}`);
    if (node.note) {
      lines.push('', node.note);
    }
    if (node.videoId) {
      lines.push('', videoWatchUrl(node.videoId, node.startSeconds));
    }
    for (const child of byParent.get(node.nodeId) ?? []) {
      emitNode(child, depth + 1);
    }
  };

  for (const root of byParent.get(null) ?? []) {
    emitNode(root, 0);
  }
  return `${lines.join('\n')}\n`;
}

function layoutRadialConstellation(
  roots: LearningPathNode[],
  childrenMap: Map<string, LearningPathNode[]>,
  allNodes: LearningPathNode[],
  coords: Map<string, { x: number; y: number; column: number; row: number }>,
  edges: { fromId: string; toId: string; kind: PositionedPathEdge['kind'] }[],
) {
  const N = Math.max(1, roots.length);
  const stageOrbitRadius = N <= 4 ? 460 : N <= 7 ? 580 : 720;

  roots.forEach((root, rootIdx) => {
    const baseAngle = (2 * Math.PI * rootIdx) / N - Math.PI / 2;
    const { width: rw, height: rh } = nodeDimensions(root);
    const rx = Math.round(stageOrbitRadius * Math.cos(baseAngle) - rw / 2);
    const ry = Math.round(stageOrbitRadius * Math.sin(baseAngle) - rh / 2);
    coords.set(root.nodeId, {
      x: rx,
      y: ry,
      column: rootIdx,
      row: 0,
    });

    if (rootIdx > 0) {
      edges.push({
        fromId: roots[rootIdx - 1].nodeId,
        toId: root.nodeId,
        kind: 'spine',
      });
    }

    // Collect descendants of this stage root
    const descendants: {
      node: LearningPathNode;
      parentId: string;
      depth: number;
    }[] = [];
    const seen = new Set<string>([root.nodeId]);
    const walk = (parent: LearningPathNode, depth: number) => {
      for (const child of childrenMap.get(parent.nodeId) ?? []) {
        if (seen.has(child.nodeId)) continue;
        seen.add(child.nodeId);
        descendants.push({ node: child, parentId: parent.nodeId, depth });
        edges.push({
          fromId: parent.nodeId,
          toId: child.nodeId,
          kind: child.optional ? 'siding' : 'hierarchy',
        });
        walk(child, depth + 1);
      }
    };
    walk(root, 1);

    const sectorSpan = Math.min(
      Math.PI * 0.72,
      ((2 * Math.PI) / Math.max(2, N)) * 0.84,
    );
    const perRing = Math.max(2, Math.min(4, Math.ceil(descendants.length / 2)));

    descendants.forEach((entry, idx) => {
      const ringIdx = Math.floor(idx / perRing);
      const idxInRing = idx % perRing;
      const countInRing = Math.min(
        perRing,
        descendants.length - ringIdx * perRing,
      );
      const ringRadius = stageOrbitRadius + 380 + ringIdx * 340;
      const angle =
        countInRing === 1
          ? baseAngle
          : baseAngle -
            sectorSpan / 2 +
            (idxInRing / (countInRing - 1)) * sectorSpan;
      const { width, height } = nodeDimensions(entry.node);
      coords.set(entry.node.nodeId, {
        x: Math.round(ringRadius * Math.cos(angle) - width / 2),
        y: Math.round(ringRadius * Math.sin(angle) - height / 2),
        column: rootIdx,
        row: idx + 1,
      });
    });
  });

  for (const node of allNodes) {
    for (const reqId of node.prerequisiteIds) {
      if (reqId !== node.parentId) {
        edges.push({
          fromId: reqId,
          toId: node.nodeId,
          kind: 'prerequisite',
        });
      }
    }
  }
}

/* ==========================================================================
   Learning Path Star-Map (Obsidian-Style Force-Directed Course Constellation)
   ========================================================================== */

export const STAGE_STAR_PALETTE = [
  '#e05638', // Vermilion (Stage 1)
  '#38bdf8', // Sky Cyan (Stage 2)
  '#10b981', // Emerald (Stage 3)
  '#f59e0b', // Solar Amber (Stage 4)
  '#a855f7', // Cosmic Purple (Stage 5)
  '#ec4899', // Rose Nebula (Stage 6)
  '#6366f1', // Indigo Pulsar (Stage 7)
  '#14b8a6', // Deep Teal (Stage 8)
  '#eab308', // Gold Star (Stage 9)
  '#f43f5e', // Crimson Flare (Stage 10)
];

export type PathStarNodeKind = 'core' | 'stage' | 'video' | 'checkpoint';

export interface PathStarNode {
  id: string;
  label: string;
  kind: PathStarNodeKind;
  stageIndex: number;
  stageTitle: string;
  orderIndex: number | null;
  status: NodeUnlockStatus;
  progressRatio: number;
  isNextUp: boolean;
  optional: boolean;
  note: string | null;
  video: VideoItem | null;
  positionedNode: PositionedPathNode | null;
  parentId: string | null;
  prerequisiteIds: string[];
  dependentIds: string[];
  degree: number;
  x: number;
  y: number;
  radius: number;
  orbitRadius: number;
  orbitAngle: number;
  color: string;
}

export interface PathStarLink {
  id: string;
  source: string;
  target: string;
  kind: 'core_spoke' | 'hierarchy' | 'prerequisite' | 'spine' | 'siding';
  active: boolean;
  optional: boolean;
  color: string;
}

export interface LearningPathStarGraph {
  pathId: string;
  title: string;
  description: string | null;
  nodes: PathStarNode[];
  links: PathStarLink[];
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  stats: {
    totalStages: number;
    totalVideos: number;
    completedVideos: number;
    prerequisiteLinksCount: number;
    optionalCount: number;
  };
}

export function buildLearningPathStarGraph(
  detail: LearningPathDetail,
  layout: LearningPathLayoutResult,
): LearningPathStarGraph {
  const posById = new Map<string, PositionedPathNode>();
  for (const item of layout.nodes) {
    posById.set(item.node.nodeId, item);
  }

  const sortedNodes = [...detail.nodes].sort(
    (a, b) => a.position - b.position || a.nodeId.localeCompare(b.nodeId),
  );
  const idSet = new Set(sortedNodes.map((n) => n.nodeId));
  const childrenMap = new Map<string, LearningPathNode[]>();
  const dependentsMap = new Map<string, string[]>();

  for (const n of sortedNodes) {
    childrenMap.set(n.nodeId, []);
    dependentsMap.set(n.nodeId, []);
  }

  const roots: LearningPathNode[] = [];
  for (const n of sortedNodes) {
    if (n.parentId && idSet.has(n.parentId)) {
      childrenMap.get(n.parentId)!.push(n);
    } else {
      roots.push(n);
    }
    for (const reqId of n.prerequisiteIds) {
      if (idSet.has(reqId)) {
        dependentsMap.get(reqId)!.push(n.nodeId);
      }
    }
  }

  const completedVideos = layout.orderedPlayableNodes.filter(
    (n) => n.status === 'completed',
  ).length;
  const totalVideos = layout.orderedPlayableNodes.length;
  const overallRatio = totalVideos > 0 ? completedVideos / totalVideos : 0;

  const starNodes: PathStarNode[] = [];
  const starLinks: PathStarLink[] = [];

  // 1. Central Course Hub ("core-hub")
  const coreNode: PathStarNode = {
    id: 'core-hub',
    label: detail.summary.title,
    kind: 'core',
    stageIndex: -1,
    stageTitle: detail.summary.title,
    orderIndex: null,
    status:
      overallRatio >= 1 && totalVideos > 0
        ? 'completed'
        : overallRatio > 0
          ? 'in_progress'
          : 'ready',
    progressRatio: overallRatio,
    isNextUp: false,
    optional: false,
    note: detail.summary.description,
    video: null,
    positionedNode: null,
    parentId: null,
    prerequisiteIds: [],
    dependentIds: roots.map((r) => r.nodeId),
    degree: roots.length,
    x: 0,
    y: 0,
    radius: 34,
    orbitRadius: 0,
    orbitAngle: 0,
    color: '#e05638',
  };
  starNodes.push(coreNode);

  const stageCount = Math.max(1, roots.length);
  const getStageOrbit = (idx: number) => {
    if (stageCount <= 6) return 290;
    return idx % 2 === 0 ? 270 : 410;
  };

  roots.forEach((root, stageIdx) => {
    const stageColor = STAGE_STAR_PALETTE[stageIdx % STAGE_STAR_PALETTE.length];
    const stageAngle = (2 * Math.PI * stageIdx) / stageCount - Math.PI / 2;
    const stageOrbit = getStageOrbit(stageIdx);
    const sx = Math.round(stageOrbit * Math.cos(stageAngle));
    const sy = Math.round(stageOrbit * Math.sin(stageAngle));
    const rootPos = posById.get(root.nodeId) ?? null;

    starNodes.push({
      id: root.nodeId,
      label: root.title,
      kind:
        root.kind === 'checkpoint'
          ? 'checkpoint'
          : root.videoId
            ? 'video'
            : 'stage',
      stageIndex: stageIdx,
      stageTitle: root.title,
      orderIndex: rootPos?.orderIndex ?? null,
      status: rootPos?.status ?? 'ready',
      progressRatio: rootPos?.progressRatio ?? 0,
      isNextUp: rootPos?.isNextUp ?? false,
      optional: root.optional,
      note: root.note,
      video: rootPos?.video ?? null,
      positionedNode: rootPos,
      parentId: 'core-hub',
      prerequisiteIds: root.prerequisiteIds,
      dependentIds: dependentsMap.get(root.nodeId) ?? [],
      degree: 1,
      x: sx,
      y: sy,
      radius: 17,
      orbitRadius: stageOrbit,
      orbitAngle: stageAngle,
      color: stageColor,
    });

    starLinks.push({
      id: `core->${root.nodeId}`,
      source: 'core-hub',
      target: root.nodeId,
      kind: 'core_spoke',
      active: (rootPos?.status ?? 'ready') === 'completed',
      optional: false,
      color: stageColor,
    });

    if (stageIdx > 0) {
      starLinks.push({
        id: `spine:${roots[stageIdx - 1].nodeId}->${root.nodeId}`,
        source: roots[stageIdx - 1].nodeId,
        target: root.nodeId,
        kind: 'spine',
        active:
          (posById.get(roots[stageIdx - 1].nodeId)?.status ?? 'ready') ===
          'completed',
        optional: false,
        color: stageColor,
      });
    }

    // Subtree lessons under this stage
    const seen = new Set<string>([root.nodeId]);
    const placeChildren = (
      parent: LearningPathNode,
      parentX: number,
      parentY: number,
      parentAngle: number,
      depth: number,
    ) => {
      const kids = (childrenMap.get(parent.nodeId) ?? []).filter(
        (c) => !seen.has(c.nodeId),
      );
      if (kids.length === 0) return;
      kids.forEach((c) => seen.add(c.nodeId));

      const itemsPerTier = depth === 1 ? (kids.length <= 4 ? 2 : 3) : 2;
      kids.forEach((child, idx) => {
        const tier = Math.floor(idx / itemsPerTier);
        const idxInTier = idx % itemsPerTier;
        const countInTier = Math.min(
          itemsPerTier,
          kids.length - tier * itemsPerTier,
        );
        const dist = (depth === 1 ? 105 : 68) + tier * 72;
        const arcSpan =
          countInTier === 1
            ? 0
            : Math.min(1.18, (depth === 1 ? 0.5 : 0.42) * (countInTier - 1));
        const angle =
          countInTier === 1
            ? parentAngle
            : parentAngle -
              arcSpan / 2 +
              (idxInTier / (countInTier - 1)) * arcSpan;

        const cx = Math.round(parentX + dist * Math.cos(angle));
        const cy = Math.round(parentY + dist * Math.sin(angle));
        const childPos = posById.get(child.nodeId) ?? null;

        starNodes.push({
          id: child.nodeId,
          label: child.title,
          kind:
            child.kind === 'checkpoint'
              ? 'checkpoint'
              : child.videoId
                ? 'video'
                : 'stage',
          stageIndex: stageIdx,
          stageTitle: root.title,
          orderIndex: childPos?.orderIndex ?? null,
          status: childPos?.status ?? 'ready',
          progressRatio: childPos?.progressRatio ?? 0,
          isNextUp: childPos?.isNextUp ?? false,
          optional: child.optional,
          note: child.note,
          video: childPos?.video ?? null,
          positionedNode: childPos,
          parentId: parent.nodeId,
          prerequisiteIds: child.prerequisiteIds,
          dependentIds: dependentsMap.get(child.nodeId) ?? [],
          degree: 1,
          x: cx,
          y: cy,
          radius:
            child.kind === 'checkpoint' ? 12.5 : child.optional ? 8.5 : 10.5,
          orbitRadius: dist,
          orbitAngle: angle,
          color: stageColor,
        });

        starLinks.push({
          id: `${parent.nodeId}->${child.nodeId}`,
          source: parent.nodeId,
          target: child.nodeId,
          kind: child.optional ? 'siding' : 'hierarchy',
          active:
            (posById.get(parent.nodeId)?.status ?? 'ready') === 'completed',
          optional: child.optional,
          color: stageColor,
        });

        placeChildren(child, cx, cy, angle, depth + 1);
      });
    };

    placeChildren(root, sx, sy, stageAngle, 1);
  });

  // 2. Add explicit cross-node prerequisite links
  const existingLinkKeys = new Set(
    starLinks.map((l) => `${l.source}->${l.target}`),
  );
  let prerequisiteLinksCount = 0;

  for (const node of sortedNodes) {
    for (const reqId of node.prerequisiteIds) {
      if (!idSet.has(reqId) || reqId === node.parentId) continue;
      const key = `${reqId}->${node.nodeId}`;
      if (existingLinkKeys.has(key)) continue;
      existingLinkKeys.add(key);
      prerequisiteLinksCount += 1;
      const targetStageIdx = posById.get(node.nodeId)?.stageIndex ?? 0;
      starLinks.push({
        id: `prereq:${key}`,
        source: reqId,
        target: node.nodeId,
        kind: 'prerequisite',
        active: (posById.get(reqId)?.status ?? 'ready') === 'completed',
        optional: node.optional,
        color: STAGE_STAR_PALETTE[targetStageIdx % STAGE_STAR_PALETTE.length],
      });
    }
  }

  // Compute node degrees
  const degreeMap = new Map<string, number>();
  for (const l of starLinks) {
    if (l.kind === 'spine') continue;
    degreeMap.set(l.source, (degreeMap.get(l.source) ?? 0) + 1);
    degreeMap.set(l.target, (degreeMap.get(l.target) ?? 0) + 1);
  }
  for (const n of starNodes) {
    n.degree = degreeMap.get(n.id) ?? 1;
  }

  let minX = -200;
  let maxX = 200;
  let minY = -200;
  let maxY = 200;
  for (const n of starNodes) {
    if (n.x - n.radius < minX) minX = n.x - n.radius;
    if (n.x + n.radius > maxX) maxX = n.x + n.radius;
    if (n.y - n.radius < minY) minY = n.y - n.radius;
    if (n.y + n.radius > maxY) maxY = n.y + n.radius;
  }

  return {
    pathId: detail.summary.pathId,
    title: detail.summary.title,
    description: detail.summary.description,
    nodes: starNodes,
    links: starLinks,
    bounds: {
      minX: Math.floor(minX - 90),
      maxX: Math.ceil(maxX + 90),
      minY: Math.floor(minY - 90),
      maxY: Math.ceil(maxY + 90),
    },
    stats: {
      totalStages: roots.length,
      totalVideos,
      completedVideos,
      prerequisiteLinksCount,
      optionalCount: sortedNodes.filter((n) => n.optional).length,
    },
  };
}

export function buildPathStarAdjacencyMap(
  graph: LearningPathStarGraph,
  options?: { includeSpine?: boolean; includePrerequisites?: boolean },
): Map<string, Set<string>> {
  const includeSpine = options?.includeSpine ?? false;
  const includePrereqs = options?.includePrerequisites ?? true;
  const map = new Map<string, Set<string>>();

  for (const n of graph.nodes) {
    map.set(n.id, new Set([n.id]));
  }

  for (const link of graph.links) {
    if (link.kind === 'spine' && !includeSpine) continue;
    if (link.kind === 'prerequisite' && !includePrereqs) continue;
    map.get(link.source)?.add(link.target);
    map.get(link.target)?.add(link.source);
  }

  // When hovering a stage cluster, also highlight all lessons belonging to that stage
  for (const n of graph.nodes) {
    if (n.kind === 'stage') {
      for (const member of graph.nodes) {
        if (member.stageIndex === n.stageIndex && member.kind !== 'core') {
          map.get(n.id)?.add(member.id);
        }
      }
    }
  }

  return map;
}

export interface PathStarPhysicsConfig {
  repelStrength: number;
  linkDistanceScale: number;
  linkTension: number;
  centerGravity: number;
}

export const DEFAULT_PATH_STAR_PHYSICS_CONFIG: PathStarPhysicsConfig = {
  repelStrength: 1.0,
  linkDistanceScale: 1.0,
  linkTension: 1.0,
  centerGravity: 1.0,
};

export interface PathStarSimBody {
  id: string;
  kind: PathStarNodeKind;
  parentId: string | null;
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

export interface PathStarPhysicsState {
  bodies: Map<string, PathStarSimBody>;
  bodyList: PathStarSimBody[];
  links: PathStarLink[];
  alpha: number;
}

export function createPathStarPhysicsState(
  graph: LearningPathStarGraph,
): PathStarPhysicsState {
  const bodies = new Map<string, PathStarSimBody>();
  const bodyList: PathStarSimBody[] = [];

  for (const n of graph.nodes) {
    const body: PathStarSimBody = {
      id: n.id,
      kind: n.kind,
      parentId: n.parentId,
      x: n.x,
      y: n.y,
      vx: 0,
      vy: 0,
      anchorX: n.x,
      anchorY: n.y,
      fx: null,
      fy: null,
      radius: n.radius,
      orbitRadius: n.orbitRadius,
      orbitAngle: n.orbitAngle,
    };
    bodies.set(n.id, body);
    bodyList.push(body);
  }

  return {
    bodies,
    bodyList,
    links: graph.links,
    alpha: 0.45,
  };
}

export function stepPathStarPhysics(
  state: PathStarPhysicsState,
  config: PathStarPhysicsConfig = DEFAULT_PATH_STAR_PHYSICS_CONFIG,
  visibleIds?: Set<string>,
): boolean {
  const { bodies, bodyList, links } = state;
  const hasPinned = bodyList.some((b) => b.fx !== null || b.fy !== null);
  if (state.alpha < 0.002 && !hasPinned) {
    return false;
  }

  const activeAlpha = hasPinned ? Math.max(state.alpha, 0.3) : state.alpha;
  const distScale = config.linkDistanceScale;
  const tension = config.linkTension;
  const repel = config.repelStrength;
  const gravity = config.centerGravity;

  const activeBodies = visibleIds
    ? bodyList.filter((b) => visibleIds.has(b.id))
    : bodyList;
  const n = activeBodies.length;

  // 1. Many-Body Charge Repulsion
  const maxRepelDist = 220;
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
      const minGap = (a.radius + b.radius + 24) * Math.sqrt(repel);
      const charge =
        a.kind === 'core' || b.kind === 'core'
          ? 2600 * repel
          : a.kind === 'stage' && b.kind === 'stage'
            ? 1600 * repel
            : 520 * repel;

      let force = (charge / (dSq + 110)) * activeAlpha;
      if (dist < minGap) {
        force += (minGap - dist) * 0.24 * activeAlpha;
      }

      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (a.fx === null && a.kind !== 'core') {
        a.vx -= fx;
        a.vy -= fy;
      }
      if (b.fx === null && b.kind !== 'core') {
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  // 2. Hookean Spring Forces along Links
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

    if (
      link.kind === 'core_spoke' ||
      link.kind === 'hierarchy' ||
      link.kind === 'siding'
    ) {
      const restLength = (tgt.orbitRadius || 105) * distScale;
      const k =
        (link.kind === 'core_spoke' ? 0.065 : 0.14) * tension * activeAlpha;
      const delta = (dist - restLength) * k;
      const fx = (dx / dist) * delta;
      const fy = (dy / dist) * delta;

      if (src.fx === null && src.kind !== 'core') {
        const parentWeight = tgt.fx !== null ? 0.55 : 0.22;
        src.vx += fx * parentWeight;
        src.vy += fy * parentWeight;
      }
      if (tgt.fx === null) {
        const childWeight = src.fx !== null ? 0.92 : 0.78;
        tgt.vx -= fx * childWeight;
        tgt.vy -= fy * childWeight;
      }
    } else if (link.kind === 'prerequisite') {
      const restLength = 210 * distScale;
      const k = 0.02 * tension * activeAlpha;
      const delta = (dist - restLength) * k;
      const fx = (dx / dist) * delta;
      const fy = (dy / dist) * delta;
      if (src.fx === null && src.kind !== 'core') {
        src.vx += fx;
        src.vy += fy;
      }
      if (tgt.fx === null && tgt.kind !== 'core') {
        tgt.vx -= fx;
        tgt.vy -= fy;
      }
    }
  }

  // 3. Soft Anchor & Radial Restoring Gravity
  const core = bodies.get('core-hub');
  if (core && core.fx === null) {
    core.vx += (0 - core.x) * 0.2 * gravity;
    core.vy += (0 - core.y) * 0.2 * gravity;
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

    if (body.kind === 'stage' && core) {
      const targetX = core.x + body.anchorX * distScale;
      const targetY = core.y + body.anchorY * distScale;
      body.vx += (targetX - body.x) * 0.045 * gravity * activeAlpha;
      body.vy += (targetY - body.y) * 0.045 * gravity * activeAlpha;
    } else if (body.parentId && body.parentId !== 'core-hub') {
      const parent = bodies.get(body.parentId);
      if (parent) {
        const relX = Math.cos(body.orbitAngle) * body.orbitRadius * distScale;
        const relY = Math.sin(body.orbitAngle) * body.orbitRadius * distScale;
        const targetX = parent.x + relX;
        const targetY = parent.y + relY;
        const pull = parent.fx !== null ? 0.18 : 0.06 * gravity * activeAlpha;
        body.vx += (targetX - body.x) * pull;
        body.vy += (targetY - body.y) * pull;
      }
    }

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
