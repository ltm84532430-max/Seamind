import {
  TERMINAL_RESOURCE_MENTIONS,
  TERMINAL_SLASH_COMMANDS,
} from '../terminal-agent-protocol';
import type {
  AgentCallEvent,
  AgentToolAction,
  AgentTurnUsage,
} from '../../agent/types';
import type {
  CliAgentRunResult,
  CliAgentStreamEvent,
  CliModelOption,
  CliModelsCatalog,
} from '../terminal-api';
import type {
  AgentTurnRecord,
  AgentTurnStatus,
  CliEngineId,
  ExecutionBlock,
  ModelFamilyGroup,
  SessionArtifactItem,
} from './agent-workbench-types';

const CLI_MODELS_STORAGE_KEY = 'seamind:terminal-cli-models:v1';

const TIER_SORT_WEIGHT: Record<string, number> = {
  low: 10,
  lite: 15,
  medium: 20,
  high: 30,
  xhigh: 40,
  argon: 12,
  carbon: 22,
  neon: 32,
  thinking: 35,
  preview: 45,
  latest: 50,
};

export function tierSortWeight(tier?: string | null): number {
  if (!tier) return 0;
  return TIER_SORT_WEIGHT[tier.trim().toLowerCase()] ?? 60;
}

export function splitFallbackModelLabel(raw: string): CliModelOption {
  const trimmed = raw.trim();
  const openIdx = trimmed.lastIndexOf('(');
  if (trimmed.endsWith(')') && openIdx > 0) {
    const family = trimmed.slice(0, openIdx).trim();
    const tier = trimmed.slice(openIdx + 1, -1).trim();
    if (family && tier) {
      return { id: trimmed, label: trimmed, family, tier };
    }
  }
  return { id: trimmed, label: trimmed, family: trimmed, tier: null };
}

export function matchModelOption(
  opt: CliModelOption,
  value?: string | null,
): boolean {
  const needle = (value ?? '').trim().toLowerCase();
  if (!needle) return false;
  return (
    opt.id.trim().toLowerCase() === needle ||
    opt.label.trim().toLowerCase() === needle
  );
}

export function groupCliModelOptions(
  catalog?: CliModelsCatalog | null,
): ModelFamilyGroup[] {
  const rawOptions: CliModelOption[] =
    catalog?.options && catalog.options.length > 0
      ? catalog.options
      : (catalog?.models ?? []).map(splitFallbackModelLabel);

  const byFamily = new Map<string, CliModelOption[]>();
  for (const opt of rawOptions) {
    const key = opt.family.trim() || opt.label.trim() || opt.id.trim();
    if (!key) continue;
    const list = byFamily.get(key) ?? [];
    if (
      !list.some(
        (existing) => existing.id.toLowerCase() === opt.id.toLowerCase(),
      )
    ) {
      list.push(opt);
      byFamily.set(key, list);
    }
  }

  const groups: ModelFamilyGroup[] = [];
  for (const [family, variants] of byFamily.entries()) {
    const sorted = [...variants].sort(
      (a, b) => tierSortWeight(a.tier) - tierSortWeight(b.tier),
    );
    const preferred =
      sorted.find((v) => v.tier?.toLowerCase() === 'high') ??
      sorted.find((v) => v.tier?.toLowerCase() === 'medium') ??
      sorted.find((v) => v.tier?.toLowerCase() === 'neon') ??
      sorted[0];
    groups.push({
      family,
      variants: sorted,
      defaultVariant: preferred,
    });
  }
  return groups;
}

export function loadSavedCliModels(): Record<CliEngineId, string> {
  const defaults: Record<CliEngineId, string> = {
    agy: '',
    gemini: '',
    claude: '',
    codex: '',
  };
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem(CLI_MODELS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<CliEngineId, string>>;
    return {
      agy: typeof parsed.agy === 'string' ? parsed.agy : '',
      gemini: typeof parsed.gemini === 'string' ? parsed.gemini : '',
      claude: typeof parsed.claude === 'string' ? parsed.claude : '',
      codex: typeof parsed.codex === 'string' ? parsed.codex : '',
    };
  } catch {
    return defaults;
  }
}

