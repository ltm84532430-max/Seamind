import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  terminalApi,
  type DataDbConnectionInput,
  type DataDbDatabaseEntry,
  type DataDbPgpassMatch,
  type LocalPostgresInstance,
} from './terminal-api';
import {
  formatFileSizeCompact,
  type DataLabDbConnection,
  type DbSslMode,
} from './terminal-codelab-model';
import { diagnoseDatabaseError, parseDatabaseUrl } from './db-connection-utils';

export interface DbConnectionModalProps {
  open: boolean;
  editingConnection?: DataLabDbConnection | null;
  presetInstance?: LocalPostgresInstance | null;
  preferredPythonPath?: string | null;
  existingConnections: DataLabDbConnection[];
  onClose: () => void;
  onSaved: (
    savedConnections: DataLabDbConnection[],
    mode: 'create' | 'edit',
    message: string,
  ) => void;
}

const SSL_MODE_OPTIONS: Array<{ value: DbSslMode; label: string }> = [
  { value: 'prefer', label: 'prefer（推荐，优先加密）' },
  { value: 'disable', label: 'disable（本机明文直连）' },
  { value: 'require', label: 'require（强制 TLS）' },
  { value: 'verify-ca', label: 'verify-ca（校验证书链）' },
  { value: 'verify-full', label: 'verify-full（严格主机校验）' },
];

