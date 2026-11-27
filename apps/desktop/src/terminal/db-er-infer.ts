import { quoteQualifiedTable } from './db-connection-utils';
import { autoLayoutErDiagram, placeNewTableCoords } from './db-er-layout';
import {
  areTypeFamiliesCompatible,
  ER_CARD_WIDTH,
  makeErTableId,
  makeLocalFileTableId,
  makeRelationKey,
  pickSchemaColor,
  type DbErOverlay,
  type ErCardinality,
  type ErColumn,
  type ErCustomType,
  type ErDiagramState,
  type ErIssue,
  type ErRelation,
  type ErSubjectArea,
  type ErTable,
} from './db-er-model';
import type {
  DataDbCustomType,
  DataDbTableProfile,
  DataDbTableSchema,
} from './terminal-api';
import {
  sanitizeDataAlias,
  type DataLabDbConnection,
  type DataLabMountedFile,
} from './terminal-codelab-model';

/* ==========================================================================
   Seamind Database ER Studio — Schema Merge, Logical FK Inference,
   Dual-Dimension Issues Linter & JOIN / Federated Code Generators
   ========================================================================== */

const GENERIC_NON_DOMAIN_COLS = new Set([
  'id',
  'name',
  'title',
  'value',
  'raw_value',
  'status',
  'type',
  'kind',
  'created_at',
  'updated_at',
  'loaded_at',
  'deleted_at',
  'notes',
  'description',
  'comment',
  'units',
  'frequency',
  'source',
  'flag',
  'count',
  'total',
]);

const CROSS_SOURCE_JOIN_KEYS = new Set([
  'series_id',
  'symbol',
  'ticker',
  'code',
  'ts_code',
  'sec_id',
  'instrument_id',
  'contract',
  'date',
  'trade_date',
  'observation_date',
  'datetime',
  'timestamp',
]);

function singularizeToken(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s.endsWith('ies') && s.length > 4) return `${s.slice(0, -3)}y`;
  if (/(?:sses|shes|ches|xes|zes|uses)$/.test(s) && s.length > 4) {
    return s.slice(0, -2);
  }
  if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) {
    return s.slice(0, -1);
  }
  return s;
}

function isColumnUnique(table: ErTable, colName: string): boolean {
  const low = colName.toLowerCase();
  if (
    table.primaryKeys.length === 1 &&
    table.primaryKeys[0].toLowerCase() === low
  ) {
    return true;
  }
  const col = table.columns.find((c) => c.name.toLowerCase() === low);
  if (col?.isUnique) return true;
  return table.indexes.some(
    (ix) =>
      ix.unique &&
      ix.columns.length === 1 &&
      ix.columns[0].toLowerCase() === low,
  );
}

function inferCardinality(
  sourceTable: ErTable,
  sourceColumn: string,
  targetTable: ErTable,
  targetColumn: string,
): ErCardinality {
  const srcUnique = isColumnUnique(sourceTable, sourceColumn);
  const tgtUnique = isColumnUnique(targetTable, targetColumn);
  const srcCol = sourceTable.columns.find(
    (c) => c.name.toLowerCase() === sourceColumn.toLowerCase(),
  );
  if (srcUnique && tgtUnique) return srcCol?.nullable ? '0:1' : '1:1';
  if (!srcUnique && tgtUnique) return srcCol?.nullable ? '0:N' : 'N:1';
  if (srcUnique && !tgtUnique) return '1:N';
  return 'N:M';
}

/**
 * Deterministic logical foreign-key inference for analytical/research databases
 * (e.g. FRED macro warehouses, local Parquet files) that omit physical FK constraints.
 */
