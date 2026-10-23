import { parseYouTubeEmbedInput } from '../youtube';

/** What a pasted link, handle or id points at. */
export type YouTubeTarget =
  | {
      kind: 'video';
      videoId: string;
      startSeconds: number;
      /** The playlist the link was taken from, when it names one. */
      listId: string | null;
    }
  | { kind: 'playlist'; listId: string }
  | { kind: 'channel'; channelId: string }
  | { kind: 'handle'; handle: string }
  /** A `/c/name` or `/user/name` address, which only YouTube can turn into a channel. */
  | { kind: 'lookup'; url: string };

const videoIdPattern = /^[\w-]{11}$/;
const channelIdPattern = /^UC[\w-]{22}$/;
// Playlists a person can open: their own (PL), a channel's uploads (UU) and albums (OL). Mixes (RD),
// liked videos (LL) and watch later (WL) are generated or private, so they are not accepted.
const playlistIdPattern = /^(?:PL|UU|OL)[\w-]{10,}$/;
const handlePattern = /^@[\p{L}\p{N}_.-]{1,60}$/u;

const youtubeHosts = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export function isVideoId(value: string): boolean {
  return videoIdPattern.test(value);
}

export function isChannelId(value: string): boolean {
  return channelIdPattern.test(value);
}

export function isPlaylistId(value: string): boolean {
  return playlistIdPattern.test(value);
}

function validListId(value: string | null): string | null {
  return value && playlistIdPattern.test(value) ? value : null;
}

function targetFromBareText(text: string): YouTubeTarget | null {
  if (channelIdPattern.test(text)) return { kind: 'channel', channelId: text };
  if (playlistIdPattern.test(text)) return { kind: 'playlist', listId: text };
  if (handlePattern.test(text)) return { kind: 'handle', handle: text };
  if (videoIdPattern.test(text))
    return { kind: 'video', videoId: text, startSeconds: 0, listId: null };
  return null;
}

function targetFromUrl(url: URL, original: string): YouTubeTarget | null {
  const host = url.hostname.toLowerCase();
  if (!youtubeHosts.has(host)) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0] ?? '';

  if (first === 'channel' && channelIdPattern.test(segments[1] ?? ''))
    return { kind: 'channel', channelId: segments[1] };
  if (first.startsWith('@')) {
    const handle = decodeURIComponent(first);
    return handlePattern.test(handle) ? { kind: 'handle', handle } : null;
  }
  if ((first === 'c' || first === 'user') && segments[1])
    return {
      kind: 'lookup',
      url: `https://www.youtube.com/${first}/${segments[1]}`,
    };
  if (first === 'feeds') {
    const channelId = url.searchParams.get('channel_id');
    if (channelId && channelIdPattern.test(channelId))
      return { kind: 'channel', channelId };
    return null;
  }

  const video = parseYouTubeEmbedInput(original);
  if (video)
    return {
      kind: 'video',
      videoId: video.id,
      startSeconds: video.startSeconds,
      listId: validListId(url.searchParams.get('list')),
    };

  if (first === 'playlist') {
    const listId = validListId(url.searchParams.get('list'));
    return listId ? { kind: 'playlist', listId } : null;
  }
  return null;
}

/**
 * Works out what the user pasted into the address box: a video (with its start time), a playlist, a
 * channel by id or `@handle`, or an address only YouTube can resolve.
 */
export function parseYouTubeTarget(input: string): YouTubeTarget | null {
  const text = input.trim();
  if (!text) return null;
  const bare = targetFromBareText(text);
  if (bare) return bare;
  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate))
    candidate = `https://${candidate}`;
  try {
    return targetFromUrl(new URL(candidate), candidate);
  } catch {
    return null;
  }
}

/** The channel id in an address such as `https://www.youtube.com/channel/UC…`, if it has one. */
export function channelIdFromUrl(value: string): string | null {
  const target = parseYouTubeTarget(value);
  return target?.kind === 'channel' ? target.channelId : null;
}

export function videoWatchUrl(videoId: string, startSeconds = 0): string {
  const suffix = startSeconds > 0 ? `&t=${Math.floor(startSeconds)}s` : '';
  return `https://www.youtube.com/watch?v=${videoId}${suffix}`;
}

export function channelUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

/** A list thumbnail; `i.ytimg.com` is the only picture host the app's CSP lets through. */
export function thumbnailUrl(
  videoId: string,
  quality: 'mq' | 'hq' | 'maxres' = 'mq',
): string {
  const name =
    quality === 'maxres'
      ? 'maxresdefault'
      : quality === 'hq'
        ? 'hqdefault'
        : 'mqdefault';
  return `https://i.ytimg.com/vi/${videoId}/${name}.jpg`;
}
