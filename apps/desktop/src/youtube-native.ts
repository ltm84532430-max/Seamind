import { invoke } from '@tauri-apps/api/core';
import {
  classifyPlayability,
  isDefinitiveFailure,
  NativePlaybackError,
  pickFailure,
} from './youtube-native-errors';
import { proxiedFetch } from './youtube-proxy';

export type NativeClient = 'VISIONOS' | 'IOS' | 'ANDROID_VR' | 'ANDROID';

/**
 * InnerTube clients that, as of yt-dlp's October 2026 client table, return googlevideo addresses
 * without a PO token. visionOS and iOS need no JavaScript player; Android's ciphered formats do, so
 * it goes last. YouTube retires these every few months — keep this list in step with yt-dlp.
 */
export const defaultNativeClients: NativeClient[] = [
  'VISIONOS',
  'IOS',
  'ANDROID_VR',
  'ANDROID',
];

const RESOLVE_TIMEOUT_MS = 45_000;
const MAX_BOT_CHECKS = 2;

export interface NativePlayback {
  videoId: string;
  client: NativeClient;
  title: string;
  author: string;
  durationSeconds: number;
  live: boolean;
  source: { kind: 'dash'; manifest: string } | { kind: 'hls'; url: string };
  /** The user agent the media servers saw when the addresses were issued. */
  userAgent: string | null;
  /** Epoch milliseconds after which the signed addresses stop working. */
  expiresAt: number;
  /** Available video heights, tallest first. */
  heights: number[];
}

export interface ResolveNativeOptions {
  signal?: AbortSignal;
  clients?: NativeClient[];
}

export type Library = typeof import('youtubei.js/web.bundle');
type Format = InstanceType<Library['Misc']['Format']>;

