import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativePlaybackError } from '../src/youtube-native-errors';

const invoke = vi.hoisted(() => vi.fn());
const resolveNativeTranscriptInfo = vi.hoisted(() => vi.fn());
const clearCachedNativeTranscriptInfo = vi.hoisted(() => vi.fn());
const proxiedFetch = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../src/youtube-native', () => ({
  resolveNativeTranscriptInfo,
  clearCachedNativeTranscriptInfo,
}));
vi.mock('../src/youtube-proxy', () => ({
  proxiedFetch,
}));

import {
  clearTranscriptCache,
  fetchBrowserTranscript,
  fetchVideoTranscript,
  TranscriptFetchError,
} from '../src/player/transcript/fetcher';

const catalog = {
  videoId: 'dQw4w9WgXcQ',
  tracks: [
    {
      id: 'youtube:en:manual:0',
      languageCode: 'en',
      name: 'English',
      isGenerated: false,
      isTranslatable: false,
      isDefault: true,
    },
  ],
  translationLanguages: [],
};

beforeEach(() => {
  invoke.mockReset();
  resolveNativeTranscriptInfo.mockReset();
  clearCachedNativeTranscriptInfo.mockReset();
  proxiedFetch.mockReset();
  clearTranscriptCache('dQw4w9WgXcQ');
  clearTranscriptCache('CuknAdR6ofE');
});

