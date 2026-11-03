import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { fetchVideoTranscript } from './fetcher';
import { parseVttOrSrt } from './parser';
import type { TranscriptCue, TranscriptViewMode } from './types';

export interface TranscriptPanelProps {
  videoId: string;
  videoTitle?: string;
  currentTime: number;
  onSeek(seconds: number): void;
  onToggleLoopCue?(cue: TranscriptCue | null): void;
  loopingCueId?: string | null;
  onToggleShadowMode?(enabled: boolean): void;
  shadowMode?: boolean;
  onShowNotice?(text: string): void;
  onCuesLoaded?(cues: TranscriptCue[]): void;
}

function formatCueTime(seconds: number): string {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const secs = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mins = m % 60;
    return `${h}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${m}:${secs.toString().padStart(2, '0')}`;
}

export default function TranscriptPanel({
  videoId,
  videoTitle,
  currentTime,
  onSeek,
  onToggleLoopCue,
  loopingCueId,
  onToggleShadowMode,
  shadowMode = false,
  onShowNotice,
  onCuesLoaded,
}: TranscriptPanelProps) {
  const [cues, setCues] = useState<TranscriptCue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<TranscriptViewMode>('bilingual');
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeElementRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleRetry = useCallback(() => {
    try {
      localStorage.removeItem(`seamind:transcript:v1:${videoId}`);
    } catch {
      // ignore
    }
    setRetryCount((c) => c + 1);
  }, [videoId]);

  // Load transcript when videoId or retryCount changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchVideoTranscript(videoId)
      .then((res) => {
        if (cancelled) return;
        setCues(res.cues);
        onCuesLoaded?.(res.cues);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : '加载字幕失败';
        setError(msg);
        setCues([]);
        onCuesLoaded?.([]);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [videoId, retryCount, onCuesLoaded]);

  // Find active cue based on currentTime
  const activeCue = useMemo(() => {
    if (!cues.length) return null;
    return (
      cues.find((c) => currentTime >= c.start && currentTime <= c.end + 0.3) ??
      null
    );
  }, [cues, currentTime]);

  // Auto-scroll to active cue smoothly
  useEffect(() => {
    if (
      !autoScroll ||
      !activeCue ||
      !listRef.current ||
      !activeElementRef.current
    )
      return;
    const container = listRef.current;
    const element = activeElementRef.current;

    const containerTop = container.scrollTop;
    const containerBottom = containerTop + container.clientHeight;
    const elemTop = element.offsetTop;
    const elemBottom = elemTop + element.offsetHeight;

    if (elemTop < containerTop + 40 || elemBottom > containerBottom - 40) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeCue, autoScroll]);

  // Filtered cues
  const filteredCues = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cues;
    return cues.filter(
      (c) =>
        c.text.toLowerCase().includes(q) ||
        (c.translation && c.translation.toLowerCase().includes(q)),
    );
  }, [cues, search]);

  const handleImportFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (content) {
        const parsed = parseVttOrSrt(content);
        if (parsed.length > 0) {
          setCues(parsed);
          onCuesLoaded?.(parsed);
          setError(null);
          onShowNotice?.(`成功导入 ${parsed.length} 条本地字幕`);
        } else {
          onShowNotice?.(
            '无法解析此字幕文件，请确认是否为有效 .vtt 或 .srt 格式',
          );
        }
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const copyCueToMindmap = useCallback(
    (cue: TranscriptCue) => {
      const startSec = Math.floor(cue.start);
      const timeLabel = formatCueTime(cue.start);
      const url = `https://www.youtube.com/watch?v=${videoId}&t=${startSec}s`;
      let snippet = `> [▶ ${timeLabel}](${url}) ${cue.text}`;
      if (cue.translation) {
        snippet += `\n> *${cue.translation}*`;
      }

      navigator.clipboard
        .writeText(snippet)
        .then(() => {
          onShowNotice?.(`已复制导图引用卡片 [▶ ${timeLabel}]`);
        })
        .catch(() => {
          onShowNotice?.('复制失败，请重试');
        });
    },
    [videoId, onShowNotice],
  );

  return (
    <div
      className="player-transcript-panel"
      aria-label={
        videoTitle ? `《${videoTitle}》视频台词与字幕` : '视频台词与字幕'
      }
    >
      {/* 顶部工具栏 */}
      <div className="player-transcript-toolbar">
        <div className="player-transcript-search">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <circle
              cx="7"
              cy="7"
              r="4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M10.5 10.5L14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索台词或中英文关键词…"
            aria-label="搜索台词"
          />
          {search && (
            <button
              type="button"
              className="player-transcript-search-clear"
              onClick={() => setSearch('')}
              title="清除搜索"
            >
              ×
            </button>
          )}
        </div>

        <div className="player-transcript-modes">
          <button
            type="button"
            className={`player-transcript-btn${viewMode === 'bilingual' ? ' is-active' : ''}`}
            onClick={() => setViewMode('bilingual')}
            title="双语对照模式"
          >
            双语
          </button>
          <button
            type="button"
            className={`player-transcript-btn${viewMode === 'original' ? ' is-active' : ''}`}
            onClick={() => setViewMode('original')}
            title="仅显示原文"
          >
            原文
          </button>
          {cues.some((c) => Boolean(c.translation)) && (
            <button
              type="button"
              className={`player-transcript-btn${viewMode === 'translation' ? ' is-active' : ''}`}
              onClick={() => setViewMode('translation')}
              title="仅显示译文"
            >
              译文
            </button>
          )}
        </div>

        <div className="player-transcript-actions-bar">
          {/* 单句循环切换 */}
          <button
            type="button"
            className={`player-transcript-tool-icon${loopingCueId ? ' is-active' : ''}`}
            onClick={() => onToggleLoopCue?.(loopingCueId ? null : activeCue)}
            title={
              loopingCueId
                ? '正在单句循环 (快捷键 R 关闭)'
                : '单句 A-B 循环 (快捷键 R)'
            }
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M13 5H3.5a2.5 2.5 0 0 0 0 5H4M10 2l3 3-3 3M3 11h9.5a2.5 2.5 0 0 0 0-5H12M6 14l-3-3 3-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{loopingCueId ? '循环中' : '循环'}</span>
          </button>

          {/* 跟读暂停模式 */}
          <button
            type="button"
            className={`player-transcript-tool-icon${shadowMode ? ' is-active' : ''}`}
            onClick={() => onToggleShadowMode?.(!shadowMode)}
            title={
              shadowMode
                ? '影子跟读模式已开启 (每句结束自动暂停)'
                : '开启影子跟读模式'
            }
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <rect
                x="6"
                y="5.5"
                width="1.5"
                height="5"
                rx="0.5"
                fill="currentColor"
              />
              <rect
                x="8.5"
                y="5.5"
                width="1.5"
                height="5"
                rx="0.5"
                fill="currentColor"
              />
            </svg>
            <span>{shadowMode ? '跟读中' : '跟读'}</span>
          </button>

          {/* 自动滚动锁定 */}
          <button
            type="button"
            className={`player-transcript-tool-icon${autoScroll ? ' is-active' : ''}`}
            onClick={() => setAutoScroll((prev) => !prev)}
            title={
              autoScroll ? '跟随播放自动滚动已开启' : '点击开启跟随自动滚动'
            }
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M8 2v12M4 10l4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{autoScroll ? '跟随' : '锁定'}</span>
          </button>

          {/* 导入外部字幕 */}
          <button
            type="button"
            className="player-transcript-tool-icon"
            onClick={() => fileInputRef.current?.click()}
            title="导入本地 .vtt 或 .srt 字幕文件"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path
                d="M3 13h10M8 3v7M5 7l3 3 3-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>导入</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".vtt,.srt"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
        </div>
      </div>

      {/* 台词内容列表 */}
      <div ref={listRef} className="player-transcript-list">
        {loading && (
          <div className="player-transcript-state">
            <span className="player-transcript-spinner" aria-hidden="true" />
            <p>正在获取字幕与双语台词…</p>
          </div>
        )}

        {!loading && error && cues.length === 0 && (
          <div className="player-transcript-state is-error">
            <span className="player-transcript-error-badge">
              ⚠️ 网络或风控受限
            </span>
            <p className="player-transcript-error-msg">{error}</p>
            <div className="player-transcript-state-actions">
              <button
                type="button"
                className="player-btn is-primary"
                onClick={handleRetry}
              >
                🔄 重新检测字幕
              </button>
              <button
                type="button"
                className="player-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                导入本地字幕 (.vtt / .srt)
              </button>
            </div>
          </div>
        )}

        {!loading && !error && cues.length === 0 && (
          <div className="player-transcript-state">
            <p>此视频未提供官方台词字幕</p>
            <div className="player-transcript-state-actions">
              <button
                type="button"
                className="player-btn"
                onClick={handleRetry}
                title="重新请求网络检测字幕"
              >
                🔄 刷新检测
              </button>
              <button
                type="button"
                className="player-btn is-primary"
                onClick={() => fileInputRef.current?.click()}
              >
                导入字幕 (.vtt / .srt)
              </button>
            </div>
          </div>
        )}

        {!loading &&
          filteredCues.map((cue) => {
            const isActive = activeCue?.id === cue.id;
            const isLooping = loopingCueId === cue.id;

            return (
              <div
                key={cue.id}
                ref={isActive ? activeElementRef : null}
                className={`player-transcript-cue${isActive ? ' is-active' : ''}${
                  isLooping ? ' is-looping' : ''
                }`}
                onClick={() => onSeek(cue.start)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSeek(cue.start);
                }}
              >
                <div className="player-transcript-cue-head">
                  <span className="player-transcript-cue-time">
                    {formatCueTime(cue.start)}
                  </span>
                  <div
                    className="player-transcript-cue-tools"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* 单句复读 */}
                    <button
                      type="button"
                      className={`player-cue-btn${isLooping ? ' is-on' : ''}`}
                      onClick={() => onToggleLoopCue?.(isLooping ? null : cue)}
                      title={isLooping ? '停止复读本句' : '循环复读本句'}
                    >
                      🔁
                    </button>
                    {/* 插桩思维导图 */}
                    <button
                      type="button"
                      className="player-cue-btn"
                      onClick={() => copyCueToMindmap(cue)}
                      title="复制带时间戳的导图引用卡片"
                    >
                      📌
                    </button>
                  </div>
                </div>

                <div className="player-transcript-cue-text">
                  {viewMode !== 'translation' && (
                    <p className="cue-original">{cue.text}</p>
                  )}
                  {viewMode !== 'original' && cue.translation && (
                    <p className="cue-translation">{cue.translation}</p>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
