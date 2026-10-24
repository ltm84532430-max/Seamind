import { invoke } from '@tauri-apps/api/core';
import {
  classifyPlayability,
  isDefinitiveFailure,
  NativePlaybackError,
  pickFailure,
} from './youtube-native-errors';
import { proxiedFetch } from './youtube-proxy';
import { SabrStreamingAdapter } from 'googlevideo/sabr-streaming-adapter';
import { buildSabrFormat } from 'googlevideo/utils';
import {
  getPlaybackPoToken,
  loadYouTubeAttestationContext,
} from './youtube-botguard';
import { ShakaPlayerAdapter } from './youtube-sabr-shaka-adapter';

export type NativeClient =
  | 'WEB'
  | 'VISIONOS'
  | 'IOS'
  | 'ANDROID_VR'
  | 'ANDROID'
  | 'WEB_EMBEDDED';

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
  // The current WEB client returns SABR-only formats. Keep it last so direct native-client
  // formats remain the first choice, while still having the same web-token path FreeTube uses.
  'WEB',
];

const RESOLVE_TIMEOUT_MS = 45_000;

export interface NativePlayback {
  videoId: string;
  client: NativeClient;
  title: string;
  author: string;
  durationSeconds: number;
  live: boolean;
  source:
    | { kind: 'dash'; manifest: string }
    | { kind: 'hls'; url: string }
    | { kind: 'sabr'; manifest: string };
  /** In-memory context used if YouTube only provides SABR streams or direct URLs fail. */
  sabrSessionId?: string;
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

interface SabrSession {
  library: Library;
  innertube: any;
  info: any;
  client: NativeClient;
  videoId: string;
  expiresAt: number;
}

interface NativeClientConfig {
  NAME: string;
  VERSION: string;
  USER_AGENT?: string;
  OS_NAME?: string;
  OS_VERSION?: string;
}

const sabrSessions = new Map<string, SabrSession>();

let libraryPromise: Promise<Library> | null = null;

function getNativeClientConfig(library: Library, client: NativeClient) {
  return (
    library.Constants.CLIENTS as unknown as Record<string, NativeClientConfig>
  )[client];
}

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

function rememberSabrSession(session: SabrSession): string {
  for (const [key, value] of sabrSessions) {
    if (value.expiresAt <= Date.now()) sabrSessions.delete(key);
  }
  while (sabrSessions.size >= 12) {
    const oldest = sabrSessions.keys().next().value as string | undefined;
    if (!oldest) break;
    sabrSessions.delete(oldest);
  }
  const id = crypto.randomUUID();
  sabrSessions.set(id, session);
  return id;
}

async function getSabrManifest(session: SabrSession): Promise<string> {
  const manifest = await session.info.toDash({
    manifest_options: {
      is_sabr: true,
      captions_format: 'vtt',
      include_thumbnails: false,
    },
  });
  if (typeof manifest !== 'string' || !manifest.includes('<MPD'))
    throw new NativePlaybackError(
      'noStreams',
      'YouTube did not return a SABR manifest.',
    );
  return manifest;
}

async function decipherServerAbrUrl(session: SabrSession): Promise<string> {
  const encryptedUrl = session.info.streaming_data?.server_abr_streaming_url;
  if (!encryptedUrl)
    throw new NativePlaybackError('noStreams', 'SABR URL is missing.');

  let player = session.innertube.session.player;
  if (!player) {
    player = await createPlayer(session.library);
    session.innertube.session.player = player;
  }
  return player.decipher(encryptedUrl);
}

/** Prepares and attaches the official GoogleVideo SABR/UMP adapter to a Shaka player. */
export async function activateSabrPlayback(
  playback: NativePlayback,
  shakaPlayer: unknown,
) {
  const session = playback.sabrSessionId
    ? sabrSessions.get(playback.sabrSessionId)
    : undefined;
  if (!session || session.expiresAt <= Date.now())
    throw new NativePlaybackError(
      'expired',
      'SABR playback context has expired.',
    );

  const manifest =
    playback.source.kind === 'sabr'
      ? playback.source.manifest
      : await getSabrManifest(session);
  const client = session.innertube.session.context.client;
  const clientConfig = getNativeClientConfig(session.library, session.client);
  const clientName =
    clientConfig.NAME as keyof typeof session.library.Constants.CLIENT_NAME_IDS;
  const isAndroid =
    session.client === 'ANDROID' || session.client === 'ANDROID_VR';
  const clientInfo = {
    osName: clientConfig.OS_NAME ?? (isAndroid ? 'Android' : client.osName),
    osVersion:
      clientConfig.OS_VERSION ??
      (session.client === 'ANDROID'
        ? '13'
        : session.client === 'ANDROID_VR'
          ? '12L'
          : client.osVersion),
    clientName: Number(session.library.Constants.CLIENT_NAME_IDS[clientName]),
    clientVersion: clientConfig.VERSION,
  };
  const adapter = new SabrStreamingAdapter({
    playerAdapter: new ShakaPlayerAdapter(playback.userAgent),
    clientInfo,
  });
  const webClient =
    session.client === 'WEB' || session.client === 'WEB_EMBEDDED';
  // Web PO tokens are accepted only by web-based clients. Android/iOS require their own
  // attestation token providers, so do not send a Web token with those clients.
  if (webClient)
    adapter.onMintPoToken(() => getPlaybackPoToken(session.videoId, true));
  adapter.onReloadPlayerResponse(async (reloadPlaybackContext) => {
    const poToken = webClient
      ? await getPlaybackPoToken(session.videoId, true)
      : undefined;
    const response = await session.innertube.actions.execute('/player', {
      videoId: session.videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      client: session.client,
      ...(poToken ? { serviceIntegrityDimensions: { poToken } } : {}),
      playbackContext: {
        adPlaybackContext: { pyv: true },
        contentPlaybackContext: {
          signatureTimestamp:
            session.innertube.session.player?.signature_timestamp,
        },
        reloadPlaybackContext,
      },
    });
    const reloadedInfo = new (session.library as any).YT.VideoInfo(
      [response],
      session.innertube.actions,
      session.library.Utils.generateRandomString(16),
    );
    session.info = reloadedInfo;
    adapter.setStreamingURL(await decipherServerAbrUrl(session));
    adapter.setUstreamerConfig(
      reloadedInfo.player_config?.media_common_config
        ?.media_ustreamer_request_config?.video_playback_ustreamer_config,
    );
    adapter.setServerAbrFormats(
      reloadedInfo.streaming_data?.adaptive_formats
        ?.filter(
          (format: Format) => !format.drm_families && !format.drm_track_type,
        )
        .map((format: Format) => buildSabrFormat(format)) ?? [],
    );
  });
  adapter.attach(shakaPlayer);
  adapter.setStreamingURL(await decipherServerAbrUrl(session));
  adapter.setUstreamerConfig(
    session.info.player_config?.media_common_config
      ?.media_ustreamer_request_config?.video_playback_ustreamer_config,
  );
  adapter.setServerAbrFormats(
    session.info.streaming_data?.adaptive_formats
      ?.filter(
        (format: Format) => !format.drm_families && !format.drm_track_type,
      )
      .map((format: Format) => buildSabrFormat(format)) ?? [],
  );
  return { adapter, manifest };
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

function clientFailureDetail(
  client: NativeClient,
  failure: NativePlaybackError,
): string {
  const prefix = `${client}: `;
  const rawDetail = failure.detail ?? failure.message;
  const detail = (
    rawDetail.startsWith(prefix) ? rawDetail.slice(prefix.length) : rawDetail
  )
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 180);
  return `${client} ${failure.code}: ${detail}`;
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
  server_abr_streaming_url?: string;
}): number {
  if (streaming.expires instanceof Date && !Number.isNaN(+streaming.expires))
    return streaming.expires.getTime();
  const sample =
    streaming.adaptive_formats.find((format) => format.url)?.url ??
    streaming.server_abr_streaming_url;
  const expire = sample ? new URL(sample).searchParams.get('expire') : null;
  return expire && Number(expire) > 0
    ? Number(expire) * 1000
    : Date.now() + 5 * 60 * 60 * 1000;
}

