import { invoke } from '@tauri-apps/api/core';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import YouTubeDiagnostics from './YouTubeDiagnostics';
import { buildYouTubeEmbedUrl } from './youtube';
import type { NativePlayback } from './youtube-native';
import { resolveNativePlayback } from './youtube-native';
import { NativePlaybackError } from './youtube-native-errors';
import type {
  YouTubeIframePlayer,
  YouTubePlaybackResolution,
  YouTubePlaybackState,
} from './youtube-player';
import {
  loadYouTubeIframeApi,
  readPreferNative,
  youtubePlaybackStateLabels,
  youtubePlayerErrorMessage,
} from './youtube-player';
import type { NativePlayerFailure } from './YouTubeNativePlayer';

const YouTubeNativePlayer = lazy(() => import('./YouTubeNativePlayer'));

export interface YouTubePreviewSelection {
  id: string;
  title: string;
  startSeconds: number;
  /** A stream that was already resolved; the dialog opens straight into the built-in player. */
  playback?: NativePlayback;
}

/** What the page around the player can do with it, whichever way the video is being played. */
export interface YouTubePlayerHandle {
  getCurrentTime(): number | null;
  getDuration(): number | null;
  seekTo(seconds: number): void;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  play(): void;
  pause(): void;
}

export interface PlayerProgress {
  seconds: number;
  duration: number | null;
  playing: boolean;
}

export interface YouTubePlayerPanelProps {
  selection: YouTubePreviewSelection;
  /**
   * "dialog" is the modal opened from a mind map card. "page" sits in the player page, which has
   * its own heading and starts the video by itself.
   */
  variant?: 'dialog' | 'page';
  onClose?: () => void;
  /** About once a second while playing, and once more when playback pauses or ends. */
  onProgress?: (progress: PlayerProgress) => void;
  onStatusChange?: (status: YouTubePlaybackState) => void;
  onEnded?: () => void;
  /** The controls, once there is a player to control; null when it goes away. */
  onHandle?: (handle: YouTubePlayerHandle | null) => void;
}

type PlayerMode = 'embed' | 'native' | 'local';

type NativeState =
  | { phase: 'idle' }
  | { phase: 'resolving' }
  | { phase: 'ready'; playback: NativePlayback }
  | { phase: 'failed'; error: NativePlaybackError };

const EMBED_TIMEOUT_MS = 15_000;
/** How long the page waits for an embedded video to start by itself before it says what to try. */
const AUTOPLAY_HINT_MS = 12_000;
const PLAYER_TIMEOUT_MS = 30_000;
const EXPIRED_RELOAD_INTERVAL_MS = 120_000;
const iframePermissions =
  'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share';

function messageOf(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error;
  return error instanceof Error && error.message ? error.message : fallback;
}

