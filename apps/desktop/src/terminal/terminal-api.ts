import { invoke } from '@tauri-apps/api/core';
import type { TerminalShellOption, TerminalShellType } from './terminal-types';

export const terminalApi = {
  detectShells: () => invoke<TerminalShellOption[]>('terminal_detect_shells'),
  start: (args: {
    cwd: string;
    cols: number;
    rows: number;
    shell?: TerminalShellType;
  }) => invoke<string>('terminal_start', args),
  write: (args: { sessionId: string; data: number[] }) =>
    invoke<void>('terminal_write', args),
  resize: (args: { sessionId: string; cols: number; rows: number }) =>
    invoke<void>('terminal_resize', args),
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
};