describe('desktop transcript request chain', () => {
  it('discovers and fetches captions without resolving native playback', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'youtube_transcript_list')
        return { state: 'ok', data: catalog };
      if (command === 'youtube_transcript_fetch')
        return {
          state: 'ok',
          data: {
            videoId: catalog.videoId,
            trackId: catalog.tracks[0].id,
            contentType: 'application/json',
            body: JSON.stringify({
              events: [
                {
                  tStartMs: 1000,
                  dDurationMs: 2000,
                  segs: [{ utf8: 'Hello' }],
                },
              ],
            }),
          },
        };
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await fetchVideoTranscript(catalog.videoId, 'en', {
      forceRefresh: true,
    });
    expect(result.cues).toEqual([
      { id: 'cue-0', start: 1, end: 3, text: 'Hello' },
    ]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'youtube_transcript_list',
      'youtube_transcript_fetch',
    ]);
    expect(resolveNativeTranscriptInfo).not.toHaveBeenCalled();
  });

  it('falls back to WebView BotGuard + PO Token when Layer 1 is blocked or requires exp=xpe', async () => {
    invoke.mockResolvedValue({
      state: 'error',
      data: {
        code: 'requestBlocked',
        stage: 'player',
        message: 'YouTube 要求先完成真人验证。',
        traceId: 'probe1234',
      },
    });
    resolveNativeTranscriptInfo.mockResolvedValue({
      client: 'WEB',
      poToken: 'test-po-token',
      userAgent: 'Mozilla/5.0 TestWebUA',
      visitorData: 'Cgt2aXNpdG9y',
      info: {
        captions: {
          caption_tracks: [
            {
              base_url:
                'https://www.youtube.com/api/timedtext?v=CuknAdR6ofE&exp=xpe&fmt=srv3&lang=en',
              language_code: 'en',
              name: { text: 'English' },
              is_translatable: true,
            },
            {
              base_url:
                'https://www.youtube.com/api/timedtext?v=CuknAdR6ofE&exp=xpe&lang=ja&kind=asr',
              language_code: 'ja',
              kind: 'asr',
              name: { text: 'Japanese (auto)' },
              is_translatable: false,
            },
          ],
          translation_languages: [
            {
              language_code: 'zh-Hans',
              language_name: { text: '简体中文' },
            },
          ],
        },
      },
    });

    proxiedFetch.mockImplementation(async (input: string) => {
      const parsed = new URL(input);
      const tlang = parsed.searchParams.get('tlang');
      const lang = parsed.searchParams.get('lang');
      const text =
        tlang === 'zh-Hans'
          ? '你好世界'
          : lang === 'ja'
            ? 'こんにちは'
            : 'Hello world';
      return new Response(
        JSON.stringify({
          events: [
            { tStartMs: 500, dDurationMs: 1500, segs: [{ utf8: text }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const result = await fetchVideoTranscript('CuknAdR6ofE', 'zh-Hans', {
      forceRefresh: true,
    });
    expect(result.activeTrackId).toBe('native:en:manual:0');
    expect(result.cues).toEqual([
      {
        id: 'cue-0',
        start: 0.5,
        end: 2,
        text: 'Hello world',
        translation: '你好世界',
      },
    ]);
    expect(resolveNativeTranscriptInfo).toHaveBeenCalledTimes(1);
    expect(proxiedFetch).toHaveBeenCalledTimes(2);

    const [firstUrl, firstInit] = proxiedFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    const parsedFirst = new URL(firstUrl);
    expect(parsedFirst.searchParams.get('pot')).toBe('test-po-token');
    expect(parsedFirst.searchParams.get('potc')).toBe('1');
    expect(parsedFirst.searchParams.get('fmt')).toBeNull();
    expect(firstInit.headers).toEqual({
      'User-Agent': 'Mozilla/5.0 TestWebUA',
      'X-Goog-Visitor-Id': 'Cgt2aXNpdG9y',
    });

    // Switching to another native track reuses the cached Layer 2 catalog directly.
    const switched = await fetchVideoTranscript('CuknAdR6ofE', 'zh-Hans', {
      trackId: 'native:ja:auto:1',
    });
    expect(switched.activeTrackId).toBe('native:ja:auto:1');
    expect(switched.cues[0]?.text).toBe('こんにちは');
    expect(resolveNativeTranscriptInfo).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('hands off youtube:... track selection to Layer 2 when Layer 1 caption fetch requires PO Token', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'youtube_transcript_list')
        return { state: 'ok', data: catalog };
      if (command === 'youtube_transcript_fetch') {
        return {
          state: 'error',
          data: {
            code: 'poTokenRequired',
            stage: 'caption',
            message: 'PO Token required',
          },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    resolveNativeTranscriptInfo.mockResolvedValue({
      client: 'WEB',
      poToken: 'minted-pot',
      info: {
        captions: {
          caption_tracks: [
            {
              base_url:
                'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&exp=xpe&lang=en',
              language_code: 'en',
              name: 'English',
              is_translatable: false,
            },
          ],
        },
      },
    });
    proxiedFetch.mockResolvedValue(
      new Response(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nNever gonna give you up\n',
        {
          status: 200,
          headers: { 'content-type': 'text/vtt' },
        },
      ),
    );

    const result = await fetchVideoTranscript('dQw4w9WgXcQ', 'en', {
      trackId: 'youtube:en:manual:0',
      forceRefresh: true,
    });
    expect(result.activeTrackId).toBe('native:en:manual:0');
    expect(result.cues[0]?.text).toBe('Never gonna give you up');
    expect(proxiedFetch).toHaveBeenCalledTimes(1);
  });

  it('recovers via hidden WebView2 embed player when /watch hits HTTP 429 and BotGuard fails with 400', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'youtube_transcript_list') {
        return {
          state: 'error',
          data: {
            code: 'requestBlocked',
            stage: 'watch',
            httpStatus: 429,
            message: 'YouTube 要求验证当前字幕请求。',
            traceId: '80217cfa',
          },
        };
      }
      if (command === 'youtube_transcript_embed_fetch') {
        return {
          state: 'ok',
          data: {
            videoId: 'CuknAdR6ofE',
            tracks: [
              {
                id: 'embed:en:auto:0',
                languageCode: 'en',
                name: 'English (auto-generated)',
                isGenerated: true,
                isTranslatable: true,
                isDefault: true,
              },
            ],
            translationLanguages: [
              { languageCode: 'zh-Hans', name: '简体中文' },
            ],
            activeTrackId: 'embed:en:auto:0',
            contentType: 'application/json',
            body: JSON.stringify({
              events: [
                {
                  tStartMs: 8000,
                  dDurationMs: 4000,
                  segs: [
                    {
                      utf8: 'Each day, an average of 11 homes are effectively stolen in Mexico City.',
                    },
                  ],
                },
              ],
            }),
            translationLanguage: 'zh-Hans',
            translationBody: JSON.stringify({
              events: [
                {
                  tStartMs: 8000,
                  dDurationMs: 4000,
                  segs: [
                    { utf8: '在墨西哥城，平均每天有 11 套房屋被变相盗占。' },
                  ],
                },
              ],
            }),
          },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    resolveNativeTranscriptInfo.mockRejectedValue(
      new NativePlaybackError(
        'botCheck',
        'BotGuard could not mint the required content PO token: BotGuard token request failed (400).',
      ),
    );

    const result = await fetchVideoTranscript('CuknAdR6ofE', 'zh-Hans', {
      forceRefresh: true,
    });
    expect(result.activeTrackId).toBe('embed:en:auto:0');
    expect(result.tracks).toHaveLength(1);
    expect(result.cues).toEqual([
      {
        id: 'cue-0',
        start: 8,
        end: 12,
        text: 'Each day, an average of 11 homes are effectively stolen in Mexico City.',
        translation: '在墨西哥城，平均每天有 11 套房屋被变相盗占。',
      },
    ]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'youtube_transcript_list',
      'youtube_transcript_embed_fetch',
    ]);
  });

  it('automatically recovers via cookie-less Layer 3 yt-dlp with bilingual alignment when Layers 1, 2, and embed are blocked', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'youtube_transcript_list') {
        return {
          state: 'error',
          data: {
            code: 'requestBlocked',
            stage: 'player',
            message: 'YouTube 要求先完成真人验证。',
            traceId: 'probe1234',
          },
        };
      }
      if (command === 'youtube_transcript_embed_fetch') {
        return {
          state: 'error',
          data: {
            code: 'requestBlocked',
            stage: 'embed',
            message: '视频作者禁用了内嵌播放。',
          },
        };
      }
      if (command === 'youtube_transcript_ytdlp_fetch') {
        return {
          state: 'ok',
          data: {
            videoId: 'CuknAdR6ofE',
            trackId: 'ytdlp:yue-HK',
            contentType: 'text/vtt',
            body: [
              'WEBVTT',
              '',
              '00:00:01.000 --> 00:00:02.990 align:start position:0%',
              '大家好<00:00:01.500><c> 歡迎收睇</c>',
              '',
              '00:00:02.990 --> 00:00:03.000 align:start position:0%',
              '大家好 歡迎收睇',
              '',
              '00:00:03.000 --> 00:00:05.000 align:start position:0%',
              '大家好 歡迎收睇',
              '今日講下字幕提取',
            ].join('\n'),
            translationLanguage: 'zh-Hans',
            translationBody: [
              'WEBVTT',
              '',
              '00:00:01.000 --> 00:00:03.000',
              '大家好 欢迎收看',
              '',
              '00:00:03.000 --> 00:00:05.000',
              '今天讲一下字幕提取',
            ].join('\n'),
          },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    resolveNativeTranscriptInfo.mockRejectedValue(
      new NativePlaybackError('botCheck', 'BotGuard blocked'),
    );

    const result = await fetchVideoTranscript('CuknAdR6ofE', 'zh-Hans', {
      forceRefresh: true,
    });
    expect(result.activeTrackId).toBe('ytdlp:yue-HK');
    expect(result.cues).toEqual([
      {
        id: 'cue-0',
        start: 1,
        end: 3,
        text: '大家好 歡迎收睇',
        translation: '大家好 欢迎收看',
      },
      {
        id: 'cue-1',
        start: 3,
        end: 5,
        text: '今日講下字幕提取',
        translation: '今天讲一下字幕提取',
      },
    ]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'youtube_transcript_list',
      'youtube_transcript_embed_fetch',
      'youtube_transcript_ytdlp_fetch',
    ]);
  });

  it('preserves the real player verification error without inventing HTTP 403 when all automatic layers fail', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'youtube_transcript_list') {
        return {
          state: 'error',
          data: {
            code: 'requestBlocked',
            stage: 'player',
            message: 'YouTube 要求先完成真人验证。',
            traceId: 'probe1234',
          },
        };
      }
      if (command === 'youtube_transcript_embed_fetch') {
        return {
          state: 'error',
          data: {
            code: 'requestBlocked',
            stage: 'embed',
            message: 'YouTube 内嵌播放器未在时限内返回字幕数据。',
          },
        };
      }
      if (command === 'youtube_transcript_ytdlp_fetch') {
        return {
          state: 'error',
          data: {
            code: 'ytdlpUnavailable',
            stage: 'ytdlp',
            message: '未安装本地 yt-dlp 提取器。',
          },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    resolveNativeTranscriptInfo.mockRejectedValue(
      new NativePlaybackError('botCheck', 'BotGuard blocked'),
    );

    await expect(
      fetchVideoTranscript('CuknAdR6ofE', 'zh-Hans', { forceRefresh: true }),
    ).rejects.toMatchObject({
      code: 'requestBlocked',
      stage: 'player',
      status: undefined,
      traceId: 'probe1234',
    } satisfies Partial<TranscriptFetchError>);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'youtube_transcript_list',
      'youtube_transcript_embed_fetch',
      'youtube_transcript_ytdlp_fetch',
    ]);
    expect(resolveNativeTranscriptInfo).toHaveBeenCalledTimes(1);
  });

  it('uses the browser session only through the explicit fallback call', async () => {
    invoke.mockResolvedValue({
      state: 'ok',
      data: {
        videoId: 'CuknAdR6ofE',
        trackId: 'browser:en',
        contentType: 'text/vtt',
        body: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n',
        translationLanguage: 'zh-Hans',
        translationBody: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n',
      },
    });
    const result = await fetchBrowserTranscript('CuknAdR6ofE', 'firefox');
    expect(result.cues[0]).toEqual({
      id: 'cue-0',
      start: 1,
      end: 2,
      text: 'Hello',
      translation: '你好',
    });
    expect(result.activeTrackId).toBe('browser:en');
    expect(invoke).toHaveBeenCalledWith('youtube_transcript_browser_fetch', {
      videoId: 'CuknAdR6ofE',
      browser: 'firefox',
    });
  });
});