export function inferLogicalRelations(
  tables: readonly ErTable[],
  physicalRelations: readonly ErRelation[],
  logicalRelations: readonly ErRelation[],
  dismissedIds: readonly string[],
): ErRelation[] {
  const existingPairs = new Set<string>();
  const dismissedSet = new Set(dismissedIds);

  const registerPair = (
    aTbl: string,
    aCol: string,
    bTbl: string,
    bCol: string,
  ) => {
    existingPairs.add(makeRelationKey(aTbl, aCol, bTbl, bCol));
    existingPairs.add(makeRelationKey(bTbl, bCol, aTbl, aCol));
  };

  for (const r of physicalRelations) {
    registerPair(
      r.sourceTableId,
      r.sourceColumn,
      r.targetTableId,
      r.targetColumn,
    );
  }
  for (const r of logicalRelations) {
    registerPair(
      r.sourceTableId,
      r.sourceColumn,
      r.targetTableId,
      r.targetColumn,
    );
  }

  const inferred: ErRelation[] = [];

  // Index tables by single-PK or leading named PK column
  const pkTargetsByColName = new Map<
    string,
    Array<{ table: ErTable; col: ErColumn; isSinglePk: boolean }>
  >();
  const tableBySingular = new Map<string, ErTable[]>();

  for (const tbl of tables) {
    if (tbl.sourceKind === 'local-file') continue;
    const sing = singularizeToken(tbl.name);
    const list = tableBySingular.get(sing);
    if (list) list.push(tbl);
    else tableBySingular.set(sing, [tbl]);

    if (tbl.primaryKeys.length === 1) {
      const pkName = tbl.primaryKeys[0];
      const pkCol = tbl.columns.find(
        (c) => c.name.toLowerCase() === pkName.toLowerCase(),
      );
      if (pkCol) {
        const key = pkCol.name.toLowerCase();
        const arr = pkTargetsByColName.get(key) ?? [];
        arr.push({ table: tbl, col: pkCol, isSinglePk: true });
        pkTargetsByColName.set(key, arr);
      }
    }
  }

  const tryPush = (candidate: Omit<ErRelation, 'id'>) => {
    const id = `inf:${makeRelationKey(
      candidate.sourceTableId,
      candidate.sourceColumn,
      candidate.targetTableId,
      candidate.targetColumn,
    )}`;
    if (dismissedSet.has(id)) return;
    if (
      existingPairs.has(
        makeRelationKey(
          candidate.sourceTableId,
          candidate.sourceColumn,
          candidate.targetTableId,
          candidate.targetColumn,
        ),
      )
    ) {
      return;
    }
    registerPair(
      candidate.sourceTableId,
      candidate.sourceColumn,
      candidate.targetTableId,
      candidate.targetColumn,
    );
    inferred.push({ id, ...candidate });
  };

  // Rule 1 & Rule 2: Live/offline tables referencing dimension PKs
  for (const src of tables) {
    if (src.sourceKind === 'local-file') continue;
    for (const col of src.columns) {
      const colLow = col.name.toLowerCase();

      // Rule 1: Exact non-generic column name match to a single-PK parent table (e.g. series_id -> fred.series.series_id)
      if (!GENERIC_NON_DOMAIN_COLS.has(colLow)) {
        const targets = pkTargetsByColName.get(colLow);
        if (targets && targets.length > 0) {
          // Prefer same-schema parent if multiple exist
          const sorted = [...targets].sort((a, b) => {
            const sameA = a.table.schema === src.schema ? 1 : 0;
            const sameB = b.table.schema === src.schema ? 1 : 0;
            return sameB - sameA;
          });
          const best = sorted.find(
            (t) =>
              t.table.id !== src.id &&
              areTypeFamiliesCompatible(col.dataType, t.col.dataType),
          );
          if (best) {
            tryPush({
              sourceTableId: src.id,
              sourceColumn: col.name,
              targetTableId: best.table.id,
              targetColumn: best.col.name,
              cardinality: inferCardinality(
                src,
                col.name,
                best.table,
                best.col.name,
              ),
              kind: 'inferred',
              confidence: 'high',
              reason: `主键同名匹配 (${col.name} → ${best.table.id}.${best.col.name})`,
            });
            continue;
          }
        }
      }

      // Rule 2: `<singular_table>_id` pointing to `<table>(id)` or `<table>(<singular>_id)`
      if (colLow.endsWith('_id') && colLow.length > 3) {
        const stem = singularizeToken(colLow.slice(0, -3));
        const matchedTables = tableBySingular.get(stem);
        if (matchedTables && matchedTables.length > 0) {
          const sorted = [...matchedTables].sort((a, b) => {
            const sameA = a.schema === src.schema ? 1 : 0;
            const sameB = b.schema === src.schema ? 1 : 0;
            return sameB - sameA;
          });
          for (const tgt of sorted) {
            if (tgt.id === src.id) continue;
            const tgtCol =
              tgt.columns.find((c) => c.name.toLowerCase() === 'id') ??
              tgt.columns.find((c) => c.name.toLowerCase() === colLow);
            if (
              tgtCol &&
              areTypeFamiliesCompatible(col.dataType, tgtCol.dataType)
            ) {
              tryPush({
                sourceTableId: src.id,
                sourceColumn: col.name,
                targetTableId: tgt.id,
                targetColumn: tgtCol.name,
                cardinality: inferCardinality(src, col.name, tgt, tgtCol.name),
                kind: 'inferred',
                confidence: 'high',
                reason: `命名规范推断 (${col.name} → ${tgt.id}.${tgtCol.name})`,
              });
              break;
            }
          }
        }
      }
    }
  }

  // Rule 3: Cross-source local Parquet/CSV file join hints against DB tables (O(1) hash lookup)
  const localTables = tables.filter((t) => t.sourceKind === 'local-file');
  if (localTables.length > 0) {
    const dbColIndex = new Map<
      string,
      Array<{ table: ErTable; col: ErColumn }>
    >();
    for (const dbt of tables) {
      if (dbt.sourceKind === 'local-file') continue;
      for (const c of dbt.columns) {
        const low = c.name.toLowerCase();
        if (!CROSS_SOURCE_JOIN_KEYS.has(low)) continue;
        const arr = dbColIndex.get(low);
        if (arr) arr.push({ table: dbt, col: c });
        else dbColIndex.set(low, [{ table: dbt, col: c }]);
      }
    }
    for (const lf of localTables) {
      for (const lcol of lf.columns) {
        const low = lcol.name.toLowerCase();
        const candidates = dbColIndex.get(low);
        if (!candidates) continue;
        const matched = candidates.find((cand) =>
          areTypeFamiliesCompatible(lcol.dataType, cand.col.dataType),
        );
        if (matched) {
          tryPush({
            sourceTableId: lf.id,
            sourceColumn: lcol.name,
            targetTableId: matched.table.id,
            targetColumn: matched.col.name,
            cardinality: 'N:M',
            kind: 'inferred',
            confidence: 'medium',
            reason: `跨源联邦关联键 (${lf.name}.${lcol.name} ↔ ${matched.table.id}.${matched.col.name})`,
          });
        }
      }
    }
  }

  return inferred;
}

