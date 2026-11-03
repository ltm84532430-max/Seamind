import { errorText } from './player-api';

export interface RefreshChannel {
  channelId: string;
  name: string;
  lastCheckedAt: number | null;
  lastError: string | null;
  lastAttemptedAt?: number | null;
}

export interface RefreshProgress {
  done: number;
  total: number;
  channel: RefreshChannel | null;
}

export interface RefreshFailure {
  channelId: string;
  name: string;
  message: string;
}

export interface RefreshReport {
  checked: number;
  failed: RefreshFailure[];
  /** Channels that were checked recently enough to leave alone. */
  skipped: number;
  cancelled: boolean;
}

export interface RefreshOptions {
  channels: RefreshChannel[];
  /** Unix seconds. */
  now: number;
  /** A channel checked more recently than this many seconds ago is left alone. */
  thresholdSeconds: number;
  /** Check every channel, whatever its last check. */
  force?: boolean;
  /** Fetches and stores one channel's videos; it rejects with the reason when that fails. */
  fetchFeed: (channelId: string) => Promise<unknown>;
  /** How many channels are fetched at the same time. NewPipe uses 3. */
  concurrency?: number;
  /** After this many channels the refresh waits a little, so YouTube is not hammered. */
  batchSize?: number;
  /** The wait, in milliseconds. NewPipe picks one between 6 and 12 seconds. */
  batchDelayMs?: () => number;
  /** Pause between individual channel fetches to avoid YouTube rate limiting (HTTP 429). */
  itemDelayMs?: number;
  /** Minimum delay before retrying a channel that previously had an error. */
  errorRetryThresholdSeconds?: number;
  /** Goes through the channels in a random order, as NewPipe does, unless turned off. */
  shuffle?: boolean;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (progress: RefreshProgress) => void;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

/**
 * The channels worth checking: those never checked, those whose last check failed (that is what
 * "outdated" means in NewPipe), and those last checked longer ago than the threshold.
 */
export function outdatedChannels(
  channels: RefreshChannel[],
  now: number,
  thresholdSeconds: number,
  force = false,
  errorRetryThresholdSeconds?: number,
): RefreshChannel[] {
  return channels.filter((channel) => {
    if (force) return true;
    if (channel.lastCheckedAt === null && !channel.lastAttemptedAt) return true;
    if (channel.lastError !== null) {
      if (
        typeof errorRetryThresholdSeconds === 'number' &&
        errorRetryThresholdSeconds > 0
      ) {
        const lastAttempt =
          channel.lastAttemptedAt ?? channel.lastCheckedAt ?? 0;
        return now - lastAttempt >= errorRetryThresholdSeconds;
      }
      return true;
    }
    return now - (channel.lastCheckedAt ?? 0) >= thresholdSeconds;
  });
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

/**
 * Brings the feed up to date the way NewPipe does: only outdated channels, a few at a time, a pause
 * after every batch, and a failing channel does not stop the others.
 */
export async function refreshFeeds(
  options: RefreshOptions,
): Promise<RefreshReport> {
  const random = options.random ?? Math.random;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const batchSize = Math.max(1, options.batchSize ?? 50);
  const batchDelayMs = options.batchDelayMs ?? (() => 6000 + random() * 6000);
  const itemDelayMs = options.itemDelayMs ?? 0;
  const sleep = options.sleep ?? defaultSleep;

  const due = outdatedChannels(
    options.channels,
    options.now,
    options.thresholdSeconds,
    options.force,
    options.errorRetryThresholdSeconds,
  );
  const queue = options.shuffle === false ? due : shuffled(due, random);
  const report: RefreshReport = {
    checked: 0,
    failed: [],
    skipped: options.channels.length - due.length,
    cancelled: false,
  };
  const total = queue.length;
  let started = 0;
  let done = 0;
  let pause: Promise<void> = Promise.resolve();
  options.onProgress?.({ done, total, channel: null });

  const worker = async () => {
    for (;;) {
      await pause;
      if (options.signal?.aborted) {
        report.cancelled = true;
        return;
      }
      const channel = queue[started];
      if (!channel) return;
      const currentIndex = started;
      started += 1;
      if (currentIndex > 0 && itemDelayMs > 0) {
        await sleep(itemDelayMs);
      }
      if (currentIndex > 0 && currentIndex % batchSize === 0)
        pause = sleep(batchDelayMs());
      try {
        await options.fetchFeed(channel.channelId);
        report.checked += 1;
      } catch (error) {
        report.failed.push({
          channelId: channel.channelId,
          name: channel.name,
          message: errorText(error, '更新失败'),
        });
      }
      done += 1;
      options.onProgress?.({ done, total, channel });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, worker),
  );
  return report;
}
