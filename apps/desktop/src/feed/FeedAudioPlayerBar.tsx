import React, { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { FeedArticle } from './types';
import {
  feedAsrApi,
  mergeCaptionCue,
  type FeedAsrCaption,
  type FeedAsrMode,
  type FeedAsrStatus,
} from './feed-asr-api';

interface FeedAudioPlayerBarProps {
  article: FeedArticle | null;
  onClose: () => void;
  onGenerateMindmap?: (articleId: string, title: string) => void;
}

function formatAudioTime(seconds: number): string {
  if (!seconds || isNaN(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const SPEED_OPTIONS = [0.8, 1.0, 1.25, 1.5, 2.0];

export const FeedAudioPlayerBar: React.FC<FeedAudioPlayerBarProps> = ({
  article,
  onClose,
  onGenerateMindmap,
}) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(1); // 1.0x
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [captionEnabled, setCaptionEnabled] = useState(false);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [captionStatus, setCaptionStatus] = useState<FeedAsrStatus | null>(
    null,
  );
  const [captionError, setCaptionError] = useState('');
  const [captionDownload, setCaptionDownload] = useState({
    downloadedBytes: 0,
    totalBytes: 0,
    label: '',
  });
  const [captionCues, setCaptionCues] = useState<FeedAsrCaption[]>([]);
  const [partialCaption, setPartialCaption] = useState<FeedAsrCaption | null>(
    null,
  );
  const [captionMode, setCaptionMode] = useState<FeedAsrMode>('podcast');
  const [playbackSrc, setPlaybackSrc] = useState('');
  const [seekRevision, setSeekRevision] = useState(0);
  const captionSessionRef = useRef<string | null>(null);
  const captionQueueRef = useRef<FeedAsrCaption[]>([]);
  const captionListenerReadyRef = useRef<Promise<void>>(Promise.resolve());
  const applyCaptionRef = useRef<(caption: FeedAsrCaption) => void>(
    () => undefined,
  );

  const audioUrl = article?.audioUrl ?? '';

  applyCaptionRef.current = (caption) => {
    if (caption.error) {
      setCaptionError(caption.error);
      setCaptionEnabled(false);
      return;
    }
    setCaptionError('');
    if (caption.isFinal) {
      if (caption.text.trim()) {
        setCaptionCues((current) => mergeCaptionCue(current, caption));
      }
      setPartialCaption(null);
      return;
    }
    if (caption.text.trim()) setPartialCaption(caption);
  };

  useEffect(() => {
    let mounted = true;
    void feedAsrApi
      .getStatus()
      .then((status) => {
        if (mounted) setCaptionStatus(status);
      })
      .catch((error: unknown) => {
        if (mounted)
          setCaptionError(
            error instanceof Error ? error.message : '无法读取本机字幕组件状态',
          );
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    captionListenerReadyRef.current = feedAsrApi
      .listen((caption) => {
        if (!mounted) return;
        if (caption.sessionId !== captionSessionRef.current) {
          captionQueueRef.current.push(caption);
          if (captionQueueRef.current.length > 30) {
            captionQueueRef.current.shift();
          }
          return;
        }
        applyCaptionRef.current(caption);
      })
      .then((stopListening) => {
        if (mounted) unlisten = stopListening;
        else stopListening();
      })
      .catch((error: unknown) => {
        setCaptionError(
          error instanceof Error ? error.message : '字幕事件监听启动失败',
        );
      });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    setCaptionCues([]);
    setPartialCaption(null);
    setCaptionError('');
    captionQueueRef.current = [];
  }, [article?.id]);

  useEffect(() => {
    let cancelled = false;
    setPlaybackSrc('');
    const articleId = article?.id;
    if (!audioUrl || !articleId) return;
    void feedAsrApi
      .cachedAudio(audioUrl, articleId)
      .then((path) => {
        if (cancelled) return;
        setPlaybackSrc(path ? convertFileSrc(path) : audioUrl);
      })
      .catch(() => {
        if (!cancelled) setPlaybackSrc(audioUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [audioUrl, article?.id]);

  useEffect(() => {
    const articleId = article?.id;
    if (!captionEnabled || !isPlaying || !audioUrl || !articleId) return;

    let cancelled = false;
    let sessionId: string | null = null;
    setPartialCaption(null);
    void (async () => {
      try {
        await captionListenerReadyRef.current;
        const id = await feedAsrApi.start(
          audioUrl,
          audioRef.current?.currentTime ?? 0,
          SPEED_OPTIONS[speedIndex],
          articleId,
          captionMode,
        );
        sessionId = id;
        if (cancelled) {
          await feedAsrApi.stop(id);
          return;
        }
        captionSessionRef.current = id;
        const queued = captionQueueRef.current.filter(
          (caption) => caption.sessionId === id,
        );
        captionQueueRef.current = captionQueueRef.current.filter(
          (caption) => caption.sessionId !== id,
        );
        queued.forEach((caption) => applyCaptionRef.current(caption));
        setCaptionError('');
      } catch (error) {
        if (cancelled) return;
        setCaptionEnabled(false);
        setCaptionError(
          error instanceof Error ? error.message : '实时字幕启动失败',
        );
      }
    })();

    return () => {
      cancelled = true;
      if (!sessionId) return;
      if (captionSessionRef.current === sessionId)
        captionSessionRef.current = null;
      void feedAsrApi.stop(sessionId).catch(() => undefined);
    };
  }, [
    captionEnabled,
    isPlaying,
    audioUrl,
    article?.id,
    speedIndex,
    seekRevision,
    captionMode,
  ]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !playbackSrc) return;

    el.currentTime = 0;
    setCurrentTime(0);
    setDuration(article?.audioDuration || 0);

    // Auto-play when audio loads
    const playPromise = el.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  }, [playbackSrc, article?.id]);

  useEffect(() => {
    setImageFailed(false);
  }, [article?.id, article?.imageUrl]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = SPEED_OPTIONS[speedIndex];
  }, [speedIndex]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (isPlaying) {
      el.pause();
      setIsPlaying(false);
    } else {
      el.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  };

  const handleSkip = (seconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    const target = Math.max(
      0,
      Math.min(duration || 0, el.currentTime + seconds),
    );
    el.currentTime = target;
    setCurrentTime(target);
    setSeekRevision((revision) => revision + 1);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el) return;
    const target = parseFloat(e.target.value);
    el.currentTime = target;
    setCurrentTime(target);
    setSeekRevision((revision) => revision + 1);
  };

  const cycleSpeed = () => {
    setSpeedIndex((prev) => (prev + 1) % SPEED_OPTIONS.length);
  };

  const selectCaptionMode = async (mode: FeedAsrMode) => {
    if (mode === captionMode || captionBusy) return;
    if (!captionEnabled) {
      setCaptionMode(mode);
      return;
    }
    setCaptionBusy(true);
    setCaptionError('');
    try {
      let status = await feedAsrApi.getStatus();
      const ready =
        mode === 'streaming'
          ? status.streamingModelInstalled
          : status.modelInstalled;
      if (!ready) {
        setCaptionDownload({ downloadedBytes: 0, totalBytes: 0, label: '' });
        status = await feedAsrApi.installModel((progress) => {
          setCaptionDownload({
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes ?? 0,
            label: progress.label ?? '',
          });
        }, mode);
        setCaptionStatus(status);
      }
      setCaptionMode(mode);
    } catch (error) {
      setCaptionError(
        error instanceof Error ? error.message : '切换字幕模式失败',
      );
    } finally {
      setCaptionBusy(false);
    }
  };

  const toggleCaptions = async () => {
    if (captionEnabled) {
      setCaptionEnabled(false);
      setPartialCaption(null);
      return;
    }
    if (captionBusy) return;
    setCaptionBusy(true);
    setCaptionError('');
    try {
      let status = await feedAsrApi.getStatus();
      setCaptionStatus(status);
      if (!status.ffmpegAvailable) {
        setCaptionError(
          '未检测到 FFmpeg。请先安装 FFmpeg 并加入 PATH，然后重启 Seamind。',
        );
        return;
      }
      const modelReady =
        captionMode === 'streaming'
          ? status.streamingModelInstalled
          : status.modelInstalled;
      if (!modelReady) {
        setCaptionDownload({ downloadedBytes: 0, totalBytes: 0, label: '' });
        status = await feedAsrApi.installModel((progress) => {
          setCaptionDownload({
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes ?? 0,
            label: progress.label ?? '',
          });
        }, captionMode);
        setCaptionStatus(status);
      }
      setCaptionEnabled(true);
    } catch (error) {
      setCaptionError(
        error instanceof Error ? error.message : '本地字幕模型安装失败',
      );
    } finally {
      setCaptionBusy(false);
    }
  };

  const handleTimeUpdate = () => {
    const el = audioRef.current;
    if (!el) return;
    setCurrentTime(el.currentTime);
    if (el.buffered.length > 0 && el.duration > 0) {
      const bufEnd = el.buffered.end(el.buffered.length - 1);
      setBufferedPercent(Math.min(100, (bufEnd / el.duration) * 100));
    }
  };

  const handleLoadedMetadata = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.duration && !isNaN(el.duration)) {
      setDuration(el.duration);
    }
  };

  if (!article || !audioUrl) {
    return null;
  }

  const currentSpeed = SPEED_OPTIONS[speedIndex];
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <aside
      className="feed-audio-player-panel feed-audio-player-inline"
      aria-label="播客播放面板"
    >
      <audio
        ref={audioRef}
        src={playbackSrc || undefined}
        preload="metadata"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />

      {(captionEnabled ||
        captionBusy ||
        captionCues.length > 0 ||
        captionError) && (
        <section
          className="feed-audio-live-captions"
          aria-label="播客实时字幕"
          aria-live="polite"
        >
          <div className="feed-audio-live-captions-head">
            <span>实时字幕</span>
            <span className="feed-audio-live-captions-local">本机识别</span>
            {captionBusy && (
              <span className="feed-audio-live-captions-progress">
                {captionDownload.label || '正在准备本地模型…'}
                {captionDownload.totalBytes > 0
                  ? ` ${Math.round(
                      (captionDownload.downloadedBytes /
                        captionDownload.totalBytes) *
                        100,
                    )}%`
                  : ''}
              </span>
            )}
          </div>
          {captionError ? (
            <p className="feed-audio-live-captions-error">{captionError}</p>
          ) : (
            <div className="feed-audio-live-captions-lines">
              {captionCues.slice(-4).map((cue) => (
                <button
                  type="button"
                  key={`${cue.start.toFixed(2)}-${cue.text}`}
                  onClick={() => {
                    const audio = audioRef.current;
                    if (!audio) return;
                    audio.currentTime = cue.start;
                    setCurrentTime(cue.start);
                    setSeekRevision((revision) => revision + 1);
                  }}
                >
                  <time>{formatAudioTime(cue.start)}</time>
                  <span>{cue.text}</span>
                </button>
              ))}
              {partialCaption ? (
                <div className="feed-audio-live-caption-partial">
                  <time>{formatAudioTime(partialCaption.start)}</time>
                  <span>{partialCaption.text}</span>
                </div>
              ) : captionEnabled ? (
                <p className="feed-audio-live-captions-waiting">
                  {isPlaying
                    ? captionMode === 'podcast'
                      ? '正在听，说完一句就显示（大约 1–3 秒）'
                      : '正在识别播放中的音频…'
                    : '播放后开始识别'}
                </p>
              ) : captionBusy ? (
                <p className="feed-audio-live-captions-waiting">
                  {captionMode === 'podcast'
                    ? '正在下载播客字幕模型（SenseVoice，约 160MB）和语音切分模型，完成后会自动开始。'
                    : '正在下载低延迟流式模型，完成后会自动开始。'}
                </p>
              ) : null}
            </div>
          )}
        </section>
      )}

      {/* 顶部微薄进度指示线 */}
      <div
        className="feed-audio-track-scrub"
        role="progressbar"
        aria-valuenow={Math.round(currentTime)}
        aria-valuemax={Math.round(duration)}
      >
        <div
          className="feed-audio-buffered-bar"
          style={{ width: `${bufferedPercent}%` }}
        />
        <div
          className="feed-audio-progress-bar"
          style={{ width: `${progressPercent}%` }}
        />
        <input
          type="range"
          className="feed-audio-range-slider"
          min={0}
          max={duration || 100}
          step={0.5}
          value={currentTime}
          onChange={handleSeek}
          aria-label="拖动跳转音频进度"
        />
      </div>

      <div className="feed-audio-player-content">
        {/* 左侧：节目信息 */}
        <div className="feed-audio-info">
          <div className="feed-audio-badge-icon" aria-hidden="true">
            {article.imageUrl && !imageFailed ? (
              <img
                className="feed-audio-cover-image"
                src={article.imageUrl}
                alt=""
                loading="lazy"
                onError={() => setImageFailed(true)}
              />
            ) : (
              <svg
                viewBox="0 0 16 16"
                width="28"
                height="28"
                fill="currentColor"
              >
                <path d="M8 2a4 4 0 00-4 4v3.5a1.5 1.5 0 001.5 1.5h.5V7H5a3 3 0 016 0h-1v4h.5a1.5 1.5 0 001.5-1.5V6a4 4 0 00-4-4z" />
                <path d="M3 13.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5v-.5H3v.5z" />
              </svg>
            )}
          </div>
          <div className="feed-audio-meta">
            <span className="feed-audio-title" title={article.title}>
              {article.title}
            </span>
            <span className="feed-audio-channel">
              {article.channelTitle} · 播客录音
            </span>
          </div>
        </div>

        {/* 中间：播放传输主控 */}
        <div className="feed-audio-controls">
          <button
            type="button"
            className="feed-audio-btn is-skip"
            onClick={() => handleSkip(-15)}
            title="快退 15 秒"
            aria-label="快退 15 秒"
          >
            <svg
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <path
                d="M2.5 7.5A5.5 5.5 0 118 13.5a5.5 5.5 0 01-4.2-2"
                strokeLinecap="round"
              />
              <path
                d="M2.5 4v3.5H6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="feed-audio-skip-text">15</span>
          </button>

          <button
            type="button"
            className="feed-audio-btn is-play-main"
            onClick={togglePlay}
            title={isPlaying ? '暂停' : '播放'}
            aria-label={isPlaying ? '暂停' : '播放'}
          >
            {isPlaying ? (
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="currentColor"
              >
                <rect x="3.5" y="3" width="3.2" height="10" rx="1" />
                <rect x="9.3" y="3" width="3.2" height="10" rx="1" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="currentColor"
              >
                <path d="M4.5 3.3a.8.8 0 00-1.2.7v8a.8.8 0 001.2.7l7.5-4a.8.8 0 000-1.4l-7.5-4z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            className="feed-audio-btn is-skip"
            onClick={() => handleSkip(15)}
            title="快进 15 秒"
            aria-label="快进 15 秒"
          >
            <svg
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <path
                d="M13.5 7.5A5.5 5.5 0 108 13.5a5.5 5.5 0 004.2-2"
                strokeLinecap="round"
              />
              <path
                d="M13.5 4v3.5H10"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="feed-audio-skip-text">15</span>
          </button>

          <div className="feed-audio-time">
            <span>{formatAudioTime(currentTime)}</span>
            <span style={{ opacity: 0.4 }}>/</span>
            <span>{formatAudioTime(duration)}</span>
          </div>
        </div>

        {/* 右侧：倍速、音量、导图与关闭 */}
        <div className="feed-audio-extra">
          <button
            type="button"
            className={`feed-audio-caption-toggle${captionEnabled ? ' is-active' : ''}`}
            onClick={() => void toggleCaptions()}
            disabled={captionBusy}
            title={
              captionMode === 'podcast'
                ? '播客模式：按语句切分后在本机识别，首次会下载约 160MB 模型'
                : '低延迟模式：边播边出字。首次会下载流式模型，播客效果弱于播客模式'
            }
            aria-pressed={captionEnabled}
          >
            {captionBusy
              ? '准备字幕中'
              : captionEnabled
                ? '字幕开'
                : captionStatus &&
                    (captionMode === 'streaming'
                      ? !captionStatus.streamingModelInstalled
                      : !captionStatus.modelInstalled)
                  ? '安装字幕模型'
                  : '实时字幕'}
          </button>
          <button
            type="button"
            className={`feed-audio-caption-toggle${captionMode === 'podcast' ? ' is-active' : ''}`}
            onClick={() =>
              void selectCaptionMode(
                captionMode === 'podcast' ? 'streaming' : 'podcast',
              )
            }
            disabled={captionBusy}
            title="播客模式按句识别，低延迟模式边播边出字"
          >
            {captionMode === 'podcast' ? '播客句读' : '低延迟'}
          </button>
          <button
            type="button"
            className="feed-audio-speed-btn"
            onClick={cycleSpeed}
            title="切换播放倍速"
          >
            {currentSpeed}x
          </button>

          <div className="feed-audio-volume-wrap">
            <button
              type="button"
              className="feed-audio-btn is-vol"
              onClick={() => setIsMuted((m) => !m)}
              title={isMuted ? '取消静音' : '静音'}
            >
              {isMuted || volume === 0 ? (
                <svg
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  fill="currentColor"
                >
                  <path d="M2.5 6H4l3-3v10l-3-3H2.5A.5.5 0 012 9.5v-3a.5.5 0 01.5-.5z" />
                  <path
                    d="M11 5l4 6M15 5l-4 6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  fill="currentColor"
                >
                  <path d="M2.5 6H4l3-3v10l-3-3H2.5A.5.5 0 012 9.5v-3a.5.5 0 01.5-.5z" />
                  <path
                    d="M10 5a4 4 0 010 6M11.5 3a6.5 6.5 0 010 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </button>
            <input
              type="range"
              className="feed-audio-vol-slider"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                setVolume(parseFloat(e.target.value));
                if (isMuted) setIsMuted(false);
              }}
              aria-label="调节音量"
            />
          </div>

          {onGenerateMindmap && (
            <button
              type="button"
              className="feed-audio-btn is-mindmap"
              onClick={() => onGenerateMindmap(article.id, article.title)}
              title="一键将本期播客内容转为思维导图"
            >
              转导图
            </button>
          )}

          <button
            type="button"
            className="feed-audio-btn is-close"
            onClick={onClose}
            title="关闭播放栏"
            aria-label="关闭播放栏"
          >
            ×
          </button>
        </div>
      </div>
    </aside>
  );
};
