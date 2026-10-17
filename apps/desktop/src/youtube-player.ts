export type YouTubePlaybackState =
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'error'
  | 'timeout';

export interface YouTubeIframePlayer {
  destroy(): void;
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
    ready: '已就绪',
    playing: '播放中',
    paused: '已暂停',
    buffering: '缓冲中',
    ended: '播放结束',
    error: '播放错误',
    timeout: '连接超时',
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
    case 153:
      return 'YouTube 未收到有效的来源标识。';
    default:
      return 'YouTube 播放器遇到问题。';
  }
}

export function canOfferAlternativePlayback(
  state: YouTubePlaybackState,
  errorCode: number | null,
): boolean {
  return (
    (state === 'error' || state === 'timeout') &&
    ![2, 100, 101, 150].includes(errorCode ?? -1)
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
