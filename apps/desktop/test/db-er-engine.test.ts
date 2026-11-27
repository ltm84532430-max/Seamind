import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  exportErToDbml,
  exportErToJson,
  exportErToMarkdownDictionary,
  exportErToMermaid,
  exportErToSql,
  exportErToStandaloneSvg,
  parseErImportText,
} from '../src/terminal/db-er-codec';
import {
  assembleLosslessPdfDocument,
  buildErExportSvgDocument,
  compressZlibFlate,
  computeErExportPlan,
  encodeRgbToPngSubScanlines,
  rewriteSvgViewport,
  uint8ArrayToBase64,
} from '../src/terminal/db-er-export';
import {
  analyzeErIssues,
  applyErLayoutOverlay,
  buildErSchemaBase,
  buildRelationJoinSql,
  buildRelationPythonSnippet,
  inferLogicalRelations,
  mergeLiveSchemaIntoEr,
} from '../src/terminal/db-er-infer';
import {
  autoLayoutErDiagram,
  calcErEdgePath,
  computeDragSnap,
  computeDragSnapFast,
  computeFitViewport,
  precomputeSnapBoxes,
} from '../src/terminal/db-er-layout';
import {
  createEmptyErOverlay,
  ER_CARD_WIDTH,
  makeErTableId,
} from '../src/terminal/db-er-model';
import type { DataDbTableSchema } from '../src/terminal/terminal-api';
import type {
  DataLabDbConnection,
  DataLabMountedFile,
} from '../src/terminal/terminal-codelab-model';

const FRED_CONN: DataLabDbConnection = {
  id: 'conn-fed',
  name: 'FRED Macro PG',
  dbType: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: 'FED',
  username: 'postgres',
  readOnly: true,
};

const FRED_LIVE_TABLES: DataDbTableSchema[] = [
  {
    name: 'series',
    schema: 'fred',
    tableType: 'table',
    estimatedRows: 4200,
    totalBytes: 2_400_000,
    comment: 'FRED macro series metadata',
    primaryKeys: ['series_id'],
    foreignKeys: [],
    indexes: [
      {
        name: 'series_pkey',
        columns: ['series_id'],
        unique: true,
        primary: true,
      },
    ],
    columns: [
      {
        name: 'series_id',
        dataType: 'text',
        nullable: false,
        isPrimaryKey: true,
      },
      { name: 'title', dataType: 'text', nullable: true },
      { name: 'frequency', dataType: 'text', nullable: true },
      { name: 'release_id', dataType: 'integer', nullable: true },
    ],
  },
  {
    name: 'observations',
    schema: 'fred',
    tableType: 'table',
    estimatedRows: 1_030_485,
    totalBytes: 168_000_000,
    primaryKeys: [
      'series_id',
      'observation_date',
      'realtime_start',
      'realtime_end',
    ],
    foreignKeys: [],
    indexes: [
      {
        name: 'observations_pkey',
        columns: [
          'series_id',
          'observation_date',
          'realtime_start',
          'realtime_end',
        ],
        unique: true,
        primary: true,
      },
    ],
    columns: [
      {
        name: 'series_id',
        dataType: 'text',
        nullable: false,
        isPrimaryKey: true,
      },
      {
        name: 'observation_date',
        dataType: 'date',
        nullable: false,
        isPrimaryKey: true,
      },
      {
        name: 'realtime_start',
        dataType: 'date',
        nullable: false,
        isPrimaryKey: true,
      },
      {
        name: 'realtime_end',
        dataType: 'date',
        nullable: false,
        isPrimaryKey: true,
      },
      { name: 'value', dataType: 'numeric(20,6)', nullable: true },
      { name: 'raw_value', dataType: 'text', nullable: true },
    ],
  },
  {
    name: 'releases',
    schema: 'fred',
    tableType: 'table',
    estimatedRows: 310,
    totalBytes: 64_000,
    primaryKeys: ['id'],
    foreignKeys: [],
    indexes: [],
    columns: [
      { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true },
      { name: 'name', dataType: 'text', nullable: false },
    ],
  },
  {
    name: 'staging_empty',
    schema: 'public',
    tableType: 'table',
    estimatedRows: 0,
    totalBytes: 0,
    primaryKeys: [],
    foreignKeys: [],
    indexes: [],
    columns: [{ name: 'payload', dataType: 'jsonb', nullable: true }],
  },
];

