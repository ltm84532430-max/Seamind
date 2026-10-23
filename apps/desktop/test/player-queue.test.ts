import { describe, expect, it } from 'vitest';
import { avatarHue, formatClock, initialOf } from '../src/player/format';
import {
  applyOverlay,
  firstUnfinished,
  inputFromItem,
  nextVideo,
  patchOverlay,
  sortChannels,
  withOverlay,
} from '../src/player/queue';
import type { PlayerChannel, VideoItem } from '../src/player/types';

function item(id: string, extra: Partial<VideoItem> = {}): VideoItem {
  return {
    videoId: id,
    channelId: null,
    channelName: null,
    title: `video ${id}`,
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
    ...extra,
  };
}

function channel(id: string, name: string): PlayerChannel {
  return {
    channelId: id,
    name,
    handle: null,
    avatarUrl: null,
    description: null,
    subscribedAt: 0,
    lastCheckedAt: null,
    lastError: null,
  };
}

describe('the overlay of what the user did with videos', () => {
  it('lays a patch over the matching video only', () => {
    const overlay = patchOverlay({}, 'a', { favorite: true });
    expect(applyOverlay(item('a'), overlay).favorite).toBe(true);
    expect(applyOverlay(item('b'), overlay).favorite).toBe(false);
  });

  it('keeps earlier patches of a video when another is added', () => {
    let overlay = patchOverlay({}, 'a', { favorite: true });
    overlay = patchOverlay(overlay, 'a', { finished: true });
    expect(overlay.a).toEqual({ favorite: true, finished: true });
  });

  it('lets a later patch undo an earlier one', () => {
    let overlay = patchOverlay({}, 'a', {
      finished: true,
      progressSeconds: 90,
    });
    overlay = patchOverlay(overlay, 'a', {
      finished: false,
      progressSeconds: null,
    });
    const shown = applyOverlay(item('a', { finished: true }), overlay);
    expect(shown.finished).toBe(false);
    expect(shown.progressSeconds).toBeNull();
  });

  it('returns the very same item when there is nothing to lay over it', () => {
    const original = item('a');
    expect(applyOverlay(original, {})).toBe(original);
    expect(withOverlay([original], {})[0]).toBe(original);
  });

  it('does not change the overlay it was given', () => {
    const before = patchOverlay({}, 'a', { favorite: true });
    patchOverlay(before, 'a', { favorite: false });
    expect(before.a.favorite).toBe(true);
  });
});

describe('moving through a list', () => {
  const list = [item('a'), item('b', { finished: true }), item('c')];

  it('plays on with the video after the current one', () => {
    expect(nextVideo(list, 'a')?.videoId).toBe('b');
    expect(nextVideo(list, 'b')?.videoId).toBe('c');
  });

  it('stops at the end of the list and for a video that is not in it', () => {
    expect(nextVideo(list, 'c')).toBeNull();
    expect(nextVideo(list, 'zzz')).toBeNull();
  });

  it('carries on a course at the first lesson not watched yet', () => {
    expect(firstUnfinished(list)?.videoId).toBe('a');
    expect(
      firstUnfinished([item('a', { finished: true }), item('b')])?.videoId,
    ).toBe('b');
    expect(firstUnfinished([item('a', { finished: true })])).toBeNull();
  });
});

describe('saving a video again', () => {
  it('hands the database what it needs to know the video', () => {
    const input = inputFromItem(
      item('a', {
        channelId: 'UC' + 'x'.repeat(22),
        channelName: 'Some channel',
        durationSeconds: 125,
        publishedAt: 1_700_000_000,
        publishedApprox: true,
        favorite: true,
        progressSeconds: 30,
      }),
    );
    expect(input).toEqual({
      videoId: 'a',
      channelId: 'UC' + 'x'.repeat(22),
      channelName: 'Some channel',
      title: 'video a',
      publishedAt: 1_700_000_000,
      publishedApprox: true,
      durationSeconds: 125,
      viewCount: null,
      viewText: null,
      thumbnailUrl: null,
    });
  });
});

describe('listing the followed channels', () => {
  it('orders Chinese names by pinyin and Latin names by letter, ignoring case', () => {
    const names = sortChannels([
      channel('UC3', '张三'),
      channel('UC1', 'beta'),
      channel('UC2', '阿里'),
      channel('UC4', 'Alpha'),
    ]).map((entry) => entry.name);
    // Where Chinese names go relative to Latin ones is up to the locale's collation.
    expect(names.indexOf('阿里')).toBeLessThan(names.indexOf('张三'));
    expect(names.indexOf('Alpha')).toBeLessThan(names.indexOf('beta'));
  });

  it('keeps channels with the same name in a fixed order', () => {
    const names = sortChannels([
      channel('UC2', 'same'),
      channel('UC1', 'same'),
    ]).map((entry) => entry.channelId);
    expect(names).toEqual(['UC1', 'UC2']);
  });

  it('does not reorder the list it was given', () => {
    const channels = [channel('UC2', 'b'), channel('UC1', 'a')];
    sortChannels(channels);
    expect(channels.map((entry) => entry.name)).toEqual(['b', 'a']);
  });
});

describe('the round badge of a channel without a picture', () => {
  it('shows the first character, in capitals for Latin letters', () => {
    expect(initialOf('3Blue1Brown')).toBe('3');
    expect(initialOf('  veritasium')).toBe('V');
    expect(initialOf('李永乐老师')).toBe('李');
    expect(initialOf('')).toBe('?');
  });

  it('gives the same hue for the same name and always a valid one', () => {
    expect(avatarHue('Veritasium')).toBe(avatarHue('Veritasium'));
    for (const name of ['', 'a', '李永乐老师', 'Kurzgesagt – In a Nutshell']) {
      const hue = avatarHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
    expect(avatarHue('Veritasium')).not.toBe(avatarHue('Kurzgesagt'));
  });
});

describe('a position in a video', () => {
  it('is written as a clock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(83)).toBe('1:23');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});
