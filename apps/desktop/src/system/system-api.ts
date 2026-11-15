import { invoke } from '@tauri-apps/api/core';

export interface PendingComponents {
  plantumlJava: boolean;
  ytDlp: boolean;
}

export const systemApi = {
  pendingComponents: () =>
    invoke<PendingComponents | null>('installer_get_pending_components'),
  clearPendingComponents: () =>
    invoke<void>('installer_clear_pending_components'),
  installPlantUmlJava: () => invoke<string>('plantuml_install_java_runtime'),
  installYtDlp: () => invoke<{ version: string }>('youtube_install_ytdlp'),
  checkCEnvironment: () =>
    invoke<{ available: boolean; error?: string }>('c_check_environment'),
  runCCode: (args: {
    source: string;
    stdinInput: string | null;
    isCpp: boolean;
  }) =>
    invoke<{
      success: boolean;
      stdout: string;
      stderr: string;
      exitCode?: number | null;
      durationMs: number;
      stage: string;
    }>('c_run_code', args),
};
