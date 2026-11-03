import React, { useCallback, useEffect, useState } from 'react';
import { feedApi } from './feed-api';
import { FeedAddDialog } from './FeedAddDialog';
import { FeedArticleList } from './FeedArticleList';
import { FeedOpmlDialog } from './FeedOpmlDialog';
import { FeedReaderView } from './FeedReaderView';
import { FeedSidebar } from './FeedSidebar';
import type { FeedArticle, FeedOverview } from './types';
import './feed-workspace.css';

export interface FeedWorkspaceProps {
  onOpenMindmap?: (markdown: string, title: string) => void;
}

export const FeedWorkspace: React.FC<FeedWorkspaceProps> = ({
  onOpenMindmap,
}) => {
  const [overview, setOverview] = useState<FeedOverview | null>(null);
  const [articles, setArticles] = useState<FeedArticle[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<FeedArticle | null>(
    null,
  );

  // Filters
  const [filterMode, setFilterMode] = useState<'all' | 'unread' | 'starred'>(
    'all',
  );
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null,
  );
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingArticles, setLoadingArticles] = useState(false);

  // Dialogs
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isOpmlOpen, setIsOpmlOpen] = useState(false);
  const [opmlMode, setOpmlMode] = useState<'import' | 'export'>('import');
  const [exportData, setExportData] = useState('');

  // ---------------------------------------------------------------------------
  // Data Loaders
  // ---------------------------------------------------------------------------
  const reloadOverview = useCallback(async () => {
    try {
      const data = await feedApi.getOverview();
      setOverview(data);
    } catch (err) {
      console.error('加载订阅概览失败：', err);
    }
  }, []);

  const reloadArticles = useCallback(async () => {
    setLoadingArticles(true);
    try {
      const list = await feedApi.listArticles({
        channelId: selectedChannelId || undefined,
        category: selectedCategory || undefined,
        readStatus: filterMode === 'unread' ? 'unread' : undefined,
        starred: filterMode === 'starred' ? true : undefined,
        search: searchQuery.trim() || undefined,
        limit: 100,
      });
      setArticles(list);

      // Keep selection or pick first
      setSelectedArticle((curr) => {
        if (!curr) return list[0] || null;
        const found = list.find((a) => a.id === curr.id);
        return found || list[0] || null;
      });
    } catch (err) {
      console.error('加载文章列表失败：', err);
    } finally {
      setLoadingArticles(false);
    }
  }, [selectedChannelId, selectedCategory, filterMode, searchQuery]);

  useEffect(() => {
    reloadOverview();
  }, [reloadOverview]);

  useEffect(() => {
    reloadArticles();
  }, [reloadArticles]);

  // ---------------------------------------------------------------------------
  // Article Actions
  // ---------------------------------------------------------------------------
  const handleSelectArticle = useCallback(
    async (article: FeedArticle) => {
      setSelectedArticle(article);
      // Auto-mark as read if unread
      if (article.readStatus === 'unread') {
        try {
          await feedApi.setArticleRead(article.id, 'read');
          setArticles((prev) =>
            prev.map((a) =>
              a.id === article.id ? { ...a, readStatus: 'read' } : a,
            ),
          );
          setSelectedArticle((curr) =>
            curr?.id === article.id ? { ...curr, readStatus: 'read' } : curr,
          );
          reloadOverview();
        } catch (e) {
          console.error('标记文章已读失败：', e);
        }
      }
    },
    [reloadOverview],
  );

  const handleToggleRead = useCallback(
    async (articleId: string, currentStatus: 'read' | 'unread') => {
      const nextStatus = currentStatus === 'read' ? 'unread' : 'read';
      try {
        await feedApi.setArticleRead(articleId, nextStatus);
        setArticles((prev) =>
          prev.map((a) =>
            a.id === articleId ? { ...a, readStatus: nextStatus } : a,
          ),
        );
        setSelectedArticle((curr) =>
          curr?.id === articleId ? { ...curr, readStatus: nextStatus } : curr,
        );
        reloadOverview();
      } catch (e) {
        console.error('切换已读状态失败：', e);
      }
    },
    [reloadOverview],
  );

  const handleToggleStar = useCallback(
    async (articleId: string, currentStarred: boolean) => {
      const nextStarred = !currentStarred;
      try {
        await feedApi.setArticleStarred(articleId, nextStarred);
        setArticles((prev) =>
          prev.map((a) =>
            a.id === articleId ? { ...a, starred: nextStarred } : a,
          ),
        );
        setSelectedArticle((curr) =>
          curr?.id === articleId ? { ...curr, starred: nextStarred } : curr,
        );
        reloadOverview();
      } catch (e) {
        console.error('切换收藏状态失败：', e);
      }
    },
    [reloadOverview],
  );

  const handleMarkAllRead = useCallback(async () => {
    try {
      await feedApi.markAllRead(
        selectedChannelId || undefined,
        selectedCategory || undefined,
      );
      await Promise.all([reloadOverview(), reloadArticles()]);
    } catch (e) {
      console.error('全部标记已读失败：', e);
    }
  }, [selectedChannelId, selectedCategory, reloadOverview, reloadArticles]);

  const handleGenerateMindmap = useCallback(
    async (articleId: string, title: string) => {
      try {
        const md = await feedApi.articleToMindmap(articleId);
        if (onOpenMindmap) {
          onOpenMindmap(md, title);
        }
      } catch (e) {
        console.error('生成思维导图失败：', e);
        alert(
          `生成思维导图失败：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [onOpenMindmap],
  );

  // ---------------------------------------------------------------------------
  // Channel & OPML Handlers
  // ---------------------------------------------------------------------------
  const handleAddChannel = useCallback(
    async (url: string, category?: string, customTitle?: string) => {
      await feedApi.addChannel(url, category, customTitle);
      await Promise.all([reloadOverview(), reloadArticles()]);
    },
    [reloadOverview, reloadArticles],
  );

  const handleDeleteChannel = useCallback(
    async (channelId: string) => {
      try {
        await feedApi.deleteChannel(channelId);
        if (selectedChannelId === channelId) {
          setSelectedChannelId(null);
        }
        await Promise.all([reloadOverview(), reloadArticles()]);
      } catch (e) {
        console.error('退订失败：', e);
      }
    },
    [selectedChannelId, reloadOverview, reloadArticles],
  );

  const handleRefreshAll = useCallback(async () => {
    try {
      await feedApi.refreshAllChannels();
      await Promise.all([reloadOverview(), reloadArticles()]);
    } catch (e) {
      console.error('刷新订阅源失败：', e);
    }
  }, [reloadOverview, reloadArticles]);

  const handleOpenExportOpml = useCallback(async () => {
    try {
      const data = await feedApi.exportOpml();
      setExportData(data);
      setOpmlMode('export');
      setIsOpmlOpen(true);
    } catch (e) {
      console.error('导出 OPML 失败：', e);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Keyboard Shortcuts (J/K navigation, S star, M read)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          (activeEl as HTMLElement).isContentEditable)
      ) {
        return;
      }

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (articles.length === 0) return;
        const idx = selectedArticle
          ? articles.findIndex((a) => a.id === selectedArticle.id)
          : -1;
        const nextIdx = Math.min(articles.length - 1, idx + 1);
        handleSelectArticle(articles[nextIdx]);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (articles.length === 0) return;
        const idx = selectedArticle
          ? articles.findIndex((a) => a.id === selectedArticle.id)
          : 0;
        const prevIdx = Math.max(0, idx - 1);
        handleSelectArticle(articles[prevIdx]);
      } else if (e.key === 's') {
        if (selectedArticle) {
          e.preventDefault();
          handleToggleStar(selectedArticle.id, selectedArticle.starred);
        }
      } else if (e.key === 'm') {
        if (selectedArticle) {
          e.preventDefault();
          handleToggleRead(selectedArticle.id, selectedArticle.readStatus);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    articles,
    selectedArticle,
    handleSelectArticle,
    handleToggleStar,
    handleToggleRead,
  ]);

  return (
    <div className="feed-workspace">
      <FeedSidebar
        overview={overview}
        selectedChannelId={selectedChannelId}
        selectedCategory={selectedCategory}
        currentFilterMode={filterMode}
        onSelectAll={() => {
          setSelectedChannelId(null);
          setSelectedCategory(null);
          setFilterMode('all');
        }}
        onSelectUnread={() => {
          setSelectedChannelId(null);
          setSelectedCategory(null);
          setFilterMode('unread');
        }}
        onSelectStarred={() => {
          setSelectedChannelId(null);
          setSelectedCategory(null);
          setFilterMode('starred');
        }}
        onSelectCategory={(cat) => {
          setSelectedChannelId(null);
          setSelectedCategory(cat);
        }}
        onSelectChannel={(chId) => {
          setSelectedChannelId(chId);
          setSelectedCategory(null);
        }}
        onOpenAddDialog={() => setIsAddOpen(true)}
        onOpenImportOpml={() => {
          setOpmlMode('import');
          setIsOpmlOpen(true);
        }}
        onOpenExportOpml={handleOpenExportOpml}
        onRefreshAll={handleRefreshAll}
        onDeleteChannel={handleDeleteChannel}
      />

      <FeedArticleList
        articles={articles}
        selectedArticleId={selectedArticle?.id ?? null}
        filterMode={filterMode}
        searchQuery={searchQuery}
        loading={loadingArticles}
        onSelectArticle={handleSelectArticle}
        onChangeFilterMode={(m) => setFilterMode(m)}
        onChangeSearchQuery={(q) => setSearchQuery(q)}
        onMarkAllRead={handleMarkAllRead}
      />

      <FeedReaderView
        article={selectedArticle}
        hasChannels={(overview?.channels?.length ?? 0) > 0}
        onToggleRead={handleToggleRead}
        onToggleStar={handleToggleStar}
        onGenerateMindmap={handleGenerateMindmap}
        onAddPreset={handleAddChannel}
      />

      <FeedAddDialog
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onAdd={handleAddChannel}
      />

      <FeedOpmlDialog
        isOpen={isOpmlOpen}
        mode={opmlMode}
        exportData={exportData}
        existingUrls={(overview?.channels || []).map((c) => c.url)}
        onClose={() => setIsOpmlOpen(false)}
        onFeedAdded={async () => {
          await Promise.all([reloadOverview(), reloadArticles()]);
        }}
      />
    </div>
  );
};

export default FeedWorkspace;