/**
 * Dual-dimension Schema Issues Linter:
 * 1) Static modeling rules (aligned with drawDB)
 * 2) Live research data quality diagnostics (Seamind exclusive)
 */
export function analyzeErIssues(
  tables: readonly ErTable[],
  relations: readonly ErRelation[],
  profilesByTableId?: Record<string, DataDbTableProfile | undefined>,
): ErIssue[] {
  const issues: ErIssue[] = [];
  const tableMap = new Map(tables.map((t) => [t.id, t]));
  const connectedIds = new Set<string>();
  const inferredTableIds = new Set<string>();
  const activeRels: ErRelation[] = [];

  for (const r of relations) {
    if (r.kind === 'inferred') {
      inferredTableIds.add(r.sourceTableId);
      inferredTableIds.add(r.targetTableId);
    } else {
      activeRels.push(r);
      connectedIds.add(r.sourceTableId);
      connectedIds.add(r.targetTableId);
    }
  }

  for (const t of tables) {
    const isView = t.tableType.toLowerCase().includes('view');
    const isLocal = t.sourceKind === 'local-file';

    // Modeling: empty table definition
    if (t.columns.length === 0) {
      issues.push({
        id: `empty-${t.id}`,
        category: 'modeling',
        severity: 'warning',
        code: 'EMPTY_TABLE_DEF',
        title: `表 ${t.id} 未检测到字段`,
        detail: '请点击「同步实库结构」重新读取该表元数据，或检查只读权限。',
        tableId: t.id,
      });
    }

    // Modeling: missing primary key on base tables
    if (!isView && !isLocal && t.primaryKeys.length === 0 && !t.missingInLive) {
      issues.push({
        id: `nopk-${t.id}`,
        category: 'modeling',
        severity: 'warning',
        code: 'MISSING_PK',
        title: `表 ${t.id} 缺少主键约束`,
        detail:
          '未定义 PRIMARY KEY 可能导致重复行、关联基数不明或分页排序不稳定。',
        tableId: t.id,
      });
    }

    // Modeling: duplicate column names
    const seenCols = new Set<string>();
    for (const c of t.columns) {
      const low = c.name.toLowerCase();
      if (seenCols.has(low)) {
        issues.push({
          id: `dupcol-${t.id}-${low}`,
          category: 'modeling',
          severity: 'error',
          code: 'DUPLICATE_COLUMN',
          title: `表 ${t.id} 存在重复字段 ${c.name}`,
          detail: '同一张表中出现同名列会导致 SQL 查询歧义。',
          tableId: t.id,
          columnName: c.name,
        });
      }
      seenCols.add(low);
    }

    // Modeling: duplicate indexes covering identical column sequence
    const idxSigMap = new Map<string, string>();
    for (const ix of t.indexes) {
      if (ix.columns.length === 0) continue;
      const sig = ix.columns.map((c) => c.toLowerCase()).join(',');
      const prev = idxSigMap.get(sig);
      if (prev) {
        issues.push({
          id: `dupidx-${t.id}-${ix.name}`,
          category: 'modeling',
          severity: 'info',
          code: 'DUPLICATE_INDEX',
          title: `表 ${t.id} 存在重叠索引`,
          detail: `索引 ${ix.name} 与 ${prev} 覆盖完全相同的字段序列 (${ix.columns.join(', ')})。`,
          tableId: t.id,
        });
      } else {
        idxSigMap.set(sig, ix.name);
      }
    }

    // Modeling: isolated table (only if diagram has > 1 table)
    if (tables.length > 1 && !connectedIds.has(t.id)) {
      const hasInferred = inferredTableIds.has(t.id);
      issues.push({
        id: `iso-${t.id}`,
        category: 'modeling',
        severity: 'info',
        code: 'ISOLATED_TABLE',
        title: `孤立表 ${t.id}`,
        detail: hasInferred
          ? '该表无物理外键，但系统已推断出潜在逻辑关联（虚线），可在画布或关系栏一键采纳。'
          : '该表目前未与任何其他表建立物理或逻辑关联，可拖拽字段行手动连线。',
        tableId: t.id,
      });
    }

    // Data Quality: empty live table (0 rows)
    if (
      t.sourceKind === 'live' &&
      !isView &&
      t.estimatedRows !== null &&
      t.estimatedRows !== undefined &&
      t.estimatedRows === 0
    ) {
      issues.push({
        id: `zerorow-${t.id}`,
        category: 'data-quality',
        severity: 'info',
        code: 'ZERO_ROW_TABLE',
        title: `空数据表 ${t.id} (0 行)`,
        detail:
          '实库估算行数为 0（可能是尚未导入数据的空表，或尚未执行 ANALYZE）。',
        tableId: t.id,
      });
    }

    // Data Quality: large table (>= 100k rows) with no indexes at all
    if (
      t.sourceKind === 'live' &&
      !isView &&
      (t.estimatedRows ?? 0) >= 100_000 &&
      t.indexes.length === 0 &&
      t.primaryKeys.length === 0
    ) {
      issues.push({
        id: `big-noindex-${t.id}`,
        category: 'data-quality',
        severity: 'warning',
        code: 'LARGE_TABLE_NO_INDEX',
        title: `大表 ${t.id} 缺少索引`,
        detail: `估算约 ${Math.round(t.estimatedRows!).toLocaleString()} 行，但未发现主键或二级索引，过滤/JOIN 可能触发全表扫描。`,
        tableId: t.id,
      });
    }

    // Data Quality: bitemporal / vintage composite PK tip (e.g. FRED realtime_start / realtime_end)
    const pkLow = new Set(t.primaryKeys.map((p) => p.toLowerCase()));
    if (
      t.primaryKeys.length >= 3 &&
      (pkLow.has('realtime_start') || pkLow.has('realtime_end'))
    ) {
      issues.push({
        id: `vintage-${t.id}`,
        category: 'data-quality',
        severity: 'info',
        code: 'VINTAGE_COMPOSITE_PK',
        title: `双时态修订主键提示 · ${t.id}`,
        detail: `复合主键 (${t.primaryKeys.join(', ')}) 包含发布修订区间字段，做常规宏观汇总时建议过滤最新口径（如 realtime_end = '9999-12-31'）防止重复计数。`,
        tableId: t.id,
      });
    }

    // Data Quality: high null fraction from cached pg_stats profile
    const prof = profilesByTableId?.[t.id];
    if (prof?.ok) {
      for (const col of prof.columns) {
        if (col.nullFraction != null && col.nullFraction >= 0.5) {
          issues.push({
            id: `highnull-${t.id}-${col.name}`,
            category: 'data-quality',
            severity: 'warning',
            code: 'HIGH_NULL_COLUMN',
            title: `高缺失率列 ${t.id}.${col.name}`,
            detail: `pg_stats 显示该列空值率达 ${(col.nullFraction * 100).toFixed(1)}%，统计建模或 JOIN 前需注意空值处理。`,
            tableId: t.id,
            columnName: col.name,
          });
        }
      }
    }
  }

  // Relation checks: type mismatch & directed cycles
  for (const r of activeRels) {
    const src = tableMap.get(r.sourceTableId);
    const tgt = tableMap.get(r.targetTableId);
    if (!src || !tgt) continue;
    const sc = src.columns.find(
      (c) => c.name.toLowerCase() === r.sourceColumn.toLowerCase(),
    );
    const tc = tgt.columns.find(
      (c) => c.name.toLowerCase() === r.targetColumn.toLowerCase(),
    );
    if (sc && tc && !areTypeFamiliesCompatible(sc.dataType, tc.dataType)) {
      issues.push({
        id: `typemis-${r.id}`,
        category: 'modeling',
        severity: 'warning',
        code: 'FK_TYPE_MISMATCH',
        title: `关联字段类型不一致`,
        detail: `${src.id}.${sc.name} (${sc.dataType}) → ${tgt.id}.${tc.name} (${tc.dataType}) 类型族不匹配，JOIN 时可能发生隐式类型转换并导致索引失效。`,
        tableId: src.id,
        columnName: sc.name,
        relationId: r.id,
      });
    }
  }

  // Cycle detection on physical/logical directed graph (excluding self-loops)
  const adj = new Map<string, string[]>();
  for (const r of activeRels) {
    if (r.sourceTableId === r.targetTableId) continue;
    const list = adj.get(r.sourceTableId) ?? [];
    list.push(r.targetTableId);
    adj.set(r.sourceTableId, list);
  }
  const color = new Map<string, 0 | 1 | 2>();
  const reportedCycle = new Set<string>();
  const dfs = (u: string, stack: string[]) => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) {
        const idx = stack.indexOf(v);
        const cycleNodes = idx >= 0 ? [...stack.slice(idx), v] : [u, v];
        const sig = [...cycleNodes].sort().join('->');
        if (!reportedCycle.has(sig)) {
          reportedCycle.add(sig);
          issues.push({
            id: `cycle-${sig}`,
            category: 'modeling',
            severity: 'warning',
            code: 'CYCLE_DEPENDENCY',
            title: `检测到循环外键依赖`,
            detail: `引用链路形成闭环：${cycleNodes.join(' → ')}。`,
            tableId: u,
          });
        }
      } else if (c === 0) {
        dfs(v, [...stack, v]);
      }
    }
    color.set(u, 2);
  };
  for (const t of tables) {
    if ((color.get(t.id) ?? 0) === 0) {
      dfs(t.id, [t.id]);
    }
  }

  const severityOrder = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  return issues;
}

