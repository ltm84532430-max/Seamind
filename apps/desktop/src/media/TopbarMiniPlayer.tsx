import React, { useEffect, useState } from 'react';
import {
  useActiveMediaProgress,
  useGlobalMedia,
  useMiniPlayerState,
  type ActiveMediaMeta,
  type MediaSourceKind,
} from './global-media-store';

interface TopbarMiniPlayerProps {
  onJumpToSource: (kind: MediaSourceKind, id: string) => void;
}

function formatMiniTime(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const MiniPlayerTimeAndProgress: React.FC<{
  meta: ActiveMediaMeta;
  onSeek: (seconds: number) => void;
}> = ({ meta, onSeek }) => {
  const progress = useActiveMediaProgress();
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const effectiveDuration =
    progress.duration > 0 ? progress.duration : meta.duration;
  const shownTime = scrubTime !== null ? scrubTime : progress.currentTime;
  const pct =
    effectiveDuration > 0
      ? Math.max(0, Math.min(100, (shownTime / effectiveDuration) * 100))
      : 0;

  return (
    <>
      <span className="topbar-mini-time" aria-live="off">
        <span>{formatMiniTime(shownTime)}</span>
        {effectiveDuration > 0 && (
          <span className="topbar-mini-time-total">
            {' '}
            / {formatMiniTime(effectiveDuration)}
          </span>
        )}
      </span>
      <div
        className="topbar-mini-progress"
        role="progressbar"
        aria-valuenow={Math.round(shownTime)}
        aria-valuemax={Math.round(effectiveDuration)}
      >
        {progress.bufferedPercent > 0 && (
          <div
            className="topbar-mini-progress-buffered"
            style={{ width: `${progress.bufferedPercent}%` }}
          />
        )}
        <div
          className="topbar-mini-progress-fill"
          style={{ width: `${pct}%` }}
        />
        {meta.canSeek && effectiveDuration > 0 && (
          <input
            type="range"
            className="topbar-mini-progress-slider"
            min={0}
            max={effectiveDuration}
            step={0.5}
            value={Math.min(effectiveDuration, shownTime)}
            onPointerDown={() => setScrubTime(progress.currentTime)}
            onChange={(event) => {
              const target = parseFloat(event.target.value);
              setScrubTime(target);
              onSeek(target);
            }}
            onPointerUp={() => setScrubTime(null)}
            onPointerCancel={() => setScrubTime(null)}
            aria-label="拖动跳转播放进度"
          />
        )}
      </div>
    </>
  );
};

export const TopbarMiniPlayer: React.FC<TopbarMiniPlayerProps> = ({
  onJumpToSource,
}) => {
  const media = useGlobalMedia();
  const miniState = useMiniPlayerState();
  const [imageFailed, setImageFailed] = useState(false);

  const meta = miniState?.meta ?? null;

  useEffect(() => {
    setImageFailed(false);
  }, [meta?.kind, meta?.id, meta?.artworkUrl]);

  if (!meta) {
    return null;
  }

  const isPlaying = meta.status === 'playing';
  const isBusy = meta.status === 'loading' || meta.status === 'buffering';
  const skipStep = meta.kind === 'podcast' ? 15 : 10;
  const sourceLabel = meta.kind === 'podcast' ? '播客' : '视频';
  const titleTooltip = [
    meta.title,
    meta.subtitle,
    isPlaying ? '点击回到播放页面' : '已暂停 · 点击回到播放页面',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className="topbar-mini-player"
      data-kind={meta.kind}
      data-status={meta.status}
      role="region"
      aria-label={`后台${sourceLabel}播放控制：${meta.title}`}
    >
      <button
        type="button"
        className="topbar-mini-jump"
        onClick={() => onJumpToSource(meta.kind, meta.id)}
        title={titleTooltip}
      >
        <span className="topbar-mini-cover" aria-hidden="true">
          {meta.artworkUrl && !imageFailed ? (
            <img
              src={meta.artworkUrl}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setImageFailed(true)}
            />
          ) : meta.kind === 'podcast' ? (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
              <path d="M8 2a4 4 0 00-4 4v3.5a1.5 1.5 0 001.5 1.5h.5V7H5a3 3 0 016 0h-1v4h.5a1.5 1.5 0 001.5-1.5V6a4 4 0 00-4-4z" />
              <path d="M3 13.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5v-.5H3v.5z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
              <path d="M4.5 3.3a.8.8 0 00-1.2.7v8a.8.8 0 001.2.7l7.5-4a.8.8 0 000-1.4l-7.5-4z" />
            </svg>
          )}
          {isPlaying && (
            <span className="topbar-mini-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
        </span>

        <span className="topbar-mini-badge">{sourceLabel}</span>
        <span className="topbar-mini-title">
          {isBusy ? `载入中 · ${meta.title}` : meta.title}
        </span>
      </button>

      <div className="topbar-mini-controls">
        <button
          type="button"
          className="topbar-mini-btn is-skip"
          onClick={() => media.skipActive(-skipStep)}
          title={`快退 ${skipStep} 秒`}
          aria-label={`快退 ${skipStep} 秒`}
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path
              d="M3 7.8A5 5 0 118 13a5 5 0 01-3.8-1.7"
              strokeLinecap="round"
            />
            <path
              d="M3 4.5v3.3h3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          type="button"
          className="topbar-mini-btn is-play"
          onClick={() => media.togglePlayActive()}
          title={isPlaying || isBusy ? '暂停' : '继续播放'}
          aria-label={isPlaying || isBusy ? '暂停' : '继续播放'}
        >
          {isPlaying || isBusy ? (
            <svg
              viewBox="0 0 16 16"
              width="11"
              height="11"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="3.5" y="3" width="3.2" height="10" rx="0.6" />
              <rect x="9.3" y="3" width="3.2" height="10" rx="0.6" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              width="11"
              height="11"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M4.5 3.2a.7.7 0 00-1.1.6v8.4a.7.7 0 001.1.6l7.8-4.2a.7.7 0 000-1.2L4.5 3.2z" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="topbar-mini-btn is-skip"
          onClick={() => media.skipActive(skipStep)}
          title={`快进 ${skipStep} 秒`}
          aria-label={`快进 ${skipStep} 秒`}
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path
              d="M13 7.8A5 5 0 108 13a5 5 0 003.8-1.7"
              strokeLinecap="round"
            />
            <path
              d="M13 4.5v3.3H9.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <MiniPlayerTimeAndProgress
          meta={meta}
          onSeek={(sec) => media.seekActive(sec)}
        />

        <button
          type="button"
          className={`topbar-mini-btn is-mute${meta.muted ? ' is-muted' : ''}`}
          onClick={() => media.toggleMuteActive()}
          title={meta.muted ? '取消静音' : '静音'}
          aria-label={meta.muted ? '取消静音' : '静音'}
          aria-pressed={meta.muted}
        >
          {meta.muted ? (
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M2.5 6H4l3-3v10l-3-3H2.5A.5.5 0 012 9.5v-3a.5.5 0 01.5-.5z" />
              <path
                d="M11 5l3.8 6M14.8 5L11 11"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M2.5 6H4l3-3v10l-3-3H2.5A.5.5 0 012 9.5v-3a.5.5 0 01.5-.5z" />
              <path
                d="M10 5.3a3.6 3.6 0 010 5.4M11.7 3.5a6 6 0 010 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="topbar-mini-btn is-open"
          onClick={() => onJumpToSource(meta.kind, meta.id)}
          title={`前往${meta.kind === 'podcast' ? '订阅播客' : '视频播放器'}`}
          aria-label={`前往${meta.kind === 'podcast' ? '订阅播客' : '视频播放器'}`}
        >
          <svg
            viewBox="0 0 16 16"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path
              d="M6.5 3.5H3.5v9h9v-3M9 3.5h3.5V7M12.5 3.5L7 9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          type="button"
          className="topbar-mini-btn is-close"
          onClick={() => media.dismissMiniPlayer()}
          title="关闭播放栏目并停止播放"
          aria-label="关闭播放栏目并停止播放"
        >
          ×
        </button>
      </div>
    </div>
  );
};
