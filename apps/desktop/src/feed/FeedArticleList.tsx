import React from 'react';
import type { FeedArticle } from './types';

interface FeedArticleListProps {
  articles: FeedArticle[];
  selectedArticleId: string | null;
  filterMode: 'all' | 'unread' | 'starred';
  searchQuery: string;
  loading: boolean;
  onSelectArticle: (article: FeedArticle) => void;
  onChangeFilterMode: (mode: 'all' | 'unread' | 'starred') => void;
  onChangeSearchQuery: (query: string) => void;
  onMarkAllRead: () => void;
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
}) => {
  return (
    <section className="feed-article-pane">
      <div className="feed-article-header">
        <div className="feed-article-toolbar">
          <div className="feed-filter-tabs">
            <button
              type="button"
              className={`feed-filter-tab ${filterMode === 'all' ? 'is-active' : ''}`}
              onClick={() => onChangeFilterMode('all')}
            >
              全部
            </button>
            <button
              type="button"
              className={`feed-filter-tab ${
                filterMode === 'unread' ? 'is-active' : ''
              }`}
              onClick={() => onChangeFilterMode('unread')}
            >
              未读
            </button>
            <button
              type="button"
              className={`feed-filter-tab ${
                filterMode === 'starred' ? 'is-active' : ''
              }`}
              onClick={() => onChangeFilterMode('starred')}
            >
              星标
            </button>
          </div>

          <button
            type="button"
            className="feed-text-btn"
            onClick={onMarkAllRead}
            title="将当前列表文章标记为已读"
          >
            全部已读
          </button>
        </div>

        <input
          type="text"
          className="feed-search-input"
          placeholder="搜索文章标题与正文关键词..."
          value={searchQuery}
          onChange={(e) => onChangeSearchQuery(e.target.value)}
        />
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
                  {isUnread && (
                    <span className="feed-tag-pill is-unread">[未读]</span>
                  )}
                  {article.starred && (
                    <span className="feed-tag-pill is-starred">[星标]</span>
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
