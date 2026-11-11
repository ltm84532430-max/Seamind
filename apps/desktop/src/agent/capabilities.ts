export type {
  AgentCapabilities,
  AgentToolResult,
  ProposeFavoritesCategorizationInput,
  ProposeLearningPathInput,
  ProposeLearningPathRawNode,
  ProposeNodeBranchInput,
  ProposeNodeEditInput,
} from './tool-api';

export { buildValidatedLearningPathNodes } from './tools/learning-path';
export type { AgentToolSurface } from './tools/registry';
export {
  agentToolCatalog,
  agentToolCatalogForWorkspace,
  agentToolDefinitionsFor,
  agentToolSurfaces,
  agentTools,
  executeAgentTool,
  mcpToolSpecs,
} from './tools/registry';
