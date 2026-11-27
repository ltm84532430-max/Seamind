import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  terminalApi,
  type DataDbTableSchema,
  type LocalPostgresInstance,
} from './terminal-api';
import {
  formatFileSizeCompact,
  sanitizeDataAlias,
  type DataLabDbConnection,
  type DataLabMountedFile,
} from './terminal-codelab-model';
import {
  buildConnectionInput,
  buildTableSelectSql,
} from './db-connection-utils';
import { DbConnectionModal } from './DbConnectionModal';
import { DbSchemaTree } from './DbSchemaTree';
import { DbTableProfilerModal } from './DbTableProfilerModal';
import type { TerminalCodeLabLanguage } from './terminal-types';

interface CodeLabDataPanelProps {
  mountedFiles: DataLabMountedFile[];
  dbConnections: DataLabDbConnection[];
  preferredPythonPath?: string | null;
  onUpdateFiles: (next: DataLabMountedFile[]) => void;
  onUpdateConnections: (next: DataLabDbConnection[]) => void;
  onInsertCell: (
    language: TerminalCodeLabLanguage,
    source: string,
    autoRun: boolean,
    sqlConnectionId?: string,
    sqlAttachDbIds?: string[],
  ) => void;
  onOpenErStudio?: (connectionId: string, title?: string) => void;
  onNotify?: (message: string) => void;
}

function buildFileReaderSnippet(
  file: DataLabMountedFile,
  lang: 'sql' | 'python' | 'r',
): string {
  const escapedWinPath = file.path.replace(/\\/g, '/');
  const fmt = file.format.toLowerCase();
  if (lang === 'sql') {
    return `-- 查询已挂载文件：${file.alias} (${file.format.toUpperCase()})\nSELECT *\nFROM ${file.alias}\nLIMIT 50;`;
  }
  if (lang === 'python') {
    if (fmt === 'parquet') {
      return `import pandas as pd\n\ndf_${file.alias} = pd.read_parquet(r"${file.path}")\nprint(df_${file.alias}.shape)\ndf_${file.alias}.head(10)`;
    }
    if (fmt === 'excel') {
      return `import pandas as pd\n\ndf_${file.alias} = pd.read_excel(r"${file.path}")\nprint(df_${file.alias}.shape)\ndf_${file.alias}.head(10)`;
    }
    if (fmt === 'json' || fmt === 'jsonl') {
      return `import pandas as pd\n\ndf_${file.alias} = pd.read_json(r"${file.path}"${fmt === 'jsonl' ? ', lines=True' : ''})\nprint(df_${file.alias}.shape)\ndf_${file.alias}.head(10)`;
    }
    return `import pandas as pd\n\ndf_${file.alias} = pd.read_csv(r"${file.path}"${fmt === 'tsv' ? ', sep="\\t"' : ''})\nprint(df_${file.alias}.shape)\ndf_${file.alias}.head(10)`;
  }
  if (fmt === 'parquet') {
    return `library(arrow)\ndf_${file.alias} <- read_parquet("${escapedWinPath}")\nhead(df_${file.alias}, 10)`;
  }
  if (fmt === 'tsv') {
    return `df_${file.alias} <- read.delim("${escapedWinPath}", stringsAsFactors = FALSE)\nsummary(df_${file.alias})\nhead(df_${file.alias}, 10)`;
  }
  return `df_${file.alias} <- read.csv("${escapedWinPath}", stringsAsFactors = FALSE)\nsummary(df_${file.alias})\nhead(df_${file.alias}, 10)`;
}

