import { getCodeLabLiveBridge } from '../../terminal/codelab-live-bridge';
import {
  terminalApi,
  type DataDbConnectionInput,
} from '../../terminal/terminal-api';
import {
  CODELAB_AGENT_PUSH_EVENT,
  formatTableToMarkdown,
  loadCodeLabCollection,
  loadCustomEnvPaths,
  loadDataLabBaseProfile,
  loadDataLabConnections,
  loadDataLabFiles,
  readCodeLabNotebookSnapshot,
  type CodeLabAgentPushPayload,
} from '../../terminal/terminal-codelab-model';
import type { TerminalCodeLabLanguage } from '../../terminal/terminal-types';
import type { AgentToolResult, ToolHandler } from '../tool-api';
import type { AgentToolDescriptor } from '../types';
import { assertOnlyKeys, requireString, schema } from './parse';

const ALLOWED_CELL_LANGUAGES = [
  'python',
  'sql',
  'r',
  'c',
  'cpp',
  'markdown',
] as const;

type CellLanguageArg = (typeof ALLOWED_CELL_LANGUAGES)[number];

function parseOptionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength = 500,
): string | undefined {
  const raw = input[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function parseOptionalPositiveInt(
  input: Record<string, unknown>,
  key: string,
  max = 10_000,
): number | undefined {
  const raw = input[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const n = Math.floor(raw);
  if (n < 1 || n > max) return undefined;
  return n;
}

function isCellLanguageArg(value: string): value is CellLanguageArg {
  return (ALLOWED_CELL_LANGUAGES as readonly string[]).includes(value);
}

export const datalabToolCatalog: AgentToolDescriptor[] = [
  {
    version: 1,
    name: 'code_run_python',
    description:
      '在用户固定的默认 Python/Anaconda 基座（持久会话，自动预注入 sm_load/sm_save/sm_sql/SEAMIND_FILES 与中文字体）中执行 Python 代码，返回 stdout/stderr、表达式结果、活跃变量及保存的图表文件路径。',
    permission: 'read',
    inputSchema: schema(
      {
        code: {
          type: 'string',
          minLength: 1,
          maxLength: 16_000,
          description: '待执行的 Python 源码',
        },
        condaEnv: {
          type: 'string',
          maxLength: 120,
          description: '可选：覆盖默认基座，指定 Anaconda 环境名（如 base）',
        },
        pythonPath: {
          type: 'string',
          maxLength: 500,
          description: '可选：覆盖默认基座，指定本地 python.exe 绝对路径',
        },
        resetSession: {
          type: 'boolean',
          description: '可选：设为 true 以清空持久 Python 会话变量',
        },
      },
      ['code'],
    ),
  },
  {
    version: 1,
    name: 'datalab_list_sources',
    description:
      '获取数据实验室的永久默认基座配置（指定 Python/R 路径、默认数据库与稳定库基线）、跨语言共享数据总线（Parquet 中间表与图表产物）、已挂载数据文件（CSV/Parquet/JSON/Excel）、数据库连接及实验本清单。',
    permission: 'read',
    inputSchema: schema({
      includeEnvs: {
        type: 'boolean',
        description: '是否同时扫描本地 Anaconda/Python 与 R 环境（默认 true）',
      },
    }),
  },
  {
    version: 1,
    name: 'datalab_inspect_file',
    description:
      '探查本地数据文件（CSV/TSV/Parquet/JSON/JSONL/Excel/SQLite）的完整字段 Schema、类型、总行数与前若干行数据预览。支持传文件绝对路径或已挂载别名。',
    permission: 'read',
    inputSchema: schema(
      {
        pathOrAlias: {
          type: 'string',
          minLength: 1,
          maxLength: 600,
          description: '文件绝对路径，或左侧「数据」面板中已挂载的文件别名',
        },
        maxRows: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
        },
        pythonPath: {
          type: 'string',
          maxLength: 500,
        },
      },
      ['pathOrAlias'],
    ),
  },
  {
    version: 1,
    name: 'datalab_query_sql',
    description:
      '使用 SQL 检索已挂载文件、会话共享总线表或已连接的 SQLite/DuckDB/PostgreSQL/MySQL 数据库；可选通过 saveAsTable 将完整结果写入跨语言 Parquet 总线供 Python/R 调用 sm_load() 读取。',
    permission: 'read',
    inputSchema: schema(
      {
        sql: {
          type: 'string',
          minLength: 1,
          maxLength: 16_000,
          description: '待执行的 SQL 语句',
        },
        connectionId: {
          type: 'string',
          maxLength: 160,
          description:
            '可选：数据库连接 ID 或名称；留空则使用本地文件/总线或默认基座数据库',
        },
        saveAsTable: {
          type: 'string',
          maxLength: 80,
          description:
            '可选：将全量查询结果保存为共享总线表名（Python/R 可立即 sm_load）',
        },
        maxRows: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
        },
        pythonPath: {
          type: 'string',
          maxLength: 500,
        },
      },
      ['sql'],
    ),
  },
  {
    version: 1,
    name: 'datalab_run_r',
    description:
      '在用户固定的默认 R 基座（持久会话，自动预注入 sm_load/sm_save/sm_tables 与中文字体）中执行 R 统计与绘图代码，返回 stdout、data.frame 表格、变量摘要及保存的图表路径。',
    permission: 'read',
    inputSchema: schema(
      {
        code: {
          type: 'string',
          minLength: 1,
          maxLength: 16_000,
          description: '待执行的 R 语言源码',
        },
        rscriptPath: {
          type: 'string',
          maxLength: 500,
          description: '可选：覆盖默认基座，指定 Rscript 可执行文件路径',
        },
        resetSession: {
          type: 'boolean',
          description: '可选：设为 true 以清空持久 R 会话变量',
        },
      },
      ['code'],
    ),
  },
  {
    version: 1,
    name: 'datalab_read_notebook',
    description:
      '实时读取当前可见（或指定标题/ID）的代码实验本中所有单元格与复合分析区块，返回每个格子的 cellId、index（从 1 开始）、groupId、groupTitle、语言、源码、运行状态与输出。修改或运行左侧代码块前先调用此工具获取 cellId/groupId。',
    permission: 'read',
    inputSchema: schema({
      fileId: { type: 'string', maxLength: 160 },
      title: { type: 'string', maxLength: 200 },
    }),
  },
  {
    version: 1,
    name: 'datalab_push_cell',
    description:
      '向当前可见的代码实验本窗口追加一个新单元格或嵌套语言分区（支持 sql / python / r / c / cpp / markdown），等待写入并返回真实的 cellId 与 cellIndex；传相同的 groupId 与 groupTitle 会归入同一个「复合分析区块」。若要原地修改已有代码格，请改用 datalab_update_cell。',
    permission: 'read',
    inputSchema: schema(
      {
        language: {
          type: 'string',
          enum: ['python', 'sql', 'r', 'c', 'cpp', 'markdown'],
        },
        source: {
          type: 'string',
          minLength: 1,
          maxLength: 20_000,
          description: '单元格源码或 Markdown 文本',
        },
        autoRun: {
          type: 'boolean',
          description: '插入后是否立即执行并等待返回输出（默认 false）',
        },
        sqlConnectionId: {
          type: 'string',
          maxLength: 160,
          description: '仅 sql 单元格：可选指定目标数据库连接 ID',
        },
        sqlResultVar: {
          type: 'string',
          maxLength: 80,
          description: '仅 sql 单元格：可选自动写入共享总线的表/变量名',
        },
        groupId: {
          type: 'string',
          maxLength: 80,
          description:
            '可选：复合分析区块 ID，相同 groupId 的 SQL/Python/R/Markdown 会嵌套在同一个分析区块内',
        },
        groupTitle: {
          type: 'string',
          maxLength: 120,
          description: '可选：复合分析区块标题',
        },
        afterCellId: {
          type: 'string',
          maxLength: 120,
          description: '可选：插入到指定 cellId 之后',
        },
        fileId: { type: 'string', maxLength: 160 },
        title: { type: 'string', maxLength: 200 },
      },
      ['language', 'source'],
    ),
  },
  {
    version: 1,
    name: 'datalab_update_cell',
    description:
      '原地修改/填充当前可见实验本中已有的代码块或复合分析区块内的指定分区。可通过 cellId、cellIndex（从 1 开始）或 groupId + matchLanguage 精准定位目标格，支持更新源码、语言、SQL 绑定与归属区块，并可设 autoRun=true 立即运行并拿回真实结果。',
    permission: 'read',
    inputSchema: schema({
      cellId: {
        type: 'string',
        maxLength: 120,
        description: '目标单元格 ID（来自 datalab_read_notebook）',
      },
      cellIndex: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
        description: '可选：按 1-based 序号定位目标单元格',
      },
      groupId: {
        type: 'string',
        maxLength: 80,
        description:
          '可选：按复合分析区块 ID 定位（可配合 matchLanguage 指定其中的 sql/python/r/markdown 分区）',
      },
      matchLanguage: {
        type: 'string',
        enum: ['python', 'sql', 'r', 'c', 'cpp', 'markdown'],
        description: '可选：与 groupId 搭配，锁定该区块内的指定语言分区',
      },
      source: {
        type: 'string',
        maxLength: 20_000,
        description: '新的单元格源码或 Markdown 注释内容',
      },
      language: {
        type: 'string',
        enum: ['python', 'sql', 'r', 'c', 'cpp', 'markdown'],
        description: '可选：切换目标单元格的语言或转为 markdown',
      },
      sqlConnectionId: { type: 'string', maxLength: 160 },
      sqlResultVar: { type: 'string', maxLength: 80 },
      newGroupId: { type: 'string', maxLength: 80 },
      newGroupTitle: { type: 'string', maxLength: 120 },
      autoRun: {
        type: 'boolean',
        description: '修改后是否立即运行该格并等待返回真实输出（默认 false）',
      },
      fileId: { type: 'string', maxLength: 160 },
      title: { type: 'string', maxLength: 200 },
    }),
  },
  {
    version: 1,
    name: 'datalab_run_cell',
    description:
      '直接运行当前可见实验本中的单个代码块（cellId / cellIndex）、整块复合分析区块（groupId，按分区顺序执行并自动激活虚拟环境）或全部单元格（runAll=true），等待执行完成并返回真实输出、表格、图表与报错信息。',
    permission: 'read',
    inputSchema: schema({
      cellId: { type: 'string', maxLength: 120 },
      cellIndex: { type: 'integer', minimum: 1, maximum: 1000 },
      groupId: {
        type: 'string',
        maxLength: 80,
        description: '按复合分析区块 ID 顺序运行该区块内全部代码分区',
      },
      runAll: {
        type: 'boolean',
        description: '设为 true 时从上到下运行整个实验本',
      },
      fileId: { type: 'string', maxLength: 160 },
      title: { type: 'string', maxLength: 200 },
    }),
  },
  {
    version: 1,
    name: 'datalab_delete_cell',
    description:
      '删除当前可见实验本中的指定单元格（cellId / cellIndex）或清理整个复合分析区块（groupId）。',
    permission: 'read',
    inputSchema: schema({
      cellId: { type: 'string', maxLength: 120 },
      cellIndex: { type: 'integer', minimum: 1, maximum: 1000 },
      groupId: { type: 'string', maxLength: 80 },
      fileId: { type: 'string', maxLength: 160 },
      title: { type: 'string', maxLength: 200 },
    }),
  },
];

