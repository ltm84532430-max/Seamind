import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import YouTubePlayerPanel from '../YouTubePlayerPanel';
import type {
  PlayerProgress,
  YouTubePlayerHandle,
} from '../YouTubePlayerPanel';
import type { YouTubePlaybackState } from '../youtube-player';
import { formatAgo, formatDate, formatViews } from './format';
import { usePlayerHost } from './host';
import { BackIcon, CheckIcon, ClockIcon, StarIcon } from './icons';
import { playerApi } from './player-api';
import { applyOverlay, nextVideo } from './queue';
import type { QueueSource } from './queue';
import type { VideoItem, WatchState } from './types';
import { isWorthSaving } from './watch-state';
import VideoList from './VideoList';

/** The video being played, the list it came from and where it starts. */
export interface Watching {
  item: VideoItem;
  queue: QueueSource;
  startSeconds: number;
  /** Counts up with every opening, so opening the same video again starts it afresh. */
  token: number;
}

/** While playing, the position is written down this often. */
const SAVE_EVERY_MS = 10_000;
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = 'seamind:player-rate:v1';

function readRate(): number {
  try {
    const stored = Number(localStorage.getItem(RATE_KEY));
    return RATES.includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

function rememberRate(rate: number) {
  try {
    localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // The speed is only forgotten when the app closes.
  }
}

/** The player with the video's details, and the rest of its list beside it. */
export default function WatchView({
  watching,
  active,
  backLabel,
  onBack,
  onSaved,
}: {
  watching: Watching;
  /** Whether the player page is the workspace in front. */
  active: boolean;
  backLabel: string;
  onBack(): void;
  onSaved(videoId: string, state: WatchState): void;
}) {
  const host = usePlayerHost();
  const { queue } = watching;
  const videoId = watching.item.videoId;
  const item = applyOverlay(watching.item, host.overlay);
  const [handle, setHandle] = useState<YouTubePlayerHandle | null>(null);
  const [status, setStatus] = useState<YouTubePlaybackState>('loading');
  const [rate, setRate] = useState(readRate);
  const progressRef = useRef<PlayerProgress | null>(null);
  const savedAtRef = useRef(0);
  const onSavedRef = useRef(onSaved);
  const queueListRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });

  const selection = useMemo(
    () => ({
      id: videoId,
      title: watching.item.title,
      startSeconds: watching.startSeconds,
    }),
    // One selection per opening: the panel reads where to start only when it appears.
    [watching.token],
  );

  const save = useCallback(() => {
    const progress = progressRef.current;
    if (!progress) return;
    savedAtRef.current = Date.now();
    if (!isWorthSaving(progress.seconds, progress.duration)) return;
    playerApi
      .saveProgress(videoId, progress.seconds, progress.duration)
      .then((state) => {
        if (state) onSavedRef.current(videoId, state);
      })
      .catch(() => undefined);
  }, [videoId]);

  useEffect(() => () => save(), [save]);
  useEffect(() => {
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [save]);

  // Leaving the page stops the video, unless the user wants to listen on while working elsewhere.
  useEffect(() => {
    if (active) return;
    save();
    if (host.settings.pauseWhenHidden) handle?.pause();
  }, [active]);

  useEffect(() => {
    if (!handle) return;
    if (status !== 'playing' && status !== 'ready' && status !== 'paused')
      return;
    if (Math.abs(handle.getPlaybackRate() - rate) > 0.001)
      handle.setPlaybackRate(rate);
  }, [handle, status, rate]);

  useEffect(() => {
    const list = queueListRef.current;
    const row = list?.querySelector<HTMLElement>('.player-video.is-active');
    if (list && row)
      list.scrollTo({
        top: Math.max(0, row.offsetTop - list.clientHeight / 3),
      });
  }, [videoId]);

  const handleProgress = (progress: PlayerProgress) => {
    progressRef.current = progress;
    if (!progress.playing || Date.now() - savedAtRef.current >= SAVE_EVERY_MS)
      save();
  };

  const handleEnded = () => {
    save();
    if (!host.settings.autoplayNext) return;
    const next = nextVideo(queue.items, videoId);
    if (!next) return;
    host.notify(`接下来播放：${next.title}`);
    host.openVideo(next, queue);
  };

  const position = queue.items.findIndex((entry) => entry.videoId === videoId);
  const meta = [
    formatViews(item.viewCount, item.viewText),
    formatAgo(item.publishedAt, host.now, item.publishedApprox),
  ].filter(Boolean);

  return (
    <section
      className={`player-watch${queue.items.length > 1 ? '' : ' is-single'}`}
      aria-label="正在播放"
    >
      <div className="player-watch-main">
        <div className="player-watch-bar">
          <button type="button" className="player-button" onClick={onBack}>
            <BackIcon />
            {backLabel}
          </button>
        </div>
        <YouTubePlayerPanel
          selection={selection}
          variant="page"
          onProgress={handleProgress}
          onStatusChange={setStatus}
          onEnded={handleEnded}
          onHandle={setHandle}
        />
        <div className="player-watch-info">
          <h2 title={item.title}>{item.title}</h2>
          <p className="player-watch-meta">
            {item.channelName &&
              (item.channelId ? (
                <button
                  type="button"
                  className="player-text-button"
                  onClick={() => host.openChannel(item.channelId as string)}
                >
                  {item.channelName}
                </button>
              ) : (
                <span>{item.channelName}</span>
              ))}
            {meta.length > 0 && (
              <span
                title={
                  item.publishedAt && !item.publishedApprox
                    ? formatDate(item.publishedAt)
                    : undefined
                }
              >
                {meta.join(' · ')}
              </span>
            )}
          </p>
          <div className="player-watch-actions">
            <button
              type="button"
              className={`player-button${item.favorite ? ' is-on' : ''}`}
              aria-pressed={item.favorite}
              onClick={() => host.toggleFavorite(item)}
            >
              <StarIcon filled={item.favorite} />
              {item.favorite ? '已收藏' : '收藏'}
            </button>
            <button
              type="button"
              className={`player-button${item.watchLater ? ' is-on' : ''}`}
              aria-pressed={item.watchLater}
              onClick={() => host.toggleWatchLater(item)}
            >
              <ClockIcon filled={item.watchLater} />
              {item.watchLater ? '已加入稍后看' : '稍后看'}
            </button>
            <button
              type="button"
              className={`player-button${item.finished ? ' is-on' : ''}`}
              aria-pressed={item.finished}
              onClick={() => host.toggleWatched(item)}
            >
              <CheckIcon filled={item.finished} />
              {item.finished ? '已看完' : '标记已看'}
            </button>
            <label className="player-rate">
              倍速
              <select
                value={rate}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setRate(next);
                  rememberRate(next);
                }}
              >
                {RATES.map((value) => (
                  <option key={value} value={value}>
                    {value}×
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>
      {queue.items.length > 1 && (
        <aside className="player-watch-queue" aria-label="播放队列">
          <header>
            <strong title={queue.title}>{queue.title}</strong>
            <span>
              {position >= 0 ? `${position + 1}/` : ''}
              {queue.items.length}
            </span>
          </header>
          <div ref={queueListRef} className="player-watch-queue-list">
            <VideoList
              items={queue.items}
              queueTitle={queue.title}
              activeId={videoId}
              compact
            />
          </div>
        </aside>
      )}
    </section>
  );
}
