import React from 'react';
import type { FeedArticle } from './types';

interface FeedArticleListProps {
  articles: FeedArticle[];
  selectedArticleId: string | null;
  filterMode: 'all' | 'unread' | 'starred' | 'audio';
  searchQuery: string;
  loading: boolean;
  onSelectArticle: (article: FeedArticle) => void;
  onChangeFilterMode: (mode: 'all' | 'unread' | 'starred' | 'audio') => void;
  onChangeSearchQuery: (query: string) => void;
  onMarkAllRead: () => void;
  onOpenGalaxy: () => void;
  onPlayAudio?: (article: FeedArticle) => void;
  translatedIds?: ReadonlySet<string>;
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;

  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export const FeedArticleList: React.FC<FeedArticleListProps> = ({
  articles,
  selectedArticleId,
  filterMode,
  searchQuery,
  loading,
  onSelectArticle,
  onChangeFilterMode,
  onChangeSearchQuery,
  onMarkAllRead,
  onOpenGalaxy,
  onPlayAudio,
  translatedIds,
}) => {
  return (
    <section className="feed-article-pane">
      {/* 栏目 Header：与相邻栏目保持 48px 完全一致的水平线高度 */}
      <div className="feed-article-header">
        <div
          className="feed-filter-segmented"
          role="tablist"
          aria-label="文章筛选"
        >
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'all'}
            className={`feed-segmented-item ${filterMode === 'all' ? 'is-active' : ''}`}
            onClick={() => onChangeFilterMode('all')}
          >
            全部
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'unread'}
            className={`feed-segmented-item ${filterMode === 'unread' ? 'is-active' : ''}`}
            onClick={() => onChangeFilterMode('unread')}
          >
            未读
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'starred'}
            className={`feed-segmented-item ${filterMode === 'starred' ? 'is-active' : ''}`}
            onClick={() => onChangeFilterMode('starred')}
          >
            星标
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filterMode === 'audio'}
            className={`feed-segmented-item ${filterMode === 'audio' ? 'is-active' : ''}`}
            onClick={() => onChangeFilterMode('audio')}
          >
            音频
          </button>
        </div>

        <div className="feed-article-toolbar-actions">
          <button
            type="button"
            className="feed-action-btn"
            onClick={onOpenGalaxy}
            title="查看订阅源星系分布拓扑"
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              aria-hidden="true"
              className="feed-btn-icon"
            >
              <circle
                cx="8"
                cy="8"
                r="3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <circle cx="3" cy="5" r="1.4" fill="currentColor" />
              <circle cx="13" cy="11" r="1.4" fill="currentColor" />
              <circle cx="12" cy="4" r="1" fill="currentColor" />
            </svg>
            <span>星系</span>
          </button>
          <button
            type="button"
            className="feed-action-btn"
            onClick={onMarkAllRead}
            title="将当前列表文章全部标记为已读"
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              aria-hidden="true"
              className="feed-btn-icon"
            >
              <path
                d="M2.5 8.5l3.5 3.5 7.5-7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>全部已读</span>
          </button>
        </div>
      </div>

      {/* 搜索工具条：置顶且平滑连接列表 */}
      <div className="feed-article-search-bar">
        <div className="feed-search-input-wrap">
          <svg
            className="feed-search-icon"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            aria-hidden="true"
          >
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
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="text"
            className="feed-search-input"
            placeholder="搜索文章标题与正文关键词..."
            value={searchQuery}
            onChange={(e) => onChangeSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="feed-search-clear"
              onClick={() => onChangeSearchQuery('')}
              title="清空搜索"
              aria-label="清空搜索"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="feed-article-scroll">
        {loading && articles.length === 0 ? (
          <div
            style={{
              padding: '24px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: '13px',
            }}
          >
            加载文章列表中...
          </div>
        ) : articles.length === 0 ? (
          <div
            style={{
              padding: '36px 20px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: '13px',
            }}
          >
            暂无匹配文章
          </div>
        ) : (
          articles.map((article) => {
            const isActive = selectedArticleId === article.id;
            const isUnread = article.readStatus === 'unread';

            return (
              <div
                key={article.id}
                className={`feed-article-card ${isActive ? 'is-active' : ''} ${
                  !isUnread ? 'is-read' : ''
                }`}
                onClick={() => onSelectArticle(article)}
              >
                <div className="feed-article-card-meta">
                  <span className="feed-card-channel-name">
                    {article.channelTitle}
                  </span>
                  <span>{formatRelativeTime(article.publishedAt)}</span>
                </div>

                <h4 className="feed-article-card-title">{article.title}</h4>

                {article.summary && (
                  <p className="feed-article-card-summary">{article.summary}</p>
                )}

                <div className="feed-card-footer">
                  {article.audioUrl && (
                    <button
                      type="button"
                      className="feed-tag-pill is-audio-badge"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayAudio?.(article);
                      }}
                      title="点击播放播客原声"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        width="10"
                        height="10"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path d="M4 3.5l9 4.5-9 4.5V3.5z" />
                      </svg>
                      <span>
                        {article.audioDuration
                          ? `${Math.floor(article.audioDuration / 60)}:${String(article.audioDuration % 60).padStart(2, '0')}`
                          : '播客'}
                      </span>
                    </button>
                  )}
                  {isUnread && (
                    <span className="feed-tag-pill is-unread">未读</span>
                  )}
                  {translatedIds?.has(article.id) && (
                    <span className="feed-tag-pill is-translated">已译</span>
                  )}
                  {article.starred && (
                    <span className="feed-tag-pill is-starred">★ 星标</span>
                  )}
                  {article.author && (
                    <span className="feed-tag-pill">
                      作者: {article.author}
                    </span>
                  )}
                  <span className="feed-tag-pill">
                    {article.readingTimeMin} 分钟读完
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};
