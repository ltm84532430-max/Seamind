import { invoke } from '@tauri-apps/api/core';
import {
  clearCachedNativeTranscriptInfo,
  resolveNativeTranscriptInfo,
  type NativeClient,
  type NativeTranscriptInfo,
} from '../../youtube-native';
import { NativePlaybackError } from '../../youtube-native-errors';
import { proxiedFetch } from '../../youtube-proxy';
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
const REQUEST_TIMEOUT_MS = 120_000;

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
  translationBody?: string;
  translationLanguage?: string;
}

interface EmbedTranscriptPayload {
  videoId: string;
  tracks: TranscriptTrack[];
  translationLanguages: TranscriptTranslationLanguage[];
  activeTrackId: string;
  body: string;
  contentType: string;
  translationBody?: string;
  translationLanguage?: string;
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

interface NativeTrackEntry {
  public: TranscriptTrack;
  baseUrl: string;
}

interface NativeCatalogEntry {
  createdAt: number;
  videoId: string;
  client: NativeClient;
  poToken?: string;
  userAgent?: string | null;
  visitorData?: string | null;
  tracks: NativeTrackEntry[];
  translationLanguages: TranscriptTranslationLanguage[];
}

const trackCatalogs = new Map<
  string,
  { createdAt: number; catalog: TranscriptCatalog }
>();
const nativeCatalogs = new Map<string, NativeCatalogEntry>();
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
  nativeCatalogs.delete(videoId);
  clearCachedNativeTranscriptInfo(videoId);
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

function extractTextLabel(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const record = value as {
      text?: unknown;
      simpleText?: unknown;
      runs?: unknown;
      toString?: () => string;
    };
    if (typeof record.text === 'string' && record.text.trim())
      return record.text.trim();
    if (typeof record.simpleText === 'string' && record.simpleText.trim())
      return record.simpleText.trim();
    if (Array.isArray(record.runs)) {
      const joined = record.runs
        .map((run) =>
          run &&
          typeof run === 'object' &&
          typeof (run as { text?: unknown }).text === 'string'
            ? (run as { text: string }).text
            : '',
        )
        .join('')
        .trim();
      if (joined) return joined;
    }
    if (typeof record.toString === 'function') {
      const rendered = record.toString().trim();
      if (rendered && rendered !== '[object Object]' && rendered !== 'N/A')
        return rendered;
    }
  }
  return fallback;
}

function parseNativeCatalog(
  videoId: string,
  resolved: NativeTranscriptInfo,
): NativeCatalogEntry {
  const captions = resolved.info?.captions;
  const rawTracks = captions?.caption_tracks ?? captions?.captionTracks;
  if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
    throw new TranscriptFetchError(
      'transcriptsDisabled',
      'YouTube 没有返回这个视频的字幕轨道。',
      undefined,
      'catalog',
    );
  }
  const audioTracks = captions?.audio_tracks ?? captions?.audioTracks;
  const defaultAudioIdx =
    typeof captions?.default_audio_track_index === 'number'
      ? captions.default_audio_track_index
      : 0;
  const defaultCaptionIndex = Array.isArray(audioTracks)
    ? (audioTracks[defaultAudioIdx]?.default_caption_track_index ??
      audioTracks[defaultAudioIdx]?.defaultCaptionTrackIndex)
    : undefined;

  const tracks: NativeTrackEntry[] = [];
  rawTracks.forEach((raw: any, index: number) => {
    const baseUrl = raw?.base_url ?? raw?.baseUrl;
    const languageCode = raw?.language_code ?? raw?.languageCode;
    if (
      typeof baseUrl !== 'string' ||
      !baseUrl ||
      typeof languageCode !== 'string' ||
      !languageCode
    )
      return;
    const isGenerated = raw?.kind === 'asr';
    const kind = isGenerated ? 'auto' : 'manual';
    tracks.push({
      baseUrl,
      public: {
        id: `native:${languageCode}:${kind}:${index}`,
        languageCode,
        name: extractTextLabel(raw?.name, languageCode),
        isGenerated,
        isTranslatable: Boolean(raw?.is_translatable ?? raw?.isTranslatable),
        isDefault: Boolean(
          raw?.is_default ?? raw?.isDefault ?? defaultCaptionIndex === index,
        ),
      },
    });
  });

  if (tracks.length === 0) {
    throw new TranscriptFetchError(
      'transcriptsDisabled',
      'YouTube 没有返回可用的字幕轨道。',
      undefined,
      'catalog',
    );
  }

  const rawTranslations =
    captions?.translation_languages ?? captions?.translationLanguages;
  const translationLanguages: TranscriptTranslationLanguage[] = [];
  if (Array.isArray(rawTranslations)) {
    for (const item of rawTranslations) {
      const code = item?.language_code ?? item?.languageCode;
      if (typeof code !== 'string' || !code) continue;
      translationLanguages.push({
        languageCode: code,
        name: extractTextLabel(item?.language_name ?? item?.languageName, code),
      });
    }
  }

  return {
    createdAt: Date.now(),
    videoId,
    client: resolved.client,
    poToken: resolved.poToken,
    userAgent: resolved.userAgent ?? null,
    visitorData: resolved.visitorData ?? null,
    tracks,
    translationLanguages,
  };
}

