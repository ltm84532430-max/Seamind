export type TerminalShellType = 'powershell' | 'wsl' | 'bash' | 'cmd';

export type TerminalCliPreset = 'agy' | 'claude' | 'codex';

export interface TerminalShellOption {
  id: TerminalShellType;
  name: string;
  badge: string;
  description: string;
  available: boolean;
}

export interface TerminalTab {
  id: string;
  title: string;
  shell: TerminalShellType;
  cwd: string;
  initialCli?: TerminalCliPreset;
  bellCount?: number;
  status: 'starting' | 'ready' | 'exited' | 'error';
  statusMessage?: string;
  createdAt: number;
}

export type SplitLayoutMode =
  'single' | 'vertical' | 'horizontal' | 'tri' | 'quad';

export type TerminalCursorStyle = 'block' | 'underline' | 'bar';

export interface TerminalPreferences {
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  saveOnSelect: boolean;
  smartCopyPaste: boolean;
  webglEnabled: boolean;
  scrollback: number;
  semanticEscapeChars: string;
}

export interface LinuxCheatItem {
  id: string;
  cmd: string;
  commandByShell?: Partial<Record<TerminalShellType, string>>;
  requiresConfirmation?: boolean;
  category: 'fs' | 'text' | 'proc' | 'net' | 'sys';
  categoryLabel: string;
  title: string;
  explanation: string;
  practicalScenario: string;
  sampleArgs?: string;
}

export interface KnowledgeActionItem {
  id: string;
  category: 'kb' | 'map' | 'exam' | 'agent';
  categoryBadge: string;
  targetWorkspace: string;
  title: string;
  commandTemplate: string;
  commandByShell?: Partial<Record<TerminalShellType, string>>;
  requiresConfirmation?: boolean;
  description: string;
}
