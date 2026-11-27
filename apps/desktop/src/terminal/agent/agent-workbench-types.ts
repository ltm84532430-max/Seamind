import type { ActiveWorkspace } from '../../app/app-storage';
import type {
  AgentToolArtifact,
  AgentTurnUsage,
  CompletionUsage,
  KnowledgeDocumentEditProposal,
  ModelContextWindow,
} from '../../agent/types';
import type {
  CliEngineStatus,
  CliModelOption,
  CliModelsCatalog,
} from '../terminal-api';
import type { TerminalAgentEngineMode } from '../terminal-types';

export type CliEngineId = 'agy' | 'gemini' | 'claude' | 'codex';

export type AgentTurnStatus =
  'running' | 'completed' | 'paused' | 'cancelled' | 'failed';

/**
 * Granular 9-state execution phase aligned with SEAMIND Agent Spec §8.
 */
export type AgentRunPhase =
  | 'idle'
  | 'submitting'
  | 'streaming'
  | 'tool-running'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'disconnected';

export type ExecutionBlockKind = 'model' | 'tool' | 'cli-tool' | 'status';

export type ExecutionBlockStatus =
  'running' | 'done' | 'failed' | 'approval' | 'cancelled';

export interface ExecutionBlock {
  id: string;
  kind: ExecutionBlockKind;
  label: string;
  toolName?: string;
  round?: number;
  status: ExecutionBlockStatus;
  summary?: string;
  detail?: string;
  inputArgs?: Record<string, unknown>;
  outputPreview?: string;
  errorDetail?: string;
  artifacts?: AgentToolArtifact[];
  durationMs?: number;
  timestampMs?: number;
  usage?: CompletionUsage;
}

export interface TerminalCommandProposalState {
  command: string;
  paneIndex: number;
  reason: string;
  resolved?: 'approved' | 'filled' | 'dismissed';
}

export interface WorkspaceProposalHint {
  title: string;
  description: string;
  targetWorkspace?: ActiveWorkspace;
  targetLabel?: string;
}

export interface KnowledgeDocumentProposalState extends KnowledgeDocumentEditProposal {
  resolved?: 'approved' | 'dismissed';
  resultMessage?: string;
}

export interface AgentTurnRecord {
  id: string;
  userText: string;
  engineLabel: string;
  engineMode: TerminalAgentEngineMode | 'local';
  status: AgentTurnStatus;
  attachedContexts: string[];
  blocks: ExecutionBlock[];
  artifacts?: AgentToolArtifact[];
  seenEventKeys?: string[];
  reply: string;
  streamBuffer?: string;
  stderr?: string;
  error?: string;
  disconnected?: boolean;
  exitCode?: number | null;
  usedMcp?: boolean;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  cliRunId?: string;
  usage?: AgentTurnUsage;
  roundsUsed?: number;
  toolCallsUsed?: number;
  terminalProposal?: TerminalCommandProposalState;
  knowledgeDocumentProposal?: KnowledgeDocumentProposalState;
  workspaceProposal?: WorkspaceProposalHint;
}

export interface LocalEngineConfig {
  mode: TerminalAgentEngineMode;
  presetId: string;
  baseUrl: string;
  model: string;
  noToolsMode: boolean;
}

export interface ModelFamilyGroup {
  family: string;
  variants: CliModelOption[];
  defaultVariant: CliModelOption;
}

export interface ActiveModelDisplay {
  family: string;
  tier: string;
  id: string;
}

export interface McpBridgeSnapshot {
  state: 'loading' | 'ready' | 'unavailable' | 'error';
  ready: boolean;
  endpoint: string | null;
  toolCount: number | null;
  toolNames: string[];
  errorMessage?: string;
  checkedAt?: number;
}

export interface SessionArtifactItem {
  id: string;
  turnId: string;
  turnIndex: number;
  kind: 'code' | 'command' | 'table' | 'file-ref';
  language: string;
  title: string;
  lineCount: number;
  preview: string;
}

export interface ContextSourceAvailability {
  token: string;
  label: string;
  hint: string;
  badge?: string;
  alert?: boolean;
  primary?: boolean;
  available: boolean;
  detailText?: string;
}

export interface SessionTelemetrySnapshot {
  sessionPhase: AgentRunPhase;
  turnCount: number;
  totalToolCalls: number;
  pendingApprovals: number;
  reportedUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reportedRequests: number;
  };
  localEstimatedTokens: number;
  contextWindow: ModelContextWindow | null;
  cliEngines: CliEngineStatus[];
  activeCliCatalog?: CliModelsCatalog;
}
