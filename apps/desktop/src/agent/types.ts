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
  root: MindmapNodeSnapshot;
}

export type NodeEditOperation =
  | 'rename'
  | 'add_child'
  | 'add_sibling'
  | 'delete'
  | 'set_note';

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
  name: string;
  label: string;
  summary: string;
  status: 'running' | 'done' | 'failed' | 'approval';
}
