import type {
  AgentCallEvent,
  AgentToolAction,
  AgentToolArtifact,
} from '../../agent/types';
import { redactSensitiveValue } from '../../agent/session';
import type { CliAgentStreamEvent } from '../terminal-api';
import type {
  AgentRunPhase,
  AgentTurnRecord,
  ExecutionBlock,
} from './agent-workbench-types';

export { redactSensitiveValue };

const DISCONNECT_ERROR_RE =
  /(?:econnrefused|econnreset|etimedout|network error|failed to fetch|connection refused|dns error|socket hang up|bridge.*未就绪|无法连接|网络[^\n]{0,4}中断|连接[^\n]{0,4}断开)/i;

export function isDisconnectErrorMessage(message?: string): boolean {
  if (!message) return false;
  return DISCONNECT_ERROR_RE.test(message);
}

/**
 * Derives the exact 9-state execution phase for a turn (Spec §8).
 */
export function deriveTurnPhase(turn: AgentTurnRecord): AgentRunPhase {
  if (turn.disconnected) return 'disconnected';
  if (turn.status === 'cancelled') return 'cancelled';
  if (turn.status === 'failed') {
    return isDisconnectErrorMessage(turn.error) ? 'disconnected' : 'failed';
  }
  if (turn.status === 'paused') return 'awaiting-approval';
  if (turn.status === 'completed') return 'completed';

  // Active running turn: distinguish submitting / tool-running / streaming
  const hasActiveTool = turn.blocks.some(
    (b) =>
      (b.kind === 'tool' || b.kind === 'cli-tool') && b.status === 'running',
  );
  if (hasActiveTool) return 'tool-running';
  if (turn.reply.trim().length > 0 || (turn.streamBuffer ?? '').length > 0) {
    return 'streaming';
  }
  return 'submitting';
}

export function deriveSessionPhase(
  turns: AgentTurnRecord[],
  isBusy: boolean,
): AgentRunPhase {
  if (turns.length === 0) return isBusy ? 'submitting' : 'idle';
  const latest = turns[turns.length - 1];
  return deriveTurnPhase(latest);
}

function makeCliEventKey(payload: CliAgentStreamEvent): string {
  return `${payload.runId}|${payload.kind}|${payload.timestampMs}|${payload.toolName ?? ''}|${(payload.text ?? '').slice(0, 80)}`;
}

/**
 * Concurrent-safe CLI stream event adapter with event-key deduplication.
 * Never assumes CLI tools execute serially (never force-completes running sibling tools).
 * Safely renders unknown event kinds as generic read-only status logs.
 */
export function applyCliStreamEventSafe(
  turn: AgentTurnRecord,
  payload: CliAgentStreamEvent,
): AgentTurnRecord {
  if (turn.cliRunId !== payload.runId || turn.status !== 'running') {
    return turn;
  }

  const eventKey = makeCliEventKey(payload);
  const seen = turn.seenEventKeys ?? [];
  if (seen.includes(eventKey)) {
    return turn;
  }
  const nextSeen = [...seen.slice(-199), eventKey];

  const text = payload.text ?? '';
  if (payload.kind === 'text') {
    if (!text.trim()) {
      return { ...turn, seenEventKeys: nextSeen };
    }
    const prevBuf = turn.streamBuffer ?? '';
    const nextBuf = prevBuf ? `${prevBuf}\n${text}` : text;
    return {
      ...turn,
      seenEventKeys: nextSeen,
      streamBuffer: nextBuf,
      reply: nextBuf,
    };
  }

  if (payload.kind === 'tool') {
    const toolName = payload.toolName ?? 'tool';
    const blockId = `${payload.runId}-tool-${payload.timestampMs}-${toolName}-${turn.blocks.length}`;
    const nextBlock: ExecutionBlock = {
      id: blockId,
      kind: 'cli-tool',
      toolName,
      label: `${payload.engine.toUpperCase()} · ${toolName}`,
      status: 'running',
      summary: text.slice(0, 140),
      detail: text,
      timestampMs: payload.timestampMs,
    };
    return {
      ...turn,
      seenEventKeys: nextSeen,
      blocks: [...turn.blocks.slice(-49), nextBlock],
    };
  }

  if (payload.kind === 'tool_result' || payload.kind === 'tool_done') {
    const toolName = payload.toolName ?? '';
    const matchIdx = [...turn.blocks]
      .reverse()
      .findIndex(
        (b) =>
          b.kind === 'cli-tool' &&
          b.status === 'running' &&
          (!toolName || b.toolName === toolName),
      );
    if (matchIdx >= 0) {
      const realIdx = turn.blocks.length - 1 - matchIdx;
      const updated = turn.blocks.map((b, i) =>
        i === realIdx
          ? {
              ...b,
              status: 'done' as const,
              outputPreview: text || b.outputPreview,
            }
          : b,
      );
      return { ...turn, seenEventKeys: nextSeen, blocks: updated };
    }
  }

  // Fallback for status or any unknown event kind: safe generic read-only status block
  const statusBlock: ExecutionBlock = {
    id: `${payload.runId}-evt-${payload.timestampMs}-${turn.blocks.length}`,
    kind: 'status',
    label: `${payload.engine.toUpperCase()} · ${payload.kind || 'event'}`,
    status: 'done',
    summary: text.slice(0, 140),
    detail: text,
    timestampMs: payload.timestampMs,
  };
  return {
    ...turn,
    seenEventKeys: nextSeen,
    blocks: [...turn.blocks.slice(-49), statusBlock],
  };
}

