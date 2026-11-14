import type { ZlibBook, ZlibProfile } from './zlib-api';

export type ZlibConnectionState =
  | 'checking'
  | 'missing'
  | 'unauthenticated'
  | 'connected'
  | 'expired'
  | 'offline';

export type ZlibErrorKind = 'auth_expired' | 'network' | 'other';

const AUTH_EXPIRED_PATTERN =
  /expired|revoked|not logged in|log in again|login was rejected|unauthorized|unauthenticated|\b401\b|请先登录|请重新登录|登录已失效|登录已过期|会话.*失效/i;

const NETWORK_ERROR_PATTERN =
  /could not resolve|no such host|dial tcp|lookup |timed?\s*out|connection refused|connection reset|unexpected eof|network|dns|tls|ssl|proxy|\b502\b|\b503\b|\b504\b|http 403|http 5\d\d|节点.*不可达|无法连接|连接.*失败|网络/i;

/**
 * Normalizes Z-Library `id` and `hash` into CLI `id:hash` format without duplicating `:hash`
 * when CLI search output already embeds `:hash` inside `book.id`.
 */
export function normalizeBookIdHash(id: string, hash?: string | null): string {
  const cleanId = id.trim();
  const cleanHash = (hash ?? '').trim();

  if (cleanId.includes(':')) {
    const parts = cleanId
      .split(':')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}:${parts[1]}`;
    }
    if (parts.length === 1 && cleanHash) {
      return `${parts[0]}:${cleanHash}`;
    }
    return parts[0] ?? '';
  }

  return cleanHash ? `${cleanId}:${cleanHash}` : cleanId;
}

export function buildZlibBookKey(
  book: Pick<ZlibBook, 'id' | 'hash'>,
  index: number,
): string {
  const normalized = normalizeBookIdHash(book.id, book.hash);
  return `${normalized || 'book'}-${index}`;
}

export function classifyZlibError(rawMessage: string): ZlibErrorKind {
  const text = rawMessage.trim();
  if (!text) return 'other';
  if (AUTH_EXPIRED_PATTERN.test(text)) return 'auth_expired';
  if (NETWORK_ERROR_PATTERN.test(text)) return 'network';
  return 'other';
}

export function explainZlibError(rawMessage: string): string {
  const clean = rawMessage.trim();
  const kind = classifyZlibError(clean);
  if (kind === 'auth_expired') {
    return 'Z-Library 登录会话已失效，请重新登录。';
  }
  if (kind === 'network') {
    return '当前节点暂时无法连接，本地会话已保留；可切换可用节点后重试。';
  }
  if (/id:hash/i.test(clean)) {
    return '书籍下载标识格式异常，请重新搜索该书籍后再试。';
  }
  return clean || 'Z-Library 操作失败，请稍后重试。';
}

export function formatZlibQuota(profile: ZlibProfile | null): string | null {
  if (!profile) return null;
  const limit = profile.downloadsLimit ?? profile.dailyAllowed ?? null;
  const today = profile.downloadsToday ?? null;
  const remaining =
    profile.dailyRemaining ??
    (limit !== null && today !== null ? Math.max(0, limit - today) : null);

  if (limit !== null && remaining !== null) {
    return `余 ${remaining}/${limit}`;
  }
  if (remaining !== null) {
    return `余 ${remaining}`;
  }
  return null;
}

export function formatDomainLabel(
  domain: string | null | undefined,
): string | null {
  if (!domain) return null;
  const trimmed = domain.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
