import { useState } from 'react';
import { CheckIcon, ClockIcon, StarIcon } from './icons';
import { formatAgo, formatDate, formatDuration, formatViews } from './format';
import type { VideoItem } from './types';
import { progressShare } from './watch-state';
import { thumbnailUrl } from './video-links';

/** How many more times a thumbnail that failed to load is asked for. */
const THUMBNAIL_RETRIES = 2;

export interface VideoRowActions {
  onOpen(item: VideoItem): void;
  onToggleFavorite(item: VideoItem): void;
  onToggleWatchLater(item: VideoItem): void;
  onToggleWatched(item: VideoItem): void;
  onOpenChannel?(channelId: string): void;
  /** An extra action for lists that can drop an entry, such as the history. */
  onRemove?: { label: string; run(item: VideoItem): void };
}

interface VideoRowProps extends VideoRowActions {
  item: VideoItem;
  /** Unix seconds, for "3 days ago". */
  now: number;
  /** The video that is playing now. */
  active?: boolean;
  /** The narrow form used for the queue beside the player. */
  compact?: boolean;
  /** Whether to name the channel; a channel's own page has no need to. */
  showChannel?: boolean;
}

export default function VideoRow({
  item,
  now,
  active = false,
  compact = false,
  showChannel = true,
  onOpen,
  onToggleFavorite,
  onToggleWatchLater,
  onToggleWatched,
  onOpenChannel,
  onRemove,
}: VideoRowProps) {
  const [pictureFailed, setPictureFailed] = useState(false);
  // A thumbnail that failed to load (a flaky connection drops one now and then) is asked for again
  // a little later, with a different address so the failure is not served from the cache.
  const [pictureTries, setPictureTries] = useState(0);
  const share = progressShare(item);
  const duration = formatDuration(item.durationSeconds);
  const published = formatAgo(item.publishedAt, now, item.publishedApprox);
  const views = formatViews(item.viewCount, item.viewText);
  const meta = [views, published].filter(Boolean).join(' · ');

  return (
    <li
      className={`player-video${compact ? ' is-compact' : ''}${active ? ' is-active' : ''}${item.finished ? ' is-finished' : ''}`}
    >
      <button
        type="button"
        className="player-video-open"
        onClick={() => onOpen(item)}
        title={`播放：${item.title}`}
      >
        <span className="player-video-thumb">
          {pictureFailed ? (
            <span className="player-video-nopicture" aria-hidden="true">
              ▶
            </span>
          ) : (
            <img
              src={`${thumbnailUrl(item.videoId)}${pictureTries > 0 ? `?retry=${pictureTries}` : ''}`}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => {
                if (pictureTries >= THUMBNAIL_RETRIES) setPictureFailed(true);
                else
                  window.setTimeout(
                    () => setPictureTries((tries) => tries + 1),
                    1500 * (pictureTries + 1),
                  );
              }}
            />
          )}
          {duration && (
            <span className="player-video-duration">{duration}</span>
          )}
          {item.finished && (
            <span className="player-video-watched" aria-label="已看完">
              已看完
            </span>
          )}
          {share > 0 && !item.finished && (
            <span className="player-video-progress" aria-hidden="true">
              <span style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
          )}
          {active && <span className="player-video-now">正在播放</span>}
        </span>
        <span className="player-video-text">
          <strong className="player-video-title">{item.title}</strong>
          {!compact && showChannel && item.channelName && (
            <span className="player-video-channel">{item.channelName}</span>
          )}
          {meta && (
            <span
              className="player-video-meta"
              title={
                item.publishedAt && !item.publishedApprox
                  ? formatDate(item.publishedAt)
                  : undefined
              }
            >
              {compact && item.channelName ? `${item.channelName} · ` : ''}
              {meta}
            </span>
          )}
        </span>
      </button>
      <span className="player-video-actions">
        {!compact && showChannel && item.channelId && onOpenChannel && (
          <button
            type="button"
            className="player-text-button"
            onClick={() => onOpenChannel(item.channelId as string)}
            title="打开频道"
          >
            频道
          </button>
        )}
        <button
          type="button"
          className={`player-icon-button${item.favorite ? ' is-on' : ''}`}
          aria-pressed={item.favorite}
          title={item.favorite ? '取消收藏' : '收藏'}
          aria-label={item.favorite ? '取消收藏' : '收藏'}
          onClick={() => onToggleFavorite(item)}
        >
          <StarIcon filled={item.favorite} />
        </button>
        <button
          type="button"
          className={`player-icon-button${item.watchLater ? ' is-on' : ''}`}
          aria-pressed={item.watchLater}
          title={item.watchLater ? '从稍后看移除' : '稍后看'}
          aria-label={item.watchLater ? '从稍后看移除' : '稍后看'}
          onClick={() => onToggleWatchLater(item)}
        >
          <ClockIcon filled={item.watchLater} />
        </button>
        <button
          type="button"
          className={`player-icon-button${item.finished ? ' is-on' : ''}`}
          aria-pressed={item.finished}
          title={item.finished ? '标记为未看' : '标记为已看'}
          aria-label={item.finished ? '标记为未看' : '标记为已看'}
          onClick={() => onToggleWatched(item)}
        >
          <CheckIcon filled={item.finished} />
        </button>
        {onRemove && (
          <button
            type="button"
            className="player-text-button"
            onClick={() => onRemove.run(item)}
          >
            {onRemove.label}
          </button>
        )}
      </span>
    </li>
  );
}