function newRequestId(): string {
  return `yt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function YouTubePlayerPanel({
  selection,
  variant = 'dialog',
  onClose,
  onProgress,
  onStatusChange,
  onEnded,
  onHandle,
}: YouTubePlayerPanelProps) {
  const isDialog = variant === 'dialog';
  const [preloaded] = useState(selection.playback ?? null);
  const [initialPreferNative] = useState(
    () => !preloaded && readPreferNative(),
  );
  const [mode, setMode] = useState<PlayerMode>(
    preloaded || initialPreferNative ? 'native' : 'embed',
  );
  const [status, setStatus] = useState<YouTubePlaybackState>(
    initialPreferNative ? 'resolving' : 'loading',
  );
  const [embedSession, setEmbedSession] = useState(0);
  const [iframeError, setIframeError] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [native, setNative] = useState<NativeState>(
    preloaded
      ? { phase: 'ready', playback: preloaded }
      : initialPreferNative
        ? { phase: 'resolving' }
        : { phase: 'idle' },
  );
  const [localSource, setLocalSource] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  const [mpvBusy, setMpvBusy] = useState(false);
  const [mpvLaunched, setMpvLaunched] = useState(false);

  const embedHostRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const embedPlayerRef = useRef<YouTubeIframePlayer | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const nativeAbortRef = useRef<AbortController | null>(null);
  const resumeRef = useRef(selection.startSeconds);
  const requestIdRef = useRef(newRequestId());
  const autoFallbackTriedRef = useRef(false);
  const hadPlaybackRef = useRef(preloaded !== null);
  const lastReloadRef = useRef(0);
  const latest = useRef({ mode, status });
  const startNativeRef = useRef<(auto: boolean) => Promise<void>>(
    async () => undefined,
  );

  useEffect(() => {
    latest.current = { mode, status };
  });

  /** Remembers where the playing video was and pauses it before another player takes over. */
  const captureResume = () => {
    stageRef.current?.querySelector('video')?.pause();
    const player = embedPlayerRef.current;
    if (!player) return;
    try {
      const seconds = player.getCurrentTime();
      if (Number.isFinite(seconds) && seconds > 1)
        resumeRef.current = Math.floor(seconds);
      player.pauseVideo();
    } catch {
      // The player may not be ready yet; the link's start time is used instead.
    }
  };

  const cancelBackgroundWork = () => {
    nativeAbortRef.current?.abort();
    void invoke('youtube_cancel', { requestId: requestIdRef.current }).catch(
      () => undefined,
    );
  };

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const close = () => {
    cancelBackgroundWork();
    onCloseRef.current?.();
  };

  /** The latest call wins: starting again aborts a resolution that is still running. */
  const startNative = async (auto: boolean) => {
    captureResume();
    nativeAbortRef.current?.abort();
    const controller = new AbortController();
    nativeAbortRef.current = controller;
    const previousStatus = latest.current.status;
    setNative({ phase: 'resolving' });
    setStatus('resolving');
    setNotice('');
    setMessage(auto ? '内嵌播放器不可用，正在改用内置播放器…' : '');
    try {
      const playback = await resolveNativePlayback(selection.id, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      hadPlaybackRef.current = true;
      setNative({ phase: 'ready', playback });
      setMode('native');
      setStatus('loading');
      setFailure(null);
      setMessage(
        `内置播放器 · ${playback.client} 客户端${auto ? '（内嵌播放器不可用，已自动切换）' : ''}`,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason =
        error instanceof NativePlaybackError
          ? error
          : new NativePlaybackError('unknown', messageOf(error, ''));
      setNative({ phase: 'failed', error: reason });
      setFailure(
        reason.detail
          ? `${reason.message}（${reason.detail}）`
          : reason.message,
      );
      setMessage(reason.message);
      if (latest.current.mode === 'native' && !hadPlaybackRef.current) {
        // Native was the first choice and never produced a picture: fall back to YouTube's player.
        setMode('embed');
        setEmbedSession((session) => session + 1);
      } else {
        setStatus(previousStatus === 'resolving' ? 'ready' : previousStatus);
      }
    }
  };

  useEffect(() => {
    startNativeRef.current = startNative;
  });

  useEffect(() => {
    if (initialPreferNative) void startNativeRef.current(false);
  }, [initialPreferNative]);

  useEffect(
    () => () => {
      nativeAbortRef.current?.abort();
      void invoke('youtube_cancel', { requestId: requestIdRef.current }).catch(
        () => undefined,
      );
    },
    [],
  );

  const launchWithMpv = async () => {
    captureResume();
    setMpvBusy(true);
    setNotice('');
    try {
      await invoke('youtube_open_with_mpv', {
        videoId: selection.id,
        startSeconds: resumeRef.current,
        requestId: requestIdRef.current,
      });
      setMpvLaunched(true);
      setMessage('mpv 已启动，正在外部窗口加载视频。');
    } catch (error) {
      setMpvLaunched(false);
      const text = messageOf(error, '无法启动外部播放器。');
      setMessage(text);
      setFailure(text);
    } finally {
      setMpvBusy(false);
    }
  };

  const resolveLocally = async (browser?: 'firefox' | 'edge' | 'chrome') => {
    if (localBusy) return;
    captureResume();
    setLocalBusy(true);
    setNotice('');
    setMessage('');
    setMpvLaunched(false);
    const previousStatus = latest.current.status;
    setStatus('resolving');
    try {
      const resolution = browser
        ? await invoke<YouTubePlaybackResolution>(
            'youtube_resolve_playback_with_browser',
            {
              videoId: selection.id,
              browser,
              requestId: requestIdRef.current,
            },
          )
        : await invoke<YouTubePlaybackResolution>('youtube_resolve_playback', {
            videoId: selection.id,
            requestId: requestIdRef.current,
          });
      if (resolution.backend === 'html5') {
        setLocalSource(resolution.url);
        setMode('local');
        setStatus('loading');
        setMessage('本地解析 · 已取得兼容的 MP4 流，使用 HTML5 播放。');
      } else {
        setStatus('ready');
        await invoke('youtube_open_with_mpv', {
          videoId: selection.id,
          startSeconds: resumeRef.current,
          requestId: requestIdRef.current,
        });
        setMpvLaunched(true);
        setMessage(`${resolution.reason} 已交由 mpv 外部播放。`);
      }
    } catch (error) {
      const text = messageOf(error, '无法解析或启动兼容的播放方式。');
      setMessage(text);
      setFailure(text);
      setStatus(previousStatus === 'resolving' ? 'ready' : previousStatus);
    } finally {
      setLocalBusy(false);
    }
  };

  const returnToEmbed = () => {
    nativeAbortRef.current?.abort();
    setLocalSource('');
    setNotice('');
    setMessage('');
    setMpvLaunched(false);
    setIframeError(null);
    setStatus('loading');
    setMode('embed');
    setEmbedSession((session) => session + 1);
  };

  const handleNativeFailure = (playerFailure: NativePlayerFailure) => {
    if (
      playerFailure.kind === 'expired' &&
      Date.now() - lastReloadRef.current > EXPIRED_RELOAD_INTERVAL_MS
    ) {
      lastReloadRef.current = Date.now();
      setMessage('播放地址已过期，正在重新解析…');
      void startNativeRef.current(false);
      return;
    }
    setNotice(playerFailure.message);
    setFailure(playerFailure.message);
    setStatus('error');
  };

  // The YouTube IFrame player lives in an element this component creates, so the API can remove it
  // on destroy without React ever holding a node that no longer exists.
  useEffect(() => {
    if (mode !== 'embed') return;
    const host = embedHostRef.current;
    if (!host) return;
    const src = buildYouTubeEmbedUrl(selection.id, resumeRef.current, {
      autoplay: !isDialog,
    });
    if (!src) {
      setStatus('error');
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.title = `播放 ${selection.title}`;
    iframe.src = src;
    iframe.allow = iframePermissions;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.allowFullscreen = true;
    host.replaceChildren(iframe);
    setStatus('loading');
    setIframeError(null);

    let cancelled = false;
    let player: YouTubeIframePlayer | null = null;
    void loadYouTubeIframeApi()
      .then((api) => {
        if (cancelled) return;
        player = new api.Player(iframe, {
          events: {
            onReady: () => {
              if (!cancelled) setStatus('ready');
            },
            onStateChange: (event) => {
              if (cancelled) return;
              switch (event.data) {
                case api.PlayerState.PLAYING:
                  setStatus('playing');
                  break;
                case api.PlayerState.PAUSED:
                  setStatus('paused');
                  break;
                case api.PlayerState.BUFFERING:
                  setStatus('buffering');
                  break;
                case api.PlayerState.ENDED:
                  setStatus('ended');
                  break;
                default:
                  setStatus('ready');
              }
            },
            onError: (event) => {
              if (cancelled) return;
              setIframeError(event.data);
              setStatus('error');
            },
          },
        });
        embedPlayerRef.current = player;
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
      embedPlayerRef.current = null;
      try {
        player?.destroy();
      } catch {
        // The iframe is removed below either way.
      }
      host.replaceChildren();
    };
  }, [mode, embedSession, selection.id, selection.title]);

  // When the embedded player cannot play the video, try the built-in one once without being asked.
  useEffect(() => {
    if (
      mode === 'embed' &&
      (status === 'error' || status === 'timeout') &&
      !autoFallbackTriedRef.current
    ) {
      autoFallbackTriedRef.current = true;
      void startNativeRef.current(true);
    }
  }, [mode, status]);

  useEffect(() => {
    if (
      (status !== 'loading' && status !== 'buffering') ||
      (mode === 'native' && native.phase !== 'ready')
    )
      return;
    const waiting = status;
    const timeout = window.setTimeout(
      () =>
        setStatus((current) => {
          if (current !== waiting) return current;
          return waiting === 'buffering' ? 'stalled' : 'timeout';
        }),
      mode === 'embed' ? EMBED_TIMEOUT_MS : PLAYER_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [mode, status, native.phase]);

  // On the player page the embedded video starts by itself. When it has not after a while, say what
  // the other ways of playing are: YouTube's check that asks the viewer to sign in is drawn inside
  // the frame, where the page cannot see it, and the player reports nothing wrong.
  const [autoplayStalled, setAutoplayStalled] = useState(false);
  useEffect(() => {
    setAutoplayStalled(false);
    if (isDialog || mode !== 'embed' || status !== 'ready') return undefined;
    const timer = window.setTimeout(
      () => setAutoplayStalled(true),
      AUTOPLAY_HINT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isDialog, mode, status]);

  useEffect(() => {
    if (!isDialog) return undefined;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButtonRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (!isDialog) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      nativeAbortRef.current?.abort();
      void invoke('youtube_cancel', { requestId: requestIdRef.current }).catch(
        () => undefined,
      );
      onCloseRef.current?.();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, []);

  const callbacks = useRef({ onProgress, onStatusChange, onEnded });
  const onHandleRef = useRef(onHandle);
  useEffect(() => {
    callbacks.current = { onProgress, onStatusChange, onEnded };
    onHandleRef.current = onHandle;
  });

  const handle = useMemo<YouTubePlayerHandle>(() => {
    const video = () => stageRef.current?.querySelector('video') ?? null;
    const finite = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    return {
      getCurrentTime() {
        const element = video();
        if (element) return finite(element.currentTime);
        try {
          return finite(embedPlayerRef.current?.getCurrentTime());
        } catch {
          return null;
        }
      },
      getDuration() {
        const element = video();
        if (element) return finite(element.duration);
        try {
          const duration = finite(embedPlayerRef.current?.getDuration());
          return duration && duration > 0 ? duration : null;
        } catch {
          return null;
        }
      },
      seekTo(seconds) {
        const element = video();
        if (element) {
          element.currentTime = Math.max(0, seconds);
          return;
        }
        try {
          embedPlayerRef.current?.seekTo(Math.max(0, seconds), true);
        } catch {
          // The player may not be ready yet.
        }
      },
      setPlaybackRate(rate) {
        const element = video();
        if (element) {
          element.playbackRate = rate;
          return;
        }
        try {
          embedPlayerRef.current?.setPlaybackRate(rate);
        } catch {
          // The player may not be ready yet.
        }
      },
      getPlaybackRate() {
        const element = video();
        if (element) return element.playbackRate;
        try {
          return finite(embedPlayerRef.current?.getPlaybackRate()) ?? 1;
        } catch {
          return 1;
        }
      },
      play() {
        const element = video();
        if (element) void element.play().catch(() => undefined);
        else
          try {
            embedPlayerRef.current?.playVideo();
          } catch {
            // The player may not be ready yet.
          }
      },
      pause() {
        const element = video();
        if (element) element.pause();
        else
          try {
            embedPlayerRef.current?.pauseVideo();
          } catch {
            // The player may not be ready yet.
          }
      },
    };
  }, []);

  useEffect(() => {
    onHandleRef.current?.(handle);
    return () => onHandleRef.current?.(null);
  }, [handle]);

  useEffect(() => {
    callbacks.current.onStatusChange?.(status);
    if (status === 'ended') callbacks.current.onEnded?.();
  }, [status]);

  useEffect(() => {
    const report = () => {
      const seconds = handle.getCurrentTime();
      if (seconds === null) return;
      callbacks.current.onProgress?.({
        seconds,
        duration: handle.getDuration(),
        playing: status === 'playing',
      });
    };
    report();
    if (status !== 'playing') return undefined;
    const timer = window.setInterval(report, 1000);
    return () => window.clearInterval(timer);
  }, [status, handle]);

  const resolvingNative = native.phase === 'resolving';
  const playback = native.phase === 'ready' ? native.playback : null;
  const title = playback?.title || selection.title;
  const failed = status === 'error' || status === 'timeout';
  const stageNotice = !failed
    ? ''
    : notice ||
      (mode === 'embed'
        ? status === 'timeout'
          ? 'YouTube 播放器连接超时。'
          : `${youtubePlayerErrorMessage(iframeError)}${native.phase === 'failed' ? ` 内置播放器：${native.error.message}` : ''}`
        : '播放失败。');
  const loadingText = localBusy
    ? '正在用 yt-dlp 解析播放格式（最长 60 秒）…'
    : resolvingNative
      ? '正在解析播放地址…'
      : mode === 'embed'
        ? '正在连接 YouTube 播放器…'
        : '正在载入视频…';
  const watchUrl = `https://www.youtube.com/watch?v=${selection.id}${
    resumeRef.current > 0 ? `&t=${resumeRef.current}s` : ''
  }`;

  const panel = (
    <>
      <section
        className={`youtube-player-dialog${isDialog ? '' : ' is-page'}`}
        role={isDialog ? 'dialog' : undefined}
        aria-modal={isDialog ? 'true' : undefined}
        aria-labelledby={isDialog ? 'youtube-player-title' : undefined}
        aria-label={isDialog ? undefined : `播放器：${title}`}
      >
        {isDialog && (
          <div className="youtube-player-heading">
            <div>
              <span className="pane-kicker">YOUTUBE PLAYER</span>
              <h2 id="youtube-player-title">{title}</h2>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="dialog-close youtube-player-close"
              aria-label="关闭 YouTube 播放器"
              onClick={close}
            >
              ×
            </button>
          </div>
        )}
        <div ref={stageRef} className="youtube-player-stage">
          {mode === 'embed' && (
            <div
              key={embedSession}
              ref={embedHostRef}
              className="youtube-embed-host"
            />
          )}
          {mode === 'native' && playback && (
            <Suspense fallback={null}>
              <YouTubeNativePlayer
                playback={playback}
                startSeconds={resumeRef.current}
                onState={setStatus}
                onFailure={handleNativeFailure}
                onTime={(seconds) => {
                  resumeRef.current = Math.floor(seconds);
                }}
              />
            </Suspense>
          )}
          {mode === 'local' && localSource && (
            <video
              className="youtube-player-video"
              src={localSource}
              controls
              playsInline
              autoPlay={!isDialog}
              preload="metadata"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                if (
                  resumeRef.current > 0 &&
                  Number.isFinite(video.duration) &&
                  resumeRef.current < video.duration
                )
                  video.currentTime = resumeRef.current;
                setStatus('ready');
              }}
              onPlay={() => setStatus('playing')}
              onPause={() => setStatus('paused')}
              onWaiting={() => setStatus('buffering')}
              onEnded={() => setStatus('ended')}
              onError={() => {
                setNotice('浏览器无法播放该媒体流，或者播放地址已过期。');
                setStatus('error');
              }}
            />
          )}
          {(status === 'loading' || status === 'resolving') && (
            <div className="youtube-player-loading" role="status">
              {loadingText}
            </div>
          )}
          {stageNotice && (
            <div className="youtube-player-notice" role="alert">
              {stageNotice}
            </div>
          )}
        </div>
        {message && (
          <div className="youtube-player-route-message" role="status">
            {message}
          </div>
        )}
        {!message && autoplayStalled && (
          <div className="youtube-player-route-message" role="status">
            视频没有自动开始播放。如果画面里要求登录验证（YouTube
            对当前网络的风控），可以点下面的“内置播放器”或“本地解析”换一种方式播放。
          </div>
        )}
        <div className="youtube-player-actions">
          <button
            type="button"
            className="youtube-player-action"
            onClick={() => void startNative(false)}
            disabled={resolvingNative}
          >
            {resolvingNative
              ? '正在解析…'
              : mode === 'native'
                ? '重新解析'
                : '内置播放器'}
          </button>
          {mode !== 'local' && (
            <button
              type="button"
              className="youtube-player-action"
              onClick={() => void resolveLocally()}
              disabled={localBusy}
            >
              {localBusy ? '正在解析…' : '本地解析（yt-dlp）'}
            </button>
          )}
          <button
            type="button"
            className="youtube-player-action"
            onClick={() => void launchWithMpv()}
            disabled={mpvBusy || localBusy}
          >
            {mpvBusy ? '正在启动 mpv…' : '用 mpv 外部播放'}
          </button>
          {mode !== 'embed' && (
            <button
              type="button"
              className="youtube-player-action"
              onClick={returnToEmbed}
            >
              返回 YouTube 内嵌播放
            </button>
          )}
        </div>
        <YouTubeDiagnostics
          videoId={selection.id}
          failure={failure}
          busy={localBusy}
          onBrowserSession={(browser) => void resolveLocally(browser)}
        />
        <div className="youtube-player-meta">
          <span
            className="youtube-player-state"
            data-state={mpvLaunched ? 'ready' : status}
            aria-live="polite"
          >
            <span className="youtube-player-state-dot" aria-hidden="true" />
            {mpvLaunched ? 'mpv 已启动' : youtubePlaybackStateLabels[status]}
          </span>
          <span>
            {mode === 'native'
              ? '内置播放器（经本地代理）'
              : mode === 'local'
                ? '本地 HTML5 媒体播放'
                : '视频由 YouTube 提供'}
          </span>
          <a href={watchUrl} target="_blank" rel="noopener noreferrer">
            在 YouTube 打开
          </a>
        </div>
      </section>
    </>
  );
  if (!isDialog) return panel;
  return (
    <div
      className="youtube-player-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      {panel}
    </div>
  );
}
