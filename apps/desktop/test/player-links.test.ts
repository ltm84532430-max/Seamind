import { describe, expect, it } from 'vitest';
import {
  channelIdFromUrl,
  channelUrl,
  isChannelId,
  isPlaylistId,
  isVideoId,
  parseYouTubeTarget,
  thumbnailUrl,
  videoWatchUrl,
} from '../src/player/video-links';

const CHANNEL = 'UCYO_jab_esuFRV4b17AJtAw';
const LIST = 'PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab';

describe('parseYouTubeTarget', () => {
  it('reads video addresses in every form, with their start time', () => {
    const video = (
      videoId: string,
      startSeconds = 0,
      listId: string | null = null,
    ) => ({
      kind: 'video',
      videoId,
      startSeconds,
      listId,
    });
    expect(
      parseYouTubeTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toEqual(video('dQw4w9WgXcQ'));
    expect(parseYouTubeTarget('https://youtu.be/dQw4w9WgXcQ?t=75')).toEqual(
      video('dQw4w9WgXcQ', 75),
    );
    expect(
      parseYouTubeTarget('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s'),
    ).toEqual(video('dQw4w9WgXcQ', 65));
    expect(
      parseYouTubeTarget('https://www.youtube.com/shorts/dQw4w9WgXcQ'),
    ).toEqual(video('dQw4w9WgXcQ'));
    expect(
      parseYouTubeTarget('https://www.youtube.com/embed/dQw4w9WgXcQ?start=9'),
    ).toEqual(video('dQw4w9WgXcQ', 9));
    expect(
      parseYouTubeTarget('https://www.youtube.com/live/dQw4w9WgXcQ'),
    ).toEqual(video('dQw4w9WgXcQ'));
    expect(
      parseYouTubeTarget('https://m.youtube.com/watch?v=dQw4w9WgXcQ'),
    ).toEqual(video('dQw4w9WgXcQ'));
    expect(parseYouTubeTarget('dQw4w9WgXcQ')).toEqual(video('dQw4w9WgXcQ'));
    expect(parseYouTubeTarget('youtu.be/dQw4w9WgXcQ')).toEqual(
      video('dQw4w9WgXcQ'),
    );
  });

  it('keeps the playlist a video link was taken from', () => {
    expect(
      parseYouTubeTarget(
        `https://www.youtube.com/watch?v=fNk_zzaMoSs&list=${LIST}&index=2`,
      ),
    ).toEqual({
      kind: 'video',
      videoId: 'fNk_zzaMoSs',
      startSeconds: 0,
      listId: LIST,
    });
    // A mix or a private list is not a playlist worth keeping.
    expect(
      parseYouTubeTarget(
        'https://www.youtube.com/watch?v=fNk_zzaMoSs&list=RDfNk_zzaMoSs',
      ),
    ).toMatchObject({ kind: 'video', listId: null });
  });

  it('reads playlists, with their address or on their own', () => {
    expect(
      parseYouTubeTarget(`https://www.youtube.com/playlist?list=${LIST}`),
    ).toEqual({
      kind: 'playlist',
      listId: LIST,
    });
    expect(parseYouTubeTarget(LIST)).toEqual({
      kind: 'playlist',
      listId: LIST,
    });
    expect(
      parseYouTubeTarget('https://www.youtube.com/playlist?list=WL'),
    ).toBeNull();
  });

  it('reads channels by id, address, handle and old-style name', () => {
    expect(parseYouTubeTarget(CHANNEL)).toEqual({
      kind: 'channel',
      channelId: CHANNEL,
    });
    expect(
      parseYouTubeTarget(`https://www.youtube.com/channel/${CHANNEL}/videos`),
    ).toEqual({
      kind: 'channel',
      channelId: CHANNEL,
    });
    expect(
      parseYouTubeTarget(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
      ),
    ).toEqual({
      kind: 'channel',
      channelId: CHANNEL,
    });
    expect(parseYouTubeTarget('@3blue1brown')).toEqual({
      kind: 'handle',
      handle: '@3blue1brown',
    });
    expect(
      parseYouTubeTarget('https://www.youtube.com/@3blue1brown/videos'),
    ).toEqual({
      kind: 'handle',
      handle: '@3blue1brown',
    });
    expect(
      parseYouTubeTarget('https://www.youtube.com/@%E5%B0%8F%E6%98%8E'),
    ).toEqual({
      kind: 'handle',
      handle: '@小明',
    });
    expect(
      parseYouTubeTarget('https://www.youtube.com/c/Computerphile'),
    ).toEqual({
      kind: 'lookup',
      url: 'https://www.youtube.com/c/Computerphile',
    });
    expect(
      parseYouTubeTarget('https://www.youtube.com/user/numberphile'),
    ).toEqual({
      kind: 'lookup',
      url: 'https://www.youtube.com/user/numberphile',
    });
  });

  it('says nothing for text that is not YouTube', () => {
    for (const text of [
      '',
      '   ',
      'hello world',
      'https://example.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/',
      'https://www.youtube.com/feed/subscriptions',
    ]) {
      expect(parseYouTubeTarget(text), text).toBeNull();
    }
  });
});

describe('address helpers', () => {
  it('takes a channel id out of an address', () => {
    expect(channelIdFromUrl(`http://www.youtube.com/channel/${CHANNEL}`)).toBe(
      CHANNEL,
    );
    expect(channelIdFromUrl('https://www.youtube.com/@x')).toBeNull();
  });

  it('builds the addresses the page uses', () => {
    expect(videoWatchUrl('dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(videoWatchUrl('dQw4w9WgXcQ', 75.9)).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=75s',
    );
    expect(channelUrl(CHANNEL)).toBe(
      `https://www.youtube.com/channel/${CHANNEL}`,
    );
    // The app only lets pictures from i.ytimg.com through its content security policy.
    expect(thumbnailUrl('dQw4w9WgXcQ')).toBe(
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
    );
    expect(thumbnailUrl('dQw4w9WgXcQ', 'maxres')).toContain('maxresdefault');
  });

  it('checks the shape of ids', () => {
    expect(isVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(isVideoId('short')).toBe(false);
    expect(isChannelId(CHANNEL)).toBe(true);
    expect(isChannelId('UC123')).toBe(false);
    expect(isPlaylistId(LIST)).toBe(true);
    expect(isPlaylistId('RDabcdefghijkl')).toBe(false);
  });
});
