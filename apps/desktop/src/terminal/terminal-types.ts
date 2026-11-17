import type { ActiveWorkspace, ProviderSettings } from '../app/app-storage';
import type { AgentCapabilities } from '../agent/capabilities';
import type { EpubBookDocument, MapDocument } from '../library/library';

export type TerminalShellType = 'powershell' | 'wsl' | 'bash' | 'cmd';

export type TerminalCliPreset = 'agy' | 'claude' | 'codex';

export type TerminalTabKind = 'shell' | 'agent' | 'lab';

export type TerminalCodeLabLanguage = 'python' | 'c' | 'cpp';

export type TerminalAgentEngineMode =
  'api' | 'cli:claude' | 'cli:codex' | 'cli:agy' | 'hybrid';

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
  kind?: TerminalTabKind;
  shell: TerminalShellType;
  cwd: string;
  initialCli?: TerminalCliPreset;
  labLanguage?: TerminalCodeLabLanguage;
  agentEngine?: TerminalAgentEngineMode;
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

export interface TerminalWorkspaceBridge {
  provider?: ProviderSettings;
  capabilities?: AgentCapabilities;
  books?: EpubBookDocument[];
  documents?: MapDocument[];
  activeDocument?: {
    title: string;
    relativePath: string | null;
    kind: string;
  } | null;
  activeMindmapTitle?: string | null;
  onNavigateWorkspace?: (workspace: ActiveWorkspace) => void;
  onOpenBook?: (book: EpubBookDocument) => void;
  onOpenDocument?: (doc: MapDocument) => void;
  onSaveMarkdownNote?: (args: {
    title: string;
    category?: string;
    source: string;
  }) => Promise<boolean>;
  onOpenExamBookFilter?: (bookKey?: string | null) => void;
  onOpenYouTubeVideo?: (
    videoId: string,
    startSeconds?: number,
    title?: string,
  ) => void;
}
