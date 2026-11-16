import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProviderSettings } from '../agent/runtime';
import {
  useGlobalMediaOptional,
  type ActiveVideoMeta,
  type MediaPlayStatus,
} from '../media/global-media-store';
import YouTubePlayerPanel from './YouTubePlayerPanel';
import type { PlayerProgress, YouTubePlayerHandle } from './YouTubePlayerPanel';
import type { YouTubePlaybackState } from './youtube-player';
import { formatAgo, formatDuration } from './format';
import { usePlayerHost } from './host';
import { BackIcon, CheckIcon, ClockIcon, StarIcon } from './icons';
import {
  computeWatchedContentDelta,
  type WatchProgressTick,
} from './player-heatmap-model';
import { playerApi } from './player-api';
import { applyOverlay, nextVideo } from './queue';
import { thumbnailUrl } from './video-links';
import type { QueueSource } from './queue';
import type { VideoItem, WatchState } from './types';
import { isWorthSaving } from './watch-state';
import { notifyResourceProgress } from '../tasks/task-api';
import ResourceTaskLinks from '../tasks/ResourceTaskLinks';
import VideoList from './VideoList';
import {
  PlayerDocumentEditor,
  type PlayerExportedDocument,
} from './PlayerNotePanel';
import {
  TranscriptPanel,
  SubtitleOverlay,
  type TranscriptCue,
  type TranscriptKnowledgeExportPayload,
  type TranscriptKnowledgeExportResult,
} from './transcript/index';

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
const PERSONAL_NOTES_HEADING = '## 我的观看笔记';

function preservePersonalNotes(current: string, incoming: string) {
  const headingIndex = current.lastIndexOf(`\n${PERSONAL_NOTES_HEADING}`);
  if (headingIndex < 0 || incoming.includes(PERSONAL_NOTES_HEADING))
    return incoming;
  return `${incoming.trimEnd()}\n\n${current.slice(headingIndex).trimStart()}`;
}

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

