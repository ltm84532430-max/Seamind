import { agentApi } from './agent-api';
import type { AgentCapabilities } from './tool-api';
import type { AgentProfile } from './profiles';
import { agentToolDefinitionsFor, executeAgentTool } from './tools/registry';
import type {
  AgentChatMessage,
  AgentCallEvent,
  AgentToolAction,
  AgentToolCall,
  AgentTurnUsage,
  CompletionUsage,
  FavoritesCategorizationProposal,
  KnowledgeNoteProposal,
  LearningPathProposal,
  NodeEditProposal,
  ReaderChapterProposal,
} from './types';
import type { AgentToolResult } from './tool-api';

const MAX_CONTEXT_BYTES = 250_000;
const MAX_HISTORY_MESSAGES = 40;
const KEEP_RECENT_TOOL_RESULTS = 4;
const SHRINK_TOOL_RESULT_AT = 800;

export interface AgentProviderSettings {
  baseUrl: string;
  model: string;
}

export interface AgentSessionPause {
  proposal: NodeEditProposal | null;
  learningPathProposal: LearningPathProposal | null;
  favoritesCategorizationProposal: FavoritesCategorizationProposal | null;
  knowledgeNoteProposal: KnowledgeNoteProposal | null;
  readerChapterProposal: ReaderChapterProposal | null;
}

export interface AgentSessionResult {
  reply: string;
  status: 'completed' | 'paused';
  pause: AgentSessionPause | null;
  proposal: NodeEditProposal | null;
  learningPathProposal: LearningPathProposal | null;
  favoritesCategorizationProposal: FavoritesCategorizationProposal | null;
  history: AgentChatMessage[];
  usage: AgentTurnUsage;
  roundsUsed: number;
  toolCallsUsed: number;
}

interface AgentCompletionResponse extends AgentChatMessage {
  usage?: CompletionUsage;
}

export interface CompactHistoryOptions {
  maxMessages?: number;
  keepRecentToolResults?: number;
  shrinkAt?: number;
}

export function estimateTokenCount(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    const code = character.codePointAt(0) || 0;
    if (
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    )
      cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

function addReportedUsage(total: AgentTurnUsage, usage?: CompletionUsage) {
  if (!usage) return;
  const values = [
    usage.promptTokens,
    usage.completionTokens,
    usage.totalTokens,
  ];
  if (
    values.some(
      (value) => Number.isSafeInteger(value) && (value as number) >= 0,
    )
  )
    total.reportedRequests += 1;
  if (
    Number.isSafeInteger(usage.promptTokens) &&
    (usage.promptTokens as number) >= 0
  ) {
    total.promptTokens += usage.promptTokens as number;
    total.promptReportedRequests += 1;
  }
  if (
    Number.isSafeInteger(usage.completionTokens) &&
    (usage.completionTokens as number) >= 0
  ) {
    total.completionTokens += usage.completionTokens as number;
    total.completionReportedRequests += 1;
  }
  if (
    Number.isSafeInteger(usage.totalTokens) &&
    (usage.totalTokens as number) >= 0
  ) {
    total.totalTokens += usage.totalTokens as number;
    total.totalReportedRequests += 1;
  }
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

function shrinkReadOnlyToolContent(content: string, shrinkAt: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return content;
  }
  const record = parsed as Record<string, unknown>;
  if (record.permission !== 'read' || content.length <= shrinkAt)
    return content;
  return JSON.stringify({
    version: record.version ?? 1,
    permission: 'read',
    compacted: true,
    summary: content.slice(0, Math.min(180, shrinkAt)),
  });
}

function groupsOf(history: AgentChatMessage[]): AgentChatMessage[][] {
  const groups: AgentChatMessage[][] = [];
  let index = 0;
  while (index < history.length) {
    const message = history[index];
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const group = [message];
      index += 1;
      while (index < history.length && history[index].role === 'tool') {
        group.push(history[index]);
        index += 1;
      }
      groups.push(group);
      continue;
    }
    groups.push([message]);
    index += 1;
  }
  return groups;
}

export function compactHistory(
  history: AgentChatMessage[],
  options: CompactHistoryOptions = {},
): AgentChatMessage[] {
  const maxMessages = options.maxMessages ?? MAX_HISTORY_MESSAGES;
  const keepRecent = options.keepRecentToolResults ?? KEEP_RECENT_TOOL_RESULTS;
  const shrinkAt = options.shrinkAt ?? SHRINK_TOOL_RESULT_AT;
  const toolIndexes = history.flatMap((message, index) =>
    message.role === 'tool' ? [index] : [],
  );
  const shrinkable = new Set(
    toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent)),
  );
  const shrunk = history.map((message, index) => {
    if (!shrinkable.has(index) || message.role !== 'tool' || !message.content) {
      return message;
    }
    const content = shrinkReadOnlyToolContent(message.content, shrinkAt);
    return content === message.content ? message : { ...message, content };
  });
  let groups = groupsOf(shrunk);
  while (
    groups.reduce((count, group) => count + group.length, 0) > maxMessages &&
    groups.length > 1
  ) {
    groups = groups.slice(1);
  }
  return groups.flat();
}

