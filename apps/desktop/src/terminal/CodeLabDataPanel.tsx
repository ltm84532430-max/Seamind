import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { terminalApi, type DataDbConnectionInput } from './terminal-api';
import {
  formatFileSizeCompact,
  sanitizeDataAlias,
  type DataLabDbConnection,
  type DataLabMountedFile,
} from './terminal-codelab-model';
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
  ) => void;
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
  // R snippet
  if (fmt === 'parquet') {
    return `library(arrow)\ndf_${file.alias} <- read_parquet("${escapedWinPath}")\nhead(df_${file.alias}, 10)`;
  }
  if (fmt === 'tsv') {
    return `df_${file.alias} <- read.delim("${escapedWinPath}", stringsAsFactors = FALSE)\nsummary(df_${file.alias})\nhead(df_${file.alias}, 10)`;
  }
  return `df_${file.alias} <- read.csv("${escapedWinPath}", stringsAsFactors = FALSE)\nsummary(df_${file.alias})\nhead(df_${file.alias}, 10)`;
}

function buildTableSelectSql(
  tableName: string,
  schema: string | null | undefined,
  dbType: DataLabDbConnection['dbType'],
): string {
  const qualified =
    schema && schema !== 'main' && dbType === 'postgres'
      ? `"${schema}"."${tableName}"`
      : dbType === 'mysql'
        ? `\`${tableName}\``
        : `"${tableName}"`;
  return `SELECT *\nFROM ${qualified}\nLIMIT 50;`;
}

