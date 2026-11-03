import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

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
  });

  it('preserves the real player verification error without inventing HTTP 403', async () => {
    invoke.mockResolvedValue({
      state: 'error',
      data: {
        code: 'requestBlocked',
        stage: 'player',
        message: 'YouTube 要求先完成真人验证。',
        traceId: 'probe1234',
      },
    });

    await expect(
      fetchVideoTranscript('CuknAdR6ofE', 'zh-Hans', { forceRefresh: true }),
    ).rejects.toMatchObject({
      code: 'requestBlocked',
      stage: 'player',
      status: undefined,
      traceId: 'probe1234',
    } satisfies Partial<TranscriptFetchError>);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('uses the browser session only through the explicit fallback call', async () => {
    invoke.mockResolvedValue({
      state: 'ok',
      data: {
        videoId: 'CuknAdR6ofE',
        trackId: 'browser:zh-Hans',
        contentType: 'text/vtt',
        body: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n',
      },
    });
    const result = await fetchBrowserTranscript('CuknAdR6ofE', 'firefox');
    expect(result.cues[0]?.text).toBe('你好');
    expect(result.activeTrackId).toBe('browser:zh-Hans');
    expect(invoke).toHaveBeenCalledWith('youtube_transcript_browser_fetch', {
      videoId: 'CuknAdR6ofE',
      browser: 'firefox',
    });
  });
});
