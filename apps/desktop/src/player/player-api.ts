import { invoke } from '@tauri-apps/api/core';
import type {
  BackupSummary,
  ChannelInput,
  FeedFetchResult,
  FeedQuery,
  ImportSummary,
  PlayerChannel,
  PlayerOverview,
  PlayerPlaylist,
  PlayerSettings,
  VideoBasics,
  VideoInput,
  VideoItem,
  WatchState,
} from './types';

/** The commands of `player.rs`, typed. */
export const playerApi = {
  overview: () => invoke<PlayerOverview>('player_overview'),
  saveSettings: (settings: PlayerSettings) =>
    invoke<PlayerSettings>('player_settings_save', { settings }),

  subscribe: (channel: ChannelInput) =>
    invoke<PlayerChannel>('player_subscribe', { channel }),
  unsubscribe: (channelId: string) =>
    invoke<void>('player_unsubscribe', { channelId }),
  updateChannel: (channel: ChannelInput) =>
    invoke<void>('player_update_channel', { channel }),
  importChannels: (channels: ChannelInput[]) =>
    invoke<ImportSummary>('player_import_channels', { channels }),

  storeVideos: (videos: VideoInput[]) =>
    invoke<VideoItem[]>('player_store_videos', { videos }),
  videoItems: (videoIds: string[]) =>
    invoke<VideoItem[]>('player_video_items', { videoIds }),
  feed: (query: FeedQuery) => invoke<VideoItem[]>('player_feed', { query }),

  history: (limit: number, offset = 0) =>
    invoke<VideoItem[]>('player_history', { limit, offset }),
  removeFromHistory: (videoId: string) =>
    invoke<void>('player_history_remove', { videoId }),
  clearHistory: () => invoke<void>('player_history_clear'),
  markPlayed: (videoId: string) =>
    invoke<void>('player_mark_played', { videoId }),
  saveProgress: (
    videoId: string,
    progressSeconds: number,
    durationSeconds: number | null,
  ) =>
    invoke<WatchState | null>('player_save_progress', {
      videoId,
      progressSeconds,
      durationSeconds,
    }),
  watchState: (videoId: string) =>
    invoke<WatchState | null>('player_watch_state', { videoId }),
  setWatched: (videoId: string, watched: boolean) =>
    invoke<void>('player_set_watched', { videoId, watched }),

  createPlaylist: (name: string) =>
    invoke<PlayerPlaylist>('player_playlist_create', { name }),
  renamePlaylist: (playlistId: string, name: string) =>
    invoke<void>('player_playlist_rename', { playlistId, name }),
  deletePlaylist: (playlistId: string) =>
    invoke<void>('player_playlist_delete', { playlistId }),
  addToPlaylist: (playlistId: string, videoId: string) =>
    invoke<void>('player_playlist_add', { playlistId, videoId }),
  removeFromPlaylist: (playlistId: string, videoId: string) =>
    invoke<void>('player_playlist_remove', { playlistId, videoId }),
  togglePlaylist: (playlistId: string, videoId: string) =>
    invoke<boolean>('player_playlist_toggle', { playlistId, videoId }),
  playlistItems: (playlistId: string) =>
    invoke<VideoItem[]>('player_playlist_items', { playlistId }),
  saveCourse: (
    remoteId: string,
    name: string,
    channelName: string | null,
    videos: VideoInput[],
  ) =>
    invoke<PlayerPlaylist>('player_course_save', {
      remoteId,
      name,
      channelName,
      videos,
    }),

  exportBackup: () => invoke<string>('player_export_backup'),
  importBackup: (text: string) =>
    invoke<BackupSummary>('player_import_backup', { text }),

  fetchFeed: (channelId: string) =>
    invoke<FeedFetchResult>('player_fetch_feed', { channelId }),
  fetchVideoInfo: (videoId: string) =>
    invoke<VideoBasics>('player_fetch_video_info', { videoId }),
};

export type PlayerApi = typeof playerApi;

/** What Tauri rejects with is a string; anything else is described by its message. */
export function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
