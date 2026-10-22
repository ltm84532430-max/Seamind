import { useEffect, useRef, useState } from 'react';
import type { NativePlayerErrorKind } from './youtube-native-errors';
import { classifyShakaError } from './youtube-native-errors';
import type { NativePlayback } from './youtube-native';
import type { YouTubePlaybackState } from './youtube-player';
import {
  getYouTubeProxyEndpoint,
  isProxiedYouTubeUrl,
  isYouTubeDebugEnabled,
  toProxyUrl,
} from './youtube-proxy';

type Shaka =
  typeof import('shaka-player/dist/shaka-player.compiled.js').default;
type ShakaPlayer = InstanceType<Shaka['Player']>;
type ShakaTrack = ReturnType<ShakaPlayer['getVariantTracks']>[number];

export interface NativePlayerFailure {
  kind: NativePlayerErrorKind;
  message: string;
}

interface YouTubeNativePlayerProps {
  playback: NativePlayback;
  startSeconds: number;
  onState: (state: YouTubePlaybackState) => void;
  onFailure: (failure: NativePlayerFailure) => void;
  onTime?: (seconds: number) => void;
}

interface TrackChoices {
  heights: number[];
  audio: string[];
  text: { id: number; label: string }[];
  activeHeight: number | null;
  activeAudio: string | null;
  activeText: number | null;
}

const emptyChoices: TrackChoices = {
  heights: [],
  audio: [],
  text: [],
  activeHeight: null,
  activeAudio: null,
  activeText: null,
};

let shakaPromise: Promise<Shaka> | null = null;

function loadShaka(): Promise<Shaka> {
  shakaPromise ??= import('shaka-player/dist/shaka-player.compiled.js')
    .then(({ default: shaka }) => {
      shaka.polyfill.installAll();
      return shaka;
    })
    .catch((error: unknown) => {
      shakaPromise = null;
      throw error;
    });
  return shakaPromise;
}

function audioLabel(track: ShakaTrack): string {
  return track.label || track.language || 'default';
}

function bestVariant(
  tracks: ShakaTrack[],
  height: number | null,
  audio: string | null,
): ShakaTrack | undefined {
  return tracks
    .filter(
      (track) =>
        (height === null || track.height === height) &&
        (audio === null || audioLabel(track) === audio),
    )
    .sort((left, right) => right.bandwidth - left.bandwidth)[0];
}

function readChoices(player: ShakaPlayer): TrackChoices {
  const variants = player.getVariantTracks();
  const active = variants.find((track) => track.active);
  const textTracks = player.getTextTracks();
  return {
    heights: [
      ...new Set(
        variants
          .map((track) => track.height)
          .filter((height): height is number => Boolean(height)),
      ),
    ].sort((left, right) => right - left),
    audio: [...new Set(variants.map(audioLabel))],
    text: textTracks.map((track) => ({
      id: track.id,
      label: track.label || track.language || `字幕 ${track.id}`,
    })),
    activeHeight: active?.height ?? null,
    activeAudio: active ? audioLabel(active) : null,
    activeText: textTracks.find((track) => track.active)?.id ?? null,
  };
}

/**
 * Plays a resolved YouTube stream with Shaka. Requests for YouTube hosts are rewritten to the local
 * proxy, which supplies the headers YouTube expects and makes the responses readable by the page.
 */
