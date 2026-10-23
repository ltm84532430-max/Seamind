import type { PlayerChannel, VideoInput, VideoItem } from './types';

/**
 * What the user did with a video, laid over every list so that a star clicked in the feed also
 * shows in the queue beside the player, without any list being loaded again.
 */
export interface VideoPatch {
  favorite?: boolean;
  watchLater?: boolean;
  finished?: boolean;
  progressSeconds?: number | null;
  durationSeconds?: number | null;
}

export type Overlay = Readonly<Record<string, VideoPatch>>;

/** The list a video was opened from, in that list's order. Playback continues down this list. */
export interface QueueSource {
  title: string;
  items: VideoItem[];
}

export function applyOverlay(item: VideoItem, overlay: Overlay): VideoItem {
  const patch = overlay[item.videoId];
  return patch ? { ...item, ...patch } : item;
}

export function withOverlay(items: VideoItem[], overlay: Overlay): VideoItem[] {
  return items.map((item) => applyOverlay(item, overlay));
}

export function patchOverlay(
  overlay: Overlay,
  videoId: string,
  patch: VideoPatch,
): Overlay {
  return { ...overlay, [videoId]: { ...overlay[videoId], ...patch } };
}

/**
 * What the database needs to know a video again. A video that nothing refers to any more is
 * forgotten, and a list can still be showing it, so it is saved again before it is put in a list.
 */
export function inputFromItem(item: VideoItem): VideoInput {
  return {
    videoId: item.videoId,
    channelId: item.channelId,
    channelName: item.channelName,
    title: item.title,
    publishedAt: item.publishedAt,
    publishedApprox: item.publishedApprox,
    durationSeconds: item.durationSeconds,
    viewCount: item.viewCount,
    viewText: item.viewText,
    thumbnailUrl: item.thumbnailUrl,
  };
}

/** The video after this one in its list, for playing on when one ends. */
export function nextVideo(
  items: readonly VideoItem[],
  currentId: string,
): VideoItem | null {
  const index = items.findIndex((item) => item.videoId === currentId);
  return index >= 0 ? (items[index + 1] ?? null) : null;
}

/** Where to carry on in a course: the first lesson not watched yet. */
export function firstUnfinished(items: readonly VideoItem[]): VideoItem | null {
  return items.find((item) => !item.finished) ?? null;
}

/** The followed channels by name, the way a Chinese reader expects them (pinyin order). */
export function sortChannels(
  channels: readonly PlayerChannel[],
): PlayerChannel[] {
  return [...channels].sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'zh-Hans-CN') ||
      a.channelId.localeCompare(b.channelId),
  );
}