function mergeTurnArtifacts(
  existing: AgentToolArtifact[] | undefined,
  incoming: AgentToolArtifact[] | undefined,
): AgentToolArtifact[] | undefined {
  if (!incoming || incoming.length === 0) return existing;
  const base = existing ? [...existing] : [];
  for (const art of incoming) {
    const key =
      art.kind === 'file-ref'
        ? `file:${art.path}`
        : art.kind === 'table'
          ? `table:${art.title}:${art.columns.join(',')}:${art.rows.length}`
          : `term:${art.title}:${(art.stdout ?? '').slice(0, 40)}:${(art.stderr ?? '').slice(0, 40)}`;
    const dup = base.some((b) => {
      const bk =
        b.kind === 'file-ref'
          ? `file:${b.path}`
          : b.kind === 'table'
            ? `table:${b.title}:${b.columns.join(',')}:${b.rows.length}`
            : `term:${b.title}:${(b.stdout ?? '').slice(0, 40)}:${(b.stderr ?? '').slice(0, 40)}`;
      return bk === key;
    });
    if (!dup) base.push(art);
  }
  return base;
}

/**
 * Applies an API/Hybrid `AgentCallEvent` by exact event ID (safe for concurrent tools
 * and duplicate emissions), preserving redacted input args, result previews, errors,
 * and structured artifacts.
 */
export function applyApiEventSafe(
  turn: AgentTurnRecord,
  event: AgentCallEvent,
  modelName: string,
): AgentTurnRecord {
  if (event.kind === 'model') {
    const tokenSummary = event.usage?.totalTokens
      ? `${event.usage.totalTokens.toLocaleString()} tok`
      : event.status === 'running'
        ? '推理请求中'
        : event.status === 'failed'
          ? '请求失败'
          : '响应已返回';
    const entry: ExecutionBlock = {
      id: event.id,
      kind: 'model',
      round: event.round,
      label: `Round ${event.round} · ${modelName}`,
      status: event.status,
      summary: tokenSummary,
      durationMs: event.durationMs,
      timestampMs: event.endedAt ?? event.startedAt,
      usage: event.usage,
    };
    const idx = turn.blocks.findIndex((b) => b.id === event.id);
    const blocks =
      idx >= 0
        ? turn.blocks.map((b, i) => (i === idx ? entry : b))
        : [...turn.blocks, entry];
    return { ...turn, blocks };
  }

  const toolEvent = event as AgentToolAction;
  const idx = turn.blocks.findIndex((b) => b.id === toolEvent.id);
  const existing = idx >= 0 ? turn.blocks[idx] : undefined;

  const entry: ExecutionBlock = {
    id: toolEvent.id,
    kind: 'tool',
    round: toolEvent.round,
    toolName: toolEvent.name,
    label:
      toolEvent.label && toolEvent.label !== toolEvent.name
        ? toolEvent.label
        : toolEvent.name,
    status: toolEvent.status,
    summary: toolEvent.summary,
    detail:
      toolEvent.errorDetail ?? toolEvent.outputPreview ?? toolEvent.summary,
    inputArgs: toolEvent.inputArgs ?? existing?.inputArgs,
    outputPreview: toolEvent.outputPreview ?? existing?.outputPreview,
    errorDetail: toolEvent.errorDetail ?? existing?.errorDetail,
    artifacts: toolEvent.artifacts ?? existing?.artifacts,
    durationMs: toolEvent.durationMs,
    timestampMs: toolEvent.endedAt ?? toolEvent.startedAt,
  };

  const blocks =
    idx >= 0
      ? turn.blocks.map((b, i) => (i === idx ? entry : b))
      : [...turn.blocks, entry];

  return {
    ...turn,
    blocks,
    artifacts: mergeTurnArtifacts(turn.artifacts, toolEvent.artifacts),
  };
}
