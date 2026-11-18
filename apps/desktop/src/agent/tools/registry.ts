import type { ActiveWorkspace } from '../../app/app-storage';
import type {
  AgentCapabilities,
  AgentToolResult,
  ToolHandler,
} from '../tool-api';
import type { AgentToolDefinition, AgentToolDescriptor } from '../types';
import { favoritesHandlers, favoritesToolCatalog } from './favorites';
import { feedHandlers, feedToolCatalog } from './feed';
import { learningPathHandlers, learningPathToolCatalog } from './learning-path';
import { mindmapHandlers, mindmapToolCatalog } from './mindmap';
import { parseObject } from './parse';
import { readerHandlers, readerToolCatalog } from './reader';
import {
  terminalBridgeHandlers,
  terminalBridgeToolCatalog,
} from './terminal-bridge';

export const agentToolCatalog: AgentToolDescriptor[] = [
  ...feedToolCatalog,
  ...readerToolCatalog,
  ...mindmapToolCatalog,
  ...learningPathToolCatalog,
  ...favoritesToolCatalog,
  ...terminalBridgeToolCatalog,
];

export const agentTools: AgentToolDefinition[] = agentToolCatalog.map(
  ({ name, description, inputSchema }) => ({
    type: 'function',
    function: { name, description, parameters: inputSchema },
  }),
);

export const agentToolSurfaces = [
  'mindmap',
  'learning-path',
  'favorites',
  'reader',
  'feed',
  'terminal-agent',
] as const;

export type AgentToolSurface = (typeof agentToolSurfaces)[number];

const SURFACE_TOOL_NAMES: Record<AgentToolSurface, readonly string[]> = {
  mindmap: mindmapToolCatalog.map((tool) => tool.name),
  'learning-path': learningPathToolCatalog.map((tool) => tool.name),
  favorites: favoritesToolCatalog.map((tool) => tool.name),
  reader: readerToolCatalog.map((tool) => tool.name),
  feed: feedToolCatalog.map((tool) => tool.name),
  'terminal-agent': terminalBridgeToolCatalog.map((tool) => tool.name),
};

function catalogEntriesNamed(names: readonly string[]): AgentToolDescriptor[] {
  const byName = new Map(agentToolCatalog.map((tool) => [tool.name, tool]));
  return names.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`缺少工具定义：${name}`);
    return tool;
  });
}

export function agentToolDefinitionsFor(
  surface: AgentToolSurface,
): AgentToolDefinition[] {
  const allowed = new Set(SURFACE_TOOL_NAMES[surface]);
  return agentTools.filter((tool) => allowed.has(tool.function.name));
}

export function agentToolCatalogForWorkspace(
  workspace: ActiveWorkspace,
): AgentToolDescriptor[] | null {
  switch (workspace) {
    case 'mindmap':
    case 'knowledge':
      return catalogEntriesNamed(SURFACE_TOOL_NAMES.mindmap);
    case 'player':
      return catalogEntriesNamed([
        ...SURFACE_TOOL_NAMES['learning-path'],
        ...SURFACE_TOOL_NAMES.favorites,
      ]);
    case 'reader':
      return catalogEntriesNamed(SURFACE_TOOL_NAMES.reader);
    case 'feed':
      return catalogEntriesNamed(SURFACE_TOOL_NAMES.feed);
    case 'exams':
      return catalogEntriesNamed([
        'exam_list_papers',
        'exam_get_paper',
        'code_run_c',
        'code_run_python',
      ]);
    case 'literature':
      return catalogEntriesNamed(['literature_list_papers']);
    default:
      return null;
  }
}

export function mcpToolSpecs(tools: AgentToolDescriptor[]) {
  return tools.map(
    ({ name, description, permission, inputSchema, version }) => ({
      name,
      description,
      inputSchema,
      annotations: {
        readOnlyHint: permission === 'read',
        destructiveHint: permission === 'user_approval',
        openWorldHint: false,
      },
      _meta: {
        'seamind/version': version,
        'seamind/permission': permission,
        ...(permission === 'user_approval'
          ? { 'anthropic/requiresUserInteraction': true }
          : {}),
      },
    }),
  );
}

const toolHandlers = new Map<string, ToolHandler>();
for (const group of [
  feedHandlers,
  readerHandlers,
  mindmapHandlers,
  learningPathHandlers,
  favoritesHandlers,
  terminalBridgeHandlers,
]) {
  for (const [name, handler] of Object.entries(group) as Array<
    [string, ToolHandler]
  >) {
    if (toolHandlers.has(name)) throw new Error(`重复的工具：${name}`);
    toolHandlers.set(name, handler);
  }
}

for (const tool of agentToolCatalog) {
  if (!toolHandlers.has(tool.name)) {
    throw new Error(`工具 ${tool.name} 没有执行函数。`);
  }
}

export async function executeAgentTool(
  name: string,
  rawArguments: string,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`模型请求了未注册的工具：${name}`);
  return handler(parseObject(rawArguments), capabilities);
}