export function completeToolBatch(
  calls: Array<{ id: string }>,
  messages: AgentChatMessage[],
  skippedContent: string,
): AgentChatMessage[] {
  const answered = new Set(
    messages
      .filter((message) => message.role === 'tool' && message.tool_call_id)
      .map((message) => message.tool_call_id),
  );
  const pending = calls
    .filter((call) => !answered.has(call.id))
    .map((call) => ({
      role: 'tool' as const,
      tool_call_id: call.id,
      content: skippedContent,
    }));
  return [...messages, ...pending];
}

export function noteSessionResolution(
  history: AgentChatMessage[],
  text: string,
): AgentChatMessage[] {
  const note = text.trim();
  if (!note) return compactHistory(history);
  return compactHistory([...history, { role: 'user', content: note }]);
}

function pauseFrom(execution: AgentToolResult): AgentSessionPause | null {
  if (
    !execution.proposal &&
    !execution.learningPathProposal &&
    !execution.favoritesCategorizationProposal &&
    !execution.knowledgeNoteProposal &&
    !execution.readerChapterProposal
  ) {
    return null;
  }
  return {
    proposal: execution.proposal ?? null,
    learningPathProposal: execution.learningPathProposal ?? null,
    favoritesCategorizationProposal:
      execution.favoritesCategorizationProposal ?? null,
    knowledgeNoteProposal: execution.knowledgeNoteProposal ?? null,
    readerChapterProposal: execution.readerChapterProposal ?? null,
  };
}

function pauseReply(
  execution: AgentToolResult,
  assistantContent: string | null,
): string {
  if (execution.proposal) {
    return '修改预览已准备好。请检查提案，再选择应用或放弃。';
  }
  if (execution.learningPathProposal) {
    return (
      assistantContent?.trim() ||
      `已生成学习路径「${execution.learningPathProposal.input.title}」的预览提案，请在弹窗中检查视频列表并点击确认保存。`
    );
  }
  if (execution.favoritesCategorizationProposal) {
    return assistantContent?.trim() || '已生成收藏分类整理预览，请确认后应用。';
  }
  if (execution.knowledgeNoteProposal) {
    return '笔记修改预览已准备好。请确认或放弃后再继续。';
  }
  if (execution.readerChapterProposal) {
    return '章节跳转预览已准备好。请确认或放弃后再继续。';
  }
  return assistantContent?.trim() || '已暂停，等待确认。';
}

function emptyUsage(): AgentTurnUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reportedRequests: 0,
    requestCount: 0,
    promptReportedRequests: 0,
    completionReportedRequests: 0,
    totalReportedRequests: 0,
    contextTokensEstimate: 0,
  };
}

