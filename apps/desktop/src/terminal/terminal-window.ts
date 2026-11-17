import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { Theme } from '../app/app-storage';
import type {
  SplitLayoutMode,
  TerminalCliPreset,
  TerminalCodeLabLanguage,
  TerminalShellType,
  TerminalTabKind,
} from './terminal-types';

export interface StandaloneTerminalOptions {
  cwd?: string;
  shell?: TerminalShellType;
  cli?: TerminalCliPreset;
  kind?: TerminalTabKind;
  labLanguage?: TerminalCodeLabLanguage;
  theme?: Theme;
  title?: string;
}

export interface StandaloneTerminalResult {
  ok: boolean;
  label?: string;
  error?: string;
}

export function visiblePaneCountForMode(mode: SplitLayoutMode): number {
  switch (mode) {
    case 'vertical':
    case 'horizontal':
      return 2;
    case 'tri':
      return 3;
    case 'quad':
      return 4;
    default:
      return 1;
  }
}

export function normalizePaneTabAssignments(
  paneTabIds: ReadonlyArray<string>,
  allTabIds: ReadonlyArray<string>,
  neededCount: number,
): string[] {
  const validSet = new Set(allTabIds);
  const next: string[] = [];
  for (const id of paneTabIds) {
    if (validSet.has(id) && !next.includes(id)) {
      next.push(id);
    }
    if (next.length >= neededCount) break;
  }
  for (const id of allTabIds) {
    if (next.length >= neededCount) break;
    if (!next.includes(id)) {
      next.push(id);
    }
  }
  if (next.length === 0 && allTabIds[0]) {
    next.push(allTabIds[0]);
  }
  return next;
}

export function buildStandaloneTerminalUrl(
  options: StandaloneTerminalOptions,
): string {
  const base =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : '/';
  const params = new URLSearchParams();
  params.set('window', 'terminal');
  if (options.cwd) params.set('cwd', options.cwd);
  if (options.shell) params.set('shell', options.shell);
  if (options.cli) params.set('cli', options.cli);
  if (options.kind) params.set('kind', options.kind);
  if (options.labLanguage) params.set('lab', options.labLanguage);
  if (options.theme) params.set('theme', options.theme);
  return `${base}?${params.toString()}`;
}

export async function openStandaloneTerminalWindow(
  options: StandaloneTerminalOptions,
): Promise<StandaloneTerminalResult> {
  const label = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const url = buildStandaloneTerminalUrl(options);
  const titleSuffix = options.cli
    ? ` · ${options.cli.toUpperCase()}`
    : options.shell
      ? ` · ${options.shell.toUpperCase()}`
      : '';
  const windowTitle = options.title ?? `Seamind Terminal${titleSuffix}`;

  try {
    const win = new WebviewWindow(label, {
      url,
      title: windowTitle,
      width: 1120,
      height: 720,
      minWidth: 680,
      minHeight: 420,
      center: true,
    });
    return await new Promise<StandaloneTerminalResult>((resolve) => {
      let settled = false;
      const done = (result: StandaloneTerminalResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      void win.once('tauri://created', () => done({ ok: true, label }));
      void win.once('tauri://error', (event) =>
        done({
          ok: false,
          error:
            typeof event.payload === 'string'
              ? event.payload
              : '独立窗口创建失败',
        }),
      );
      window.setTimeout(() => done({ ok: true, label }), 300);
    });
  } catch (reason) {
    return {
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
}