export function CodeLabDataPanel({
  mountedFiles,
  dbConnections,
  preferredPythonPath,
  onUpdateFiles,
  onUpdateConnections,
  onInsertCell,
  onOpenErStudio,
  onNotify,
}: CodeLabDataPanelProps) {
  const [manualFilePath, setManualFilePath] = useState('');
  const [inspectingPath, setInspectingPath] = useState<string | null>(null);
  const [expandedFileIds, setExpandedFileIds] = useState<
    Record<string, boolean>
  >({});
  const [expandedConnIds, setExpandedConnIds] = useState<
    Record<string, boolean>
  >({});
  const [testingConnId, setTestingConnId] = useState<string | null>(null);

  // Modal state for creating / editing DB connections
  const [connModalOpen, setConnModalOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<DataLabDbConnection | null>(
    null,
  );
  const [presetPgInstance, setPresetPgInstance] =
    useState<LocalPostgresInstance | null>(null);

  // Profiler modal state
  const [profilerTarget, setProfilerTarget] = useState<{
    conn: DataLabDbConnection;
    table: DataDbTableSchema;
  } | null>(null);

  // Local PostgreSQL discovery state
  const [localPgInstances, setLocalPgInstances] = useState<
    LocalPostgresInstance[]
  >([]);
  const [discoveringPg, setDiscoveringPg] = useState(true);
  const [pgDiscoveryError, setPgDiscoveryError] = useState('');
  const [startingPgService, setStartingPgService] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    terminalApi
      .discoverLocalPostgres()
      .then((instances) => {
        if (active) {
          setLocalPgInstances(instances);
          setDiscoveringPg(false);
        }
      })
      .catch((err) => {
        if (active) {
          setPgDiscoveryError(err instanceof Error ? err.message : String(err));
          setDiscoveringPg(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const refreshLocalPg = async () => {
    setDiscoveringPg(true);
    setPgDiscoveryError('');
    try {
      setLocalPgInstances(await terminalApi.discoverLocalPostgres());
    } catch (err) {
      setPgDiscoveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscoveringPg(false);
    }
  };

  const selectLocalPg = async (instance: LocalPostgresInstance) => {
    setPgDiscoveryError('');
    let selected = instance;
    if (instance.state.toLowerCase() !== 'running') {
      setStartingPgService(instance.serviceName);
      try {
        selected = await terminalApi.startLocalPostgres({
          serviceName: instance.serviceName,
        });
        setLocalPgInstances((items) =>
          items.map((item) =>
            item.serviceName === selected.serviceName ? selected : item,
          ),
        );
      } catch (err) {
        setPgDiscoveryError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setStartingPgService(null);
      }
    }
    setEditingConn(null);
    setPresetPgInstance(selected);
    setConnModalOpen(true);
  };

  const inspectAndMountPath = async (rawPath: string) => {
    const cleanPath = rawPath.trim().replace(/^["']|["']$/g, '');
    if (!cleanPath) return;
    setInspectingPath(cleanPath);
    try {
      const info = await terminalApi.inspectDataFile({
        path: cleanPath,
        pythonPath: preferredPythonPath ?? null,
        maxRows: 10,
      });
      const existingIdx = mountedFiles.findIndex(
        (f) => f.path.toLowerCase() === info.path.toLowerCase(),
      );
      const baseAlias = sanitizeDataAlias(info.fileName);
      const existingAliases = new Set(
        mountedFiles
          .filter((_, idx) => idx !== existingIdx)
          .map((f) => f.alias.toLowerCase()),
      );
      let alias = baseAlias;
      let suffix = 2;
      while (existingAliases.has(alias.toLowerCase())) {
        alias = `${baseAlias}_${suffix}`;
        suffix += 1;
      }

      const item: DataLabMountedFile = {
        id:
          existingIdx >= 0
            ? mountedFiles[existingIdx].id
            : `df-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        alias: existingIdx >= 0 ? mountedFiles[existingIdx].alias : alias,
        path: info.path,
        format: info.format,
        sizeBytes: info.sizeBytes,
        rowCount: info.rowCount ?? null,
        columns: info.columns,
        engine: info.engine,
        updatedAt: Date.now(),
      };
      const next =
        existingIdx >= 0
          ? mountedFiles.map((f, idx) => (idx === existingIdx ? item : f))
          : [item, ...mountedFiles];
      onUpdateFiles(next);
      setExpandedFileIds((prev) => ({ ...prev, [item.id]: true }));
      setManualFilePath('');
      onNotify?.(
        `已挂载 ${item.alias} (${info.columns.length} 列${info.rowCount != null ? ` · ${info.rowCount} 行` : ''})`,
      );
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : String(err));
    } finally {
      setInspectingPath(null);
    }
  };

  const handleBrowseDataFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        title: '选择本地数据文件 (CSV / Parquet / JSON / Excel)',
        filters: [
          {
            name: '数据文件',
            extensions: [
              'csv',
              'tsv',
              'parquet',
              'pq',
              'json',
              'jsonl',
              'ndjson',
              'xlsx',
              'xls',
            ],
          },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (typeof selected === 'string' && selected) {
        await inspectAndMountPath(selected);
      }
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : '打开文件选择器失败');
    }
  };

  const handleTestConnection = async (conn: DataLabDbConnection) => {
    setTestingConnId(conn.id);
    try {
      const res = await terminalApi.testDbConnection({
        connection: buildConnectionInput(conn, preferredPythonPath),
      });
      const updated = dbConnections.map((item) =>
        item.id === conn.id
          ? {
              ...item,
              tables: res.tables,
              customTypes: res.customTypes ?? [],
              lastTestedAt: Date.now(),
              lastStatus: res.ok ? `已连接 · ${res.engine}` : res.message,
            }
          : item,
      );
      onUpdateConnections(updated);
      if (res.ok) {
        setExpandedConnIds((prev) => ({ ...prev, [conn.id]: true }));
      }
      onNotify?.(res.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const updated = dbConnections.map((item) =>
        item.id === conn.id
          ? { ...item, lastTestedAt: Date.now(), lastStatus: msg }
          : item,
      );
      onUpdateConnections(updated);
      onNotify?.(msg);
    } finally {
      setTestingConnId(null);
    }
  };

  const handleToggleReadOnly = (conn: DataLabDbConnection) => {
    const nextRo = !(conn.readOnly ?? true);
    onUpdateConnections(
      dbConnections.map((item) =>
        item.id === conn.id ? { ...item, readOnly: nextRo } : item,
      ),
    );
    onNotify?.(
      nextRo
        ? `${conn.name} 已切换为只读研究模式（防误写）。`
        : `${conn.name} 已切换为读写模式，请谨慎执行写入语句。`,
    );
  };

  const handleRemoveConnection = async (id: string) => {
    await terminalApi
      .deleteDbPassword({ connectionId: id })
      .catch(() => undefined);
    onUpdateConnections(dbConnections.filter((c) => c.id !== id));
  };

  const handleModalSaved = (
    savedBatch: DataLabDbConnection[],
    mode: 'create' | 'edit',
    message: string,
  ) => {
    if (mode === 'edit' && savedBatch[0]) {
      const edited = savedBatch[0];
      onUpdateConnections(
        dbConnections.map((c) => (c.id === edited.id ? edited : c)),
      );
      setExpandedConnIds((prev) => ({ ...prev, [edited.id]: true }));
    } else {
      onUpdateConnections([...savedBatch, ...dbConnections]);
      const nextExpanded: Record<string, boolean> = {};
      for (const c of savedBatch) nextExpanded[c.id] = true;
      setExpandedConnIds((prev) => ({ ...prev, ...nextExpanded }));
    }
    onNotify?.(message);
  };

  const firstMountedAlias = mountedFiles[0]?.alias;

  return (
    <div className="datalab-panel">
      {/* Section 1: Mounted Local Data Files */}
      <div className="datalab-section">
        <div className="datalab-section-head">
          <span>本地数据文件 ({mountedFiles.length})</span>
          <button
            type="button"
            className="terminal-rail-mini-btn is-accent"
            onClick={() => void handleBrowseDataFile()}
            disabled={Boolean(inspectingPath)}
          >
            + 挂载文件
          </button>
        </div>

        <form
          className="datalab-path-form"
          onSubmit={(e) => {
            e.preventDefault();
            void inspectAndMountPath(manualFilePath);
          }}
        >
          <input
            type="text"
            className="terminal-rail-search"
            value={manualFilePath}
            onChange={(e) => setManualFilePath(e.target.value)}
            placeholder="粘贴 CSV / Parquet / JSON 路径回车…"
            aria-label="指定本地数据文件路径"
          />
          {manualFilePath.trim() && (
            <button
              type="submit"
              className="terminal-rail-mini-btn is-accent"
              disabled={Boolean(inspectingPath)}
            >
              挂载
            </button>
          )}
        </form>

        {mountedFiles.length === 0 ? (
          <div className="terminal-rail-empty-hint">
            支持 CSV / TSV / Parquet / JSON / Excel；挂载后可直接写 SQL、Python
            或 R 检索。
          </div>
        ) : (
          <div className="datalab-card-list">
            {mountedFiles.map((file) => {
              const expanded = Boolean(expandedFileIds[file.id]);
              return (
                <div key={file.id} className="datalab-card">
                  <div className="datalab-card-top">
                    <button
                      type="button"
                      className="datalab-card-head"
                      onClick={() =>
                        setExpandedFileIds((prev) => ({
                          ...prev,
                          [file.id]: !prev[file.id],
                        }))
                      }
                      title={file.path}
                    >
                      <span className="datalab-fmt-badge">
                        {file.format.toUpperCase()}
                      </span>
                      <strong className="datalab-card-name">
                        {file.alias}
                      </strong>
                    </button>
                    <button
                      type="button"
                      className="datalab-card-remove"
                      onClick={() =>
                        onUpdateFiles(
                          mountedFiles.filter((f) => f.id !== file.id),
                        )
                      }
                      title="取消挂载"
                      aria-label={`取消挂载 ${file.alias}`}
                    >
                      ×
                    </button>
                  </div>

                  {(file.rowCount != null || (file.sizeBytes ?? 0) > 0) && (
                    <div className="datalab-card-submeta">
                      {file.rowCount != null
                        ? `${file.rowCount.toLocaleString()} 行`
                        : ''}
                      {file.rowCount != null && (file.sizeBytes ?? 0) > 0
                        ? ' · '
                        : ''}
                      {file.sizeBytes
                        ? formatFileSizeCompact(file.sizeBytes)
                        : ''}
                      {file.columns?.length
                        ? ` · ${file.columns.length} 列`
                        : ''}
                    </div>
                  )}

                  <div className="datalab-card-actions is-compact-four">
                    <button
                      type="button"
                      className="terminal-rail-mini-btn is-accent"
                      onClick={() =>
                        onInsertCell(
                          'sql',
                          buildFileReaderSnippet(file, 'sql'),
                          true,
                          '',
                        )
                      }
                      title="插入 SQL 查询格并运行"
                    >
                      SQL 查
                    </button>
                    <button
                      type="button"
                      className="terminal-rail-mini-btn"
                      onClick={() =>
                        onInsertCell(
                          'python',
                          buildFileReaderSnippet(file, 'python'),
                          false,
                        )
                      }
                      title="插入 Python Pandas 读取格"
                    >
                      PY 读
                    </button>
                    <button
                      type="button"
                      className="terminal-rail-mini-btn"
                      onClick={() =>
                        onInsertCell(
                          'r',
                          buildFileReaderSnippet(file, 'r'),
                          false,
                        )
                      }
                      title="插入 R 读取格"
                    >
                      R 读
                    </button>
                    <button
                      type="button"
                      className="terminal-rail-mini-btn"
                      onClick={() => void inspectAndMountPath(file.path)}
                      disabled={inspectingPath === file.path}
                      title="重新解析字段 Schema"
                    >
                      刷新
                    </button>
                  </div>

                  {expanded && (
                    <div className="datalab-schema-box">
                      <div className="datalab-path-caption" title={file.path}>
                        {file.path}
                      </div>
                      {file.columns && file.columns.length > 0 ? (
                        <div className="datalab-col-list">
                          {file.columns.slice(0, 32).map((col, idx) => (
                            <div
                              key={`${col.name}-${idx}`}
                              className="datalab-col-row"
                            >
                              <span>{col.name}</span>
                              <span className="datalab-col-type">
                                {col.dataType}
                              </span>
                            </div>
                          ))}
                          {file.columns.length > 32 && (
                            <div className="datalab-col-more">
                              还有 {file.columns.length - 32} 列…
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="terminal-rail-empty-hint">
                          点击「刷新」查看字段结构
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 2: Database Connections */}
      <div className="datalab-section">
        <div className="datalab-section-head">
          <span>数据库连接 ({dbConnections.length})</span>
          <div className="datalab-head-btns">
            <button
              type="button"
              className="terminal-rail-mini-btn"
              onClick={() => void refreshLocalPg()}
              disabled={discoveringPg || Boolean(startingPgService)}
            >
              {discoveringPg ? '查找中…' : '本机 PG'}
            </button>
            <button
              type="button"
              className="terminal-rail-mini-btn is-accent"
              onClick={() => {
                setEditingConn(null);
                setPresetPgInstance(null);
                setConnModalOpen(true);
              }}
            >
              + 新建连接
            </button>
          </div>
        </div>

        {localPgInstances.length > 0 && (
          <div className="datalab-local-pg-list">
            {localPgInstances.map((instance) => {
              const running = instance.state.toLowerCase() === 'running';
              const stopped = instance.state.toLowerCase() === 'stopped';
              return (
                <div key={instance.serviceName} className="datalab-local-pg">
                  <div className="datalab-local-pg-info">
                    <strong
                      title={instance.displayName || instance.serviceName}
                    >
                      {instance.displayName || instance.serviceName}
                    </strong>
                    <span>
                      127.0.0.1:{instance.port} ·{' '}
                      {running ? '运行中' : stopped ? '已停止' : instance.state}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="terminal-rail-mini-btn is-accent"
                    disabled={
                      Boolean(startingPgService) || (!running && !stopped)
                    }
                    onClick={() => void selectLocalPg(instance)}
                  >
                    {startingPgService === instance.serviceName
                      ? '启动中…'
                      : running
                        ? '配置连接'
                        : '启动并连接'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {pgDiscoveryError && (
          <div className="datalab-inline-error" role="alert">
            {pgDiscoveryError}
          </div>
        )}

        {dbConnections.length === 0 ? (
          <div className="terminal-rail-empty-hint">
            支持 PostgreSQL（多库发现/只读研究/百万行分页）、DuckDB、SQLite 与
            MySQL。点击「配置连接」或「+ 新建连接」打开向导。
          </div>
        ) : (
          <div className="datalab-card-list">
            {dbConnections.map((conn) => {
              const expanded = Boolean(expandedConnIds[conn.id]);
              const isReadOnly = conn.readOnly ?? true;
              return (
                <div key={conn.id} className="datalab-card">
                  <div className="datalab-card-top">
                    <button
                      type="button"
                      className="datalab-card-head"
                      onClick={() =>
                        setExpandedConnIds((prev) => ({
                          ...prev,
                          [conn.id]: !prev[conn.id],
                        }))
                      }
                      title={`${conn.name}${conn.database ? ` · 库: ${conn.database}` : ''}`}
                    >
                      <span className="datalab-fmt-badge">
                        {conn.dbType === 'postgres'
                          ? 'PG'
                          : conn.dbType.toUpperCase()}
                      </span>
                      <strong className="datalab-card-name">{conn.name}</strong>
                      <span className="datalab-card-meta">
                        {conn.tables ? `${conn.tables.length} 表` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="datalab-card-remove"
                      onClick={() => void handleRemoveConnection(conn.id)}
                      title="删除连接"
                      aria-label={`删除连接 ${conn.name}`}
                    >
                      ×
                    </button>
                  </div>

                  <div className="datalab-card-submeta datalab-conn-meta-line">
                    <span
                      className={`datalab-ro-pill${isReadOnly ? ' is-ro' : ' is-rw'}`}
                      title={
                        isReadOnly
                          ? '只读研究模式：数据库会话层禁止写入'
                          : '读写模式：允许执行写入语句'
                      }
                    >
                      {isReadOnly ? '只读' : '读写'}
                    </span>
                    {conn.database && <span>库: {conn.database}</span>}
                    {conn.host && (
                      <span>
                        · {conn.host}:{conn.port ?? 5432}
                      </span>
                    )}
                  </div>

                  {conn.lastStatus && (
                    <div
                      className="datalab-conn-status"
                      title={conn.lastStatus}
                    >
                      {conn.lastStatus}
                    </div>
                  )}

                  <div className="datalab-card-actions">
                    {onOpenErStudio && (
                      <button
                        type="button"
                        className="terminal-rail-mini-btn is-accent"
                        onClick={() =>
                          onOpenErStudio(
                            conn.id,
                            `ER · ${conn.database || conn.name}`,
                          )
                        }
                        title="在编辑器标签页打开交互式 Database ER Studio（支持与右侧 Agent 分屏联动）"
                      >
                        ER 图谱
                      </button>
                    )}
                    <button
                      type="button"
                      className="terminal-rail-mini-btn is-accent"
                      onClick={() =>
                        onInsertCell(
                          'sql',
                          conn.tables?.[0]
                            ? buildTableSelectSql(
                                conn.tables[0].name,
                                conn.tables[0].schema,
                                conn.dbType,
                                100,
                              )
                            : '-- 输入 SQL 查询\nSELECT 1;',
                          false,
                          conn.id,
                        )
                      }
                    >
                      新建 SQL
                    </button>
                    <button
                      type="button"
                      className="terminal-rail-mini-btn"
                      disabled={testingConnId === conn.id}
                      onClick={() => void handleTestConnection(conn)}
                    >
                      {testingConnId === conn.id ? '检测中…' : '刷新表'}
                    </button>
                    <button
                      type="button"
                      className="terminal-rail-mini-btn"
                      onClick={() => {
                        setEditingConn(conn);
                        setPresetPgInstance(null);
                        setConnModalOpen(true);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="terminal-rail-mini-btn"
                      onClick={() => handleToggleReadOnly(conn)}
                      title="快速切换只读研究模式与读写模式"
                    >
                      {isReadOnly ? '切读写' : '切只读'}
                    </button>
                  </div>

                  {expanded && (
                    <div className="datalab-schema-box">
                      <DbSchemaTree
                        connection={conn}
                        firstMountedAlias={firstMountedAlias}
                        onInsertCell={onInsertCell}
                        onProfileTable={(c, tbl) =>
                          setProfilerTarget({ conn: c, table: tbl })
                        }
                        onNotify={onNotify}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <DbConnectionModal
        open={connModalOpen}
        editingConnection={editingConn}
        presetInstance={presetPgInstance}
        preferredPythonPath={preferredPythonPath}
        existingConnections={dbConnections}
        onClose={() => setConnModalOpen(false)}
        onSaved={handleModalSaved}
      />

      <DbTableProfilerModal
        connection={profilerTarget?.conn ?? null}
        table={profilerTarget?.table ?? null}
        preferredPythonPath={preferredPythonPath}
        firstMountedAlias={firstMountedAlias}
        onClose={() => setProfilerTarget(null)}
        onInsertCell={onInsertCell}
      />
    </div>
  );
}
