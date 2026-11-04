import React, { useCallback, useEffect, useRef, useState } from 'react';
import { feedApi } from './feed-api';
import { FeedAddDialog } from './FeedAddDialog';
import { FeedArticleList } from './FeedArticleList';
import { FeedAudioPlayerBar } from './FeedAudioPlayerBar';
import { FeedCategoryDialog } from './FeedCategoryDialog';
import { FeedGalaxyView } from './FeedGalaxyView';
import { FeedOpmlDialog } from './FeedOpmlDialog';
import { FeedReaderView } from './FeedReaderView';
import { FeedSidebar } from './FeedSidebar';
import { DEFAULT_STARTER_FEEDS } from './default-starter-feeds';
import type { FeedArticle, FeedOverview } from './types';
import './feed-workspace.css';

let defaultFeedSeedPromise: Promise<string[]> | null = null;
let defaultFeedRefreshPromise: Promise<void> | null = null;

async function seedDefaultSourcesOnce(force = false): Promise<{
  refreshPromise: Promise<void> | null;
}> {
  if (!defaultFeedSeedPromise || force) {
    defaultFeedSeedPromise = feedApi
      .seedDefaultSources(force)
      .catch((error) => {
        defaultFeedSeedPromise = null;
        throw error;
      });
  }

  const seededIds = await defaultFeedSeedPromise;
  if (seededIds.length > 0) {
    defaultFeedRefreshPromise = feedApi
      .refreshChannels(seededIds)
      .then(() => undefined)
      .catch((error) => {
        console.error('后台刷新预置订阅源失败：', error);
      });
  }
  // Return the refresh task as a value inside an object. Returning the promise
  // directly from an async function would make JavaScript await it before the
  // caller can render the freshly seeded categories and channels.
  return { refreshPromise: defaultFeedRefreshPromise };
}

export interface FeedWorkspaceProps {
  onOpenMindmap?: (markdown: string, title: string) => void;
  onSelectedArticleChange?: (articleId: string | null, title: string) => void;
  onAnalyzeArticle?: (articleId: string) => void;
  externalRevision?: number;
}