export async function runAgentSession(args: {
  profile: AgentProfile;
  prompt: string;
  history?: AgentChatMessage[];
  provider: AgentProviderSettings;
  capabilities: AgentCapabilities;
  contextMessages?: AgentChatMessage[];
  onEvent?(event: AgentCallEvent): void;
}): Promise<AgentSessionResult> {
  if (!args.profile.surface) {
    throw new Error(
      '终端里的 Agent 使用当前工作区的 MCP 工具，不走应用内会话。',
    );
  }
  const prompt = args.prompt.trim() || args.profile.fallbackPrompt || '';
  if (!prompt) throw new Error(args.profile.emptyPromptMessage);

  const prior = compactHistory(args.history ?? []);
  const userMessage: AgentChatMessage = { role: 'user', content: prompt };
  const workingMessages: AgentChatMessage[] = [
    { role: 'system', content: args.profile.systemPrompt },
    ...(args.contextMessages ?? []),
    ...prior,
    userMessage,
  ];
  const prefixCount = workingMessages.length;
  const tools = agentToolDefinitionsFor(args.profile.surface);
  const usage = emptyUsage();
  let totalToolCalls = 0;

  const finish = (
    status: 'completed' | 'paused',
    reply: string,
    pause: AgentSessionPause | null,
    roundsUsed: number,
  ): AgentSessionResult => ({
    reply,
    status,
    pause,
    proposal: pause?.proposal ?? null,
    learningPathProposal: pause?.learningPathProposal ?? null,
    favoritesCategorizationProposal:
      pause?.favoritesCategorizationProposal ?? null,
    history: compactHistory([
      ...prior,
      userMessage,
      ...workingMessages.slice(prefixCount),
    ]),
    usage,
    roundsUsed,
    toolCallsUsed: totalToolCalls,
  });

  for (let round = 0; round < args.profile.maxRounds; round += 1) {
    const requestBytes = new TextEncoder().encode(
      JSON.stringify(workingMessages),
    ).byteLength;
    if (requestBytes > MAX_CONTEXT_BYTES) {
      throw new Error(args.profile.contextOverflowMessage);
    }
    usage.contextTokensEstimate = estimateTokenCount(
      JSON.stringify(workingMessages),
    );
    const startedAt = Date.now();
    const requestEvent = {
      id: `${args.profile.id}-model-${round + 1}`,
      kind: 'model' as const,
      round: round + 1,
      startedAt,
      contextTokensEstimate: usage.contextTokensEstimate,
    };
    usage.requestCount += 1;
    args.onEvent?.({ ...requestEvent, status: 'running' });
    let assistant: AgentCompletionResponse;
    try {
      assistant = await agentApi.complete({
        baseUrl: args.provider.baseUrl,
        model: args.provider.model,
        messages: workingMessages,
        tools,
      });
    } catch (error) {
      const endedAt = Date.now();
      args.onEvent?.({
        ...requestEvent,
        status: 'failed',
        endedAt,
        durationMs: endedAt - startedAt,
      });
      throw error;
    }
    const requestEndedAt = Date.now();
    args.onEvent?.({
      ...requestEvent,
      status: 'done',
      endedAt: requestEndedAt,
      durationMs: requestEndedAt - startedAt,
      ...(assistant?.usage ? { usage: assistant.usage } : {}),
    });
    if (!assistant || assistant.role !== 'assistant') {
      throw new Error('模型返回了无效的助手消息。');
    }
    addReportedUsage(usage, assistant.usage);

    const calls = Array.isArray(assistant.tool_calls)
      ? assistant.tool_calls.filter(isToolCall)
      : [];
    const assistantContent =
      typeof assistant.content === 'string' ? assistant.content : null;
    workingMessages.push({
      role: 'assistant',
      content: assistantContent,
      ...(calls.length ? { tool_calls: calls } : {}),
    });

    if (!calls.length) {
      const reply = assistantContent?.trim();
      if (!reply) {
        throw new Error(
          '模型没有返回文字或工具调用。请确认当前模型支持 OpenAI 兼容的工具调用。',
        );
      }
      return finish('completed', reply, null, round + 1);
    }

    const batchTools: AgentChatMessage[] = [];
    for (const call of calls) {
      totalToolCalls += 1;
      if (totalToolCalls > args.profile.maxToolCalls) {
        throw new Error('工具调用次数达到上限，请把请求拆成更小的步骤。');
      }
      const action: AgentToolAction = {
        id: `${args.profile.id}-tool-${round + 1}-${call.id}`,
        kind: 'tool',
        round: round + 1,
        name: call.function.name,
        label: call.function.name,
        summary: '正在执行',
        status: 'running',
        startedAt: Date.now(),
      };
      args.onEvent?.(action);
      try {
        const execution = await executeAgentTool(
          call.function.name,
          call.function.arguments,
          args.capabilities,
        );
        const toolMessage: AgentChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            version: execution.version,
            permission: execution.permission,
            ...execution.result,
          }),
        };
        batchTools.push(toolMessage);
        workingMessages.push(toolMessage);
        const pause = pauseFrom(execution);
        const endedAt = Date.now();
        args.onEvent?.({
          ...action,
          label: execution.label,
          summary: execution.summary,
          status: pause ? 'approval' : 'done',
          endedAt,
          durationMs: endedAt - action.startedAt,
        });
        if (pause) {
          const skipped = JSON.stringify({
            error: '会话已暂停等待确认，此调用未执行。',
          });
          const completed = completeToolBatch(calls, batchTools, skipped);
          for (const extra of completed.slice(batchTools.length)) {
            workingMessages.push(extra);
          }
          const reply = pauseReply(execution, assistantContent);
          workingMessages.push({ role: 'assistant', content: reply });
          return finish('paused', reply, pause, round + 1);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '工具执行失败。';
        const toolMessage: AgentChatMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: message }),
        };
        batchTools.push(toolMessage);
        workingMessages.push(toolMessage);
        const endedAt = Date.now();
        args.onEvent?.({
          ...action,
          summary: message,
          status: 'failed',
          endedAt,
          durationMs: endedAt - action.startedAt,
        });
      }
    }
  }

  throw new Error(
    `模型连续 ${args.profile.maxRounds} 轮仍未完成，请缩小请求范围。`,
  );
}
