import type {
  DataDbCustomType,
  DataDbIndexInfo,
  DataDbTableSchema,
} from './terminal-api';
import type { DataLabDbConnection } from './terminal-codelab-model';

/* ==========================================================================
   Seamind Database ER Studio — Clean-Room Data Model & Overlay Persistence
   ========================================================================== */

export type ErCardinality = '1:1' | '1:N' | 'N:1' | 'N:M' | '0:1' | '0:N';

export type ErActionRule =
  'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';

export type ErEdgeRouting = 'orthogonal' | 'bezier';

export type ErSourceKind = 'live' | 'local-file' | 'offline';

export interface ErColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isUnique?: boolean;
  defaultValue?: string | null;
  comment?: string | null;
  /** Local research note/Chinese alias (never mutates read-only DB) */
  note?: string;
  nullFraction?: number | null;
  nDistinct?: number | null;
}

export interface ErTable {
  id: string;
  schema: string;
  name: string;
  tableType: string;
  sourceKind: ErSourceKind;
  estimatedRows?: number | null;
  totalBytes?: number | null;
  comment?: string | null;
  /** Local Chinese business alias / title overlay */
  alias?: string;
  /** Local research annotation */
  note?: string;
  color: string;
  collapsed?: boolean;
  columns: ErColumn[];
  primaryKeys: string[];
  indexes: DataDbIndexInfo[];
  x: number;
  y: number;
  width: number;
  /** True when a previously annotated table disappeared after refreshing live schema */
  missingInLive?: boolean;
  /** Populated when sourceKind === 'local-file' */
  mountedFileAlias?: string;
  mountedFilePath?: string;
  mountedFileFormat?: string;
}

export interface ErRelation {
  id: string;
  sourceTableId: string;
  sourceColumn: string;
  targetTableId: string;
  targetColumn: string;
  cardinality: ErCardinality;
  /** physical = DB FK constraint; logical = user/Agent confirmed; inferred = heuristic suggestion */
  kind: 'physical' | 'logical' | 'inferred';
  constraintName?: string | null;
  onUpdate?: string | null;
  onDelete?: string | null;
  note?: string;
  confidence?: 'high' | 'medium';
  reason?: string;
}

export interface ErSubjectArea {
  id: string;
  name: string;
  schema?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  note?: string;
}

