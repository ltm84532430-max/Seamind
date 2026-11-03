import React, { useMemo } from 'react';
import type { FeedChannelWithStats, FeedOverview } from './types';

interface FeedSidebarProps {
  overview: FeedOverview | null;
  selectedChannelId: string | null;
  selectedCategory: string | null;
  currentFilterMode: 'all' | 'unread' | 'starred';
  onSelectAll: () => void;
  onSelectUnread: () => void;
  onSelectStarred: () => void;
  onSelectCategory: (category: string) => void;
  onSelectChannel: (channelId: string) => void;
  onOpenAddDialog: () => void;
  onOpenImportOpml: () => void;
  onOpenExportOpml: () => void;
  onRefreshAll: () => void;
  onDeleteChannel: (channelId: string) => void;
}

export const FeedSidebar: React.FC<FeedSidebarProps> = ({
  overview,
  selectedChannelId,
  selectedCategory,
  currentFilterMode,
  onSelectAll,
  onSelectUnread,
  onSelectStarred,
  onSelectCategory,
  onSelectChannel,
  onOpenAddDialog,
  onOpenImportOpml,
  onOpenExportOpml,
  onRefreshAll,
  onDeleteChannel,
}) => {
  // Group channels by category
  const channelsByCategory = useMemo(() => {
    if (!overview?.channels) return {};
    const grouped: Record<string, FeedChannelWithStats[]> = {};
    for (const ch of overview.channels) {
      const cat = ch.category || '默认分类';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ch);
    }
    return grouped;
  }, [overview?.channels]);

  return (
    <aside className="feed-sidebar">
      <div className="feed-sidebar-header">
        <span className="feed-sidebar-title">博客与 RSS</span>
        <div className="feed-sidebar-actions">
          <button
            type="button"
            className="feed-text-btn is-primary"
            onClick={onOpenAddDialog}
            title="添加新订阅源"
          >
            + 订阅
          </button>
          <button
            type="button"
            className="feed-text-btn"
            onClick={onRefreshAll}
            title="刷新全部订阅源"
          >
            刷新
          </button>
        </div>
      </div>

      <div className="feed-sidebar-scroll">
        {/* Core Views */}
        <div className="feed-nav-section-title">阅读导航</div>

        <button
          type="button"
          className={`feed-nav-item ${
            currentFilterMode === 'all' &&
            !selectedChannelId &&
            !selectedCategory
              ? 'is-active'
              : ''
          }`}
          onClick={onSelectAll}
        >
          <span className="feed-nav-item-name">全部文章</span>
          <span className="feed-badge">[{overview?.totalArticles ?? 0}]</span>
        </button>

        <button
          type="button"
          className={`feed-nav-item ${
            currentFilterMode === 'unread' &&
            !selectedChannelId &&
            !selectedCategory
              ? 'is-active'
              : ''
          }`}
          onClick={onSelectUnread}
        >
          <span className="feed-nav-item-name">未读文章</span>
          <span
            className={`feed-badge ${
              (overview?.totalUnread ?? 0) > 0 ? 'has-unread' : ''
            }`}
          >
            [{overview?.totalUnread ?? 0}]
          </span>
        </button>

        <button
          type="button"
          className={`feed-nav-item ${
            currentFilterMode === 'starred' &&
            !selectedChannelId &&
            !selectedCategory
              ? 'is-active'
              : ''
          }`}
          onClick={onSelectStarred}
        >
          <span className="feed-nav-item-name">星标收藏</span>
          <span className="feed-badge">[{overview?.totalStarred ?? 0}]</span>
        </button>

        {/* Categories & Channels */}
        <div className="feed-nav-section-title" style={{ marginTop: '12px' }}>
          分类订阅源
        </div>

        {Object.keys(channelsByCategory).length === 0 ? (
          <div
            style={{
              padding: '12px 8px',
              fontSize: '12px',
              color: 'var(--muted)',
              lineHeight: '1.6',
            }}
          >
            暂无订阅源，可点击上方「+ 订阅」或「导入 OPML」开始
          </div>
        ) : (
          Object.entries(channelsByCategory).map(([cat, channels]) => {
            const isCatActive = selectedCategory === cat && !selectedChannelId;
            const catUnread = channels.reduce(
              (sum, ch) => sum + ch.unreadCount,
              0,
            );

            return (
              <div key={cat} className="feed-category-group">
                <button
                  type="button"
                  className={`feed-nav-item ${isCatActive ? 'is-active' : ''}`}
                  onClick={() => onSelectCategory(cat)}
                  style={{ fontWeight: 600 }}
                >
                  <span className="feed-nav-item-name">{cat}</span>
                  <span
                    className={`feed-badge ${
                      catUnread > 0 ? 'has-unread' : ''
                    }`}
                  >
                    [{catUnread}]
                  </span>
                </button>

                {channels.map((ch) => {
                  const isChActive = selectedChannelId === ch.id;
                  return (
                    <div
                      key={ch.id}
                      style={{ display: 'flex', alignItems: 'center' }}
                    >
                      <button
                        type="button"
                        className={`feed-nav-item feed-channel-item ${
                          isChActive ? 'is-active' : ''
                        }`}
                        onClick={() => onSelectChannel(ch.id)}
                        title={ch.url}
                      >
                        <span className="feed-nav-item-name">
                          {ch.title || '未命名'}
                        </span>
                        {ch.unreadCount > 0 && (
                          <span className="feed-badge has-unread">
                            [{ch.unreadCount}]
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="feed-text-btn"
                        style={{
                          fontSize: '10px',
                          padding: '1px 4px',
                          marginRight: '6px',
                          opacity: 0.6,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`确认退订「${ch.title}」？`)) {
                            onDeleteChannel(ch.id);
                          }
                        }}
                        title="退订"
                      >
                        退订
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}

        {/* OPML Actions */}
        <div
          style={{
            marginTop: 'auto',
            paddingTop: '16px',
            display: 'flex',
            gap: '6px',
          }}
        >
          <button
            type="button"
            className="feed-text-btn"
            style={{ flex: 1, textAlign: 'center' }}
            onClick={onOpenImportOpml}
          >
            导入 OPML
          </button>
          <button
            type="button"
            className="feed-text-btn"
            style={{ flex: 1, textAlign: 'center' }}
            onClick={onOpenExportOpml}
          >
            导出 OPML
          </button>
        </div>
      </div>
    </aside>
  );
};
