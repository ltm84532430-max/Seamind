import { resolveNativeTranscriptInfo } from '../../youtube-native';
import { NativePlaybackError } from '../../youtube-native-errors';
import { proxiedFetch } from '../../youtube-proxy';
import { alignBilingualCues, parseYouTubeCaptionResponse } from './parser';
import type {
  TranscriptCue,
  TranscriptResult,
  TranscriptTrack,
  TranscriptTranslationLanguage,
} from './types';

const CACHE_PREFIX = 'seamind:transcript:v2:';
const LEGACY_CACHE_PREFIX = 'seamind:transcript:v1:';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TRACK_CATALOG_TTL_MS = 3 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 55_000;

export type TranscriptFetchErrorCode =
  | 'transcriptsDisabled'
  | 'languageUnavailable'
  | 'trackUnavailable'
  | 'requestBlocked'
  | 'rateLimited'
  | 'poTokenRequired'
  | 'ageRestricted'
  | 'videoUnavailable'
  | 'network'
  | 'timeout'
  | 'http'
  | 'parse'
  | 'unknown';

export class TranscriptFetchError extends Error {
  constructor(
    readonly code: TranscriptFetchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TranscriptFetchError';
  }
}

export interface FetchTranscriptOptions {
  signal?: AbortSignal;
  trackId?: string;
  translationLang?: string;
  forceRefresh?: boolean;
}

interface DiscoveredTrack extends TranscriptTrack {
  baseUrl: string;
}

interface TrackCatalog {
  createdAt: number;
  tracks: DiscoveredTrack[];
  translationLanguages: TranscriptTranslationLanguage[];
  poToken?: string;
}

interface TranscriptCacheEntry {
  schema: 2;
  savedAt: number;
  result: TranscriptResult;
}

interface InFlightRequest {
  controller: AbortController;
  promise: Promise<TranscriptResult>;
  subscribers: number;
  settled: boolean;
}

const trackCatalogs = new Map<string, TrackCatalog>();
const inFlightRequests = new Map<string, InFlightRequest>();

function cacheKey(
  videoId: string,
  preferredLang: string,
  trackId?: string,
  translationLang = preferredLang,
): string {
  return `${CACHE_PREFIX}${encodeURIComponent(videoId)}:${encodeURIComponent(
    preferredLang,
  )}:${encodeURIComponent(trackId ?? 'auto')}:${encodeURIComponent(translationLang)}`;
}

function readCache(key: string): TranscriptResult | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as TranscriptCacheEntry;
    if (
      cached?.schema === 2 &&
      Date.now() - cached.savedAt <= CACHE_TTL_MS &&
      Array.isArray(cached.result?.cues) &&
      cached.result.cues.length > 0
    )
      return cached.result;
    localStorage.removeItem(key);
  } catch {
    // A bad or unavailable local cache must not prevent fetching captions.
  }
  return null;
}

function writeCache(key: string, result: TranscriptResult): void {
  if (result.cues.length === 0) return;
  try {
    const value: TranscriptCacheEntry = {
      schema: 2,
      savedAt: Date.now(),
      result,
    };
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota and private-browsing storage errors.
  }
}

export function clearTranscriptCache(videoId: string): void {
  trackCatalogs.delete(videoId);
  try {
    localStorage.removeItem(`${LEGACY_CACHE_PREFIX}${videoId}`);
    const prefix = `${CACHE_PREFIX}${encodeURIComponent(videoId)}:`;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // A storage failure should not block a retry.
  }
}

function textFromName(value: any, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value?.simple_text === 'string') return value.simple_text;
  if (typeof value?.simpleText === 'string') return value.simpleText;
  if (typeof value?.text === 'string') return value.text;
  if (Array.isArray(value?.runs))
    return value.runs.map((run: any) => run?.text ?? '').join('') || fallback;
  return fallback;
}