let libraryPromise: Promise<Library> | null = null;

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToBuffer(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/** Keeps YouTube.js' processed player script on disk, keyed by player version. */
class PlayerCache {
  /** Required by YouTube.js' cache interface; the Rust side picks the directory. */
  readonly cache_dir = '';

  async get(key: string): Promise<ArrayBuffer | undefined> {
    const text = await invoke<string | null>('youtube_player_cache_get', {
      key,
    });
    return text ? base64ToBuffer(text) : undefined;
  }

  async set(key: string, value: ArrayBuffer): Promise<void> {
    await invoke('youtube_player_cache_set', {
      key,
      value: bufferToBase64(value),
    });
  }

  async remove(): Promise<void> {
    // Entries are pruned by count on the Rust side.
  }
}

/** The YouTube.js bundle, loaded once and set up to run its player script in the Rust sandbox. */
export function loadYouTubeLibrary(): Promise<Library> {
  return loadLibrary();
}

function loadLibrary(): Promise<Library> {
  libraryPromise ??= import('youtubei.js/web.bundle')
    .then((library) => {
      // The deciphering script is Google's code; it runs in a QuickJS sandbox on the Rust side.
      library.Platform.shim.eval = async (data) =>
        JSON.parse(
          await invoke<string>('youtube_eval_script', { script: data.output }),
        );
      return library;
    })
    .catch((error: unknown) => {
      libraryPromise = null;
      throw error;
    });
  return libraryPromise;
}

/** The player script of YouTube's current web player, processed by YouTube.js and cached on disk. */
function createPlayer(library: Library, signal?: AbortSignal) {
  return library.Player.create(new PlayerCache(), (input, init) =>
    proxiedFetch(input, { ...init, signal }),
  );
}

/**
 * Deciphers an address with the current player script (the `n` parameter and signature cipher
 * YouTube.js knows how to undo). None of the clients Seamind uses needs this today; it is what a TV
 * or web client would go through, and what the end-to-end check exercises.
 */
export async function decipherUrl(
  url: string,
): Promise<{ playerId: string; url: string }> {
  const player = await createPlayer(await loadLibrary());
  return { playerId: player.player_id, url: await player.decipher(url) };
}

function normalizeError(error: unknown): NativePlaybackError {
  if (error instanceof NativePlaybackError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return new NativePlaybackError('network', '解析超过 45 秒。');
  const message = error instanceof Error ? error.message : String(error);
  if (
    /status code (401|403|502|504)|failed to fetch|networkerror|load failed/i.test(
      message,
    )
  )
    return new NativePlaybackError('network', message);
  return new NativePlaybackError('unknown', message);
}

function subreasonOf(playability: unknown): {
  subreason?: string;
  offerId?: string;
} {
  const screen = (
    playability as
      | {
          error_screen?: {
            subreason?: { text?: string };
            offer_id?: string;
          };
        }
      | undefined
  )?.error_screen;
  return { subreason: screen?.subreason?.text, offerId: screen?.offer_id };
}

function expiryOf(streaming: {
  expires?: Date;
  adaptive_formats: { url?: string }[];
}): number {
  if (streaming.expires instanceof Date && !Number.isNaN(+streaming.expires))
    return streaming.expires.getTime();
  const sample = streaming.adaptive_formats.find((format) => format.url)?.url;
  const expire = sample ? new URL(sample).searchParams.get('expire') : null;
  return expire && Number(expire) > 0
    ? Number(expire) * 1000
    : Date.now() + 5 * 60 * 60 * 1000;
}

async function resolveWithClient(
  library: Library,
  client: NativeClient,
  videoId: string,
  signal: AbortSignal,
): Promise<NativePlayback> {
  const fetchThroughProxy: typeof fetch = (input, init) =>
    proxiedFetch(input, { ...init, signal });
  const innertube = await library.Innertube.create({
    fetch: fetchThroughProxy,
    cache: new PlayerCache(),
    retrieve_player: false,
    generate_session_locally: true,
    enable_session_cache: false,
    lang: 'en',
  });

  const info = await innertube.getBasicInfo(videoId, { client });
  signal.throwIfAborted();

  const playability = info.playability_status;
  const failure = classifyPlayability({
    status: playability?.status,
    reason: playability?.reason,
    ...subreasonOf(playability),
  });
  if (failure)
    throw new NativePlaybackError(
      failure,
      `${client}: ${playability?.status ?? ''} ${playability?.reason ?? ''}`.trim(),
    );

  const streaming = info.streaming_data;
  const live = Boolean(
    info.basic_info.is_live || info.basic_info.is_post_live_dvr,
  );
  // YouTube sometimes serves a client formats with neither an address nor a signature cipher (a
  // SABR-only session); there is nothing to download or decipher for those.
  const unusable = (format: Format) =>
    Boolean(format.drm_families || format.drm_track_type) ||
    !(format.url || format.signature_cipher || format.cipher);
  const adaptive = (streaming?.adaptive_formats ?? []).filter(
    (format) => !unusable(format),
  );
  const userAgent =
    (library.Constants.CLIENTS as Record<string, { USER_AGENT?: string }>)[
      client
    ]?.USER_AGENT ?? null;
  const common = {
    videoId,
    client,
    title: info.basic_info.title ?? '',
    author: info.basic_info.author ?? '',
    durationSeconds: info.basic_info.duration ?? 0,
    live,
    userAgent,
  };

  if (streaming && live && streaming.hls_manifest_url) {
    return {
      ...common,
      source: { kind: 'hls', url: streaming.hls_manifest_url },
      expiresAt: expiryOf({ ...streaming, adaptive_formats: adaptive }),
      heights: [],
    };
  }
  if (!streaming || adaptive.length === 0)
    throw new NativePlaybackError('noStreams', client);

  const needsPlayer = adaptive.some(
    (format) =>
      !format.url || (format.url && new URL(format.url).searchParams.has('n')),
  );
  if (needsPlayer) {
    innertube.session.player = await createPlayer(library, signal);
    signal.throwIfAborted();
  }

  const manifest = await info.toDash({
    // YouTube.js drops a format when this returns true.
    format_filter: unusable,
    manifest_options: { captions_format: 'vtt' },
  });
  signal.throwIfAborted();

  const heights = [
    ...new Set(
      adaptive
        .filter((format) => format.has_video && format.height)
        .map((format) => format.height as number),
    ),
  ].sort((left, right) => right - left);

  return {
    ...common,
    source: { kind: 'dash', manifest },
    expiresAt: expiryOf({ ...streaming, adaptive_formats: adaptive }),
    heights,
  };
}

/**
 * Asks YouTube for a playable stream the way a TV or phone app does and returns it in a form the
 * built-in player can load. Failures carry a classified reason so the UI can explain them.
 */
export async function resolveNativePlayback(
  videoId: string,
  options: ResolveNativeOptions = {},
): Promise<NativePlayback> {
  const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  const library = await loadLibrary();
  const failures: NativePlaybackError[] = [];
  let botChecks = 0;
  for (const client of options.clients ?? defaultNativeClients) {
    signal.throwIfAborted();
    try {
      return await resolveWithClient(library, client, videoId, signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = normalizeError(error);
      failures.push(failure);
      if (isDefinitiveFailure(failure.code)) break;
      if (failure.code === 'botCheck' && ++botChecks >= MAX_BOT_CHECKS) break;
      if (timeout.aborted) break;
    }
  }
  throw pickFailure(failures);
}

export function isPlaybackExpired(
  playback: NativePlayback,
  marginMs = 60_000,
): boolean {
  return Date.now() > playback.expiresAt - marginMs;
}
