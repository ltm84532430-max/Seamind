import type { DataDbConnectionInput, DataDbTableSchema } from './terminal-api';
import {
  sanitizeDataAlias,
  type DataLabDbConnection,
  type DbSslMode,
} from './terminal-codelab-model';

export interface ParsedDatabaseUrl {
  dbType: DataLabDbConnection['dbType'];
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
  filePath?: string;
  sslMode?: DbSslMode;
  suggestedName?: string;
}

export interface DatabaseErrorDiagnosis {
  title: string;
  detail: string;
  suggestions: string[];
}

export interface SchemaTableGroup {
  schema: string;
  tables: DataDbTableSchema[];
}

const VALID_SSL_MODES = new Set<DbSslMode>([
  'prefer',
  'disable',
  'require',
  'verify-ca',
  'verify-full',
]);

export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl | null {
  const text = raw.trim().replace(/^["']|["']$/g, '');
  if (!text) return null;

  if (/^sqlite(?:3)?:\/\//i.test(text)) {
    const filePath = decodeURIComponent(
      text.replace(/^sqlite(?:3)?:\/\/\/?/i, ''),
    );
    const base =
      filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, '') || 'SQLite';
    return { dbType: 'sqlite', filePath, suggestedName: base };
  }

  if (/^duckdb:\/\//i.test(text)) {
    const filePath = decodeURIComponent(text.replace(/^duckdb:\/\/\/?/i, ''));
    const base =
      filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, '') || 'DuckDB';
    return { dbType: 'duckdb', filePath, suggestedName: base };
  }

  const normalized = text
    .replace(/^postgresql\+[^:]+:\/\//i, 'postgresql://')
    .replace(/^postgres:\/\//i, 'postgresql://')
    .replace(/^mysql\+[^:]+:\/\//i, 'mysql://');

  if (!/^(?:postgresql|mysql):\/\//i.test(normalized)) {
    return null;
  }

  try {
    const url = new URL(normalized);
    const dbType: DataLabDbConnection['dbType'] = url.protocol.startsWith(
      'mysql',
    )
      ? 'mysql'
      : 'postgres';
    const host = url.hostname || '127.0.0.1';
    const port = url.port || (dbType === 'mysql' ? '3306' : '5432');
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const username = url.username ? decodeURIComponent(url.username) : '';
    const password = url.password ? decodeURIComponent(url.password) : '';
    const rawSsl = url.searchParams.get('sslmode')?.trim().toLowerCase();
    const sslMode =
      rawSsl && VALID_SSL_MODES.has(rawSsl as DbSslMode)
        ? (rawSsl as DbSslMode)
        : undefined;
    const suggestedName = database
      ? `${database} (${host})`
      : `${dbType.toUpperCase()} · ${host}`;
    return {
      dbType,
      host,
      port,
      database,
      username,
      password,
      sslMode,
      suggestedName,
    };
  } catch {
    return null;
  }
}

export function diagnoseDatabaseError(
  rawError: string,
  dbType: DataLabDbConnection['dbType'],
): DatabaseErrorDiagnosis {
  const raw = (rawError || '').trim();
  const low = raw.toLowerCase();

  if (
    low.includes('password authentication failed') ||
    low.includes('fe_sendauth: no password supplied') ||
    low.includes('access denied for user')
  ) {
    return {
      title: '账户密码验证未通过',
      detail: raw,
      suggestions:
        dbType === 'postgres'
          ? [
              '核对当前用户名与 pgAdmin 中使用的密码是否一致（可点密码框右侧眼睛图标确认输入无空格或大小写偏差）。',
              '若本机配置了 %APPDATA%\\postgresql\\pgpass.conf，留空密码即可自动匹配；也可在 pgAdmin 中右键服务器查看连接属性。',
              '如果你要连接的是具体业务库（如 FED），先用正确密码点「读取库列表」再选择目标库。',
            ]
          : ['请检查用户名和密码是否正确，确认该用户有当前主机的访问权限。'],
    };
  }

  if (low.includes('database') && low.includes('does not exist')) {
    return {
      title: '目标数据库不存在',
      detail: raw,
      suggestions: [
        'PostgreSQL 库名区分大小写（例如 FED 与 fed 不同）。',
        '请点击「读取库列表」拉取该实例中真实存在的全部数据库并直接点选。',
      ],
    };
  }

  if (low.includes('role') && low.includes('does not exist')) {
    return {
      title: '数据库用户名（角色）不存在',
      detail: raw,
      suggestions: [
        'PostgreSQL 默认管理员用户名通常为 postgres，请核对是否与安装时设置一致。',
      ],
    };
  }

  if (
    low.includes('connection refused') ||
    low.includes('could not connect to server') ||
    low.includes('actively refused') ||
    low.includes('timed out') ||
    low.includes('timeout expired')
  ) {
    return {
      title: '无法连接到数据库端口',
      detail: raw,
      suggestions: [
        '确认本机 PostgreSQL / MySQL 服务正在运行（可点「查找本机 PG」一键启动）。',
        '核对主机地址（127.0.0.1 / localhost）与端口号（PostgreSQL 默认 5432，MySQL 默认 3306）。',
      ],
    };
  }

  if (
    low.includes('未检测到 postgresql 驱动') ||
    low.includes('no module named') ||
    low.includes('未检测到 duckdb') ||
    low.includes('未检测到 mysql 驱动')
  ) {
    return {
      title: '当前 Python 环境缺少数据库驱动',
      detail: raw,
      suggestions: [
        dbType === 'postgres'
          ? '请在「环境」面板检查当前固定的 Anaconda 环境，并在终端安装：pip install "psycopg[binary]"（或 psycopg2-binary）。'
          : dbType === 'duckdb'
            ? '请在当前 Anaconda 环境安装：pip install duckdb。'
            : '请在当前 Anaconda 环境安装：pip install pymysql。',
      ],
    };
  }

  if (low.includes('read-only transaction') || low.includes('只读研究模式')) {
    return {
      title: '已启用只读研究保护，写入操作已阻止',
      detail: raw,
      suggestions: [
        '当前连接处于只读模式（防误删/误改数据）。如需执行建表或修改语句，可在连接编辑弹层中关闭「只读研究模式」。',
      ],
    };
  }

  if (low.includes('ssl') || low.includes('tls')) {
    return {
      title: 'SSL / TLS 握手失败',
      detail: raw,
      suggestions: [
        '本机开发环境可将高级选项中的 SSL 模式切换为 disable 或 prefer 后重试。',
      ],
    };
  }

  return {
    title: '数据库连接或执行失败',
    detail: raw || '未知错误',
    suggestions: ['请检查连接参数、数据库服务状态与当前选中的 Python 环境。'],
  };
}

export function formatEstimatedRows(rows: number | null | undefined): string {
  if (rows == null || !Number.isFinite(rows) || rows < 0) return '';
  if (rows >= 1_000_000) return `~${(rows / 1_000_000).toFixed(2)}M 行`;
  if (rows >= 10_000) return `~${(rows / 1_000).toFixed(1)}k 行`;
  return `${Math.round(rows).toLocaleString()} 行`;
}

export function groupTablesBySchema(
  tables: readonly DataDbTableSchema[],
  filterQuery: string,
): SchemaTableGroup[] {
  const q = filterQuery.trim().toLowerCase();
  const filtered = q
    ? tables.filter((tbl) => {
        const full = `${tbl.schema ?? ''}.${tbl.name}`.toLowerCase();
        if (full.includes(q)) return true;
        if (tbl.comment && tbl.comment.toLowerCase().includes(q)) return true;
        return tbl.columns.some((c) => c.name.toLowerCase().includes(q));
      })
    : [...tables];

  const bySchema = new Map<string, DataDbTableSchema[]>();
  for (const tbl of filtered) {
    const schema = (tbl.schema || 'default').trim() || 'default';
    const list = bySchema.get(schema);
    if (list) list.push(tbl);
    else bySchema.set(schema, [tbl]);
  }

  return Array.from(bySchema.entries())
    .sort(([a], [b]) => {
      if (a === 'public' && b !== 'public') return 1;
      if (b === 'public' && a !== 'public') return -1;
      return a.localeCompare(b);
    })
    .map(([schema, list]) => ({
      schema,
      tables: list.sort((x, y) => {
        const rx = x.estimatedRows ?? x.rowCount ?? -1;
        const ry = y.estimatedRows ?? y.rowCount ?? -1;
        if (rx !== ry) return ry - rx;
        return x.name.localeCompare(y.name);
      }),
    }));
}

export function quoteQualifiedTable(
  tableName: string,
  schema: string | null | undefined,
  dbType: DataLabDbConnection['dbType'],
): string {
  const escDouble = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const escBacktick = (s: string) => `\`${s.replace(/`/g, '``')}\``;
  if (dbType === 'mysql') {
    return schema
      ? `${escBacktick(schema)}.${escBacktick(tableName)}`
      : escBacktick(tableName);
  }
  if (schema && schema !== 'main' && schema !== 'default') {
    return `${escDouble(schema)}.${escDouble(tableName)}`;
  }
  return escDouble(tableName);
}

export function buildTableSelectSql(
  tableName: string,
  schema: string | null | undefined,
  dbType: DataLabDbConnection['dbType'],
  limit = 100,
): string {
  const qualified = quoteQualifiedTable(tableName, schema, dbType);
  return `SELECT *\nFROM ${qualified}\nLIMIT ${limit};`;
}

export function buildTablePythonSnippet(
  conn: DataLabDbConnection,
  tableName: string,
  schema: string | null | undefined,
  limit = 10000,
): string {
  const qualified = quoteQualifiedTable(tableName, schema, conn.dbType);
  const varName = `df_${sanitizeDataAlias(tableName)}`;
  const connRef = JSON.stringify(conn.name);
  return `# 安全只读直连数据库（无需明文密码）\n${varName} = sm_db_query(\n    ${connRef},\n    """\n    SELECT *\n    FROM ${qualified}\n    LIMIT ${limit}\n    """,\n)\nprint(${varName}.shape)\n${varName}.head(10)`;
}

export function buildTableRSnippet(
  conn: DataLabDbConnection,
  tableName: string,
  schema: string | null | undefined,
  limit = 10000,
): string {
  const qualified = quoteQualifiedTable(tableName, schema, conn.dbType);
  const varName = `df_${sanitizeDataAlias(tableName)}`;
  const connRef = JSON.stringify(conn.name);
  return `# 安全只读直连数据库（经由 Seamind Parquet 总线，无需明文密码）\n${varName} <- sm_db_query(\n  ${connRef},\n  'SELECT * FROM ${qualified} LIMIT ${limit}'\n)\nstr(${varName})\nhead(${varName}, 10)`;
}

export function buildFederatedJoinSql(
  conn: DataLabDbConnection,
  tableName: string,
  schema: string | null | undefined,
  localAlias?: string,
): string {
  const dbAlias = sanitizeDataAlias(conn.database || conn.name || 'db');
  const sch = schema && schema !== 'main' ? `"${schema}".` : '';
  const target = `"${dbAlias}".${sch}"${tableName}"`;
  if (localAlias) {
    return `-- DuckDB 联邦只读查询：同时访问 PostgreSQL (${conn.name}) 与本地文件 (${localAlias})\nSELECT *\nFROM ${target} AS db_tbl\nLIMIT 50;\n-- 示例联合：SELECT * FROM ${target} AS db_tbl JOIN "${localAlias}" AS local_tbl ON ... LIMIT 50;`;
  }
  return `-- DuckDB 联邦只读查询：访问已挂载库 ${conn.name}\nSELECT *\nFROM ${target}\nLIMIT 50;`;
}

export function buildConnectionInput(
  conn: DataLabDbConnection,
  fallbackPythonPath?: string | null,
  overridePassword?: string | null,
): DataDbConnectionInput {
  return {
    id: conn.id,
    name: conn.name,
    dbType: conn.dbType,
    filePath: conn.filePath ?? null,
    host: conn.host ?? null,
    port: conn.port ?? null,
    database: conn.database ?? null,
    username: conn.username ?? null,
    password: overridePassword ?? null,
    pythonPath: conn.pythonPath ?? fallbackPythonPath ?? null,
    readOnly: conn.readOnly ?? true,
    sslMode: conn.sslMode ?? 'prefer',
    statementTimeoutSec: conn.statementTimeoutSec ?? 30,
  };
}