function normalizeTrack(raw: any, index: number): DiscoveredTrack | null {
  const baseUrl = raw?.base_url ?? raw?.baseUrl;
  if (typeof baseUrl !== 'string' || !baseUrl) return null;

  const languageCode = String(raw.language_code ?? raw.languageCode ?? 'und');
  const isGenerated = raw.kind === 'asr' || Boolean(raw.is_generated);
  const kindId = isGenerated ? 'auto' : 'manual';
  const stableId = String(raw.vss_id ?? raw.id ?? index).replace(
    /[^\w.-]/g,
    '_',
  );

  return {
    id: `youtube:${languageCode}:${kindId}:${stableId}`,
    baseUrl,
    languageCode,
    name: textFromName(raw.name, languageCode),
    isTranslatable: Boolean(raw.is_translatable ?? raw.isTranslatable),
    isGenerated,
    isDefault: Boolean(raw.is_default ?? raw.isDefault),
  };
}

function rememberTrackCatalog(
  videoId: string,
  tracks: DiscoveredTrack[],
  translationLanguages: TranscriptTranslationLanguage[],
  poToken?: string,
): TrackCatalog {
  trackCatalogs.delete(videoId);
  const catalog = {
    createdAt: Date.now(),
    tracks,
    translationLanguages,
    poToken,
  };
  trackCatalogs.set(videoId, catalog);
  while (trackCatalogs.size > 24) {
    const oldest = trackCatalogs.keys().next().value as string | undefined;
    if (!oldest) break;
    trackCatalogs.delete(oldest);
  }
  return catalog;
}

async function discoverTracks(
  videoId: string,
  signal: AbortSignal,
  forceRefresh: boolean,
): Promise<TrackCatalog> {
  const cached = trackCatalogs.get(videoId);
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.createdAt <= TRACK_CATALOG_TTL_MS
  )
    return cached;

  const { info, poToken } = await resolveNativeTranscriptInfo(videoId, {
    signal,
  });
  signal.throwIfAborted();
  const rawTracks = info?.captions?.caption_tracks;
  const tracks = Array.isArray(rawTracks)
    ? rawTracks
        .map((track: any, index: number) => normalizeTrack(track, index))
        .filter((track: DiscoveredTrack | null): track is DiscoveredTrack =>
          Boolean(track),
        )
    : [];
  const rawLanguages = info?.captions?.translation_languages;
  const translationLanguages: TranscriptTranslationLanguage[] = Array.isArray(
    rawLanguages,
  )
    ? rawLanguages
        .map((language: any) => {
          const languageCode = String(
            language?.language_code ?? language?.languageCode ?? '',
          );
          if (!languageCode) return null;
          const name = textFromName(
            language?.language_name ?? language?.languageName ?? language?.name,
            languageCode,
          );
          return { languageCode, name };
        })
        .filter(
          (
            language: TranscriptTranslationLanguage | null,
          ): language is TranscriptTranslationLanguage => Boolean(language),
        )
    : [];
  return rememberTrackCatalog(videoId, tracks, translationLanguages, poToken);
}

function languageRank(languageCode: string, preferredLang: string): number {
  const normalize = (value: string) => value.replace(/_/g, '-').toLowerCase();
  const code = normalize(languageCode);
  const preferred = normalize(preferredLang);
  if (code === preferred) return 0;
  if (code.split('-')[0] === preferred.split('-')[0]) return 1;
  if (code.split('-')[0] === 'en') return 2;
  return 3;
}