const FeedWorkspaceInner: React.FC<FeedWorkspaceProps> = ({
  onOpenMindmap,
  onSelectedArticleChange,
  onAnalyzeArticle,
  externalRevision,
}) => {
  const [overview, setOverview] = useState<FeedOverview | null>(null);
  const [articles, setArticles] = useState<FeedArticle[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<FeedArticle | null>(
    null,
  );
  const handledExternalRevision = useRef(externalRevision ?? 0);

  // 终端通过 MCP 读取当前文章时，始终使用阅读区实际选中的文章 ID。
  useEffect(() => {
    onSelectedArticleChange?.(
      selectedArticle?.id ?? null,
      selectedArticle?.title ?? '',
    );
  }, [onSelectedArticleChange, selectedArticle?.id, selectedArticle?.title]);

  // Filters
  const [filterMode, setFilterMode] = useState<
    'all' | 'unread' | 'starred' | 'audio'
  >('all');
  const [playingArticle, setPlayingArticle] = useState<FeedArticle | null>(
    null,
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
  const [isCreateCategoryOpen, setIsCreateCategoryOpen] = useState(false);
  const [isGalaxyOpen, setIsGalaxyOpen] = useState(false);
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
        hasAudio: filterMode === 'audio' ? true : undefined,
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
    if (
      !externalRevision ||
      externalRevision === handledExternalRevision.current
    )
      return;
    handledExternalRevision.current = externalRevision;
    void Promise.all([reloadOverview(), reloadArticles()]);
  }, [externalRevision, reloadOverview, reloadArticles]);

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      let refreshPromise: Promise<void> | null = null;
      try {
        const seedResult = await seedDefaultSourcesOnce();
        refreshPromise = seedResult.refreshPromise;
      } catch (err) {
        console.warn('初始化预置订阅源失败：', err);
      }

      if (!active) return;

      // 检查当前是否有订阅频道，如果为空则立即触发直通注入，绝不留白
      try {
        const initialOverview = await feedApi.getOverview();
        if (
          active &&
          (!initialOverview || initialOverview.channels.length === 0)
        ) {
          console.info('检测到订阅源为空，正在自动直通恢复推荐源与播客...');
          await feedApi.importOpml(DEFAULT_STARTER_FEEDS);
          void feedApi.refreshAllChannels().then(async () => {
            if (active) await Promise.all([reloadOverview(), reloadArticles()]);
          });
        }
      } catch (e) {
        console.warn('直通检测订阅源失败：', e);
      }

      if (!active) return;
      await Promise.all([reloadOverview(), reloadArticles()]);

      if (refreshPromise) {
        void refreshPromise.then(async () => {
          if (active) await Promise.all([reloadOverview(), reloadArticles()]);
        });
      }
    };

    void initialize();
    return () => {
      active = false;
    };
  }, [reloadOverview, reloadArticles]);

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

  const handleMarkCategoryRead = useCallback(
    async (category: string) => {
      try {
        await feedApi.markAllRead(undefined, category);
        await Promise.all([reloadOverview(), reloadArticles()]);
      } catch (e) {
        console.error('标记分类已读失败：', e);
      }
    },
    [reloadOverview, reloadArticles],
  );

  const handleGenerateMindmap = useCallback(
    async (articleId: string, title: string) => {
      try {
        const rawMd = await feedApi.articleToMindmap(articleId);
        const md = rawMd
          .replace(/&rsquo;|&lsquo;|&#8217;|&#8216;/g, "'")
          .replace(/&rdquo;|&ldquo;|&#8220;|&#8221;/g, '"')
          .replace(/&hellip;|&#8230;/g, '...')
          .replace(/&mdash;|&#8212;/g, '—')
          .replace(/&ndash;|&#8211;/g, '–')
          .replace(/&apos;|&#39;/g, "'")
          .replace(/&quot;|&#34;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ');
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

  const handleCreateCategory = useCallback(
    async (name: string) => {
      await feedApi.createCategory(name);
      await reloadOverview();
    },
    [reloadOverview],
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

  const handleRestoreDefaultFeeds = useCallback(async () => {
    setLoadingArticles(true);
    try {
      // 步骤 1：尝试种子接口
      try {
        await seedDefaultSourcesOnce(true);
      } catch (err) {
        console.warn('种子接口未响应，执行直通注入：', err);
      }

      // 步骤 2：直通注入全量金融、军事与公共机构订阅源及播客
      const current = await feedApi.getOverview().catch(() => null);
      if (!current || (current.channels?.length ?? 0) === 0) {
        await feedApi.importOpml(DEFAULT_STARTER_FEEDS);
      }

      // 步骤 3：立即更新界面
      await Promise.all([reloadOverview(), reloadArticles()]);

      // 步骤 4：后台触发内容同步
      void feedApi.refreshAllChannels().then(async () => {
        await Promise.all([reloadOverview(), reloadArticles()]);
      });
    } catch (err) {
      console.error('恢复推荐订阅源失败：', err);
    } finally {
      setLoadingArticles(false);
    }
  }, [reloadOverview, reloadArticles]);

  const handleRefreshAll = useCallback(async () => {
    try {
      if ((overview?.channels?.length ?? 0) === 0) {
        await handleRestoreDefaultFeeds();
        return;
      }
      await feedApi.refreshAllChannels();
      await Promise.all([reloadOverview(), reloadArticles()]);
    } catch (e) {
      console.error('刷新订阅源失败：', e);
    }
  }, [
    overview?.channels?.length,
    handleRestoreDefaultFeeds,
    reloadOverview,
    reloadArticles,
  ]);

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
        onSelectAudio={() => {
          setSelectedChannelId(null);
          setSelectedCategory(null);
          setFilterMode('audio');
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
        onOpenCreateCategory={() => setIsCreateCategoryOpen(true)}
        onOpenImportOpml={() => {
          setOpmlMode('import');
          setIsOpmlOpen(true);
        }}
        onOpenExportOpml={handleOpenExportOpml}
        onRefreshAll={handleRefreshAll}
        onDeleteChannel={handleDeleteChannel}
        onMarkCategoryRead={handleMarkCategoryRead}
        onRestoreDefaultFeeds={handleRestoreDefaultFeeds}
        isRestoring={loadingArticles}
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
        onOpenGalaxy={() => setIsGalaxyOpen(true)}
        onPlayAudio={(art) => setPlayingArticle(art)}
      />

      <FeedReaderView
        article={selectedArticle}
        hasChannels={(overview?.channels?.length ?? 0) > 0}
        onToggleRead={handleToggleRead}
        onToggleStar={handleToggleStar}
        onGenerateMindmap={handleGenerateMindmap}
        onAddPreset={handleAddChannel}
        onAnalyzeArticle={onAnalyzeArticle}
        onPlayAudio={(art) => setPlayingArticle(art)}
        onRestoreDefaultFeeds={handleRestoreDefaultFeeds}
        isRestoring={loadingArticles}
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
        existingUrls={
          overview?.channels && Array.isArray(overview.channels)
            ? overview.channels
                .map((c) => (c && typeof c.url === 'string' ? c.url : ''))
                .filter(Boolean)
            : []
        }
        onClose={() => setIsOpmlOpen(false)}
        onFeedAdded={async () => {
          await Promise.all([reloadOverview(), reloadArticles()]);
        }}
      />

      <FeedCategoryDialog
        isOpen={isCreateCategoryOpen}
        onClose={() => setIsCreateCategoryOpen(false)}
        onCreate={handleCreateCategory}
      />

      {isGalaxyOpen && (
        <FeedGalaxyView
          categories={overview?.categories ?? []}
          channels={overview?.channels ?? []}
          onClose={() => setIsGalaxyOpen(false)}
          onSelectCategory={(category) => {
            setSelectedChannelId(null);
            setSelectedCategory(category);
            setFilterMode('all');
            setIsGalaxyOpen(false);
          }}
          onSelectChannel={(channelId) => {
            setSelectedCategory(null);
            setSelectedChannelId(channelId);
            setFilterMode('all');
            setIsGalaxyOpen(false);
          }}
        />
      )}

      {playingArticle && (
        <FeedAudioPlayerBar
          article={playingArticle}
          onClose={() => setPlayingArticle(null)}
          onGenerateMindmap={handleGenerateMindmap}
        />
      )}
    </div>
  );
};

interface FeedErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class FeedErrorBoundary extends React.Component<
  { children: React.ReactNode },
  FeedErrorBoundaryState
> {
  override state: FeedErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): FeedErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(
      '[FeedErrorBoundary] Uncaught render error in feed workspace:',
      error,
      errorInfo,
    );
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: '36px',
            textAlign: 'center',
            color: 'var(--ink)',
          }}
        >
          <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>
            订阅工作区加载异常
          </h3>
          <p
            style={{
              color: 'var(--muted)',
              fontSize: '13px',
              maxWidth: '460px',
              margin: '0 0 16px 0',
            }}
          >
            {this.state.error?.message || '未知错误'}
          </p>
          <button
            type="button"
            className="feed-text-btn is-primary"
            onClick={this.handleReset}
          >
            重新载入
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export const FeedWorkspaceWithBoundary: React.FC<FeedWorkspaceProps> = (
  props,
) => {
  return (
    <FeedErrorBoundary>
      <FeedWorkspaceInner {...props} />
    </FeedErrorBoundary>
  );
};

export const FeedWorkspace = FeedWorkspaceWithBoundary;
export default FeedWorkspaceWithBoundary;
