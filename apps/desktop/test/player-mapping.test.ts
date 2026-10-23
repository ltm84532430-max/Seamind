import { describe, expect, it } from 'vitest';
import {
  approximatePublishedAt,
  parseDurationText,
  parseViewCount,
  videoFromItem,
} from '../src/player/youtube-mapping';
import {
  formatAgo,
  formatCount,
  formatDuration,
  formatViews,
  initialOf,
} from '../src/player/format';
import {
  isFinished,
  isWorthSaving,
  progressShare,
  startSecondsFor,
  withWatchState,
} from '../src/player/watch-state';
import { buildYouTubeEmbedUrl } from '../src/youtube';
import type { VideoItem } from '../src/player/types';

const NOW = 1_800_000_000;

describe('parseViewCount', () => {
  it('reads the units of Chinese and English YouTube', () => {
    expect(parseViewCount('237万次观看')).toBe(2_370_000);
    expect(parseViewCount('1.2千次观看')).toBe(1_200);
    expect(parseViewCount('1.2亿次观看')).toBe(120_000_000);
    expect(parseViewCount('1,234次观看')).toBe(1_234);
    expect(parseViewCount('1.5K views')).toBe(1_500);
    expect(parseViewCount('2.3M views')).toBe(2_300_000);
    expect(parseViewCount('12,345 views')).toBe(12_345);
    expect(parseViewCount('99 views')).toBe(99);
  });

  it('counts "no views" as zero and gives null for text without a count', () => {
    expect(parseViewCount('No views')).toBe(0);
    expect(parseViewCount('暂无观看次数')).toBe(0);
    expect(parseViewCount('5天前')).toBe(5);
    expect(parseViewCount('')).toBeNull();
    expect(parseViewCount(null)).toBeNull();
    expect(parseViewCount('正在直播')).toBeNull();
  });
});

describe('parseDurationText', () => {
  it('reads m:ss and h:mm:ss', () => {
    expect(parseDurationText('40:44')).toBe(2444);
    expect(parseDurationText('1:02:03')).toBe(3723);
    expect(parseDurationText('0:09')).toBe(9);
    expect(parseDurationText('LIVE')).toBeNull();
    expect(parseDurationText(undefined)).toBeNull();
  });
});

describe('approximatePublishedAt', () => {
  it('turns "5天前" and friends into a time', () => {
    expect(approximatePublishedAt('5天前', NOW)).toBe(NOW - 5 * 86_400);
    expect(approximatePublishedAt('3周前', NOW)).toBe(NOW - 21 * 86_400);
    expect(approximatePublishedAt('2个月前', NOW)).toBe(NOW - 60 * 86_400);
    expect(approximatePublishedAt('1年前', NOW)).toBe(NOW - 365 * 86_400);
    expect(approximatePublishedAt('6小时前', NOW)).toBe(NOW - 6 * 3600);
    expect(approximatePublishedAt('30分钟前', NOW)).toBe(NOW - 1800);
    expect(approximatePublishedAt('直播时间：2天前', NOW)).toBe(
      NOW - 2 * 86_400,
    );
  });

  it('reads English too', () => {
    expect(approximatePublishedAt('5 days ago', NOW)).toBe(NOW - 5 * 86_400);
    expect(approximatePublishedAt('Streamed 2 weeks ago', NOW)).toBe(
      NOW - 14 * 86_400,
    );
    expect(approximatePublishedAt('1 month ago', NOW)).toBe(NOW - 30 * 86_400);
    expect(approximatePublishedAt('Premiered 3 hours ago', NOW)).toBe(
      NOW - 3 * 3600,
    );
  });

  it('says nothing for text without a time', () => {
    expect(approximatePublishedAt('237万次观看', NOW)).toBeNull();
    expect(approximatePublishedAt('', NOW)).toBeNull();
    expect(approximatePublishedAt(null, NOW)).toBeNull();
  });
});

