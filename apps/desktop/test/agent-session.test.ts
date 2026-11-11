import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agentToolCatalog,
  agentToolDefinitionsFor,
} from '../src/agent/capabilities';
import { LEARNING_PATH_BUDGET } from '../src/agent/learning-path-budget';
import { agentProfiles } from '../src/agent/profiles';
import { compactHistory, completeToolBatch } from '../src/agent/session';
import type { AgentChatMessage, AgentToolCall } from '../src/agent/types';

const MAX_AGENT_TOOLS = 24;

function toolCall(id: string, name: string): AgentToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  };
}

function assistantWithCalls(calls: AgentToolCall[]): AgentChatMessage {
  return { role: 'assistant', content: null, tool_calls: calls };
}

function toolMessage(
  id: string,
  body: Record<string, unknown>,
): AgentChatMessage {
  return {
    role: 'tool',
    tool_call_id: id,
    content: JSON.stringify(body),
  };
}

function pairedIds(history: AgentChatMessage[]) {
  const calls = new Map<string, number>();
  for (const message of history) {
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) {
        calls.set(call.id, (calls.get(call.id) ?? 0) + 1);
      }
    }
  }
  const answers = history
    .filter((message) => message.role === 'tool')
    .map((message) => message.tool_call_id);
  return { calls, answers };
}

describe('agent session history', () => {
  it('shrinks old read-only tool results and keeps each tool call paired', () => {
    const longRead = { permission: 'read', version: 1, body: 'x'.repeat(500) };
    const history: AgentChatMessage[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id = `read-${index}`;
      history.push(assistantWithCalls([toolCall(id, 'library_search')]));
      history.push(toolMessage(id, longRead));
    }
    const approvalId = 'approval-1';
    history.push(
      assistantWithCalls([toolCall(approvalId, 'mindmap_propose_node_branch')]),
    );
    history.push(
      toolMessage(approvalId, {
        permission: 'user_approval',
        status: 'awaiting_user_approval',
        body: 'y'.repeat(500),
      }),
    );

    const compacted = compactHistory(history, {
      maxMessages: 4,
      keepRecentToolResults: 1,
      shrinkAt: 120,
    });
    const { calls, answers } = pairedIds(compacted);
    for (const [id, count] of calls) {
      expect(answers.filter((answer) => answer === id)).toHaveLength(count);
    }
    expect(answers.filter((answer) => !calls.has(answer ?? ''))).toEqual([]);

    const readBodies = compacted
      .filter((message) => message.tool_call_id?.startsWith('read-'))
      .map(
        (message) =>
          JSON.parse(message.content ?? '{}') as { compacted?: boolean },
      );
    expect(readBodies.length).toBeGreaterThan(0);
    expect(readBodies.every((body) => body.compacted)).toBe(true);
    const approval = compacted.find(
      (message) => message.tool_call_id === approvalId,
    );
    expect(approval?.content).toContain('awaiting_user_approval');
    expect(approval?.content).not.toContain('"compacted":true');
  });

  it('keeps an assistant tool batch whole when it is larger than the message cap', () => {
    const calls = [
      toolCall('a', 'library_search'),
      toolCall('b', 'library_read_document'),
    ];
    const history = [
      { role: 'user' as const, content: '先看一下' },
      assistantWithCalls(calls),
      toolMessage('a', { permission: 'read', version: 1, body: 'short' }),
      toolMessage('b', { permission: 'read', version: 1, body: 'short' }),
    ];
    const compacted = compactHistory(history, { maxMessages: 1 });
    const { calls: kept, answers } = pairedIds(compacted);
    expect([...kept.keys()].sort()).toEqual(['a', 'b']);
    expect(answers.sort()).toEqual(['a', 'b']);
  });

  it('fills a tool response for calls skipped when a proposal pauses the batch', () => {
    const calls = [
      toolCall('done', 'favorites_get_board'),
      toolCall('later', 'favorites_propose_categorization'),
    ];
    const done = [toolMessage('done', { permission: 'read', version: 1 })];
    const completed = completeToolBatch(
      calls,
      done,
      JSON.stringify({ error: '会话已暂停等待确认，此调用未执行。' }),
    );
    expect(completed.map((message) => message.tool_call_id)).toEqual([
      'done',
      'later',
    ]);
    expect(completed[1]?.content).toContain('未执行');
  });
});

describe('agent profiles', () => {
  it('keeps each profile tool set inside the catalog and that profile cap', () => {
    const catalog = new Set(agentToolCatalog.map((tool) => tool.name));
    for (const profile of Object.values(agentProfiles)) {
      if (!profile.surface) {
        expect(profile.id).toBe('terminal');
        continue;
      }
      const names = agentToolDefinitionsFor(profile.surface).map(
        (tool) => tool.function.name,
      );
      expect(names.length).toBeGreaterThan(0);
      expect(names.length).toBeLessThanOrEqual(profile.maxToolCalls);
      expect(names.length).toBeLessThanOrEqual(MAX_AGENT_TOOLS);
      for (const name of names) expect(catalog.has(name)).toBe(true);
    }
    expect(
      agentToolDefinitionsFor('learning-path').map(
        (tool) => tool.function.name,
      ),
    ).toEqual([
      'player_search_youtube',
      'learning_path_list',
      'learning_path_get',
      'learning_path_propose',
    ]);
  });

  it('uses one learning-path budget in the prompt, the tools, and the terminal rules', () => {
    const prompt = agentProfiles['learning-path'].systemPrompt;
    const budget = LEARNING_PATH_BUDGET;
    expect(prompt).toContain(`${budget.minSearches}–${budget.maxSearches} 次`);
    expect(prompt).toContain(`limit 为 ${budget.searchLimit}`);
    expect(prompt).toContain(`${budget.minStages}–${budget.maxStages} 个`);
    expect(prompt).toContain(`${budget.minNodes}–${budget.maxNodes} 个`);
    expect(prompt).toContain(`${budget.maxRounds} 轮`);
    expect(prompt).toContain(`${budget.maxToolCalls} 次工具`);
    expect(prompt).not.toMatch(/6–1[02]/);
    expect(prompt).not.toMatch(/3[05]–6[05]/);
    expect(prompt).not.toMatch(/30–80/);
    expect(agentProfiles['learning-path'].maxRounds).toBe(budget.maxRounds);
    expect(agentProfiles['learning-path'].maxToolCalls).toBe(
      budget.maxToolCalls,
    );

    const search = agentToolCatalog.find(
      (tool) => tool.name === 'player_search_youtube',
    );
    const propose = agentToolCatalog.find(
      (tool) => tool.name === 'learning_path_propose',
    );
    expect(search?.description).toContain(
      `${budget.minSearches}–${budget.maxSearches} 次`,
    );
    expect(search?.description).toContain(String(budget.searchLimit));
    expect(search?.description).not.toContain('6–12');
    expect(propose?.description).toContain(
      `${budget.minStages}–${budget.maxStages}`,
    );
    expect(propose?.description).toContain(
      `${budget.minNodes}–${budget.maxNodes}`,
    );
    expect(propose?.description).not.toContain('30–80');

    const rustPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src-tauri/src/agent/agent_bridge.rs',
    );
    const rust = readFileSync(rustPath, 'utf8');
    expect(rust).toContain('4–6 次');
    expect(rust).toContain('limit: 12');
    expect(rust).toContain('16–28');
    expect(rust).toContain('10 轮');
    expect(rust).toContain('12 次工具');
    expect(rust).not.toContain('6–12 次');
    expect(rust).not.toContain('35–65');
  });
});
