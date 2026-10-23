import { isVideoId } from './video-links';
import type { VideoInput } from './types';

/**
 * "237万次观看", "1.2千次观看", "1.5K views", "12,345 views" as a number; null when the text has no
 * count in it. "No views" and "暂无观看" are zero.
 */
export function parseViewCount(text: string | null | undefined): number | null {
  if (!text) return null;
  if (/no views|暂无|无人观看|没有观看/i.test(text)) return 0;
  const match = /([\d][\d,.]*)\s*(万|亿|千|[kKmMbB](?![a-z]))?/.exec(text);
  if (!match) return null;
  const digits = match[1].replace(/,/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  const unit = match[2]?.toLowerCase();
  const factor =
    unit === '万'
      ? 10_000
      : unit === '亿'
        ? 100_000_000
        : unit === '千' || unit === 'k'
          ? 1_000
          : unit === 'm'
            ? 1_000_000
            : unit === 'b'
              ? 1_000_000_000
              : 1;
  return Math.round(value * factor);
}

/** "40:44" or "1:02:03" in seconds. */
export function parseDurationText(
  text: string | null | undefined,
): number | null {
  if (!text) return null;
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  return (
    Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])
  );
}

const SECONDS_PER_UNIT: Record<string, number> = {
  秒: 1,
  分钟: 60,
  小时: 3600,
  天: 86_400,
  周: 7 * 86_400,
  个月: 30 * 86_400,
  月: 30 * 86_400,
  年: 365 * 86_400,
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
  year: 365 * 86_400,
};

/**
 * When a video went up, worked out from "5天前" or "3 weeks ago". The result is only as exact as
 * the unit: a month counts as 30 days. Null when the text names no time.
 */
export function approximatePublishedAt(
  text: string | null | undefined,
  now: number,
): number | null {
  if (!text) return null;
  const chinese = /(\d+)\s*(秒|分钟|小时|天|周|个月|月|年)前/.exec(text);
  if (chinese) return now - Number(chinese[1]) * SECONDS_PER_UNIT[chinese[2]];
  const english =
    /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(text);
  if (english)
    return (
      now - Number(english[1]) * SECONDS_PER_UNIT[english[2].toLowerCase()]
    );
  return null;
}

interface TextHolder {
  text?: unknown;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const text = (value as TextHolder | null | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

/** The pieces of text YouTube shows under a video: "237万次观看", "5天前". */
function metadataParts(item: Record<string, any>): string[] {
  const rows = item.metadata?.metadata?.metadata_rows;
  const fromRows: string[] = Array.isArray(rows)
    ? rows.flatMap((row: Record<string, any>) =>
        Array.isArray(row?.metadata_parts)
          ? row.metadata_parts.map((part: Record<string, any>) =>
              textOf(part?.text),
            )
          : [],
      )
    : [];
  return [
    ...fromRows,
    textOf(item.short_view_count),
    textOf(item.view_count),
    textOf(item.published),
  ].filter(Boolean);
}

const viewWords = /观看|views?\b|watching/i;
const timeWords = /前|ago\b|直播|首播|streamed|premiered/i;

export interface ListedVideoContext {
  channelId?: string | null;
  channelName?: string | null;
  now: number;
}

/**
 * A video from what YouTube.js returns for a channel's videos tab or a playlist: the newer
 * `LockupView` or the older `Video`/`PlaylistVideo`. Null when the entry is not a playable video.
 */
export function videoFromItem(
  item: unknown,
  context: ListedVideoContext,
): VideoInput | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, any>;
  const contentType = record.content_type;
  if (typeof contentType === 'string' && !/VIDEO/i.test(contentType))
    return null;
  const id = record.content_id ?? record.video_id ?? record.id;
  if (typeof id !== 'string' || !isVideoId(id)) return null;

  const title = (
    textOf(record.metadata?.title) ||
    textOf(record.title) ||
    ''
  ).trim();
  const parts = metadataParts(record);
  const viewText = parts.find((part) => viewWords.test(part)) ?? null;
  const publishedText = parts.find((part) => timeWords.test(part)) ?? null;
  const publishedAt = approximatePublishedAt(publishedText, context.now);
  const duration =
    typeof record.duration?.seconds === 'number' && record.duration.seconds > 0
      ? record.duration.seconds
      : parseDurationText(textOf(record.duration));

  const authorName =
    typeof record.author?.name === 'string' ? record.author.name : null;
  const authorId =
    typeof record.author?.id === 'string' ? record.author.id : null;
  return {
    videoId: id,
    channelId: context.channelId ?? authorId,
    channelName: context.channelName ?? authorName,
    title: title || id,
    publishedAt,
    publishedApprox: publishedAt !== null,
    durationSeconds: duration,
    viewCount: parseViewCount(viewText),
    viewText,
  };
}