function chooseTrack(
  tracks: DiscoveredTrack[],
  preferredLang: string,
  requestedTrackId?: string,
): DiscoveredTrack {
  if (requestedTrackId) {
    const selected = tracks.find((track) => track.id === requestedTrackId);
    if (!selected)
      throw new TranscriptFetchError(
        'trackUnavailable',
        '所选字幕轨道已不可用，请重新选择字幕语言。',
      );
    return selected;
  }

  const [selected] = [...tracks].sort((left, right) => {
    const languageDifference =
      languageRank(left.languageCode, preferredLang) -
      languageRank(right.languageCode, preferredLang);
    if (languageDifference !== 0) return languageDifference;
    if (left.isGenerated !== right.isGenerated)
      return left.isGenerated ? 1 : -1;
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
  if (!selected)
    throw new TranscriptFetchError(
      'transcriptsDisabled',
      '这个视频没有可用的 YouTube 字幕轨道。',
    );
  return selected;
}

function makeTrackUrlCandidates(
  baseUrl: string,
  poToken?: string,
  translatedTo?: string,
): string[] {
  let source: URL;
  try {
    source = new URL(baseUrl);
  } catch {
    throw new TranscriptFetchError('parse', 'YouTube 返回了无效的字幕地址。');
  }

  if (source.searchParams.get('exp') === 'xpe' && !poToken)
    throw new TranscriptFetchError(
      'poTokenRequired',
      'YouTube 要求 PO Token 才能读取这个字幕轨道。',
    );
  if (source.searchParams.get('exp') === 'xpe' && poToken)
    source.searchParams.set('pot', poToken);

  const originalFormat = source.searchParams.get('fmt');
  if (originalFormat === 'srv3') source.searchParams.delete('fmt');
  if (translatedTo) source.searchParams.set('tlang', translatedTo);
  else source.searchParams.delete('tlang');

  const defaultFormatUrl = source.toString();
  const json3Url = new URL(defaultFormatUrl);
  json3Url.searchParams.set('fmt', 'json3');
  const json3 = json3Url.toString();
  const candidates =
    originalFormat === 'json3'
      ? [json3, defaultFormatUrl]
      : [defaultFormatUrl, json3];
  return [...new Set(candidates)];
}

function classifyHttpFailure(
  status: number,
  url: string,
): TranscriptFetchError {
  if (status === 429)
    return new TranscriptFetchError(
      'rateLimited',
      'YouTube 限制了字幕请求频率（HTTP 429），请稍后再试。',
      status,
    );
  if (status === 401 || status === 403) {
    const tokenRequired = new URL(url).searchParams.get('exp') === 'xpe';
    return new TranscriptFetchError(
      tokenRequired ? 'poTokenRequired' : 'requestBlocked',
      tokenRequired
        ? 'YouTube 要求 PO Token 才能读取这个字幕轨道。'
        : 'YouTube 拒绝了字幕请求，可能需要验证或当前网络出口受限。',
      status,
    );
  }
  if (status === 404 || status === 410)
    return new TranscriptFetchError(
      'trackUnavailable',
      '字幕轨道地址已失效，请刷新后重试。',
      status,
    );
  if (status >= 500)
    return new TranscriptFetchError(
      'network',
      `YouTube 字幕服务暂时不可用（HTTP ${status}）。`,
      status,
    );
  return new TranscriptFetchError(
    'http',
    `YouTube 字幕请求失败（HTTP ${status}）。`,
    status,
  );
}

function isRetryableFormatError(error: unknown): boolean {
  return error instanceof TranscriptFetchError && error.code === 'parse';
}

async function fetchCuesFromBaseUrl(
  baseUrl: string,
  signal: AbortSignal,
  poToken?: string,
  translatedTo?: string,
): Promise<TranscriptCue[]> {
  const urls = makeTrackUrlCandidates(baseUrl, poToken, translatedTo);
  let lastFormatError: TranscriptFetchError | null = null;

  for (const url of urls) {
    signal.throwIfAborted();
    const response = await proxiedFetch(url, { signal });
    if (!response.ok) {
      if (response.status === 400) {
        lastFormatError = new TranscriptFetchError(
          'parse',
          'YouTube 不接受当前字幕格式请求。',
          response.status,
        );
        continue;
      }
      throw classifyHttpFailure(response.status, url);
    }

    const body = await response.text();
    if (/sign in to confirm|not a bot|botguard|unusual traffic/i.test(body))
      throw new TranscriptFetchError(
        'requestBlocked',
        'YouTube 要求验证访问请求，字幕暂时无法读取。',
      );

    try {
      return parseYouTubeCaptionResponse(body);
    } catch (error) {
      lastFormatError = new TranscriptFetchError(
        'parse',
        error instanceof Error
          ? error.message
          : '无法识别 YouTube 返回的字幕格式。',
      );
      if (!isRetryableFormatError(lastFormatError)) throw lastFormatError;
    }
  }

  throw (
    lastFormatError ??
    new TranscriptFetchError('parse', 'YouTube 返回了无法识别的字幕格式。')
  );
}

function sameLanguage(left: string, right: string): boolean {
  const baseLanguage = (value: string) =>
    value.replace(/_/g, '-').split('-')[0].toLowerCase();
  return baseLanguage(left) === baseLanguage(right);
}

function mapNativeError(error: unknown): TranscriptFetchError {
  if (error instanceof TranscriptFetchError) return error;
  if (error instanceof NativePlaybackError) {
    const nativeMessage = `${error.message} ${error.detail ?? ''}`;
    if (/429/.test(nativeMessage))
      return new TranscriptFetchError(
        'rateLimited',
        'YouTube 限制了字幕请求频率（HTTP 429），请稍后再试。',
        429,
      );
    if (/exp=xpe|po.?token required/i.test(nativeMessage))
      return new TranscriptFetchError(
        'poTokenRequired',
        'YouTube 要求 PO Token 才能读取这个字幕轨道。',
      );
    if (/HTTP 403|status code 403|LOGIN_REQUIRED|BotGuard/i.test(nativeMessage))
      return new TranscriptFetchError(
        'requestBlocked',
        'YouTube 拒绝了字幕请求，可能需要验证或当前网络出口受限。',
        403,
      );
    switch (error.code) {
      case 'botCheck':
      case 'loginRequired':
        return new TranscriptFetchError(
          'requestBlocked',
          'YouTube 要求验证访问请求，换网络后可稍后重试。',
        );
      case 'ageRestricted':
        return new TranscriptFetchError(
          'ageRestricted',
          '这是年龄限制视频，当前访问上下文无法读取字幕。',
        );
      case 'privateVideo':
      case 'membersOnly':
      case 'regionBlocked':
      case 'unavailable':
      case 'notFound':
      case 'liveOffline':
        return new TranscriptFetchError(
          'videoUnavailable',
          '视频当前不可访问，无法读取字幕。',
        );
      case 'network':
        return new TranscriptFetchError(
          /timeout|超时/i.test(error.message) ? 'timeout' : 'network',
          /timeout|超时/i.test(error.message)
            ? '获取字幕信息超时，请检查网络后重试。'
            : '无法连接 YouTube 字幕服务，请检查网络后重试。',
        );
      default:
        return new TranscriptFetchError(
          'unknown',
          'YouTube 返回了无法识别的字幕错误。',
        );
    }
  }
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return new TranscriptFetchError(
      'timeout',
      '获取字幕超时，请检查网络后重试。',
    );
  if (error instanceof DOMException && error.name === 'AbortError')
    return new TranscriptFetchError('network', '字幕请求已取消。');
  if (error instanceof TypeError)
    return new TranscriptFetchError(
      'network',
      '无法连接 YouTube 字幕服务，请检查网络后重试。',
    );
  return new TranscriptFetchError(
    'unknown',
    error instanceof Error ? error.message : '读取字幕时发生未知错误。',
  );
}

export function transcriptErrorMessage(error: unknown): string {
  return mapNativeError(error).message;
}

async function fetchTranscriptUncached(
  videoId: string,
  preferredLang: string,
  options: FetchTranscriptOptions,
  signal: AbortSignal,
  key: string,
): Promise<TranscriptResult> {
  try {
    const catalog = await discoverTracks(
      videoId,
      signal,
      Boolean(options.forceRefresh),
    );
    const { tracks } = catalog;
    if (tracks.length === 0)
      throw new TranscriptFetchError(
        'transcriptsDisabled',
        '这个视频没有可用的 YouTube 字幕轨道。',
      );

    const selected = chooseTrack(tracks, preferredLang, options.trackId);
    let cues = await fetchCuesFromBaseUrl(
      selected.baseUrl,
      signal,
      catalog.poToken,
    );

    const translationLang = options.translationLang ?? preferredLang;
    if (
      selected.isTranslatable &&
      !sameLanguage(selected.languageCode, translationLang)
    ) {
      try {
        const translated = await fetchCuesFromBaseUrl(
          selected.baseUrl,
          signal,
          catalog.poToken,
          translationLang,
        );
        cues = alignBilingualCues(cues, translated);
      } catch (error) {
        signal.throwIfAborted();
        // Preserve the original captions if YouTube's optional translation track is unavailable.
        console.info(
          '[Transcript] Optional translation unavailable:',
          mapNativeError(error).code,
        );
      }
    }

    const result: TranscriptResult = {
      videoId,
      tracks: tracks.map((track) => ({
        id: track.id,
        languageCode: track.languageCode,
        name: track.name,
        isTranslatable: track.isTranslatable,
        isGenerated: track.isGenerated,
        isDefault: track.isDefault,
      })),
      translationLanguages: catalog.translationLanguages,
      activeTrackId: selected.id,
      cues,
    };
    writeCache(key, result);
    return result;
  } catch (error) {
    throw mapNativeError(error);
  }
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function subscribeToRequest(
  entry: InFlightRequest,
  signal?: AbortSignal,
): Promise<TranscriptResult> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? createAbortError());
  entry.subscribers += 1;

  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', onAbort);
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers === 0 && !entry.settled) entry.controller.abort();
    };
    const onAbort = () => {
      release();
      reject(signal?.reason ?? createAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (result) => {
        if (released) return;
        release();
        resolve(result);
      },
      (error: unknown) => {
        if (released) return;
        release();
        reject(error);
      },
    );
  });
}