export interface ErSchemaBaseModel {
  connectionId: string;
  title: string;
  dbType: DataLabDbConnection['dbType'];
  isOffline: boolean;
  baseTables: ErTable[];
  relations: ErRelation[];
  customTypes: ErCustomType[];
  issues: ErIssue[];
  autoPositions: Record<string, { x: number; y: number }>;
  autoAreas: ErSubjectArea[];
}

/**
 * Expensive Stage 1 (Schema + Physical FKs + Logical Inference + Dual Issues Linter).
 * Independent of table coordinates, viewport, areas, or notes so dragging/panning/zooming
 * NEVER re-runs inference or cycle detection.
 */
export function buildErSchemaBase(params: {
  connection: DataLabDbConnection | null;
  connectionId: string;
  liveTables: readonly DataDbTableSchema[];
  liveTypes?: readonly DataDbCustomType[];
  mountedFiles: readonly DataLabMountedFile[];
  pinnedLocalFiles: readonly string[];
  logicalRelations: readonly ErRelation[];
  dismissedInferredIds: readonly string[];
  showInferred: boolean;
  offlineTitle?: string;
  offlineDialect?: DataLabDbConnection['dbType'];
  offlineTables?: readonly DataDbTableSchema[];
  offlineTypes?: readonly DataDbCustomType[];
  profilesByTableId?: Record<string, DataDbTableProfile | undefined>;
}): ErSchemaBaseModel {
  const {
    connection,
    connectionId,
    liveTables,
    liveTypes = [],
    mountedFiles,
    pinnedLocalFiles,
    logicalRelations: rawLogicalRelations,
    dismissedInferredIds,
    showInferred,
    offlineTitle,
    offlineDialect,
    offlineTables,
    offlineTypes,
    profilesByTableId,
  } = params;

  const isOffline = !connection;
  const dbType = connection?.dbType ?? offlineDialect ?? 'postgres';
  const title = connection
    ? `${connection.name}${connection.database ? ` (${connection.database})` : ''}`
    : offlineTitle || '离线 ER 建模草图';

  const sourceTables = isOffline ? (offlineTables ?? []) : liveTables;
  const sourceTypes = isOffline ? (offlineTypes ?? []) : liveTypes;

  const baseTables: ErTable[] = [];
  const physicalRelations: ErRelation[] = [];

  for (const raw of sourceTables) {
    const schema = (
      raw.schema || (dbType === 'sqlite' ? 'main' : 'public')
    ).trim();
    const id = makeErTableId(schema, raw.name);
    const pkSet = new Set((raw.primaryKeys ?? []).map((p) => p.toLowerCase()));
    const prof = profilesByTableId?.[id];
    const profMap = new Map(
      (prof?.columns ?? []).map((c) => [c.name.toLowerCase(), c]),
    );

    const columns: ErColumn[] = (raw.columns ?? []).map((c) => {
      const pcol = profMap.get(c.name.toLowerCase());
      return {
        name: c.name,
        dataType: c.dataType || 'text',
        nullable: c.nullable ?? true,
        isPrimaryKey: Boolean(
          c.isPrimaryKey || pkSet.has(c.name.toLowerCase()),
        ),
        isUnique: Boolean(c.isUnique),
        defaultValue: c.defaultValue ?? null,
        comment: c.comment ?? pcol?.comment ?? null,
        nullFraction: pcol?.nullFraction ?? null,
        nDistinct: pcol?.nDistinct ?? null,
      };
    });

    const primaryKeys =
      raw.primaryKeys && raw.primaryKeys.length > 0
        ? [...raw.primaryKeys]
        : columns.filter((c) => c.isPrimaryKey).map((c) => c.name);

    baseTables.push({
      id,
      schema,
      name: raw.name,
      tableType: raw.tableType || 'table',
      sourceKind: isOffline ? 'offline' : 'live',
      estimatedRows: raw.estimatedRows ?? raw.rowCount ?? null,
      totalBytes: raw.totalBytes ?? null,
      comment: raw.comment ?? null,
      color: pickSchemaColor(schema),
      collapsed: false,
      columns,
      primaryKeys,
      indexes: raw.indexes ?? [],
      x: 0,
      y: 0,
      width: ER_CARD_WIDTH,
    });
  }

  const pinnedAliases = new Set(pinnedLocalFiles);
  for (const file of mountedFiles) {
    if (!pinnedAliases.has(file.alias)) continue;
    const id = makeLocalFileTableId(file.alias);
    const columns: ErColumn[] = (file.columns ?? []).map((c) => ({
      name: c.name,
      dataType: c.dataType || 'VARCHAR',
      nullable: c.nullable ?? true,
      isPrimaryKey: false,
      comment: c.comment ?? null,
    }));
    baseTables.push({
      id,
      schema: 'local',
      name: file.alias,
      tableType: file.format.toUpperCase(),
      sourceKind: 'local-file',
      estimatedRows: file.rowCount ?? null,
      totalBytes: file.sizeBytes ?? null,
      comment: file.path,
      color: '#3b6e8c',
      collapsed: false,
      columns,
      primaryKeys: [],
      indexes: [],
      x: 0,
      y: 0,
      width: ER_CARD_WIDTH,
      mountedFileAlias: file.alias,
      mountedFilePath: file.path,
      mountedFileFormat: file.format,
    });
  }

  const tableById = new Map(baseTables.map((t) => [t.id, t]));
  const seenPhys = new Set<string>();
  for (const raw of sourceTables) {
    const schema = (
      raw.schema || (dbType === 'sqlite' ? 'main' : 'public')
    ).trim();
    const srcId = makeErTableId(schema, raw.name);
    const srcTbl = tableById.get(srcId);
    if (!srcTbl) continue;
    for (const fk of raw.foreignKeys ?? []) {
      const tgtId = makeErTableId(fk.refSchema ?? schema, fk.refTable);
      const tgtTbl =
        tableById.get(tgtId) ??
        baseTables.find(
          (t) => t.name.toLowerCase() === fk.refTable.toLowerCase(),
        );
      if (!tgtTbl) continue;
      const key = makeRelationKey(srcId, fk.column, tgtTbl.id, fk.refColumn);
      if (seenPhys.has(key)) continue;
      seenPhys.add(key);
      physicalRelations.push({
        id: `fk:${key}`,
        sourceTableId: srcId,
        sourceColumn: fk.column,
        targetTableId: tgtTbl.id,
        targetColumn: fk.refColumn,
        cardinality: inferCardinality(srcTbl, fk.column, tgtTbl, fk.refColumn),
        kind: 'physical',
        constraintName: fk.constraintName ?? null,
        onUpdate: fk.onUpdate ?? 'NO ACTION',
        onDelete: fk.onDelete ?? 'NO ACTION',
      });
    }
  }

  const logicalRelations = rawLogicalRelations.filter(
    (r) => tableById.has(r.sourceTableId) && tableById.has(r.targetTableId),
  );

  const inferredRelations = inferLogicalRelations(
    baseTables,
    physicalRelations,
    logicalRelations,
    dismissedInferredIds,
  );

  const relations = [
    ...physicalRelations,
    ...logicalRelations,
    ...(showInferred ? inferredRelations : []),
  ];

  const auto = autoLayoutErDiagram(baseTables, relations);

  const customTypes: ErCustomType[] = sourceTypes.map((ct) => ({
    id: `${ct.schema || 'public'}.${ct.name}`,
    schema: ct.schema || 'public',
    name: ct.name,
    kind: ct.kind === 'composite' || ct.kind === 'domain' ? ct.kind : 'enum',
    values: ct.values ?? [],
    fields: (ct.fields ?? []).map((f) => ({
      name: f.name,
      dataType: f.dataType,
    })),
    comment: ct.comment ?? null,
  }));

  const issues = analyzeErIssues(baseTables, relations, profilesByTableId);

  return {
    connectionId,
    title,
    dbType,
    isOffline,
    baseTables,
    relations,
    customTypes,
    issues,
    autoPositions: auto.positions,
    autoAreas: auto.subjectAreas,
  };
}

