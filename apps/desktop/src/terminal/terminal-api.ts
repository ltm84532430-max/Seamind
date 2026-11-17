import { invoke } from '@tauri-apps/api/core';
import type { TerminalShellOption, TerminalShellType } from './terminal-types';

export interface PythonEnvInfo {
  id: string;
  label: string;
  pythonPath: string;
  envType: string;
  version?: string | null;
  hasNumpy: boolean;
  hasMatplotlib: boolean;
  hasPandas: boolean;
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
  svgs: string[];
  htmls: string[];
  latexes: string[];
  variables: PythonVarSummary[];
  error?: string | null;
  durationMs: number;
}

export interface CliEngineStatus {
  id: string;
  label: string;
  available: boolean;
  path?: string | null;
  hint: string;
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
  detectPythonEnvs: (args?: { cwd?: string | null }) =>
    invoke<PythonEnvInfo[]>('python_kernel_detect_envs', {
      cwd: args?.cwd ?? null,
    }),
  startPythonKernel: (args?: {
    pythonPath?: string | null;
    cwd?: string | null;
  }) =>
    invoke<string>('python_kernel_start', {
      pythonPath: args?.pythonPath ?? null,
      cwd: args?.cwd ?? null,
    }),
  evalPythonKernel: (args: { kernelId: string; code: string }) =>
    invoke<PythonEvalResult>('python_kernel_eval', args),
  resetPythonKernel: (args: { kernelId: string }) =>
    invoke<PythonEvalResult>('python_kernel_reset', args),
  varsPythonKernel: (args: { kernelId: string }) =>
    invoke<PythonVarSummary[]>('python_kernel_vars', args),
  closePythonKernel: (args: { kernelId: string }) =>
    invoke<void>('python_kernel_close', args),
  detectCliAgents: () => invoke<CliEngineStatus[]>('cli_agent_detect'),
  runCliAgent: (args: {
    runId: string;
    engine: string;
    prompt: string;
    systemPrompt?: string | null;
    cwd?: string | null;
    attachMcp?: boolean | null;
  }) => invoke<CliAgentRunResult>('cli_agent_run', args),
  cancelCliAgent: (args: { runId: string }) =>
    invoke<void>('cli_agent_cancel', args),
};
