import React, { useEffect, useMemo, useState } from 'react';
import type { FeedChannelWithStats, FeedOverview } from './types';

const COLLAPSED_CATEGORIES_KEY = 'seamind:feed-collapsed-categories:v1';

// 从本机偏好恢复已收起的分类，避免每次打开订阅页都重新整理列表。
function readCollapsedCategories(): Set<string> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(COLLAPSED_CATEGORIES_KEY) ?? '[]',
    );
    return new Set(
      Array.isArray(value)
        ? value.filter(
            (category): category is string => typeof category === 'string',
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

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
  onOpenCreateCategory: () => void;
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
  onOpenCreateCategory,
  onOpenImportOpml,
  onOpenExportOpml,
  onRefreshAll,
  onDeleteChannel,
}) => {
  const [collapsedCategories, setCollapsedCategories] = useState(
    readCollapsedCategories,
  );
  const categories = overview?.categories ?? [];
  const allCategoriesCollapsed =
    categories.length > 0 &&
    categories.every((category) => collapsedCategories.has(category.name));

  useEffect(() => {
    try {
      localStorage.setItem(
        COLLAPSED_CATEGORIES_KEY,
        JSON.stringify([...collapsedCategories]),
      );
    } catch {
      // 本机存储不可用时仍保留当前会话中的折叠状态。
    }
  }, [collapsedCategories]);

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
        <div className="feed-nav-section-heading">
          <div className="feed-nav-section-title">分类订阅源</div>
          {categories.length > 1 && (
            <button
              type="button"
              className="feed-category-bulk-toggle"
              onClick={() =>
                setCollapsedCategories(
                  allCategoriesCollapsed
                    ? new Set()
                    : new Set(categories.map((category) => category.name)),
                )
              }
              title={allCategoriesCollapsed ? '展开全部分类' : '收起全部分类'}
              aria-label={
                allCategoriesCollapsed ? '展开全部分类' : '收起全部分类'
              }
            >
              {allCategoriesCollapsed ? '全部展开' : '全部收起'}
            </button>
          )}
          <button
            type="button"
            className="feed-text-btn feed-add-category-btn"
            onClick={onOpenCreateCategory}
            title="新建分类"
          >
            + 分类
          </button>
        </div>

        {(!overview?.categories || overview.categories.length === 0) && (
          <div
            style={{
              padding: '12px 8px',
              fontSize: '12px',
              color: 'var(--muted)',
              lineHeight: '1.6',
            }}
          >
            暂无分类，可新建分类或添加订阅源
          </div>
        )}

        {categories.map((category) => {
          const channels = channelsByCategory[category.name] ?? [];
          const isCatActive =
            selectedCategory === category.name && !selectedChannelId;
          const isCollapsed = collapsedCategories.has(category.name);
          const channelsPanelId = `feed-category-${encodeURIComponent(category.name)}`;
          const catUnread = channels.reduce(
            (sum, ch) => sum + ch.unreadCount,
            0,
          );

          return (
            <section
              key={category.name}
              className={`feed-category-group ${isCollapsed ? 'is-collapsed' : ''}`}
              aria-label={`${category.name}分类`}
            >
              <div className="feed-category-heading-row">
                <button
                  type="button"
                  className="feed-category-toggle"
                  onClick={() => {
                    setCollapsedCategories((current) => {
                      const next = new Set(current);
                      if (next.has(category.name)) next.delete(category.name);
                      else next.add(category.name);
                      return next;
                    });
                  }}
                  title={`${isCollapsed ? '展开' : '收起'}该分类`}
                  aria-label={`${isCollapsed ? '展开' : '收起'}${category.name}分类`}
                  aria-expanded={!isCollapsed}
                  aria-controls={channelsPanelId}
                >
                  <span className="feed-category-chevron" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`feed-category-filter ${isCatActive ? 'is-active' : ''}`}
                  onClick={() => onSelectCategory(category.name)}
                  title={`查看「${category.name}」中的全部文章`}
                  aria-pressed={isCatActive}
                >
                  <span
                    className="feed-category-dot"
                    style={{ backgroundColor: category.color }}
                    aria-hidden="true"
                  />
                  <span className="feed-category-name">{category.name}</span>
                  <span
                    className={`feed-category-count ${catUnread > 0 ? 'has-unread' : ''}`}
                    title={`${catUnread} 篇未读`}
                  >
                    {catUnread}
                  </span>
                </button>
              </div>

              <div
                id={channelsPanelId}
                className="feed-category-channels"
                hidden={isCollapsed}
                aria-hidden={isCollapsed}
              >
                {channels.map((ch) => {
                  const isChActive = selectedChannelId === ch.id;
                  return (
                    <div
                      key={ch.id}
                      className={`feed-channel-row ${isChActive ? 'is-active' : ''}`}
                    >
                      <button
                        type="button"
                        className={`feed-nav-item feed-channel-item ${
                          isChActive ? 'is-active' : ''
                        }`}
                        onClick={() => onSelectChannel(ch.id)}
                        title={ch.url}
                        aria-pressed={isChActive}
                      >
                        <span className="feed-nav-item-name">
                          {ch.title || '未命名'}
                        </span>
                        {ch.unreadCount > 0 && (
                          <span className="feed-channel-count">
                            {ch.unreadCount}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="feed-channel-unsubscribe"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (window.confirm(`确认退订「${ch.title}」？`)) {
                            onDeleteChannel(ch.id);
                          }
                        }}
                        title={`退订「${ch.title}」`}
                        aria-label={`退订「${ch.title}」`}
                      >
                        退订
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

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