function rememberNativeCatalog(
  videoId: string,
  entry: NativeCatalogEntry,
): void {
  nativeCatalogs.delete(videoId);
  nativeCatalogs.set(videoId, entry);
  while (nativeCatalogs.size > 24) {
    const oldest = nativeCatalogs.keys().next().value as string | undefined;
    if (!oldest) break;
    nativeCatalogs.delete(oldest);
  }
}

async function discoverNativeCatalog(
  videoId: string,
  signal: AbortSignal,
  forceRefresh: boolean,
  clients?: NativeClient[],
): Promise<NativeCatalogEntry> {
  if (!forceRefresh && !clients) {
    const cached = nativeCatalogs.get(videoId);
    if (cached && Date.now() - cached.createdAt <= TRACK_CATALOG_TTL_MS)
      return cached;
  }
  const resolved = await resolveNativeTranscriptInfo(videoId, {
    signal,
    forceRefresh,
    clients,
  });
  signal.throwIfAborted();
  const entry = parseNativeCatalog(videoId, resolved);
  rememberNativeCatalog(videoId, entry);
  return entry;
}

function buildNativeCaptionUrl(
  baseUrl: string,
  entry: NativeCatalogEntry,
  translationLang?: string,
  formatOverride?: 'json3' | 'vtt',
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TranscriptFetchError(
      'trackUnavailable',
      '字幕轨道地址无效。',
      undefined,
      'caption',
    );
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'www.youtube.com' && url.hostname !== 'youtube.com') ||
    url.pathname !== '/api/timedtext'
  ) {
    throw new TranscriptFetchError(
      'trackUnavailable',
      '字幕轨道地址不属于允许的 YouTube 接口。',
      undefined,
      'caption',
    );
  }
  if (url.searchParams.get('fmt') === 'srv3') url.searchParams.delete('fmt');
  url.searchParams.delete('tlang');
  if (formatOverride) url.searchParams.set('fmt', formatOverride);
  if (translationLang) url.searchParams.set('tlang', translationLang);

  const expXpe = url.searchParams.get('exp') === 'xpe';
  if (entry.poToken) {
    url.searchParams.set('pot', entry.poToken);
    if (entry.client === 'WEB' || entry.client === 'WEB_EMBEDDED' || expXpe) {
      url.searchParams.set('potc', '1');
    }
  } else if (expXpe) {
    throw new TranscriptFetchError(
      'poTokenRequired',
      '这个字幕轨道要求专用 PO Token。',
      undefined,
      'caption',
    );
  }
  return url.toString();
}

function isBotChallengeHtml(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes('not a bot') ||
    lower.includes('unusual traffic') ||
    lower.includes('g-recaptcha') ||
    lower.includes('sign in to confirm') ||
    lower.includes('botguard') ||
    body.includes('不是机器人') ||
    body.includes('异常流量')
  );
}