export function saveCliModels(models: Record<CliEngineId, string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CLI_MODELS_STORAGE_KEY, JSON.stringify(models));
  } catch {
    // ignore storage errors
  }
}

const CONTEXT_MENTION_RE =
  /(?:^|\s)(#([a-zA-Z0-9\u4e00-\u9fa5_-]+)(?::([^\s#]+))?)/g;

/**
 * Extracts unique `#context` tokens present in the current composer text so they can
 * be rendered as removable tags above the input.
 */
export function extractContextTagsFromInput(input: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(CONTEXT_MENTION_RE)) {
    const token = match[1];
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(token);
  }
  return tags;
}

export function hasContextTagInInput(input: string, token: string): boolean {
  const needle = token.trim().toLowerCase();
  if (!needle) return false;
  return extractContextTagsFromInput(input).some(
    (item) => item.toLowerCase() === needle,
  );
}

/**
 * Appends a `#context` or `/command` token cleanly without duplicating an existing tag.
 */
export function attachTokenToInput(input: string, rawToken: string): string {
  const token = rawToken.trim();
  if (!token) return input;
  if (token.startsWith('#') && hasContextTagInInput(input, token)) {
    return input;
  }
  if (token.startsWith('/')) {
    const trimmed = input.trimStart();
    if (trimmed.toLowerCase().startsWith(token.toLowerCase())) {
      return input;
    }
    return trimmed ? `${token} ${trimmed}` : `${token} `;
  }
  const spacer = input && !/\s$/.test(input) ? ' ' : '';
  return `${input}${spacer}${token} `;
}

/**
 * Removes a `#context` tag from the composer text while keeping surrounding whitespace tidy.
 */
export function removeContextTagFromInput(
  input: string,
  token: string,
): string {
  const target = token.trim().toLowerCase();
  if (!target) return input;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'gi');
  const next = input
    .replace(re, (_, lead: string) => (lead ? ' ' : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s+/, '');
  return next;
}

/**
 * Applies a live `seamind-cli-agent-event` payload to the matching running turn.
 * - `kind === 'text'` incrementally appends to `streamBuffer` (avoiding noisy trace spam).
 * - `kind === 'tool'` records a structured `cli-tool` execution block.
 * - other kinds (`status`, etc.) record a compact `status` block.
 */
export function applyCliStreamEventToTurn(
  turn: AgentTurnRecord,
  payload: CliAgentStreamEvent,
): AgentTurnRecord {
  if (turn.cliRunId !== payload.runId || turn.status !== 'running') {
    return turn;
  }

  const text = payload.text ?? '';
  if (payload.kind === 'text') {
    const trimmed = text.trim();
    if (!trimmed) return turn;
    const prevBuf = turn.streamBuffer ?? '';
    const nextBuf = prevBuf ? `${prevBuf}\n${text}` : text;
    return {
      ...turn,
      streamBuffer: nextBuf,
      reply: nextBuf,
    };
  }

  if (payload.kind === 'tool') {
    const toolName = payload.toolName ?? 'tool';
    const nextBlock: ExecutionBlock = {
      id: `${payload.runId}-tool-${payload.timestampMs}-${turn.blocks.length}`,
      kind: 'cli-tool',
      toolName,
      label: `${payload.engine.toUpperCase()} · ${toolName}`,
      status: 'running',
      summary: text.slice(0, 140),
      detail: text,
      timestampMs: payload.timestampMs,
    };
    const updatedPrev = turn.blocks.map((b) =>
      b.kind === 'cli-tool' && b.status === 'running'
        ? { ...b, status: 'done' as const }
        : b,
    );
    return {
      ...turn,
      blocks: [...updatedPrev.slice(-39), nextBlock],
    };
  }

  const statusBlock: ExecutionBlock = {
    id: `${payload.runId}-status-${payload.timestampMs}-${turn.blocks.length}`,
    kind: 'status',
    label: `${payload.engine.toUpperCase()} · ${payload.kind || 'status'}`,
    status: 'done',
    summary: text.slice(0, 120),
    detail: text,
    timestampMs: payload.timestampMs,
  };
  return {
    ...turn,
    blocks: [...turn.blocks.slice(-39), statusBlock],
  };
}

