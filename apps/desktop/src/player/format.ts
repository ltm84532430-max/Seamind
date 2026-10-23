/** `83` is `1:23`, `3725` is `1:02:05`. */
export function formatDuration(
  totalSeconds: number | null | undefined,
): string {
  if (totalSeconds === null || totalSeconds === undefined) return '';
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '';
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(rest)}`
    : `${minutes}:${two(rest)}`;
}

/** 23750 as `2.4 万` and 2375000 as `238 万`, the way Chinese YouTube writes it. */
export function formatCount(count: number): string {
  if (count >= 100_000_000) return `${trim(count / 100_000_000)} 亿`;
  if (count >= 10_000) return `${trim(count / 10_000)} 万`;
  return String(count);
}

function trim(value: number): string {
  return value >= 100
    ? String(Math.round(value))
    : value.toFixed(1).replace(/\.0$/, '');
}

export function formatViews(
  count: number | null | undefined,
  text: string | null | undefined,
): string {
  if (count !== null && count !== undefined)
    return `${formatCount(count)} 次观看`;
  return text ?? '';
}

/** How long ago `timestamp` (unix seconds) was, in words. */
export function formatAgo(
  timestamp: number | null | undefined,
  now: number,
  approximate = false,
): string {
  if (timestamp === null || timestamp === undefined) return '';
  const seconds = Math.max(0, now - timestamp);
  const prefix = approximate ? '约 ' : '';
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${prefix}${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${prefix}${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${prefix}${days} 天前`;
  if (days < 30) return `${prefix}${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${prefix}${Math.floor(days / 30)} 个月前`;
  return `${prefix}${Math.floor(days / 365)} 年前`;
}

/** The date a video went up, for a tooltip. */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A channel's first letter or character, for the round badge shown without an avatar. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

/** A hue from 0 to 359 that stays the same for the same name, to tell the round badges apart. */
export function avatarHue(seed: string): number {
  let hash = 0;
  for (const char of seed)
    hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

/** A position in a video, such as the place playback resumes from; `0:00` when it is not a time. */
export function formatClock(totalSeconds: number): string {
  return formatDuration(totalSeconds) || '0:00';
}
