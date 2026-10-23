import { channelIdFromUrl, channelUrl, isChannelId } from './video-links';
import type { ChannelInput, PlayerChannel } from './types';

export type SubscriptionFormat =
  | 'newpipe'
  | 'takeout-csv'
  | 'takeout-json'
  | 'opml';

export interface ParsedSubscriptions {
  format: SubscriptionFormat;
  channels: ChannelInput[];
  /** Entries that could not be used: another service, or no channel id in the address. */
  skipped: number;
}

const BYTE_ORDER_MARK = /^\uFEFF/;

function collect(
  format: SubscriptionFormat,
  entries: { channelId: string | null; name: string }[],
): ParsedSubscriptions {
  const seen = new Set<string>();
  const channels: ChannelInput[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.channelId || !isChannelId(entry.channelId)) {
      skipped += 1;
      continue;
    }
    if (seen.has(entry.channelId)) continue;
    seen.add(entry.channelId);
    channels.push({
      channelId: entry.channelId,
      name: entry.name.trim() || entry.channelId,
    });
  }
  return { format, channels, skipped };
}

/** The file NewPipe exports: `{ subscriptions: [{ service_id, url, name }] }`, YouTube being service 0. */
function fromNewPipe(value: unknown): ParsedSubscriptions | null {
  const subscriptions = (value as { subscriptions?: unknown })?.subscriptions;
  if (!Array.isArray(subscriptions)) return null;
  const entries: { channelId: string | null; name: string }[] = [];
  let otherServices = 0;
  for (const item of subscriptions) {
    const record = item as {
      service_id?: unknown;
      url?: unknown;
      name?: unknown;
    };
    if (record.service_id !== undefined && record.service_id !== 0) {
      otherServices += 1;
      continue;
    }
    entries.push({
      channelId:
        typeof record.url === 'string' ? channelIdFromUrl(record.url) : null,
      name: typeof record.name === 'string' ? record.name : '',
    });
  }
  const parsed = collect('newpipe', entries);
  return { ...parsed, skipped: parsed.skipped + otherServices };
}

/** The JSON of Google Takeout: a list of subscription resources. */
function fromTakeoutJson(value: unknown): ParsedSubscriptions | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map((item) => {
    const snippet = (
      item as {
        snippet?: {
          title?: unknown;
          resourceId?: { channelId?: unknown };
          channelId?: unknown;
        };
      }
    )?.snippet;
    const id = snippet?.resourceId?.channelId ?? snippet?.channelId;
    return {
      channelId: typeof id === 'string' ? id : null,
      name: typeof snippet?.title === 'string' ? snippet.title : '',
    };
  });
  return collect('takeout-json', entries);
}

/** Splits CSV text into rows of cells, honouring quotes, doubled quotes and line breaks in cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

/** `subscriptions.csv` from Google Takeout: channel id, channel address, channel title. */
function fromTakeoutCsv(text: string): ParsedSubscriptions | null {
  const rows = parseCsv(text);
  const entries = rows
    .filter((row) => isChannelId((row[0] ?? '').trim()))
    .map((row) => ({
      channelId: row[0].trim(),
      name: row[2] ?? row[1] ?? '',
    }));
  if (entries.length === 0) return null;
  return collect('takeout-csv', entries);
}

/** An OPML list of feeds, where each channel is a `…/feeds/videos.xml?channel_id=UC…` address. */
function fromOpml(text: string): ParsedSubscriptions | null {
  const outlines = [...text.matchAll(/<outline\b[^>]*>/gi)].map(
    (match) => match[0],
  );
  const entries: { channelId: string | null; name: string }[] = [];
  for (const outline of outlines) {
    const attribute = (name: string) =>
      new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(outline)?.[1] ?? '';
    const xmlUrl = decodeEntities(attribute('xmlUrl'));
    if (!xmlUrl) continue;
    const id = /[?&]channel_id=(UC[\w-]{22})/.exec(xmlUrl)?.[1] ?? null;
    entries.push({
      channelId: id,
      name: decodeEntities(attribute('title') || attribute('text')),
    });
  }
  if (entries.length === 0) return null;
  return collect('opml', entries);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Reads a subscription list in any of the formats people have: NewPipe's export, Google Takeout
 * (CSV or JSON) or OPML. Returns null for text that is none of them.
 */
export function parseSubscriptionFile(
  text: string,
): ParsedSubscriptions | null {
  const content = text.replace(BYTE_ORDER_MARK, '').trim();
  if (!content) return null;
  if (content.startsWith('{') || content.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(content);
      return fromNewPipe(value) ?? fromTakeoutJson(value);
    } catch {
      return null;
    }
  }
  if (content.startsWith('<')) return fromOpml(content);
  return fromTakeoutCsv(content);
}

/** The followed channels in NewPipe's export format, which NewPipe and Seamind can both import. */
export function subscriptionsToNewPipeJson(channels: PlayerChannel[]): string {
  return JSON.stringify(
    {
      app_version: 'Seamind',
      app_version_int: 0,
      subscriptions: channels.map((channel) => ({
        service_id: 0,
        url: channelUrl(channel.channelId),
        name: channel.name,
      })),
    },
    null,
    2,
  );
}
