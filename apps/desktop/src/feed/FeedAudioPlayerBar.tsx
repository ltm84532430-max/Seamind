import React, { useEffect, useState } from 'react';
import {
  FEED_AUDIO_SPEED_OPTIONS,
  useFeedAudio,
  useFeedAudioProgress,
} from './FeedAudioEngine';

interface FeedAudioPlayerBarProps {
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

const FeedAudioScrubBar: React.FC<{
  fallbackDuration: number;
  onSeek: (seconds: number) => void;
}> = ({ fallbackDuration, onSeek }) => {
  const progress = useFeedAudioProgress();
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const effectiveDuration =
    progress.duration > 0 ? progress.duration : fallbackDuration;
  const shownTime = scrubTime !== null ? scrubTime : progress.currentTime;
  const progressPercent =
    effectiveDuration > 0
      ? Math.min(100, (shownTime / effectiveDuration) * 100)
      : 0;

  return (
    <div
      className="feed-audio-track-scrub"
      role="progressbar"
      aria-valuenow={Math.round(shownTime)}
      aria-valuemax={Math.round(effectiveDuration)}
    >
      <div
        className="feed-audio-buffered-bar"
        style={{ width: `${progress.bufferedPercent}%` }}
      />
      <div
        className="feed-audio-progress-bar"
        style={{ width: `${progressPercent}%` }}
      />
      <input
        type="range"
        className="feed-audio-range-slider"
        min={0}
        max={effectiveDuration || 100}
        step={0.5}
        value={shownTime}
        onPointerDown={() => setScrubTime(progress.currentTime)}
        onChange={(e) => {
          const target = parseFloat(e.target.value);
          setScrubTime(target);
          onSeek(target);
        }}
        onPointerUp={() => setScrubTime(null)}
        onPointerCancel={() => setScrubTime(null)}
        aria-label="拖动跳转音频进度"
      />
    </div>
  );
};

const FeedAudioTimeDisplay: React.FC<{ fallbackDuration: number }> = ({
  fallbackDuration,
}) => {
  const progress = useFeedAudioProgress();
  const effectiveDuration =
    progress.duration > 0 ? progress.duration : fallbackDuration;
  return (
    <div className="feed-audio-time">
      <span>{formatAudioTime(progress.currentTime)}</span>
      <span style={{ opacity: 0.4 }}>/</span>
      <span>{formatAudioTime(effectiveDuration)}</span>
    </div>
  );
};

export const FeedAudioPlayerBar: React.FC<FeedAudioPlayerBarProps> = ({
  onGenerateMindmap,
}) => {
  const {
    article,
    isPlaying,
    duration,
    speedIndex,
    volume,
    isMuted,
    captionEnabled,
    captionBusy,
    captionStatus,
    captionError,
    captionDownload,
    captionCues,
    partialCaption,
    captionMode,
    closePlayer,
    togglePlay,
    skip,
    seekTo,
    cycleSpeed,
    setVolumeLevel,
    toggleMute,
    toggleCaptions,
    selectCaptionMode,
  } = useFeedAudio();

  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [article?.id, article?.imageUrl]);

  const audioUrl = article?.audioUrl ?? '';
  if (!article || !audioUrl) {
    return null;
  }

  const currentSpeed = FEED_AUDIO_SPEED_OPTIONS[speedIndex];
  const fallbackDuration = duration || article.audioDuration || 0;

  return (
    <aside
      className="feed-audio-player-panel feed-audio-player-inline"
      aria-label="播客播放面板"
    >
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
                  onClick={() => seekTo(cue.start)}
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
      <FeedAudioScrubBar fallbackDuration={fallbackDuration} onSeek={seekTo} />

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
            onClick={() => skip(-15)}
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
            onClick={() => skip(15)}
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

          <FeedAudioTimeDisplay fallbackDuration={fallbackDuration} />
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
              onClick={toggleMute}
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
              onChange={(e) => setVolumeLevel(parseFloat(e.target.value))}
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
            onClick={closePlayer}
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