export const DATALAB_TOOL_NAMES = datalabToolCatalog.map((tool) => tool.name);

let sharedAgentPyKernel: {
  kernelId: string;
  pythonPath: string | null;
} | null = null;

let sharedAgentRKernel: {
  kernelId: string;
  rscriptPath: string | null;
} | null = null;

async function syncAgentDataBusContext() {
  const baseProfile = loadDataLabBaseProfile();
  const files = loadDataLabFiles();
  const conns = loadDataLabConnections();
  return terminalApi
    .syncDataBusContext({
      sessionId: 'default',
      mountedFiles: files.map((f) => ({
        alias: f.alias,
        path: f.path,
        format: f.format,
      })),
      dbConnections: conns.map((c) => ({
        id: c.id,
        name: c.name,
        dbType: c.dbType,
        filePath: c.filePath ?? null,
        host: c.host ?? null,
        port: c.port ?? null,
        database: c.database ?? null,
        username: c.username ?? null,
      })),
      defaultPythonPath:
        baseProfile.pythonPath && baseProfile.pythonPath !== 'pyodide'
          ? baseProfile.pythonPath
          : null,
      defaultRscriptPath: baseProfile.rscriptPath || null,
      defaultConnectionId: baseProfile.defaultConnectionId || null,
    })
    .catch(() => null);
}