export function DbConnectionModal({
  open: isOpen,
  editingConnection,
  presetInstance,
  preferredPythonPath,
  existingConnections,
  onClose,
  onSaved,
}: DbConnectionModalProps) {
  const isEdit = Boolean(editingConnection);

  const [dbType, setDbType] =
    useState<DataLabDbConnection['dbType']>('postgres');
  const [connName, setConnName] = useState('');
  const [filePath, setFilePath] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('5432');
  const [database, setDatabase] = useState('postgres');
  const [username, setUsername] = useState('postgres');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [sslMode, setSslMode] = useState<DbSslMode>('prefer');
  const [timeoutSec, setTimeoutSec] = useState('30');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [urlDraft, setUrlDraft] = useState('');
  const [urlHint, setUrlHint] = useState('');

  const [pgpassMatch, setPgpassMatch] = useState<DataDbPgpassMatch | null>(
    null,
  );
  const [discoveredDbs, setDiscoveredDbs] = useState<DataDbDatabaseEntry[]>([]);
  const [selectedExtraDbs, setSelectedExtraDbs] = useState<
    Record<string, boolean>
  >({});
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [dbListNotice, setDbListNotice] = useState('');

  const [showCreateDb, setShowCreateDb] = useState(false);
  const [newDbName, setNewDbName] = useState('');
  const [creatingDb, setCreatingDb] = useState(false);
  const [statusNotice, setStatusNotice] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setFormError('');
    setStatusNotice('');
    setUrlDraft('');
    setUrlHint('');
    setDiscoveredDbs([]);
    setSelectedExtraDbs({});
    setDbListNotice('');
    setShowCreateDb(false);
    setNewDbName('');
    setShowPassword(false);

    if (editingConnection) {
      setDbType(editingConnection.dbType);
      setConnName(editingConnection.name);
      setFilePath(editingConnection.filePath ?? '');
      setHost(editingConnection.host ?? '127.0.0.1');
      setPort(
        String(
          editingConnection.port ??
            (editingConnection.dbType === 'mysql' ? 3306 : 5432),
        ),
      );
      setDatabase(editingConnection.database ?? '');
      setUsername(editingConnection.username ?? '');
      setPassword('');
      setReadOnly(editingConnection.readOnly ?? true);
      setSslMode(editingConnection.sslMode ?? 'prefer');
      setTimeoutSec(String(editingConnection.statementTimeoutSec ?? 30));
      setShowAdvanced(false);
    } else if (presetInstance) {
      setDbType('postgres');
      setConnName('');
      setFilePath('');
      setHost('127.0.0.1');
      setPort(String(presetInstance.port || 5432));
      setDatabase('postgres');
      setUsername('postgres');
      setPassword('');
      setReadOnly(true);
      setSslMode('prefer');
      setTimeoutSec('30');
      setShowAdvanced(false);
    } else {
      setDbType('postgres');
      setConnName('');
      setFilePath('');
      setHost('127.0.0.1');
      setPort('5432');
      setDatabase('postgres');
      setUsername('postgres');
      setPassword('');
      setReadOnly(true);
      setSslMode('prefer');
      setTimeoutSec('30');
      setShowAdvanced(false);
    }
  }, [isOpen, editingConnection, presetInstance]);

  useEffect(() => {
    if (!isOpen || dbType !== 'postgres') {
      setPgpassMatch(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      const parsedPort = Number(port);
      terminalApi
        .checkPgpass({
          host: host.trim() || '127.0.0.1',
          port: Number.isInteger(parsedPort) ? parsedPort : 5432,
          database: database.trim() || 'postgres',
          username: username.trim() || 'postgres',
        })
        .then((res) => {
          if (active) setPgpassMatch(res);
        })
        .catch(() => {
          if (active) setPgpassMatch(null);
        });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [isOpen, dbType, host, port, database, username]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, submitting, onClose]);

  if (!isOpen) return null;

  const isFileDb = dbType === 'sqlite' || dbType === 'duckdb';

  const buildInput = (
    id: string,
    databaseOverride?: string,
  ): DataDbConnectionInput => ({
    id,
    name:
      connName.trim() ||
      (isFileDb
        ? filePath.split(/[\\/]/).pop() || dbType.toUpperCase()
        : (databaseOverride ?? database.trim()) ||
          `${dbType}://${host.trim()}`),
    dbType,
    filePath: isFileDb ? filePath.trim() : null,
    host: isFileDb ? null : host.trim() || '127.0.0.1',
    port: isFileDb ? null : Number(port) || (dbType === 'mysql' ? 3306 : 5432),
    database: isFileDb
      ? null
      : (databaseOverride ?? database.trim()) ||
        (dbType === 'postgres' ? 'postgres' : null),
    username: isFileDb ? null : username.trim() || null,
    password: password || null,
    pythonPath: editingConnection?.pythonPath ?? preferredPythonPath ?? null,
    readOnly,
    sslMode: dbType === 'postgres' ? sslMode : null,
    statementTimeoutSec: Math.max(
      1,
      Math.min(600, Math.round(Number(timeoutSec) || 30)),
    ),
  });

  const handleApplyUrl = () => {
    const parsed = parseDatabaseUrl(urlDraft);
    if (!parsed) {
      setUrlHint(
        '无法解析该连接串，示例：postgresql://postgres:pwd@127.0.0.1:5432/FED?sslmode=prefer',
      );
      return;
    }
    setDbType(parsed.dbType);
    if (parsed.filePath != null) setFilePath(parsed.filePath);
    if (parsed.host != null) setHost(parsed.host);
    if (parsed.port != null) setPort(parsed.port);
    if (parsed.database != null) setDatabase(parsed.database);
    if (parsed.username != null) setUsername(parsed.username);
    if (parsed.password != null) setPassword(parsed.password);
    if (parsed.sslMode) setSslMode(parsed.sslMode);
    if (parsed.suggestedName && !connName.trim()) {
      setConnName(parsed.suggestedName);
    }
    setUrlDraft('');
    setUrlHint('已解析连接串并填入下方表单（原连接串已自动清空以保护密码）。');
    setFormError('');
  };

  const handleBrowseFile = async () => {
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
        setFilePath(selected);
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

  const handleLoadDatabases = async () => {
    if (dbType !== 'postgres') return;
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setFormError('端口必须是 1–65535 之间的整数。');
      return;
    }
    setLoadingDbs(true);
    setFormError('');
    setDbListNotice('');
    try {
      const list = await terminalApi.listDatabases({
        connection: buildInput(
          editingConnection?.id ?? `pg-probe-${Date.now()}`,
        ),
      });
      setDiscoveredDbs(list);
      if (list.length > 0) {
        setDbListNotice(
          `实例已认证成功，共发现 ${list.length} 个数据库。请点击选择目标库（支持勾选多库一键挂载）。`,
        );
        // If current database is still default 'postgres' and a non-postgres research DB exists (like FED), highlight it
        const nonDefault = list.find(
          (d) => d.name.toLowerCase() !== 'postgres',
        );
        if (
          !isEdit &&
          database.trim().toLowerCase() === 'postgres' &&
          nonDefault
        ) {
          setDatabase(nonDefault.name);
          if (!connName.trim()) {
            setConnName(`${nonDefault.name} (PG)`);
          }
        }
      } else {
        setDbListNotice('已连接实例，但未发现可访问的业务数据库。');
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDbs(false);
    }
  };

  const handleCreateDatabase = async () => {
    const clean = newDbName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(clean)) {
      setFormError(
        '数据库名须以字母或下划线开头，只能包含字母、数字、下划线，最长 63 字符。',
      );
      return;
    }
    setCreatingDb(true);
    setFormError('');
    setStatusNotice('');
    try {
      const msg = await terminalApi.createPostgresDatabase({
        connection: buildInput(
          editingConnection?.id ?? `db-create-${Date.now()}`,
        ),
        databaseName: clean,
      });
      setDatabase(clean);
      setNewDbName('');
      setShowCreateDb(false);
      setStatusNotice(`${msg} 已自动切换目标库为 ${clean}。`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingDb(false);
    }
  };

  const handleSubmit = async () => {
    if (isFileDb && !filePath.trim()) {
      setFormError('请指定数据库文件路径。');
      return;
    }
    if (!isFileDb && !host.trim()) {
      setFormError('请输入数据库主机地址。');
      return;
    }
    const parsedPort = Number(port);
    if (
      !isFileDb &&
      (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)
    ) {
      setFormError('端口必须是 1–65535 之间的整数。');
      return;
    }
    const parsedTimeout = Math.max(
      1,
      Math.min(600, Math.round(Number(timeoutSec) || 30)),
    );

    setFormError('');
    setStatusNotice('');
    setSubmitting(true);

    try {
      const primaryDb = isFileDb
        ? undefined
        : database.trim() || (dbType === 'postgres' ? 'postgres' : undefined);
      const extraDbs =
        !isEdit && dbType === 'postgres'
          ? Object.entries(selectedExtraDbs)
              .filter(([db, checked]) => checked && db !== primaryDb)
              .map(([db]) => db)
          : [];
      const targetDbs: Array<string | undefined> = [primaryDb, ...extraDbs];
      const savedBatch: DataLabDbConnection[] = [];
      let firstMessage = '';

      for (let i = 0; i < targetDbs.length; i += 1) {
        const dbTarget = targetDbs[i];
        const id =
          isEdit && editingConnection && i === 0
            ? editingConnection.id
            : `db-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 5)}`;

        const displayName =
          i === 0 && connName.trim()
            ? connName.trim()
            : isFileDb
              ? filePath.split(/[\\/]/).pop() || dbType.toUpperCase()
              : dbTarget
                ? `${dbTarget} (${host.trim()})`
                : `${dbType}://${host.trim()}`;

        const testRes = await terminalApi.testDbConnection({
          connection: {
            ...buildInput(id, dbTarget),
            name: displayName,
          },
        });
        if (!testRes.ok) {
          throw new Error(testRes.message);
        }
        if (i === 0) firstMessage = testRes.message;

        let hasPassword = Boolean(editingConnection?.hasPassword);
        if (!isFileDb) {
          if (password) {
            await terminalApi.saveDbPassword({
              connectionId: id,
              password,
            });
            hasPassword = true;
          } else if (i > 0 && savedBatch[0]?.id && savedBatch[0]?.hasPassword) {
            hasPassword = await terminalApi.copyDbPassword({
              sourceConnectionId: savedBatch[0].id,
              targetConnectionId: id,
            });
          } else if (!isEdit && pgpassMatch?.found) {
            hasPassword = false;
          }
        }

        savedBatch.push({
          id,
          name: displayName,
          dbType,
          filePath: isFileDb ? filePath.trim() : undefined,
          host: isFileDb ? undefined : host.trim(),
          port: isFileDb ? undefined : parsedPort,
          database: dbTarget,
          username: isFileDb ? undefined : username.trim() || undefined,
          hasPassword: !isFileDb && hasPassword,
          pythonPath:
            editingConnection?.pythonPath ?? preferredPythonPath ?? undefined,
          readOnly,
          sslMode: dbType === 'postgres' ? sslMode : undefined,
          statementTimeoutSec: parsedTimeout,
          tables: testRes.tables,
          customTypes: testRes.customTypes ?? [],
          lastTestedAt: Date.now(),
          lastStatus: `已连接 · ${testRes.engine}`,
        });
      }

      const finalMsg =
        savedBatch.length > 1
          ? `已成功连接并保存 ${savedBatch.length} 个数据库：${savedBatch.map((c) => c.database || c.name).join('、')}`
          : firstMessage || '数据库连接已保存。';
      onSaved(savedBatch, isEdit ? 'edit' : 'create', finalMsg);
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const diagnosis = formError ? diagnoseDatabaseError(formError, dbType) : null;
  const existingDbSet = new Set(
    existingConnections
      .filter(
        (c) =>
          c.dbType === 'postgres' &&
          (c.host || '127.0.0.1') === (host.trim() || '127.0.0.1') &&
          String(c.port ?? 5432) === String(Number(port) || 5432),
      )
      .map((c) => (c.database || '').toLowerCase()),
  );

  return (
    <div
      className="datalab-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="datalab-modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? '编辑数据库连接' : '新建数据库连接'}
      >
        <div className="datalab-modal-header">
          <div>
            <h3>{isEdit ? '编辑数据库连接' : '配置数据库连接'}</h3>
            <p className="datalab-modal-subtitle">
              默认启用会话级只读研究保护与服务端分页游标，安全探索百万行级数据库。
            </p>
          </div>
          <button
            type="button"
            className="datalab-modal-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="关闭窗口"
          >
            ×
          </button>
        </div>

        <div className="datalab-modal-body">
          {/* DB Engine Tabs */}
          <div className="datalab-modal-engine-tabs" role="tablist">
            {(
              [
                { id: 'postgres', label: 'PostgreSQL' },
                { id: 'duckdb', label: 'DuckDB' },
                { id: 'sqlite', label: 'SQLite' },
                { id: 'mysql', label: 'MySQL' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={dbType === item.id}
                className={`datalab-modal-engine-tab${dbType === item.id ? ' is-active' : ''}`}
                disabled={isEdit}
                onClick={() => {
                  setDbType(item.id);
                  setPort(item.id === 'mysql' ? '3306' : '5432');
                  if (item.id === 'postgres' && !database) {
                    setDatabase('postgres');
                  }
                  if (item.id === 'postgres' && !username) {
                    setUsername('postgres');
                  }
                  setFormError('');
                  setDiscoveredDbs([]);
                  setDbListNotice('');
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Quick URL Paste Import */}
          {!isEdit && (
            <div className="datalab-modal-url-box">
              <label
                className="datalab-field-label"
                htmlFor="datalab-url-import"
              >
                连接字符串快捷导入（可选）
              </label>
              <div className="datalab-modal-inline-row">
                <input
                  id="datalab-url-import"
                  type="text"
                  className="datalab-modal-input"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && urlDraft.trim()) {
                      e.preventDefault();
                      handleApplyUrl();
                    }
                  }}
                  placeholder="粘贴 postgresql://user:pass@127.0.0.1:5432/FED 一键解析…"
                />
                <button
                  type="button"
                  className="terminal-rail-mini-btn"
                  disabled={!urlDraft.trim()}
                  onClick={handleApplyUrl}
                >
                  解析填充
                </button>
              </div>
              {urlHint && <div className="datalab-modal-hint">{urlHint}</div>}
            </div>
          )}

          {/* Connection Name */}
          <div className="datalab-field-group">
            <label className="datalab-field-label" htmlFor="datalab-conn-name">
              连接名称（留空则自动以库名命名）
            </label>
            <input
              id="datalab-conn-name"
              type="text"
              className="datalab-modal-input"
              value={connName}
              onChange={(e) => setConnName(e.target.value)}
              placeholder={
                dbType === 'postgres'
                  ? '例如：FED 宏观数据库'
                  : '例如：本地科研库'
              }
            />
          </div>

          {isFileDb ? (
            <div className="datalab-field-group">
              <label
                className="datalab-field-label"
                htmlFor="datalab-file-path"
              >
                数据库文件路径
              </label>
              <div className="datalab-modal-inline-row">
                <input
                  id="datalab-file-path"
                  type="text"
                  className="datalab-modal-input"
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  placeholder={
                    dbType === 'duckdb'
                      ? '输入 .duckdb 路径或 :memory:'
                      : '输入 .db / .sqlite 文件路径'
                  }
                />
                <button
                  type="button"
                  className="terminal-rail-mini-btn"
                  onClick={() => void handleBrowseFile()}
                >
                  浏览文件
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="datalab-modal-grid-2-host">
                <div className="datalab-field-group">
                  <label className="datalab-field-label" htmlFor="datalab-host">
                    主机地址 (Host)
                  </label>
                  <input
                    id="datalab-host"
                    type="text"
                    className="datalab-modal-input"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="127.0.0.1"
                  />
                </div>
                <div className="datalab-field-group">
                  <label className="datalab-field-label" htmlFor="datalab-port">
                    端口 (Port)
                  </label>
                  <input
                    id="datalab-port"
                    type="text"
                    className="datalab-modal-input"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder={dbType === 'mysql' ? '3306' : '5432'}
                  />
                </div>
              </div>

              <div className="datalab-modal-grid-2">
                <div className="datalab-field-group">
                  <label className="datalab-field-label" htmlFor="datalab-user">
                    用户名 (User)
                  </label>
                  <input
                    id="datalab-user"
                    type="text"
                    className="datalab-modal-input"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={dbType === 'mysql' ? 'root' : 'postgres'}
                  />
                </div>
                <div className="datalab-field-group">
                  <div className="datalab-field-label-row">
                    <label
                      className="datalab-field-label"
                      htmlFor="datalab-pwd"
                    >
                      密码 (Password)
                    </label>
                    {isEdit && editingConnection?.hasPassword && !password && (
                      <span className="datalab-field-badge">
                        已存 Windows 凭据
                      </span>
                    )}
                    {!password && pgpassMatch?.found && (
                      <span
                        className="datalab-field-badge is-ok"
                        title={`匹配本机 ${pgpassMatch.path ?? 'pgpass.conf'}`}
                      >
                        已检测 pgpass
                      </span>
                    )}
                  </div>
                  <div className="datalab-pwd-wrap">
                    <input
                      id="datalab-pwd"
                      type={showPassword ? 'text' : 'password'}
                      className="datalab-modal-input"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={
                        isEdit && editingConnection?.hasPassword
                          ? '留空保留原密码，或输入新密码覆盖'
                          : pgpassMatch?.found
                            ? '留空自动使用本机 pgpass，或手动输入'
                            : '输入数据库密码（存入系统凭据管理器）'
                      }
                    />
                    <button
                      type="button"
                      className="datalab-pwd-toggle"
                      onClick={() => setShowPassword((v) => !v)}
                      title={showPassword ? '隐藏密码' : '显示密码'}
                    >
                      {showPassword ? '隐藏' : '显示'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Database Name + Live Discovery */}
              <div className="datalab-field-group">
                <div className="datalab-field-label-row">
                  <label
                    className="datalab-field-label"
                    htmlFor="datalab-database"
                  >
                    目标数据库名 (Database)
                  </label>
                  {dbType === 'postgres' && (
                    <div className="datalab-field-actions">
                      <button
                        type="button"
                        className="terminal-rail-mini-btn is-accent"
                        disabled={loadingDbs || submitting}
                        onClick={() => void handleLoadDatabases()}
                      >
                        {loadingDbs ? '正在读取实例库…' : '读取库列表'}
                      </button>
                      <button
                        type="button"
                        className="terminal-rail-mini-btn"
                        disabled={creatingDb || submitting}
                        onClick={() => setShowCreateDb((v) => !v)}
                      >
                        {showCreateDb ? '收起新建' : '+ 新建库'}
                      </button>
                    </div>
                  )}
                </div>
                <input
                  id="datalab-database"
                  type="text"
                  className="datalab-modal-input"
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  placeholder="例如：FED 或 postgres（PG 库名区分大小写）"
                />

                {dbListNotice && (
                  <div className="datalab-modal-hint">{dbListNotice}</div>
                )}

                {discoveredDbs.length > 0 && (
                  <div className="datalab-db-picker-list">
                    {discoveredDbs.map((entry) => {
                      const isPrimary = database.trim() === entry.name;
                      const isExtra = Boolean(selectedExtraDbs[entry.name]);
                      const alreadySaved = existingDbSet.has(
                        entry.name.toLowerCase(),
                      );
                      return (
                        <div
                          key={entry.name}
                          className={`datalab-db-picker-item${isPrimary ? ' is-primary' : ''}`}
                        >
                          <button
                            type="button"
                            className="datalab-db-picker-select"
                            onClick={() => {
                              setDatabase(entry.name);
                              if (!isEdit) {
                                setConnName(`${entry.name} (PG)`);
                              }
                            }}
                          >
                            <strong>{entry.name}</strong>
                            <span>
                              {entry.sizeBytes != null
                                ? formatFileSizeCompact(entry.sizeBytes)
                                : ''}
                              {entry.owner ? ` · ${entry.owner}` : ''}
                              {alreadySaved ? ' · 已存在' : ''}
                            </span>
                          </button>
                          {!isEdit && !isPrimary && (
                            <label className="datalab-db-picker-multi">
                              <input
                                type="checkbox"
                                checked={isExtra}
                                onChange={(e) =>
                                  setSelectedExtraDbs((prev) => ({
                                    ...prev,
                                    [entry.name]: e.target.checked,
                                  }))
                                }
                              />
                              <span>一并挂载</span>
                            </label>
                          )}
                          {isPrimary && (
                            <span className="datalab-db-picker-badge">
                              主目标库
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {showCreateDb && dbType === 'postgres' && (
                  <div className="datalab-modal-create-box">
                    <span>使用上方账户在实例中创建新数据库：</span>
                    <div className="datalab-modal-inline-row">
                      <input
                        type="text"
                        className="datalab-modal-input"
                        value={newDbName}
                        onChange={(e) => setNewDbName(e.target.value)}
                        placeholder="新数据库名（字母/数字/下划线）"
                      />
                      <button
                        type="button"
                        className="terminal-rail-mini-btn is-accent"
                        disabled={creatingDb}
                        onClick={() => void handleCreateDatabase()}
                      >
                        {creatingDb ? '创建中…' : '确认创建'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Read-only Safety & Advanced */}
          <div className="datalab-modal-safety-row">
            <label className="datalab-checkbox-label">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
              />
              <span>
                <strong>只读研究模式（推荐）</strong>
                <small>
                  在数据库会话层强制开启 READ ONLY，防止探索数据时误执行
                  DELETE/UPDATE/DROP
                </small>
              </span>
            </label>
            <button
              type="button"
              className="terminal-rail-mini-btn"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? '收起高级选项' : '高级选项'}
            </button>
          </div>

          {showAdvanced && (
            <div className="datalab-modal-advanced">
              <div className="datalab-modal-grid-2">
                {dbType === 'postgres' && (
                  <div className="datalab-field-group">
                    <label
                      className="datalab-field-label"
                      htmlFor="datalab-ssl"
                    >
                      SSL 连接模式
                    </label>
                    <select
                      id="datalab-ssl"
                      className="datalab-modal-input"
                      value={sslMode}
                      onChange={(e) => setSslMode(e.target.value as DbSslMode)}
                    >
                      {SSL_MODE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="datalab-field-group">
                  <label
                    className="datalab-field-label"
                    htmlFor="datalab-timeout"
                  >
                    单条 SQL 超时上限（秒，1–600）
                  </label>
                  <input
                    id="datalab-timeout"
                    type="number"
                    min={1}
                    max={600}
                    className="datalab-modal-input"
                    value={timeoutSec}
                    onChange={(e) => setTimeoutSec(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {statusNotice && (
            <div className="datalab-inline-success" role="status">
              {statusNotice}
            </div>
          )}

          {diagnosis && (
            <div className="datalab-diag-error" role="alert">
              <div className="datalab-diag-title">{diagnosis.title}</div>
              <div className="datalab-diag-raw">{diagnosis.detail}</div>
              <ul className="datalab-diag-tips">
                {diagnosis.suggestions.map((tip, idx) => (
                  <li key={idx}>{tip}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="datalab-modal-footer">
          <button
            type="button"
            className="terminal-rail-mini-btn"
            disabled={submitting}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="terminal-rail-mini-btn is-accent datalab-modal-primary"
            disabled={submitting}
            onClick={() => void handleSubmit()}
          >
            {submitting
              ? '正在测试并保存…'
              : isEdit
                ? '重新测试并保存修改'
                : '测试并保存连接'}
          </button>
        </div>
      </div>
    </div>
  );
}
