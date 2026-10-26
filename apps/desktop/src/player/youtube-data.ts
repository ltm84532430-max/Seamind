import { loadYouTubeLibrary } from '../youtube-native';
import type { Library } from '../youtube-native';
import { proxiedFetch } from '../youtube-proxy';
import { errorText } from './player-api';
import { withRetries } from './retry-fetch';
import type { ChannelInput, VideoInput } from './types';
import { channelUrl, isChannelId, thumbnailUrl } from './video-links';
import type { YouTubeTarget } from './video-links';
import { videoFromItem } from './youtube-mapping';

/**
 * Looking things up on YouTube for the player page: channels, playlists and the address of a
 * channel by its name. It uses YouTube.js through the same local proxy playback does. Nothing here
 * asks for a stream address, so none of it meets the bot check that playback can.
 */

type Innertube = InstanceType<Library['Innertube']>;
type ChannelPageData = InstanceType<Library['YT']['Channel']>;

/** The Videos tab of a channel, newest first. One request returns the channel's identity too. */
const VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';
const REQUEST_TIMEOUT_MS = 40_000;
/** A playlist longer than this is cut, so a huge one cannot take minutes to load. */
const MAX_PLAYLIST_VIDEOS = 400;
const MAX_PLAYLIST_PAGES = 12;

export interface ChannelInfo {
  channelId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  description: string | null;
}

export interface ChannelListing {
  info: ChannelInfo;
  videos: VideoInput[];
  /** Loads the next page of videos; null when there are no more. */
  more: (() => Promise<ChannelListing>) | null;
}

export interface PlaylistListing {
  listId: string;
  title: string;
  channelName: string | null;
  videos: VideoInput[];
  /** Whether the playlist had more videos than were loaded. */
  truncated: boolean;
}

interface Session {
  library: Library;
  innertube: Innertube;
}

let sessionPromise: Promise<Session> | null = null;

function timeoutFetch(): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return proxiedFetch(input, { ...init, signal });
  };
}

function session(): Promise<Session> {
  sessionPromise ??= loadYouTubeLibrary()
    .then(async (library) => ({
      library,
      innertube: await library.Innertube.create({
        fetch: withRetries(timeoutFetch()),
        retrieve_player: false,
        generate_session_locally: true,
        enable_session_cache: false,
        // Chinese labels for the relative dates and view counts that are shown as they come.
        lang: 'zh-CN',
      }),
    }))
    .catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  return sessionPromise;
}

/** A sentence for the person using the page, whatever went wrong. */
export function describeDataError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return '连接 YouTube 超时，请稍后再试。';
  const message = errorText(error, '');
  if (
    /failed to fetch|networkerror|load failed|status code (502|504)/i.test(
      message,
    )
  )
    return '无法连接到 YouTube，请检查网络或代理设置。';
  if (/status code 429|too many requests/i.test(message))
    return 'YouTube 暂时限制了请求，请稍后再试。';
  if (
    /not found|does not exist|404|unavailable|terminated|无法找到/i.test(
      message,
    )
  )
    return '找不到这个频道或播放列表，它可能已被删除或不公开。';
  return message || '读取 YouTube 失败。';
}

