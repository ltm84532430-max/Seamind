import { invoke } from '@tauri-apps/api/core';
import type { AgentChatMessage, CompletionUsage } from './types';

type BridgeResolution = {
  requestId: string;
  result: Record<string, unknown>;
  error?: string | null;
};

export interface AgentBridgeStatus {
  ready: boolean;
  endpoint: string | null;
  toolCount: number;
  toolNames: string[];
}

export const agentApi = {
  getBridgeStatus: () => invoke<AgentBridgeStatus>('agent_bridge_status'),
  setBridgeTools: (args: { tools: unknown[] }) =>
    invoke<void>('agent_bridge_set_tools', args),
  resolveBridge: (args: BridgeResolution) =>
    invoke<void>('agent_bridge_resolve', args),
  generateMindmap: (args: { baseUrl: string; model: string; prompt: string }) =>
    invoke<string>('generate_mindmap', args),
  listProviderModels: (args: { baseUrl: string }) =>
    invoke<string[]>('list_provider_models', args),
  hasApiKey: () => invoke<boolean>('has_api_key'),
  saveApiKey: (args: { apiKey: string }) => invoke<void>('save_api_key', args),
  deleteApiKey: () => invoke<void>('delete_api_key'),
  hasProviderApiKey: (args: { providerId: string }) =>
    invoke<boolean>('has_provider_api_key', args),
  saveProviderApiKey: (args: { providerId: string; apiKey: string }) =>
    invoke<void>('save_provider_api_key', args),
  complete: (args: {
    baseUrl: string;
    model: string;
    messages: AgentChatMessage[];
    tools: unknown;
    providerId?: string | null;
  }) =>
    invoke<AgentChatMessage & { usage?: CompletionUsage }>(
      'agent_completion',
      args,
    ),
};