const LOCAL_FILES: DataLabMountedFile[] = [
  {
    id: 'df-1',
    alias: 't_2022_12_19',
    path: 'C:/data/t_2022_12_19.parquet',
    format: 'parquet',
    rowCount: 24710,
    sizeBytes: 457_200,
    columns: [
      { name: 'observation_date', dataType: 'DATE' },
      { name: 'close', dataType: 'DOUBLE' },
    ],
    updatedAt: 1,
  },
];

describe('Seamind Database ER Studio engine', () => {
  it('merges live schema with local research overlay without losing annotations and infers logical FKs', () => {
    const overlay = createEmptyErOverlay('conn-fed');
    overlay.tableLayouts['fred.observations'] = {
      x: 520,
      y: 120,
      alias: 'FRED 宏观观测值主表',
      note: '百万行双时态核心表',
    };
    overlay.columnNotes['fred.observations.value'] = '清洗后的数值型观测值';
    overlay.pinnedLocalFiles = ['t_2022_12_19'];

    const state = mergeLiveSchemaIntoEr({
      connection: FRED_CONN,
      liveTables: FRED_LIVE_TABLES,
      liveTypes: [
        {
          name: 'freq_enum',
          schema: 'fred',
          kind: 'enum',
          values: ['D', 'W', 'M', 'Q', 'A'],
          fields: [],
        },
      ],
      mountedFiles: LOCAL_FILES,
      overlay,
    });

    const obs = state.tables.find((t) => t.id === 'fred.observations');
    expect(obs?.x).toBe(520);
    expect(obs?.y).toBe(120);
    expect(obs?.alias).toBe('FRED 宏观观测值主表');
    expect(obs?.columns.find((c) => c.name === 'value')?.note).toBe(
      '清洗后的数值型观测值',
    );

    // Logical FK inference catches both PK exact match (series_id) and singular _id match (release_id)
    const inferred = state.relations.filter((r) => r.kind === 'inferred');
    expect(
      inferred.some(
        (r) =>
          r.sourceTableId === 'fred.observations' &&
          r.sourceColumn === 'series_id' &&
          r.targetTableId === 'fred.series',
      ),
    ).toBe(true);
    expect(
      inferred.some(
        (r) =>
          r.sourceTableId === 'fred.series' &&
          r.sourceColumn === 'release_id' &&
          r.targetTableId === 'fred.releases' &&
          r.targetColumn === 'id',
      ),
    ).toBe(true);
    // Cross-source local Parquet file join hint
    expect(
      inferred.some(
        (r) =>
          r.sourceTableId === 'local:t_2022_12_19' &&
          r.sourceColumn === 'observation_date' &&
          r.targetTableId === 'fred.observations',
      ),
    ).toBe(true);

    // Dual-dimension Issues linter catches missing PK, zero-row table, and vintage bitemporal PK tip
    const codes = new Set(state.issues.map((i) => i.code));
    expect(codes.has('MISSING_PK')).toBe(true);
    expect(codes.has('ZERO_ROW_TABLE')).toBe(true);
    expect(codes.has('VINTAGE_COMPOSITE_PK')).toBe(true);
  });

  it('computes clean multi-schema auto-layout, orthogonal/bezier paths, snapping, and fit viewport', () => {
    const overlay = createEmptyErOverlay('conn-fed');
    const state = mergeLiveSchemaIntoEr({
      connection: FRED_CONN,
      liveTables: FRED_LIVE_TABLES,
      mountedFiles: [],
      overlay,
    });

    const layout = autoLayoutErDiagram(state.tables, state.relations);
    expect(Object.keys(layout.positions)).toHaveLength(FRED_LIVE_TABLES.length);
    expect(layout.subjectAreas.map((a) => a.name)).toContain('fred');
    expect(layout.subjectAreas.map((a) => a.name)).toContain('public');

    const src = state.tables.find((t) => t.id === 'fred.observations')!;
    const tgt = state.tables.find((t) => t.id === 'fred.series')!;
    const ortho = calcErEdgePath(
      src,
      'series_id',
      tgt,
      'series_id',
      'orthogonal',
    );
    const bez = calcErEdgePath(src, 'series_id', tgt, 'series_id', 'bezier');
    expect(ortho.pathD.startsWith('M ')).toBe(true);
    expect(bez.pathD).toContain(' C ');

    // Self-loop edge works cleanly
    const selfLoop = calcErEdgePath(
      src,
      'series_id',
      src,
      'raw_value',
      'orthogonal',
    );
    expect(selfLoop.sourceDir).toBe(1);
    expect(selfLoop.targetDir).toBe(1);

    // Drag snap aligns to nearby table X edge
    const snapped = computeDragSnap(
      src.id,
      tgt.x + 3,
      tgt.y + 400,
      ER_CARD_WIDTH,
      200,
      state.tables,
      true,
    );
    expect(snapped.x).toBe(tgt.x);
    expect(snapped.guides.some((g) => g.axis === 'x')).toBe(true);

    const fit = computeFitViewport(
      state.tables,
      state.subjectAreas,
      [],
      1200,
      800,
    );
    expect(fit.zoom).toBeGreaterThan(0.2);
    expect(fit.zoom).toBeLessThanOrEqual(1.15);
  });

  it('generates executable JOIN SQL and DuckDB federated snippets from ER relations', () => {
    const overlay = createEmptyErOverlay('conn-fed');
    overlay.pinnedLocalFiles = ['t_2022_12_19'];
    const state = mergeLiveSchemaIntoEr({
      connection: FRED_CONN,
      liveTables: FRED_LIVE_TABLES,
      mountedFiles: LOCAL_FILES,
      overlay,
    });

    const dbRel = state.relations.find(
      (r) =>
        r.sourceTableId === 'fred.observations' &&
        r.targetTableId === 'fred.series',
    )!;
    const obs = state.tables.find((t) => t.id === 'fred.observations')!;
    const ser = state.tables.find((t) => t.id === 'fred.series')!;
    const joinRes = buildRelationJoinSql(dbRel, obs, ser, FRED_CONN, 50);
    expect(joinRes.useDuckDbFederation).toBe(false);
    expect(joinRes.sql).toContain('"fred"."observations"');
    expect(joinRes.sql).toContain('INNER JOIN "fred"."series"');

    const crossRel = state.relations.find(
      (r) => r.sourceTableId === 'local:t_2022_12_19',
    )!;
    const lf = state.tables.find((t) => t.id === 'local:t_2022_12_19')!;
    const fedRes = buildRelationJoinSql(crossRel, lf, obs, FRED_CONN, 50);
    expect(fedRes.useDuckDbFederation).toBe(true);
    expect(fedRes.attachDbIds).toEqual(['conn-fed']);
    expect(fedRes.sql).toContain('"fed"."fred"."observations"');

    const pyCode = buildRelationPythonSnippet(crossRel, lf, obs, FRED_CONN);
    expect(pyCode).toContain('sm_sql(');
    expect(pyCode).toContain('attach_dbs=');
  });

  it('round-trips SQL DDL, DBML, Mermaid, Markdown Dictionary, pure-vector SVG, and JSON snapshots', () => {
    const overlay = createEmptyErOverlay('conn-fed');
    overlay.logicalRelations = [
      {
        id: 'log-1',
        sourceTableId: 'fred.observations',
        sourceColumn: 'series_id',
        targetTableId: 'fred.series',
        targetColumn: 'series_id',
        cardinality: 'N:1',
        kind: 'logical',
        note: '观测值归属宏观序列',
      },
    ];
    const state = mergeLiveSchemaIntoEr({
      connection: FRED_CONN,
      liveTables: FRED_LIVE_TABLES,
      liveTypes: [
        {
          name: 'freq_enum',
          schema: 'fred',
          kind: 'enum',
          values: ['D', 'M', 'Q'],
          fields: [],
        },
      ],
      mountedFiles: [],
      overlay,
    });

    // SQL round-trip
    const pgSql = exportErToSql(state, 'postgres');
    expect(pgSql).toContain('CREATE TYPE "fred"."freq_enum" AS ENUM');
    expect(pgSql).toContain('CREATE TABLE "fred"."observations"');
    const parsedSql = parseErImportText(pgSql);
    expect(parsedSql.format).toBe('sql');
    expect(parsedSql.tables.length).toBe(4);
    expect(parsedSql.customTypes.length).toBe(1);
    const parsedObs = parsedSql.tables.find((t) => t.name === 'observations');
    expect(parsedObs?.primaryKeys).toEqual([
      'series_id',
      'observation_date',
      'realtime_start',
      'realtime_end',
    ]);
    expect(parsedObs?.foreignKeys?.length).toBe(1);

    // DBML round-trip
    const dbml = exportErToDbml(state);
    expect(dbml).toContain('Enum fred.freq_enum');
    expect(dbml).toContain('Table fred.observations');
    const parsedDbml = parseErImportText(dbml);
    expect(parsedDbml.format).toBe('dbml');
    expect(parsedDbml.tables.length).toBe(4);
    expect(parsedDbml.customTypes.length).toBe(1);

    // Mermaid & Markdown Dictionary & SVG & JSON
    const mermaid = exportErToMermaid(state);
    expect(mermaid).toContain('erDiagram');
    expect(mermaid).toContain('fred_observations');

    const md = exportErToMarkdownDictionary(state, FRED_CONN);
    expect(md).toContain('```mermaid');
    expect(md).toContain('`fred.observations`');

    const svg = exportErToStandaloneSvg(state, 'light');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('foreignObject');
    expect(svg).toContain('fred.observations');

    const json = exportErToJson(state, overlay);
    const parsedJson = parseErImportText(json);
    expect(parsedJson.format).toBe('json');
    expect(parsedJson.tables.length).toBe(4);
  });

  it('respects dismissed inferred relations and detects FK type mismatches & cycles', () => {
    const tA = {
      id: makeErTableId('public', 'a'),
      schema: 'public',
      name: 'a',
      tableType: 'table',
      sourceKind: 'offline' as const,
      color: '#467b5e',
      columns: [
        {
          name: 'id',
          dataType: 'integer',
          nullable: false,
          isPrimaryKey: true,
        },
        { name: 'b_id', dataType: 'text', nullable: true, isPrimaryKey: false },
      ],
      primaryKeys: ['id'],
      indexes: [],
      x: 0,
      y: 0,
      width: ER_CARD_WIDTH,
    };
    const tB = {
      id: makeErTableId('public', 'b'),
      schema: 'public',
      name: 'b',
      tableType: 'table',
      sourceKind: 'offline' as const,
      color: '#467b5e',
      columns: [
        {
          name: 'id',
          dataType: 'integer',
          nullable: false,
          isPrimaryKey: true,
        },
        {
          name: 'a_id',
          dataType: 'integer',
          nullable: true,
          isPrimaryKey: false,
        },
      ],
      primaryKeys: ['id'],
      indexes: [],
      x: 360,
      y: 0,
      width: ER_CARD_WIDTH,
    };
    const rels = [
      {
        id: 'r1',
        sourceTableId: 'public.a',
        sourceColumn: 'b_id',
        targetTableId: 'public.b',
        targetColumn: 'id',
        cardinality: 'N:1' as const,
        kind: 'physical' as const,
      },
      {
        id: 'r2',
        sourceTableId: 'public.b',
        sourceColumn: 'a_id',
        targetTableId: 'public.a',
        targetColumn: 'id',
        cardinality: 'N:1' as const,
        kind: 'physical' as const,
      },
    ];
    const issues = analyzeErIssues([tA, tB], rels);
    expect(issues.some((i) => i.code === 'FK_TYPE_MISMATCH')).toBe(true);
    expect(issues.some((i) => i.code === 'CYCLE_DEPENDENCY')).toBe(true);

    // Dismissed inference does not reappear
    const inferred = inferLogicalRelations(
      [tA, tB],
      [],
      [],
      ['inf:public.b.a_id->public.a.id'],
    );
    expect(
      inferred.some((r) => r.id === 'inf:public.b.a_id->public.a.id'),
    ).toBe(false);
  });

  it('preserves object references for unmoved tables and runs precomputed fast drag snap smoothly on 100 tables', () => {
    const overlay = createEmptyErOverlay('conn-fed');
    const base = buildErSchemaBase({
      connection: FRED_CONN,
      connectionId: 'conn-fed',
      liveTables: FRED_LIVE_TABLES,
      mountedFiles: [],
      pinnedLocalFiles: [],
      logicalRelations: [],
      dismissedInferredIds: [],
      showInferred: true,
    });
    const cache = new Map();
    const first = applyErLayoutOverlay(base, overlay, undefined, cache);

    // Move ONLY fred.observations; all other tables must keep exact === object identity for React.memo
    const movedOverlay = {
      ...overlay,
      tableLayouts: {
        ...overlay.tableLayouts,
        'fred.observations': { x: 900, y: 400 },
      },
    };
    const second = applyErLayoutOverlay(base, movedOverlay, undefined, cache);
    const firstSeries = first.tables.find((t) => t.id === 'fred.series');
    const secondSeries = second.tables.find((t) => t.id === 'fred.series');
    const firstObs = first.tables.find((t) => t.id === 'fred.observations');
    const secondObs = second.tables.find((t) => t.id === 'fred.observations');

    expect(secondSeries).toBe(firstSeries);
    expect(secondObs).not.toBe(firstObs);
    expect(secondObs?.x).toBe(900);

    // Precomputed fast drag snap on 100 tables over 500 frames stays ultra-fast
    const hundredTables = Array.from({ length: 100 }, (_, i) => ({
      id: `s.t_${i}`,
      schema: 's',
      name: `t_${i}`,
      tableType: 'table',
      sourceKind: 'live' as const,
      color: '#467b5e',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true },
        { name: 'val', dataType: 'text', nullable: true, isPrimaryKey: false },
      ],
      primaryKeys: ['id'],
      indexes: [],
      x: (i % 10) * 340,
      y: Math.floor(i / 10) * 240,
      width: ER_CARD_WIDTH,
    }));
    const boxes = precomputeSnapBoxes(hundredTables, 's.t_0', false);
    expect(boxes).toHaveLength(99);
    const t0 = performance.now();
    let lastSnapX = 0;
    for (let f = 0; f < 500; f += 1) {
      const res = computeDragSnapFast(
        343,
        f * 2,
        ER_CARD_WIDTH,
        120,
        boxes,
        true,
      );
      lastSnapX = res.x;
    }
    const elapsedMs = performance.now() - t0;
    expect(lastSnapX).toBe(340);
    expect(elapsedMs).toBeLessThan(200);
  });

  it('builds publication-grade high-detail SVG and plans safe PNG/PDF resolutions without blurry clamping', () => {
    const overlay = createEmptyErOverlay('conn-fed');
    overlay.notes = [
      {
        id: 'n-1',
        title: '双时态口径说明',
        content:
          '第一行说明：FRED 数据包含 vintage 修订历史。\n第二行说明：分析时请按 realtime_end 过滤。',
        x: 40,
        y: 520,
        width: 240,
        height: 120,
        color: '#fef3c7',
      },
    ];
    overlay.tableLayouts['fred.observations'] = {
      x: 480,
      y: 120,
      collapsed: true,
    };

    const liveWithLongType: DataDbTableSchema[] = FRED_LIVE_TABLES.map((t) =>
      t.name === 'observations'
        ? {
            ...t,
            columns: [
              ...t.columns,
              {
                name: 'loaded_at',
                dataType: 'timestamp with time zone',
                nullable: false,
                isPrimaryKey: false,
              },
            ],
          }
        : t,
    );

    const state = mergeLiveSchemaIntoEr({
      connection: FRED_CONN,
      liveTables: liveWithLongType,
      mountedFiles: [],
      overlay,
    });

    const svgDoc = buildErExportSvgDocument(state, {
      paletteMode: 'dark',
      appTheme: 'dark',
      expandAllColumns: true,
      includeGrid: true,
      includeHeaderLegend: true,
      showRelationLabels: true,
    });

    expect(svgDoc.svg.startsWith('<svg')).toBe(true);
    expect(svgDoc.svg).not.toContain('foreignObject');
    expect(svgDoc.svg).toContain('erDotGrid');
    expect(svgDoc.svg).toContain('>PK<');
    expect(svgDoc.svg).toContain('>FK<');
    // Expanded collapsed table preserves full long Postgres data type without legacy .slice(0, 18) chop!
    expect(svgDoc.svg).toContain('loaded_at');
    expect(svgDoc.svg).toContain('timestamp with time zone');
    // Multi-line note renders both lines
    expect(svgDoc.svg).toContain('第一行说明');
    expect(svgDoc.svg).toContain('第二行说明');

    // rewriteSvgViewport targets exact physical pixel size for Skia native high-DPI rasterization
    const hiResSvg = rewriteSvgViewport(
      svgDoc.svg,
      svgDoc.viewBoxX,
      svgDoc.viewBoxY,
      svgDoc.width,
      svgDoc.height,
      svgDoc.width * 3,
      svgDoc.height * 3,
    );
    expect(hiResSvg).toContain(
      `width="${svgDoc.width * 3}" height="${svgDoc.height * 3}"`,
    );

    // Tall 23-table schema (1400 x 4800) gets full 3x un-clamped PNG and seamless multi-strip PDF
    const pngPlan3x = computeErExportPlan(
      { width: 1400, height: 4800 },
      {
        format: 'png',
        scale: 3,
        pdfPageMode: 'single-page',
        pdfOrientation: 'auto',
      },
    );
    expect(pngPlan3x.clamped).toBe(false);
    expect(pngPlan3x.pixelWidth).toBe(4200);
    expect(pngPlan3x.pixelHeight).toBe(14400);

    // Colossal 10000 x 10000 diagram safely clamps PNG to prevent GPU OOM while single-page PDF uses strips
    const giantPng = computeErExportPlan(
      { width: 10000, height: 10000 },
      {
        format: 'png',
        scale: 4,
        pdfPageMode: 'single-page',
        pdfOrientation: 'auto',
      },
    );
    expect(giantPng.clamped).toBe(true);
    expect(giantPng.pixelWidth * giantPng.pixelHeight).toBeLessThanOrEqual(
      96_500_000,
    );

    const tallSinglePdf = computeErExportPlan(
      { width: 1400, height: 4800 },
      {
        format: 'pdf',
        scale: 3,
        pdfPageMode: 'single-page',
        pdfOrientation: 'auto',
      },
    );
    expect(tallSinglePdf.pdfPageCount).toBe(1);
    expect(tallSinglePdf.pdfStripCount).toBeGreaterThan(1);
    expect(tallSinglePdf.pixelWidth).toBe(4200);
    expect(tallSinglePdf.pixelHeight).toBe(14400);

    const a4Tiled = computeErExportPlan(
      { width: 1400, height: 4800 },
      {
        format: 'pdf',
        scale: 3,
        pdfPageMode: 'a4-tiled',
        pdfOrientation: 'portrait',
      },
    );
    expect(a4Tiled.pdfGridCols).toBeGreaterThanOrEqual(2);
    expect(a4Tiled.pdfGridRows).toBeGreaterThanOrEqual(4);
    expect(a4Tiled.pdfPageCount).toBe(
      a4Tiled.pdfGridCols * a4Tiled.pdfGridRows,
    );
  });

  it('encodes lossless PNG-Sub RGB zlib streams and assembles valid ISO PDF 1.4 with exact xref offsets', async () => {
    const w = 16;
    const h = 8;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const idx = (y * w + x) * 4;
        rgba[idx] = (x * 15) & 0xff;
        rgba[idx + 1] = (y * 31) & 0xff;
        rgba[idx + 2] = ((x + y) * 11) & 0xff;
        rgba[idx + 3] = 255;
      }
    }

    const filtered = encodeRgbToPngSubScanlines(rgba, w, h);
    expect(filtered.length).toBe(h * (1 + w * 3));
    const compressed = await compressZlibFlate(filtered);
    // Valid RFC 1950 zlib header check
    expect((compressed[0] * 256 + compressed[1]) % 31).toBe(0);
    // Byte-for-byte inflate round-trip via Node's native zlib
    const inflated = new Uint8Array(inflateSync(compressed));
    expect(inflated).toEqual(filtered);

    // Reconstruct RGB pixels from PNG Sub filter (filter byte = 1) and verify exact match
    for (let y = 0; y < h; y += 1) {
      const rowStart = y * (1 + w * 3);
      expect(inflated[rowStart]).toBe(1);
      let pr = 0;
      let pg = 0;
      let pb = 0;
      for (let x = 0; x < w; x += 1) {
        const p = rowStart + 1 + x * 3;
        pr = (pr + inflated[p]) & 0xff;
        pg = (pg + inflated[p + 1]) & 0xff;
        pb = (pb + inflated[p + 2]) & 0xff;
        const srcIdx = (y * w + x) * 4;
        expect([pr, pg, pb]).toEqual([
          rgba[srcIdx],
          rgba[srcIdx + 1],
          rgba[srcIdx + 2],
        ]);
      }
    }

    // Assemble a 2-page PDF (page 1 with 2 strips, page 2 with 1 tile + footer)
    const pdfBytes = assembleLosslessPdfDocument(
      [
        {
          widthPt: 600,
          heightPt: 400,
          backgroundRgb: [19, 23, 29],
          images: [
            {
              pixelWidth: w,
              pixelHeight: h,
              flateSubRgbBytes: compressed,
              drawXPt: 0,
              drawYPt: 200,
              drawWidthPt: 600,
              drawHeightPt: 200,
            },
            {
              pixelWidth: w,
              pixelHeight: h,
              flateSubRgbBytes: compressed,
              drawXPt: 0,
              drawYPt: 0,
              drawWidthPt: 600,
              drawHeightPt: 200,
            },
          ],
        },
        {
          widthPt: 595.28,
          heightPt: 841.89,
          backgroundRgb: [248, 250, 252],
          images: [
            {
              pixelWidth: w,
              pixelHeight: h,
              flateSubRgbBytes: compressed,
              drawXPt: 28,
              drawYPt: 400,
              drawWidthPt: 500,
              drawHeightPt: 400,
            },
          ],
          footerAscii: 'us_market | Page 2 / 2',
        },
      ],
      { title: 'ER · us_market 数据库架构图' },
    );

    const pdfLatin1 = Buffer.from(pdfBytes).toString('latin1');
    expect(pdfLatin1.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdfLatin1.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdfLatin1).toContain('/Count 2');
    expect(pdfLatin1).toContain('/Predictor 15');
    expect(pdfLatin1).toContain('/Filter /FlateDecode');
    expect(pdfLatin1).toContain('/Title <FEFF');

    // Verify startxref points directly to "xref\n" and every object offset matches "N 0 obj"
    const startXrefMatch = pdfLatin1.match(/startxref\n(\d+)\n%%EOF/);
    expect(startXrefMatch).not.toBeNull();
    const xrefOffset = Number(startXrefMatch![1]);
    expect(pdfLatin1.slice(xrefOffset, xrefOffset + 5)).toBe('xref\n');

    const xrefSection = pdfLatin1.slice(xrefOffset);
    const entryMatches = [...xrefSection.matchAll(/^(\d{10}) 00000 n $/gm)];
    expect(entryMatches.length).toBeGreaterThanOrEqual(10);
    entryMatches.forEach((m, idx) => {
      const objId = idx + 1;
      const offset = Number(m[1]);
      expect(pdfLatin1.slice(offset, offset + `${objId} 0 obj`.length)).toBe(
        `${objId} 0 obj`,
      );
    });

    // Verify chunked Base64 helper round-trips accurately
    const b64 = uint8ArrayToBase64(pdfBytes);
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(pdfBytes));
  });
});