// The shape YouTube.js gives a channel's videos in 2026 (checked against a real channel).
const lockup = {
  type: 'LockupView',
  content_id: 'LKrwhjOI8Nc',
  content_type: 'VIDEO',
  metadata: {
    title: { text: "There's never been a better time to go into math" },
    metadata: {
      metadata_rows: [
        {
          metadata_parts: [
            { text: { text: '237万次观看' } },
            { text: { text: '5天前' } },
          ],
        },
      ],
    },
  },
  duration: { seconds: 2444, text: '40:44' },
};

describe('videoFromItem', () => {
  const context = {
    channelId: 'UCYO_jab_esuFRV4b17AJtAw',
    channelName: '3Blue1Brown',
    now: NOW,
  };

  it('reads a channel listing entry', () => {
    expect(videoFromItem(lockup, context)).toEqual({
      videoId: 'LKrwhjOI8Nc',
      channelId: 'UCYO_jab_esuFRV4b17AJtAw',
      channelName: '3Blue1Brown',
      title: "There's never been a better time to go into math",
      publishedAt: NOW - 5 * 86_400,
      publishedApprox: true,
      durationSeconds: 2444,
      viewCount: 2_370_000,
      viewText: '237万次观看',
    });
  });

  it('reads the older video entry and a playlist entry with its author', () => {
    const old = {
      type: 'Video',
      id: 'dQw4w9WgXcQ',
      title: { text: 'Never Gonna Give You Up' },
      short_view_count: { text: '1.5M views' },
      published: { text: '14 years ago' },
      duration: { text: '3:33' },
      author: { name: 'Rick Astley', id: 'UCuAXFkgsw1L7xaCfnd5JJOw' },
    };
    expect(videoFromItem(old, { now: NOW })).toMatchObject({
      videoId: 'dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
      channelName: 'Rick Astley',
      durationSeconds: 213,
      viewCount: 1_500_000,
      publishedAt: NOW - 14 * 365 * 86_400,
    });
  });

  it('has no duration for a live stream and keeps what else it knows', () => {
    const live = {
      ...lockup,
      duration: undefined,
      metadata: {
        title: { text: '直播中' },
        metadata: {
          metadata_rows: [
            { metadata_parts: [{ text: { text: '1.2万人正在观看' } }] },
          ],
        },
      },
    };
    const video = videoFromItem(live, context);
    expect(video?.durationSeconds).toBeNull();
    expect(video?.viewText).toBe('1.2万人正在观看');
    expect(video?.publishedAt).toBeNull();
    expect(video?.publishedApprox).toBe(false);
  });

  it('skips entries that are not videos', () => {
    expect(
      videoFromItem({ ...lockup, content_type: 'PLAYLIST' }, context),
    ).toBeNull();
    expect(
      videoFromItem({ ...lockup, content_id: 'short' }, context),
    ).toBeNull();
    expect(videoFromItem(null, context)).toBeNull();
    expect(videoFromItem('text', context)).toBeNull();
  });

  it('falls back to the id when the title is missing', () => {
    expect(videoFromItem({ ...lockup, metadata: {} }, context)?.title).toBe(
      'LKrwhjOI8Nc',
    );
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(83)).toBe('1:23');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(-5)).toBe('');
  });

  it('formats counts the Chinese way', () => {
    expect(formatCount(9999)).toBe('9999');
    // Three digits or more are rounded to a whole number of 万, as YouTube does.
    expect(formatCount(2_375_000)).toBe('238 万');
    expect(formatCount(23_750)).toBe('2.4 万');
    expect(formatCount(10_000)).toBe('1 万');
    expect(formatCount(120_000_000)).toBe('1.2 亿');
    expect(formatViews(1_500, null)).toBe('1500 次观看');
    expect(formatViews(null, '3.2万次观看')).toBe('3.2万次观看');
    expect(formatViews(null, null)).toBe('');
  });

  it('formats how long ago, marking approximations', () => {
    expect(formatAgo(NOW - 20, NOW)).toBe('刚刚');
    expect(formatAgo(NOW - 5 * 60, NOW)).toBe('5 分钟前');
    expect(formatAgo(NOW - 3 * 3600, NOW)).toBe('3 小时前');
    expect(formatAgo(NOW - 2 * 86_400, NOW)).toBe('2 天前');
    expect(formatAgo(NOW - 15 * 86_400, NOW)).toBe('2 周前');
    expect(formatAgo(NOW - 100 * 86_400, NOW)).toBe('3 个月前');
    expect(formatAgo(NOW - 800 * 86_400, NOW, true)).toBe('约 2 年前');
    expect(formatAgo(null, NOW)).toBe('');
  });

  it('takes the first character for a badge', () => {
    expect(initialOf('3Blue1Brown')).toBe('3');
    expect(initialOf('李永乐老师')).toBe('李');
    expect(initialOf('  cs50')).toBe('C');
    expect(initialOf('')).toBe('?');
  });
});