function mapYouTubeStatus(state: YouTubePlaybackState): MediaPlayStatus {
  switch (state) {
    case 'loading':
    case 'resolving':
    case 'ready':
      return 'loading';
    case 'buffering':
    case 'stalled':
      return 'buffering';
    case 'playing':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'ended':
      return 'ended';
    case 'error':
    case 'timeout':
      return 'error';
    default:
      return 'idle';
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
  onSaveVideoNoteToKnowledge,
  onFindVideoKnowledgeDocument,
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
  onSaveVideoNoteToKnowledge?(payload: {
    videoId: string;
    videoTitle: string;
    channelName?: string;
    markdown: string;
  }): Promise<TranscriptKnowledgeExportResult | void>;
  onFindVideoKnowledgeDocument?(
    videoId: string,
  ): Promise<PlayerExportedDocument | null> | PlayerExportedDocument | null;
}) {
  const host = usePlayerHost();
  const media = useGlobalMediaOptional();
  const { queue } = watching;
  const hasQueue = queue.items.length > 1;
  const videoId = watching.item.videoId;
  const item = applyOverlay(watching.item, host.overlay);
  const [handle, setHandle] = useState<YouTubePlayerHandle | null>(null);
  const [playbackOptionsHost, setPlaybackOptionsHost] =
    useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<YouTubePlaybackState>('loading');
  const [rate, setRate] = useState(readRate);
  const [stopToken, setStopToken] = useState(0);
  const [playerModeInfo, setPlayerModeInfo] = useState<{
    mode: 'embed' | 'native' | 'local';
    mpvLaunched: boolean;
  }>({ mode: 'native', mpvLaunched: false });
  const [videoMuted, setVideoMuted] = useState(false);
  const [recentHistory, setRecentHistory] = useState<VideoItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
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

  type WatchTab = 'queue' | 'transcript' | 'notes' | 'settings';
  const [activeTab, setActiveTab] = useState<WatchTab>(() => {
    try {
      const saved = localStorage.getItem(WATCH_TAB_KEY);
      if (saved === 'queue' || saved === 'transcript' || saved === 'settings') {
        if (saved === 'queue' && !hasQueue) return 'transcript';
        return saved;
      }
    } catch {
      // ignore
    }
    return hasQueue ? 'queue' : 'transcript';
  });
  const [transcriptPanelMounted, setTranscriptPanelMounted] = useState(
    activeTab === 'transcript',
  );

  const [subtitlesVisible, setSubtitlesVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SUBTITLES_VISIBLE_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  const [cues, setCues] = useState<TranscriptCue[]>([]);
  const [exportedDocument, setExportedDocument] =
    useState<PlayerExportedDocument | null>(null);
  const [documentRefinementActive, setDocumentRefinementActive] =
    useState(false);
  const [loopingCue, setLoopingCue] = useState<TranscriptCue | null>(null);
  const [shadowMode, setShadowMode] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(
    watching.startSeconds || 0,
  );
  const lastShadowPausedCueIdRef = useRef<string | null>(null);
  const recentItems = useMemo(
    () =>
      recentHistory
        .filter((entry) => entry.videoId !== videoId)
        .slice(0, 7)
        .map((entry) => applyOverlay(entry, host.overlay)),
    [host.overlay, recentHistory, videoId],
  );

  useEffect(() => {
    let current = true;
    setHistoryLoaded(false);
    void playerApi.history(24, 0).then(
      (items) => {
        if (!current) return;
        setRecentHistory(items);
        setHistoryLoaded(true);
      },
      () => {
        if (!current) return;
        setRecentHistory([]);
        setHistoryLoaded(true);
      },
    );
    return () => {
      current = false;
    };
  }, [videoId]);

  const switchTab = useCallback((tab: WatchTab) => {
    setActiveTab(tab);
    if (tab === 'transcript') setTranscriptPanelMounted(true);
    if (tab === 'queue' || tab === 'transcript' || tab === 'settings') {
      try {
        localStorage.setItem(WATCH_TAB_KEY, tab);
      } catch {
        // ignore
      }
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
  const lastProgressTickRef = useRef<WatchProgressTick | null>(null);
  const pendingContentSecondsRef = useRef(0);
  const onSavedRef = useRef(onSaved);
  const queueListRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  const pauseWhenHiddenRef = useRef(host.settings.pauseWhenHidden);
  const handleRef = useRef<YouTubePlayerHandle | null>(null);
  const rateRef = useRef(rate);
  const videoMutedRef = useRef(videoMuted);
  const playerModeInfoRef = useRef(playerModeInfo);
  const suppressedByDismissRef = useRef(false);
  const backgroundResumeAllowedRef = useRef(false);
  const mediaRef = useRef(media);
  const videoIdRef = useRef(videoId);
  useEffect(() => {
    onSavedRef.current = onSaved;
    activeRef.current = active;
    pauseWhenHiddenRef.current = host.settings.pauseWhenHidden;
    handleRef.current = handle;
    rateRef.current = rate;
    videoMutedRef.current = videoMuted;
    playerModeInfoRef.current = playerModeInfo;
    mediaRef.current = media;
    videoIdRef.current = videoId;
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
    const watchedDelta = pendingContentSecondsRef.current;
    if (!progress && watchedDelta <= 0) return;
    pendingContentSecondsRef.current = 0;
    lastProgressTickRef.current = null;
    savedAtRef.current = Date.now();
    const secs = progress?.seconds ?? 0;
    const duration = progress?.duration ?? null;
    if (!isWorthSaving(secs, duration) && watchedDelta < 1) return;
    playerApi
      .saveProgress(
        videoId,
        secs,
        duration,
        watchedDelta >= 0.5 ? watchedDelta : null,
      )
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

  const saveRef = useRef(save);
  saveRef.current = save;

  const buildVideoMeta = useCallback(
    (metaStatus: MediaPlayStatus): ActiveVideoMeta => ({
      kind: 'video',
      id: videoId,
      title: item.title,
      subtitle: item.channelName ?? null,
      artworkUrl: item.thumbnailUrl || thumbnailUrl(videoId),
      status: metaStatus,
      duration: progressRef.current?.duration || item.durationSeconds || 0,
      playbackRate: rateRef.current,
      muted: videoMutedRef.current,
      canSeek: true,
      isEmbedMode: playerModeInfoRef.current.mode === 'embed',
      externalOnly: playerModeInfoRef.current.mpvLaunched,
    }),
    [
      videoId,
      item.title,
      item.channelName,
      item.thumbnailUrl,
      item.durationSeconds,
    ],
  );
  const buildVideoMetaRef = useRef(buildVideoMeta);
  buildVideoMetaRef.current = buildVideoMeta;

  useEffect(() => {
    if (!media) return;
    suppressedByDismissRef.current = false;
    backgroundResumeAllowedRef.current = false;
    if (activeRef.current || media.getActiveSource() === 'video') {
      media.claimFocus(buildVideoMetaRef.current('loading'));
    }
  }, [media, watching.token]);

  useEffect(() => {
    if (!media) return;
    media.registerAdapter('video', {
      play: () => {
        suppressedByDismissRef.current = false;
        backgroundResumeAllowedRef.current = true;
        if (media.getActiveSource() !== 'video') {
          media.claimFocus(buildVideoMetaRef.current('loading'));
        } else {
          media.updateMeta('video', { status: 'loading' });
        }
        handleRef.current?.play();
      },
      pause: () => {
        backgroundResumeAllowedRef.current = false;
        saveRef.current();
        handleRef.current?.pause();
      },
      seekTo: (seconds) => {
        handleRef.current?.seekTo(seconds);
        setCurrentTime(seconds);
      },
      skipBy: (deltaSeconds) => {
        const cur =
          handleRef.current?.getCurrentTime() ??
          progressRef.current?.seconds ??
          0;
        const dur =
          handleRef.current?.getDuration() ??
          progressRef.current?.duration ??
          item.durationSeconds ??
          0;
        const target = Math.max(
          0,
          dur > 0 ? Math.min(dur, cur + deltaSeconds) : cur + deltaSeconds,
        );
        handleRef.current?.seekTo(target);
        setCurrentTime(target);
        media.setProgress('video', {
          currentTime: target,
          duration: dur,
          bufferedPercent: 0,
        });
      },
      toggleMute: () => {
        if (!handleRef.current) return;
        const nextMuted = handleRef.current.toggleMute();
        setVideoMuted(nextMuted);
        media.updateMeta('video', { muted: nextMuted });
      },
      cycleSpeed: () => {
        const idx = RATES.indexOf(rateRef.current);
        const nextRate = RATES[(idx + 1) % RATES.length];
        setRate(nextRate);
        rememberRate(nextRate);
        handleRef.current?.setPlaybackRate(nextRate);
      },
      stopAndClose: () => {
        suppressedByDismissRef.current = true;
        backgroundResumeAllowedRef.current = false;
        saveRef.current();
        handleRef.current?.pause();
        setStopToken((token) => token + 1);
      },
    });
    return () => {
      media.registerAdapter('video', null);
    };
  }, [media, item.durationSeconds]);

  useEffect(() => {
    media?.updateMeta('video', {
      title: item.title,
      subtitle: item.channelName ?? null,
      artworkUrl: item.thumbnailUrl || thumbnailUrl(videoId),
      playbackRate: rate,
      muted: videoMuted,
      isEmbedMode: playerModeInfo.mode === 'embed',
      externalOnly: playerModeInfo.mpvLaunched,
    });
  }, [
    media,
    videoId,
    item.title,
    item.channelName,
    item.thumbnailUrl,
    rate,
    videoMuted,
    playerModeInfo,
  ]);

  useEffect(() => () => save(), [save]);
  useEffect(() => {
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [save]);

  // Leaving the page saves progress, and only pauses if pauseWhenHidden is enabled.
  useEffect(() => {
    if (active) {
      suppressedByDismissRef.current = false;
      backgroundResumeAllowedRef.current = false;
      return;
    }
    backgroundResumeAllowedRef.current = false;
    saveRef.current();
    if (host.settings.pauseWhenHidden) {
      handleRef.current?.pause();
      if (mediaRef.current?.getMetaOf('video')?.id === videoIdRef.current) {
        mediaRef.current.updateMeta('video', { status: 'paused' });
      }
    }
  }, [active, host.settings.pauseWhenHidden]);

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
    setExportedDocument(null);
    setDocumentRefinementActive(false);
    setActiveTab(hasQueue ? 'queue' : 'transcript');
    lastShadowPausedCueIdRef.current = null;

    if (onFindVideoKnowledgeDocument) {
      void Promise.resolve(onFindVideoKnowledgeDocument(videoId)).then(
        (existing) => {
          if (existing) {
            setExportedDocument(existing);
          }
        },
      );
    }
  }, [videoId, watching.token, hasQueue, onFindVideoKnowledgeDocument]);

  const handleDepositVideoNote = useCallback(
    async (markdown: string): Promise<PlayerExportedDocument | void> => {
      if (!onSaveVideoNoteToKnowledge) return;
      const result = await onSaveVideoNoteToKnowledge({
        videoId,
        videoTitle: item.title,
        channelName: item.channelName ?? undefined,
        markdown,
      });
      if (result) {
        const exportedDoc: PlayerExportedDocument = {
          ...(result.id ? { id: result.id } : {}),
          title: result.title,
          category: result.category,
          markdown,
          ...(result.open ? { openKnowledge: result.open } : {}),
          ...(result.updateMarkdown
            ? { updateMarkdown: result.updateMarkdown }
            : {}),
        };
        setExportedDocument(exportedDoc);
        host.notify(`已将文稿笔记沉淀至知识库「${result.title}」`);
        return exportedDoc;
      }
    },
    [videoId, item.title, item.channelName, onSaveVideoNoteToKnowledge, host],
  );

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
    const nowMs = Date.now();
    const contentDelta = computeWatchedContentDelta(
      lastProgressTickRef.current,
      videoId,
      progress.seconds,
      nowMs,
      progress.playing,
    );
    if (contentDelta > 0) {
      pendingContentSecondsRef.current += contentDelta;
    }
    lastProgressTickRef.current = progress.playing
      ? { videoId, seconds: progress.seconds, wallMs: nowMs }
      : null;

    progressRef.current = progress;
    setCurrentTime(progress.seconds);

    if (media?.getMetaOf('video')?.id === videoId) {
      const effectiveDuration =
        progress.duration && Number.isFinite(progress.duration)
          ? progress.duration
          : item.durationSeconds || 0;
      media.setProgress('video', {
        currentTime: progress.seconds,
        duration: effectiveDuration,
        bufferedPercent: 0,
      });
      if (effectiveDuration > 0) {
        media.updateMeta('video', { duration: effectiveDuration });
      }
    }

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
    if (!active) return;
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
  }, [active, jumpToRelativeCue, toggleSentenceLoop, toggleSubtitles]);

  const handleEnded = () => {
    save();
    if (!host.settings.autoplayNext) return;
    const next = nextVideo(queue.items, videoId);
    if (!next) return;
    host.notify(`接下来播放：${next.title}`);
    host.openVideo(next, queue);
  };

  const handlePlayerStatusChange = useCallback(
    (nextStatus: YouTubePlaybackState) => {
      setStatus(nextStatus);
      if (nextStatus === 'playing') {
        const suppressedByHiddenAutoPause =
          !activeRef.current &&
          pauseWhenHiddenRef.current &&
          !backgroundResumeAllowedRef.current;
        const suppressedByOtherActiveSource =
          !activeRef.current &&
          !backgroundResumeAllowedRef.current &&
          Boolean(media && media.getActiveSource() !== 'video');
        if (
          suppressedByDismissRef.current ||
          suppressedByHiddenAutoPause ||
          suppressedByOtherActiveSource
        ) {
          handleRef.current?.pause();
          return;
        }
        media?.claimFocus(buildVideoMetaRef.current('playing'));
        return;
      }
      if (media?.getMetaOf('video')?.id === videoId) {
        media.updateMeta('video', { status: mapYouTubeStatus(nextStatus) });
      }
    },
    [media, videoId],
  );

  const position = queue.items.findIndex((entry) => entry.videoId === videoId);

  return (
    <section
      className={`player-watch${queueCollapsed ? ' is-queue-collapsed' : ''}`}
      aria-label="正在播放"
    >
      <div className="player-watch-main">
        <YouTubePlayerPanel
          selection={selection}
          variant="page"
          active={active}
          pauseWhenHidden={host.settings.pauseWhenHidden}
          stopToken={stopToken}
          controlsTarget={playbackOptionsHost}
          onProgress={handleProgress}
          onStatusChange={handlePlayerStatusChange}
          onEnded={handleEnded}
          onModeChange={setPlayerModeInfo}
          onMutedChange={setVideoMuted}
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
          </p>
          <div className="player-watch-actions">
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
            <ResourceTaskLinks
              kind="youtube"
              identity={item.videoId}
              onOpenTask={onOpenTask}
            />
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
          </div>
        </div>
        <section className="player-watch-history" aria-label="最近观看">
          <header>
            <h3>最近观看</h3>
            {recentItems.length > 0 && <span>{recentItems.length} 条</span>}
          </header>
          {recentItems.length > 0 ? (
            <div className="player-watch-history-list">
              {recentItems.map((recent) => {
                const duration = formatDuration(recent.durationSeconds);
                const playedAt = formatAgo(recent.lastPlayedAt, host.now);
                return (
                  <button
                    key={recent.videoId}
                    type="button"
                    className="player-watch-history-item"
                    title={recent.title}
                    aria-label={`播放最近观看：${recent.title}`}
                    onClick={() =>
                      host.openVideo(recent, {
                        title: '最近观看',
                        items: recentItems,
                      })
                    }
                  >
                    <span className="player-watch-history-thumb">
                      <img
                        src={
                          recent.thumbnailUrl || thumbnailUrl(recent.videoId)
                        }
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                      {duration && <span>{duration}</span>}
                    </span>
                    <strong>{recent.title}</strong>
                    {playedAt && <small>{playedAt}</small>}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="player-watch-history-empty">
              {historyLoaded ? '还没有其他观看记录' : '读取观看记录…'}
            </p>
          )}
        </section>
      </div>
      <aside
        className={`player-watch-queue${queueCollapsed ? ' is-collapsed' : ''}`}
        aria-label="播放队列、字幕与笔记"
      >
        <header>
          {!queueCollapsed ? (
            <>
              <div className="player-watch-tabs" role="tablist">
                {hasQueue && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'queue'}
                    className={`player-watch-tab${activeTab === 'queue' ? ' is-active' : ''}`}
                    onClick={() => switchTab('queue')}
                    title={`播放队列 (${queue.items.length})`}
                  >
                    队列
                  </button>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'transcript'}
                  className={`player-watch-tab${activeTab === 'transcript' ? ' is-active' : ''}`}
                  onClick={() => switchTab('transcript')}
                  title="台词 / 字幕"
                >
                  字幕
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'notes'}
                  className={`player-watch-tab${activeTab === 'notes' ? ' is-active' : ''}`}
                  onClick={() => switchTab('notes')}
                  title="文稿与笔记"
                >
                  文稿笔记
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'settings'}
                  className={`player-watch-tab${activeTab === 'settings' ? ' is-active' : ''}`}
                  onClick={() => switchTab('settings')}
                  title="播放设置"
                >
                  设置
                </button>
              </div>
              <div className="player-watch-queue-controls">
                {hasQueue && (
                  <span>
                    {activeTab === 'queue' && position >= 0
                      ? `${position + 1}/`
                      : ''}
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
            ) : null}
            {transcriptPanelMounted && (
              <div
                className="player-watch-transcript-slot"
                hidden={activeTab !== 'transcript'}
              >
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
                  onDocumentExported={(document) => {
                    let legacyNotes = '';
                    try {
                      const combinedEditor = localStorage.getItem(
                        `seamind:player-document:v1:${videoId}`,
                      );
                      const priorNotes = combinedEditor?.match(
                        /(?:^|\r?\n)## 我的观看笔记\s*\r?\n([\s\S]*)$/,
                      )?.[1];
                      legacyNotes =
                        priorNotes?.trim() ||
                        localStorage
                          .getItem(`seamind:player-note:v1:${videoId}`)
                          ?.trim() ||
                        '';
                    } catch {
                      legacyNotes = '';
                    }
                    const mergedDocument =
                      legacyNotes &&
                      (!document.id || exportedDocument?.id !== document.id)
                        ? {
                            ...document,
                            markdown: `${document.markdown.trim()}\n\n${PERSONAL_NOTES_HEADING}\n\n${legacyNotes}`,
                            pendingManualSync: true,
                          }
                        : document;
                    setExportedDocument(mergedDocument);
                    setQueueCollapsed(false);
                    switchTab('notes');
                  }}
                  onDocumentMarkdownChange={(markdown) =>
                    setExportedDocument((current) =>
                      current
                        ? {
                            ...current,
                            markdown: preservePersonalNotes(
                              current.markdown,
                              markdown,
                            ),
                          }
                        : current,
                    )
                  }
                  onRefinementActivityChange={setDocumentRefinementActive}
                />
              </div>
            )}
            {activeTab === 'notes' ? (
              <div
                className="player-document-notes"
                aria-label="文稿与视频笔记"
              >
                <PlayerDocumentEditor
                  videoId={videoId}
                  videoTitle={item.title}
                  currentTime={currentTime}
                  document={exportedDocument}
                  suspendDocumentSave={documentRefinementActive}
                  onDepositToKnowledge={handleDepositVideoNote}
                  onDocumentMarkdownChange={(markdown) =>
                    setExportedDocument((current) =>
                      current ? { ...current, markdown } : current,
                    )
                  }
                />
              </div>
            ) : null}
          </>
        )}
        <div
          className="player-watch-settings"
          role="tabpanel"
          hidden={queueCollapsed || activeTab !== 'settings'}
          aria-label="播放设置与诊断"
        >
          <div className="player-watch-settings-speed">
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
          <div ref={setPlaybackOptionsHost} />
        </div>
      </aside>
    </section>
  );
}
