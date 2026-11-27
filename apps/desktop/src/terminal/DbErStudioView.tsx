import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { Theme } from '../app/app-storage';
import {
  buildConnectionInput,
  buildFederatedJoinSql,
  buildTablePythonSnippet,
  buildTableRSnippet,
  buildTableSelectSql,
  formatEstimatedRows,
} from './db-connection-utils';
import {
  exportErToDbml,
  exportErToJson,
  exportErToMarkdownDictionary,
  exportErToMermaid,
  exportErToSql,
  exportErToStandaloneSvg,
  parseErImportText,
} from './db-er-codec';
import { utf8ToBase64 } from './db-er-export';
import { DbErExportModal } from './DbErExportModal';
import {
  applyErLayoutOverlay,
  buildErSchemaBase,
  buildRelationDuckDbSql,
  buildRelationJoinSql,
  buildRelationPythonSnippet,
  buildRelationRSnippet,
} from './db-er-infer';
import { autoLayoutErDiagram } from './db-er-layout';
import {
  DATALAB_ER_OVERLAY_EVENT,
  ER_NOTE_COLORS,
  ER_SCHEMA_PALETTE,
  loadErOverlay,
  makeErEntityId,
  OFFLINE_ER_CONNECTION_ID,
  saveErOverlay,
  type DbErOverlay,
  type ErCanvasNote,
  type ErCardinality,
  type ErRelation,
  type ErSubjectArea,
  type ErTable,
  type ErViewport,
} from './db-er-model';
import { DbErCanvas } from './DbErCanvas';
import { DbErSidebar, type ErSidebarTab } from './DbErSidebar';
import { terminalApi, type DataDbTableProfile } from './terminal-api';
import {
  formatFileSizeCompact,
  type DataLabDbConnection,
  type DataLabMountedFile,
} from './terminal-codelab-model';
import type {
  TerminalCodeLabLanguage,
  TerminalTab,
  TerminalWorkspaceBridge,
} from './terminal-types';
import './db-er-studio.css';

export interface DbErStudioViewProps {
  tab: TerminalTab;
  theme: Theme;
  active: boolean;
  style?: CSSProperties;
  bridge?: TerminalWorkspaceBridge;
  dbConnections: DataLabDbConnection[];
  mountedFiles: DataLabMountedFile[];
  preferredPythonRuntime?: string | null;
  onUpdateDbConnections: (next: DataLabDbConnection[]) => void;
  onChangeTabConnection?: (
    tabId: string,
    connectionId: string,
    title: string,
  ) => void;
  onInsertDataCell: (
    language: TerminalCodeLabLanguage,
    source: string,
    autoRun: boolean,
    sqlConnectionId?: string,
    sqlAttachDbIds?: string[],
  ) => void;
  onFocusPane?: () => void;
  onNotify?: (message: string) => void;
}

type ExportFormatId =
  | 'pg-sql'
  | 'mysql-sql'
  | 'sqlite-sql'
  | 'dbml'
  | 'mermaid'
  | 'markdown'
  | 'svg'
  | 'json';

const MAX_UNDO_STACK = 40;

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveTextFileNativeOrBrowser(
  filename: string,
  ext: string,
  content: string,
  mime: string,
): Promise<{ saved: boolean; path?: string }> {
  const isTauri =
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ??
      (window as unknown as Record<string, unknown>).__TAURI__,
    );
  if (isTauri) {
    const selected = await saveDialog({
      title: `保存 .${ext} 导出文件`,
      defaultPath: filename,
      filters: [{ name: `${ext.toUpperCase()} 文件`, extensions: [ext] }],
    });
    if (typeof selected !== 'string' || !selected.trim()) {
      return { saved: false };
    }
    const targetPath = selected.toLowerCase().endsWith(`.${ext}`)
      ? selected
      : `${selected}.${ext}`;
    await terminalApi.writeErExport({
      filePath: targetPath,
      dataBase64: utf8ToBase64(content),
    });
    return { saved: true, path: targetPath };
  }
  downloadTextFile(filename, content, mime);
  return { saved: true, path: filename };
}

