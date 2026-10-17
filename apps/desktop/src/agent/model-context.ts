import type { ModelContextWindow } from './types';

const VERIFIED_ON = '2026-10-17';

const DEEPSEEK_CONTEXT_WINDOW: ModelContextWindow = {
  tokens: 1_048_576,
  sourceLabel: 'DeepSeek 官方模型目录',
  sourceUrl: 'https://api-docs.deepseek.com/api/list-models/',
  verifiedOn: VERIFIED_ON,
};

const OPENAI_GPT_4O_MINI_CONTEXT_WINDOW: ModelContextWindow = {
  tokens: 128_000,
  sourceLabel: 'OpenAI GPT-4o mini 模型文档',
  sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4o-mini',
  verifiedOn: VERIFIED_ON,
};

function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isSnapshotOf(model: string, baseName: string): boolean {
  return (
    model === baseName ||
    new RegExp(`^${baseName}-\\d{4}-\\d{2}-\\d{2}$`).test(model)
  );
}

/** Return a capacity only for model IDs on their documented first-party API host. */
export function resolveModelContextWindow(
  baseUrl: string,
  modelName: string,
): ModelContextWindow | null {
  const host = hostOf(baseUrl);
  const model = modelName.trim().toLowerCase();

  if (host === 'api.deepseek.com') {
    if (
      model === 'deepseek-flash' ||
      model === 'deepseek-v4-pro' ||
      model === 'deepseek-v4-flash'
    ) {
      return DEEPSEEK_CONTEXT_WINDOW;
    }
    return null;
  }

  if (host === 'api.openai.com' && isSnapshotOf(model, 'gpt-4o-mini')) {
    return OPENAI_GPT_4O_MINI_CONTEXT_WINDOW;
  }

  return null;
}

export function formatContextWindow(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`
    : `${(tokens / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
}