function handleFrom(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const match = /\/(@[^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

function infoFromPage(page: ChannelPageData, fallbackId: string): ChannelInfo {
  const metadata = page.metadata as {
    title?: string;
    external_id?: string;
    description?: string;
    vanity_channel_url?: string;
    avatar?: { url?: string }[];
  };
  return {
    channelId: isChannelId(metadata.external_id ?? '')
      ? (metadata.external_id as string)
      : fallbackId,
    name: metadata.title?.trim() || fallbackId,
    handle: handleFrom(metadata.vanity_channel_url),
    avatarUrl: metadata.avatar?.[0]?.url ?? null,
    description: metadata.description?.trim() || null,
  };
}

/** What a first page of a channel's videos and every page after it have in common. */
interface VideoPage {
  videos: unknown[];
  has_continuation: boolean;
  getContinuation(): Promise<VideoPage>;
}

function listingFromPage(
  page: VideoPage,
  info: ChannelInfo,
  now: number,
): ChannelListing {
  const videos = page.videos
    .map((item) =>
      videoFromItem(item, {
        channelId: info.channelId,
        channelName: info.name,
        now,
      }),
    )
    .filter((video): video is VideoInput => video !== null);
  return {
    info,
    videos,
    more: page.has_continuation
      ? async () =>
          listingFromPage(
            await page.getContinuation(),
            info,
            Math.floor(Date.now() / 1000),
          )
      : null,
  };
}

/** The first page of a channel's videos and what is known about the channel. */
export async function fetchChannel(channelId: string): Promise<ChannelListing> {
  if (!isChannelId(channelId)) throw new Error('频道编号无效。');
  const { library, innertube } = await session();
  const response = await innertube.actions.execute('/browse', {
    browseId: channelId,
    params: VIDEOS_TAB_PARAMS,
    parse: true,
  });
  const page = new library.YT.Channel(innertube.actions, response, true);
  return listingFromPage(
    page,
    infoFromPage(page, channelId),
    Math.floor(Date.now() / 1000),
  );
}

/** The channel a handle (`@name`) or an old-style address points at. */
export async function resolveChannelId(
  target: Extract<YouTubeTarget, { kind: 'handle' | 'lookup' | 'channel' }>,
): Promise<string> {
  if (target.kind === 'channel') return target.channelId;
  const { innertube } = await session();
  const url =
    target.kind === 'handle'
      ? `https://www.youtube.com/${target.handle}`
      : target.url;
  const endpoint = await innertube.resolveURL(url);
  const browseId = (endpoint.payload as { browseId?: string } | undefined)
    ?.browseId;
  if (!browseId || !isChannelId(browseId)) throw new Error('找不到这个频道。');
  return browseId;
}

/** A playlist with all its videos (up to a limit), for saving it as a course. */
export async function fetchPlaylist(listId: string): Promise<PlaylistListing> {
  const { innertube } = await session();
  let playlist = await innertube.getPlaylist(listId);
  const info = playlist.info as {
    title?: string;
    author?: { name?: string };
  };
  const videos: VideoInput[] = [];
  const now = Math.floor(Date.now() / 1000);
  let truncated = false;
  for (let page = 0; ; page += 1) {
    for (const item of playlist.items as unknown[]) {
      const video = videoFromItem(item, { now });
      if (video) videos.push(video);
    }
    if (!playlist.has_continuation) break;
    if (
      page + 1 >= MAX_PLAYLIST_PAGES ||
      videos.length >= MAX_PLAYLIST_VIDEOS
    ) {
      truncated = true;
      break;
    }
    playlist = await playlist.getContinuation();
  }
  return {
    listId,
    title: info.title?.trim() || listId,
    channelName: info.author?.name?.trim() || null,
    videos: videos.slice(0, MAX_PLAYLIST_VIDEOS),
    truncated,
  };
}

/** Searches YouTube for long-form playable videos matching `query`, returning real metadata. */
export async function searchYouTubeVideos(
  query: string,
  limit = 8,
): Promise<VideoInput[]> {
  const cleaned = query.trim();
  if (!cleaned) return [];
  const cappedLimit = Math.max(1, Math.min(20, Math.floor(limit) || 8));
  const { innertube } = await session();
  const search = await innertube.search(cleaned, { type: 'video' });
  const now = Math.floor(Date.now() / 1000);
  const candidates: unknown[] = [
    ...((search.videos as unknown[]) ?? []),
    ...((search.results as unknown[]) ?? []),
  ];
  const seen = new Set<string>();
  const out: VideoInput[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const nodeType = (item as { type?: string }).type;
    if (nodeType === 'ReelItem' || nodeType === 'ShortsLockupView') continue;
    const mapped = videoFromItem(item, { now });
    if (!mapped || seen.has(mapped.videoId)) continue;
    seen.add(mapped.videoId);
    out.push({
      ...mapped,
      thumbnailUrl: mapped.thumbnailUrl ?? thumbnailUrl(mapped.videoId, 'mq'),
    });
    if (out.length >= cappedLimit) break;
  }
  return out;
}

/** The input the database takes for a channel the page found out about. */
export function channelInputFromInfo(info: ChannelInfo): ChannelInput {
  return {
    channelId: info.channelId,
    name: info.name,
    handle: info.handle,
    avatarUrl: info.avatarUrl,
    description: info.description,
  };
}

export { channelUrl };
