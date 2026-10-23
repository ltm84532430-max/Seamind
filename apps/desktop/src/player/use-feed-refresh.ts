import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshFeeds } from './feed-manager';
import type { RefreshReport } from './feed-manager';
import { playerApi } from './player-api';
import type { PlayerChannel } from './types';

export interface FeedRefreshState {
  running: boolean;
  done: number;
  total: number;
  /** The channel checked most recently, for the progress line. */
  lastChannel: string | null;
  /** How the last refresh went; null until one has finished. */
  report: RefreshReport | null;
}

const IDLE: FeedRefreshState = {
  running: false,
  done: 0,
  total: 0,
  lastChannel: null,
  report: null,
};

/** The feed list is reloaded at most this often while a refresh is under way. */
const RELOAD_EVERY_MS = 2000;

interface Options {
  channels: PlayerChannel[];
  thresholdSeconds: number;
  /** New videos arrived; the lists showing them should be read again. */
  onNewVideos(): void;
  /** The refresh ended, so the channels' last-checked marks have changed. */
  onFinished(report: RefreshReport): void;
}

/** Brings the feed up to date, a channel at a time, and reports how far it got. */
export function useFeedRefresh(options: Options) {
  const [state, setState] = useState<FeedRefreshState>(IDLE);
  const latest = useRef(options);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async (force: boolean) => {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const { channels, thresholdSeconds } = latest.current;
    setState({ ...IDLE, running: true });
    let arrived = false;
    let reloadedAt = 0;
    try {
      const report = await refreshFeeds({
        channels,
        now: Math.floor(Date.now() / 1000),
        thresholdSeconds,
        force,
        signal: controller.signal,
        fetchFeed: async (channelId) => {
          const result = await playerApi.fetchFeed(channelId);
          if (result.newVideoIds.length > 0) arrived = true;
          return result;
        },
        onProgress: (progress) => {
          setState((previous) => ({
            ...previous,
            done: progress.done,
            total: progress.total,
            lastChannel: progress.channel?.name ?? previous.lastChannel,
          }));
          if (arrived && Date.now() - reloadedAt >= RELOAD_EVERY_MS) {
            arrived = false;
            reloadedAt = Date.now();
            latest.current.onNewVideos();
          }
        },
      });
      if (arrived) latest.current.onNewVideos();
      setState({
        running: false,
        done: report.checked + report.failed.length,
        total: report.checked + report.failed.length,
        lastChannel: null,
        report,
      });
      latest.current.onFinished(report);
    } catch {
      setState(IDLE);
    } finally {
      abortRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  return { state, start, cancel };
}
