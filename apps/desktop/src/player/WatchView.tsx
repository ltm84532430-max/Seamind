import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProviderSettings } from '../agent/runtime';
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
import { notifyResourceProgress } from '../tasks/task-api';
import ResourceTaskLinks from '../tasks/ResourceTaskLinks';
import VideoList from './VideoList';
import {
  TranscriptPanel,
  SubtitleOverlay,
  type TranscriptCue,
  type TranscriptKnowledgeExportPayload,
  type TranscriptKnowledgeExportResult,
} from './transcript';

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
const QUEUE_COLLAPSED_KEY = 'seamind:player-queue-collapsed:v1';
const WATCH_TAB_KEY = 'seamind:watch-tab:v1';
const SUBTITLES_VISIBLE_KEY = 'seamind:watch-subtitles:v1';

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
  provider,
  backLabel,
  onBack,
  onSaved,
  onCreateTask,
  onOpenTask,
  onExportTranscriptToKnowledge,
}: {
  watching: Watching;
  /** Whether the player page is the workspace in front. */
  active: boolean;
  provider?: AgentProviderSettings;
  backLabel: string;
  onBack(): void;
  onSaved(videoId: string, state: WatchState): void;
  onCreateTask(item: VideoItem, startSeconds: number): void;
  onOpenTask(id: string): void;
  onExportTranscriptToKnowledge?(
    payload: TranscriptKnowledgeExportPayload,
  ): Promise<TranscriptKnowledgeExportResult | void>;
}) {
  const host = usePlayerHost();
  const { queue } = watching;
  const hasQueue = queue.items.length > 1;
  const videoId = watching.item.videoId;
  const item = applyOverlay(watching.item, host.overlay);
  const [handle, setHandle] = useState<YouTubePlayerHandle | null>(null);
  const [status, setStatus] = useState<YouTubePlaybackState>('loading');
  const [rate, setRate] = useState(readRate);
  const [assignedCategoryId, setAssignedCategoryId] = useState<string | null>(
    null,
  );
  const [queueCollapsed, setQueueCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(QUEUE_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [activeTab, setActiveTab] = useState<'queue' | 'transcript'>(() => {
    try {
      const saved = localStorage.getItem(WATCH_TAB_KEY);
      if (saved === 'queue' || saved === 'transcript') {
        if (saved === 'queue' && !hasQueue) return 'transcript';
        return saved;
      }
    } catch {
      // ignore
    }
    return hasQueue ? 'queue' : 'transcript';
  });

  const [subtitlesVisible, setSubtitlesVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SUBTITLES_VISIBLE_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  const [cues, setCues] = useState<TranscriptCue[]>([]);
  const [loopingCue, setLoopingCue] = useState<TranscriptCue | null>(null);
  const [shadowMode, setShadowMode] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(
    watching.startSeconds || 0,
  );
  const lastShadowPausedCueIdRef = useRef<string | null>(null);

  const switchTab = useCallback((tab: 'queue' | 'transcript') => {
    setActiveTab(tab);
    try {
      localStorage.setItem(WATCH_TAB_KEY, tab);
    } catch {
      // ignore
    }
  }, []);

  const toggleSubtitles = useCallback(() => {
    setSubtitlesVisible((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SUBTITLES_VISIBLE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const toggleQueue = useCallback(() => {
    setQueueCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(QUEUE_COLLAPSED_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
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
        if (state) {
          onSavedRef.current(videoId, state);
          notifyResourceProgress();
        }
      })
      .catch(() => undefined);
  }, [videoId]);

  useEffect(() => {
    let alive = true;
    void playerApi
      .favoritesSnapshot()
      .then((snapshot) => {
        if (!alive) return;
        const found = snapshot.items.find(
          (entry) => entry.video.videoId === videoId,
        );
        setAssignedCategoryId(found?.categoryId ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [videoId, item.favorite]);

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

  useEffect(() => {
    setLoopingCue(null);
    setCues([]);
    setCurrentTime(watching.startSeconds || 0);
    lastShadowPausedCueIdRef.current = null;
  }, [videoId, watching.token]);

  const jumpToRelativeCue = useCallback(
    (offset: -1 | 1) => {
      if (!cues.length || !handle) return;
      const cur = progressRef.current?.seconds ?? currentTime;
      const idx = cues.findIndex((c) => cur >= c.start && cur <= c.end + 0.35);
      let targetIdx = idx;
      if (idx === -1) {
        if (offset === 1) {
          targetIdx = cues.findIndex((c) => c.start > cur);
        } else {
          for (let i = cues.length - 1; i >= 0; i--) {
            if (cues[i].end < cur) {
              targetIdx = i;
              break;
            }
          }
        }
      } else {
        targetIdx = idx + offset;
      }
      if (targetIdx >= 0 && targetIdx < cues.length) {
        const targetCue = cues[targetIdx];
        handle.seekTo(targetCue.start);
        setCurrentTime(targetCue.start);
        host.notify(
          `跳转句 [${targetIdx + 1}/${cues.length}]: ${targetCue.text.slice(0, 32)}...`,
        );
      }
    },
    [cues, currentTime, handle, host],
  );

  const toggleSentenceLoop = useCallback(
    (targetCue?: TranscriptCue | null) => {
      if (targetCue !== undefined) {
        setLoopingCue(targetCue);
        if (targetCue) {
          host.notify(`已开启单句循环: ${targetCue.text.slice(0, 32)}...`);
        } else {
          host.notify('已退出单句循环');
        }
        return;
      }
      if (loopingCue) {
        setLoopingCue(null);
        host.notify('已退出单句循环');
        return;
      }
      const cur = progressRef.current?.seconds ?? currentTime;
      const active = cues.find((c) => cur >= c.start && cur <= c.end + 0.35);
      if (active) {
        setLoopingCue(active);
        host.notify(`已开启单句循环: ${active.text.slice(0, 32)}...`);
      } else {
        host.notify('当前播放时间未匹配到台词句子');
      }
    },
    [cues, currentTime, loopingCue, host],
  );

  const handleProgress = (progress: PlayerProgress) => {
    progressRef.current = progress;
    setCurrentTime(progress.seconds);

    // Sentence repeat loop check
    if (loopingCue && progress.playing) {
      if (progress.seconds >= loopingCue.end) {
        handle?.seekTo(loopingCue.start);
      }
    }

    // Shadowing mode auto-pause check
    if (shadowMode && cues.length > 0 && progress.playing) {
      const cur = progress.seconds;
      const matchingCue = cues.find(
        (c) => cur >= c.start && cur <= c.end + 0.2,
      );
      if (matchingCue && cur >= matchingCue.end - 0.25) {
        if (lastShadowPausedCueIdRef.current !== matchingCue.id) {
          lastShadowPausedCueIdRef.current = matchingCue.id;
          handle?.pause();
          host.notify('跟读模式：句子已结束，请跟读；按空格继续播放');
        }
      }
    }

    if (!progress.playing || Date.now() - savedAtRef.current >= SAVE_EVERY_MS)
      save();
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target?.isContentEditable
      ) {
        return;
      }

      if (e.key === '[') {
        e.preventDefault();
        jumpToRelativeCue(-1);
      } else if (e.key === ']') {
        e.preventDefault();
        jumpToRelativeCue(1);
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        toggleSentenceLoop();
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        toggleSubtitles();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [jumpToRelativeCue, toggleSentenceLoop, toggleSubtitles]);

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
      className={`player-watch${queueCollapsed ? ' is-queue-collapsed' : ''}`}
      aria-label="正在播放"
    >
      <div className="player-watch-main">
        <div className="player-watch-bar">
          <ResourceTaskLinks
            kind="youtube"
            identity={item.videoId}
            onOpenTask={onOpenTask}
          />
          <button type="button" className="player-button" onClick={onBack}>
            <BackIcon />
            {backLabel}
          </button>
          <button
            type="button"
            className="player-button"
            onClick={() => onCreateTask(item, currentTime)}
          >
            添加任务
          </button>
        </div>
        <YouTubePlayerPanel
          selection={selection}
          variant="page"
          onProgress={handleProgress}
          onStatusChange={setStatus}
          onEnded={handleEnded}
          onHandle={setHandle}
        >
          <SubtitleOverlay
            cues={cues}
            currentTime={currentTime}
            visible={subtitlesVisible}
          />
        </YouTubePlayerPanel>
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
            {item.favorite && host.favoriteCategories.length > 0 && (
              <label className="player-watch-category-select">
                <span>分类</span>
                <select
                  value={assignedCategoryId ?? ''}
                  onChange={(e) => {
                    const nextId = e.target.value || null;
                    setAssignedCategoryId(nextId);
                    void host.assignFavoriteCategory(item, nextId);
                  }}
                >
                  <option value="">未分类</option>
                  {host.favoriteCategories.map((c) => (
                    <option key={c.categoryId} value={c.categoryId}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
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

            {/* 字幕显示/隐藏切换 */}
            <button
              type="button"
              className={`player-button${subtitlesVisible ? ' is-on' : ''}`}
              aria-pressed={subtitlesVisible}
              onClick={toggleSubtitles}
              title="切换画面双语字幕显示 (快捷键 C)"
            >
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                aria-hidden="true"
              >
                <rect
                  x="2"
                  y="3.5"
                  width="12"
                  height="9"
                  rx="1.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M5 8h2M5 10h1.5M9 8h2M9 10h2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              {subtitlesVisible ? '字幕开' : '字幕关'}
            </button>

            {/* 单句循环指示/取消 */}
            {loopingCue && (
              <button
                type="button"
                className="player-button is-on"
                onClick={() => toggleSentenceLoop(null)}
                title="正在单句循环，点击退出 (快捷键 R)"
              >
                🔁 循环中
              </button>
            )}

            {/* 影子跟读指示/取消 */}
            {shadowMode && (
              <button
                type="button"
                className="player-button is-on"
                onClick={() => setShadowMode(false)}
                title="影子跟读已开启，点击退出"
              >
                🗣️ 跟读中
              </button>
            )}

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
      <aside
        className={`player-watch-queue${queueCollapsed ? ' is-collapsed' : ''}`}
        aria-label="播放队列与视频字幕"
      >
        <header>
          {!queueCollapsed ? (
            <>
              {hasQueue ? (
                <div className="player-watch-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'queue'}
                    className={`player-watch-tab${activeTab === 'queue' ? ' is-active' : ''}`}
                    onClick={() => switchTab('queue')}
                  >
                    播放队列 ({queue.items.length})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'transcript'}
                    className={`player-watch-tab${activeTab === 'transcript' ? ' is-active' : ''}`}
                    onClick={() => switchTab('transcript')}
                  >
                    台词 / 字幕
                  </button>
                </div>
              ) : (
                <div className="player-watch-tabs">
                  <span className="player-watch-tab is-active is-static">
                    视频台词 / 字幕
                  </span>
                </div>
              )}
              <div className="player-watch-queue-controls">
                {hasQueue && activeTab === 'queue' && (
                  <span>
                    {position >= 0 ? `${position + 1}/` : ''}
                    {queue.items.length}
                  </span>
                )}
                <button
                  type="button"
                  className="player-queue-toggle-btn"
                  onClick={toggleQueue}
                  title="收起侧边栏 (扩大播放窗口)"
                  aria-label="收起侧边栏"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="13"
                    height="13"
                    aria-hidden="true"
                  >
                    <path
                      d="M6 3l5 5-5 5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="player-queue-toggle-btn is-collapsed"
              onClick={toggleQueue}
              title="展开侧边栏"
              aria-label="展开侧边栏"
            >
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                aria-hidden="true"
              >
                <path
                  d="M10 3L5 8l5 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </header>
        {!queueCollapsed && (
          <>
            {hasQueue && activeTab === 'queue' ? (
              <div ref={queueListRef} className="player-watch-queue-list">
                <VideoList
                  items={queue.items}
                  queueTitle={queue.title}
                  activeId={videoId}
                  compact
                />
              </div>
            ) : (
              <TranscriptPanel
                videoId={videoId}
                videoTitle={item.title}
                channelName={item.channelName}
                provider={provider}
                currentTime={currentTime}
                onSeek={(sec) => {
                  handle?.seekTo(sec);
                  setCurrentTime(sec);
                }}
                onToggleLoopCue={toggleSentenceLoop}
                loopingCueId={loopingCue?.id}
                onToggleShadowMode={setShadowMode}
                shadowMode={shadowMode}
                onShowNotice={host.notify}
                onCuesLoaded={setCues}
                onExportToKnowledge={onExportTranscriptToKnowledge}
              />
            )}
          </>
        )}
      </aside>
    </section>
  );
}
