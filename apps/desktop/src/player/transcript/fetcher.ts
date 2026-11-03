import { invoke } from '@tauri-apps/api/core';
import { alignBilingualCues, parseYouTubeCaptionResponse } from './parser';
import type {
  TranscriptCue,
  TranscriptResult,
  TranscriptTrack,
  TranscriptTranslationLanguage,
} from './types';

const CACHE_PREFIX = 'seamind:transcript:v3:';
const OLD_CACHE_PREFIXES = ['seamind:transcript:v1:', 'seamind:transcript:v2:'];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TRACK_CATALOG_TTL_MS = 3 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 95_000;

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
  | 'emptyResponse'
  | 'unexpectedResponse'
  | 'parse'
  | 'unknown';

const knownErrorCodes = new Set<TranscriptFetchErrorCode>([
  'transcriptsDisabled',
  'languageUnavailable',
  'trackUnavailable',
  'requestBlocked',
  'rateLimited',
  'poTokenRequired',
  'ageRestricted',
  'videoUnavailable',
  'network',
  'timeout',
  'http',
  'emptyResponse',
  'unexpectedResponse',
  'parse',
  'unknown',
]);

export class TranscriptFetchError extends Error {
  tracks?: TranscriptTrack[];
  translationLanguages?: TranscriptTranslationLanguage[];
  activeTrackId?: string | null;

  constructor(
    readonly code: TranscriptFetchErrorCode,
    message: string,
    readonly status?: number,
    readonly stage?: string,
    readonly traceId?: string,
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

interface TranscriptCatalog {
  videoId: string;
  tracks: TranscriptTrack[];
  translationLanguages: TranscriptTranslationLanguage[];
}

interface TranscriptBody {
  videoId: string;
  trackId: string;
  body: string;
  contentType: string;
}

interface BackendFailure {
  code: string;
  stage: string;
  message: string;
  httpStatus?: number;
  traceId?: string;
}

type BackendReply<T> =
  | { state: 'ok'; data: T }
  | { state: 'error'; data: BackendFailure };

interface TranscriptCacheEntry {
  schema: 3;
  savedAt: number;
  result: TranscriptResult;
}

interface InFlightRequest {
  controller: AbortController;
  promise: Promise<TranscriptResult>;
  subscribers: number;
  settled: boolean;
}

const trackCatalogs = new Map<
  string,
  { createdAt: number; catalog: TranscriptCatalog }
>();
const inFlightRequests = new Map<string, InFlightRequest>();

function cacheKey(
  videoId: string,
  preferredLang: string,
  trackId?: string,
  translationLang = preferredLang,
): string {
  return (
    CACHE_PREFIX +
    encodeURIComponent(videoId) +
    ':' +
    encodeURIComponent(preferredLang) +
    ':' +
    encodeURIComponent(trackId ?? 'auto') +
    ':' +
    encodeURIComponent(translationLang)
  );
}

function readCache(key: string): TranscriptResult | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as TranscriptCacheEntry;
    if (
      cached?.schema === 3 &&
      Date.now() - cached.savedAt <= CACHE_TTL_MS &&
      Array.isArray(cached.result?.cues) &&
      cached.result.cues.length > 0 &&
      Array.isArray(cached.result?.tracks)
    )
      return cached.result;
    localStorage.removeItem(key);
  } catch {
    // Storage failures must not stop a fresh caption request.
  }
  return null;
}

function writeCache(key: string, result: TranscriptResult): void {
  if (result.cues.length === 0) return;
  try {
    const value: TranscriptCacheEntry = {
      schema: 3,
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
    localStorage.removeItem(OLD_CACHE_PREFIXES[0] + videoId);
    const encoded = encodeURIComponent(videoId);
    const prefixes = [CACHE_PREFIX, ...OLD_CACHE_PREFIXES].map(
      (prefix) => prefix + encoded + ':',
    );
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix)))
        localStorage.removeItem(key);
    }
  } catch {
    // A storage failure should not block a retry.
  }
}

function errorFromBackend(error: BackendFailure): TranscriptFetchError {
  const code = knownErrorCodes.has(error.code as TranscriptFetchErrorCode)
    ? (error.code as TranscriptFetchErrorCode)
    : 'unknown';
  return new TranscriptFetchError(
    code,
    error.message,
    error.httpStatus,
    error.stage,
    error.traceId,
  );
}

async function callBackend<T>(
  command: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let reply: BackendReply<T>;
  try {
    reply = await invoke<BackendReply<T>>(command, args);
  } catch {
    signal.throwIfAborted();
    throw new TranscriptFetchError(
      'network',
      '字幕服务暂时无法连接，请重新打开播放器后重试。',
      undefined,
      'ipc',
    );
  }
  signal.throwIfAborted();
  if (reply.state === 'error') throw errorFromBackend(reply.data);
  return reply.data;
}

