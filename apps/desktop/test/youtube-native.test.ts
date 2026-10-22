import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPlayability,
  classifyShakaError,
  isDefinitiveFailure,
  NativePlaybackError,
  pickFailure,
} from '../src/youtube-native-errors';

describe('classifying YouTube playability', () => {
  it('recognises the bot check however the client reports it', () => {
    // Both responses were captured from the real service for a restricted video.
    expect(
      classifyPlayability({
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm you’re not a bot',
      }),
    ).toBe('botCheck');
    expect(
      classifyPlayability({
        status: 'UNPLAYABLE',
        reason: 'Sign in to confirm you’re not a bot',
      }),
    ).toBe('botCheck');
  });

  it('accepts playable videos', () => {
    expect(classifyPlayability({ status: 'OK' })).toBeNull();
  });

  it('separates the definitive failures', () => {
    expect(
      classifyPlayability({
        status: 'ERROR',
        reason: 'This video is unavailable',
      }),
    ).toBe('notFound');
    expect(
      classifyPlayability({
        status: 'LOGIN_REQUIRED',
        reason: 'Sign in to confirm your age',
      }),
    ).toBe('ageRestricted');
    expect(
      classifyPlayability({
        status: 'LOGIN_REQUIRED',
        reason: 'Private video',
      }),
    ).toBe('privateVideo');
    expect(
      classifyPlayability({
        status: 'UNPLAYABLE',
        reason: 'Join this channel to get access to members-only content',
      }),
    ).toBe('membersOnly');
    expect(
      classifyPlayability({
        status: 'UNPLAYABLE',
        offerId: 'sponsors_only_video',
      }),
    ).toBe('membersOnly');
    expect(
      classifyPlayability({
        status: 'UNPLAYABLE',
        reason: 'Video unavailable',
        subreason:
          'The uploader has not made this video available in your country',
      }),
    ).toBe('regionBlocked');
    expect(
      classifyPlayability({ status: 'LIVE_STREAM_OFFLINE', reason: 'Offline' }),
    ).toBe('liveOffline');
  });

  it('treats other unplayable states as client-specific', () => {
    expect(
      classifyPlayability({
        status: 'UNPLAYABLE',
        reason: 'The page needs to be reloaded.',
      }),
    ).toBe('unavailable');
    expect(classifyPlayability({ status: 'SOMETHING_NEW' })).toBe('unknown');
  });

  it('only stops trying other clients for failures every client shares', () => {
    for (const code of [
      'privateVideo',
      'membersOnly',
      'ageRestricted',
      'notFound',
      'regionBlocked',
      'liveOffline',
    ] as const)
      expect(isDefinitiveFailure(code)).toBe(true);
    for (const code of [
      'botCheck',
      'unavailable',
      'noStreams',
      'network',
      'unknown',
    ] as const)
      expect(isDefinitiveFailure(code)).toBe(false);
  });

  it('reports the most informative of several failures', () => {
    const picked = pickFailure([
      new NativePlaybackError('network'),
      new NativePlaybackError('botCheck'),
      new NativePlaybackError('unknown'),
    ]);
    expect(picked.code).toBe('botCheck');
    expect(pickFailure([]).code).toBe('unknown');
    expect(picked.message).toContain('机器人');
  });
});

describe('classifying Shaka errors', () => {
  it('treats rejected media requests as an expired or mismatched address', () => {
    for (const status of [403, 404, 410])
      expect(
        classifyShakaError({ code: 1001, data: ['https://x', status] }).kind,
      ).toBe('expired');
  });

  it('separates rate limits, network trouble and unsupported media', () => {
    expect(
      classifyShakaError({ code: 1001, data: ['https://x', 429] }).kind,
    ).toBe('network');
    expect(classifyShakaError({ code: 1002 }).kind).toBe('network');
    expect(classifyShakaError({ code: 1003 }).kind).toBe('network');
    expect(classifyShakaError({ code: 4012 }).kind).toBe('unsupported');
    expect(classifyShakaError({ code: 3016 }).kind).toBe('unsupported');
    expect(classifyShakaError({ code: 9999 }).kind).toBe('unknown');
  });
});

describe('the loopback proxy client', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.doUnmock('@tauri-apps/api/core');
  });

  async function loadProxy() {
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: vi.fn(async () => ({
        origin: 'http://127.0.0.1:5555',
        token: 'secret',
      })),
    }));
    return import('../src/youtube-proxy');
  }

  it('proxies only YouTube hosts over https', async () => {
    const { isProxiedYouTubeUrl } = await loadProxy();
    expect(
      isProxiedYouTubeUrl(
        'https://rr1---sn-a.googlevideo.com/videoplayback?x=1',
      ),
    ).toBe(true);
    expect(
      isProxiedYouTubeUrl('https://www.youtube.com/youtubei/v1/player'),
    ).toBe(true);
    expect(isProxiedYouTubeUrl('https://i.ytimg.com/vi/x/hq.jpg')).toBe(true);
    expect(isProxiedYouTubeUrl('http://www.youtube.com/')).toBe(false);
    expect(isProxiedYouTubeUrl('https://notyoutube.com/')).toBe(false);
    expect(isProxiedYouTubeUrl('https://youtube.com.evil.example/')).toBe(
      false,
    );
    expect(isProxiedYouTubeUrl('data:application/dash+xml,<MPD/>')).toBe(false);
    expect(isProxiedYouTubeUrl('http://127.0.0.1:9/')).toBe(false);
  });

  it('keeps only headers the proxy accepts and moves the user agent', async () => {
    const { toProxyHeaders } = await loadProxy();
    const headers = toProxyHeaders(
      new Headers({
        'Content-Type': 'application/json',
        Range: 'bytes=0-9',
        'User-Agent': 'com.example/1.0',
        Cookie: 'SID=secret',
        Authorization: 'Bearer secret',
        'X-Goog-Visitor-Id': 'visitor',
      }),
      { origin: 'http://127.0.0.1:5555', token: 'secret' },
    );
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('range')).toBe('bytes=0-9');
    expect(headers.get('x-goog-visitor-id')).toBe('visitor');
    expect(headers.get('x-seamind-ua')).toBe('com.example/1.0');
    expect(headers.get('x-seamind-token')).toBe('secret');
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('user-agent')).toBe(false);
  });

  it('sends a YouTube.js style request through the proxy', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { proxiedFetch } = await loadProxy();

    // YouTube.js builds a Request and overrides body and headers in the init argument.
    const request = new Request(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      {
        method: 'POST',
      },
    );
    await proxiedFetch(request, {
      body: '{"videoId":"dQw4w9WgXcQ"}',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'visionos-ua',
      },
      credentials: 'include',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `http://127.0.0.1:5555/fetch?u=${encodeURIComponent('https://www.youtube.com/youtubei/v1/player?prettyPrint=false')}`,
    );
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"videoId":"dQw4w9WgXcQ"}');
    expect(init.credentials).toBe('omit');
    const headers = init.headers as Headers;
    expect(headers.get('x-seamind-ua')).toBe('visionos-ua');
    expect(headers.get('x-seamind-token')).toBe('secret');
  });

  it('never sends a body with GET requests', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { proxiedFetch } = await loadProxy();
    await proxiedFetch('https://www.youtube.com/generate_204');
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });
});
