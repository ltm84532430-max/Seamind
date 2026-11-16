import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  useGlobalMedia,
  type MediaProgressSnapshot,
} from '../media/global-media-store';
import {
  feedAsrApi,
  mergeCaptionCue,
  type FeedAsrCaption,
  type FeedAsrMode,
  type FeedAsrStatus,
} from './feed-asr-api';
import type { FeedArticle } from './types';

export const FEED_AUDIO_SPEED_OPTIONS = [0.8, 1.0, 1.25, 1.5, 2.0] as const;

export interface FeedAudioContextValue {
  article: FeedArticle | null;
  isPlaying: boolean;
  duration: number;
  speedIndex: number;
  volume: number;
  isMuted: boolean;
  captionEnabled: boolean;
  captionBusy: boolean;
  captionStatus: FeedAsrStatus | null;
  captionError: string;
  captionDownload: {
    downloadedBytes: number;
    totalBytes: number;
    label: string;
  };
  captionCues: FeedAsrCaption[];
  partialCaption: FeedAsrCaption | null;
  captionMode: FeedAsrMode;
  playArticle(article: FeedArticle): void;
  closePlayer(): void;
  togglePlay(): void;
  skip(seconds: number): void;
  seekTo(seconds: number): void;
  cycleSpeed(): void;
  setVolumeLevel(volume: number): void;
  toggleMute(): void;
  toggleCaptions(): Promise<void>;
  selectCaptionMode(mode: FeedAsrMode): Promise<void>;
}

const FeedAudioContext = createContext<FeedAudioContextValue | null>(null);

export function useFeedAudio(): FeedAudioContextValue {
  const ctx = useContext(FeedAudioContext);
  if (!ctx) {
    throw new Error('useFeedAudio must be used within FeedAudioProvider');
  }
  return ctx;
}

export function useFeedAudioProgress(): MediaProgressSnapshot {
  const media = useGlobalMedia();
  const getSnapshot = useCallback(
    () => media.getProgressOf('podcast'),
    [media],
  );
  return useSyncExternalStore(
    media.subscribeProgress,
    getSnapshot,
    getSnapshot,
  );
}