describe('watch state rules', () => {
  it('follows NewPipe: finished means under a minute left and three quarters played', () => {
    expect(isFinished(960, 1000)).toBe(true);
    expect(isFinished(500, 1000)).toBe(false);
    expect(isFinished(100, 400)).toBe(false);
    expect(isFinished(100, 120)).toBe(true);
    expect(isFinished(100, null)).toBe(false);
  });

  it('saves a position past five seconds or a quarter of the video', () => {
    expect(isWorthSaving(3, 1000)).toBe(false);
    expect(isWorthSaving(6, 1000)).toBe(true);
    expect(isWorthSaving(4, 10)).toBe(true);
    expect(isWorthSaving(Number.NaN, 10)).toBe(false);
    expect(isWorthSaving(-1, 10)).toBe(false);
  });

  it('starts a video at a whole second, because the embedded player ignores a fraction', () => {
    expect(startSecondsFor({ resumeSeconds: 8.908 })).toBe(8);
    expect(startSecondsFor({ resumeSeconds: 300 })).toBe(300);
    expect(startSecondsFor({ resumeSeconds: 0.4 })).toBe(0);
    expect(startSecondsFor({ resumeSeconds: 0 })).toBe(0);
    expect(startSecondsFor(null)).toBe(0);
    expect(startSecondsFor(undefined)).toBe(0);
    expect(startSecondsFor({ resumeSeconds: Number.NaN })).toBe(0);
    // What the player page hands to the embedded player (this was the bug: a fraction lost the start).
    const address = new URL(
      buildYouTubeEmbedUrl(
        'dQw4w9WgXcQ',
        startSecondsFor({ resumeSeconds: 8.908 }),
      ) ?? '',
    );
    expect(address.searchParams.get('start')).toBe('8');
    expect(
      new URL(
        buildYouTubeEmbedUrl('dQw4w9WgXcQ', 8.908) ?? '',
      ).searchParams.get('start'),
    ).toBeNull();
  });

  const item: VideoItem = {
    videoId: 'aaaaaaaaaaa',
    channelId: null,
    channelName: null,
    title: 't',
    publishedAt: null,
    publishedApprox: false,
    durationSeconds: null,
    viewCount: null,
    viewText: null,
    thumbnailUrl: null,
    progressSeconds: null,
    finished: false,
    lastPlayedAt: null,
    favorite: false,
    watchLater: false,
  };

  it('gives the share for the bar under a thumbnail', () => {
    expect(progressShare(item)).toBe(0);
    expect(
      progressShare({ ...item, progressSeconds: 30, durationSeconds: 120 }),
    ).toBe(0.25);
    expect(
      progressShare({ ...item, progressSeconds: 300, durationSeconds: 120 }),
    ).toBe(1);
    expect(progressShare({ ...item, finished: true })).toBe(1);
  });

  it('applies a saved state to a list item', () => {
    const updated = withWatchState(item, {
      progressSeconds: 50,
      durationSeconds: 100.4,
      finished: false,
      resumeSeconds: 50,
    });
    expect(updated).toMatchObject({
      progressSeconds: 50,
      finished: false,
      durationSeconds: 100,
    });
    expect(withWatchState(item, null)).toBe(item);
    // A duration that was already known is kept.
    expect(
      withWatchState(
        { ...item, durationSeconds: 90 },
        {
          progressSeconds: 1,
          durationSeconds: 100,
          finished: false,
          resumeSeconds: 1,
        },
      ).durationSeconds,
    ).toBe(90);
  });
});
