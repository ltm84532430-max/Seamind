import { describe, expect, it } from 'vitest';
import { outdatedChannels, refreshFeeds } from '../src/player/feed-manager';
import type { RefreshChannel } from '../src/player/feed-manager';

const NOW = 1_800_000_000;
const HOUR = 3600;

const channel = (
  id: string,
  lastCheckedAt: number | null,
  lastError: string | null = null,
): RefreshChannel => ({
  channelId: id,
  name: `频道 ${id}`,
  lastCheckedAt,
  lastError,
});

describe('outdatedChannels', () => {
  const channels = [
    channel('fresh', NOW - 10),
    channel('stale', NOW - 2 * HOUR),
    channel('never', null),
    channel('failed', NOW - 10, '网络超时'),
  ];

  it('keeps the channels never checked, failed last time, or checked too long ago', () => {
    expect(
      outdatedChannels(channels, NOW, HOUR).map((c) => c.channelId),
    ).toEqual(['stale', 'never', 'failed']);
  });

  it('checks the edge: exactly at the threshold counts as outdated', () => {
    expect(
      outdatedChannels([channel('edge', NOW - HOUR)], NOW, HOUR).map(
        (c) => c.channelId,
      ),
    ).toEqual(['edge']);
  });

  it('takes everything when forced, and a threshold of 0 means always', () => {
    expect(outdatedChannels(channels, NOW, HOUR, true)).toHaveLength(4);
    expect(outdatedChannels(channels, NOW, 0)).toHaveLength(4);
  });
});

function deferred() {
  let resolve: () => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('refreshFeeds', () => {
  const base = {
    now: NOW,
    thresholdSeconds: HOUR,
    shuffle: false,
    sleep: async () => {},
  };

  it('fetches the outdated channels and leaves the others', async () => {
    const fetched: string[] = [];
    const report = await refreshFeeds({
      ...base,
      channels: [channel('a', null), channel('b', NOW - 5), channel('c', null)],
      fetchFeed: async (id) => {
        fetched.push(id);
      },
    });
    expect(fetched.sort()).toEqual(['a', 'c']);
    expect(report).toMatchObject({
      checked: 2,
      skipped: 1,
      cancelled: false,
      failed: [],
    });
  });

  it('never has more than the allowed number of fetches running', async () => {
    const channels = Array.from({ length: 8 }, (_, index) =>
      channel(`c${index}`, null),
    );
    const pending: ReturnType<typeof deferred>[] = [];
    let running = 0;
    let peak = 0;
    const done = refreshFeeds({
      ...base,
      channels,
      concurrency: 3,
      fetchFeed: async () => {
        running += 1;
        peak = Math.max(peak, running);
        const gate = deferred();
        pending.push(gate);
        await gate.promise;
        running -= 1;
      },
    });
    await flush();
    expect(pending).toHaveLength(3);
    // Letting them finish one at a time starts the next channel each time.
    while (pending.length < 8 || running > 0) {
      pending.filter((gate) => gate).forEach((gate) => gate.resolve());
      await flush();
      if (pending.length >= 8 && running === 0) break;
    }
    const report = await done;
    expect(peak).toBe(3);
    expect(report.checked).toBe(8);
  });

  it('carries on after a failure and says which channel failed and why', async () => {
    const report = await refreshFeeds({
      ...base,
      channels: [channel('a', null), channel('b', null), channel('c', null)],
      concurrency: 1,
      fetchFeed: async (id) => {
        if (id === 'b') throw '连接 YouTube 超时。';
      },
    });
    expect(report.checked).toBe(2);
    expect(report.failed).toEqual([
      { channelId: 'b', name: '频道 b', message: '连接 YouTube 超时。' },
    ]);
  });

  it('waits a random while after every batch of channels', async () => {
    const sleeps: number[] = [];
    const channels = Array.from({ length: 7 }, (_, index) =>
      channel(`c${index}`, null),
    );
    await refreshFeeds({
      ...base,
      channels,
      concurrency: 1,
      batchSize: 3,
      batchDelayMs: () => 9000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      fetchFeed: async () => {},
    });
    // After the 3rd and the 6th channel, before the 4th and the 7th start.
    expect(sleeps).toEqual([9000, 9000]);
  });

  it('draws the pause between 6 and 12 seconds by default', async () => {
    const sleeps: number[] = [];
    await refreshFeeds({
      ...base,
      channels: Array.from({ length: 4 }, (_, index) =>
        channel(`c${index}`, null),
      ),
      concurrency: 1,
      batchSize: 2,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      fetchFeed: async () => {},
    });
    expect(sleeps).toEqual([9000]);
  });

  it('stops starting new channels once cancelled', async () => {
    const controller = new AbortController();
    const fetched: string[] = [];
    const report = await refreshFeeds({
      ...base,
      channels: Array.from({ length: 5 }, (_, index) =>
        channel(`c${index}`, null),
      ),
      concurrency: 1,
      signal: controller.signal,
      fetchFeed: async (id) => {
        fetched.push(id);
        if (fetched.length === 2) controller.abort();
      },
    });
    expect(fetched).toEqual(['c0', 'c1']);
    expect(report.cancelled).toBe(true);
    expect(report.checked).toBe(2);
  });

  it('shuffles the order unless told not to, using the random source it is given', async () => {
    const order: string[] = [];
    await refreshFeeds({
      now: NOW,
      thresholdSeconds: HOUR,
      sleep: async () => {},
      channels: ['a', 'b', 'c', 'd'].map((id) => channel(id, null)),
      concurrency: 1,
      random: () => 0,
      fetchFeed: async (id) => {
        order.push(id);
      },
    });
    expect(order).toEqual(['b', 'c', 'd', 'a']);
  });

  it('reports progress, starting from nothing done', async () => {
    const steps: string[] = [];
    await refreshFeeds({
      ...base,
      channels: [channel('a', null), channel('b', null)],
      concurrency: 1,
      onProgress: ({ done, total, channel: current }) =>
        steps.push(`${done}/${total}${current ? ` ${current.channelId}` : ''}`),
      fetchFeed: async () => {},
    });
    expect(steps).toEqual(['0/2', '1/2 a', '2/2 b']);
  });

  it('does nothing when nothing is outdated', async () => {
    let calls = 0;
    const report = await refreshFeeds({
      ...base,
      channels: [channel('a', NOW - 5)],
      fetchFeed: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(0);
    expect(report).toMatchObject({ checked: 0, skipped: 1 });
  });
});
