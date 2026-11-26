import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  terminalApi,
  type DataDbConnectionInput,
  type LocalPostgresInstance,
} from './terminal-api';
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
  const [connFormError, setConnFormError] = useState('');
  const [localPgInstances, setLocalPgInstances] = useState<
    LocalPostgresInstance[]
  >([]);
  const [discoveringPg, setDiscoveringPg] = useState(true);
  const [pgDiscoveryError, setPgDiscoveryError] = useState('');
  const [startingPgService, setStartingPgService] = useState<string | null>(
    null,
  );
  const [showCreateDatabase, setShowCreateDatabase] = useState(false);
  const [newDatabaseName, setNewDatabaseName] = useState('');
  const [creatingDatabase, setCreatingDatabase] = useState(false);
  const [createDatabaseMessage, setCreateDatabaseMessage] = useState('');
  const [createForConnId, setCreateForConnId] = useState<string | null>(null);
  const [savedNewDatabaseName, setSavedNewDatabaseName] = useState('');
  const [creatingForConnId, setCreatingForConnId] = useState<string | null>(
    null,
  );
  const [savedCreateStatus, setSavedCreateStatus] = useState<
    Record<string, string>
  >({});

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
    setDbType('postgres');
    setConnName(selected.displayName || selected.serviceName);
    setConnHost('127.0.0.1');
    setConnPort(String(selected.port));
    setConnDatabase('postgres');
    setConnUsername('postgres');
    setConnPassword('');
    setConnFormError('');
    setCreateDatabaseMessage('');
    setShowConnForm(true);
  };

  const formConnectionInput = (
    id: string,
    databaseOverride?: string,
  ): DataDbConnectionInput => ({
    id,
    name: connName.trim() || 'PostgreSQL',
    dbType,
    filePath:
      dbType === 'sqlite' || dbType === 'duckdb' ? connFilePath.trim() : null,
    host: dbType === 'sqlite' || dbType === 'duckdb' ? null : connHost.trim(),
    port: dbType === 'sqlite' || dbType === 'duckdb' ? null : Number(connPort),
    database: (databaseOverride ?? connDatabase.trim()) || null,
    username: connUsername.trim() || null,
    password: connPassword || null,
    pythonPath: preferredPythonPath ?? null,
  });

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
      setConnFormError('请指定数据库文件路径');
      return;
    }
    if (!isFileDb && !connHost.trim()) {
      setConnFormError('请输入数据库主机地址');
      return;
    }
    const parsedPort = Number(connPort);
    if (
      !isFileDb &&
      (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)
    ) {
      setConnFormError('端口必须是 1–65535 之间的整数。');
      return;
    }
    setConnFormError('');
    setSavingConn(true);
    try {
      const id = `db-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const displayName =
        connName.trim() ||
        (isFileDb
          ? connFilePath.split(/[\\/]/).pop() || dbType.toUpperCase()
          : `${dbType}://${connHost}/${connDatabase || 'default'}`);
      const newConn: DataLabDbConnection = {
        id,
        name: displayName,
        dbType,
        filePath: isFileDb ? connFilePath.trim() : undefined,
        host: isFileDb ? undefined : connHost.trim(),
        port: isFileDb ? undefined : parsedPort,
        database: isFileDb ? undefined : connDatabase.trim() || undefined,
        username: isFileDb ? undefined : connUsername.trim() || undefined,
        hasPassword: !isFileDb && Boolean(connPassword),
        pythonPath: preferredPythonPath ?? undefined,
      };
      const testRes = await terminalApi
        .testDbConnection({
          connection: { ...formConnectionInput(id), name: newConn.name },
        })
        .catch((err) => ({
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          tables: [],
          engine: dbType.toUpperCase(),
        }));
      if (!testRes.ok) {
        setConnFormError(testRes.message);
        onNotify?.(testRes.message);
        return;
      }
      if (!isFileDb && connPassword) {
        await terminalApi.saveDbPassword({
          connectionId: id,
          password: connPassword,
        });
      }

      const savedConn: DataLabDbConnection = {
        ...newConn,
        tables: testRes.tables,
        lastTestedAt: Date.now(),
        lastStatus: `已连接 · ${testRes.engine}`,
      };
      onUpdateConnections([savedConn, ...dbConnections]);
      setExpandedConnIds((prev) => ({ ...prev, [savedConn.id]: true }));
      setShowConnForm(false);
      setShowCreateDatabase(false);
      setCreateDatabaseMessage('');
      setConnName('');
      setConnFilePath('');
      setConnPassword('');
      onNotify?.(testRes.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConnFormError(message);
      onNotify?.(message);
    } finally {
      setSavingConn(false);
    }
  };

  const handleCreatePostgresDatabase = async () => {
    const name = newDatabaseName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
      setConnFormError(
        '数据库名须以字母或下划线开头，只能包含字母、数字、下划线，最长 63 字符。',
      );
      return;
    }
    const port = Number(connPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setConnFormError('端口必须是 1–65535 之间的整数。');
      return;
    }
    setCreatingDatabase(true);
    setConnFormError('');
    setCreateDatabaseMessage('');
    try {
      const message = await terminalApi.createPostgresDatabase({
        connection: formConnectionInput(`db-create-${Date.now()}`),
        databaseName: name,
      });
      setConnDatabase(name);
      setNewDatabaseName('');
      setShowCreateDatabase(false);
      setCreateDatabaseMessage(`${message} 请测试并保存连接。`);
      onNotify?.(message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConnFormError(message);
      onNotify?.(message);
    } finally {
      setCreatingDatabase(false);
    }
  };

  const handleCreateForSavedConnection = async (conn: DataLabDbConnection) => {
    const name = savedNewDatabaseName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
      setSavedCreateStatus((previous) => ({
        ...previous,
        [conn.id]:
          '数据库名须以字母或下划线开头，只能包含字母、数字、下划线，最长 63 字符。',
      }));
      return;
    }
    setCreatingForConnId(conn.id);
    setSavedCreateStatus((previous) => ({ ...previous, [conn.id]: '' }));
    let created = false;
    try {
      const baseInput: DataDbConnectionInput = {
        id: conn.id,
        name: conn.name,
        dbType: 'postgres',
        host: conn.host ?? '127.0.0.1',
        port: conn.port ?? 5432,
        database: conn.database ?? 'postgres',
        username: conn.username ?? 'postgres',
        password: null,
        pythonPath: conn.pythonPath ?? preferredPythonPath ?? null,
      };
      await terminalApi.createPostgresDatabase({
        connection: baseInput,
        databaseName: name,
      });
      created = true;
      const tested = await terminalApi.testDbConnection({
        connection: { ...baseInput, database: name },
      });
      if (!tested.ok) throw new Error(tested.message);
      const newId = `db-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const hasPassword = await terminalApi.copyDbPassword({
        sourceConnectionId: conn.id,
        targetConnectionId: newId,
      });
      const newConn: DataLabDbConnection = {
        ...conn,
        id: newId,
        name: `${conn.name} / ${name}`,
        database: name,
        hasPassword,
        tables: tested.tables,
        lastTestedAt: Date.now(),
        lastStatus: `已连接 · ${tested.engine}`,
      };
      onUpdateConnections([newConn, ...dbConnections]);
      setExpandedConnIds((previous) => ({ ...previous, [newId]: true }));
      setCreateForConnId(null);
      setSavedNewDatabaseName('');
      onNotify?.(`数据库 ${name} 已创建并连接。`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const message = created
        ? `数据库 ${name} 已创建，但新连接未保存：${reason}`
        : reason;
      setSavedCreateStatus((previous) => ({ ...previous, [conn.id]: message }));
      onNotify?.(message);
    } finally {
      setCreatingForConnId(null);
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
          <div className="datalab-head-btns">
            <button
              type="button"
              className="terminal-rail-mini-btn"
              onClick={() => void refreshLocalPg()}
              disabled={discoveringPg || Boolean(startingPgService)}
            >
              {discoveringPg ? '查找中…' : '查找本机 PG'}
            </button>
            <button
              type="button"
              className="terminal-rail-mini-btn is-accent"
              onClick={() => {
                if (showConnForm) {
                  setConnPassword('');
                  setConnFormError('');
                  setShowCreateDatabase(false);
                  setCreateDatabaseMessage('');
                }
                setShowConnForm((value) => !value);
              }}
            >
              {showConnForm ? '取消' : '+ 新建连接'}
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
                    <strong>
                      {instance.displayName || instance.serviceName}
                    </strong>
                    <span>
                      127.0.0.1:{instance.port}
                      {instance.portSource === 'default'
                        ? ' · 默认端口，连接前可修改'
                        : ''}
                      {' · '}
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
                        ? '连接'
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
        {!discoveringPg &&
          localPgInstances.length === 0 &&
          !pgDiscoveryError && (
            <div className="terminal-rail-empty-hint">
              未发现 Windows PostgreSQL 服务；可手动填写本机或远程连接。
            </div>
          )}

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
                      setConnFormError('');
                      setShowCreateDatabase(false);
                      setConnPassword('');
                      setCreateDatabaseMessage('');
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
                    placeholder="密码（Windows 凭据管理器）"
                  />
                </div>
                {dbType === 'postgres' && (
                  <div className="datalab-create-db">
                    <button
                      type="button"
                      className="terminal-rail-mini-btn"
                      onClick={() => setShowCreateDatabase((value) => !value)}
                    >
                      {showCreateDatabase ? '收起创建数据库' : '+ 创建新数据库'}
                    </button>
                    {showCreateDatabase && (
                      <div className="datalab-create-db-fields">
                        <span>
                          用上面的账户连接现有数据库，创建后切换到新数据库。
                        </span>
                        <input
                          type="text"
                          className="terminal-rail-search"
                          value={newDatabaseName}
                          onChange={(event) =>
                            setNewDatabaseName(event.target.value)
                          }
                          placeholder="新数据库名，例如 research"
                          aria-label="新 PostgreSQL 数据库名"
                        />
                        <button
                          type="button"
                          className="terminal-rail-mini-btn is-accent"
                          disabled={creatingDatabase || savingConn}
                          onClick={() => void handleCreatePostgresDatabase()}
                        >
                          {creatingDatabase ? '正在创建…' : '确认创建数据库'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {createDatabaseMessage && (
              <div className="datalab-inline-success" role="status">
                {createDatabaseMessage}
              </div>
            )}
            {connFormError && (
              <div className="datalab-inline-error" role="alert">
                {connFormError}
              </div>
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
                    {conn.dbType === 'postgres' && (
                      <button
                        type="button"
                        className="terminal-rail-mini-btn"
                        onClick={() => {
                          setCreateForConnId((current) =>
                            current === conn.id ? null : conn.id,
                          );
                          setSavedNewDatabaseName('');
                          setSavedCreateStatus((previous) => ({
                            ...previous,
                            [conn.id]: '',
                          }));
                        }}
                      >
                        创建数据库
                      </button>
                    )}
                    <button
                      type="button"
                      className="terminal-rail-mini-btn"
                      onClick={() => void handleRemoveConnection(conn.id)}
                      title="删除连接"
                    >
                      ×
                    </button>
                  </div>

                  {createForConnId === conn.id && (
                    <div className="datalab-create-db-fields">
                      <span>
                        使用此连接的账户创建数据库，并自动添加新连接。
                      </span>
                      <input
                        type="text"
                        className="terminal-rail-search"
                        value={savedNewDatabaseName}
                        onChange={(event) =>
                          setSavedNewDatabaseName(event.target.value)
                        }
                        placeholder="新数据库名，例如 research"
                        aria-label="新 PostgreSQL 数据库名"
                      />
                      <button
                        type="button"
                        className="terminal-rail-mini-btn is-accent"
                        disabled={creatingForConnId === conn.id}
                        onClick={() =>
                          void handleCreateForSavedConnection(conn)
                        }
                      >
                        {creatingForConnId === conn.id
                          ? '正在创建…'
                          : '确认创建数据库'}
                      </button>
                    </div>
                  )}
                  {savedCreateStatus[conn.id] && (
                    <div className="datalab-inline-error" role="alert">
                      {savedCreateStatus[conn.id]}
                    </div>
                  )}

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
