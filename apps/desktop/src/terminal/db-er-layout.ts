import {
  ER_CARD_WIDTH,
  ER_GRID_SIZE,
  estimateTableCardHeight,
  getColumnAnchorY,
  pickSchemaColor,
  type ErCanvasNote,
  type ErEdgeRouting,
  type ErRelation,
  type ErSubjectArea,
  type ErTable,
  type ErViewport,
} from './db-er-model';

/* ==========================================================================
   Seamind Database ER Studio — Auto-Layout, Field-Anchor Pathing & Snapping
   ========================================================================== */

export interface ErEdgePathResult {
  pathD: string;
  sourcePoint: { x: number; y: number };
  targetPoint: { x: number; y: number };
  /** +1 exits right, -1 exits left */
  sourceDir: 1 | -1;
  /** +1 enters from right side, -1 enters from left side */
  targetDir: 1 | -1;
  labelPoint: { x: number; y: number };
}

export interface ErAlignmentGuide {
  axis: 'x' | 'y';
  pos: number;
  from: number;
  to: number;
}

export interface PrecomputedSnapBox {
  id: string;
  x0: number;
  xm: number;
  x1: number;
  y0: number;
  ym: number;
  y1: number;
}

const SCHEMA_GAP_Y = 72;
const TABLE_GAP_X = 96;
const TABLE_GAP_Y = 46;
const AREA_PAD_X = 30;
const AREA_PAD_TOP = 46;
const AREA_PAD_BOTTOM = 28;
const EDGE_STUB = 28;
const EDGE_CORNER_R = 8;