async function decipherManifestUrl(
  player: Awaited<ReturnType<Library['Player']['create']>>,
  value: string,
  poToken: string | undefined,
  isDash: boolean,
): Promise<string> {
  const url = new URL(value);
  if (url.searchParams.size > 0) {
    if (poToken) url.searchParams.set('pot', poToken);
    if (isDash) url.searchParams.set('mpd_version', '7');
    return player.decipher(url.toString());
  }

  const prefix = isDash ? '/api/manifest/dash' : '/api/manifest/hls_variant';
  if (!url.pathname.startsWith(prefix)) {
    if (poToken) url.searchParams.set('pot', poToken);
    return player.decipher(url.toString());
  }

  const pathParams = url.pathname
    .slice(prefix.length)
    .split('/')
    .filter(Boolean);
  url.pathname = prefix;
  for (let index = 0; index + 1 < pathParams.length; index += 2) {
    url.searchParams.set(
      decodeURIComponent(pathParams[index]),
      decodeURIComponent(pathParams[index + 1]),
    );
  }
  const deciphered = new URL(await player.decipher(url.toString()));
  for (const [name, parameter] of deciphered.searchParams)
    deciphered.pathname += `/${name}/${encodeURIComponent(parameter)}`;
  deciphered.search = '';
  if (poToken) deciphered.pathname += `/pot/${encodeURIComponent(poToken)}`;
  if (isDash) deciphered.pathname += '/mpd_version/7';
  return deciphered.toString();
}