/**
 * Lightweight Stage 2: applies coordinates, local aliases/notes, and preserves exact
 * object references for every unchanged table (via prevTableCache) so React.memo skips all unmoved cards.
 */
export function applyErLayoutOverlay(
  base: ErSchemaBaseModel,
  overlay: DbErOverlay,
  viewportOverride?: DbErOverlay['viewport'],
  prevTableCache?: Map<string, ErTable>,
): ErDiagramState {
  const liveIds = new Set<string>();
  const positioned: ErTable[] = [];
  let newCounter = 0;

  const tables: ErTable[] = base.baseTables.map((rawTbl) => {
    liveIds.add(rawTbl.id);
    const saved = overlay.tableLayouts[rawTbl.id];
    let x: number;
    let y: number;
    if (saved) {
      x = saved.x;
      y = saved.y;
    } else if (base.autoPositions[rawTbl.id]) {
      x = base.autoPositions[rawTbl.id].x;
      y = base.autoPositions[rawTbl.id].y;
    } else {
      const pt = placeNewTableCoords(positioned, rawTbl.schema, newCounter);
      x = pt.x;
      y = pt.y;
      newCounter += 1;
    }

    const width = saved?.width ?? rawTbl.width;
    const color = saved?.color || rawTbl.color;
    const collapsed = saved?.collapsed ?? false;
    const alias = saved?.alias;
    const note = saved?.note;

    let columnsChanged = false;
    const colsWithNotes = rawTbl.columns.map((c) => {
      const cn = overlay.columnNotes[`${rawTbl.id}.${c.name}`];
      if (cn !== c.note) {
        columnsChanged = true;
        return { ...c, note: cn };
      }
      return c;
    });
    const finalCols = columnsChanged ? colsWithNotes : rawTbl.columns;

    const prev = prevTableCache?.get(rawTbl.id);
    if (
      prev &&
      prev.x === x &&
      prev.y === y &&
      prev.width === width &&
      prev.color === color &&
      prev.collapsed === collapsed &&
      prev.alias === alias &&
      prev.note === note &&
      prev.columns.length === finalCols.length &&
      prev.columns.every(
        (pc, idx) =>
          pc === finalCols[idx] ||
          (pc.name === finalCols[idx].name &&
            pc.dataType === finalCols[idx].dataType &&
            pc.note === finalCols[idx].note &&
            pc.nullFraction === finalCols[idx].nullFraction),
      ) &&
      prev.estimatedRows === rawTbl.estimatedRows &&
      prev.totalBytes === rawTbl.totalBytes
    ) {
      positioned.push(prev);
      return prev;
    }

    const nextTbl: ErTable = {
      ...rawTbl,
      x,
      y,
      width,
      color,
      collapsed,
      alias,
      note,
      columns: finalCols,
    };
    prevTableCache?.set(rawTbl.id, nextTbl);
    positioned.push(nextTbl);
    return nextTbl;
  });

  if (!base.isOffline) {
    for (const [savedId, saved] of Object.entries(overlay.tableLayouts)) {
      if (liveIds.has(savedId)) continue;
      if (savedId.startsWith('local:')) continue;
      if (!saved.alias && !saved.note) continue;
      const dot = savedId.indexOf('.');
      const sch = dot > 0 ? savedId.slice(0, dot) : 'public';
      const nm = dot > 0 ? savedId.slice(dot + 1) : savedId;
      tables.push({
        id: savedId,
        schema: sch,
        name: nm,
        tableType: 'missing',
        sourceKind: 'live',
        alias: saved.alias,
        note: saved.note,
        color: saved.color || '#8c5a7a',
        collapsed: true,
        columns: [],
        primaryKeys: [],
        indexes: [],
        x: saved.x,
        y: saved.y,
        width: saved.width ?? ER_CARD_WIDTH,
        missingInLive: true,
      });
    }
  }

  const subjectAreas =
    overlay.subjectAreas.length > 0 ? overlay.subjectAreas : base.autoAreas;

  return {
    connectionId: base.connectionId,
    title: base.title,
    dbType: base.dbType,
    isOffline: base.isOffline,
    tables,
    relations: base.relations,
    subjectAreas,
    notes: overlay.notes ?? [],
    customTypes: base.customTypes,
    issues: base.issues,
    viewport: viewportOverride ?? overlay.viewport,
    routing: overlay.routing,
    showGrid: overlay.showGrid,
    snapToGrid: overlay.snapToGrid,
    showInferred: overlay.showInferred,
  };
}