function roundPathCoord(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Generates clean multi-schema partitioned layout:
 * - Groups tables by schema (non-public research schemas first, local DuckDB files last).
 * - Inside each schema, orders referenced parent/dimension tables before referencing fact tables.
 * - Returns updated table positions and bounding Subject Areas.
 */
export function autoLayoutErDiagram(
  tables: readonly ErTable[],
  relations: readonly ErRelation[],
): {
  positions: Record<string, { x: number; y: number }>;
  subjectAreas: ErSubjectArea[];
} {
  const positions: Record<string, { x: number; y: number }> = {};
  const subjectAreas: ErSubjectArea[] = [];
  if (tables.length === 0) return { positions, subjectAreas };

  // Compute in-degree (how many tables reference this table -> dimension tables come first)
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const rel of relations) {
    if (rel.sourceTableId === rel.targetTableId) continue;
    inDegree.set(rel.targetTableId, (inDegree.get(rel.targetTableId) ?? 0) + 1);
    outDegree.set(
      rel.sourceTableId,
      (outDegree.get(rel.sourceTableId) ?? 0) + 1,
    );
  }

  const bySchema = new Map<string, ErTable[]>();
  for (const t of tables) {
    const groupKey =
      t.sourceKind === 'local-file'
        ? '__local_files__'
        : (t.schema || 'default').trim() || 'default';
    const arr = bySchema.get(groupKey);
    if (arr) arr.push(t);
    else bySchema.set(groupKey, [t]);
  }

  const sortedSchemas = Array.from(bySchema.keys()).sort((a, b) => {
    if (a === '__local_files__') return 1;
    if (b === '__local_files__') return -1;
    if (a === 'public' && b !== 'public') return 1;
    if (b === 'public' && a !== 'public') return -1;
    return a.localeCompare(b);
  });

  let cursorY = 48;
  const startX = 48;

  sortedSchemas.forEach((schemaKey, schemaIdx) => {
    const group = bySchema.get(schemaKey) ?? [];
    if (group.length === 0) return;

    // Sort: dimension tables (high inDegree, lower outDegree) first, then larger row count, then alpha
    group.sort((a, b) => {
      const scoreA = (inDegree.get(a.id) ?? 0) * 3 - (outDegree.get(a.id) ?? 0);
      const scoreB = (inDegree.get(b.id) ?? 0) * 3 - (outDegree.get(b.id) ?? 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      const rowsA = a.estimatedRows ?? -1;
      const rowsB = b.estimatedRows ?? -1;
      if (rowsA !== rowsB) return rowsB - rowsA;
      return a.name.localeCompare(b.name);
    });

    const colsPerRow = Math.min(
      Math.max(2, Math.ceil(Math.sqrt(group.length * 1.35))),
      5,
    );

    const colBottoms = new Array<number>(colsPerRow).fill(
      cursorY + AREA_PAD_TOP,
    );
    let maxRight = startX + AREA_PAD_X;
    let maxBottom = cursorY + AREA_PAD_TOP;

    group.forEach((tbl, idx) => {
      const colIdx = idx % colsPerRow;
      const width = tbl.width || ER_CARD_WIDTH;
      const height = estimateTableCardHeight(tbl, false);
      const x = startX + AREA_PAD_X + colIdx * (ER_CARD_WIDTH + TABLE_GAP_X);
      const y = colBottoms[colIdx];

      positions[tbl.id] = { x, y };
      colBottoms[colIdx] = y + height + TABLE_GAP_Y;
      maxRight = Math.max(maxRight, x + width);
      maxBottom = Math.max(maxBottom, y + height);
    });

    const areaName =
      schemaKey === '__local_files__' ? '本地文件 (DuckDB 联邦)' : schemaKey;
    subjectAreas.push({
      id: `area-schema-${schemaKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      name: areaName,
      schema: schemaKey === '__local_files__' ? undefined : schemaKey,
      x: startX,
      y: cursorY,
      width: Math.max(340, maxRight - startX + AREA_PAD_X),
      height: Math.max(180, maxBottom - cursorY + AREA_PAD_BOTTOM),
      color: pickSchemaColor(areaName, schemaIdx),
    });

    cursorY = maxBottom + AREA_PAD_BOTTOM + SCHEMA_GAP_Y;
  });

  return { positions, subjectAreas };
}

/**
 * Finds a clean non-overlapping coordinate for a newly discovered table
 * when refreshing a live database that already has manual user layout.
 */
export function placeNewTableCoords(
  existingTables: readonly ErTable[],
  schema: string,
  indexOffset = 0,
): { x: number; y: number } {
  const sameSchema = existingTables.filter(
    (t) => (t.schema || 'default') === (schema || 'default'),
  );
  const pool = sameSchema.length > 0 ? sameSchema : existingTables;
  if (pool.length === 0) {
    return {
      x: 78 + (indexOffset % 3) * (ER_CARD_WIDTH + TABLE_GAP_X),
      y: 94 + Math.floor(indexOffset / 3) * 280,
    };
  }
  let maxX = 0;
  let minY = Infinity;
  for (const t of pool) {
    maxX = Math.max(maxX, t.x + (t.width || ER_CARD_WIDTH));
    minY = Math.min(minY, t.y);
  }
  const baseY = Number.isFinite(minY) ? minY : 94;
  return {
    x: Math.round((maxX + TABLE_GAP_X) / ER_GRID_SIZE) * ER_GRID_SIZE,
    y: Math.round((baseY + indexOffset * 260) / ER_GRID_SIZE) * ER_GRID_SIZE,
  };
}

/**
 * Builds a rounded SVG polyline path from an array of orthogonal points.
 */
function buildRoundedOrthoPath(
  points: ReadonlyArray<{ x: number; y: number }>,
  radius = EDGE_CORNER_R,
): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M ${roundPathCoord(points[0].x)} ${roundPathCoord(points[0].y)}`;
  }

  // Deduplicate consecutive coincident points
  const clean: Array<{ x: number; y: number }> = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = clean[clean.length - 1];
    if (
      Math.abs(points[i].x - prev.x) > 0.5 ||
      Math.abs(points[i].y - prev.y) > 0.5
    ) {
      clean.push(points[i]);
    }
  }
  if (clean.length === 2) {
    return `M ${roundPathCoord(clean[0].x)} ${roundPathCoord(clean[0].y)} L ${roundPathCoord(clean[1].x)} ${roundPathCoord(clean[1].y)}`;
  }

  let d = `M ${roundPathCoord(clean[0].x)} ${roundPathCoord(clean[0].y)}`;
  for (let i = 1; i < clean.length - 1; i += 1) {
    const p0 = clean[i - 1];
    const p1 = clean[i];
    const p2 = clean[i + 1];

    const v1x = p1.x - p0.x;
    const v1y = p1.y - p0.y;
    const len1 = Math.hypot(v1x, v1y);

    const v2x = p2.x - p1.x;
    const v2y = p2.y - p1.y;
    const len2 = Math.hypot(v2x, v2y);

    if (len1 < 0.5 || len2 < 0.5) {
      d += ` L ${roundPathCoord(p1.x)} ${roundPathCoord(p1.y)}`;
      continue;
    }

    const r = Math.min(radius, len1 / 2, len2 / 2);
    const startX = p1.x - (v1x / len1) * r;
    const startY = p1.y - (v1y / len1) * r;
    const endX = p1.x + (v2x / len2) * r;
    const endY = p1.y + (v2y / len2) * r;

    d += ` L ${roundPathCoord(startX)} ${roundPathCoord(startY)}`;
    d += ` Q ${roundPathCoord(p1.x)} ${roundPathCoord(p1.y)} ${roundPathCoord(endX)} ${roundPathCoord(endY)}`;
  }
  const last = clean[clean.length - 1];
  d += ` L ${roundPathCoord(last.x)} ${roundPathCoord(last.y)}`;
  return d;
}

/**
 * Field-level relationship edge router supporting:
 * - Left/right dynamic port attachment
 * - Self-referencing table loops
 * - Overlapping X C-channels
 * - Rounded orthogonal Manhattan routing & smooth cubic Bezier routing
 */
export function calcErEdgePath(
  sourceTable: ErTable,
  sourceColumn: string,
  targetTable: ErTable,
  targetColumn: string,
  routing: ErEdgeRouting = 'orthogonal',
  lodCompact = false,
  laneOffset = 0,
): ErEdgePathResult {
  const sw = sourceTable.width || ER_CARD_WIDTH;
  const tw = targetTable.width || ER_CARD_WIDTH;
  const sy = getColumnAnchorY(sourceTable, sourceColumn, lodCompact);
  const ty = getColumnAnchorY(targetTable, targetColumn, lodCompact);

  const sLeft = sourceTable.x;
  const sRight = sourceTable.x + sw;
  const tLeft = targetTable.x;
  const tRight = targetTable.x + tw;

  // Self-referencing relationship loop on the right side
  if (sourceTable.id === targetTable.id) {
    const loopX = sRight + EDGE_STUB + 18 + laneOffset * 14;
    const syAdj = sy;
    const tyAdj = Math.abs(ty - sy) < 6 ? sy + 20 : ty;
    const pts = [
      { x: sRight, y: syAdj },
      { x: loopX, y: syAdj },
      { x: loopX, y: tyAdj },
      { x: sRight, y: tyAdj },
    ];
    return {
      pathD: buildRoundedOrthoPath(pts),
      sourcePoint: { x: sRight, y: syAdj },
      targetPoint: { x: sRight, y: tyAdj },
      sourceDir: 1,
      targetDir: 1,
      labelPoint: { x: loopX, y: (syAdj + tyAdj) / 2 },
    };
  }

  let sx: number;
  let tx: number;
  let sourceDir: 1 | -1;
  let targetDir: 1 | -1;

  if (sRight + EDGE_STUB * 1.4 <= tLeft) {
    // Source strictly to the left of target
    sx = sRight;
    tx = tLeft;
    sourceDir = 1;
    targetDir = -1;
  } else if (tRight + EDGE_STUB * 1.4 <= sLeft) {
    // Target strictly to the left of source
    sx = sLeft;
    tx = tRight;
    sourceDir = -1;
    targetDir = 1;
  } else {
    // Horizontally overlapping or stacked: connect via same-side C-channel
    const sCenter = (sLeft + sRight) / 2;
    const tCenter = (tLeft + tRight) / 2;
    if (sCenter <= tCenter) {
      sx = sRight;
      tx = tRight;
      sourceDir = 1;
      targetDir = 1;
    } else {
      sx = sLeft;
      tx = tLeft;
      sourceDir = -1;
      targetDir = -1;
    }
  }

  if (routing === 'bezier') {
    const dist = Math.abs(tx - sx);
    const ctrlOffset =
      sourceDir === targetDir
        ? Math.max(64, Math.abs(ty - sy) * 0.25 + 48) + laneOffset * 14
        : Math.max(48, Math.min(180, dist * 0.45));
    const c1x = sx + sourceDir * ctrlOffset;
    const c2x = tx + targetDir * ctrlOffset;
    const pathD = `M ${roundPathCoord(sx)} ${roundPathCoord(sy)} C ${roundPathCoord(c1x)} ${roundPathCoord(sy)}, ${roundPathCoord(c2x)} ${roundPathCoord(ty)}, ${roundPathCoord(tx)} ${roundPathCoord(ty)}`;
    // Midpoint at t = 0.5 on cubic Bezier
    const midX = 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * tx;
    const midY = 0.5 * sy + 0.5 * ty;
    return {
      pathD,
      sourcePoint: { x: sx, y: sy },
      targetPoint: { x: tx, y: ty },
      sourceDir,
      targetDir,
      labelPoint: { x: midX, y: midY },
    };
  }

  // Orthogonal routing
  if (sourceDir !== targetDir) {
    const midX = (sx + tx) / 2 + laneOffset * 12;
    const pts = [
      { x: sx, y: sy },
      { x: midX, y: sy },
      { x: midX, y: ty },
      { x: tx, y: ty },
    ];
    return {
      pathD: buildRoundedOrthoPath(pts),
      sourcePoint: { x: sx, y: sy },
      targetPoint: { x: tx, y: ty },
      sourceDir,
      targetDir,
      labelPoint: { x: midX, y: (sy + ty) / 2 },
    };
  }

  // Same-side C-channel (stacked tables)
  const outerX =
    sourceDir === 1
      ? Math.max(sx, tx) + EDGE_STUB + 14 + laneOffset * 14
      : Math.min(sx, tx) - EDGE_STUB - 14 - laneOffset * 14;
  const pts = [
    { x: sx, y: sy },
    { x: outerX, y: sy },
    { x: outerX, y: ty },
    { x: tx, y: ty },
  ];
  return {
    pathD: buildRoundedOrthoPath(pts),
    sourcePoint: { x: sx, y: sy },
    targetPoint: { x: tx, y: ty },
    sourceDir,
    targetDir,
    labelPoint: { x: outerX, y: (sy + ty) / 2 },
  };
}

/**
 * Precomputes bounding snap coordinates for all non-dragged tables ONCE at pointerdown
 * so pointermove runs pure arithmetic with zero object allocations or height recomputations.
 */
export function precomputeSnapBoxes(
  tables: readonly ErTable[],
  excludeTableId: string,
  lodCompact = false,
): PrecomputedSnapBox[] {
  const boxes: PrecomputedSnapBox[] = [];
  for (let i = 0; i < tables.length; i += 1) {
    const t = tables[i];
    if (t.id === excludeTableId) continue;
    const tw = t.width || ER_CARD_WIDTH;
    const th = estimateTableCardHeight(t, lodCompact);
    boxes.push({
      id: t.id,
      x0: t.x,
      xm: t.x + tw * 0.5,
      x1: t.x + tw,
      y0: t.y,
      ym: t.y + th * 0.5,
      y1: t.y + th,
    });
  }
  return boxes;
}

/**
 * Zero-allocation fast drag snap against precomputed boxes (< 0.02ms for 200 tables).
 */
export function computeDragSnapFast(
  rawX: number,
  rawY: number,
  width: number,
  height: number,
  boxes: readonly PrecomputedSnapBox[],
  snapToGrid: boolean,
  gridSize = ER_GRID_SIZE,
): { x: number; y: number; guides: ErAlignmentGuide[] } {
  const SNAP_THRESHOLD = 7;
  let x = rawX;
  let y = rawY;
  const guides: ErAlignmentGuide[] = [];

  let bestDx = SNAP_THRESHOLD + 1;
  let bestGuideX: ErAlignmentGuide | null = null;
  let bestDy = SNAP_THRESHOLD + 1;
  let bestGuideY: ErAlignmentGuide | null = null;

  const halfW = width * 0.5;
  const halfH = height * 0.5;
  const dx0 = rawX;
  const dxm = rawX + halfW;
  const dx1 = rawX + width;
  const dy0 = rawY;
  const dym = rawY + halfH;
  const dy1 = rawY + height;

  for (let i = 0; i < boxes.length; i += 1) {
    const b = boxes[i];

    // X alignment checks (left, center, right)
    const tx0 = b.x0;
    const txm = b.xm;
    const tx1 = b.x1;

    let d = Math.abs(dx0 - tx0);
    if (d < bestDx) {
      bestDx = d;
      x = tx0;
      bestGuideX = {
        axis: 'x',
        pos: tx0,
        from: Math.min(dy0, b.y0) - 24,
        to: Math.max(dy1, b.y1) + 24,
      };
    }
    d = Math.abs(dx0 - tx1);
    if (d < bestDx) {
      bestDx = d;
      x = tx1;
      bestGuideX = {
        axis: 'x',
        pos: tx1,
        from: Math.min(dy0, b.y0) - 24,
        to: Math.max(dy1, b.y1) + 24,
      };
    }
    d = Math.abs(dxm - txm);
    if (d < bestDx) {
      bestDx = d;
      x = txm - halfW;
      bestGuideX = {
        axis: 'x',
        pos: txm,
        from: Math.min(dy0, b.y0) - 24,
        to: Math.max(dy1, b.y1) + 24,
      };
    }
    d = Math.abs(dx1 - tx0);
    if (d < bestDx) {
      bestDx = d;
      x = tx0 - width;
      bestGuideX = {
        axis: 'x',
        pos: tx0,
        from: Math.min(dy0, b.y0) - 24,
        to: Math.max(dy1, b.y1) + 24,
      };
    }
    d = Math.abs(dx1 - tx1);
    if (d < bestDx) {
      bestDx = d;
      x = tx1 - width;
      bestGuideX = {
        axis: 'x',
        pos: tx1,
        from: Math.min(dy0, b.y0) - 24,
        to: Math.max(dy1, b.y1) + 24,
      };
    }

    // Y alignment checks (top, middle, bottom)
    const ty0 = b.y0;
    const tym = b.ym;
    const ty1 = b.y1;

    d = Math.abs(dy0 - ty0);
    if (d < bestDy) {
      bestDy = d;
      y = ty0;
      bestGuideY = {
        axis: 'y',
        pos: ty0,
        from: Math.min(dx0, b.x0) - 24,
        to: Math.max(dx1, b.x1) + 24,
      };
    }
    d = Math.abs(dy0 - ty1);
    if (d < bestDy) {
      bestDy = d;
      y = ty1;
      bestGuideY = {
        axis: 'y',
        pos: ty1,
        from: Math.min(dx0, b.x0) - 24,
        to: Math.max(dx1, b.x1) + 24,
      };
    }
    d = Math.abs(dym - tym);
    if (d < bestDy) {
      bestDy = d;
      y = tym - halfH;
      bestGuideY = {
        axis: 'y',
        pos: tym,
        from: Math.min(dx0, b.x0) - 24,
        to: Math.max(dx1, b.x1) + 24,
      };
    }
    d = Math.abs(dy1 - ty0);
    if (d < bestDy) {
      bestDy = d;
      y = ty0 - height;
      bestGuideY = {
        axis: 'y',
        pos: ty0,
        from: Math.min(dx0, b.x0) - 24,
        to: Math.max(dx1, b.x1) + 24,
      };
    }
    d = Math.abs(dy1 - ty1);
    if (d < bestDy) {
      bestDy = d;
      y = ty1 - height;
      bestGuideY = {
        axis: 'y',
        pos: ty1,
        from: Math.min(dx0, b.x0) - 24,
        to: Math.max(dx1, b.x1) + 24,
      };
    }
  }

  if (bestGuideX) {
    guides.push(bestGuideX);
  } else if (snapToGrid && gridSize > 0) {
    x = Math.round(x / gridSize) * gridSize;
  }

  if (bestGuideY) {
    guides.push(bestGuideY);
  } else if (snapToGrid && gridSize > 0) {
    y = Math.round(y / gridSize) * gridSize;
  }

  return { x, y, guides };
}

/**
 * Computes drag snapping to nearby table edges/centers + optional grid snapping.
 */
export function computeDragSnap(
  draggingId: string,
  rawX: number,
  rawY: number,
  width: number,
  height: number,
  otherTables: readonly ErTable[],
  snapToGrid: boolean,
  gridSize = ER_GRID_SIZE,
): { x: number; y: number; guides: ErAlignmentGuide[] } {
  const boxes = precomputeSnapBoxes(otherTables, draggingId, false);
  return computeDragSnapFast(
    rawX,
    rawY,
    width,
    height,
    boxes,
    snapToGrid,
    gridSize,
  );
}

/**
 * Fits all visible tables, subject areas and notes cleanly into the given canvas pixel viewport.
 */
export function computeFitViewport(
  tables: readonly ErTable[],
  areas: readonly ErSubjectArea[],
  notes: readonly ErCanvasNote[],
  viewportWidth: number,
  viewportHeight: number,
  padding = 56,
): ErViewport {
  if (
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    (tables.length === 0 && areas.length === 0 && notes.length === 0)
  ) {
    return { x: 48, y: 48, zoom: 0.95 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const t of tables) {
    const h = estimateTableCardHeight(t, false);
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + (t.width || ER_CARD_WIDTH));
    maxY = Math.max(maxY, t.y + h);
  }
  for (const a of areas) {
    minX = Math.min(minX, a.x);
    minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, a.x + a.width);
    maxY = Math.max(maxY, a.y + a.height);
  }
  for (const n of notes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }

  const contentW = Math.max(120, maxX - minX);
  const contentH = Math.max(120, maxY - minY);
  const availW = Math.max(160, viewportWidth - padding * 2);
  const availH = Math.max(160, viewportHeight - padding * 2);
  const zoom = Math.max(
    0.22,
    Math.min(1.15, Math.min(availW / contentW, availH / contentH)),
  );

  const x = (viewportWidth - contentW * zoom) / 2 - minX * zoom;
  const y = (viewportHeight - contentH * zoom) / 2 - minY * zoom;

  return {
    x: Math.round(x),
    y: Math.round(y),
    zoom: Math.round(zoom * 1000) / 1000,
  };
}