/**
 * Applies an `AgentCallEvent` from `runAgentSession` into structured turn blocks.
 */
export function applyApiAgentEventToTurn(
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
    detail: toolEvent.summary,
    durationMs: toolEvent.durationMs,
    timestampMs: toolEvent.endedAt ?? toolEvent.startedAt,
  };
  const idx = turn.blocks.findIndex((b) => b.id === toolEvent.id);
  const blocks =
    idx >= 0
      ? turn.blocks.map((b, i) => (i === idx ? entry : b))
      : [...turn.blocks, entry];
  return { ...turn, blocks };
}

/**
 * Classifies a finished CLI agent execution accurately into completed / cancelled / failed.
 * Never reports a cancelled or non-zero exit run as completed.
 */
export function resolveCliRunOutcome(
  res: CliAgentRunResult,
  userCancelledLocally: boolean,
): {
  status: Extract<AgentTurnStatus, 'completed' | 'cancelled' | 'failed'>;
  error?: string;
} {
  const stderrHasCancel =
    res.stderr.includes('[已由用户手动终止]') ||
    res.stderr.toLowerCase().includes('cancelled by user');
  if (userCancelledLocally || stderrHasCancel) {
    return {
      status: 'cancelled',
      error: undefined,
    };
  }
  if (res.success) {
    return { status: 'completed' };
  }
  const reason = res.stderr.trim()
    ? res.stderr.trim().split('\n').slice(-4).join('\n')
    : `CLI 进程异常退出（退出码：${res.exitCode ?? 'unknown'}）`;
  return {
    status: 'failed',
    error: reason,
  };
}

/**
 * Aggregates real provider-reported token usage across turns in the current session.
 * Returns zeros & `reportedRequests === 0` when no provider usage was reported.
 */
export function aggregateReportedUsage(turns: AgentTurnRecord[]): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reportedRequests: number;
} {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let reportedRequests = 0;

  for (const turn of turns) {
    if (turn.usage && turn.usage.reportedRequests > 0) {
      promptTokens += turn.usage.promptTokens;
      completionTokens += turn.usage.completionTokens;
      totalTokens += turn.usage.totalTokens;
      reportedRequests += turn.usage.reportedRequests;
      continue;
    }
    for (const block of turn.blocks) {
      if (block.kind === 'model' && block.usage) {
        const u = block.usage;
        const hasAny =
          typeof u.promptTokens === 'number' ||
          typeof u.completionTokens === 'number' ||
          typeof u.totalTokens === 'number';
        if (hasAny) {
          reportedRequests += 1;
          if (typeof u.promptTokens === 'number')
            promptTokens += u.promptTokens;
          if (typeof u.completionTokens === 'number')
            completionTokens += u.completionTokens;
          if (typeof u.totalTokens === 'number') totalTokens += u.totalTokens;
        }
      }
    }
  }

  return { promptTokens, completionTokens, totalTokens, reportedRequests };
}

/**
 * Extracts concrete code blocks and terminal command proposals from turns for Inspector navigation.
 */