export function DbErStudioView({
  tab,
  theme,
  active,
  style,
  bridge,
  dbConnections,
  mountedFiles,
  preferredPythonRuntime,
  onUpdateDbConnections,
  onChangeTabConnection,
  onInsertDataCell,
  onFocusPane,
  onNotify,
}: DbErStudioViewProps) {
  const initialConnId =
    tab.erConnectionId || dbConnections[0]?.id || OFFLINE_ER_CONNECTION_ID;

  const [connId, setConnId] = useState<string>(initialConnId);
  const [overlay, setOverlay] = useState<DbErOverlay>(() =>
    loadErOverlay(initialConnId),
  );
  const [viewport, setViewport] = useState<ErViewport>(
    () => loadErOverlay(initialConnId).viewport,
  );
  const [undoStack, setUndoStack] = useState<DbErOverlay[]>([]);
  const [redoStack, setRedoStack] = useState<DbErOverlay[]>([]);

  // Per-table object cache preserving referential equality for React.memo cards across moves
  const tableCacheRef = useRef<Map<string, ErTable>>(new Map());
  const pendingSaveTimerRef = useRef<number | null>(null);
  const latestOverlayRef = useRef(overlay);
  latestOverlayRef.current = overlay;
  const latestViewportRef = useRef(viewport);
  latestViewportRef.current = viewport;

  const [sidebarTab, setSidebarTab] = useState<ErSidebarTab>('tables');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [presentationMode, setPresentationMode] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(
    null,
  );
  const [syncingSchema, setSyncingSchema] = useState(false);

  // Live pg_stats Profiler Drawer state
  const [profilerTableId, setProfilerTableId] = useState<string | null>(null);
  const [profilesByTableId, setProfilesByTableId] = useState<
    Record<string, DataDbTableProfile>
  >({});
  const [profilingLoading, setProfilingLoading] = useState(false);
  const [profilerError, setProfilerError] = useState('');

  // Import / Export Modals
  const [codecModal, setCodecModal] = useState<'import' | 'export' | null>(
    null,
  );
  const [visualExportOpen, setVisualExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormatId>('pg-sql');
  const [importText, setImportText] = useState('');
  const [savingKb, setSavingKb] = useState(false);

  const preferredPy =
    preferredPythonRuntime && preferredPythonRuntime !== 'pyodide'
      ? preferredPythonRuntime
      : null;

  const activeConnection = useMemo(
    () =>
      connId === OFFLINE_ER_CONNECTION_ID
        ? null
        : (dbConnections.find((c) => c.id === connId) ?? null),
    [connId, dbConnections],
  );

  // Reload overlay when switching connectionId
  useEffect(() => {
    const loaded = loadErOverlay(connId);
    tableCacheRef.current.clear();
    setOverlay(loaded);
    setViewport(loaded.viewport);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedTableId(null);
    setSelectedRelationId(null);
    setProfilerTableId(null);
    setProfilesByTableId({});
  }, [connId]);

  // Listen for live external overlay mutations (e.g. Agent calling datalab_er_annotate!)
  const selfSavingRef = useRef(false);
  useEffect(() => {
    const onOverlayChanged = (event: Event) => {
      if (selfSavingRef.current) return;
      const custom = event as CustomEvent<{ connectionId?: string }>;
      if (
        custom.detail?.connectionId &&
        custom.detail.connectionId !== connId
      ) {
        return;
      }
      setOverlay(loadErOverlay(connId));
    };
    window.addEventListener(DATALAB_ER_OVERLAY_EVENT, onOverlayChanged);
    return () =>
      window.removeEventListener(DATALAB_ER_OVERLAY_EVENT, onOverlayChanged);
  }, [connId]);

  // Debounced localStorage persistence (never blocks drag/pan frames with sync disk I/O!)
  const flushOverlayToStorage = useCallback(() => {
    if (pendingSaveTimerRef.current !== null) {
      window.clearTimeout(pendingSaveTimerRef.current);
      pendingSaveTimerRef.current = null;
    }
    selfSavingRef.current = true;
    try {
      saveErOverlay({
        ...latestOverlayRef.current,
        viewport: latestViewportRef.current,
      });
    } finally {
      selfSavingRef.current = false;
    }
  }, []);

  const scheduleOverlaySave = useCallback(() => {
    if (pendingSaveTimerRef.current !== null) {
      window.clearTimeout(pendingSaveTimerRef.current);
    }
    pendingSaveTimerRef.current = window.setTimeout(() => {
      pendingSaveTimerRef.current = null;
      flushOverlayToStorage();
    }, 300);
  }, [flushOverlayToStorage]);

  useEffect(() => {
    return () => {
      if (pendingSaveTimerRef.current !== null) {
        flushOverlayToStorage();
      }
    };
  }, [flushOverlayToStorage]);

  const persistOverlay = useCallback(
    (next: DbErOverlay, recordUndo = true) => {
      if (recordUndo) {
        setUndoStack((prev) => [
          ...prev.slice(-(MAX_UNDO_STACK - 1)),
          latestOverlayRef.current,
        ]);
        setRedoStack([]);
      }
      latestOverlayRef.current = next;
      setOverlay(next);
      scheduleOverlaySave();
    },
    [scheduleOverlaySave],
  );

  const mutateOverlay = useCallback(
    (updater: (prev: DbErOverlay) => DbErOverlay, recordUndo = true) => {
      const next = updater(latestOverlayRef.current);
      persistOverlay(next, recordUndo);
    },
    [persistOverlay],
  );

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s, latestOverlayRef.current]);
    latestOverlayRef.current = prev;
    setOverlay(prev);
    scheduleOverlaySave();
  }, [scheduleOverlaySave, undoStack]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s, latestOverlayRef.current]);
    latestOverlayRef.current = next;
    setOverlay(next);
    scheduleOverlaySave();
  }, [redoStack, scheduleOverlaySave]);

  // Keyboard shortcuts (Ctrl+Z / Ctrl+Y / Escape exits presentation mode)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (e.key === 'Escape' && presentationMode) {
        setPresentationMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, handleRedo, handleUndo, presentationMode]);

  // Stage 1 Memo: Schema + Inference + Issues (NEVER recomputed on table drag, pan, or zoom!)
  const schemaBase = useMemo(
    () =>
      buildErSchemaBase({
        connection: activeConnection,
        connectionId: overlay.connectionId,
        liveTables: activeConnection?.tables ?? [],
        liveTypes: activeConnection?.customTypes ?? [],
        mountedFiles,
        pinnedLocalFiles: overlay.pinnedLocalFiles,
        logicalRelations: overlay.logicalRelations,
        dismissedInferredIds: overlay.dismissedInferredIds,
        showInferred: overlay.showInferred,
        offlineTitle: overlay.offlineTitle,
        offlineDialect: overlay.offlineDialect,
        offlineTables: overlay.offlineTables,
        offlineTypes: overlay.offlineTypes,
        profilesByTableId,
      }),
    [
      activeConnection,
      mountedFiles,
      overlay.connectionId,
      overlay.dismissedInferredIds,
      overlay.logicalRelations,
      overlay.offlineDialect,
      overlay.offlineTables,
      overlay.offlineTitle,
      overlay.offlineTypes,
      overlay.pinnedLocalFiles,
      overlay.showInferred,
      profilesByTableId,
    ],
  );

  // Stage 2 Memo: Lightweight coordinate/alias overlay preserving untouched table refs
  const diagram = useMemo(
    () =>
      applyErLayoutOverlay(
        schemaBase,
        overlay,
        latestViewportRef.current,
        tableCacheRef.current,
      ),
    [overlay, schemaBase],
  );

  // Sync live DB metadata (tables + indexes + FK rules + PG custom types)
  const handleSyncLiveSchema = useCallback(async () => {
    if (!activeConnection) return;
    setSyncingSchema(true);
    try {
      const res = await terminalApi.testDbConnection({
        connection: buildConnectionInput(activeConnection, preferredPy),
      });
      if (!res.ok) {
        onNotify?.(res.message || '同步实库结构失败');
        return;
      }
      onUpdateDbConnections(
        dbConnections.map((c) =>
          c.id === activeConnection.id
            ? {
                ...c,
                tables: res.tables,
                customTypes: res.customTypes ?? [],
                lastTestedAt: Date.now(),
                lastStatus: `已连接 · ${res.engine}`,
              }
            : c,
        ),
      );
      onNotify?.(
        `已同步 ${activeConnection.name}：${res.tables.length} 张表/视图${res.customTypes?.length ? ` · ${res.customTypes.length} 个自定义类型` : ''}（已保留所有本地排版与批注）`,
      );
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingSchema(false);
    }
  }, [
    activeConnection,
    dbConnections,
    onNotify,
    onUpdateDbConnections,
    preferredPy,
  ]);

  // Auto-sync once on open if connection has 0 cached tables
  const autoSyncedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (
      active &&
      activeConnection &&
      (!activeConnection.tables || activeConnection.tables.length === 0) &&
      !autoSyncedRef.current.has(activeConnection.id)
    ) {
      autoSyncedRef.current.add(activeConnection.id);
      void handleSyncLiveSchema();
    }
  }, [active, activeConnection, handleSyncLiveSchema]);

  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;
  const profilesByTableIdRef = useRef(profilesByTableId);
  profilesByTableIdRef.current = profilesByTableId;

  // Live pg_stats Profiler Drawer loader (stable identity via refs)
  const handleOpenProfiler = useCallback(
    async (tableId: string) => {
      setSelectedTableId(tableId);
      setProfilerTableId(tableId);
      setProfilerError('');
      if (!activeConnection) return;
      const tbl = diagramRef.current.tables.find((t) => t.id === tableId);
      if (!tbl || tbl.sourceKind !== 'live' || tbl.missingInLive) return;
      if (profilesByTableIdRef.current[tableId]) return;

      setProfilingLoading(true);
      try {
        const res = await terminalApi.profileTable({
          connection: buildConnectionInput(activeConnection, preferredPy),
          schema: tbl.schema ?? null,
          tableName: tbl.name,
          sampleRows: 5,
        });
        if (!res.ok) {
          setProfilerError(res.error || '实库剖析失败');
        } else {
          setProfilesByTableId((prev) => ({ ...prev, [tableId]: res }));
        }
      } catch (err) {
        setProfilerError(err instanceof Error ? err.message : String(err));
      } finally {
        setProfilingLoading(false);
      }
    },
    [activeConnection, preferredPy],
  );

  const handleViewportChange = useCallback(
    (vp: ErViewport) => {
      latestViewportRef.current = vp;
      setViewport(vp);
      scheduleOverlaySave();
    },
    [scheduleOverlaySave],
  );

  const handleCommitTablePosition = useCallback(
    (tableId: string, x: number, y: number) => {
      mutateOverlay((prev) => ({
        ...prev,
        tableLayouts: {
          ...prev.tableLayouts,
          [tableId]: {
            ...prev.tableLayouts[tableId],
            x,
            y,
          },
        },
      }));
    },
    [mutateOverlay],
  );

  const handleAutoLayout = useCallback(() => {
    const auto = autoLayoutErDiagram(
      diagramRef.current.tables,
      diagramRef.current.relations,
    );
    mutateOverlay((prev) => {
      const nextLayouts = { ...prev.tableLayouts };
      for (const [id, pos] of Object.entries(auto.positions)) {
        nextLayouts[id] = {
          ...nextLayouts[id],
          x: pos.x,
          y: pos.y,
        };
      }
      return {
        ...prev,
        tableLayouts: nextLayouts,
        subjectAreas: auto.subjectAreas,
      };
    });
    onNotify?.('已按 Schema 分区自动重新排版');
  }, [mutateOverlay, onNotify]);

  const handleCreateLogicalRelation = useCallback(
    (
      sourceTableId: string,
      sourceColumn: string,
      targetTableId: string,
      targetColumn: string,
      cardinality: ErCardinality = 'N:1',
    ) => {
      const newRel: ErRelation = {
        id: makeErEntityId('logrel'),
        sourceTableId,
        sourceColumn,
        targetTableId,
        targetColumn,
        cardinality,
        kind: 'logical',
      };
      mutateOverlay((prev) => ({
        ...prev,
        logicalRelations: [...prev.logicalRelations, newRel],
      }));
      setSelectedRelationId(newRel.id);
      onNotify?.(
        `已创建逻辑关联：${sourceTableId}.${sourceColumn} → ${targetTableId}.${targetColumn}`,
      );
    },
    [mutateOverlay, onNotify],
  );

  const handleAcceptInferred = useCallback(
    (rel: ErRelation) => {
      const promoted: ErRelation = {
        ...rel,
        id: makeErEntityId('logrel'),
        kind: 'logical',
        note: rel.reason,
      };
      mutateOverlay((prev) => ({
        ...prev,
        logicalRelations: [...prev.logicalRelations, promoted],
      }));
      setSelectedRelationId(promoted.id);
      onNotify?.('已采纳为正式逻辑关联（将写入导出与 Agent 上下文）');
    },
    [mutateOverlay, onNotify],
  );

  const handleDismissInferred = useCallback(
    (relId: string) => {
      mutateOverlay((prev) => ({
        ...prev,
        dismissedInferredIds: Array.from(
          new Set([...prev.dismissedInferredIds, relId]),
        ),
      }));
    },
    [mutateOverlay],
  );

  const handleGenerateRelationCode = useCallback(
    (rel: ErRelation, kind: 'sql' | 'python' | 'r' | 'duckdb') => {
      const src = diagramRef.current.tables.find(
        (t) => t.id === rel.sourceTableId,
      );
      const tgt = diagramRef.current.tables.find(
        (t) => t.id === rel.targetTableId,
      );
      if (!src || !tgt) return;
      if (kind === 'sql') {
        const res = buildRelationJoinSql(rel, src, tgt, activeConnection, 100);
        onInsertDataCell(
          'sql',
          res.sql,
          false,
          res.useDuckDbFederation ? '' : activeConnection?.id,
          res.attachDbIds,
        );
        onNotify?.('已向实验本插入可执行 JOIN SQL 代码格');
      } else if (kind === 'duckdb') {
        const sql = buildRelationDuckDbSql(
          rel,
          src,
          tgt,
          activeConnection,
          100,
        );
        onInsertDataCell(
          'sql',
          sql,
          false,
          '',
          activeConnection ? [activeConnection.id] : undefined,
        );
        onNotify?.('已向实验本插入 DuckDB 联邦只读 JOIN 查询格');
      } else if (kind === 'python') {
        const code = buildRelationPythonSnippet(
          rel,
          src,
          tgt,
          activeConnection,
          10000,
        );
        onInsertDataCell('python', code, false);
        onNotify?.('已向实验本插入 Python 关联取数格');
      } else {
        const code = buildRelationRSnippet(
          rel,
          src,
          tgt,
          activeConnection,
          10000,
        );
        onInsertDataCell('r', code, false);
        onNotify?.('已向实验本插入 R 关联取数格');
      }
    },
    [activeConnection, onInsertDataCell, onNotify],
  );

  const handleQuickSqlForTable = useCallback(
    (tableId: string) => {
      const curDiagram = diagramRef.current;
      const tbl = curDiagram.tables.find((t) => t.id === tableId);
      if (!tbl) return;
      if (tbl.sourceKind === 'local-file') {
        onInsertDataCell(
          'sql',
          `SELECT *\nFROM "${tbl.mountedFileAlias || tbl.name}"\nLIMIT 100;`,
          true,
          '',
        );
        return;
      }
      onInsertDataCell(
        'sql',
        buildTableSelectSql(tbl.name, tbl.schema, curDiagram.dbType, 100),
        true,
        activeConnection?.id,
      );
      onNotify?.(`已向实验本插入 ${tbl.id} 预览 SQL`);
    },
    [activeConnection?.id, onInsertDataCell, onNotify],
  );

  const handleToggleCollapseTable = useCallback(
    (tableId: string) => {
      const curr = diagramRef.current.tables.find((t) => t.id === tableId);
      mutateOverlay((prev) => {
        const existing = prev.tableLayouts[tableId];
        return {
          ...prev,
          tableLayouts: {
            ...prev.tableLayouts,
            [tableId]: {
              ...existing,
              x: existing?.x ?? curr?.x ?? 80,
              y: existing?.y ?? curr?.y ?? 80,
              collapsed: !curr?.collapsed,
            },
          },
        };
      });
    },
    [mutateOverlay],
  );

  const handleOpenProfilerSync = useCallback(
    (id: string) => {
      void handleOpenProfiler(id);
    },
    [handleOpenProfiler],
  );

  const handleUpdateLogicalRelation = useCallback(
    (
      relId: string,
      patch: Partial<Pick<ErRelation, 'cardinality' | 'note'>>,
    ) => {
      mutateOverlay(
        (prev) => ({
          ...prev,
          logicalRelations: prev.logicalRelations.map((r) =>
            r.id === relId ? { ...r, ...patch } : r,
          ),
        }),
        false,
      );
    },
    [mutateOverlay],
  );

  const handleDeleteLogicalRelation = useCallback(
    (relId: string) => {
      mutateOverlay((prev) => ({
        ...prev,
        logicalRelations: prev.logicalRelations.filter((r) => r.id !== relId),
      }));
    },
    [mutateOverlay],
  );

  const handleUpdateArea = useCallback(
    (areaId: string, patch: Partial<ErSubjectArea>) => {
      mutateOverlay(
        (prev) => ({
          ...prev,
          subjectAreas: (prev.subjectAreas.length > 0
            ? prev.subjectAreas
            : diagramRef.current.subjectAreas
          ).map((a) => (a.id === areaId ? { ...a, ...patch } : a)),
        }),
        false,
      );
    },
    [mutateOverlay],
  );

  const handleUpdateNote = useCallback(
    (noteId: string, patch: Partial<ErCanvasNote>) => {
      mutateOverlay(
        (prev) => ({
          ...prev,
          notes: prev.notes.map((n) =>
            n.id === noteId ? { ...n, ...patch } : n,
          ),
        }),
        false,
      );
    },
    [mutateOverlay],
  );

  const handleDeleteNote = useCallback(
    (noteId: string) => {
      mutateOverlay((prev) => ({
        ...prev,
        notes: prev.notes.filter((n) => n.id !== noteId),
      }));
    },
    [mutateOverlay],
  );

  const handleTogglePresentation = useCallback(() => {
    setPresentationMode((v) => !v);
  }, []);

  const panToWorldPoint = useCallback(
    (wx: number, wy: number) => {
      const z = latestViewportRef.current.zoom;
      handleViewportChange({
        x: Math.round(420 - wx * z),
        y: Math.round(280 - wy * z),
        zoom: z,
      });
    },
    [handleViewportChange],
  );

  // Export preview text computed on demand when modal is open
  const exportPreviewText = useMemo(() => {
    if (codecModal !== 'export') return '';
    const isDarkTheme =
      theme === 'dark' || theme === 'navy' || theme === 'purple';
    switch (exportFormat) {
      case 'pg-sql':
        return exportErToSql(diagram, 'postgres');
      case 'mysql-sql':
        return exportErToSql(diagram, 'mysql');
      case 'sqlite-sql':
        return exportErToSql(diagram, 'sqlite');
      case 'dbml':
        return exportErToDbml(diagram);
      case 'mermaid':
        return exportErToMermaid(diagram);
      case 'markdown':
        return exportErToMarkdownDictionary(diagram, activeConnection);
      case 'svg':
        return exportErToStandaloneSvg(diagram, isDarkTheme ? 'dark' : 'light');
      case 'json':
        return exportErToJson(diagram, overlay);
    }
  }, [activeConnection, codecModal, diagram, exportFormat, overlay, theme]);

  const handleImportSubmit = () => {
    const parsed = parseErImportText(importText);
    if (parsed.tables.length === 0) {
      onNotify?.(
        parsed.warnings[0] ||
          '未能解析出有效表结构，请检查 SQL DDL 或 DBML 语法。',
      );
      return;
    }
    const targetConnId = OFFLINE_ER_CONNECTION_ID;
    const baseOverlay = loadErOverlay(targetConnId);
    const nextOverlay: DbErOverlay = {
      ...baseOverlay,
      ...(parsed.overlayPatch ?? {}),
      connectionId: targetConnId,
      offlineTitle:
        parsed.title ||
        `导入模型 (${parsed.format.toUpperCase()} · ${parsed.tables.length} 表)`,
      offlineDialect: 'postgres',
      offlineTables: parsed.tables,
      offlineTypes: parsed.customTypes,
      tableLayouts: parsed.overlayPatch?.tableLayouts ?? {},
      subjectAreas: parsed.overlayPatch?.subjectAreas ?? [],
    };
    saveErOverlay(nextOverlay);
    setConnId(targetConnId);
    setOverlay(nextOverlay);
    onChangeTabConnection?.(
      tab.id,
      targetConnId,
      `ER · ${nextOverlay.offlineTitle}`,
    );
    setCodecModal(null);
    setImportText('');
    onNotify?.(
      `已解析 ${parsed.format.toUpperCase()}：共 ${parsed.tables.length} 张表${parsed.customTypes.length ? `、${parsed.customTypes.length} 个自定义类型` : ''}`,
    );
  };

  const handleSaveDictionaryToKb = async () => {
    if (!bridge?.onSaveMarkdownNote) {
      onNotify?.('当前窗口未挂载知识库写入桥接，请改用复制或下载 Markdown。');
      return;
    }
    setSavingKb(true);
    try {
      const md = exportErToMarkdownDictionary(diagram, activeConnection);
      const ok = await bridge.onSaveMarkdownNote({
        title: `数据库字典-${diagram.title.replace(/[\\/:*?"<>|]/g, '_')}`,
        category: '数据研究',
        source: md,
      });
      onNotify?.(
        ok
          ? '已一键保存为 Seamind 知识库 Markdown 数据字典（含 Mermaid ER 图）！'
          : '保存知识库文档失败。',
      );
    } finally {
      setSavingKb(false);
    }
  };

  const profiledTable = profilerTableId
    ? (diagram.tables.find((t) => t.id === profilerTableId) ?? null)
    : null;
  const activeProfile = profilerTableId
    ? (profilesByTableId[profilerTableId] ?? null)
    : null;
  const firstMountedAlias = mountedFiles[0]?.alias;

  return (
    <div
      className={`er-studio-root${active ? '' : ' is-hidden'}`}
      style={style}
      onMouseDown={() => onFocusPane?.()}
    >
      {/* Top Studio Toolbar */}
      <header className="er-toolbar">
        <div className="er-toolbar-group">
          <button
            type="button"
            className={`er-tool-btn${sidebarOpen && !presentationMode ? ' is-active' : ''}`}
            onClick={() => {
              setPresentationMode(false);
              setSidebarOpen((v) => !v);
            }}
            title="展开/收起左侧建模与体检栏"
          >
            侧栏
          </button>

          <select
            className="er-db-select"
            value={connId}
            onChange={(e) => {
              const nextId = e.target.value;
              setConnId(nextId);
              const nextConn = dbConnections.find((c) => c.id === nextId);
              onChangeTabConnection?.(
                tab.id,
                nextId,
                nextConn
                  ? `ER · ${nextConn.database || nextConn.name}`
                  : 'ER · 离线建模草图',
              );
            }}
            aria-label="切换 ER 图谱数据源"
          >
            {dbConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.database ? ` (${c.database})` : ''}
              </option>
            ))}
            <option value={OFFLINE_ER_CONNECTION_ID}>
              离线 SQL / DBML 建模草图
            </option>
          </select>

          {activeConnection ? (
            <span className="er-mode-pill is-ro">
              {(activeConnection.readOnly ?? true) ? '实库只读' : '实库读写'}
            </span>
          ) : (
            <span className="er-mode-pill is-offline">离线草图</span>
          )}

          {activeConnection && (
            <button
              type="button"
              className="er-tool-btn is-primary"
              disabled={syncingSchema}
              onClick={() => void handleSyncLiveSchema()}
              title="重新读取实库多 Schema、主键、外键、索引与自定义类型，保留所有本地排版与批注"
            >
              {syncingSchema ? '同步中…' : '同步实库结构'}
            </button>
          )}
        </div>

        <div className="er-toolbar-group">
          <span className="er-toolbar-stat">
            {diagram.tables.length} 表 · {diagram.relations.length} 关系 ·{' '}
            {diagram.issues.length} 体检
          </span>
          <span className="er-toolbar-sep" />

          <button
            type="button"
            className="er-tool-btn"
            onClick={() =>
              mutateOverlay(
                (prev) => ({
                  ...prev,
                  routing:
                    prev.routing === 'orthogonal' ? 'bezier' : 'orthogonal',
                }),
                false,
              )
            }
            title="切换连线路径风格"
          >
            {overlay.routing === 'orthogonal' ? '正交折线' : '平滑曲线'}
          </button>

          <button
            type="button"
            className={`er-tool-btn${overlay.showInferred ? ' is-active' : ''}`}
            onClick={() =>
              mutateOverlay(
                (prev) => ({ ...prev, showInferred: !prev.showInferred }),
                false,
              )
            }
            title="开关无物理外键时的智能逻辑关联推断虚线"
          >
            推断虚线
          </button>

          <button
            type="button"
            className={`er-tool-btn${overlay.snapToGrid ? ' is-active' : ''}`}
            onClick={() =>
              mutateOverlay(
                (prev) => ({ ...prev, snapToGrid: !prev.snapToGrid }),
                false,
              )
            }
            title="拖拽对齐参考线与网格吸附"
          >
            网格吸附
          </button>

          <span className="er-toolbar-sep" />

          <button
            type="button"
            className="er-tool-btn"
            disabled={undoStack.length === 0}
            onClick={handleUndo}
            title="撤销 (Ctrl+Z)"
          >
            撤销
          </button>
          <button
            type="button"
            className="er-tool-btn"
            disabled={redoStack.length === 0}
            onClick={handleRedo}
            title="重做 (Ctrl+Y)"
          >
            重做
          </button>

          <span className="er-toolbar-sep" />

          <button
            type="button"
            className="er-tool-btn"
            onClick={() => setCodecModal('import')}
            title="粘贴 PostgreSQL / MySQL / SQLite DDL、DBML 或 JSON 快照生成 ER 图"
          >
            导入 SQL/DBML
          </button>
          <button
            type="button"
            className="er-tool-btn is-primary"
            disabled={diagram.tables.length === 0}
            onClick={() => setVisualExportOpen(true)}
            title="导出超清像素 PNG 图片 / 无损 PDF 文档 / 纯矢量 SVG，并自选保存位置"
          >
            导出图表 (PNG/PDF)
          </button>
          <button
            type="button"
            className="er-tool-btn is-active"
            onClick={() => setCodecModal('export')}
            title="导出 DDL / DBML / Mermaid / 知识库数据字典"
          >
            导出代码 / 知识库
          </button>
        </div>
      </header>

      {/* Main 3-Pane Workspace */}
      <div className="er-studio-body">
        {sidebarOpen && !presentationMode && (
          <DbErSidebar
            diagram={diagram}
            activeTab={sidebarTab}
            selectedTableId={selectedTableId}
            selectedRelationId={selectedRelationId}
            mountedFiles={mountedFiles}
            pinnedLocalFiles={overlay.pinnedLocalFiles}
            onChangeTab={setSidebarTab}
            onFocusTable={(id) => {
              setSelectedTableId(id);
              setSelectedRelationId(null);
              const t = diagram.tables.find((x) => x.id === id);
              if (t) panToWorldPoint(t.x + t.width / 2, t.y + 80);
            }}
            onFocusRelation={(id) => {
              setSelectedRelationId(id);
              setSelectedTableId(null);
              const r = diagram.relations.find((x) => x.id === id);
              if (r) {
                const src = diagram.tables.find(
                  (t) => t.id === r.sourceTableId,
                );
                if (src) panToWorldPoint(src.x + src.width / 2, src.y + 80);
              }
            }}
            onFocusArea={(a) => panToWorldPoint(a.x + a.width / 2, a.y + 120)}
            onFocusNote={(n) => panToWorldPoint(n.x + n.width / 2, n.y + 80)}
            onUpdateTableMeta={(tableId, patch) => {
              const curr = diagram.tables.find((t) => t.id === tableId);
              mutateOverlay((prev) => {
                const existing = prev.tableLayouts[tableId];
                return {
                  ...prev,
                  tableLayouts: {
                    ...prev.tableLayouts,
                    [tableId]: {
                      ...existing,
                      x: existing?.x ?? curr?.x ?? 80,
                      y: existing?.y ?? curr?.y ?? 80,
                      ...patch,
                    },
                  },
                };
              });
            }}
            onUpdateColumnNote={(tableId, columnName, note) => {
              mutateOverlay((prev) => {
                const nextNotes = { ...prev.columnNotes };
                const k = `${tableId}.${columnName}`;
                if (note.trim()) nextNotes[k] = note;
                else delete nextNotes[k];
                return { ...prev, columnNotes: nextNotes };
              }, false);
            }}
            onTogglePinLocalFile={(alias) => {
              mutateOverlay((prev) => {
                const has = prev.pinnedLocalFiles.includes(alias);
                return {
                  ...prev,
                  pinnedLocalFiles: has
                    ? prev.pinnedLocalFiles.filter((a) => a !== alias)
                    : [...prev.pinnedLocalFiles, alias],
                };
              });
            }}
            onCreateLogicalRelation={handleCreateLogicalRelation}
            onAcceptInferred={handleAcceptInferred}
            onDismissInferred={handleDismissInferred}
            onDeleteLogicalRelation={(relId) => {
              mutateOverlay((prev) => ({
                ...prev,
                logicalRelations: prev.logicalRelations.filter(
                  (r) => r.id !== relId,
                ),
              }));
            }}
            onGenerateRelationCode={handleGenerateRelationCode}
            onAddArea={() => {
              const vp = latestViewportRef.current;
              const area: ErSubjectArea = {
                id: makeErEntityId('area'),
                name: `研究分区 ${diagram.subjectAreas.length + 1}`,
                x: Math.round((-vp.x + 80) / vp.zoom),
                y: Math.round((-vp.y + 80) / vp.zoom),
                width: 460,
                height: 320,
                color:
                  ER_SCHEMA_PALETTE[
                    diagram.subjectAreas.length % ER_SCHEMA_PALETTE.length
                  ],
              };
              mutateOverlay((prev) => ({
                ...prev,
                subjectAreas: [...prev.subjectAreas, area],
              }));
            }}
            onUpdateArea={(areaId, patch) => {
              mutateOverlay(
                (prev) => ({
                  ...prev,
                  subjectAreas: (prev.subjectAreas.length > 0
                    ? prev.subjectAreas
                    : diagram.subjectAreas
                  ).map((a) => (a.id === areaId ? { ...a, ...patch } : a)),
                }),
                false,
              );
            }}
            onDeleteArea={(areaId) => {
              mutateOverlay((prev) => ({
                ...prev,
                subjectAreas: (prev.subjectAreas.length > 0
                  ? prev.subjectAreas
                  : diagram.subjectAreas
                ).filter((a) => a.id !== areaId),
              }));
            }}
            onAddNote={() => {
              const vp = latestViewportRef.current;
              const note: ErCanvasNote = {
                id: makeErEntityId('note'),
                title: '研究便签',
                content: '',
                x: Math.round((-vp.x + 120) / vp.zoom),
                y: Math.round((-vp.y + 120) / vp.zoom),
                width: 236,
                height: 128,
                color:
                  ER_NOTE_COLORS[diagram.notes.length % ER_NOTE_COLORS.length],
              };
              mutateOverlay((prev) => ({
                ...prev,
                notes: [...prev.notes, note],
              }));
            }}
            onUpdateNote={(noteId, patch) => {
              mutateOverlay(
                (prev) => ({
                  ...prev,
                  notes: prev.notes.map((n) =>
                    n.id === noteId ? { ...n, ...patch } : n,
                  ),
                }),
                false,
              );
            }}
            onDeleteNote={(noteId) => {
              mutateOverlay((prev) => ({
                ...prev,
                notes: prev.notes.filter((n) => n.id !== noteId),
              }));
            }}
            onOpenProfiler={(id) => void handleOpenProfiler(id)}
          />
        )}

        <DbErCanvas
          diagram={diagram}
          viewport={viewport}
          selectedTableId={selectedTableId}
          selectedRelationId={selectedRelationId}
          presentationMode={presentationMode}
          onSelectTable={setSelectedTableId}
          onSelectRelation={setSelectedRelationId}
          onViewportChange={handleViewportChange}
          onCommitTablePosition={handleCommitTablePosition}
          onToggleCollapseTable={handleToggleCollapseTable}
          onOpenProfiler={handleOpenProfilerSync}
          onQuickSql={handleQuickSqlForTable}
          onCreateLogicalRelation={handleCreateLogicalRelation}
          onAcceptInferredRelation={handleAcceptInferred}
          onDismissInferredRelation={handleDismissInferred}
          onUpdateLogicalRelation={handleUpdateLogicalRelation}
          onDeleteLogicalRelation={handleDeleteLogicalRelation}
          onGenerateRelationCode={handleGenerateRelationCode}
          onUpdateArea={handleUpdateArea}
          onUpdateNote={handleUpdateNote}
          onDeleteNote={handleDeleteNote}
          onAutoLayout={handleAutoLayout}
          onTogglePresentation={handleTogglePresentation}
        />

        {/* Right Live pg_stats Profiler Drawer */}
        {profiledTable && !presentationMode && (
          <aside className="er-inspector-drawer" aria-label="实库统计剖析抽屉">
            <div className="er-inspector-head">
              <strong title={profiledTable.id}>
                剖析 · {profiledTable.id}
              </strong>
              <button
                type="button"
                className="er-edge-popover-close"
                onClick={() => setProfilerTableId(null)}
                aria-label="关闭剖析抽屉"
              >
                ×
              </button>
            </div>
            <div className="er-inspector-body">
              <div className="er-inspector-metrics">
                <div className="er-metric-box">
                  <span className="er-metric-label">估算行数</span>
                  <span className="er-metric-val">
                    {formatEstimatedRows(
                      activeProfile?.estimatedRows ??
                        profiledTable.estimatedRows,
                    ) || '—'}
                  </span>
                </div>
                <div className="er-metric-box">
                  <span className="er-metric-label">磁盘占用</span>
                  <span className="er-metric-val">
                    {formatFileSizeCompact(
                      activeProfile?.totalBytes ??
                        profiledTable.totalBytes ??
                        undefined,
                    ) || '—'}
                  </span>
                </div>
                <div className="er-metric-box">
                  <span className="er-metric-label">字段 / 索引</span>
                  <span className="er-metric-val">
                    {profiledTable.columns.length} /{' '}
                    {activeProfile?.indexes.length ??
                      profiledTable.indexes.length}
                  </span>
                </div>
              </div>

              {activeConnection && (
                <div className="er-side-row-actions">
                  <button
                    type="button"
                    className="er-pop-btn is-accent"
                    onClick={() => handleQuickSqlForTable(profiledTable.id)}
                  >
                    SQL 预览
                  </button>
                  <button
                    type="button"
                    className="er-pop-btn"
                    onClick={() =>
                      onInsertDataCell(
                        'python',
                        buildTablePythonSnippet(
                          activeConnection,
                          profiledTable.name,
                          profiledTable.schema,
                        ),
                        false,
                      )
                    }
                  >
                    PY 直连
                  </button>
                  <button
                    type="button"
                    className="er-pop-btn"
                    onClick={() =>
                      onInsertDataCell(
                        'r',
                        buildTableRSnippet(
                          activeConnection,
                          profiledTable.name,
                          profiledTable.schema,
                        ),
                        false,
                      )
                    }
                  >
                    R 直连
                  </button>
                  {activeConnection.dbType === 'postgres' && (
                    <button
                      type="button"
                      className="er-pop-btn"
                      onClick={() =>
                        onInsertDataCell(
                          'sql',
                          buildFederatedJoinSql(
                            activeConnection,
                            profiledTable.name,
                            profiledTable.schema,
                            firstMountedAlias,
                          ),
                          false,
                          '',
                          [activeConnection.id],
                        )
                      }
                    >
                      DuckDB 联邦
                    </button>
                  )}
                </div>
              )}

              {profilingLoading && (
                <div className="er-side-card-meta">
                  正在读取 pg_stats 分布与样本行（零全表扫描）…
                </div>
              )}
              {profilerError && (
                <div className="er-issue-card is-error">
                  <div className="er-issue-detail">{profilerError}</div>
                </div>
              )}

              {activeProfile && (
                <>
                  <div className="er-side-section-head">
                    <span>
                      pg_stats 字段统计 ({activeProfile.columns.length})
                    </span>
                    <span>{activeProfile.durationMs}ms</span>
                  </div>
                  <div className="er-side-list">
                    {activeProfile.columns.map((c) => {
                      const highNull =
                        c.nullFraction != null && c.nullFraction >= 0.5;
                      return (
                        <div key={c.name} className="er-prof-col-card">
                          <div className="er-prof-col-top">
                            <strong>
                              {c.isPrimaryKey ? '[PK] ' : ''}
                              {c.name}
                            </strong>
                            <span className="er-side-card-meta">
                              {c.dataType}
                            </span>
                          </div>
                          <div className="er-prof-col-stats">
                            <span
                              className={highNull ? 'er-prof-null-high' : ''}
                            >
                              空值:{' '}
                              {c.nullFraction != null
                                ? `${(c.nullFraction * 100).toFixed(1)}%`
                                : '—'}
                            </span>
                            <span>
                              基数:{' '}
                              {c.nDistinct != null
                                ? c.nDistinct < 0
                                  ? `${Math.round(-c.nDistinct * 100)}% 唯一`
                                  : `~${Math.round(c.nDistinct).toLocaleString()}`
                                : '—'}
                            </span>
                          </div>
                          {(c.minValue || c.maxValue) && (
                            <div className="er-prof-col-stats">
                              范围: [{c.minValue ?? '…'} ~ {c.maxValue ?? '…'}]
                            </div>
                          )}
                          {c.mostCommonVals.length > 0 && (
                            <div className="er-prof-col-stats">
                              高频: {c.mostCommonVals.slice(0, 4).join(', ')}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {activeProfile.sampleColumns.length > 0 &&
                    activeProfile.sampleRows.length > 0 && (
                      <>
                        <div className="er-side-section-head">
                          <span>
                            样本预览 ({activeProfile.sampleRows.length} 行)
                          </span>
                        </div>
                        <div className="er-prof-sample-wrap">
                          <table className="er-prof-sample-table">
                            <thead>
                              <tr>
                                {activeProfile.sampleColumns.map((sc) => (
                                  <th key={sc.name}>{sc.name}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {activeProfile.sampleRows.map((row, rIdx) => (
                                <tr key={rIdx}>
                                  {activeProfile.sampleColumns.map(
                                    (_, cIdx) => (
                                      <td key={cIdx}>
                                        {row[cIdx] == null
                                          ? 'NULL'
                                          : String(row[cIdx])}
                                      </td>
                                    ),
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Import / Export Modal */}
      {codecModal && (
        <div
          className="er-codec-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCodecModal(null);
          }}
        >
          <div
            className="er-codec-modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              codecModal === 'import'
                ? '导入 SQL DDL / DBML / JSON'
                : '导出 ER 图谱与知识库数据字典'
            }
          >
            <div className="er-codec-modal-head">
              <h3>
                {codecModal === 'import'
                  ? '导入 SQL DDL / DBML / Seamind ER JSON'
                  : `导出 · ${diagram.title}`}
              </h3>
              <button
                type="button"
                className="er-edge-popover-close"
                onClick={() => setCodecModal(null)}
              >
                ×
              </button>
            </div>

            {codecModal === 'export' ? (
              <>
                <div className="er-codec-modal-tabs">
                  {(
                    [
                      ['pg-sql', 'PostgreSQL DDL'],
                      ['mysql-sql', 'MySQL DDL'],
                      ['sqlite-sql', 'SQLite DDL'],
                      ['dbml', 'DBML'],
                      ['mermaid', 'Mermaid erDiagram'],
                      ['markdown', '知识库数据字典 MD'],
                      ['svg', 'SVG 矢量图'],
                      ['json', 'JSON 快照'],
                    ] as const
                  ).map(([fmt, label]) => (
                    <button
                      key={fmt}
                      type="button"
                      className={`er-filter-pill${exportFormat === fmt ? ' is-active' : ''}`}
                      onClick={() => setExportFormat(fmt)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="er-codec-modal-body">
                  <textarea
                    className="er-codec-textarea"
                    readOnly
                    value={exportPreviewText}
                  />
                </div>
                <div className="er-codec-modal-footer">
                  <div className="er-toolbar-group">
                    <button
                      type="button"
                      className="er-tool-btn is-primary"
                      disabled={savingKb}
                      onClick={() => void handleSaveDictionaryToKb()}
                    >
                      {savingKb ? '写入中…' : '一键存入 Seamind 知识库数据字典'}
                    </button>
                    <button
                      type="button"
                      className="er-tool-btn"
                      onClick={() => {
                        setCodecModal(null);
                        setVisualExportOpen(true);
                      }}
                    >
                      导出高清 PNG / PDF…
                    </button>
                  </div>
                  <div className="er-toolbar-group">
                    <button
                      type="button"
                      className="er-tool-btn"
                      onClick={() => {
                        void navigator.clipboard.writeText(exportPreviewText);
                        onNotify?.('已复制到剪贴板');
                      }}
                    >
                      复制内容
                    </button>
                    <button
                      type="button"
                      className="er-tool-btn is-active"
                      onClick={() => {
                        const extMap: Record<ExportFormatId, [string, string]> =
                          {
                            'pg-sql': ['sql', 'text/sql;charset=utf-8'],
                            'mysql-sql': ['sql', 'text/sql;charset=utf-8'],
                            'sqlite-sql': ['sql', 'text/sql;charset=utf-8'],
                            dbml: ['dbml', 'text/plain;charset=utf-8'],
                            mermaid: ['mmd', 'text/plain;charset=utf-8'],
                            markdown: ['md', 'text/markdown;charset=utf-8'],
                            svg: ['svg', 'image/svg+xml;charset=utf-8'],
                            json: ['json', 'application/json;charset=utf-8'],
                          };
                        const [ext, mime] = extMap[exportFormat];
                        const safeName = `${diagram.title.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')}.${ext}`;
                        void saveTextFileNativeOrBrowser(
                          safeName,
                          ext,
                          exportPreviewText,
                          mime,
                        )
                          .then((res) => {
                            if (res.saved) {
                              onNotify?.(`已保存至 ${res.path ?? safeName}`);
                            }
                          })
                          .catch((err) => {
                            onNotify?.(
                              `保存失败：${err instanceof Error ? err.message : String(err)}`,
                            );
                          });
                      }}
                    >
                      另存为文件…
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="er-codec-modal-body">
                  <div className="er-side-card-meta">
                    支持粘贴 PostgreSQL / MySQL / SQLite 的{' '}
                    <code>CREATE TABLE</code> / <code>ALTER TABLE</code>、DBML{' '}
                    <code>Table</code> / <code>Ref</code> / <code>Enum</code> 或
                    Seamind ER JSON 快照（将作为离线 ER
                    草图打开，绝不改动真实数据库）。
                  </div>
                  <textarea
                    className="er-codec-textarea"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder={`例如：\nCREATE TABLE fred.series (\n  series_id text PRIMARY KEY,\n  title text NOT NULL\n);\n\nCREATE TABLE fred.observations (\n  series_id text REFERENCES fred.series(series_id),\n  observation_date date NOT NULL,\n  value numeric(20,6)\n);`}
                  />
                </div>
                <div className="er-codec-modal-footer">
                  <button
                    type="button"
                    className="er-tool-btn"
                    onClick={() => setCodecModal(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="er-tool-btn is-primary"
                    disabled={!importText.trim()}
                    onClick={handleImportSubmit}
                  >
                    解析并生成 ER 图谱
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {visualExportOpen && (
        <DbErExportModal
          diagram={diagram}
          theme={theme}
          onClose={() => setVisualExportOpen(false)}
          onNotify={onNotify}
        />
      )}
    </div>
  );
}
