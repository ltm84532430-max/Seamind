import type { OpenedDocument } from '../../library/library';

export const MAX_TOOL_READ_CHARS = 12_000;
export const MAX_SEARCH_RESULTS = 8;

export const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export function parseObject(raw: string): Record<string, unknown> {
  if (raw.length > 300_000) throw new Error('工具参数过长。');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('工具参数不是有效 JSON。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('工具参数必须是 JSON 对象。');
  }
  return value as Record<string, unknown>;
}

export function assertOnlyKeys(
  input: Record<string, unknown>,
  allowed: string[],
): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`不支持的参数：${unexpected}`);
}

export function requireString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
  minLength = 1,
): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是文本。`);
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new Error(
      `参数 ${key} 长度必须为 ${minLength} 到 ${maxLength} 个字符。`,
    );
  }
  return normalized;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是文本。`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`参数 ${key} 长度不得超过 ${maxLength} 个字符。`);
  }
  return normalized;
}

export function requireText(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
  minLength = 0,
): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是文本。`);
  if (value.trim().length < minLength || value.length > maxLength) {
    throw new Error(
      `参数 ${key} 长度必须为 ${minLength} 到 ${maxLength} 个字符。`,
    );
  }
  return value;
}

export function requireInteger(
  input: Record<string, unknown>,
  key: string,
): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`参数 ${key} 必须是非负整数。`);
  }
  return value as number;
}

export function previewDocument(opened: OpenedDocument, offset: number) {
  const markdown = opened.markdown;
  const start = Math.min(offset, markdown.length);
  const content = markdown.slice(start, start + MAX_TOOL_READ_CHARS);
  const nextOffset = start + content.length;
  return {
    document: {
      title: opened.document.title,
      category: opened.document.category,
      relativePath: opened.document.relativePath,
    },
    totalChars: markdown.length,
    offset: start,
    content,
    nextOffset: nextOffset < markdown.length ? nextOffset : null,
  };
}
