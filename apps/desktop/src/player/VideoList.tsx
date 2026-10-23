import { useMemo } from 'react';
import type { ReactNode } from 'react';
import VideoRow from './VideoRow';
import { usePlayerHost } from './host';
import { withOverlay } from './queue';
import type { VideoItem } from './types';
import { WarningIcon } from './icons';

/** The videos of one list. Opening one plays on down this list when it ends. */
export default function VideoList({
  items,
  queueTitle,
  activeId = null,
  compact = false,
  showChannel = true,
  onRemove,
}: {
  items: VideoItem[];
  queueTitle: string;
  activeId?: string | null;
  compact?: boolean;
  /** Whether each row names its channel; a channel's own page leaves that out. */
  showChannel?: boolean;
  onRemove?: { label: string; run(item: VideoItem): void };
}) {
  const host = usePlayerHost();
  const rows = useMemo(
    () => withOverlay(items, host.overlay),
    [items, host.overlay],
  );
  return (
    <ul className={`player-video-list${compact ? ' is-compact' : ''}`}>
      {rows.map((item) => (
        <VideoRow
          key={item.videoId}
          item={item}
          now={host.now}
          active={item.videoId === activeId}
          compact={compact}
          showChannel={showChannel}
          onOpen={(chosen) =>
            host.openVideo(chosen, { title: queueTitle, items })
          }
          onToggleFavorite={host.toggleFavorite}
          onToggleWatchLater={host.toggleWatchLater}
          onToggleWatched={host.toggleWatched}
          onOpenChannel={host.openChannel}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}

/** The title bar of a list: a heading, a line of facts and the things that can be done with it. */
export function ViewHeader({
  title,
  subtitle,
  leading,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="player-view-header">
      {leading}
      <div className="player-view-heading">
        <h2 title={title}>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="player-view-actions">{actions}</div>}
    </header>
  );
}

/** What a list shows in place of videos: that it is loading, that it is empty, or what went wrong. */
export function StateMessage({
  kind,
  title,
  children,
  action,
}: {
  kind: 'loading' | 'empty' | 'error';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={`player-state is-${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {kind === 'error' && (
        <span className="player-state-icon">
          <WarningIcon />
        </span>
      )}
      {kind === 'loading' && (
        <span className="player-state-spinner" aria-hidden="true" />
      )}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div className="player-state-action">{action}</div>}
    </div>
  );
}