export const datalabHandlers: Record<string, ToolHandler> = {
  async code_run_python(input, capabilities): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['code', 'condaEnv', 'pythonPath', 'resetSession']);
    const code = requireString(input, 'code', 16_000);
    const condaEnv = parseOptionalString(input, 'condaEnv', 120);
    const explicitPath = parseOptionalString(input, 'pythonPath', 500);
    const resetSession = input.resetSession === true;

    const baseProfile = loadDataLabBaseProfile();
    const pinnedPython =
      baseProfile.pythonPath && baseProfile.pythonPath !== 'pyodide'
        ? baseProfile.pythonPath
        : null;

    if (
      !condaEnv &&
      !explicitPath &&
      !pinnedPython &&
      capabilities.runPythonSnippet
    ) {
      const result = await capabilities.runPythonSnippet({ code });
      return {
        version: 1,
        permission: 'read',
        name: 'code_run_python',
        label: '执行 Python 实验',
        summary: '已完成 Python 代码执行',
        result,
      };
    }

    let targetPythonPath: string | null = explicitPath ?? null;
    if (!targetPythonPath && condaEnv) {
      const custom = loadCustomEnvPaths();
      const envs = await terminalApi
        .detectPythonEnvs({ extraPaths: custom.pythonPaths })
        .catch(() => []);
      const matched = envs.find(
        (e) =>
          e.condaEnvName?.toLowerCase() === condaEnv.toLowerCase() ||
          e.label.toLowerCase().includes(condaEnv.toLowerCase()),
      );
      if (!matched) {
        throw new Error(
          `未找到名为 "${condaEnv}" 的 Anaconda/Python 环境。可用环境：${envs.map((e) => e.condaEnvName || e.label).join(', ') || '无'}`,
        );
      }
      targetPythonPath = matched.pythonPath;
    }
    if (!targetPythonPath) {
      targetPythonPath = pinnedPython;
    }
    if (!targetPythonPath) {
      const custom = loadCustomEnvPaths();
      const envs = await terminalApi
        .detectPythonEnvs({ extraPaths: custom.pythonPaths })
        .catch(() => []);
      const best =
        envs.find((e) => e.hasPandas || e.hasDuckdb || e.hasPyarrow) ?? envs[0];
      targetPythonPath = best?.pythonPath ?? null;
    }

    const busInfo = await syncAgentDataBusContext();

    if (
      sharedAgentPyKernel &&
      sharedAgentPyKernel.pythonPath !== targetPythonPath
    ) {
      await terminalApi
        .closePythonKernel({ kernelId: sharedAgentPyKernel.kernelId })
        .catch(() => undefined);
      sharedAgentPyKernel = null;
    }

    if (!sharedAgentPyKernel) {
      const kernelId = await terminalApi.startPythonKernel({
        pythonPath: targetPythonPath,
        sessionId: 'default',
      });
      sharedAgentPyKernel = { kernelId, pythonPath: targetPythonPath };
    } else if (resetSession) {
      await terminalApi
        .resetPythonKernel({ kernelId: sharedAgentPyKernel.kernelId })
        .catch(() => {
          sharedAgentPyKernel = null;
        });
      if (!sharedAgentPyKernel) {
        const kernelId = await terminalApi.startPythonKernel({
          pythonPath: targetPythonPath,
          sessionId: 'default',
        });
        sharedAgentPyKernel = { kernelId, pythonPath: targetPythonPath };
      }
    }

    let res;
    try {
      res = await terminalApi.evalPythonKernel({
        kernelId: sharedAgentPyKernel.kernelId,
        code,
      });
    } catch {
      const kernelId = await terminalApi.startPythonKernel({
        pythonPath: targetPythonPath,
        sessionId: 'default',
      });
      sharedAgentPyKernel = { kernelId, pythonPath: targetPythonPath };
      res = await terminalApi.evalPythonKernel({ kernelId, code });
    }

    return {
      version: 1,
      permission: 'read',
      name: 'code_run_python',
      label: condaEnv ? `执行 Python (${condaEnv})` : '执行 Python 基座',
      summary: res.ok
        ? `Python 执行完成（${res.durationMs}ms${res.savedImages.length > 0 ? ` · ${res.savedImages.length} 张图表` : ''}）`
        : `Python 执行出错：${(res.error ?? 'error').slice(0, 80)}`,
      result: {
        ok: res.ok,
        pythonPath: targetPythonPath,
        stdout: res.stdout.slice(0, 12_000),
        stderr: res.stderr.slice(0, 4_000),
        resultText: res.resultText.slice(0, 8_000),
        htmlCount: res.htmls.length,
        imageCount: res.images.length,
        savedImages: res.savedImages,
        busDir: busInfo?.busDir ?? null,
        variables: res.variables.slice(0, 32),
        error: res.error ?? null,
        durationMs: res.durationMs,
      },
    };
  },

  async datalab_list_sources(input): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['includeEnvs']);
    const includeEnvs = input.includeEnvs !== false;
    const baseProfile = loadDataLabBaseProfile();
    const files = loadDataLabFiles();
    const connections = loadDataLabConnections().map((c) => ({
      id: c.id,
      name: c.name,
      dbType: c.dbType,
      filePath: c.filePath ?? null,
      host: c.host ?? null,
      port: c.port ?? null,
      database: c.database ?? null,
      username: c.username ?? null,
      lastStatus: c.lastStatus ?? null,
      tables: (c.tables ?? []).slice(0, 40).map((t) => ({
        name: t.name,
        schema: t.schema ?? null,
        rowCount: t.rowCount ?? null,
        columns: t.columns.slice(0, 40),
      })),
    }));
    const notebooks = loadCodeLabCollection()
      .slice(0, 30)
      .map((nb) => ({
        id: nb.id,
        title: nb.title,
        folder: nb.folder,
        language: nb.language,
        cellCount: nb.cells.length,
        updatedAt: nb.updatedAt,
      }));

    const sessionBus = await syncAgentDataBusContext();

    let pythonEnvs: unknown[] = [];
    let rEnvs: unknown[] = [];
    if (includeEnvs) {
      const custom = loadCustomEnvPaths();
      const extraPy = [
        ...custom.pythonPaths,
        ...(baseProfile.pythonPath && baseProfile.pythonPath !== 'pyodide'
          ? [baseProfile.pythonPath]
          : []),
      ];
      const extraR = [
        ...custom.rPaths,
        ...(baseProfile.rscriptPath ? [baseProfile.rscriptPath] : []),
      ];
      const [pyRes, rRes] = await Promise.allSettled([
        terminalApi.detectPythonEnvs({ extraPaths: extraPy }),
        terminalApi.detectREnvs({ extraPaths: extraR }),
      ]);
      if (pyRes.status === 'fulfilled') pythonEnvs = pyRes.value;
      if (rRes.status === 'fulfilled') rEnvs = rRes.value;
    }

    return {
      version: 1,
      permission: 'read',
      name: 'datalab_list_sources',
      label: '读取数据底座、总线与源',
      summary: `文件 ${files.length} · 数据库 ${connections.length} · 共享表 ${sessionBus?.tables.length ?? 0} · 图表 ${sessionBus?.artifacts.length ?? 0}`,
      result: {
        baseProfile,
        sessionBus,
        helpersHint:
          'Python 与 R 持久会话已预注入 sm_load(name), sm_save(name, df), sm_tables(), sm_files() 与 SEAMIND_FILES（Python 另含 sm_sql(query)）；SQL 工具可传 saveAsTable 写入同一 Parquet 总线。',
        mountedFiles: files,
        dbConnections: connections,
        pythonEnvs,
        rEnvs,
        notebooks,
      },
    };
  },

  async datalab_inspect_file(input): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['pathOrAlias', 'maxRows', 'pythonPath']);
    const rawTarget = requireString(input, 'pathOrAlias', 600);
    const maxRows =
      typeof input.maxRows === 'number' && Number.isFinite(input.maxRows)
        ? Math.max(1, Math.min(100, Math.floor(input.maxRows)))
        : 20;
    const baseProfile = loadDataLabBaseProfile();
    const pythonPath =
      parseOptionalString(input, 'pythonPath', 500) ??
      (baseProfile.pythonPath && baseProfile.pythonPath !== 'pyodide'
        ? baseProfile.pythonPath
        : null);

    const mounted = loadDataLabFiles();
    const byAlias = mounted.find(
      (f) => f.alias.toLowerCase() === rawTarget.toLowerCase(),
    );
    const resolvedPath = byAlias ? byAlias.path : rawTarget;

    const info = await terminalApi.inspectDataFile({
      path: resolvedPath,
      pythonPath,
      maxRows,
    });
    const markdownTable = formatTableToMarkdown(
      info.columns,
      info.previewRows.slice(0, 30),
    );
    return {
      version: 1,
      permission: 'read',
      name: 'datalab_inspect_file',
      label: `探查数据文件 · ${info.fileName}`,
      summary: `${info.format.toUpperCase()} · ${info.columns.length} 列${info.rowCount != null ? ` · ${info.rowCount} 行` : ''} (${info.engine})`,
      result: {
        ...info,
        alias: byAlias?.alias ?? null,
        markdownTable,
      },
    };
  },

  async datalab_query_sql(input): Promise<AgentToolResult> {
    assertOnlyKeys(input, [
      'sql',
      'connectionId',
      'saveAsTable',
      'maxRows',
      'pythonPath',
    ]);
    const sql = requireString(input, 'sql', 16_000);
    const baseProfile = loadDataLabBaseProfile();
    const rawConnRef = parseOptionalString(input, 'connectionId', 160) ?? '';
    const saveAsTable = parseOptionalString(input, 'saveAsTable', 80) ?? null;
    const maxRows =
      typeof input.maxRows === 'number' && Number.isFinite(input.maxRows)
        ? Math.max(1, Math.min(500, Math.floor(input.maxRows)))
        : 100;
    const pythonPath =
      parseOptionalString(input, 'pythonPath', 500) ??
      (baseProfile.pythonPath && baseProfile.pythonPath !== 'pyodide'
        ? baseProfile.pythonPath
        : null);

    const savedFiles = loadDataLabFiles();
    const savedConns = loadDataLabConnections();
    const effectiveConnRef =
      rawConnRef ||
      (savedFiles.length === 0 ? baseProfile.defaultConnectionId : '');
    const matchedConn = effectiveConnRef
      ? savedConns.find(
          (c) =>
            c.id === effectiveConnRef ||
            c.name.toLowerCase() === effectiveConnRef.toLowerCase(),
        )
      : undefined;
    if (rawConnRef && !matchedConn) {
      throw new Error(
        `未找到数据库连接 "${rawConnRef}"。可用连接：${savedConns.map((c) => `${c.name} (${c.id})`).join(', ') || '无'}`,
      );
    }

    const connPayload: DataDbConnectionInput | null = matchedConn
      ? {
          id: matchedConn.id,
          name: matchedConn.name,
          dbType: matchedConn.dbType,
          filePath: matchedConn.filePath ?? null,
          host: matchedConn.host ?? null,
          port: matchedConn.port ?? null,
          database: matchedConn.database ?? null,
          username: matchedConn.username ?? null,
          password: null,
          pythonPath: matchedConn.pythonPath ?? pythonPath,
        }
      : null;

    const mountedFiles = connPayload
      ? []
      : savedFiles.map((f) => ({
          alias: f.alias,
          path: f.path,
          format: f.format,
        }));

    const res = await terminalApi.querySql({
      sql,
      connection: connPayload,
      mountedFiles,
      pythonPath,
      maxRows,
      exportBusTable: saveAsTable,
      sessionId: 'default',
    });
    const markdownTable =
      res.ok && res.columns.length > 0
        ? formatTableToMarkdown(res.columns, res.rows.slice(0, 50))
        : '';

    return {
      version: 1,
      permission: 'read',
      name: 'datalab_query_sql',
      label: `SQL 查询 · ${res.engine}`,
      summary: res.ok
        ? `返回 ${res.rows.length} 行 × ${res.columns.length} 列（${res.durationMs}ms${res.busTablePath ? ` · 已写入总线 ${saveAsTable}` : ''}）`
        : `SQL 执行失败：${(res.error ?? '').slice(0, 80)}`,
      result: {
        ...res,
        savedBusTable: res.busTablePath ? saveAsTable : null,
        markdownTable,
      },
    };
  },

  async datalab_run_r(input): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['code', 'rscriptPath', 'resetSession']);
    const code = requireString(input, 'code', 16_000);
    const resetSession = input.resetSession === true;
    const baseProfile = loadDataLabBaseProfile();
    const targetRPath =
      parseOptionalString(input, 'rscriptPath', 500) ??
      (baseProfile.rscriptPath || null);

    const busInfo = await syncAgentDataBusContext();

    if (sharedAgentRKernel && sharedAgentRKernel.rscriptPath !== targetRPath) {
      await terminalApi
        .closeRKernel({ kernelId: sharedAgentRKernel.kernelId })
        .catch(() => undefined);
      sharedAgentRKernel = null;
    }

    if (!sharedAgentRKernel) {
      const kernelId = await terminalApi.startRKernel({
        rscriptPath: targetRPath,
        sessionId: 'default',
      });
      sharedAgentRKernel = { kernelId, rscriptPath: targetRPath };
    } else if (resetSession) {
      await terminalApi
        .resetRKernel({ kernelId: sharedAgentRKernel.kernelId })
        .catch(() => {
          sharedAgentRKernel = null;
        });
      if (!sharedAgentRKernel) {
        const kernelId = await terminalApi.startRKernel({
          rscriptPath: targetRPath,
          sessionId: 'default',
        });
        sharedAgentRKernel = { kernelId, rscriptPath: targetRPath };
      }
    }

    let res;
    try {
      res = await terminalApi.evalRKernel({
        kernelId: sharedAgentRKernel.kernelId,
        code,
      });
    } catch {
      const kernelId = await terminalApi.startRKernel({
        rscriptPath: targetRPath,
        sessionId: 'default',
      });
      sharedAgentRKernel = { kernelId, rscriptPath: targetRPath };
      res = await terminalApi.evalRKernel({ kernelId, code });
    }

    return {
      version: 1,
      permission: 'read',
      name: 'datalab_run_r',
      label: '执行 R 统计基座',
      summary: res.ok
        ? `R 执行完成（${res.durationMs}ms${res.savedImages.length > 0 ? ` · ${res.savedImages.length} 张图表` : ''}）`
        : `R 执行报错：${(res.error ?? '').slice(0, 80)}`,
      result: {
        ok: res.ok,
        rscriptPath: targetRPath,
        stdout: res.stdout.slice(0, 12_000),
        stderr: res.stderr.slice(0, 4_000),
        resultText: res.resultText.slice(0, 8_000),
        htmlCount: res.htmls.length,
        imageCount: res.images.length,
        savedImages: res.savedImages,
        busDir: busInfo?.busDir ?? null,
        variables: res.variables.slice(0, 32),
        error: res.error ?? null,
        durationMs: res.durationMs,
      },
    };
  },

  async datalab_read_notebook(input): Promise<AgentToolResult> {
    assertOnlyKeys(input, ['fileId', 'title']);
    const fileId = parseOptionalString(input, 'fileId', 160);
    const title = parseOptionalString(input, 'title', 200);

    const liveBridge = getCodeLabLiveBridge();
    const snapshot =
      (liveBridge ? await liveBridge.readNotebook({ fileId, title }) : null) ??
      readCodeLabNotebookSnapshot({ fileId, title });

    if (!snapshot) {
      return {
        version: 1,
        permission: 'read',
        name: 'datalab_read_notebook',
        label: '读取实验本内容',
        summary: '当前没有可读取的实验本',
        result: { found: false, notebook: null },
      };
    }

    const sourceLabel =
      snapshot.source === 'live'
        ? '当前实时窗口'
        : snapshot.source === 'draft'
          ? '实时草稿'
          : '已保存';

    return {
      version: 1,
      permission: 'read',
      name: 'datalab_read_notebook',
      label: `读取实验本 · ${snapshot.title}`,
      summary: `已读取 ${snapshot.cells.length} 个单元格（${sourceLabel}）`,
      result: { found: true, notebook: snapshot },
    };
  },

  async datalab_push_cell(input): Promise<AgentToolResult> {
    assertOnlyKeys(input, [
      'language',
      'source',
      'autoRun',
      'sqlConnectionId',
      'sqlResultVar',
      'groupId',
      'groupTitle',
      'afterCellId',
      'fileId',
      'title',
    ]);
    const rawLang = requireString(input, 'language', 20).toLowerCase();
    if (!isCellLanguageArg(rawLang)) {
      throw new Error(
        'language 必须是 python / sql / r / c / cpp / markdown 之一。',
      );
    }
    const source = requireString(input, 'source', 20_000);
    const autoRun = input.autoRun === true;
    const sqlConnectionId = parseOptionalString(input, 'sqlConnectionId', 160);
    const sqlResultVar = parseOptionalString(input, 'sqlResultVar', 80);
    const groupId = parseOptionalString(input, 'groupId', 80);
    const groupTitle = parseOptionalString(input, 'groupTitle', 120);
    const afterCellId = parseOptionalString(input, 'afterCellId', 120);
    const fileId = parseOptionalString(input, 'fileId', 160);
    const title = parseOptionalString(input, 'title', 200);

    const kind = rawLang === 'markdown' ? 'markdown' : 'code';
    const language: TerminalCodeLabLanguage =
      rawLang === 'markdown' ? 'python' : rawLang;

    const liveBridge = getCodeLabLiveBridge();
    if (liveBridge) {
      const outcome = await liveBridge.pushCell({
        kind,
        language,
        source,
        autoRun: kind === 'markdown' ? false : autoRun,
        sqlConnectionId,
        sqlResultVar,
        groupId,
        groupTitle,
        afterCellId,
        fileId,
        title,
      });
      return {
        version: 1,
        permission: 'read',
        name: 'datalab_push_cell',
        label: `推送 ${rawLang.toUpperCase()} 分区到实验本`,
        summary: outcome.message,
        result: { ...outcome, language: rawLang },
      };
    }

    const payload: CodeLabAgentPushPayload = {
      kind,
      language,
      source,
      autoRun: kind === 'markdown' ? false : autoRun,
      sqlConnectionId,
      sqlResultVar,
      groupId,
      groupTitle,
    };

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent<CodeLabAgentPushPayload>(CODELAB_AGENT_PUSH_EVENT, {
          detail: payload,
        }),
      );
    }

    return {
      version: 1,
      permission: 'read',
      name: 'datalab_push_cell',
      label: `推送 ${rawLang.toUpperCase()} 分区到实验本`,
      summary: autoRun
        ? `已将 ${rawLang.toUpperCase()} 分区推入实验本${groupTitle ? `「${groupTitle}」` : ''}并触发执行`
        : `已将 ${rawLang.toUpperCase()} 分区推入实验本${groupTitle ? `「${groupTitle}」` : ''}`,
      result: {
        ok: true,
        dispatched: true,
        language: rawLang,
        autoRun: payload.autoRun,
        sqlConnectionId: sqlConnectionId ?? null,
        sqlResultVar: sqlResultVar ?? null,
        groupId: groupId ?? null,
        groupTitle: groupTitle ?? null,
      },
    };
  },

  async datalab_update_cell(input): Promise<AgentToolResult> {
    assertOnlyKeys(input, [
      'cellId',
      'cellIndex',
      'groupId',
      'matchLanguage',
      'source',
      'language',
      'sqlConnectionId',
      'sqlResultVar',
      'newGroupId',
      'newGroupTitle',
      'autoRun',
      'fileId',
      'title',
    ]);
    const cellId = parseOptionalString(input, 'cellId', 120);
    const cellIndex = parseOptionalPositiveInt(input, 'cellIndex', 1000);
    const groupId = parseOptionalString(input, 'groupId', 80);
    const rawMatchLang = parseOptionalString(
      input,
      'matchLanguage',
      20,
    )?.toLowerCase();
    let matchLanguage: CellLanguageArg | undefined;
    if (rawMatchLang) {
      if (!isCellLanguageArg(rawMatchLang)) {
        throw new Error(
          'matchLanguage 必须是 python / sql / r / c / cpp / markdown 之一。',
        );
      }
      matchLanguage = rawMatchLang;
    }
    if (!cellId && !cellIndex && !groupId) {
      throw new Error(
        '请至少提供 cellId、cellIndex 或 groupId 以定位要修改的单元格。',
      );
    }

    const source =
      typeof input.source === 'string'
        ? input.source.slice(0, 20_000)
        : undefined;
    const rawLang = parseOptionalString(input, 'language', 20)?.toLowerCase();
    let targetLang: CellLanguageArg | undefined;
    if (rawLang) {
      if (!isCellLanguageArg(rawLang)) {
        throw new Error(
          'language 必须是 python / sql / r / c / cpp / markdown 之一。',
        );
      }
      targetLang = rawLang;
    }

    const liveBridge = getCodeLabLiveBridge();
    if (!liveBridge) {
      throw new Error('当前未打开实时代码实验本窗口，无法原地修改代码块。');
    }

    const outcome = await liveBridge.updateCell({
      cellId,
      cellIndex,
      groupId,
      matchLanguage,
      source,
      kind: targetLang
        ? targetLang === 'markdown'
          ? 'markdown'
          : 'code'
        : undefined,
      language:
        targetLang && targetLang !== 'markdown' ? targetLang : undefined,
      sqlConnectionId: parseOptionalString(input, 'sqlConnectionId', 160),
      sqlResultVar: parseOptionalString(input, 'sqlResultVar', 80),
      newGroupId: parseOptionalString(input, 'newGroupId', 80),
      newGroupTitle: parseOptionalString(input, 'newGroupTitle', 120),
      autoRun: input.autoRun === true,
      fileId: parseOptionalString(input, 'fileId', 160),
      title: parseOptionalString(input, 'title', 200),
    });

    if (!outcome.ok) {
      throw new Error(outcome.error || outcome.message);
    }

    return {
      version: 1,
      permission: 'read',
      name: 'datalab_update_cell',
      label: `修改实验本单元格 #${outcome.cellIndex ?? '?'}`,
      summary: outcome.message,
      result: { ...outcome },
    };
  },

  async datalab_run_cell(input): Promise<AgentToolResult> {
    assertOnlyKeys(input, [
      'cellId',
      'cellIndex',
      'groupId',
      'runAll',
      'fileId',
      'title',
    ]);
    const cellId = parseOptionalString(input, 'cellId', 120);
    const cellIndex = parseOptionalPositiveInt(input, 'cellIndex', 1000);
    const groupId = parseOptionalString(input, 'groupId', 80);
    const runAll = input.runAll === true;

    if (!cellId && !cellIndex && !groupId && !runAll) {
      throw new Error(
        '请指定 cellId、cellIndex、groupId 或设置 runAll: true。',
      );
    }

    const liveBridge = getCodeLabLiveBridge();
    if (!liveBridge) {
      throw new Error('当前未打开实时代码实验本窗口，无法执行实验本单元格。');
    }

    const outcome = await liveBridge.runCell({
      cellId,
      cellIndex,
      groupId,
      runAll,
      fileId: parseOptionalString(input, 'fileId', 160),
      title: parseOptionalString(input, 'title', 200),
    });

    if (!outcome.ok && !outcome.executedCells?.length) {
      throw new Error(outcome.error || outcome.message);
    }

    return {
      version: 1,
      permission: 'read',
      name: 'datalab_run_cell',
      label: runAll
        ? '运行全部实验本单元格'
        : groupId
          ? `运行复合分析区块 · ${outcome.groupTitle ?? groupId}`
          : `运行实验本单元格 #${outcome.cellIndex ?? '?'}`,
      summary: outcome.message,
      result: { ...outcome },
    };
  },

  async datalab_delete_cell(input): Promise<AgentToolResult> {
    assertOnlyKeys(input, [
      'cellId',
      'cellIndex',
      'groupId',
      'fileId',
      'title',
    ]);
    const cellId = parseOptionalString(input, 'cellId', 120);
    const cellIndex = parseOptionalPositiveInt(input, 'cellIndex', 1000);
    const groupId = parseOptionalString(input, 'groupId', 80);

    if (!cellId && !cellIndex && !groupId) {
      throw new Error('请指定要删除的 cellId、cellIndex 或 groupId。');
    }

    const liveBridge = getCodeLabLiveBridge();
    if (!liveBridge) {
      throw new Error('当前未打开实时代码实验本窗口，无法删除代码块。');
    }

    const outcome = await liveBridge.deleteCell({
      cellId,
      cellIndex,
      groupId,
      fileId: parseOptionalString(input, 'fileId', 160),
      title: parseOptionalString(input, 'title', 200),
    });

    if (!outcome.ok) {
      throw new Error(outcome.error || outcome.message);
    }

    return {
      version: 1,
      permission: 'read',
      name: 'datalab_delete_cell',
      label: groupId ? '删除复合分析区块' : '删除实验本单元格',
      summary: outcome.message,
      result: { ...outcome },
    };
  },
};
