import { invoke } from '@tauri-apps/api/core';
import type { TerminalShellOption, TerminalShellType } from './terminal-types';

export interface PythonEnvInfo {
  id: string;
  label: string;
  pythonPath: string;
  envType: string;
  condaEnvName?: string | null;
  version?: string | null;
  hasNumpy: boolean;
  hasMatplotlib: boolean;
  hasPandas: boolean;
  hasPyarrow: boolean;
  hasDuckdb: boolean;
  hasPolars: boolean;
  hasSqlalchemy: boolean;
  hasScipy: boolean;
}

export interface PythonVarSummary {
  name: string;
  typeName: string;
  preview: string;
}

export interface PythonEvalResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  resultText: string;
  images: string[];
  savedImages: string[];
  svgs: string[];
  htmls: string[];
  latexes: string[];
  variables: PythonVarSummary[];
  error?: string | null;
  durationMs: number;
}

export interface REnvInfo {
  id: string;
  label: string;
  rscriptPath: string;
  envType: string;
  version?: string | null;
  hasTidyverse: boolean;
  hasGgplot2: boolean;
  hasDataTable: boolean;
  hasArrow: boolean;
  hasDbi: boolean;
  hasDuckdb: boolean;
}

export interface REvalResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  resultText: string;
  images: string[];
  savedImages: string[];
  htmls: string[];
  variables: PythonVarSummary[];
  error?: string | null;
  durationMs: number;
}

export interface DataColumnInfo {
  name: string;
  dataType: string;
}

export type DataScalarValue = string | number | boolean | null;

export interface DataTableResult {
  ok: boolean;
  columns: DataColumnInfo[];
  rows: DataScalarValue[][];
  totalRows?: number | null;
  truncated: boolean;
  engine: string;
  durationMs: number;
  message?: string | null;
  error?: string | null;
  busTablePath?: string | null;
}

export interface DataBusEntry {
  name: string;
  format: string;
  path: string;
  sizeBytes: number;
  updatedAtMs: number;
}

export interface DataBusInfo {
  sessionId: string;
  busDir: string;
  tablesDir: string;
  artifactsDir: string;
  tables: DataBusEntry[];
  artifacts: DataBusEntry[];
}

export interface DataBusDbSummary {
  id: string;
  name: string;
  dbType: string;
  filePath?: string | null;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
}

export interface DataFileInspection {
  path: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  rowCount?: number | null;
  columns: DataColumnInfo[];
  previewRows: DataScalarValue[][];
  engine: string;
}

export interface DataDbConnectionInput {
  id: string;
  name: string;
  dbType: 'sqlite' | 'duckdb' | 'postgres' | 'mysql';
  filePath?: string | null;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  password?: string | null;
  pythonPath?: string | null;
}

export interface DataDbTableSchema {
  name: string;
  schema?: string | null;
  tableType: string;
  rowCount?: number | null;
  columns: DataColumnInfo[];
}

export interface DataDbTestResult {
  ok: boolean;
  message: string;
  tables: DataDbTableSchema[];
  engine: string;
}

export interface DataMountedFileRef {
  alias: string;
  path: string;
  format: string;
}

export interface CliEngineStatus {
  id: string;
  label: string;
  available: boolean;
  path?: string | null;
  hint: string;
}

export interface CliModelOption {
  id: string;
  label: string;
  family: string;
  tier?: string | null;
}

export interface CliModelsCatalog {
  engine: string;
  currentDefault?: string | null;
  models: string[];
  options: CliModelOption[];
  source: string;
}

export interface CliAgentStreamEvent {
  runId: string;
  engine: string;
  kind: string;
  text: string;
  toolName?: string | null;
  timestampMs: number;
}

export interface CliAgentRunResult {
  runId: string;
  engine: string;
  success: boolean;
  exitCode?: number | null;
  reply: string;
  stderr: string;
  eventsCount: number;
  durationMs: number;
  usedMcp: boolean;
}

