import type { VideoItem, WatchState } from './types';

/** NewPipe's rule, as `player_store.rs` applies it: with less than this left... */
const FINISHED_REMAINING_SECONDS = 60;
/** ...and at least this share played, a video counts as watched. */
const FINISHED_SHARE = 0.75;
/** A position is only worth keeping once it passed this many seconds (or a quarter of the video). */
export const SAVE_THRESHOLD_SECONDS = 5;

/** Whether a position in a video of this length counts as having watched it. */
export function isFinished(
  progressSeconds: number,
  durationSeconds: number | null | undefined,
): boolean {
  if (!durationSeconds || durationSeconds <= 0) return false;
  return (
    progressSeconds >= durationSeconds - FINISHED_REMAINING_SECONDS &&
    progressSeconds >= durationSeconds * FINISHED_SHARE
  );
}

/** Whether a position is worth saving at all. */
export function isWorthSaving(
  progressSeconds: number,
  durationSeconds: number | null | undefined,
): boolean {
  if (!Number.isFinite(progressSeconds) || progressSeconds < 0) return false;
  return (
    progressSeconds > SAVE_THRESHOLD_SECONDS ||
    (!!durationSeconds && progressSeconds > durationSeconds / 4)
  );
}

/**
 * Where a video starts: the saved position in whole seconds. The positions the players report have
 * fractions, and the embedded player's `start` address parameter only takes whole seconds (a
 * fraction is dropped and the video starts from the beginning), so the page rounds down.
 */
export function startSecondsFor(
  state: Pick<WatchState, 'resumeSeconds'> | null | undefined,
): number {
  const seconds = state?.resumeSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.floor(seconds)
    : 0;
}

/** How much of the video was played, 0 to 1, for the bar under a thumbnail. */
export function progressShare(
  item: Pick<VideoItem, 'progressSeconds' | 'durationSeconds' | 'finished'>,
): number {
  if (item.finished) return 1;
  if (!item.progressSeconds || !item.durationSeconds) return 0;
  return Math.min(1, Math.max(0, item.progressSeconds / item.durationSeconds));
}

/** The list item with a freshly saved state applied, so a list can update without being reloaded. */
export function withWatchState(
  item: VideoItem,
  state: WatchState | null,
): VideoItem {
  if (!state) return item;
  return {
    ...item,
    progressSeconds: state.progressSeconds,
    finished: state.finished,
    durationSeconds:
      item.durationSeconds ??
      (state.durationSeconds ? Math.round(state.durationSeconds) : null),
  };
}
