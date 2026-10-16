import { invoke } from '@tauri-apps/api/core';
import type { AgentCapabilities } from './capabilities';
import { agentTools, executeAgentTool } from './capabilities';
import type {
  AgentChatMessage,
  AgentToolAction,
  AgentToolCall,
  NodeEditProposal,
} from './types';

const SYSTEM_PROMPT = `你是 Seamind 的思维导图助手。你可以读取当前导图和本地文件库，也可以提出一个节点修改提案。
需要了解当前内容时先调用 mindmap_get_current；需要查资料时先 library_search，再按需 library_read_document。只编辑 editable 为 true 的节点；如果导图快照标记为 truncated，应说明快照不完整，不要把未显示的节点当作不存在。
修改前必须基于当前导图返回的 revision 和 nodeId 调用 mindmap_propose_node_edit；nodeId 为空时再使用 nodePath。只能选择节点 allowedOperations 中列出的操作；可用 set_note 写入 Markdown/数学公式备注。每轮最多提出一个修改；该工具只创建预览，用户确认前不能声称修改已经应用或保存。备注若标记为截断，不要把截断内容当作完整原文。
只能使用提供的工具，不要声称执行过未调用的操作。回答用中文、简洁说明结果。`;

const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_CALLS = 8;
const MAX_HISTORY_MESSAGES = 12;

export interface AgentProviderSettings {
  baseUrl: string;
  model: string;
}

export interface AgentTurnResult {
  reply: string;
  proposal: NodeEditProposal | null;
  history: AgentChatMessage[];
}

function isToolCall(value: unknown): value is AgentToolCall {
  if (!value || typeof value !== 'object') return false;
  const call = value as Partial<AgentToolCall>;
  return (
    typeof call.id === 'string' &&
    call.type === 'function' &&
    Boolean(call.function) &&
    typeof call.function?.name === 'string' &&
    typeof call.function?.arguments === 'string'
  );
}

function compactHistory(history: AgentChatMessage[]): AgentChatMessage[] {
  return history.slice(-MAX_HISTORY_MESSAGES);
}

export async function runAgentTurn(args: {
  history: AgentChatMessage[];
  prompt: string;
  provider: AgentProviderSettings;
  capabilities: AgentCapabilities;
  onAction(action: AgentToolAction): void;
}): Promise<AgentTurnResult> {
  const prompt = args.prompt.trim();
  if (!prompt) throw new Error('请先输入要处理的内容。');

  const userMessage: AgentChatMessage = { role: 'user', content: prompt };
  const workingMessages: AgentChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...compactHistory(args.history),
    userMessage,
  ];
  let totalToolCalls = 0;
  let proposal: NodeEditProposal | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const assistant = await invoke<AgentChatMessage>('agent_completion', {
      baseUrl: args.provider.baseUrl,
      model: args.provider.model,
      messages: workingMessages,
      tools: agentTools,
    });
    if (!assistant || assistant.role !== 'assistant') {
      throw new Error('模型返回了无效的助手消息。');
    }

    const calls = Array.isArray(assistant.tool_calls)
      ? assistant.tool_calls.filter(isToolCall)
      : [];
    workingMessages.push({
      role: 'assistant',
      content: typeof assistant.content === 'string' ? assistant.content : null,
      ...(calls.length ? { tool_calls: calls } : {}),
    });

    if (!calls.length) {
      const reply = assistant.content?.trim();
      if (!reply) {
        throw new Error(
          '模型没有返回文字或工具调用。请确认当前模型支持 OpenAI 兼容的工具调用。',
        );
      }
      return {
        reply,
        proposal,
        history: compactHistory([
          ...args.history,
          userMessage,
          { role: 'assistant', content: reply },
        ]),
      };
    }

    for (const call of calls) {
      totalToolCalls += 1;
      if (totalToolCalls > MAX_TOOL_CALLS) {
        throw new Error('工具调用次数达到上限，请把请求拆成更小的步骤。');
      }

      const action: AgentToolAction = {
        id: `${round}-${call.id}`,
        name: call.function.name,
        label: call.function.name,
        summary: '正在执行',
        status: 'running',
      };
      args.onAction(action);

      try {
        const execution = await executeAgentTool(
          call.function.name,
          call.function.arguments,
          args.capabilities,
        );
        proposal = execution.proposal ?? proposal;
        workingMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            version: execution.version,
            permission: execution.permission,
            ...execution.result,
          }),
        });
        args.onAction({
          ...action,
          label: execution.label,
          summary: execution.summary,
          status: execution.proposal ? 'approval' : 'done',
        });

        if (execution.proposal) {
          const reply = '修改预览已准备好。请检查提案，再选择应用或放弃。';
          return {
            reply,
            proposal: execution.proposal,
            history: compactHistory([
              ...args.history,
              userMessage,
              { role: 'assistant', content: reply },
            ]),
          };
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '工具执行失败。';
        workingMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: message }),
        });
        args.onAction({
          ...action,
          summary: message,
          status: 'failed',
        });
      }
    }
  }

  throw new Error(`模型连续 ${MAX_TOOL_ROUNDS} 轮仍未完成，请缩小请求范围。`);
}
