import type { ActiveWorkspace, ProviderSettings } from '../app/app-storage';
import type { AgentCapabilities } from '../agent/capabilities';
import type { KnowledgeDocumentEditProposal } from '../agent/types';
import type { EpubBookDocument, MapDocument } from '../library/library';

export type TerminalShellType = 'powershell' | 'wsl' | 'bash' | 'cmd';

export type TerminalCliPreset = 'agy' | 'gemini' | 'claude' | 'codex';

export type TerminalTabKind = 'shell' | 'agent' | 'lab';

export type TerminalCodeLabLanguage = 'python' | 'sql' | 'r' | 'c' | 'cpp';

export type TerminalAgentEngineMode =
  'api' | 'cli:claude' | 'cli:codex' | 'cli:agy' | 'cli:gemini' | 'hybrid';

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
  labMode?: 'notebook' | 'er';
  erConnectionId?: string;
  labFileId?: string;
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

export type AgentToolScopeMode = 'focused' | 'all';

export type AgentWorkspaceSubView =
  | 'doc'
  | 'overview'
  | 'mindmap'
  | 'notebook'
  | 'er'
  | 'epub'
  | 'pdf'
  | 'shelf'
  | 'shell'
  | 'default';

export interface AgentWorkspaceContextSnapshot {
  /** Primary (left/main) workspace tab active in the desktop window */
  primaryWorkspace: ActiveWorkspace;
  /** Secondary (right) split workspace when universal split is active */
  secondaryWorkspace: ActiveWorkspace | null;
  /** True when two workspaces are side-by-side in universal split */
  splitActive: boolean;
  /** Which workspace the Agent should prioritize right now (null = standalone fullscreen Agent) */
  targetWorkspace: ActiveWorkspace | null;
  /** Where the target workspace sits relative to Agent */
  targetPosition: 'left' | 'right' | 'main' | 'none';
  /** All currently visible non-agent workspaces (supports multi-pane / split awareness) */
  visibleWorkspaces: ActiveWorkspace[];
  /** Granular active sub-view inside the target workspace (e.g. doc vs overview, er vs notebook) */
  targetSubView: AgentWorkspaceSubView;
  /** Active Knowledge Workspace Markdown document (when open) */
  activeKnowledgeDoc?: {
    title: string;
    relativePath: string | null;
    category: string;
    charCount: number;
    lineCount: number;
    openTabs: Array<{ title: string; relativePath: string; active: boolean }>;
  } | null;
  /** Active Mindmap canvas document */
  activeMindmap?: {
    title: string;
    relativePath: string | null;
    nodeCount?: number;
  } | null;
  /** Active Lab/ER sub-view details */
  activeLab?: {
    mode: 'notebook' | 'er';
    title?: string | null;
    erConnectionId?: string | null;
  } | null;
  /** Active EPUB / PDF book in reader */
  activeBook?: {
    title: string;
    chapterLabel?: string | null;
    kind: 'epub' | 'pdf';
  } | null;
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
  /** Live primary/split workspace state so Agent prioritizes the active page's module tools */
  workspaceContext?: AgentWorkspaceContextSnapshot;
  onNavigateWorkspace?: (workspace: ActiveWorkspace) => void;
  onOpenBook?: (book: EpubBookDocument) => void;
  onOpenDocument?: (doc: MapDocument) => void;
  renderMarkdownPreview?: (markdown: string) => {
    html: string;
    source: string;
  };
  onSaveMarkdownNote?: (args: {
    title: string;
    category?: string;
    source: string;
  }) => Promise<boolean>;
  onApplyKnowledgeDocumentProposal?: (
    proposal: KnowledgeDocumentEditProposal,
  ) => Promise<{ ok: boolean; message: string; relativePath?: string }>;
  onAppendToMindmap?: (args: {
    title: string;
    markdown: string;
  }) => Promise<boolean> | boolean;
  onOpenExamBookFilter?: (bookKey?: string | null) => void;
  onOpenYouTubeVideo?: (
    videoId: string,
    startSeconds?: number,
    title?: string,
  ) => void;
}
