import { useEffect, useState } from 'react';
import { formatDuration } from './format';
import { CloseIcon } from './icons';
import { playerApi } from './player-api';
import {
  FAVORITE_CATEGORY_COLORS,
  type FavoritesSnapshot,
  type VideoInput,
  type VideoItem,
} from './types';
import { parseYouTubeTarget, thumbnailUrl } from './video-links';
import { searchYouTubeVideos } from './youtube-data';

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

export interface VideoPickerItem {
  videoId: string;
  title: string;
  channelName?: string | null;
  channelId?: string | null;
  durationSeconds?: number | null;
  thumbnailUrl?: string | null;
}

export type VideoPickerTab = 'fav' | 'history' | 'feed' | 'search' | 'url';

export interface VideoPickerModalProps {
  isOpen: boolean;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
  multiple?: boolean;
  onClose: () => void;
  onConfirm: (selected: VideoPickerItem[]) => void;
}

export function VideoPickerModal({
  isOpen,
  title = '选取课程视频',
  subtitle,
  confirmLabel = '添加所选视频',
  multiple = true,
  onClose,
  onConfirm,
}: VideoPickerModalProps) {
  const [tab, setTab] = useState<VideoPickerTab>('fav');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Favorites state
  const [favSnapshot, setFavSnapshot] = useState<FavoritesSnapshot | null>(
    null,
  );
  const [selectedFavCatId, setSelectedFavCatId] = useState<
    string | 'all' | 'uncategorized'
  >('all');
  const [favFilter, setFavFilter] = useState('');

  // History state
  const [historyItems, setHistoryItems] = useState<VideoItem[]>([]);
  const [historyFilter, setHistoryFilter] = useState('');

  // Feed state
  const [feedItems, setFeedItems] = useState<VideoItem[]>([]);
  const [feedFilter, setFeedFilter] = useState('');

  // YouTube search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<VideoInput[]>([]);
  const [searching, setSearching] = useState(false);

  // Manual URL state
  const [manualUrl, setManualUrl] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [resolvingManual, setResolvingManual] = useState(false);

  // Selected videos: Map of videoId -> VideoPickerItem
  const [selectedMap, setSelectedMap] = useState<Map<string, VideoPickerItem>>(
    new Map(),
  );

  // Load data on open or tab change
  useEffect(() => {
    if (!isOpen) {
      setSelectedMap(new Map());
      return;
    }

    if (tab === 'fav' && !favSnapshot) {
      setLoading(true);
      playerApi
        .favoritesSnapshot()
        .then((snap) => setFavSnapshot(snap))
        .catch((e) => setError(typeof e === 'string' ? e : '加载收藏夹失败'))
        .finally(() => setLoading(false));
    } else if (tab === 'history' && historyItems.length === 0) {
      setLoading(true);
      playerApi
        .history(80)
        .then((items) => setHistoryItems(items))
        .catch((e) => setError(typeof e === 'string' ? e : '加载历史记录失败'))
        .finally(() => setLoading(false));
    } else if (tab === 'feed' && feedItems.length === 0) {
      setLoading(true);
      playerApi
        .feed({ limit: 60 })
        .then((items) => setFeedItems(items))
        .catch((e) => setError(typeof e === 'string' ? e : '加载关注动态失败'))
        .finally(() => setLoading(false));
    }
  }, [isOpen, tab, favSnapshot, historyItems.length, feedItems.length]);

  if (!isOpen) return null;

  const toggleSelect = (item: VideoPickerItem) => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      if (next.has(item.videoId)) {
        next.delete(item.videoId);
      } else {
        if (!multiple) {
          next.clear();
        }
        next.set(item.videoId, item);
      }
      return next;
    });
  };

  const isSelected = (videoId: string) => selectedMap.has(videoId);

  // Filtered favorites
  const displayedFavs = (favSnapshot?.items ?? []).filter((fav) => {
    if (selectedFavCatId === 'uncategorized') {
      if (fav.categoryId !== null) return false;
    } else if (selectedFavCatId !== 'all') {
      if (fav.categoryId !== selectedFavCatId) return false;
    }
    if (favFilter.trim()) {
      const q = favFilter.toLowerCase();
      const matchTitle = fav.video.title.toLowerCase().includes(q);
      const matchChannel = fav.video.channelName?.toLowerCase().includes(q);
      const matchNote = fav.note?.toLowerCase().includes(q);
      if (!matchTitle && !matchChannel && !matchNote) return false;
    }
    return true;
  });

  const selectAllDisplayedFavs = () => {
    setSelectedMap((prev) => {
      const next = new Map(prev);
      for (const item of displayedFavs) {
        next.set(item.video.videoId, {
          videoId: item.video.videoId,
          title: item.video.title,
          channelName: item.video.channelName,
          channelId: item.video.channelId,
          durationSeconds: item.video.durationSeconds,
          thumbnailUrl: item.video.thumbnailUrl,
        });
      }
      return next;
    });
  };

  const handleSearchYouTube = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = searchQuery.trim();
    if (!q || searching) return;
    setSearching(true);
    setError('');
    try {
      const res = await searchYouTubeVideos(q, 16);
      setSearchResults(res);
      if (res.length === 0) {
        setError('未找到相关视频，可尝试不同关键词或直接粘贴 YouTube 链接。');
      }
    } catch (err) {
      setError(typeof err === 'string' ? err : 'YouTube 搜索失败，请检查网络');
    } finally {
      setSearching(false);
    }
  };

  const handleResolveManual = async () => {
    const raw = manualUrl.trim();
    if (!raw) return;
    const target = parseYouTubeTarget(raw);
    if (!target || target.kind !== 'video') {
      setError('无法识别的 YouTube 链接或 ID，请输入正确的链接。');
      return;
    }
    setResolvingManual(true);
    setError('');
    try {
      const info = await playerApi.fetchVideoInfo(target.videoId);
      setManualTitle(info.title);
      setSelectedMap((prev) => {
        const next = multiple ? new Map(prev) : new Map();
        next.set(target.videoId, {
          videoId: target.videoId,
          title: info.title || 'YouTube 视频',
          channelName: info.channelName,
        });
        return next;
      });
    } catch {
      // Fallback if network resolve fails
      setSelectedMap((prev) => {
        const next = multiple ? new Map(prev) : new Map();
        next.set(target.videoId, {
          videoId: target.videoId,
          title: manualTitle.trim() || `视频 ${target.videoId}`,
        });
        return next;
      });
    } finally {
      setResolvingManual(false);
    }
  };

  const handleConfirm = () => {
    const items = Array.from(selectedMap.values());
    if (items.length === 0) return;
    onConfirm(items);
    onClose();
  };

  return (
    <div
      className="lp-proposal-backdrop vpick-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="lp-proposal-modal vpick-modal">
        <header className="lp-proposal-head vpick-head">
          <div>
            <span className="lp-proposal-badge">
              {multiple ? '多源批量选取' : '单视频选取'}
            </span>
            <h3>{title}</h3>
            {subtitle && (
              <p
                style={{
                  margin: '4px 0 0',
                  fontSize: 12,
                  opacity: 0.78,
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            className="lp-icon-btn"
            aria-label="关闭选取窗口"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>

        {/* Tab navigation */}
        <div className="vpick-tabs">
          <button
            type="button"
            className={`vpick-tab${tab === 'fav' ? ' is-active' : ''}`}
            onClick={() => setTab('fav')}
          >
            ★ 我的收藏
            {favSnapshot ? ` (${favSnapshot.items.length})` : ''}
          </button>
          <button
            type="button"
            className={`vpick-tab${tab === 'history' ? ' is-active' : ''}`}
            onClick={() => setTab('history')}
          >
            ⏱ 播放历史
          </button>
          <button
            type="button"
            className={`vpick-tab${tab === 'feed' ? ' is-active' : ''}`}
            onClick={() => setTab('feed')}
          >
            ✦ 关注频道
          </button>
          <button
            type="button"
            className={`vpick-tab${tab === 'search' ? ' is-active' : ''}`}
            onClick={() => setTab('search')}
          >
            🔍 YouTube 在线搜索
          </button>
          <button
            type="button"
            className={`vpick-tab${tab === 'url' ? ' is-active' : ''}`}
            onClick={() => setTab('url')}
          >
            🔗 粘贴链接 / ID
          </button>
        </div>

        {error && (
          <div className="vpick-error" role="alert">
            {error}
          </div>
        )}

        {/* Tab Body */}
        <div className="lp-proposal-body vpick-body">
          {/* TAB 1: FAVORITES */}
          {tab === 'fav' && (
            <div className="vpick-panel">
              {/* Category selector row */}
              <div className="vpick-cat-bar">
                <button
                  type="button"
                  className={`vpick-cat-pill${selectedFavCatId === 'all' ? ' is-active' : ''}`}
                  onClick={() => setSelectedFavCatId('all')}
                >
                  全部 ({favSnapshot?.items.length ?? 0})
                </button>
                <button
                  type="button"
                  className={`vpick-cat-pill${selectedFavCatId === 'uncategorized' ? ' is-active' : ''}`}
                  onClick={() => setSelectedFavCatId('uncategorized')}
                >
                  未分类 (
                  {favSnapshot?.items.filter((i) => !i.categoryId).length ?? 0})
                </button>
                {(favSnapshot?.categories ?? []).map((cat) => {
                  const count = (favSnapshot?.items ?? []).filter(
                    (i) => i.categoryId === cat.categoryId,
                  ).length;
                  const colorMeta = FAVORITE_CATEGORY_COLORS.find(
                    (c) => c.id === cat.color,
                  );
                  return (
                    <button
                      key={cat.categoryId}
                      type="button"
                      className={`vpick-cat-pill${selectedFavCatId === cat.categoryId ? ' is-active' : ''}`}
                      onClick={() => setSelectedFavCatId(cat.categoryId)}
                    >
                      <span
                        className="vpick-cat-dot"
                        style={{
                          background: colorMeta?.accent ?? '#df735b',
                        }}
                      />
                      {cat.name} ({count})
                    </button>
                  );
                })}
              </div>

              {/* Search & Actions */}
              <div className="vpick-filter-row">
                <div className="vpick-input-wrap">
                  <SearchIcon />
                  <input
                    type="text"
                    value={favFilter}
                    onChange={(e) => setFavFilter(e.target.value)}
                    placeholder="在收藏中过滤标题、频道或备注…"
                    className="vpick-input"
                  />
                </div>
                {multiple && displayedFavs.length > 0 && (
                  <button
                    type="button"
                    className="lp-btn"
                    onClick={selectAllDisplayedFavs}
                  >
                    全选当前列表 ({displayedFavs.length})
                  </button>
                )}
              </div>

              {/* Items grid */}
              {loading ? (
                <div className="vpick-empty">加载收藏视频中…</div>
              ) : displayedFavs.length === 0 ? (
                <div className="vpick-empty">此分类下暂无收藏视频</div>
              ) : (
                <div className="vpick-grid">
                  {displayedFavs.map((fav) => {
                    const checked = isSelected(fav.video.videoId);
                    return (
                      <div
                        key={fav.video.videoId}
                        className={`vpick-card${checked ? ' is-checked' : ''}`}
                        onClick={() =>
                          toggleSelect({
                            videoId: fav.video.videoId,
                            title: fav.video.title,
                            channelName: fav.video.channelName,
                            channelId: fav.video.channelId,
                            durationSeconds: fav.video.durationSeconds,
                            thumbnailUrl: fav.video.thumbnailUrl,
                          })
                        }
                      >
                        <input
                          type={multiple ? 'checkbox' : 'radio'}
                          checked={checked}
                          onChange={() => {}}
                          className="vpick-checkbox"
                        />
                        <img
                          src={
                            fav.video.thumbnailUrl ??
                            thumbnailUrl(fav.video.videoId, 'mq')
                          }
                          alt=""
                          className="vpick-thumb"
                          loading="lazy"
                        />
                        <div className="vpick-card-info">
                          <strong>{fav.video.title}</strong>
                          <span>
                            {fav.video.channelName ?? 'YouTube'}
                            {fav.video.durationSeconds
                              ? ` · ${formatDuration(fav.video.durationSeconds)}`
                              : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: HISTORY */}
          {tab === 'history' && (
            <div className="vpick-panel">
              <div className="vpick-filter-row">
                <div className="vpick-input-wrap">
                  <SearchIcon />
                  <input
                    type="text"
                    value={historyFilter}
                    onChange={(e) => setHistoryFilter(e.target.value)}
                    placeholder="过滤最近观看记录…"
                    className="vpick-input"
                  />
                </div>
              </div>
              {loading ? (
                <div className="vpick-empty">加载播放历史…</div>
              ) : historyItems.length === 0 ? (
                <div className="vpick-empty">暂无播放历史</div>
              ) : (
                <div className="vpick-grid">
                  {historyItems
                    .filter((item) =>
                      historyFilter.trim()
                        ? item.title
                            .toLowerCase()
                            .includes(historyFilter.toLowerCase()) ||
                          item.channelName
                            ?.toLowerCase()
                            .includes(historyFilter.toLowerCase())
                        : true,
                    )
                    .map((item) => {
                      const checked = isSelected(item.videoId);
                      return (
                        <div
                          key={item.videoId}
                          className={`vpick-card${checked ? ' is-checked' : ''}`}
                          onClick={() =>
                            toggleSelect({
                              videoId: item.videoId,
                              title: item.title,
                              channelName: item.channelName,
                              channelId: item.channelId,
                              durationSeconds: item.durationSeconds,
                              thumbnailUrl: item.thumbnailUrl,
                            })
                          }
                        >
                          <input
                            type={multiple ? 'checkbox' : 'radio'}
                            checked={checked}
                            onChange={() => {}}
                            className="vpick-checkbox"
                          />
                          <img
                            src={
                              item.thumbnailUrl ??
                              thumbnailUrl(item.videoId, 'mq')
                            }
                            alt=""
                            className="vpick-thumb"
                            loading="lazy"
                          />
                          <div className="vpick-card-info">
                            <strong>{item.title}</strong>
                            <span>
                              {item.channelName ?? 'YouTube'}
                              {item.durationSeconds
                                ? ` · ${formatDuration(item.durationSeconds)}`
                                : ''}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: FEED */}
          {tab === 'feed' && (
            <div className="vpick-panel">
              <div className="vpick-filter-row">
                <div className="vpick-input-wrap">
                  <SearchIcon />
                  <input
                    type="text"
                    value={feedFilter}
                    onChange={(e) => setFeedFilter(e.target.value)}
                    placeholder="过滤已订阅频道视频…"
                    className="vpick-input"
                  />
                </div>
              </div>
              {loading ? (
                <div className="vpick-empty">加载关注频道更新…</div>
              ) : feedItems.length === 0 ? (
                <div className="vpick-empty">暂无关注频道动态</div>
              ) : (
                <div className="vpick-grid">
                  {feedItems
                    .filter((item) =>
                      feedFilter.trim()
                        ? item.title
                            .toLowerCase()
                            .includes(feedFilter.toLowerCase()) ||
                          item.channelName
                            ?.toLowerCase()
                            .includes(feedFilter.toLowerCase())
                        : true,
                    )
                    .map((item) => {
                      const checked = isSelected(item.videoId);
                      return (
                        <div
                          key={item.videoId}
                          className={`vpick-card${checked ? ' is-checked' : ''}`}
                          onClick={() =>
                            toggleSelect({
                              videoId: item.videoId,
                              title: item.title,
                              channelName: item.channelName,
                              channelId: item.channelId,
                              durationSeconds: item.durationSeconds,
                              thumbnailUrl: item.thumbnailUrl,
                            })
                          }
                        >
                          <input
                            type={multiple ? 'checkbox' : 'radio'}
                            checked={checked}
                            onChange={() => {}}
                            className="vpick-checkbox"
                          />
                          <img
                            src={
                              item.thumbnailUrl ??
                              thumbnailUrl(item.videoId, 'mq')
                            }
                            alt=""
                            className="vpick-thumb"
                            loading="lazy"
                          />
                          <div className="vpick-card-info">
                            <strong>{item.title}</strong>
                            <span>
                              {item.channelName ?? 'YouTube'}
                              {item.durationSeconds
                                ? ` · ${formatDuration(item.durationSeconds)}`
                                : ''}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: YOUTUBE SEARCH */}
          {tab === 'search' && (
            <div className="vpick-panel">
              <form onSubmit={handleSearchYouTube} className="vpick-filter-row">
                <div className="vpick-input-wrap">
                  <SearchIcon />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="输入 YouTube 检索关键词（如：Rust 教程 / Three.js 入门）…"
                    className="vpick-input"
                  />
                </div>
                <button
                  type="submit"
                  className="lp-btn is-primary"
                  disabled={!searchQuery.trim() || searching}
                >
                  <SearchIcon />
                  {searching ? '搜索中…' : '检索 YouTube'}
                </button>
              </form>

              {searching ? (
                <div className="vpick-empty">正在实时检索 YouTube 视频…</div>
              ) : searchResults.length === 0 ? (
                <div className="vpick-empty">
                  输入关键词检索，即可直接将 YouTube 真实视频加入学习路径。
                </div>
              ) : (
                <div className="vpick-grid">
                  {searchResults.map((item) => {
                    const checked = isSelected(item.videoId);
                    return (
                      <div
                        key={item.videoId}
                        className={`vpick-card${checked ? ' is-checked' : ''}`}
                        onClick={() =>
                          toggleSelect({
                            videoId: item.videoId,
                            title: item.title,
                            channelName: item.channelName,
                            channelId: item.channelId,
                            durationSeconds: item.durationSeconds,
                            thumbnailUrl: item.thumbnailUrl,
                          })
                        }
                      >
                        <input
                          type={multiple ? 'checkbox' : 'radio'}
                          checked={checked}
                          onChange={() => {}}
                          className="vpick-checkbox"
                        />
                        <img
                          src={
                            item.thumbnailUrl ??
                            thumbnailUrl(item.videoId, 'mq')
                          }
                          alt=""
                          className="vpick-thumb"
                          loading="lazy"
                        />
                        <div className="vpick-card-info">
                          <strong>{item.title}</strong>
                          <span>
                            {item.channelName ?? 'YouTube'}
                            {item.durationSeconds
                              ? ` · ${formatDuration(item.durationSeconds)}`
                              : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 5: MANUAL URL / ID */}
          {tab === 'url' && (
            <div className="vpick-panel" style={{ padding: '8px 0' }}>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  maxWidth: 580,
                }}
              >
                <label style={{ fontSize: 13, fontWeight: 500 }}>
                  YouTube 视频链接或 11 位 ID
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <input
                      type="text"
                      value={manualUrl}
                      onChange={(e) => setManualUrl(e.target.value)}
                      placeholder="https://www.youtube.com/watch?v=... 或 youtu.be/..."
                      className="vpick-input"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="lp-btn"
                      disabled={!manualUrl.trim() || resolvingManual}
                      onClick={() => void handleResolveManual()}
                    >
                      {resolvingManual ? '解析中…' : '解析视频'}
                    </button>
                  </div>
                </label>

                <label style={{ fontSize: 13, fontWeight: 500 }}>
                  课程节点标题（可选，解析后自动填入）
                  <input
                    type="text"
                    value={manualTitle}
                    onChange={(e) => setManualTitle(e.target.value)}
                    placeholder="留空时自动读取视频标题"
                    className="vpick-input"
                    style={{ marginTop: 6, width: '100%' }}
                  />
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <footer className="lp-proposal-foot vpick-foot">
          <div className="vpick-foot-stat">
            <span>
              已选择{' '}
              <strong style={{ color: 'var(--player-accent, #df735b)' }}>
                {selectedMap.size}
              </strong>{' '}
              个视频
            </span>
            {selectedMap.size > 0 && (
              <button
                type="button"
                className="lp-btn"
                onClick={() => setSelectedMap(new Map())}
                style={{ fontSize: 11, height: 24, padding: '0 6px' }}
              >
                清空所选
              </button>
            )}
          </div>
          <div className="lp-proposal-foot-actions">
            <button type="button" className="lp-btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="lp-btn is-primary"
              disabled={selectedMap.size === 0}
              onClick={handleConfirm}
            >
              {confirmLabel} ({selectedMap.size})
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