async function downloadNativeCaptionText(
  url: string,
  entry: NativeCatalogEntry,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const headers: Record<string, string> = {};
  if (entry.userAgent) headers['User-Agent'] = entry.userAgent;
  if (entry.visitorData) headers['X-Goog-Visitor-Id'] = entry.visitorData;

  let response: Response;
  try {
    response = await proxiedFetch(url, { method: 'GET', headers, signal });
  } catch (error) {
    signal.throwIfAborted();
    throw normalizeError(error);
  }
  signal.throwIfAborted();
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  signal.throwIfAborted();

  if (!response.ok) {
    if (isBotChallengeHtml(body)) {
      throw new TranscriptFetchError(
        'requestBlocked',
        'YouTube 要求验证当前字幕请求。',
        response.status,
        'caption',
      );
    }
    if (response.status === 429) {
      throw new TranscriptFetchError(
        'rateLimited',
        'YouTube 限制了请求频率，请稍后再试。',
        429,
        'caption',
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new TranscriptFetchError(
        'requestBlocked',
        'YouTube 拒绝了当前字幕请求，可能需要验证。',
        response.status,
        'caption',
      );
    }
    if (response.status === 404 || response.status === 410) {
      throw new TranscriptFetchError(
        'trackUnavailable',
        '字幕轨道地址已失效。',
        response.status,
        'caption',
      );
    }
    if (response.status >= 500) {
      throw new TranscriptFetchError(
        'network',
        'YouTube 字幕服务暂时不可用。',
        response.status,
        'caption',
      );
    }
    throw new TranscriptFetchError(
      'http',
      'YouTube 字幕请求返回错误状态。',
      response.status,
      'caption',
    );
  }

  const trimmed = body.replace(/^\uFEFF/, '').trim();
  const lower = trimmed.toLowerCase();
  if (
    !trimmed ||
    lower === '<transcript/>' ||
    lower === '<transcript></transcript>' ||
    lower === '<timedtext/>' ||
    lower === '<timedtext></timedtext>'
  ) {
    throw new TranscriptFetchError(
      'emptyResponse',
      'YouTube 返回了空字幕正文，轨道可能不可访问。',
      response.status,
      'caption',
    );
  }
  if (
    lower.startsWith('<!doctype html') ||
    lower.startsWith('<html') ||
    contentType.toLowerCase().startsWith('text/html')
  ) {
    throw new TranscriptFetchError(
      isBotChallengeHtml(trimmed) ? 'requestBlocked' : 'unexpectedResponse',
      isBotChallengeHtml(trimmed)
        ? 'YouTube 在字幕请求中要求真人验证。'
        : 'YouTube 返回了网页，而不是字幕正文。',
      response.status,
      'caption',
    );
  }
  return body;
}

async function fetchNativeCues(
  entry: NativeCatalogEntry,
  track: NativeTrackEntry,
  signal: AbortSignal,
  translationLang?: string,
): Promise<TranscriptCue[]> {
  const tryFetch = async (
    formatOverride?: 'json3' | 'vtt',
  ): Promise<TranscriptCue[]> => {
    const url = buildNativeCaptionUrl(
      track.baseUrl,
      entry,
      translationLang,
      formatOverride,
    );
    const body = await downloadNativeCaptionText(url, entry, signal);
    try {
      return parseYouTubeCaptionResponse(body);
    } catch {
      throw new TranscriptFetchError(
        'parse',
        'YouTube 返回了字幕正文，但其中没有可读取的时间轴内容。',
        undefined,
        'parse',
      );
    }
  };

  try {
    return await tryFetch();
  } catch (error) {
    signal.throwIfAborted();
    const first = normalizeError(error);
    if (
      first.code !== 'emptyResponse' &&
      first.code !== 'unexpectedResponse' &&
      first.code !== 'parse' &&
      !(first.code === 'http' && first.status === 400)
    )
      throw first;
    return tryFetch('json3');
  }
}

function resolveRequestedNativeTrackId(
  tracks: TranscriptTrack[],
  requestedTrackId?: string,
): string | undefined {
  if (!requestedTrackId) return undefined;
  if (requestedTrackId.startsWith('native:')) return requestedTrackId;
  if (requestedTrackId.startsWith('youtube:')) {
    const directCandidate = requestedTrackId.replace(/^youtube:/, 'native:');
    if (tracks.some((track) => track.id === directCandidate))
      return directCandidate;
    const parts = requestedTrackId.split(':');
    const lang = parts[1];
    const isGenerated = parts[2] === 'auto';
    if (lang) {
      const matched = tracks.find(
        (track) =>
          sameLanguage(track.languageCode, lang) &&
          track.isGenerated === isGenerated,
      );
      if (matched) return matched.id;
    }
    return undefined;
  }
  return requestedTrackId;
}

function shouldFallbackToNative(error: TranscriptFetchError): boolean {
  return (
    error.code === 'requestBlocked' ||
    error.code === 'poTokenRequired' ||
    error.code === 'rateLimited' ||
    error.code === 'emptyResponse' ||
    error.code === 'unexpectedResponse' ||
    error.code === 'http'
  );
}

function errorFromNative(
  error: unknown,
  fallback?: TranscriptFetchError,
): TranscriptFetchError {
  if (error instanceof TranscriptFetchError) {
    if (
      fallback &&
      (error.code === 'requestBlocked' ||
        error.code === 'network' ||
        error.code === 'unknown')
    )
      return fallback;
    return error;
  }
  if (error instanceof NativePlaybackError) {
    switch (error.code) {
      case 'ageRestricted':
        return new TranscriptFetchError(
          'ageRestricted',
          error.message,
          undefined,
          'native',
        );
      case 'privateVideo':
      case 'membersOnly':
      case 'notFound':
      case 'regionBlocked':
      case 'liveOffline':
        return new TranscriptFetchError(
          'videoUnavailable',
          error.message,
          undefined,
          'native',
        );
      case 'botCheck':
      case 'loginRequired':
        return (
          fallback ??
          new TranscriptFetchError(
            'requestBlocked',
            error.message,
            undefined,
            'native',
          )
        );
      case 'network':
        return (
          fallback ??
          new TranscriptFetchError(
            'network',
            error.message,
            undefined,
            'native',
          )
        );
      default:
        return (
          fallback ??
          new TranscriptFetchError(
            'requestBlocked',
            error.message,
            undefined,
            'native',
          )
        );
    }
  }
  return fallback ?? normalizeError(error);
}

async function fetchTranscriptViaNative(
  videoId: string,
  preferredLang: string,
  options: FetchTranscriptOptions,
  signal: AbortSignal,
  key: string,
  fallbackError?: TranscriptFetchError,
): Promise<TranscriptResult> {
  let entry: NativeCatalogEntry | null = null;
  let activeTrackId: string | null = null;

  const runWithEntry = async (
    currentEntry: NativeCatalogEntry,
  ): Promise<TranscriptResult> => {
    const publicTracks = currentEntry.tracks.map((item) => item.public);
    const selectedPublic = chooseTrack(
      publicTracks,
      preferredLang,
      resolveRequestedNativeTrackId(publicTracks, options.trackId),
    );
    activeTrackId = selectedPublic.id;
    const selectedEntry = currentEntry.tracks.find(
      (item) => item.public.id === selectedPublic.id,
    );
    if (!selectedEntry) {
      throw new TranscriptFetchError(
        'trackUnavailable',
        '所选字幕轨道已不可用，请重新选择。',
        undefined,
        'catalog',
      );
    }

    let cues = await fetchNativeCues(currentEntry, selectedEntry, signal);
    const translationLang = options.translationLang ?? preferredLang;
    const availableTranslation = currentEntry.translationLanguages.find(
      (language) =>
        language.languageCode.toLowerCase() === translationLang.toLowerCase(),
    );
    if (
      selectedPublic.isTranslatable &&
      availableTranslation &&
      !sameLanguage(selectedPublic.languageCode, translationLang)
    ) {
      try {
        const translated = await fetchNativeCues(
          currentEntry,
          selectedEntry,
          signal,
          availableTranslation.languageCode,
        );
        cues = alignBilingualCues(cues, translated);
      } catch (error) {
        signal.throwIfAborted();
        console.info(
          '[Transcript] Optional native translation unavailable:',
          normalizeError(error).code,
        );
      }
    }

    const result: TranscriptResult = {
      videoId,
      tracks: publicTracks,
      translationLanguages: currentEntry.translationLanguages,
      activeTrackId: selectedPublic.id,
      cues,
    };
    writeCache(key, result);
    return result;
  };

  try {
    entry = await discoverNativeCatalog(
      videoId,
      signal,
      Boolean(options.forceRefresh),
    );
    try {
      return await runWithEntry(entry);
    } catch (captionError) {
      signal.throwIfAborted();
      const normalizedCaptionError = normalizeError(captionError);
      const canRetryNonWeb =
        (entry.client === 'WEB' || entry.client === 'WEB_EMBEDDED') &&
        (normalizedCaptionError.code === 'emptyResponse' ||
          normalizedCaptionError.code === 'requestBlocked' ||
          normalizedCaptionError.code === 'poTokenRequired');
      if (!canRetryNonWeb) throw captionError;
      entry = await discoverNativeCatalog(videoId, signal, true, [
        'VISIONOS',
        'ANDROID_VR',
      ]);
      return await runWithEntry(entry);
    }
  } catch (error) {
    signal.throwIfAborted();
    const mapped = errorFromNative(error, fallbackError);
    if (entry && !mapped.tracks) {
      mapped.tracks = entry.tracks.map((item) => item.public);
      mapped.translationLanguages = entry.translationLanguages;
      mapped.activeTrackId = activeTrackId;
    }
    throw mapped;
  }
}

function parseTranscriptBodyWithTranslation(
  payload: TranscriptBody,
  parseErrorMessage: string,
): TranscriptCue[] {
  let cues: TranscriptCue[];
  try {
    cues = parseYouTubeCaptionResponse(payload.body);
  } catch {
    throw new TranscriptFetchError(
      'parse',
      parseErrorMessage,
      undefined,
      'parse',
    );
  }
  if (payload.translationBody) {
    try {
      const translated = parseYouTubeCaptionResponse(payload.translationBody);
      cues = alignBilingualCues(cues, translated);
    } catch {
      // Keep primary cues even if optional secondary subtitle failed to parse.
    }
  }
  return cues;
}

async function fetchTranscriptViaEmbed(
  videoId: string,
  preferredLang: string,
  options: FetchTranscriptOptions,
  signal: AbortSignal,
  key: string,
  fallbackError?: TranscriptFetchError,
): Promise<TranscriptResult> {
  const translationLang = options.translationLang ?? preferredLang;
  try {
    const args: Record<string, unknown> = {
      videoId,
      preferredLang,
      translationLang,
    };
    if (options.trackId) args.trackId = options.trackId;
    const payload = await callBackend<EmbedTranscriptPayload>(
      'youtube_transcript_embed_fetch',
      args,
      signal,
    );
    const cues = parseTranscriptBodyWithTranslation(
      {
        videoId: payload.videoId,
        trackId: payload.activeTrackId,
        body: payload.body,
        contentType: payload.contentType,
        translationBody: payload.translationBody,
        translationLanguage: payload.translationLanguage,
      },
      '内嵌播放器返回了字幕数据，但其中没有可读取的时间轴内容。',
    );
    const result: TranscriptResult = {
      videoId,
      tracks: payload.tracks,
      translationLanguages: payload.translationLanguages,
      activeTrackId: payload.activeTrackId,
      cues,
    };
    writeCache(key, result);
    return result;
  } catch (error) {
    signal.throwIfAborted();
    const normalized = normalizeError(error);
    if (
      normalized.code === 'transcriptsDisabled' ||
      normalized.code === 'ageRestricted' ||
      normalized.code === 'videoUnavailable'
    ) {
      throw normalized;
    }
    throw fallbackError ?? normalized;
  }
}

async function fetchTranscriptViaYtDlp(
  videoId: string,
  preferredLang: string,
  options: FetchTranscriptOptions,
  signal: AbortSignal,
  key: string,
  fallbackError?: TranscriptFetchError,
): Promise<TranscriptResult> {
  const targetLang = options.translationLang ?? preferredLang;
  try {
    const body = await callBackend<TranscriptBody>(
      'youtube_transcript_ytdlp_fetch',
      { videoId, preferredLang: targetLang },
      signal,
    );
    const cues = parseTranscriptBodyWithTranslation(
      body,
      '本地提取器下载了字幕，但其中没有可读取的时间轴内容。',
    );
    const languageCode = body.trackId.replace(/^ytdlp:/, '');
    const result: TranscriptResult = {
      videoId,
      tracks: [
        {
          id: body.trackId,
          languageCode,
          name: `yt-dlp · ${languageCode}`,
          isGenerated: false,
          isTranslatable: false,
          isDefault: true,
        },
      ],
      translationLanguages: [],
      activeTrackId: body.trackId,
      cues,
    };
    writeCache(key, result);
    return result;
  } catch (error) {
    signal.throwIfAborted();
    const normalized = normalizeError(error);
    if (
      normalized.code === 'transcriptsDisabled' ||
      normalized.code === 'ageRestricted' ||
      normalized.code === 'videoUnavailable'
    ) {
      throw normalized;
    }
    throw fallbackError ?? normalized;
  }
}

async function fetchViaEmbedWithYtDlpFallback(
  videoId: string,
  preferredLang: string,
  options: FetchTranscriptOptions,
  signal: AbortSignal,
  key: string,
  fallbackError?: TranscriptFetchError,
): Promise<TranscriptResult> {
  try {
    return await fetchTranscriptViaEmbed(
      videoId,
      preferredLang,
      options,
      signal,
      key,
      fallbackError,
    );
  } catch (embedError) {
    signal.throwIfAborted();
    const normalizedEmbed = normalizeError(embedError);
    if (
      !options.trackId?.startsWith('embed:') &&
      shouldFallbackToNative(normalizedEmbed)
    ) {
      return fetchTranscriptViaYtDlp(
        videoId,
        preferredLang,
        options,
        signal,
        key,
        normalizedEmbed,
      );
    }
    throw normalizedEmbed;
  }
}

async function fetchViaNativeWithFallbacks(
  videoId: string,
  preferredLang: string,
  options: FetchTranscriptOptions,
  signal: AbortSignal,
  key: string,
  fallbackError?: TranscriptFetchError,
): Promise<TranscriptResult> {
  try {
    return await fetchTranscriptViaNative(
      videoId,
      preferredLang,
      options,
      signal,
      key,
      fallbackError,
    );
  } catch (nativeError) {
    signal.throwIfAborted();
    const normalizedNative = normalizeError(nativeError);
    if (
      !options.trackId?.startsWith('native:') &&
      shouldFallbackToNative(normalizedNative)
    ) {
      return fetchViaEmbedWithYtDlpFallback(
        videoId,
        preferredLang,
        options,
        signal,
        key,
        normalizedNative,
      );
    }
    throw normalizedNative;
  }
}

async function fetchTranscriptUncached(
  videoId: string,
  preferredLang: string,
  options: FetchTranscriptOptions,
  signal: AbortSignal,
  key: string,
): Promise<TranscriptResult> {
  if (options.trackId?.startsWith('ytdlp:')) {
    return fetchTranscriptViaYtDlp(
      videoId,
      preferredLang,
      options,
      signal,
      key,
    );
  }
  if (options.trackId?.startsWith('embed:')) {
    return fetchViaEmbedWithYtDlpFallback(
      videoId,
      preferredLang,
      options,
      signal,
      key,
    );
  }

  const cachedNative = nativeCatalogs.get(videoId);
  const useNativeDirectly =
    Boolean(options.trackId?.startsWith('native:')) ||
    (!options.forceRefresh &&
      !trackCatalogs.has(videoId) &&
      Boolean(
        cachedNative &&
          Date.now() - cachedNative.createdAt <= TRACK_CATALOG_TTL_MS,
      ));
  if (useNativeDirectly) {
    return fetchViaNativeWithFallbacks(
      videoId,
      preferredLang,
      options,
      signal,
      key,
    );
  }

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
    if (shouldFallbackToNative(normalized)) {
      return fetchViaNativeWithFallbacks(
        videoId,
        preferredLang,
        options,
        signal,
        key,
        normalized,
      );
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
  preferredLang?: string,
): Promise<TranscriptResult> {
  const timeout = AbortSignal.timeout(90_000);
  try {
    const args: Record<string, unknown> = { videoId, browser };
    if (preferredLang) args.preferredLang = preferredLang;
    const body = await callBackend<TranscriptBody>(
      'youtube_transcript_browser_fetch',
      args,
      timeout,
    );
    const cues = parseTranscriptBodyWithTranslation(
      body,
      '浏览器会话下载了字幕，但没有可读取的时间轴内容。',
    );
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
