import { invoke } from '@tauri-apps/api/core';

export interface YouTubeProxyEndpoint {
  origin: string;
  token: string;
}

const debugStorageKey = 'seamind.debug.youtube';
const proxiedHostSuffixes = ['googlevideo.com', 'youtube.com', 'ytimg.com'];

/**
 * Headers the loopback proxy accepts from the page; anything else (cookies, authorization) is
 * dropped here so a CORS preflight never advertises a header the proxy would refuse.
 */
const forwardedHeaders = new Set([
  'accept',
  'accept-language',
  'content-type',
  'range',
  'if-range',
  'x-goog-visitor-id',
  'x-goog-api-format-version',
  'x-youtube-client-name',
  'x-youtube-client-version',
]);

let endpointPromise: Promise<YouTubeProxyEndpoint> | null = null;

/** Debug builds of the Rust side may allow a loopback upstream for end-to-end checks. */
export function isYouTubeDebugEnabled(): boolean {
  try {
    return localStorage.getItem(debugStorageKey) === '1';
  } catch {
    return false;
  }
}

export function getYouTubeProxyEndpoint(): Promise<YouTubeProxyEndpoint> {
  endpointPromise ??= invoke<YouTubeProxyEndpoint>('youtube_proxy_info').catch(
    (error: unknown) => {
      endpointPromise = null;
      throw error;
    },
  );
  return endpointPromise;
}

/** Whether a request to this address has to go through the proxy to carry YouTube's headers. */
export function isProxiedYouTubeUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    isYouTubeDebugEnabled() &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  )
    return true;
  return (
    url.protocol === 'https:' &&
    proxiedHostSuffixes.some(
      (suffix) =>
        url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    )
  );
}

export function toProxyUrl(
  endpoint: YouTubeProxyEndpoint,
  target: string,
): string {
  return `${endpoint.origin}/fetch?u=${encodeURIComponent(target)}`;
}

/** Keeps the headers the proxy understands and moves `User-Agent` to its own header. */
export function toProxyHeaders(
  headers: Headers,
  endpoint: YouTubeProxyEndpoint,
): Headers {
  const outgoing = new Headers();
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === 'user-agent') outgoing.set('x-seamind-ua', value);
    else if (forwardedHeaders.has(name)) outgoing.set(name, value);
  });
  outgoing.set('x-seamind-token', endpoint.token);
  return outgoing;
}

/**
 * A `fetch` that sends the request through Seamind's loopback proxy. WebView2 enforces CORS and
 * cannot set YouTube's Origin/Referer, so YouTube.js and the media player use this instead.
 */
export async function proxiedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const endpoint = await getYouTubeProxyEndpoint();
  const source = input instanceof Request ? input : null;
  const target = source ? source.url : input.toString();
  const method = (init?.method ?? source?.method ?? 'GET').toUpperCase();

  const headers = new Headers(source?.headers);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));

  let body: BodyInit | null | undefined = init?.body;
  if (body === undefined && source && method !== 'GET' && method !== 'HEAD')
    body = await source.clone().arrayBuffer();

  return fetch(toProxyUrl(endpoint, target), {
    method,
    headers: toProxyHeaders(headers, endpoint),
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    signal: init?.signal ?? source?.signal,
    credentials: 'omit',
    cache: 'no-store',
  });
}