export interface ErCanvasNote {
  id: string;
  title: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface ErCustomType {
  id: string;
  schema: string;
  name: string;
  kind: 'enum' | 'composite' | 'domain';
  values: string[];
  fields: Array<{ name: string; dataType: string }>;
  comment?: string | null;
}

export interface ErIssue {
  id: string;
  category: 'modeling' | 'data-quality';
  severity: 'error' | 'warning' | 'info';
  code: string;
  title: string;
  detail: string;
  tableId?: string;
  columnName?: string;
  relationId?: string;
}

export interface ErViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ErTableLayoutEntry {
  x: number;
  y: number;
  width?: number;
  color?: string;
  collapsed?: boolean;
  alias?: string;
  note?: string;
}

export interface DbErOverlay {
  connectionId: string;
  version: 1;
  updatedAt: number;
  viewport: ErViewport;
  routing: ErEdgeRouting;
  showGrid: boolean;
  snapToGrid: boolean;
  showInferred: boolean;
  tableLayouts: Record<string, ErTableLayoutEntry>;
  /** Keyed by `${tableId}.${columnName}` */
  columnNotes: Record<string, string>;
  logicalRelations: ErRelation[];
  dismissedInferredIds: string[];
  subjectAreas: ErSubjectArea[];
  notes: ErCanvasNote[];
  /** Mounted local file aliases pinned onto this ER canvas for cross-source DuckDB federation */
  pinnedLocalFiles: string[];
  /** Used when modeling offline from pasted SQL DDL / DBML */
  offlineTitle?: string;
  offlineDialect?: DataLabDbConnection['dbType'];
  offlineTables?: DataDbTableSchema[];
  offlineTypes?: DataDbCustomType[];
}

export interface ErDiagramState {
  connectionId: string;
  title: string;
  dbType: DataLabDbConnection['dbType'];
  isOffline: boolean;
  tables: ErTable[];
  relations: ErRelation[];
  subjectAreas: ErSubjectArea[];
  notes: ErCanvasNote[];
  customTypes: ErCustomType[];
  issues: ErIssue[];
  viewport: ErViewport;
  routing: ErEdgeRouting;
  showGrid: boolean;
  snapToGrid: boolean;
  showInferred: boolean;
}

/* ==========================================================================
   Deterministic Geometry Constants (matched 1:1 with db-er-studio.css)
   ========================================================================== */

export const ER_CARD_WIDTH = 264;
export const ER_HEADER_H = 38;
export const ER_SUBMETA_H = 22;
export const ER_ROW_H = 26;
export const ER_FOOTER_H = 8;
export const ER_GRID_SIZE = 20;
export const ER_LOD_TABLE_THRESHOLD = 60;
export const ER_LOD_ZOOM_THRESHOLD = 0.45;
export const OFFLINE_ER_CONNECTION_ID = '__offline__';

export const DATALAB_ER_OVERLAY_PREFIX = 'seamind:datalab-er-overlay:v1:';
export const DATALAB_ER_OVERLAY_EVENT = 'seamind:datalab-er-overlay-changed';

export const ER_SCHEMA_PALETTE: readonly string[] = [
  '#467b5e', // Seamind sage green
  '#3b6e8c', // Deep slate blue
  '#b37d39', // Warm ochre amber
  '#8c5a7a', // Muted plum
  '#4a7c7d', // Calm teal
  '#9c5a44', // Terracotta
  '#5d6b9c', // Editorial indigo
  '#6d7b4f', // Olive moss
];

export const ER_NOTE_COLORS: readonly string[] = [
  '#f6eed2',
  '#e4f0e8',
  '#e3edf5',
  '#f5e4e2',
  '#ede7f4',
];

export function pickSchemaColor(schemaName: string, indexHint = 0): string {
  const s = (schemaName || 'default').trim().toLowerCase();
  if (!s) return ER_SCHEMA_PALETTE[indexHint % ER_SCHEMA_PALETTE.length];
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return ER_SCHEMA_PALETTE[Math.abs(hash) % ER_SCHEMA_PALETTE.length];
}

export function makeErTableId(
  schema: string | null | undefined,
  name: string,
): string {
  const cleanSchema = (schema || '').trim();
  const cleanName = name.trim();
  if (cleanSchema && cleanSchema !== 'main' && cleanSchema !== 'default') {
    return `${cleanSchema}.${cleanName}`;
  }
  return cleanName;
}

export function makeLocalFileTableId(alias: string): string {
  return `local:${alias.trim()}`;
}

export function makeRelationKey(
  sourceTableId: string,
  sourceColumn: string,
  targetTableId: string,
  targetColumn: string,
): string {
  return `${sourceTableId.toLowerCase()}.${sourceColumn.toLowerCase()}->${targetTableId.toLowerCase()}.${targetColumn.toLowerCase()}`;
}

export function hasTableSubmeta(table: ErTable): boolean {
  return Boolean(
    table.estimatedRows != null ||
    table.totalBytes != null ||
    table.sourceKind === 'local-file' ||
    table.missingInLive,
  );
}

export function getVisibleErColumns(
  table: ErTable,
  lodCompact = false,
): ErColumn[] {
  if (table.collapsed) return [];
  if (!lodCompact) return table.columns;
  const keyCols = table.columns.filter((c) => c.isPrimaryKey || c.isUnique);
  return keyCols.length > 0 ? keyCols : table.columns.slice(0, 4);
}

export function estimateTableCardHeight(
  table: ErTable,
  lodCompact = false,
): number {
  const subH = hasTableSubmeta(table) ? ER_SUBMETA_H : 0;
  if (table.collapsed) {
    return ER_HEADER_H + subH + ER_FOOTER_H;
  }
  const cols = getVisibleErColumns(table, lodCompact);
  const hiddenCount = table.columns.length - cols.length;
  const moreRowH = hiddenCount > 0 ? 22 : 0;
  return (
    ER_HEADER_H +
    subH +
    Math.max(1, cols.length) * ER_ROW_H +
    moreRowH +
    ER_FOOTER_H
  );
}

export function getColumnAnchorY(
  table: ErTable,
  columnName: string,
  lodCompact = false,
): number {
  const subH = hasTableSubmeta(table) ? ER_SUBMETA_H : 0;
  if (table.collapsed) {
    return table.y + ER_HEADER_H / 2;
  }
  const cols = getVisibleErColumns(table, lodCompact);
  const idx = cols.findIndex(
    (c) => c.name.toLowerCase() === columnName.toLowerCase(),
  );
  if (idx < 0) {
    return table.y + ER_HEADER_H / 2;
  }
  return table.y + ER_HEADER_H + subH + idx * ER_ROW_H + ER_ROW_H / 2;
}

export type ErTypeFamily =
  | 'int'
  | 'float'
  | 'text'
  | 'bool'
  | 'date'
  | 'uuid'
  | 'json'
  | 'binary'
  | 'other';

export function normalizeErTypeFamily(rawType: string): ErTypeFamily {
  const t = (rawType || '').trim().toLowerCase();
  if (!t) return 'other';
  if (/\buuid\b/.test(t)) return 'uuid';
  if (/\b(?:bool|boolean)\b/.test(t)) return 'bool';
  if (/\b(?:json|jsonb)\b/.test(t)) return 'json';
  if (/\b(?:bytea|blob|binary|varbinary)\b/.test(t)) return 'binary';
  if (/\b(?:date|time|timestamp|timestamptz|datetime|interval)\b/.test(t)) {
    return 'date';
  }
  if (
    /\b(?:smallint|integer|int|int2|int4|int8|bigint|tinyint|mediumint|serial|bigserial|smallserial)\b/.test(
      t,
    )
  ) {
    return 'int';
  }
  if (/\b(?:numeric|decimal|real|float|float4|float8|double|money)\b/.test(t)) {
    return 'float';
  }
  if (
    /\b(?:text|varchar|char|character|citext|nvarchar|clob|string|enum)\b/.test(
      t,
    )
  ) {
    return 'text';
  }
  return 'other';
}

export function areTypeFamiliesCompatible(a: string, b: string): boolean {
  const fa = normalizeErTypeFamily(a);
  const fb = normalizeErTypeFamily(b);
  if (fa === 'other' || fb === 'other') return true;
  if (fa === fb) return true;
  return false;
}

export function createEmptyErOverlay(connectionId: string): DbErOverlay {
  return {
    connectionId,
    version: 1,
    updatedAt: Date.now(),
    viewport: { x: 48, y: 48, zoom: 0.95 },
    routing: 'orthogonal',
    showGrid: true,
    snapToGrid: true,
    showInferred: true,
    tableLayouts: {},
    columnNotes: {},
    logicalRelations: [],
    dismissedInferredIds: [],
    subjectAreas: [],
    notes: [],
    pinnedLocalFiles: [],
  };
}

export function loadErOverlay(connectionId: string): DbErOverlay {
  const fallback = createEmptyErOverlay(connectionId);
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(
      `${DATALAB_ER_OVERLAY_PREFIX}${connectionId}`,
    );
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DbErOverlay>;
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      ...fallback,
      ...parsed,
      connectionId,
      version: 1,
      viewport: {
        x:
          typeof parsed.viewport?.x === 'number' &&
          Number.isFinite(parsed.viewport.x)
            ? parsed.viewport.x
            : fallback.viewport.x,
        y:
          typeof parsed.viewport?.y === 'number' &&
          Number.isFinite(parsed.viewport.y)
            ? parsed.viewport.y
            : fallback.viewport.y,
        zoom:
          typeof parsed.viewport?.zoom === 'number' &&
          Number.isFinite(parsed.viewport.zoom)
            ? Math.max(0.18, Math.min(2.5, parsed.viewport.zoom))
            : fallback.viewport.zoom,
      },
      routing:
        parsed.routing === 'bezier' || parsed.routing === 'orthogonal'
          ? parsed.routing
          : 'orthogonal',
      showGrid: parsed.showGrid ?? true,
      snapToGrid: parsed.snapToGrid ?? true,
      showInferred: parsed.showInferred ?? true,
      tableLayouts:
        parsed.tableLayouts && typeof parsed.tableLayouts === 'object'
          ? parsed.tableLayouts
          : {},
      columnNotes:
        parsed.columnNotes && typeof parsed.columnNotes === 'object'
          ? parsed.columnNotes
          : {},
      logicalRelations: Array.isArray(parsed.logicalRelations)
        ? parsed.logicalRelations
        : [],
      dismissedInferredIds: Array.isArray(parsed.dismissedInferredIds)
        ? parsed.dismissedInferredIds
        : [],
      subjectAreas: Array.isArray(parsed.subjectAreas)
        ? parsed.subjectAreas
        : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      pinnedLocalFiles: Array.isArray(parsed.pinnedLocalFiles)
        ? parsed.pinnedLocalFiles
        : [],
    };
  } catch {
    return fallback;
  }
}

export function saveErOverlay(overlay: DbErOverlay): void {
  if (typeof localStorage === 'undefined') return;
  const next: DbErOverlay = {
    ...overlay,
    version: 1,
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(
      `${DATALAB_ER_OVERLAY_PREFIX}${next.connectionId}`,
      JSON.stringify(next),
    );
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent<{ connectionId: string }>(DATALAB_ER_OVERLAY_EVENT, {
          detail: { connectionId: next.connectionId },
        }),
      );
    }
  } catch {
    // Ignore quota errors cleanly
  }
}

export function makeErEntityId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
