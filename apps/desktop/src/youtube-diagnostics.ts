import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { NativePlaybackError } from './youtube-native-errors';
import { resolveNativePlayback } from './youtube-native';
import type {
  YouTubePlaybackCapabilities,
  YouTubeSettings,
} from './youtube-player';
import { proxiedFetch } from './youtube-proxy';

/** A video that normally resolves, used to tell "this video is restricted" from "nothing works". */
export const referenceVideoId = 'dQw4w9WgXcQ';

export interface ConnectivityCheck {
  id: 'webview' | 'backend' | 'media' | 'video' | 'reference';
  label: string;
  ok: boolean;
  detail: string;
  milliseconds: number | null;
}

export interface YtDlpInstallResult {
  path: string;
  version: string;
  sha256: string;
}

export interface InstallProgress {
  downloaded: number;
  total: number | null;
}

export function fetchCapabilities(): Promise<YouTubePlaybackCapabilities> {
  return invoke<YouTubePlaybackCapabilities>('youtube_playback_capabilities');
}

export function fetchSettings(): Promise<YouTubeSettings> {
  return invoke<YouTubeSettings>('youtube_get_settings');
}

export function saveProxy(proxyUrl: string): Promise<YouTubeSettings> {
  return invoke<YouTubeSettings>('youtube_set_settings', {
    proxyUrl: proxyUrl.trim() || null,
  });
}

export async function installYtDlp(
  onProgress: (progress: InstallProgress) => void,
): Promise<YtDlpInstallResult> {
  const unlisten = await listen<InstallProgress>(
    'youtube-install-progress',
    (event) => onProgress(event.payload),
  );
  try {
    return await invoke<YtDlpInstallResult>('youtube_install_ytdlp');
  } finally {
    unlisten();
  }
}

async function timed<T>(
  action: () => Promise<T>,
): Promise<{ value: T | null; error: unknown; milliseconds: number }> {
  const started = performance.now();
  try {
    const value = await action();
    return { value, error: null, milliseconds: performance.now() - started };
  } catch (error) {
    return { value: null, error, milliseconds: performance.now() - started };
  }
}

function describeError(error: unknown): string {
  if (error instanceof NativePlaybackError)
    return error.detail ? `${error.message}（${error.detail}）` : error.message;
  return error instanceof Error ? error.message : String(error);
}

/** The embedded player's own network stack, which the iframe uses, not the app's Rust backend. */
function loadThumbnail(): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(
      () => reject(new Error('超过 10 秒')),
      10_000,
    );
    image.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('无法加载'));
    };
    image.referrerPolicy = 'no-referrer';
    image.src = `https://i.ytimg.com/vi/${referenceVideoId}/default.jpg?seamind=${Date.now()}`;
  });
}

async function reachability(
  id: 'backend' | 'media',
  label: string,
  url: string,
): Promise<ConnectivityCheck> {
  const result = await timed(async () => {
    const response = await proxiedFetch(url, { cache: 'no-store' });
    await response.body?.cancel();
    return response.status;
  });
  const status = result.value;
  return {
    id,
    label,
    ok: status !== null && status < 500,
    detail: status !== null ? `HTTP ${status}` : describeError(result.error),
    milliseconds: result.milliseconds,
  };
}

async function resolution(
  id: 'video' | 'reference',
  label: string,
  videoId: string,
  signal?: AbortSignal,
): Promise<ConnectivityCheck> {
  const result = await timed(() => resolveNativePlayback(videoId, { signal }));
  return result.value
    ? {
        id,
        label,
        ok: true,
        detail: `可以解析（${result.value.client} 客户端，最高 ${result.value.heights[0] ?? '—'}p）`,
        milliseconds: result.milliseconds,
      }
    : {
        id,
        label,
        ok: false,
        detail: describeError(result.error),
        milliseconds: result.milliseconds,
      };
}

/**
 * Checks each hop separately — the embedded WebView, the app backend, YouTube's media servers and
 * the stream resolver — so a failure points at the layer to fix. The reference video is only
 * resolved when the chosen one fails, to show whether it is that video or the whole connection.
 */
export async function runConnectivityChecks(
  videoId: string,
  signal?: AbortSignal,
): Promise<ConnectivityCheck[]> {
  const [webview, backend, media, video] = await Promise.all([
    timed(loadThumbnail),
    reachability(
      'backend',
      '应用后端 → YouTube',
      'https://www.youtube.com/generate_204',
    ),
    reachability(
      'media',
      '应用后端 → 视频服务器',
      'https://redirector.googlevideo.com/generate_204',
    ),
    resolution('video', '解析当前视频', videoId, signal),
  ]);
  const checks: ConnectivityCheck[] = [
    {
      id: 'webview',
      label: '内嵌播放器网络 → YouTube',
      ok: webview.error === null,
      detail:
        webview.error === null ? '可以访问' : describeError(webview.error),
      milliseconds: webview.milliseconds,
    },
    backend,
    media,
    video,
  ];
  if (!video.ok && videoId !== referenceVideoId)
    checks.push(
      await resolution('reference', '解析参考视频', referenceVideoId, signal),
    );
  return checks;
}
