import { describe, expect, it } from 'vitest';
import {
  applyApiEventSafe,
  applyCliStreamEventSafe,
  deriveSessionPhase,
  deriveTurnPhase,
  isDisconnectErrorMessage,
  redactSensitiveValue,
} from '../src/terminal/agent/agent-event-adapter';
import {
  clampInspectorWidth,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
} from '../src/terminal/agent/agent-workbench-prefs';
import type { AgentTurnRecord } from '../src/terminal/agent/agent-workbench-types';
import { extractSessionArtifacts } from '../src/terminal/agent/agent-workbench-utils';
import { splitStableMarkdownSegments } from '../src/terminal/agent/blocks/AssistantMessageBlock';

function makeTurn(overrides: Partial<AgentTurnRecord> = {}): AgentTurnRecord {
  return {
    id: 'turn-1',
    userText: '/data #data 查询',
    engineLabel: 'HYBRID · deepseek-flash',
    engineMode: 'hybrid',
    status: 'running',
    attachedContexts: ['#data'],
    blocks: [],
    reply: '',
    startedAt: 1000,
    ...overrides,
  };
}

describe('agent-event-adapter & M1-M4 workbench guarantees', () => {
  it('redacts sensitive credentials recursively without corrupting normal args', () => {
    const redacted = redactSensitiveValue({
      sql: 'SELECT * FROM sales LIMIT 10',
      apiKey: 'sk-live-secret-123',
      totalTokens: 512,
      nested: {
        password: 'hunter2',
        authorization: 'Bearer xyz',
        safeCount: 42,
      },
      tokens: [{ access_token: 'abc', name: 'public' }],
    }) as Record<string, unknown>;

    expect(redacted.sql).toBe('SELECT * FROM sales LIMIT 10');
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.totalTokens).toBe(512);
    expect(redacted.nested).toEqual({
      password: '[REDACTED]',
      authorization: '[REDACTED]',
      safeCount: 42,
    });
    expect(redacted.tokens).toEqual([
      { access_token: '[REDACTED]', name: 'public' },
    ]);
  });

  it('does not assume serial CLI tool execution, deduplicates duplicate events, and handles unknown kinds safely', () => {
    let turn = makeTurn({
      engineMode: 'cli:claude',
      engineLabel: 'CLI · CLAUDE',
      cliRunId: 'cli-1',
    });

    turn = applyCliStreamEventSafe(turn, {
      runId: 'cli-1',
      engine: 'claude',
      kind: 'tool',
      text: 'call tool A',
      toolName: 'datalab_query_sql',
      timestampMs: 1100,
    });
    turn = applyCliStreamEventSafe(turn, {
      runId: 'cli-1',
      engine: 'claude',
      kind: 'tool',
      text: 'call tool B concurrently',
      toolName: 'library_search',
      timestampMs: 1105,
    });

    // Both concurrent tools must remain running rather than forcibly closing tool A
    expect(turn.blocks).toHaveLength(2);
    expect(turn.blocks[0].status).toBe('running');
    expect(turn.blocks[1].status).toBe('running');

    // Duplicate event emission is ignored
    const afterDup = applyCliStreamEventSafe(turn, {
      runId: 'cli-1',
      engine: 'claude',
      kind: 'tool',
      text: 'call tool B concurrently',
      toolName: 'library_search',
      timestampMs: 1105,
    });
    expect(afterDup.blocks).toHaveLength(2);

    // Unknown event kind safely degrades to a read-only status block
    const afterUnknown = applyCliStreamEventSafe(afterDup, {
      runId: 'cli-1',
      engine: 'claude',
      kind: 'custom_vendor_telemetry',
      text: 'opaque payload',
      timestampMs: 1200,
    });
    expect(afterUnknown.blocks).toHaveLength(3);
    expect(afterUnknown.blocks[2].kind).toBe('status');
    expect(afterUnknown.blocks[2].detail).toBe('opaque payload');
  });

  it('derives all 9 execution phases accurately (Spec §8)', () => {
    expect(deriveSessionPhase([], false)).toBe('idle');
    expect(deriveTurnPhase(makeTurn())).toBe('submitting');
    expect(deriveTurnPhase(makeTurn({ reply: '部分流式正文' }))).toBe(
      'streaming',
    );
    expect(
      deriveTurnPhase(
        makeTurn({
          blocks: [
            {
              id: 't-1',
              kind: 'tool',
              label: 'SQL',
              status: 'running',
            },
          ],
        }),
      ),
    ).toBe('tool-running');
    expect(deriveTurnPhase(makeTurn({ status: 'paused' }))).toBe(
      'awaiting-approval',
    );
    expect(deriveTurnPhase(makeTurn({ status: 'completed' }))).toBe(
      'completed',
    );
    expect(deriveTurnPhase(makeTurn({ status: 'cancelled' }))).toBe(
      'cancelled',
    );
    expect(
      deriveTurnPhase(makeTurn({ status: 'failed', error: 'Syntax error' })),
    ).toBe('failed');
    expect(
      deriveTurnPhase(
        makeTurn({ status: 'failed', error: 'ECONNREFUSED 127.0.0.1' }),
      ),
    ).toBe('disconnected');
    expect(isDisconnectErrorMessage('网络连接中断，请检查代理')).toBe(true);
  });

  it('attaches redacted args, output preview, and deduplicated table/file artifacts on API tool events', () => {
    let turn = makeTurn();

    turn = applyApiEventSafe(
      turn,
      {
        id: 'tool-1',
        kind: 'tool',
        round: 1,
        name: 'datalab_query_sql',
        label: '执行 SQL 查询',
        summary: '正在执行',
        status: 'running',
        startedAt: 1000,
        inputArgs: { sql: 'SELECT 1', password: '[REDACTED]' },
      },
      'deepseek-flash',
    );
    expect(turn.blocks[0].inputArgs).toEqual({
      sql: 'SELECT 1',
      password: '[REDACTED]',
    });

    const tableArtifact = {
      kind: 'table' as const,
      title: 'SQL 查询结果',
      columns: ['id', 'revenue'],
      rows: [
        [1, 120.5],
        [2, 340.0],
      ],
      totalRows: 2,
      engine: 'duckdb',
    };

    turn = applyApiEventSafe(
      turn,
      {
        id: 'tool-1',
        kind: 'tool',
        round: 1,
        name: 'datalab_query_sql',
        label: '执行 SQL 查询',
        summary: '返回 2 行',
        status: 'done',
        startedAt: 1000,
        endedAt: 1200,
        durationMs: 200,
        outputPreview: '{"rows": 2}',
        artifacts: [tableArtifact],
      },
      'deepseek-flash',
    );

    expect(turn.blocks[0].inputArgs?.password).toBe('[REDACTED]');
    expect(turn.blocks[0].outputPreview).toBe('{"rows": 2}');
    expect(turn.artifacts).toHaveLength(1);

    const indexed = extractSessionArtifacts([turn]);
    expect(indexed.some((a) => a.kind === 'table')).toBe(true);
  });

  it('splits markdown into stable memoizable segments without breaking code fences or math blocks', () => {
    const md = [
      '第一段说明',
      '行2',
      '行3',
      '行4',
      '行5',
      '行6',
      '',
      '```python',
      'def f(x):',
      '',
      '    return x * 2',
      '```',
      '',
      '$$',
      'a + b',
      '',
      '= c',
      '$$',
    ].join('\n');

    const segments = splitStableMarkdownSegments(md);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    const codeSeg = segments.find((s) => s.includes('def f(x):'));
    expect(codeSeg).toContain('return x * 2');
    expect(codeSeg).toContain('```python');
    const mathSeg = segments.find((s) => s.includes('a + b'));
    expect(mathSeg).toContain('= c');
  });

  it('clamps inspector width strictly within allowed bounds', () => {
    expect(clampInspectorWidth(120)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(900)).toBe(INSPECTOR_MAX_WIDTH);
    expect(clampInspectorWidth(295.6)).toBe(296);
  });
});