export const FeedAudioProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const media = useGlobalMedia();
  const audioRef = useRef<HTMLAudioElement>(null);

  const [article, setArticle] = useState<FeedArticle | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(1); // 1.0x
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackSrc, setPlaybackSrc] = useState('');

  const [captionEnabled, setCaptionEnabled] = useState(false);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [captionStatus, setCaptionStatus] = useState<FeedAsrStatus | null>(
    null,
  );
  const [captionError, setCaptionError] = useState('');
  const [captionDownload, setCaptionDownload] = useState({
    downloadedBytes: 0,
    totalBytes: 0,
    label: '',
  });
  const [captionCues, setCaptionCues] = useState<FeedAsrCaption[]>([]);
  const [partialCaption, setPartialCaption] = useState<FeedAsrCaption | null>(
    null,
  );
  const [captionMode, setCaptionMode] = useState<FeedAsrMode>('podcast');
  const [seekRevision, setSeekRevision] = useState(0);

  const articleRef = useRef<FeedArticle | null>(null);
  articleRef.current = article;
  const durationRef = useRef(0);
  durationRef.current = duration;
  const speedIndexRef = useRef(speedIndex);
  speedIndexRef.current = speedIndex;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const captionEnabledRef = useRef(captionEnabled);
  captionEnabledRef.current = captionEnabled;

  const loadGenRef = useRef(0);
  const resumeMapRef = useRef(new Map<string, number>());
  const pendingSeekRef = useRef<number>(0);

  const captionSessionRef = useRef<string | null>(null);
  const captionQueueRef = useRef<FeedAsrCaption[]>([]);
  const captionListenerReadyRef = useRef<Promise<void>>(Promise.resolve());
  const applyCaptionRef = useRef<(caption: FeedAsrCaption) => void>(
    () => undefined,
  );

  const audioUrl = article?.audioUrl ?? '';

  applyCaptionRef.current = (caption) => {
    if (caption.error) {
      setCaptionError(caption.error);
      setCaptionEnabled(false);
      return;
    }
    setCaptionError('');
    if (caption.isFinal) {
      if (caption.text.trim()) {
        setCaptionCues((current) => mergeCaptionCue(current, caption));
      }
      setPartialCaption(null);
      return;
    }
    if (caption.text.trim()) setPartialCaption(caption);
  };

  useEffect(() => {
    let mounted = true;
    void feedAsrApi
      .getStatus()
      .then((status) => {
        if (mounted) setCaptionStatus(status);
      })
      .catch((error: unknown) => {
        if (mounted) {
          setCaptionError(
            error instanceof Error ? error.message : '无法读取本机字幕组件状态',
          );
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    captionListenerReadyRef.current = feedAsrApi
      .listen((caption) => {
        if (!mounted) return;
        if (caption.sessionId !== captionSessionRef.current) {
          captionQueueRef.current.push(caption);
          if (captionQueueRef.current.length > 30) {
            captionQueueRef.current.shift();
          }
          return;
        }
        applyCaptionRef.current(caption);
      })
      .then((stopListening) => {
        if (mounted) unlisten = stopListening;
        else stopListening();
      })
      .catch((error: unknown) => {
        setCaptionError(
          error instanceof Error ? error.message : '字幕事件监听启动失败',
        );
      });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const buildPodcastMeta = useCallback(
    (
      target: FeedArticle,
      status:
        | 'idle'
        | 'loading'
        | 'buffering'
        | 'playing'
        | 'paused'
        | 'ended'
        | 'error',
      explicitDuration?: number,
    ) => ({
      kind: 'podcast' as const,
      id: target.id,
      title: target.title,
      subtitle: target.channelTitle,
      artworkUrl: target.imageUrl ?? null,
      status,
      duration:
        explicitDuration ?? (durationRef.current || target.audioDuration || 0),
      playbackRate: FEED_AUDIO_SPEED_OPTIONS[speedIndexRef.current],
      muted: isMutedRef.current || volumeRef.current === 0,
      canSeek: true,
      captionEnabled: captionEnabledRef.current,
    }),
    [],
  );

  // Resolve cached audio path whenever the active article changes.
  useEffect(() => {
    const gen = ++loadGenRef.current;
    setCaptionCues([]);
    setPartialCaption(null);
    setCaptionError('');
    captionQueueRef.current = [];
    setPlaybackSrc('');

    const targetId = article?.id;
    const targetUrl = article?.audioUrl ?? '';
    if (!targetUrl || !targetId) return;

    void feedAsrApi
      .cachedAudio(targetUrl, targetId)
      .then((path) => {
        if (loadGenRef.current !== gen) return;
        setPlaybackSrc(path ? convertFileSrc(path) : targetUrl);
      })
      .catch(() => {
        if (loadGenRef.current !== gen) return;
        setPlaybackSrc(targetUrl);
      });
  }, [article?.id, article?.audioUrl]);

  // Manage live ASR session across workspace switches.
  useEffect(() => {
    const articleId = article?.id;
    if (!captionEnabled || !isPlaying || !audioUrl || !articleId) return;

    let cancelled = false;
    let sessionId: string | null = null;
    setPartialCaption(null);

    void (async () => {
      try {
        await captionListenerReadyRef.current;
        const id = await feedAsrApi.start(
          audioUrl,
          audioRef.current?.currentTime ?? 0,
          FEED_AUDIO_SPEED_OPTIONS[speedIndex],
          articleId,
          captionMode,
        );
        sessionId = id;
        if (cancelled) {
          await feedAsrApi.stop(id);
          return;
        }
        captionSessionRef.current = id;
        const queued = captionQueueRef.current.filter(
          (caption) => caption.sessionId === id,
        );
        captionQueueRef.current = captionQueueRef.current.filter(
          (caption) => caption.sessionId !== id,
        );
        queued.forEach((caption) => applyCaptionRef.current(caption));
        setCaptionError('');
      } catch (error) {
        if (cancelled) return;
        setCaptionEnabled(false);
        setCaptionError(
          error instanceof Error ? error.message : '实时字幕启动失败',
        );
      }
    })();

    return () => {
      cancelled = true;
      if (!sessionId) return;
      if (captionSessionRef.current === sessionId) {
        captionSessionRef.current = null;
      }
      void feedAsrApi.stop(sessionId).catch(() => undefined);
    };
  }, [
    captionEnabled,
    isPlaying,
    audioUrl,
    article?.id,
    speedIndex,
    seekRevision,
    captionMode,
  ]);

  // Start playback once playbackSrc resolves for the selected article.
  useEffect(() => {
    const el = audioRef.current;
    const currentArticle = articleRef.current;
    if (!el || !playbackSrc || !currentArticle) return;

    const resumeAt = pendingSeekRef.current;
    const initialDuration = currentArticle.audioDuration || 0;
    setDuration(initialDuration);
    el.playbackRate = FEED_AUDIO_SPEED_OPTIONS[speedIndexRef.current];
    el.volume = isMutedRef.current ? 0 : volumeRef.current;
    el.currentTime = resumeAt;
    media.setProgress('podcast', {
      currentTime: resumeAt,
      duration: initialDuration,
      bufferedPercent: 0,
    });

    let cancelled = false;
    const playPromise = el.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          if (cancelled) return;
          setIsPlaying(true);
        })
        .catch(() => {
          if (cancelled) return;
          setIsPlaying(false);
          media.updateMeta('podcast', { status: 'paused' });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [playbackSrc, article?.id, media]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = FEED_AUDIO_SPEED_OPTIONS[speedIndex];
    media.updateMeta('podcast', {
      playbackRate: FEED_AUDIO_SPEED_OPTIONS[speedIndex],
    });
  }, [speedIndex, media]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = isMuted ? 0 : volume;
    media.updateMeta('podcast', {
      muted: isMuted || volume === 0,
    });
  }, [volume, isMuted, media]);

  useEffect(() => {
    media.updateMeta('podcast', { captionEnabled });
  }, [captionEnabled, media]);

  const saveCurrentResumePosition = useCallback(() => {
    const current = articleRef.current;
    const el = audioRef.current;
    if (!current || !el) return;
    const t = el.currentTime;
    const dur =
      Number.isFinite(el.duration) && el.duration > 0
        ? el.duration
        : durationRef.current;
    if (Number.isFinite(t) && t > 5 && (!dur || t < dur - 5)) {
      resumeMapRef.current.set(current.id, t);
    }
  }, []);

  const playArticle = useCallback(
    (next: FeedArticle) => {
      if (!next.audioUrl) return;
      const current = articleRef.current;
      const el = audioRef.current;

      if (current?.id === next.id && el && playbackSrc) {
        media.claimFocus(
          buildPodcastMeta(next, el.paused ? 'loading' : 'playing'),
        );
        if (el.paused) {
          void el
            .play()
            .then(() => setIsPlaying(true))
            .catch(() => setIsPlaying(false));
        }
        return;
      }

      saveCurrentResumePosition();
      const resumePos = resumeMapRef.current.get(next.id) ?? 0;
      pendingSeekRef.current = resumePos;
      setArticle(next);
      media.claimFocus(
        buildPodcastMeta(next, 'loading', next.audioDuration || 0),
      );
    },
    [buildPodcastMeta, media, playbackSrc, saveCurrentResumePosition],
  );

  const closePlayer = useCallback(() => {
    saveCurrentResumePosition();
    loadGenRef.current += 1;
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    setIsPlaying(false);
    setPlaybackSrc('');
    setDuration(0);
    setArticle(null);
    setCaptionEnabled(false);
    setPartialCaption(null);
    media.clearSource('podcast');
  }, [media, saveCurrentResumePosition]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    const current = articleRef.current;
    if (!el || !current) return;
    if (!el.paused) {
      el.pause();
      setIsPlaying(false);
    } else {
      if (media.getActiveSource() !== 'podcast') {
        media.claimFocus(buildPodcastMeta(current, 'loading'));
      }
      el.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  }, [buildPodcastMeta, media]);

  const seekTo = useCallback(
    (seconds: number) => {
      const el = audioRef.current;
      if (!el) return;
      const maxDuration =
        Number.isFinite(el.duration) && el.duration > 0
          ? el.duration
          : durationRef.current;
      const target = Math.max(
        0,
        maxDuration > 0 ? Math.min(maxDuration, seconds) : seconds,
      );
      el.currentTime = target;
      media.setProgress('podcast', {
        currentTime: target,
        duration: maxDuration,
        bufferedPercent:
          el.buffered.length > 0 && maxDuration > 0
            ? Math.min(
                100,
                (el.buffered.end(el.buffered.length - 1) / maxDuration) * 100,
              )
            : 0,
      });
      setSeekRevision((revision) => revision + 1);
    },
    [media],
  );

  const skip = useCallback(
    (seconds: number) => {
      const el = audioRef.current;
      if (!el) return;
      seekTo(el.currentTime + seconds);
    },
    [seekTo],
  );

  const cycleSpeed = useCallback(() => {
    setSpeedIndex((prev) => (prev + 1) % FEED_AUDIO_SPEED_OPTIONS.length);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  const selectCaptionMode = useCallback(
    async (mode: FeedAsrMode) => {
      if (mode === captionMode || captionBusy) return;
      if (!captionEnabled) {
        setCaptionMode(mode);
        return;
      }
      setCaptionBusy(true);
      setCaptionError('');
      try {
        let status = await feedAsrApi.getStatus();
        const ready =
          mode === 'streaming'
            ? status.streamingModelInstalled
            : status.modelInstalled;
        if (!ready) {
          setCaptionDownload({ downloadedBytes: 0, totalBytes: 0, label: '' });
          status = await feedAsrApi.installModel((progress) => {
            setCaptionDownload({
              downloadedBytes: progress.downloadedBytes,
              totalBytes: progress.totalBytes ?? 0,
              label: progress.label ?? '',
            });
          }, mode);
          setCaptionStatus(status);
        }
        setCaptionMode(mode);
      } catch (error) {
        setCaptionError(
          error instanceof Error ? error.message : '切换字幕模式失败',
        );
      } finally {
        setCaptionBusy(false);
      }
    },
    [captionMode, captionBusy, captionEnabled],
  );

  const toggleCaptions = useCallback(async () => {
    if (captionEnabled) {
      setCaptionEnabled(false);
      setPartialCaption(null);
      return;
    }
    if (captionBusy) return;
    setCaptionBusy(true);
    setCaptionError('');
    try {
      let status = await feedAsrApi.getStatus();
      setCaptionStatus(status);
      if (!status.ffmpegAvailable) {
        setCaptionError(
          '未检测到 FFmpeg。请先安装 FFmpeg 并加入 PATH，然后重启 Seamind。',
        );
        return;
      }
      const modelReady =
        captionMode === 'streaming'
          ? status.streamingModelInstalled
          : status.modelInstalled;
      if (!modelReady) {
        setCaptionDownload({ downloadedBytes: 0, totalBytes: 0, label: '' });
        status = await feedAsrApi.installModel((progress) => {
          setCaptionDownload({
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes ?? 0,
            label: progress.label ?? '',
          });
        }, captionMode);
        setCaptionStatus(status);
      }
      setCaptionEnabled(true);
    } catch (error) {
      setCaptionError(
        error instanceof Error ? error.message : '本地字幕模型安装失败',
      );
    } finally {
      setCaptionBusy(false);
    }
  }, [captionEnabled, captionBusy, captionMode]);

  // Register podcast adapter into the global media coordinator.
  useEffect(() => {
    media.registerAdapter('podcast', {
      play: () => {
        const el = audioRef.current;
        const current = articleRef.current;
        if (!el || !current) return;
        if (media.getActiveSource() !== 'podcast') {
          media.claimFocus(buildPodcastMeta(current, 'loading'));
        }
        void el
          .play()
          .then(() => setIsPlaying(true))
          .catch(() => {
            setIsPlaying(false);
            media.updateMeta('podcast', { status: 'paused' });
          });
      },
      pause: () => {
        audioRef.current?.pause();
        setIsPlaying(false);
      },
      seekTo,
      skipBy: skip,
      toggleMute,
      cycleSpeed,
      stopAndClose: closePlayer,
    });
    return () => {
      media.registerAdapter('podcast', null);
    };
  }, [
    media,
    buildPodcastMeta,
    seekTo,
    skip,
    toggleMute,
    cycleSpeed,
    closePlayer,
  ]);

  const handleTimeUpdate = () => {
    const el = audioRef.current;
    if (!el) return;
    const dur =
      Number.isFinite(el.duration) && el.duration > 0
        ? el.duration
        : durationRef.current;
    let bufferedPercent = 0;
    if (el.buffered.length > 0 && dur > 0) {
      const bufEnd = el.buffered.end(el.buffered.length - 1);
      bufferedPercent = Math.min(100, (bufEnd / dur) * 100);
    }
    media.setProgress('podcast', {
      currentTime: el.currentTime,
      duration: dur,
      bufferedPercent,
    });
  };

  const handleLoadedMetadata = () => {
    const el = audioRef.current;
    if (!el) return;
    const nextDuration =
      el.duration && Number.isFinite(el.duration) ? el.duration : 0;
    if (nextDuration > 0) {
      setDuration(nextDuration);
      media.updateMeta('podcast', { duration: nextDuration });
    }
    if (
      pendingSeekRef.current > 0 &&
      (nextDuration === 0 || pendingSeekRef.current < nextDuration)
    ) {
      el.currentTime = pendingSeekRef.current;
    }
    pendingSeekRef.current = 0;
    media.setProgress('podcast', {
      currentTime: el.currentTime,
      duration: nextDuration || durationRef.current,
      bufferedPercent: 0,
    });
  };

  const value = useMemo<FeedAudioContextValue>(
    () => ({
      article,
      isPlaying,
      duration,
      speedIndex,
      volume,
      isMuted,
      captionEnabled,
      captionBusy,
      captionStatus,
      captionError,
      captionDownload,
      captionCues,
      partialCaption,
      captionMode,
      playArticle,
      closePlayer,
      togglePlay,
      skip,
      seekTo,
      cycleSpeed,
      setVolumeLevel: (next) => {
        setVolume(next);
        if (isMutedRef.current) setIsMuted(false);
      },
      toggleMute,
      toggleCaptions,
      selectCaptionMode,
    }),
    [
      article,
      isPlaying,
      duration,
      speedIndex,
      volume,
      isMuted,
      captionEnabled,
      captionBusy,
      captionStatus,
      captionError,
      captionDownload,
      captionCues,
      partialCaption,
      captionMode,
      playArticle,
      closePlayer,
      togglePlay,
      skip,
      seekTo,
      cycleSpeed,
      toggleMute,
      toggleCaptions,
      selectCaptionMode,
    ],
  );

  return (
    <FeedAudioContext.Provider value={value}>
      <audio
        ref={audioRef}
        src={playbackSrc || undefined}
        preload="metadata"
        hidden
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => {
          const current = articleRef.current;
          if (current) resumeMapRef.current.delete(current.id);
          setIsPlaying(false);
          media.updateMeta('podcast', { status: 'ended' });
        }}
        onPause={() => {
          saveCurrentResumePosition();
          setIsPlaying(false);
          const current = articleRef.current;
          if (current && media.getMetaOf('podcast')?.id === current.id) {
            media.updateMeta('podcast', { status: 'paused' });
          }
        }}
        onPlay={() => {
          setIsPlaying(true);
          const current = articleRef.current;
          if (!current) return;
          if (media.getActiveSource() !== 'podcast') {
            media.claimFocus(buildPodcastMeta(current, 'playing'));
          } else {
            media.updateMeta('podcast', { status: 'playing' });
          }
        }}
        onWaiting={() => {
          if (articleRef.current && media.getActiveSource() === 'podcast') {
            media.updateMeta('podcast', { status: 'buffering' });
          }
        }}
        onError={() => {
          setIsPlaying(false);
          if (
            articleRef.current &&
            media.getMetaOf('podcast')?.id === articleRef.current.id
          ) {
            media.updateMeta('podcast', { status: 'error' });
          }
        }}
      />
      {children}
    </FeedAudioContext.Provider>
  );
};