export function extractSessionArtifacts(
  turns: AgentTurnRecord[],
): SessionArtifactItem[] {
  const items: SessionArtifactItem[] = [];
  const fenceRe = /```([a-zA-Z0-9_+.-]*)\n([\s\S]*?)```/g;

  turns.forEach((turn, turnIdx) => {
    if (turn.reply) {
      let blockIdx = 0;
      for (const match of turn.reply.matchAll(fenceRe)) {
        blockIdx += 1;
        const lang = (match[1] || 'text').toLowerCase();
        const code = match[2] ?? '';
        const lines = code.replace(/\r\n?/g, '\n').split('\n');
        const firstNonEmpty =
          lines.find((l) => l.trim().length > 0)?.trim() ??
          turn.userText.slice(0, 28);
        items.push({
          id: `${turn.id}-code-${blockIdx}`,
          turnId: turn.id,
          turnIndex: turnIdx + 1,
          kind: 'code',
          language: lang,
          title: firstNonEmpty.slice(0, 36),
          lineCount: lines.length,
          preview: code.slice(0, 120),
        });
      }
    }
    if (turn.artifacts && turn.artifacts.length > 0) {
      turn.artifacts.forEach((art, artIdx) => {
        if (art.kind === 'table') {
          items.push({
            id: `${turn.id}-tbl-${artIdx}`,
            turnId: turn.id,
            turnIndex: turnIdx + 1,
            kind: 'table',
            language: art.engine ?? 'table',
            title: `${art.title} (${art.totalRows ?? art.rows.length} 行)`,
            lineCount: art.rows.length,
            preview: art.columns.join(', '),
          });
        } else if (art.kind === 'file-ref') {
          items.push({
            id: `${turn.id}-file-${artIdx}`,
            turnId: turn.id,
            turnIndex: turnIdx + 1,
            kind: 'file-ref',
            language: art.mediaType ?? 'file',
            title: art.title,
            lineCount: 1,
            preview: art.path,
          });
        }
      });
    }
    if (turn.terminalProposal) {
      items.push({
        id: `${turn.id}-cmd`,
        turnId: turn.id,
        turnIndex: turnIdx + 1,
        kind: 'command',
        language: `pane:${turn.terminalProposal.paneIndex}`,
        title: turn.terminalProposal.command.slice(0, 36),
        lineCount: 1,
        preview: turn.terminalProposal.command,
      });
    }
  });

  return items;
}

export function formatDurationCompact(ms?: number): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatTurnUsageSummary(usage?: AgentTurnUsage): string | null {
  if (!usage || usage.reportedRequests === 0) return null;
  if (usage.totalTokens > 0) {
    return `${usage.totalTokens.toLocaleString()} tok`;
  }
  const combined = usage.promptTokens + usage.completionTokens;
  return combined > 0 ? `${combined.toLocaleString()} tok` : null;
}

export function buildWorkbenchHelpMarkdown(): string {
  const cmdRows = TERMINAL_SLASH_COMMANDS.map(
    (c) => `| \`${c.command}\` | ${c.title} | ${c.description} |`,
  ).join('\n');
  const mentionRows = TERMINAL_RESOURCE_MENTIONS.map(
    (m) => `| \`${m.token}\` | ${m.label} | ${m.description} |`,
  ).join('\n');

  return [
    '### SEAMIND Agent 工作台协议速查（`/` 指令与 `#` 上下文）',
    '',
    '#### 常用工作流',
    '1. **挂载研究现场（`#`）**：输入 `#` 或点击输入框下方标签挂载当前阅读章节 (`#chapter`)、书库 (`#book:书名`)、知识库 (`#kb:名称`)、思维导图 (`#map`)、数据与实验本 (`#data` / `#lab` / `#env`)、分屏终端 (`#pane:2`) 或最近报错 (`#last-error`)。已挂载的上下文显示为可删除标签。',
    '2. **触发领域调度（`/`）**：在句首输入 `/book`、`/data`、`/code`、`/kb`、`/map`、`/exam`、`/paper`、`/exec` 自动收束对应工具集并输出结构化研究块。',
    '3. **切换运行内核（`Ctrl+M`）**：在 `Hybrid (API×CLI)`、直连 `API`、或本机 `Claude / Codex / AGY / Gemini` 无头 CLI 之间切换。',
    '4. **审阅执行轨迹（`Ctrl+O`）**：展开或收起最近一轮的模型与工具执行步骤、耗时与日志。',
    '',
    '#### `/` 斜杠指令',
    '| 指令 | 模块 | 说明 |',
    '| --- | --- | --- |',
    cmdRows,
    '',
    '#### `#` 上下文引用',
    '| 标记 | 数据源 | 注入内容 |',
    '| --- | --- | --- |',
    mentionRows,
    '',
    '> **快捷键**：`/` `/#` 补全（`↑/↓` 选择，`Tab/Enter` 确认，`Esc` 关闭） · `Ctrl+M` 内核与模型 · `Ctrl+O` 折叠轨迹 · `Ctrl+K` 命令面板 · `Ctrl+Shift+M` 放大当前窗格。',
  ].join('\n');
}
