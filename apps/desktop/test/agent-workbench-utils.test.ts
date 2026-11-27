import { describe, expect, it } from 'vitest';
import type { AgentTurnRecord } from '../src/terminal/agent/agent-workbench-types';
import {
  aggregateReportedUsage,
  applyApiAgentEventToTurn,
  applyCliStreamEventToTurn,
  attachTokenToInput,
  extractContextTagsFromInput,
  extractSessionArtifacts,
  formatDurationCompact,
  groupCliModelOptions,
  removeContextTagFromInput,
  resolveCliRunOutcome,
} from '../src/terminal/agent/agent-workbench-utils';

function makeRunningTurn(
  overrides: Partial<AgentTurnRecord> = {},
): AgentTurnRecord {
  return {
    id: 'turn-1',
    userText: '/data #data 分析销售额',
    engineLabel: 'CLI · CLAUDE',
    engineMode: 'cli:claude',
    status: 'running',
    attachedContexts: ['#data'],
    blocks: [],
    reply: '',
    startedAt: 1000,
    cliRunId: 'cli-1000',
    ...overrides,
  };
}

describe('agent-workbench-utils', () => {
  it('extracts, attaches, and cleanly removes #context tags in composer input', () => {
    const start = '帮我总结 #chapter 和 #kb:系统设计';
    expect(extractContextTagsFromInput(start)).toEqual([
      '#chapter',
      '#kb:系统设计',
    ]);

    // Attaching existing tag does not duplicate
    expect(attachTokenToInput(start, '#chapter')).toBe(start);

    // Attaching new tag appends with spacing
    const withData = attachTokenToInput(start, '#data');
    expect(withData).toBe('帮我总结 #chapter 和 #kb:系统设计 #data ');
    expect(extractContextTagsFromInput(withData)).toEqual([
      '#chapter',
      '#kb:系统设计',
      '#data',
    ]);

    // Removing a tag cleans whitespace without corrupting other tokens
    const removed = removeContextTagFromInput(withData, '#chapter');
    expect(removed).toBe('帮我总结 和 #kb:系统设计 #data ');
    expect(extractContextTagsFromInput(removed)).toEqual([
      '#kb:系统设计',
      '#data',
    ]);

    // Removing leading tag trims leading space
    expect(removeContextTagFromInput('#data 分析表', '#data')).toBe('分析表');
  });

  it('streams CLI text incrementally without polluting execution blocks, and records tools separately', () => {
    let turn = makeRunningTurn();

    turn = applyCliStreamEventToTurn(turn, {
      runId: 'cli-1000',
      engine: 'claude',
      kind: 'tool',
      text: '调用工具: datalab_query_sql',
      toolName: 'datalab_query_sql',
      timestampMs: 1100,
    });
    expect(turn.blocks).toHaveLength(1);
    expect(turn.blocks[0].kind).toBe('cli-tool');
    expect(turn.blocks[0].status).toBe('running');
    expect(turn.reply).toBe('');

    turn = applyCliStreamEventToTurn(turn, {
      runId: 'cli-1000',
      engine: 'claude',
      kind: 'text',
      text: '第一段结论',
      timestampMs: 1200,
    });
    turn = applyCliStreamEventToTurn(turn, {
      runId: 'cli-1000',
      engine: 'claude',
      kind: 'text',
      text: '第二段补充',
      timestampMs: 1300,
    });
    expect(turn.reply).toBe('第一段结论\n第二段补充');
    expect(turn.blocks).toHaveLength(1);

    // Ignores events for other runIds or finished turns
    const otherRun = applyCliStreamEventToTurn(turn, {
      runId: 'cli-9999',
      engine: 'claude',
      kind: 'text',
      text: '不应写入',
      timestampMs: 1400,
    });
    expect(otherRun.reply).toBe('第一段结论\n第二段补充');
  });

  it('never misclassifies cancelled or failed CLI runs as completed', () => {
    const cancelledByStderr = resolveCliRunOutcome(
      {
        runId: 'cli-1',
        engine: 'claude',
        success: false,
        exitCode: 1,
        reply: '',
        stderr: 'terminated\n[已由用户手动终止]',
        eventsCount: 2,
        durationMs: 420,
        usedMcp: true,
      },
      false,
    );
    expect(cancelledByStderr.status).toBe('cancelled');
    expect(cancelledByStderr.error).toBeUndefined();

    const cancelledLocally = resolveCliRunOutcome(
      {
        runId: 'cli-2',
        engine: 'agy',
        success: true,
        exitCode: 0,
        reply: 'stale',
        stderr: '',
        eventsCount: 1,
        durationMs: 120,
        usedMcp: false,
      },
      true,
    );
    expect(cancelledLocally.status).toBe('cancelled');

    const failedRun = resolveCliRunOutcome(
      {
        runId: 'cli-3',
        engine: 'codex',
        success: false,
        exitCode: 2,
        reply: '',
        stderr: 'Error: authentication expired',
        eventsCount: 0,
        durationMs: 300,
        usedMcp: false,
      },
      false,
    );
    expect(failedRun.status).toBe('failed');
    expect(failedRun.error).toContain('authentication expired');

    const okRun = resolveCliRunOutcome(
      {
        runId: 'cli-4',
        engine: 'gemini',
        success: true,
        exitCode: 0,
        reply: '完成',
        stderr: '',
        eventsCount: 5,
        durationMs: 900,
        usedMcp: true,
      },
      false,
    );
    expect(okRun.status).toBe('completed');
    expect(okRun.error).toBeUndefined();
  });

  it('applies API model & tool events and aggregates only genuine provider-reported usage', () => {
    let turn = makeRunningTurn({
      engineMode: 'hybrid',
      engineLabel: 'HYBRID · deepseek-flash',
      cliRunId: undefined,
    });

    turn = applyApiAgentEventToTurn(
      turn,
      {
        id: 'm-1',
        kind: 'model',
        round: 1,
        status: 'running',
        startedAt: 1000,
        contextTokensEstimate: 420,
      },
      'deepseek-flash',
    );
    expect(turn.blocks).toHaveLength(1);
    expect(turn.blocks[0].status).toBe('running');

    // No provider usage reported yet -> must remain 0 reportedRequests
    expect(aggregateReportedUsage([turn]).reportedRequests).toBe(0);

    turn = applyApiAgentEventToTurn(
      turn,
      {
        id: 'm-1',
        kind: 'model',
        round: 1,
        status: 'done',
        startedAt: 1000,
        endedAt: 1650,
        durationMs: 650,
        contextTokensEstimate: 420,
        usage: { promptTokens: 300, completionTokens: 120, totalTokens: 420 },
      },
      'deepseek-flash',
    );
    turn = applyApiAgentEventToTurn(
      turn,
      {
        id: 't-1',
        kind: 'tool',
        round: 1,
        name: 'datalab_query_sql',
        label: '执行 SQL 查询',
        summary: '返回 12 行',
        status: 'done',
        startedAt: 1700,
        endedAt: 1850,
        durationMs: 150,
      },
      'deepseek-flash',
    );

    expect(turn.blocks).toHaveLength(2);
    expect(turn.blocks[0].durationMs).toBe(650);
    expect(turn.blocks[1].kind).toBe('tool');
    expect(turn.blocks[1].toolName).toBe('datalab_query_sql');

    const agg = aggregateReportedUsage([turn]);
    expect(agg).toEqual({
      promptTokens: 300,
      completionTokens: 120,
      totalTokens: 420,
      reportedRequests: 1,
    });
  });

  it('extracts fenced code blocks and terminal proposals as navigable artifacts', () => {
    const turn = makeRunningTurn({
      status: 'completed',
      reply: [
        '这是验证脚本：',
        '```python',
        'import math',
        'print(math.pi)',
        '```',
      ].join('\n'),
      terminalProposal: {
        command: 'pytest -q',
        paneIndex: 2,
        reason: '验证测试',
      },
    });
    const artifacts = extractSessionArtifacts([turn]);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({
      kind: 'code',
      language: 'python',
      lineCount: 3,
      turnIndex: 1,
    });
    expect(artifacts[1]).toMatchObject({
      kind: 'command',
      language: 'pane:2',
      title: 'pytest -q',
    });
  });

  it('groups CLI model options by family and formats durations compactly', () => {
    const groups = groupCliModelOptions({
      engine: 'agy',
      currentDefault: 'Gemini 3.1 Pro (High)',
      models: [],
      source: 'presets',
      options: [
        {
          id: 'Gemini 3.1 Pro (Low)',
          label: 'Gemini 3.1 Pro (Low)',
          family: 'Gemini 3.1 Pro',
          tier: 'Low',
        },
        {
          id: 'Gemini 3.1 Pro (High)',
          label: 'Gemini 3.1 Pro (High)',
          family: 'Gemini 3.1 Pro',
          tier: 'High',
        },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].defaultVariant.tier).toBe('High');
    expect(formatDurationCompact(450)).toBe('450ms');
    expect(formatDurationCompact(2450)).toBe('2.5s');
    expect(formatDurationCompact(undefined)).toBeNull();
  });
});
