import React, { useEffect, useRef, useState } from 'react';
import type { FeedArticle } from './types';

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

  const audioUrl = article?.audioUrl ?? '';

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audioUrl) return;

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
  }, [audioUrl, article?.id]);

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
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el) return;
    const target = parseFloat(e.target.value);
    el.currentTime = target;
    setCurrentTime(target);
  };

  const cycleSpeed = () => {
    setSpeedIndex((prev) => (prev + 1) % SPEED_OPTIONS.length);
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
    <aside className="feed-audio-player-dock" aria-label="音频播客播放控制台">
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />

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
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <path d="M8 2a4 4 0 00-4 4v3.5a1.5 1.5 0 001.5 1.5h.5V7H5a3 3 0 016 0h-1v4h.5a1.5 1.5 0 001.5-1.5V6a4 4 0 00-4-4z" />
              <path d="M3 13.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5v-.5H3v.5z" />
            </svg>
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
