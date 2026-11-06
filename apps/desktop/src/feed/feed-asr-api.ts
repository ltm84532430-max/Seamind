import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface FeedAsrStatus {
  modelInstalled: boolean;
  ffmpegAvailable: boolean;
}

export interface FeedAsrDownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface FeedAsrCaption {
  sessionId: string;
  start: number;
  end: number;
  text: string;
  isFinal: boolean;
  error: string | null;
}

export const feedAsrApi = {
  getStatus(): Promise<FeedAsrStatus> {
    return invoke<FeedAsrStatus>('feed_asr_get_status');
  },

  installModel(onProgress: (progress: FeedAsrDownloadProgress) => void) {
    const channel = new Channel<FeedAsrDownloadProgress>();
    channel.onmessage = onProgress;
    return invoke<FeedAsrStatus>('feed_asr_install_model', {
      onProgress: channel,
    });
  },

  start(audioUrl: string, startAt: number, playbackRate: number) {
    return invoke<string>('feed_asr_start', {
      audioUrl,
      startAt,
      playbackRate,
    });
  },

  stop(sessionId: string) {
    return invoke<void>('feed_asr_stop', { sessionId });
  },

  listen(onCaption: (caption: FeedAsrCaption) => void) {
    return listen<FeedAsrCaption>('feed-asr-caption', (event) => {
      onCaption(event.payload);
    });
  },
};
