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
  currentFilterMode: 'all' | 'unread' | 'starred' | 'audio';
  onSelectAll: () => void;
  onSelectUnread: () => void;
  onSelectStarred: () => void;
  onSelectAudio?: () => void;
  onSelectCategory: (category: string) => void;
  onSelectChannel: (channelId: string) => void;
  onOpenAddDialog: () => void;
  onOpenCreateCategory: () => void;
  onOpenImportOpml: () => void;
  onOpenExportOpml: () => void;
  onRefreshAll: () => void;
  onDeleteChannel: (channelId: string) => void;
  onMarkCategoryRead?: (category: string) => void;
  onRestoreDefaultFeeds?: () => void;
  isRestoring?: boolean;
}

export const FeedSidebar: React.FC<FeedSidebarProps> = ({
  overview,
  selectedChannelId,
  selectedCategory,
  currentFilterMode,
  onSelectAll,
  onSelectUnread,
  onSelectStarred,
  onSelectAudio,
  onSelectCategory,
  onSelectChannel,
  onOpenAddDialog,
  onOpenCreateCategory,
  onOpenImportOpml,
  onOpenExportOpml,
  onRefreshAll,
  onDeleteChannel,
  onMarkCategoryRead,
  onRestoreDefaultFeeds,
  isRestoring = false,
}) => {
  // 进入订阅页时默认显示订阅源列表，避免旧版本收起状态造成数据已丢失的错觉。
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => !current);
  };

  const toggleCategoryCollapse = (categoryName: string) => {
    setCollapsedCategories((current) => {
      const next = new Set(current);
      if (next.has(categoryName)) next.delete(categoryName);
      else next.add(categoryName);
      return next;
    });
  };

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

  if (sidebarCollapsed) {
    return (
      <aside className="feed-sidebar is-rail" aria-label="收起的订阅导航">
        <button
          type="button"
          className="feed-rail-button"
          onClick={toggleSidebar}
          title={`展开订阅导航（${overview?.channels.length ?? 0} 个订阅源）`}
          aria-label="展开订阅导航"
        >
          ›
        </button>
        <button
          type="button"
          className="feed-rail-button"
          onClick={onSelectAll}
          title="全部文章"
          aria-label="全部文章"
        >
          ≡
        </button>
        <button
          type="button"
          className="feed-rail-button"
          onClick={onSelectUnread}
          title="未读文章"
          aria-label="未读文章"
        >
          •
        </button>
        <button
          type="button"
          className="feed-rail-button"
          onClick={onSelectStarred}
          title="星标收藏"
          aria-label="星标收藏"
        >
          ☆
        </button>
        {onSelectAudio && (
          <button
            type="button"
            className="feed-rail-button"
            onClick={onSelectAudio}
            title="播客与音频"
            aria-label="播客与音频"
          >
            ♫
          </button>
        )}
        <button
          type="button"
          className="feed-rail-button"
          onClick={onOpenAddDialog}
          title="添加订阅源"
          aria-label="添加订阅源"
        >
          ＋
        </button>
      </aside>
    );
  }

  return (
    <aside className="feed-sidebar">
      {/* 侧边栏头部 */}
      <div className="feed-sidebar-header">
        <span className="feed-sidebar-title">博客与 RSS</span>
        <div className="feed-sidebar-actions">
          <button
            type="button"
            className="feed-header-btn feed-sidebar-collapse"
            onClick={toggleSidebar}
            title="收起订阅导航"
            aria-label="收起订阅导航"
          >
            ‹
          </button>
          <button
            type="button"
            className="feed-header-btn is-primary"
            onClick={onOpenAddDialog}
            title="添加新订阅源"
          >
            + 订阅
          </button>
          <button
            type="button"
            className="feed-header-btn"
            onClick={onRefreshAll}
            title="刷新全部订阅源"
          >
            刷新
          </button>
        </div>
      </div>

      <div className="feed-sidebar-scroll">
        {/* 阅读导航区 */}
        <div className="feed-section-header">
          <span className="feed-section-label">阅读导航</span>
        </div>

        <nav className="feed-nav-list" aria-label="阅读视图导航">
          <button
            type="button"
            className={`feed-nav-row ${
              currentFilterMode === 'all' &&
              !selectedChannelId &&
              !selectedCategory
                ? 'is-active'
                : ''
            }`}
            onClick={onSelectAll}
          >
            <span className="feed-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13">
                <path
                  d="M2.5 4h11M2.5 8h11M2.5 12h8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="feed-nav-label">全部文章</span>
            <span className="feed-nav-count">
              {overview?.totalArticles ?? 0}
            </span>
          </button>

          <button
            type="button"
            className={`feed-nav-row ${
              currentFilterMode === 'unread' &&
              !selectedChannelId &&
              !selectedCategory
                ? 'is-active'
                : ''
            }`}
            onClick={onSelectUnread}
          >
            <span className="feed-nav-icon is-unread-dot" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13">
                <circle cx="4.5" cy="8" r="2.5" fill="currentColor" />
                <path
                  d="M8.5 5h5M8.5 8h5M8.5 11h4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="feed-nav-label">未读文章</span>
            <span
              className={`feed-nav-count ${(overview?.totalUnread ?? 0) > 0 ? 'has-unread' : ''}`}
            >
              {overview?.totalUnread ?? 0}
            </span>
          </button>

          <button
            type="button"
            className={`feed-nav-row ${
              currentFilterMode === 'starred' &&
              !selectedChannelId &&
              !selectedCategory
                ? 'is-active'
                : ''
            }`}
            onClick={onSelectStarred}
          >
            <span className="feed-nav-icon is-star" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13">
                <path
                  d="M8 1.5l1.9 4.3 4.6.4-3.4 3.1 1 4.6L8 11.5l-4.1 2.4 1-4.6-3.4-3.1 4.6-.4L8 1.5z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="feed-nav-label">星标收藏</span>
            <span className="feed-nav-count">
              {overview?.totalStarred ?? 0}
            </span>
          </button>

          {onSelectAudio && (
            <button
              type="button"
              className={`feed-nav-row ${
                currentFilterMode === 'audio' &&
                !selectedChannelId &&
                !selectedCategory
                  ? 'is-active'
                  : ''
              }`}
              onClick={onSelectAudio}
            >
              <span className="feed-nav-icon is-audio" aria-hidden="true">
                <svg
                  viewBox="0 0 16 16"
                  width="13"
                  height="13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                >
                  <path d="M2.5 8v0M5 5.5v5M7.5 3v10M10 5.5v5M12.5 7v2" />
                </svg>
              </span>
              <span className="feed-nav-label">播客与音频</span>
              <span className="feed-nav-count">
                {overview?.totalAudios ?? 0}
              </span>
            </button>
          )}
        </nav>

        {/* 分类订阅源头部 */}
        <div className="feed-section-header is-collapsible">
          <span className="feed-section-label">分类订阅源</span>
          <div className="feed-section-controls">
            {categories.length > 1 && (
              <button
                type="button"
                className="feed-mini-btn"
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
              className="feed-mini-btn is-add"
              onClick={onOpenCreateCategory}
              title="新建分类"
            >
              + 分类
            </button>
          </div>
        </div>

        {(!overview?.categories || overview.categories.length === 0) && (
          <div
            className="feed-empty-tip"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              alignItems: 'center',
              padding: '16px 12px',
            }}
          >
            <span>暂无分类或订阅源</span>
            {onRestoreDefaultFeeds && (
              <button
                type="button"
                className="feed-header-btn is-primary"
                style={{ padding: '4px 12px', fontSize: '12px' }}
                onClick={onRestoreDefaultFeeds}
                disabled={isRestoring}
                title="一键恢复所有官方金融、军事与技术订阅源及播客"
              >
                {isRestoring ? '正在恢复推荐源...' : '恢复推荐订阅源'}
              </button>
            )}
          </div>
        )}

        {/* 分类列表（一体化机构级树形结构） */}
        <div
          className="feed-category-tree"
          role="tree"
          aria-label="订阅源分类树"
        >
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
              <div
                key={category.name}
                className={`feed-category-group ${isCollapsed ? 'is-collapsed' : ''}`}
                role="treeitem"
                aria-expanded={!isCollapsed}
                aria-selected={isCatActive}
              >
                {/* 一体化分类行 */}
                <div
                  className={`feed-category-row ${isCatActive ? 'is-active' : ''}`}
                  onClick={() => onSelectCategory(category.name)}
                  onDoubleClick={() => toggleCategoryCollapse(category.name)}
                  title={`点击查看「${category.name}」，双击${isCollapsed ? '展开' : '折叠'}`}
                >
                  {/* 折叠切换图标按钮 */}
                  <button
                    type="button"
                    className="feed-category-expander"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCategoryCollapse(category.name);
                    }}
                    title={
                      isCollapsed
                        ? `展开「${category.name}」`
                        : `折叠「${category.name}」`
                    }
                    aria-label={
                      isCollapsed
                        ? `展开「${category.name}」`
                        : `折叠「${category.name}」`
                    }
                    aria-controls={channelsPanelId}
                  >
                    <svg
                      className={`feed-chevron-icon ${isCollapsed ? '' : 'is-expanded'}`}
                      viewBox="0 0 16 16"
                      width="10"
                      height="10"
                      aria-hidden="true"
                    >
                      <path
                        d="M5.5 3.5l4.5 4.5-4.5 4.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>

                  {/* 机构级分类精致色标 */}
                  <span
                    className="feed-category-indicator"
                    style={{ backgroundColor: category.color || '#3b82f6' }}
                    aria-hidden="true"
                  />

                  {/* 分类标题 */}
                  <span className="feed-category-name">{category.name}</span>

                  {/* 悬浮快捷操作 */}
                  <div
                    className="feed-category-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {catUnread > 0 && onMarkCategoryRead && (
                      <button
                        type="button"
                        className="feed-category-action-icon"
                        onClick={() => onMarkCategoryRead(category.name)}
                        title={`将「${category.name}」分类下所有文章标记为已读`}
                        aria-label={`标记「${category.name}」已读`}
                      >
                        <svg viewBox="0 0 16 16" width="11" height="11">
                          <path
                            d="M2.5 8.5l3.5 3.5 7.5-7.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                  </div>

                  {/* 等宽未读计数胶囊 */}
                  <span
                    className={`feed-category-pill ${catUnread > 0 ? 'has-unread' : 'is-zero'}`}
                    title={`${catUnread} 篇未读`}
                  >
                    {catUnread}
                  </span>
                </div>

                {/* 子订阅源列表（带树状导引线） */}
                {!isCollapsed && channels.length > 0 && (
                  <div
                    id={channelsPanelId}
                    className="feed-category-channels"
                    role="group"
                  >
                    <div className="feed-tree-guide" aria-hidden="true" />
                    <div className="feed-channel-list">
                      {channels.map((ch) => {
                        const isChActive = selectedChannelId === ch.id;
                        return (
                          <div
                            key={ch.id}
                            className={`feed-channel-row ${isChActive ? 'is-active' : ''}`}
                            onClick={() => onSelectChannel(ch.id)}
                            role="treeitem"
                            aria-selected={isChActive}
                            title={ch.url}
                          >
                            <svg
                              className="feed-channel-icon"
                              viewBox="0 0 16 16"
                              width="12"
                              height="12"
                              aria-hidden="true"
                            >
                              <circle
                                cx="3"
                                cy="13"
                                r="1.5"
                                fill="currentColor"
                              />
                              <path
                                d="M2 8a6 6 0 0 1 6 6M2 4a10 10 0 0 1 10 10"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                            </svg>
                            <span className="feed-channel-name">
                              {ch.title || '未命名订阅源'}
                            </span>

                            <div
                              className="feed-channel-actions"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                className="feed-channel-unsub-btn"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (
                                    window.confirm(`确认退订「${ch.title}」？`)
                                  ) {
                                    onDeleteChannel(ch.id);
                                  }
                                }}
                                title={`退订「${ch.title}」`}
                                aria-label={`退订「${ch.title}」`}
                              >
                                <svg viewBox="0 0 16 16" width="9" height="9">
                                  <path
                                    d="M3.5 3.5l9 9M12.5 3.5l-9 9"
                                    stroke="currentColor"
                                    strokeWidth="1.6"
                                    strokeLinecap="round"
                                  />
                                </svg>
                              </button>
                            </div>

                            {ch.unreadCount > 0 && (
                              <span className="feed-channel-pill has-unread">
                                {ch.unreadCount}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 底部 OPML 机构级工具栏 */}
        <div className="feed-sidebar-footer">
          <button
            type="button"
            className="feed-footer-btn"
            onClick={onOpenImportOpml}
            title="导入 OPML 订阅清单"
          >
            导入 OPML
          </button>
          <button
            type="button"
            className="feed-footer-btn"
            onClick={onOpenExportOpml}
            title="导出 OPML 订阅清单"
          >
            导出 OPML
          </button>
        </div>
      </div>
    </aside>
  );
};