export default function YouTubeNativePlayer({
  playback,
  startSeconds,
  onState,
  onFailure,
  onTime,
}: YouTubeNativePlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<ShakaPlayer | null>(null);
  const callbacks = useRef({ onState, onFailure, onTime });
  const initialStart = useRef(startSeconds);
  const [choices, setChoices] = useState<TrackChoices>(emptyChoices);
  const [manualHeight, setManualHeight] = useState<number | null>(null);

  useEffect(() => {
    callbacks.current = { onState, onFailure, onTime };
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let player: ShakaPlayer | null = null;

    const fail = (failure: NativePlayerFailure) => {
      if (cancelled) return;
      callbacks.current.onState('error');
      callbacks.current.onFailure(failure);
    };

    const videoEvents: [string, () => void][] = [
      ['playing', () => callbacks.current.onState('playing')],
      [
        'pause',
        () => {
          if (!video.ended) callbacks.current.onState('paused');
        },
      ],
      ['waiting', () => callbacks.current.onState('buffering')],
      ['ended', () => callbacks.current.onState('ended')],
      ['timeupdate', () => callbacks.current.onTime?.(video.currentTime)],
    ];
    for (const [name, listener] of videoEvents)
      video.addEventListener(name, listener);

    void (async () => {
      const [shaka, endpoint] = await Promise.all([
        loadShaka(),
        getYouTubeProxyEndpoint(),
      ]);
      if (cancelled) return;
      if (!shaka.Player.isBrowserSupported()) {
        fail({
          kind: 'unsupported',
          message: '当前 WebView 不支持 Media Source 播放。',
        });
        return;
      }

      player = new shaka.Player();
      playerRef.current = player;
      if (isYouTubeDebugEnabled())
        (
          window as unknown as { __seamindShakaPlayer?: ShakaPlayer }
        ).__seamindShakaPlayer = player;
      await player.attach(video);
      if (cancelled) return;

      // Shaka runs request filters again for every retry on the same request object, so rewriting
      // has to leave an address that already points at the proxy alone.
      const proxyPrefix = `${endpoint.origin}/fetch?`;
      player.getNetworkingEngine()?.registerRequestFilter((_type, request) => {
        request.uris = request.uris.map((uri) =>
          !uri.startsWith(proxyPrefix) && isProxiedYouTubeUrl(uri)
            ? toProxyUrl(endpoint, uri)
            : uri,
        );
        if (request.uris.some((uri) => uri.startsWith(proxyPrefix))) {
          request.headers['x-seamind-token'] = endpoint.token;
          if (playback.userAgent)
            request.headers['x-seamind-ua'] = playback.userAgent;
        }
        request.allowCrossSiteCredentials = false;
      });

      const retryParameters = {
        maxAttempts: 4,
        baseDelay: 500,
        backoffFactor: 2,
        fuzzFactor: 0.5,
        timeout: 30_000,
      };
      player.configure({
        streaming: {
          bufferingGoal: 90,
          rebufferingGoal: 2,
          bufferBehind: 120,
          retryParameters,
        },
        manifest: { retryParameters },
        // Start low and climb: behind a proxy the browser's own bandwidth hint is far too
        // optimistic, and a first segment that is too big costs more than starting small.
        abr: {
          enabled: true,
          defaultBandwidthEstimate: 700_000,
          useNetworkInformation: false,
          switchInterval: 4,
        },
      });

      const refreshChoices = () => {
        if (!cancelled && player) setChoices(readChoices(player));
      };
      player.addEventListener('error', (event) => {
        const detail = (
          event as unknown as {
            detail: {
              code: number;
              category: number;
              severity: number;
              data: unknown[];
            };
          }
        ).detail;
        // Captions failing must not stop the video, and shaka retries recoverable errors itself.
        if (
          detail.category === shaka.util.Error.Category.TEXT ||
          detail.severity === shaka.util.Error.Severity.RECOVERABLE
        )
          return;
        fail(classifyShakaError(detail));
      });
      player.addEventListener('buffering', (event) => {
        const buffering = (event as unknown as { buffering: boolean })
          .buffering;
        if (buffering) callbacks.current.onState('buffering');
        else if (!video.paused) callbacks.current.onState('playing');
      });
      for (const name of [
        'trackschanged',
        'variantchanged',
        'adaptation',
        'textchanged',
      ])
        player.addEventListener(name, refreshChoices);

      const source = playback.source;
      const uri =
        source.kind === 'dash'
          ? `data:application/dash+xml;charset=utf-8,${encodeURIComponent(source.manifest)}`
          : source.url;
      const mimeType =
        source.kind === 'dash'
          ? 'application/dash+xml'
          : 'application/x-mpegurl';
      const start = initialStart.current;
      await player.load(
        uri,
        start > 0 && !playback.live ? start : null,
        mimeType,
      );
      if (cancelled) return;
      callbacks.current.onState('ready');
      refreshChoices();
      void video.play().catch(() => {
        // Autoplay may be refused; the user can press play.
      });
    })().catch((error: unknown) => {
      const shakaError = error as { code?: number; data?: unknown[] };
      if (typeof shakaError.code === 'number')
        fail(
          classifyShakaError({ code: shakaError.code, data: shakaError.data }),
        );
      else
        fail({
          kind: 'unknown',
          message: `内置播放器初始化失败：${error instanceof Error ? error.message : String(error)}`,
        });
    });

    return () => {
      cancelled = true;
      for (const [name, listener] of videoEvents)
        video.removeEventListener(name, listener);
      playerRef.current = null;
      void player?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [playback]);

  const selectHeight = (value: string) => {
    const player = playerRef.current;
    if (!player) return;
    if (value === 'auto') {
      player.configure('abr.enabled', true);
      setManualHeight(null);
      return;
    }
    const height = Number(value);
    const track = bestVariant(
      player.getVariantTracks(),
      height,
      choices.activeAudio,
    );
    if (!track) return;
    player.configure('abr.enabled', false);
    player.selectVariantTrack(track, true);
    setManualHeight(height);
  };

  const selectAudio = (label: string) => {
    const player = playerRef.current;
    if (!player) return;
    const track = bestVariant(
      player.getVariantTracks(),
      manualHeight ?? choices.activeHeight,
      label,
    );
    if (track) player.selectVariantTrack(track, true);
  };

  const selectText = (value: string) => {
    const player = playerRef.current;
    if (!player) return;
    // Shaka 5 shows the selected text track and hides captions when given null.
    const track =
      value === 'off'
        ? null
        : player.getTextTracks().find((item) => String(item.id) === value);
    if (track === undefined) return;
    player.selectTextTrack(track);
    setChoices(readChoices(player));
  };

  const hasChoices =
    choices.heights.length > 1 ||
    choices.audio.length > 1 ||
    choices.text.length > 0;

  return (
    <>
      <video
        ref={videoRef}
        className="youtube-player-video"
        controls
        playsInline
      />
      {hasChoices && (
        <div className="youtube-native-toolbar">
          {choices.heights.length > 1 && (
            <label>
              <span>画质</span>
              <select
                value={manualHeight === null ? 'auto' : String(manualHeight)}
                onChange={(event) => selectHeight(event.target.value)}
              >
                <option value="auto">
                  自动
                  {choices.activeHeight ? `（${choices.activeHeight}p）` : ''}
                </option>
                {choices.heights.map((height) => (
                  <option key={height} value={height}>
                    {height}p
                  </option>
                ))}
              </select>
            </label>
          )}
          {choices.audio.length > 1 && (
            <label>
              <span>音轨</span>
              <select
                value={choices.activeAudio ?? ''}
                onChange={(event) => selectAudio(event.target.value)}
              >
                {choices.audio.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {choices.text.length > 0 && (
            <label>
              <span>字幕</span>
              <select
                value={
                  choices.activeText === null
                    ? 'off'
                    : String(choices.activeText)
                }
                onChange={(event) => selectText(event.target.value)}
              >
                <option value="off">关闭</option>
                {choices.text.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </>
  );
}