export function CodeLabDataPanel({
  mountedFiles,
  dbConnections,
  preferredPythonPath,
  onUpdateFiles,
  onUpdateConnections,
  onInsertCell,
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

  // Add DB connection form state
  const [showConnForm, setShowConnForm] = useState(false);
  const [dbType, setDbType] = useState<DataLabDbConnection['dbType']>('sqlite');
  const [connName, setConnName] = useState('');
  const [connFilePath, setConnFilePath] = useState('');
  const [connHost, setConnHost] = useState('127.0.0.1');
  const [connPort, setConnPort] = useState('5432');
  const [connDatabase, setConnDatabase] = useState('');
  const [connUsername, setConnUsername] = useState('');
  const [connPassword, setConnPassword] = useState('');
  const [savingConn, setSavingConn] = useState(false);

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

  const handleBrowseDbFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        title:
          dbType === 'duckdb' ? '选择 DuckDB 文件' : '选择 SQLite 数据库文件',
        filters: [
          {
            name: dbType === 'duckdb' ? 'DuckDB' : 'SQLite',
            extensions:
              dbType === 'duckdb'
                ? ['duckdb', 'ddb']
                : ['db', 'sqlite', 'sqlite3'],
          },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (typeof selected === 'string' && selected) {
        setConnFilePath(selected);
        if (!connName.trim()) {
          const base =
            selected
              .split(/[\\/]/)
              .pop()
              ?.replace(/\.[^.]+$/, '') || dbType;
          setConnName(base);
        }
      }
    } catch {
      // ignore cancel
    }
  };

  const handleTestConnection = async (
    conn: DataLabDbConnection,
    overridePassword?: string,
  ) => {
    setTestingConnId(conn.id);
    try {
      const input: DataDbConnectionInput = {
        id: conn.id,
        name: conn.name,
        dbType: conn.dbType,
        filePath: conn.filePath ?? null,
        host: conn.host ?? null,
        port: conn.port ?? null,
        database: conn.database ?? null,
        username: conn.username ?? null,
        password: overridePassword || null,
        pythonPath: conn.pythonPath ?? preferredPythonPath ?? null,
      };
      const res = await terminalApi.testDbConnection({ connection: input });
      const updated = dbConnections.map((item) =>
        item.id === conn.id
          ? {
              ...item,
              tables: res.tables,
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
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const updated = dbConnections.map((item) =>
        item.id === conn.id
          ? { ...item, lastTestedAt: Date.now(), lastStatus: msg }
          : item,
      );
      onUpdateConnections(updated);
      onNotify?.(msg);
      return null;
    } finally {
      setTestingConnId(null);
    }
  };

  const handleSaveNewConnection = async () => {
    const isFileDb = dbType === 'sqlite' || dbType === 'duckdb';
    if (isFileDb && !connFilePath.trim()) {
      onNotify?.('请指定数据库文件路径');
      return;
    }
    if (!isFileDb && !connHost.trim()) {
      onNotify?.('请输入数据库主机地址');
      return;
    }
    setSavingConn(true);
    try {
      const id = `db-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const displayName =
        connName.trim() ||
        (isFileDb
          ? connFilePath.split(/[\\/]/).pop() || dbType.toUpperCase()
          : `${dbType}://${connHost}/${connDatabase || 'default'}`);
      const parsedPort = Number.parseInt(connPort, 10);
      const newConn: DataLabDbConnection = {
        id,
        name: displayName,
        dbType,
        filePath: isFileDb ? connFilePath.trim() : undefined,
        host: isFileDb ? undefined : connHost.trim(),
        port: isFileDb
          ? undefined
          : Number.isFinite(parsedPort)
            ? parsedPort
            : dbType === 'mysql'
              ? 3306
              : 5432,
        database: isFileDb ? undefined : connDatabase.trim() || undefined,
        username: isFileDb ? undefined : connUsername.trim() || undefined,
        hasPassword: !isFileDb && Boolean(connPassword),
        pythonPath: preferredPythonPath ?? undefined,
      };
      if (!isFileDb && connPassword) {
        await terminalApi.saveDbPassword({
          connectionId: id,
          password: connPassword,
        });
      }
      const testRes = await terminalApi
        .testDbConnection({
          connection: {
            id: newConn.id,
            name: newConn.name,
            dbType: newConn.dbType,
            filePath: newConn.filePath ?? null,
            host: newConn.host ?? null,
            port: newConn.port ?? null,
            database: newConn.database ?? null,
            username: newConn.username ?? null,
            password: connPassword || null,
            pythonPath: preferredPythonPath ?? null,
          },
        })
        .catch((err) => ({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          tables: [],
          engine: dbType.toUpperCase(),
        }));

      const savedConn: DataLabDbConnection = {
        ...newConn,
        tables: testRes.tables,
        lastTestedAt: Date.now(),
        lastStatus: testRes.ok ? `已连接 · ${testRes.engine}` : testRes.message,
      };
      onUpdateConnections([savedConn, ...dbConnections]);
      setExpandedConnIds((prev) => ({ ...prev, [savedConn.id]: true }));
      setShowConnForm(false);
      setConnName('');
      setConnFilePath('');
      setConnPassword('');
      onNotify?.(testRes.message);
    } finally {
      setSavingConn(false);
    }
  };

  const handleRemoveConnection = async (id: string) => {
    await terminalApi
      .deleteDbPassword({ connectionId: id })
      .catch(() => undefined);
    onUpdateConnections(dbConnections.filter((c) => c.id !== id));
  };

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
                          {file.columns.slice(0, 24).map((col, idx) => (
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
                          {file.columns.length > 24 && (
                            <div className="datalab-col-more">
                              还有 {file.columns.length - 24} 列…
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
          <button
            type="button"
            className="terminal-rail-mini-btn is-accent"
            onClick={() => setShowConnForm((v) => !v)}
          >
            {showConnForm ? '取消' : '+ 新建连接'}
          </button>
        </div>

        {showConnForm && (
          <div className="datalab-conn-form">
            <div className="datalab-dbtype-row">
              {(['sqlite', 'duckdb', 'postgres', 'mysql'] as const).map(
                (kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`datalab-dbtype-btn${dbType === kind ? ' is-active' : ''}`}
                    onClick={() => {
                      setDbType(kind);
                      setConnPort(kind === 'mysql' ? '3306' : '5432');
                    }}
                  >
                    {kind === 'postgres' ? 'PG' : kind.toUpperCase()}
                  </button>
                ),
              )}
            </div>

            <input
              type="text"
              className="terminal-rail-search"
              value={connName}
              onChange={(e) => setConnName(e.target.value)}
              placeholder="连接名称（可选）"
            />

            {dbType === 'sqlite' || dbType === 'duckdb' ? (
              <div className="datalab-file-picker-row">
                <input
                  type="text"
                  className="terminal-rail-search"
                  value={connFilePath}
                  onChange={(e) => setConnFilePath(e.target.value)}
                  placeholder={
                    dbType === 'duckdb'
                      ? '输入 .duckdb 路径或 :memory:'
                      : '输入 .db / .sqlite 文件路径'
                  }
                />
                <button
                  type="button"
                  className="terminal-rail-mini-btn"
                  onClick={() => void handleBrowseDbFile()}
                >
                  浏览
                </button>
              </div>
            ) : (
              <>
                <div className="datalab-host-row">
                  <input
                    type="text"
                    className="terminal-rail-search"
                    value={connHost}
                    onChange={(e) => setConnHost(e.target.value)}
                    placeholder="主机 127.0.0.1"
                  />
                  <input
                    type="text"
                    className="terminal-rail-search datalab-port-input"
                    value={connPort}
                    onChange={(e) => setConnPort(e.target.value)}
                    placeholder="端口"
                  />
                </div>
                <input
                  type="text"
                  className="terminal-rail-search"
                  value={connDatabase}
                  onChange={(e) => setConnDatabase(e.target.value)}
                  placeholder="数据库名 (database)"
                />
                <div className="datalab-host-row">
                  <input
                    type="text"
                    className="terminal-rail-search"
                    value={connUsername}
                    onChange={(e) => setConnUsername(e.target.value)}
                    placeholder="用户名"
                  />
                  <input
                    type="password"
                    className="terminal-rail-search"
                    value={connPassword}
                    onChange={(e) => setConnPassword(e.target.value)}
                    placeholder="密码（加密存储）"
                  />
                </div>
              </>
            )}

            <button
              type="button"
              className="terminal-rail-mini-btn is-accent datalab-submit-btn"
              disabled={savingConn}
              onClick={() => void handleSaveNewConnection()}
            >
              {savingConn ? '正在测试并保存…' : '测试并保存连接'}
            </button>
          </div>
        )}

        {dbConnections.length === 0 && !showConnForm ? (
          <div className="terminal-rail-empty-hint">
            支持 SQLite（免依赖直连）、DuckDB、PostgreSQL 与 MySQL。
          </div>
        ) : (
          <div className="datalab-card-list">
            {dbConnections.map((conn) => {
              const expanded = Boolean(expandedConnIds[conn.id]);
              return (
                <div key={conn.id} className="datalab-card">
                  <button
                    type="button"
                    className="datalab-card-head"
                    onClick={() =>
                      setExpandedConnIds((prev) => ({
                        ...prev,
                        [conn.id]: !prev[conn.id],
                      }))
                    }
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

                  {conn.lastStatus && (
                    <div
                      className="datalab-conn-status"
                      title={conn.lastStatus}
                    >
                      {conn.lastStatus}
                    </div>
                  )}

                  <div className="datalab-card-actions">
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
                              )
                            : '-- 输入 SQL 查询\nSELECT 1;',
                          false,
                          conn.id,
                        )
                      }
                    >
                      新建 SQL 格
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
                      onClick={() => void handleRemoveConnection(conn.id)}
                      title="删除连接"
                    >
                      ×
                    </button>
                  </div>

                  {expanded && (
                    <div className="datalab-schema-box">
                      {conn.tables && conn.tables.length > 0 ? (
                        <div className="datalab-table-list">
                          {conn.tables.slice(0, 30).map((tbl) => (
                            <div
                              key={`${tbl.schema ?? ''}.${tbl.name}`}
                              className="datalab-table-item"
                            >
                              <button
                                type="button"
                                className="datalab-table-btn"
                                onClick={() =>
                                  onInsertCell(
                                    'sql',
                                    buildTableSelectSql(
                                      tbl.name,
                                      tbl.schema,
                                      conn.dbType,
                                    ),
                                    true,
                                    conn.id,
                                  )
                                }
                                title={`点击直接查询 ${tbl.name} 前 50 行`}
                              >
                                <span>{tbl.name}</span>
                                <span className="datalab-col-type">
                                  {tbl.columns.length}列
                                  {tbl.rowCount != null
                                    ? ` · ${tbl.rowCount}行`
                                    : ''}
                                </span>
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="terminal-rail-empty-hint">
                          暂无数据表，点击「刷新表」重新读取 Schema。
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
    </div>
  );
}
