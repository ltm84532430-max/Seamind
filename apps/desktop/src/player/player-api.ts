import { invoke } from '@tauri-apps/api/core';
import type {
  YouTubePlaybackCapabilities,
  YouTubePlaybackResolution,
  YouTubeSettings,
} from './youtube-player';
import type { YouTubeProxyEndpoint } from './youtube-proxy';
import type {
  BackupSummary,
  ChannelInput,
  FavoriteCategory,
  FavoriteCategoryInput,
  FavoritesSnapshot,
  FeedFetchResult,
  FeedQuery,
  ImportSummary,
  LearningPathDetail,
  LearningPathInput,
  PlayerChannel,
  PlayerOverview,
  PlayerPlaylist,
  PlayerSettings,
  SubscriptionGroupRule,
  VideoBasics,
  VideoInput,
  VideoItem,
  WatchDayVideoEntry,
  WatchHeatmapSummary,
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
    watchedDeltaSeconds?: number | null,
  ) =>
    invoke<WatchState | null>('player_save_progress', {
      videoId,
      progressSeconds,
      durationSeconds,
      watchedDeltaSeconds: watchedDeltaSeconds ?? null,
    }),
  watchState: (videoId: string) =>
    invoke<WatchState | null>('player_watch_state', { videoId }),
  setWatched: (videoId: string, watched: boolean) =>
    invoke<void>('player_set_watched', { videoId, watched }),
  watchHeatmap: (args: {
    fromDate?: string;
    toDate?: string;
    subscriptionGroups?: SubscriptionGroupRule[];
    categoryFilter?: string;
  }) => invoke<WatchHeatmapSummary>('player_watch_heatmap', args),
  watchDayDetail: (args: {
    date: string;
    subscriptionGroups?: SubscriptionGroupRule[];
    categoryFilter?: string;
  }) => invoke<WatchDayVideoEntry[]>('player_watch_day_detail', args),

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

  favoritesSnapshot: () =>
    invoke<FavoritesSnapshot>('player_favorites_snapshot'),
  favoriteCategorySave: (input: FavoriteCategoryInput) =>
    invoke<FavoriteCategory>('player_favorite_category_save', { input }),
  favoriteCategoryDelete: (categoryId: string) =>
    invoke<void>('player_favorite_category_delete', { categoryId }),
  favoriteCategoriesReorder: (categoryIds: string[]) =>
    invoke<FavoriteCategory[]>('player_favorite_categories_reorder', {
      categoryIds,
    }),
  favoriteAssign: (
    videoIds: string[],
    categoryId: string | null,
    targetIndex?: number | null,
  ) =>
    invoke<void>('player_favorite_assign', {
      videoIds,
      categoryId,
      targetIndex: targetIndex ?? null,
    }),
  favoriteSetNote: (videoId: string, note: string | null) =>
    invoke<void>('player_favorite_set_note', { videoId, note }),

  learningPathGet: (pathId: string) =>
    invoke<LearningPathDetail | null>('player_learning_path_get', { pathId }),
  learningPathSave: (input: LearningPathInput) =>
    invoke<LearningPathDetail>('player_learning_path_save', { input }),
  learningPathDelete: (pathId: string) =>
    invoke<void>('player_learning_path_delete', { pathId }),

  exportBackup: () => invoke<string>('player_export_backup'),
  importBackup: (text: string) =>
    invoke<BackupSummary>('player_import_backup', { text }),

  fetchFeed: (channelId: string) =>
    invoke<FeedFetchResult>('player_fetch_feed', { channelId }),
  clearChannelErrors: (channelId?: string) =>
    invoke<void>('player_clear_channel_errors', {
      channelId: channelId ?? null,
    }),
  fetchVideoInfo: (videoId: string) =>
    invoke<VideoBasics>('player_fetch_video_info', { videoId }),
  cancelYouTubeRequest: (args: { requestId: string }) =>
    invoke<void>('youtube_cancel', args),
  openYouTubeWithMpv: (args: {
    videoId: string;
    startSeconds: number;
    requestId: string;
  }) => invoke<void>('youtube_open_with_mpv', args),
  resolveYouTubePlayback: (args: { videoId: string; requestId: string }) =>
    invoke<YouTubePlaybackResolution>('youtube_resolve_playback', args),
  resolveYouTubePlaybackWithBrowser: (args: {
    videoId: string;
    browser: 'firefox' | 'edge' | 'chrome';
    requestId: string;
  }) =>
    invoke<YouTubePlaybackResolution>(
      'youtube_resolve_playback_with_browser',
      args,
    ),
  playbackCapabilities: () =>
    invoke<YouTubePlaybackCapabilities>('youtube_playback_capabilities'),
  youtubeSettings: () => invoke<YouTubeSettings>('youtube_get_settings'),
  setYouTubeSettings: (args: { proxyUrl: string | null }) =>
    invoke<YouTubeSettings>('youtube_set_settings', args),
  installYtDlp: () =>
    invoke<{ path: string; version: string; sha256: string }>(
      'youtube_install_ytdlp',
    ),
  proxyInfo: () => invoke<YouTubeProxyEndpoint>('youtube_proxy_info'),
  playerCacheGet: (args: { key: string }) =>
    invoke<string | null>('youtube_player_cache_get', args),
  playerCacheSet: (args: { key: string; value: string }) =>
    invoke<void>('youtube_player_cache_set', args),
  evalScript: (args: { script: string }) =>
    invoke<string>('youtube_eval_script', args),
  botguardSnapshot: (args: {
    requestId: string;
    contentBinding: string;
    challenge: {
      globalName: string;
      program: string;
      interpreterHash: string;
    };
    interpreterJavascript: string;
    ytConfig: unknown;
    userAgent: string;
  }) => invoke<unknown>('youtube_botguard_snapshot', args),
  botguardMint: (args: {
    requestId: string;
    contentBinding: string;
    integrityToken: string;
  }) => invoke<string>('youtube_botguard_mint', args),
  botguardDiscard: (args: { requestId: string }) =>
    invoke<void>('youtube_botguard_discard', args),
  refineTranscriptStage: (args: {
    request: {
      baseUrl: string;
      model: string;
      videoTitle: string;
      channelName: string;
      stageIndex: number;
      totalStages: number;
      timeRange: string;
      mode: string;
      previousContextTail: string;
      items: Array<{
        id: number;
        time: string;
        text: string;
        translation?: string;
      }>;
    };
  }) =>
    invoke<{
      stageTitle: string;
      paragraphs: Array<{
        anchorId: number;
        text: string;
        translation?: string;
      }>;
    }>('refine_transcript_stage', args),
  transcriptCommand: <T>(
    command:
      | 'youtube_transcript_list'
      | 'youtube_transcript_fetch'
      | 'youtube_transcript_embed_fetch'
      | 'youtube_transcript_ytdlp_fetch'
      | 'youtube_transcript_browser_fetch',
    args: Record<string, unknown>,
  ) => invoke<T>(command, args),
};

export type PlayerApi = typeof playerApi;

/** What Tauri rejects with is a string; anything else is described by its message. */
export function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