export const terminalApi = {
  detectShells: () => invoke<TerminalShellOption[]>('terminal_detect_shells'),
  start: (args: {
    cwd: string;
    cols: number;
    rows: number;
    pixelWidth?: number;
    pixelHeight?: number;
    shell?: TerminalShellType;
  }) => invoke<string>('terminal_start', args),
  write: (args: { sessionId: string; data: number[] }) =>
    invoke<void>('terminal_write', args),
  resize: (args: {
    sessionId: string;
    cols: number;
    rows: number;
    pixelWidth?: number;
    pixelHeight?: number;
  }) => invoke<void>('terminal_resize', args),
  close: (args: { sessionId: string }) => invoke<void>('terminal_close', args),
  stageScript: (args: { source: string }) =>
    invoke<string>('terminal_stage_script', args),
  removeScript: (args: { path: string }) =>
    invoke<void>('terminal_remove_script', args),
  stageCSource: (args: {
    source: string;
    suggestedName: string | null;
    workspaceRoot: string | null;
    isCpp: boolean;
  }) =>
    invoke<{ filePath: string; fileName: string; command: string }>(
      'c_stage_source_file',
      args,
    ),
  detectPythonEnvs: (args?: {
    cwd?: string | null;
    extraPaths?: string[] | null;
  }) =>
    invoke<PythonEnvInfo[]>('python_kernel_detect_envs', {
      cwd: args?.cwd ?? null,
      extraPaths: args?.extraPaths ?? null,
    }),
  startPythonKernel: (args?: {
    pythonPath?: string | null;
    cwd?: string | null;
    sessionId?: string | null;
  }) =>
    invoke<string>('python_kernel_start', {
      pythonPath: args?.pythonPath ?? null,
      cwd: args?.cwd ?? null,
      sessionId: args?.sessionId ?? null,
    }),
  evalPythonKernel: (args: { kernelId: string; code: string }) =>
    invoke<PythonEvalResult>('python_kernel_eval', args),
  resetPythonKernel: (args: { kernelId: string }) =>
    invoke<PythonEvalResult>('python_kernel_reset', args),
  varsPythonKernel: (args: { kernelId: string }) =>
    invoke<PythonVarSummary[]>('python_kernel_vars', args),
  closePythonKernel: (args: { kernelId: string }) =>
    invoke<void>('python_kernel_close', args),
  detectREnvs: (args?: { extraPaths?: string[] | null }) =>
    invoke<REnvInfo[]>('r_kernel_detect_envs', {
      extraPaths: args?.extraPaths ?? null,
    }),
  startRKernel: (args?: {
    rscriptPath?: string | null;
    cwd?: string | null;
    sessionId?: string | null;
  }) =>
    invoke<string>('r_kernel_start', {
      rscriptPath: args?.rscriptPath ?? null,
      cwd: args?.cwd ?? null,
      sessionId: args?.sessionId ?? null,
    }),
  evalRKernel: (args: { kernelId: string; code: string }) =>
    invoke<REvalResult>('r_kernel_eval', args),
  resetRKernel: (args: { kernelId: string }) =>
    invoke<REvalResult>('r_kernel_reset', args),
  varsRKernel: (args: { kernelId: string }) =>
    invoke<PythonVarSummary[]>('r_kernel_vars', args),
  closeRKernel: (args: { kernelId: string }) =>
    invoke<void>('r_kernel_close', args),
  saveDbPassword: (args: { connectionId: string; password: string }) =>
    invoke<void>('data_lab_save_db_password', args),
  deleteDbPassword: (args: { connectionId: string }) =>
    invoke<void>('data_lab_delete_db_password', args),
  inspectDataFile: (args: {
    path: string;
    pythonPath?: string | null;
    maxRows?: number | null;
  }) =>
    invoke<DataFileInspection>('data_lab_inspect_file', {
      path: args.path,
      pythonPath: args.pythonPath ?? null,
      maxRows: args.maxRows ?? null,
    }),
  testDbConnection: (args: { connection: DataDbConnectionInput }) =>
    invoke<DataDbTestResult>('data_lab_test_connection', args),
  querySql: (args: {
    sql: string;
    connection?: DataDbConnectionInput | null;
    mountedFiles?: DataMountedFileRef[] | null;
    pythonPath?: string | null;
    maxRows?: number | null;
    exportBusTable?: string | null;
    sessionId?: string | null;
  }) =>
    invoke<DataTableResult>('data_lab_query_sql', {
      sql: args.sql,
      connection: args.connection ?? null,
      mountedFiles: args.mountedFiles ?? null,
      pythonPath: args.pythonPath ?? null,
      maxRows: args.maxRows ?? null,
      exportBusTable: args.exportBusTable ?? null,
      sessionId: args.sessionId ?? null,
    }),
  getDataBusInfo: (args?: { sessionId?: string | null }) =>
    invoke<DataBusInfo>('data_lab_bus_info', {
      sessionId: args?.sessionId ?? null,
    }),
  syncDataBusContext: (args: {
    sessionId?: string | null;
    mountedFiles: DataMountedFileRef[];
    dbConnections: DataBusDbSummary[];
    defaultPythonPath?: string | null;
    defaultRscriptPath?: string | null;
    defaultConnectionId?: string | null;
  }) =>
    invoke<DataBusInfo>('data_lab_sync_context', {
      sessionId: args.sessionId ?? null,
      mountedFiles: args.mountedFiles,
      dbConnections: args.dbConnections,
      defaultPythonPath: args.defaultPythonPath ?? null,
      defaultRscriptPath: args.defaultRscriptPath ?? null,
      defaultConnectionId: args.defaultConnectionId ?? null,
    }),
  detectCliAgents: () => invoke<CliEngineStatus[]>('cli_agent_detect'),
  listCliAgentModels: (args: { engine: string }) =>
    invoke<CliModelsCatalog>('cli_agent_list_models', args),
  runCliAgent: (args: {
    runId: string;
    engine: string;
    prompt: string;
    systemPrompt?: string | null;
    cwd?: string | null;
    attachMcp?: boolean | null;
    model?: string | null;
  }) => invoke<CliAgentRunResult>('cli_agent_run', args),
  cancelCliAgent: (args: { runId: string }) =>
    invoke<void>('cli_agent_cancel', args),
};
