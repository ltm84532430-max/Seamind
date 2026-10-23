export type YouTubePlaybackState =
  | 'loading'
  | 'resolving'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'error'
  | 'timeout'
  | 'stalled'
  | 'external';

export type YouTubePlaybackResolution =
  | {
      backend: 'html5';
      provider: 'yt-dlp' | 'newpipe';
      mediaType: 'progressiveMp4';
      url: string;
      mimeType: 'video/mp4';
    }
  | {
      backend: 'mpv';
      provider: 'yt-dlp' | 'newpipe';
      mediaType: 'hls' | 'dash' | 'separateStreams' | 'unsupported';
      mediaUrl?: string;
      audioUrl?: string;
      userAgent?: string;
      referer?: string;
      reason: string;
    };

export interface YouTubePlaybackCapabilities {
  extractor: string | null;
  extractorManaged: boolean;
  /** The extractor exists but was too slow to answer, which is not the same as not installed. */
  extractorTimedOut: boolean;
  ejsAvailable: boolean | null;
  newpipeBridgeConfigured: boolean;
  nodeAvailable: boolean;
  mpvAvailable: boolean;
  ffplayAvailable: boolean;
  ffmpegAvailable: boolean;
  proxyUrl: string | null;
}

export interface YouTubeSettings {
  proxyUrl: string | null;
  /** The proxy the embedded WebView started with; a different value needs a restart. */
  webviewProxyUrl: string | null;
}

export interface YouTubeIframePlayer {
  destroy(): void;
  pauseVideo(): void;
  playVideo(): void;
  getCurrentTime(): number;
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
}

interface YouTubePlayerEvent {
  data: number;
}

interface YouTubeIframeApi {
  PlayerState: {
    UNSTARTED: -1;
    ENDED: 0;
    PLAYING: 1;
    PAUSED: 2;
    BUFFERING: 3;
    CUED: 5;
  };
  Player: new (
    element: HTMLIFrameElement,
    options: {
      events: {
        onReady: () => void;
        onStateChange: (event: YouTubePlayerEvent) => void;
        onError: (event: YouTubePlayerEvent) => void;
      };
    },
  ) => YouTubeIframePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeIframeApi;
    onYouTubeIframeAPIReady?: () => void;
    __seamindYouTubeApiPromise?: Promise<YouTubeIframeApi>;
  }
}

export const youtubePlaybackStateLabels: Record<YouTubePlaybackState, string> =
  {
    loading: '正在连接',
    resolving: '正在解析播放地址',
    ready: '播放器已载入，视频状态未知',
    playing: '播放中',
    paused: '已暂停',
    buffering: '缓冲中',
    ended: '播放结束',
    error: '播放错误',
    timeout: '连接超时',
    stalled: '缓冲停滞',
    external: '外部播放器已启动，播放状态未知',
  };

export function youtubePlayerErrorMessage(code: number | null): string {
  switch (code) {
    case 2:
      return '视频编号或播放参数无效。';
    case 5:
      return '当前视频无法在 HTML5 播放器中播放。';
    case 100:
      return '视频不存在、已删除或设为私密。';
    case 101:
    case 150:
      return '视频所有者禁止在嵌入播放器中播放。';
    case 152:
    case 153:
      return 'YouTube 未收到有效的来源标识，内嵌播放器被拒绝。';
    default:
      return 'YouTube 播放器遇到问题。';
  }
}

const preferNativeKey = 'seamind.youtube.preferNative';

export function readPreferNative(): boolean {
  try {
    return localStorage.getItem(preferNativeKey) === '1';
  } catch {
    return false;
  }
}

export function writePreferNative(value: boolean): void {
  try {
    localStorage.setItem(preferNativeKey, value ? '1' : '0');
  } catch {
    // The choice only lasts for this session when storage is unavailable.
  }
}

export function canOfferAlternativePlayback(
  state: YouTubePlaybackState,
): boolean {
  return (
    state === 'ready' ||
    state === 'paused' ||
    state === 'ended' ||
    state === 'error' ||
    state === 'timeout' ||
    state === 'stalled' ||
    state === 'external'
  );
}

export function loadYouTubeIframeApi(): Promise<YouTubeIframeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (window.__seamindYouTubeApiPromise)
    return window.__seamindYouTubeApiPromise;

  let apiScript = document.getElementById(
    'seamind-youtube-iframe-api',
  ) as HTMLScriptElement | null;
  let timeoutId = 0;
  const previousReadyCallback = window.onYouTubeIframeAPIReady;

  const promise = new Promise<YouTubeIframeApi>((resolve, reject) => {
    const fail = (reason: Error) => {
      window.clearTimeout(timeoutId);
      if (window.onYouTubeIframeAPIReady === onApiReady)
        window.onYouTubeIframeAPIReady = previousReadyCallback;
      apiScript?.remove();
      reject(reason);
    };
    const onApiReady = () => {
      const api = window.YT;
      if (!api?.Player) {
        fail(new Error('YouTube IFrame API did not initialize.'));
        return;
      }
      window.clearTimeout(timeoutId);
      if (window.onYouTubeIframeAPIReady === onApiReady)
        window.onYouTubeIframeAPIReady = previousReadyCallback;
      try {
        previousReadyCallback?.();
      } catch {
        // A host callback must not prevent the Seamind player from initializing.
      }
      resolve(api);
    };

    window.onYouTubeIframeAPIReady = onApiReady;
    timeoutId = window.setTimeout(
      () => fail(new Error('Timed out while loading YouTube IFrame API.')),
      12000,
    );

    if (!apiScript) {
      apiScript = document.createElement('script');
      apiScript.id = 'seamind-youtube-iframe-api';
      apiScript.src = 'https://www.youtube.com/iframe_api';
      apiScript.async = true;
    }
    apiScript.addEventListener(
      'error',
      () => fail(new Error('Failed to load YouTube IFrame API.')),
      { once: true },
    );
    if (!apiScript.isConnected) document.head.append(apiScript);
  });

  window.__seamindYouTubeApiPromise = promise;
  void promise.catch(() => {
    if (window.__seamindYouTubeApiPromise === promise)
      window.__seamindYouTubeApiPromise = undefined;
  });
  return promise;
}
