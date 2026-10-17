export interface MindmapNodeSnapshot {
  path: string;
  nodeId: string | null;
  label: string;
  note: string;
  noteTruncated: boolean;
  allowedOperations: NodeEditOperation[];
  editable: boolean;
  children: MindmapNodeSnapshot[];
}

export interface ActiveMindmapSnapshot {
  title: string;
  revision: number;
  relativePath: string | null;
  nodeCount: number;
  truncated: boolean;
  markdown: string;
  root: MindmapNodeSnapshot;
}

export type NodeEditOperation =
  | 'rename'
  | 'add_child'
  | 'add_sibling'
  | 'add_branch'
  | 'delete'
  | 'set_note';

export type AgentAnalysisMode = 'drilldown' | 'visualization';

export interface GeneratedHtmlAsset {
  assetId: string;
  entryPath: 'index.html';
  title: string;
  html: string;
}

export interface NodeEditProposal {
  baseRevision: number;
  baseRelativePath: string | null;
  baseMarkdown: string;
  baseTitle: string;
  markdown: string;
  title: string;
  nodeId: string | null;
  nodePath: string;
  operation: NodeEditOperation;
  previousLabel: string;
  nextLabel: string;
  previousNote?: string;
  nextNote?: string;
  rationale: string;
  analysisMode?: AgentAnalysisMode;
  branchMarkdown?: string;
  htmlAssets?: GeneratedHtmlAsset[];
}

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
}

export interface CompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AgentTurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reportedRequests: number;
  requestCount: number;
  promptReportedRequests: number;
  completionReportedRequests: number;
  totalReportedRequests: number;
  contextTokensEstimate: number;
}

export interface ModelContextWindow {
  tokens: number;
  sourceLabel: string;
  sourceUrl: string;
  verifiedOn: string;
}

export interface AgentModelRequestEvent {
  id: string;
  kind: 'model';
  round: number;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  contextTokensEstimate: number;
  usage?: CompletionUsage;
}

export interface AgentToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentToolDescriptor {
  version: 1;
  name: string;
  description: string;
  permission: 'read' | 'user_approval';
  inputSchema: Record<string, unknown>;
}

export interface AgentToolAction {
  id: string;
  kind: 'tool';
  round: number;
  name: string;
  label: string;
  summary: string;
  status: 'running' | 'done' | 'failed' | 'approval';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
}

export type AgentCallEvent = AgentModelRequestEvent | AgentToolAction;

export interface AgentTurnDetails {
  providerLabel: string;
  model: string;
  mode: AgentAnalysisMode;
  targetLabel: string;
  status: 'running' | 'completed' | 'proposal' | 'failed';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  contextWindow: ModelContextWindow | null;
  usage: AgentTurnUsage;
  events: AgentCallEvent[];
}