function runSharedRequest(
  key: string,
  loader: (signal: AbortSignal) => Promise<TranscriptResult>,
  callerSignal?: AbortSignal,
): Promise<TranscriptResult> {
  let entry = inFlightRequests.get(key);
  if (entry?.controller.signal.aborted && !entry.settled) {
    inFlightRequests.delete(key);
    entry = undefined;
  }
  if (!entry) {
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = AbortSignal.any([controller.signal, timeout]);
    const promise = loader(requestSignal).catch((error: unknown) => {
      if (timeout.aborted)
        throw new TranscriptFetchError(
          'timeout',
          '获取字幕超时，请检查网络后重试。',
        );
      throw mapNativeError(error);
    });
    entry = { controller, promise, subscribers: 0, settled: false };
    inFlightRequests.set(key, entry);
    const createdEntry = entry;
    void promise.then(
      () => {
        createdEntry.settled = true;
        if (inFlightRequests.get(key) === createdEntry)
          inFlightRequests.delete(key);
      },
      () => {
        createdEntry.settled = true;
        if (inFlightRequests.get(key) === createdEntry)
          inFlightRequests.delete(key);
      },
    );
  }
  return subscribeToRequest(entry, callerSignal);
}

export function fetchVideoTranscript(
  videoId: string,
  preferredLang = 'zh-Hans',
  options: FetchTranscriptOptions = {},
): Promise<TranscriptResult> {
  const translationLang = options.translationLang ?? preferredLang;
  const key = cacheKey(
    videoId,
    preferredLang,
    options.trackId,
    translationLang,
  );
  if (!options.forceRefresh) {
    const cached = readCache(key);
    if (cached) return Promise.resolve(cached);
  }

  return runSharedRequest(
    key,
    (signal) =>
      fetchTranscriptUncached(videoId, preferredLang, options, signal, key),
    options.signal,
  );
}