/**
 * Merges live DB introspection + pinned local Parquet/CSV files + persisted local overlay
 * without ever losing manual coordinates, Chinese aliases, notes, or logical relations.
 */
export function mergeLiveSchemaIntoEr(params: {
  connection: DataLabDbConnection | null;
  liveTables: readonly DataDbTableSchema[];
  liveTypes?: readonly DataDbCustomType[];
  mountedFiles: readonly DataLabMountedFile[];
  overlay: DbErOverlay;
  profilesByTableId?: Record<string, DataDbTableProfile | undefined>;
}): ErDiagramState {
  const base = buildErSchemaBase({
    connection: params.connection,
    connectionId: params.overlay.connectionId,
    liveTables: params.liveTables,
    liveTypes: params.liveTypes,
    mountedFiles: params.mountedFiles,
    pinnedLocalFiles: params.overlay.pinnedLocalFiles ?? [],
    logicalRelations: params.overlay.logicalRelations ?? [],
    dismissedInferredIds: params.overlay.dismissedInferredIds ?? [],
    showInferred: params.overlay.showInferred,
    offlineTitle: params.overlay.offlineTitle,
    offlineDialect: params.overlay.offlineDialect,
    offlineTables: params.overlay.offlineTables,
    offlineTypes: params.overlay.offlineTypes,
    profilesByTableId: params.profilesByTableId,
  });
  return applyErLayoutOverlay(base, params.overlay);
}