async function discoverTracks(
  videoId: string,
  signal: AbortSignal,
  forceRefresh: boolean,
): Promise<TranscriptCatalog> {
  const cached = trackCatalogs.get(videoId);
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.createdAt <= TRACK_CATALOG_TTL_MS
  )
    return cached.catalog;

  const catalog = await callBackend<TranscriptCatalog>(
    'youtube_transcript_list',
    { videoId, forceRefresh },
    signal,
  );
  trackCatalogs.delete(videoId);
  trackCatalogs.set(videoId, { createdAt: Date.now(), catalog });
  while (trackCatalogs.size > 24) {
    const oldest = trackCatalogs.keys().next().value as string | undefined;
    if (!oldest) break;
    trackCatalogs.delete(oldest);
  }
  return catalog;
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
  tracks: TranscriptTrack[],
  preferredLang: string,
  requestedTrackId?: string,
): TranscriptTrack {
  if (requestedTrackId) {
    const selected = tracks.find((track) => track.id === requestedTrackId);
    if (!selected)
      throw new TranscriptFetchError(
        'trackUnavailable',
        '所选字幕轨道已不可用，请重新选择。',
        undefined,
        'catalog',
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
      undefined,
      'catalog',
    );
  return selected;
}

async function fetchCues(
  videoId: string,
  trackId: string,
  signal: AbortSignal,
  translationLang?: string,
): Promise<TranscriptCue[]> {
  const result = await callBackend<TranscriptBody>(
    'youtube_transcript_fetch',
    { videoId, trackId, translationLang: translationLang ?? null },
    signal,
  );
  try {
    return parseYouTubeCaptionResponse(result.body);
  } catch {
    throw new TranscriptFetchError(
      'parse',
      'YouTube 返回了字幕正文，但其中没有可读取的时间轴内容。',
      undefined,
      'parse',
    );
  }
}

function sameLanguage(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/_/g, '-').toLowerCase();
  return normalize(left) === normalize(right);
}

function normalizeError(error: unknown): TranscriptFetchError {
  if (error instanceof TranscriptFetchError) return error;
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return new TranscriptFetchError(
      'timeout',
      '获取字幕超时，请检查网络后重试。',
      undefined,
      'network',
    );
  if (error instanceof TypeError)
    return new TranscriptFetchError(
      'network',
      '无法连接 YouTube 字幕服务，请检查网络后重试。',
      undefined,
      'network',
    );
  return new TranscriptFetchError(
    'unknown',
    error instanceof Error ? error.message : '读取字幕时发生未知错误。',
  );
}

export function transcriptErrorMessage(error: unknown): string {
  return normalizeError(error).message;
}

async function fetchTranscriptUncached(
  videoId: string,
  preferredLang: string,
  options: FetchTranscriptOptions,
  signal: AbortSignal,
  key: string,
): Promise<TranscriptResult> {
  let catalog: TranscriptCatalog | null = null;
  let activeTrackId: string | null = null;
  try {
    catalog = await discoverTracks(
      videoId,
      signal,
      Boolean(options.forceRefresh),
    );
    const selected = chooseTrack(
      catalog.tracks,
      preferredLang,
      options.trackId,
    );
    activeTrackId = selected.id;
    let cues = await fetchCues(videoId, selected.id, signal);

    const translationLang = options.translationLang ?? preferredLang;
    const availableTranslation = catalog.translationLanguages.find(
      (language) =>
        language.languageCode.toLowerCase() === translationLang.toLowerCase(),
    );
    if (
      selected.isTranslatable &&
      availableTranslation &&
      !sameLanguage(selected.languageCode, translationLang)
    ) {
      try {
        const translated = await fetchCues(
          videoId,
          selected.id,
          signal,
          availableTranslation.languageCode,
        );
        cues = alignBilingualCues(cues, translated);
      } catch (error) {
        signal.throwIfAborted();
        console.info(
          '[Transcript] Optional translation unavailable:',
          normalizeError(error).code,
        );
      }
    }

    const result: TranscriptResult = {
      videoId,
      tracks: catalog.tracks,
      translationLanguages: catalog.translationLanguages,
      activeTrackId: selected.id,
      cues,
    };
    writeCache(key, result);
    return result;
  } catch (error) {
    signal.throwIfAborted();
    const normalized = normalizeError(error);
    if (catalog) {
      normalized.tracks = catalog.tracks;
      normalized.translationLanguages = catalog.translationLanguages;
      normalized.activeTrackId = activeTrackId;
    }
    throw normalized;
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
          undefined,
          'network',
        );
      throw normalizeError(error);
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
  if (options.signal?.aborted)
    return Promise.reject(options.signal.reason ?? createAbortError());
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
    options.forceRefresh ? key + ':refresh' : key,
    (signal) =>
      fetchTranscriptUncached(videoId, preferredLang, options, signal, key),
    options.signal,
  );
}

/** Reads the chosen browser session only after the user clicks the fallback action. */
export async function fetchBrowserTranscript(
  videoId: string,
  browser: 'firefox' | 'edge' | 'chrome',
): Promise<TranscriptResult> {
  const timeout = AbortSignal.timeout(90_000);
  try {
    const body = await callBackend<TranscriptBody>(
      'youtube_transcript_browser_fetch',
      { videoId, browser },
      timeout,
    );
    let cues: TranscriptCue[];
    try {
      cues = parseYouTubeCaptionResponse(body.body);
    } catch {
      throw new TranscriptFetchError(
        'parse',
        '浏览器会话下载了字幕，但没有可读取的时间轴内容。',
        undefined,
        'parse',
      );
    }
    const languageCode = body.trackId.replace(/^browser:/, '');
    return {
      videoId,
      tracks: [
        {
          id: body.trackId,
          languageCode,
          name: `浏览器会话 · ${languageCode}`,
          isGenerated: false,
          isTranslatable: false,
          isDefault: true,
        },
      ],
      translationLanguages: [],
      activeTrackId: body.trackId,
      cues,
    };
  } catch (error) {
    if (timeout.aborted)
      throw new TranscriptFetchError(
        'timeout',
        '浏览器会话字幕请求超时。',
        undefined,
        'browser',
      );
    throw normalizeError(error);
  }
}
