import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type FeedAsrMode = 'podcast' | 'streaming';

export interface FeedAsrStatus {
  modelInstalled: boolean;
  streamingModelInstalled: boolean;
  ffmpegAvailable: boolean;
}

export interface FeedAsrDownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  label?: string;
}

export interface FeedAsrCaption {
  sessionId: string;
  start: number;
  end: number;
  text: string;
  isFinal: boolean;
  error: string | null;
}

export function mergeCaptionCue(
  current: FeedAsrCaption[],
  caption: FeedAsrCaption,
): FeedAsrCaption[] {
  const duplicate = current.some(
    (cue) =>
      cue.text === caption.text && Math.abs(cue.start - caption.start) < 0.8,
  );
  if (duplicate) return current;
  return [...current, caption].slice(-40);
}

export const feedAsrApi = {
  getStatus(): Promise<FeedAsrStatus> {
    return invoke<FeedAsrStatus>('feed_asr_get_status');
  },

  cachedAudio(audioUrl: string, articleId: string): Promise<string | null> {
    return invoke<string | null>('feed_asr_cached_audio', {
      audioUrl,
      articleId,
    });
  },

  installModel(
    onProgress: (progress: FeedAsrDownloadProgress) => void,
    mode: FeedAsrMode,
  ) {
    const channel = new Channel<FeedAsrDownloadProgress>();
    channel.onmessage = onProgress;
    return invoke<FeedAsrStatus>('feed_asr_install_model', {
      onProgress: channel,
      modelKind: mode,
    });
  },

  start(
    audioUrl: string,
    startAt: number,
    playbackRate: number,
    articleId: string,
    mode: FeedAsrMode,
  ) {
    return invoke<string>('feed_asr_start', {
      audioUrl,
      startAt,
      playbackRate,
      articleId,
      mode,
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