/* ==========================================================================
   JOIN / Federated Analysis Code Generators (ER Edge -> Notebook Cell)
   ========================================================================== */

function quoteCol(name: string, dbType: DataLabDbConnection['dbType']): string {
  if (dbType === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function buildRelationJoinSql(
  relation: ErRelation,
  sourceTable: ErTable,
  targetTable: ErTable,
  connection: DataLabDbConnection | null,
  limit = 100,
): { sql: string; useDuckDbFederation: boolean; attachDbIds?: string[] } {
  const dbType = connection?.dbType ?? 'postgres';
  const isCrossSource =
    sourceTable.sourceKind === 'local-file' ||
    targetTable.sourceKind === 'local-file';

  if (isCrossSource && connection) {
    const fedSql = buildRelationDuckDbSql(
      relation,
      sourceTable,
      targetTable,
      connection,
      limit,
    );
    return {
      sql: fedSql,
      useDuckDbFederation: true,
      attachDbIds: [connection.id],
    };
  }

  const srcRef = quoteQualifiedTable(
    sourceTable.name,
    sourceTable.schema,
    dbType,
  );
  const tgtRef = quoteQualifiedTable(
    targetTable.name,
    targetTable.schema,
    dbType,
  );
  const sCol = quoteCol(relation.sourceColumn, dbType);
  const tCol = quoteCol(relation.targetColumn, dbType);
  const kindTag =
    relation.kind === 'physical'
      ? '物理外键'
      : relation.kind === 'logical'
        ? '逻辑关联'
        : '智能推断关联';

  const sql = [
    `-- ER 图谱一键生成 (${kindTag} · ${relation.cardinality}): ${sourceTable.id}.${relation.sourceColumn} → ${targetTable.id}.${relation.targetColumn}`,
    `SELECT`,
    `  a.*,`,
    `  b.*`,
    `FROM ${srcRef} AS a`,
    `INNER JOIN ${tgtRef} AS b`,
    `  ON a.${sCol} = b.${tCol}`,
    `LIMIT ${limit};`,
  ].join('\n');

  return { sql, useDuckDbFederation: false };
}

export function buildRelationDuckDbSql(
  relation: ErRelation,
  sourceTable: ErTable,
  targetTable: ErTable,
  connection: DataLabDbConnection | null,
  limit = 100,
): string {
  const dbAlias = sanitizeDataAlias(
    connection?.database || connection?.name || 'db',
  );
  const formatTableRef = (tbl: ErTable): string => {
    if (tbl.sourceKind === 'local-file') {
      return `"${tbl.mountedFileAlias || tbl.name}"`;
    }
    const sch =
      tbl.schema && tbl.schema !== 'main' && tbl.schema !== 'default'
        ? `"${tbl.schema}".`
        : '';
    return `"${dbAlias}".${sch}"${tbl.name}"`;
  };
  const srcRef = formatTableRef(sourceTable);
  const tgtRef = formatTableRef(targetTable);
  return [
    `-- DuckDB 联邦只读 JOIN (${sourceTable.id} ↔ ${targetTable.id})`,
    `SELECT`,
    `  a.*,`,
    `  b.*`,
    `FROM ${srcRef} AS a`,
    `INNER JOIN ${tgtRef} AS b`,
    `  ON a."${relation.sourceColumn}" = b."${relation.targetColumn}"`,
    `LIMIT ${limit};`,
  ].join('\n');
}

export function buildRelationPythonSnippet(
  relation: ErRelation,
  sourceTable: ErTable,
  targetTable: ErTable,
  connection: DataLabDbConnection | null,
  limit = 10000,
): string {
  const varName = `df_${sanitizeDataAlias(`${sourceTable.name}_${targetTable.name}`)}`;
  const { sql, useDuckDbFederation } = buildRelationJoinSql(
    relation,
    sourceTable,
    targetTable,
    connection,
    limit,
  );
  const connName = JSON.stringify(connection?.name || 'default');
  if (useDuckDbFederation) {
    return `# DuckDB 联邦跨源 JOIN（自动只读 ATTACH ${connection?.name ?? ''} 与本地文件）\n${varName} = sm_sql(\n    """\n${sql}\n    """,\n    attach_dbs=[${connName}],\n)\nprint(${varName}.shape)\n${varName}.head(10)`;
  }
  return `# ER 关系一键直连取数（安全只读，无需明文密码）\n${varName} = sm_db_query(\n    ${connName},\n    """\n${sql}\n    """,\n)\nprint(${varName}.shape)\n${varName}.head(10)`;
}

export function buildRelationRSnippet(
  relation: ErRelation,
  sourceTable: ErTable,
  targetTable: ErTable,
  connection: DataLabDbConnection | null,
  limit = 10000,
): string {
  const varName = `df_${sanitizeDataAlias(`${sourceTable.name}_${targetTable.name}`)}`;
  const { sql } = buildRelationJoinSql(
    relation,
    sourceTable,
    targetTable,
    connection,
    limit,
  );
  const singleLineSql = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join(' ')
    .replace(/'/g, "''");
  const connName = JSON.stringify(connection?.name || 'default');
  return `# ER 关系一键 R 取数（经由 Seamind Parquet 总线）\n${varName} <- sm_db_query(\n  ${connName},\n  '${singleLineSql}'\n)\nstr(${varName})\nhead(${varName}, 10)`;
}