async function resolveWithClient(
  library: Library,
  client: NativeClient,
  videoId: string,
  signal: AbortSignal,
  visitorData?: string,
  onVisitorData?: (value: string) => void,
): Promise<NativePlayback> {
  let resolutionActive = true;
  const fetchThroughProxy: typeof fetch = (input, init) =>
    proxiedFetch(input, {
      ...init,
      signal: resolutionActive
        ? init?.signal
          ? AbortSignal.any([signal, init.signal])
          : signal
        : init?.signal,
    });
  const clientConfig = getNativeClientConfig(library, client);
  const innertube = await library.Innertube.create({
    fetch: fetchThroughProxy,
    cache: new PlayerCache(),
    retrieve_player: false,
    generate_session_locally: true,
    enable_session_cache: false,
    // The only config request in local-session mode uses global fetch instead of this proxy.
    // Local context already supplies the client defaults, so avoid a CSP-blocked direct request.
    retrieve_innertube_config: false,
    client_type: clientConfig.NAME as NonNullable<
      NonNullable<Parameters<typeof library.Innertube.create>[0]>['client_type']
    >,
    user_agent: clientConfig.USER_AGENT,
    visitor_data: visitorData,
    lang: 'en',
  });
  const issuedVisitorData = innertube.session.context.client.visitorData;
  if (issuedVisitorData) onVisitorData?.(issuedVisitorData);

  let poToken: string | undefined;
  if (client === 'WEB' || client === 'WEB_EMBEDDED') {
    // Use the page's own ytcfg and ytAtN challenge when available. If YouTube blocks the watch
    // page, the BotGuard helper can still try its InnerTube/WAA challenge fallback.
    let attestation;
    try {
      attestation = await loadYouTubeAttestationContext(videoId, signal);
    } catch (error) {
      console.warn(
        '[YouTube PO token] Page attestation context unavailable:',
        error,
      );
    }
    if (client === 'WEB' && attestation) {
      const session = innertube.session as unknown as {
        context: Record<string, any>;
        api_key: string;
        api_version: string;
        user_agent: string;
      };
      Object.assign(session.context, attestation.context);
      const apiKey = attestation.ytConfig.INNERTUBE_API_KEY;
      const apiVersion = attestation.ytConfig.INNERTUBE_API_VERSION;
      if (typeof apiKey === 'string' && apiKey) session.api_key = apiKey;
      if (typeof apiVersion === 'string' && apiVersion)
        session.api_version = apiVersion;
      session.user_agent =
        attestation.context.client.userAgent ?? session.user_agent;
      const pageVisitorData = attestation.context.client.visitorData;
      if (typeof pageVisitorData === 'string' && pageVisitorData)
        onVisitorData?.(pageVisitorData);
    }

    // WEB_EMBEDDED uses the same content-bound token requirements for age-gated videos.
    innertube.session.player = await createPlayer(library, signal);
    signal.throwIfAborted();
    try {
      poToken = await getPlaybackPoToken(videoId, true, attestation);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new NativePlaybackError(
        'botCheck',
        `BotGuard could not mint the required content PO token: ${detail}`,
      );
    }
    signal.throwIfAborted();
  }
  const info = await innertube.getBasicInfo(videoId, {
    client,
    ...(poToken ? { po_token: poToken } : {}),
  });
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
    innertube.session.context.client.userAgent ??
    clientConfig.USER_AGENT ??
    innertube.session.user_agent ??
    null;
  const common = {
    videoId,
    client,
    title: info.basic_info.title ?? '',
    author: info.basic_info.author ?? '',
    durationSeconds: info.basic_info.duration ?? 0,
    live,
    userAgent,
  };

  if (!streaming) throw new NativePlaybackError('noStreams', client);

  if (streaming && live && streaming.hls_manifest_url) {
    let player = innertube.session.player;
    if (!player) {
      player = await createPlayer(library, signal);
      innertube.session.player = player;
    }
    signal.throwIfAborted();
    const manifest = await decipherManifestUrl(
      player,
      streaming.hls_manifest_url,
      poToken,
      false,
    );
    signal.throwIfAborted();
    resolutionActive = false;
    return {
      ...common,
      source: { kind: 'hls', url: manifest },
      expiresAt: expiryOf({ ...streaming, adaptive_formats: adaptive }),
      heights: [],
    };
  }
  const sabrFormats = streaming.adaptive_formats.filter(
    (format) => !format.drm_families && !format.drm_track_type,
  );
  const canUseSabr =
    Boolean(streaming.server_abr_streaming_url) && sabrFormats.length > 0;
  if (adaptive.length === 0) {
    if (!canUseSabr) throw new NativePlaybackError('noStreams', client);
    const session: SabrSession = {
      library,
      innertube,
      info,
      client,
      videoId,
      expiresAt: expiryOf({ ...streaming, adaptive_formats: sabrFormats }),
    };
    const sabrSessionId = rememberSabrSession(session);
    try {
      const playback: NativePlayback = {
        ...common,
        source: { kind: 'sabr', manifest: await getSabrManifest(session) },
        sabrSessionId,
        expiresAt: session.expiresAt,
        heights: [
          ...new Set(
            sabrFormats
              .filter((format) => format.has_video && format.height)
              .map((format) => format.height as number),
          ),
        ].sort((left, right) => right - left),
      };
      resolutionActive = false;
      return playback;
    } catch (error) {
      sabrSessions.delete(sabrSessionId);
      throw error;
    }
  }

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
  const sabrSessionId = canUseSabr
    ? rememberSabrSession({
        library,
        innertube,
        info,
        client,
        videoId,
        expiresAt: expiryOf({ ...streaming, adaptive_formats: sabrFormats }),
      })
    : undefined;

  resolutionActive = false;
  return {
    ...common,
    source: { kind: 'dash', manifest },
    sabrSessionId,
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
  const clientFailures: string[] = [];
  const clients = options.clients ?? defaultNativeClients;
  let visitorData: string | undefined;
  let webAttempted = false;
  let webEmbeddedAttempted = false;
  let sabrCandidate: NativePlayback | null = null;
  for (const client of clients) {
    signal.throwIfAborted();
    if (client === 'WEB') webAttempted = true;
    if (client === 'WEB_EMBEDDED') webEmbeddedAttempted = true;
    try {
      const playback = await resolveWithClient(
        library,
        client,
        videoId,
        signal,
        visitorData,
        (value) => {
          visitorData ??= value;
        },
      );
      if (playback.source.kind === 'sabr') {
        if (client === 'WEB' || !sabrCandidate) sabrCandidate = playback;
        continue;
      }
      return playback;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = normalizeError(error);
      failures.push(failure);
      clientFailures.push(clientFailureDetail(client, failure));
      if (isDefinitiveFailure(failure.code)) break;
      if (timeout.aborted) break;
    }
  }
  if (
    failures.some((failure) => failure.code === 'ageRestricted') &&
    !webEmbeddedAttempted &&
    !signal.aborted
  ) {
    webEmbeddedAttempted = true;
    try {
      return await resolveWithClient(
        library,
        'WEB_EMBEDDED',
        videoId,
        signal,
        visitorData,
        (value) => {
          visitorData ??= value;
        },
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = normalizeError(error);
      failures.push(failure);
      clientFailures.push(clientFailureDetail('WEB_EMBEDDED', failure));
    }
  }
  if (
    failures.some((failure) => failure.code === 'ageRestricted') &&
    !webAttempted &&
    (!options.clients || options.clients.includes('WEB')) &&
    !signal.aborted
  ) {
    try {
      const playback = await resolveWithClient(
        library,
        'WEB',
        videoId,
        signal,
        visitorData,
        (value) => {
          visitorData ??= value;
        },
      );
      if (playback.source.kind !== 'sabr') return playback;
      sabrCandidate = playback;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = normalizeError(error);
      failures.push(failure);
      clientFailures.push(clientFailureDetail('WEB', failure));
    }
  }
  if (sabrCandidate) return sabrCandidate;
  const selected = pickFailure(failures);
  if (clientFailures.length === 0) throw selected;
  throw new NativePlaybackError(
    selected.code,
    `客户端尝试：${clientFailures.join('；').slice(0, 680)}`,
  );
}

export function isPlaybackExpired(
  playback: NativePlayback,
  marginMs = 60_000,
): boolean {
  return Date.now() > playback.expiresAt - marginMs;
}
