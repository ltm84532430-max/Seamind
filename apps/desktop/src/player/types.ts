/** Mirrors of what `player_store.rs` sends and receives. Times are unix seconds. */

export interface PlayerChannel {
  channelId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  description: string | null;
  subscribedAt: number;
  lastCheckedAt: number | null;
  lastError: string | null;
}

export interface ChannelInput {
  channelId: string;
  name: string;
  handle?: string | null;
  avatarUrl?: string | null;
  description?: string | null;
}

/** What a listing knows about a video. Everything but the id and the title may be missing. */
export interface VideoInput {
  videoId: string;
  channelId?: string | null;
  channelName?: string | null;
  title: string;
  publishedAt?: number | null;
  /** True when `publishedAt` was worked out from text such as "5 days ago". */
  publishedApprox?: boolean;
  durationSeconds?: number | null;
  viewCount?: number | null;
  viewText?: string | null;
  thumbnailUrl?: string | null;
}

/** A video as a list shows it: what is known about it plus what the user did with it. */
export interface VideoItem {
  videoId: string;
  channelId: string | null;
  channelName: string | null;
  title: string;
  publishedAt: number | null;
  publishedApprox: boolean;
  durationSeconds: number | null;
  viewCount: number | null;
  viewText: string | null;
  thumbnailUrl: string | null;
  progressSeconds: number | null;
  finished: boolean;
  lastPlayedAt: number | null;
  favorite: boolean;
  watchLater: boolean;
}

export interface WatchState {
  progressSeconds: number;
  durationSeconds: number | null;
  finished: boolean;
  /** Where playback should start: the saved position, or 0 once the video is watched. */
  resumeSeconds: number;
}

export interface PlayerPlaylist {
  playlistId: string;
  name: string;
  /** "local" for the user's own lists, "course" for a YouTube playlist. */
  kind: 'local' | 'course';
  remoteId: string | null;
  channelName: string | null;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
  finishedCount: number;
  builtin: boolean;
}

export interface PlayerSettings {
  feedUpdateThresholdSeconds: number;
  hideFinishedInFeed: boolean;
  autoplayNext: boolean;
  pauseWhenHidden: boolean;
}

export type LearningPathNodeKind = 'stage' | 'video' | 'checkpoint';

export interface LearningPathSummary {
  pathId: string;
  title: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  videoCount: number;
  finishedCount: number;
}

export interface LearningPathNodeInput {
  nodeId: string;
  parentId?: string | null;
  position: number;
  kind: LearningPathNodeKind;
  title: string;
  note?: string | null;
  videoId?: string | null;
  startSeconds?: number;
  optional?: boolean;
  prerequisiteIds?: string[];
}

export interface LearningPathInput {
  pathId?: string | null;
  title: string;
  description?: string | null;
  nodes: LearningPathNodeInput[];
  videos?: VideoInput[];
}

export interface LearningPathNode {
  nodeId: string;
  parentId: string | null;
  position: number;
  kind: LearningPathNodeKind;
  title: string;
  note: string | null;
  videoId: string | null;
  startSeconds: number;
  optional: boolean;
  prerequisiteIds: string[];
  video: VideoItem | null;
}

export interface LearningPathDetail {
  summary: LearningPathSummary;
  nodes: LearningPathNode[];
}

export interface PlayerOverview {
  channels: PlayerChannel[];
  playlists: PlayerPlaylist[];
  learningPaths: LearningPathSummary[];
  settings: PlayerSettings;
}

export interface FeedQuery {
  channelId?: string | null;
  hideFinished?: boolean;
  limit?: number;
  offset?: number;
}

export interface FeedFetchResult {
  channelName: string | null;
  total: number;
  newVideoIds: string[];
}

export interface ImportSummary {
  added: number;
  existing: number;
  invalid: number;
}

export interface BackupSummary {
  channelsAdded: number;
  playlistsAdded: number;
  learningPathsAdded?: number;
  videos: number;
}

export interface VideoBasics {
  videoId: string;
  title: string;
  channelName: string | null;
}

export const FAVORITES_ID = 'favorites';
export const WATCH_LATER_ID = 'watch-later';

export const defaultPlayerSettings: PlayerSettings = {
  feedUpdateThresholdSeconds: 3600,
  hideFinishedInFeed: false,
  autoplayNext: true,
  pauseWhenHidden: true,
};
