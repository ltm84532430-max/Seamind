import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import type { AgentCapabilities } from '../agent/capabilities';
import type { AgentProviderSettings } from '../agent/runtime';
import { runFavoritesCategorizeAgentTurn } from '../agent/runtime';
import type { FavoritesCategorizationProposal } from '../agent/types';
import { formatAgo, formatDuration, formatViews } from './format';
import {
  ALL_FAVORITES_FILTER,
  UNCATEGORIZED_COLUMN_KEY,
  applyOptimisticCategoryMove,
  applyOverlayToFavoriteEntries,
  buildAgyFavoritesCategorizeCommand,
  buildFavoriteBoardColumns,
  computeDropTargetIndex,
  filterFavoriteEntries,
  getCategoryColorMeta,
  reorderCategoryIds,
  resolveEffectiveCategoryId,
} from './favorites-board';
import type {
  FavoriteBoardColumn,
  FavoritesCardDensity,
  FavoritesLayoutMode,
  FavoritesWatchFilter,
} from './favorites-board';
import FavoritesProposalDialog, {
  applyFavoritesCategorizationProposal,
} from './FavoritesProposalDialog';
import { usePlayerHost } from './host';
import { CheckIcon, ClockIcon, CloseIcon, PlusIcon, StarIcon } from './icons';
import { errorText, playerApi } from './player-api';
import type { QueueSource } from './queue';
import { FAVORITE_CATEGORY_COLORS } from './types';
import type {
  FavoriteCategory,
  FavoriteCategoryColor,
  FavoriteCategoryInput,
  FavoriteItemEntry,
  FavoritesSnapshot,
} from './types';
import { thumbnailUrl } from './video-links';
import './favorites-view.css';

const STORAGE_LAYOUT_KEY = 'seamind_player_favorites_layout';
const STORAGE_DENSITY_KEY = 'seamind_player_favorites_density';
const STORAGE_COLLAPSED_KEY = 'seamind_player_favorites_collapsed_cols';

export default function FavoritesView({
  bridges,
}: {
  bridges?: {
    aiProvider?: AgentProviderSettings;
    agentCapabilities?: AgentCapabilities;
    onSendTerminalCommand?: (text: string, execute?: boolean) => void;
  };
}) {
  const host = usePlayerHost();
  const [snapshot, setSnapshot] = useState<FavoritesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [layoutMode, setLayoutMode] = useState<FavoritesLayoutMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_LAYOUT_KEY);
      if (saved === 'columns' || saved === 'grid' || saved === 'list') {
        return saved;
      }
    } catch {
      // Ignore
    }
    return 'columns';
  });

  const [cardDensity, setCardDensity] = useState<FavoritesCardDensity>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_DENSITY_KEY);
      if (saved === 'comfortable' || saved === 'compact') return saved;
    } catch {
      // Ignore
    }
    return 'comfortable';
  });

  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_COLLAPSED_KEY);
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch {
      // Ignore
    }
    return new Set<string>();
  });

  const [query, setQuery] = useState('');
  const [watchFilter, setWatchFilter] = useState<FavoritesWatchFilter>('all');
  const [categoryFilter, setCategoryFilter] =
    useState<string>(ALL_FAVORITES_FILTER);
  const [sectionedGrid, setSectionedGrid] = useState(false);

  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(
    new Set(),
  );

  // Category modal
  const [categoryModal, setCategoryModal] = useState<{
    open: boolean;
    editingCategory: FavoriteCategory | null;
  }>({ open: false, editingCategory: null });
  const [categoryNameDraft, setCategoryNameDraft] = useState('');
  const [categoryColorDraft, setCategoryColorDraft] =
    useState<FavoriteCategoryColor>('terracotta');
  const [categoryChannelsDraft, setCategoryChannelsDraft] = useState<
    Set<string>
  >(new Set());
  const [categoryModalBusy, setCategoryModalBusy] = useState(false);
  const [categoryModalError, setCategoryModalError] = useState('');

  // Note editor popover / inline
  const [editingNoteVideoId, setEditingNoteVideoId] = useState<string | null>(
    null,
  );
  const [noteDraft, setNoteDraft] = useState('');

  // AI proposal dialog
  const [aiProposal, setAiProposal] =
    useState<FavoritesCategorizationProposal | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');

  // Drag and drop states
  const [draggedVideoIds, setDraggedVideoIds] = useState<string[]>([]);
  const [dropTargetColKey, setDropTargetColKey] = useState<string | null>(null);
  const [dropHoverVideoId, setDropHoverVideoId] = useState<string | null>(null);
  const [dropPlaceAfter, setDropPlaceAfter] = useState<boolean>(false);
  const [draggedColId, setDraggedColId] = useState<string | null>(null);
  const [colDragOverId, setColDragOverId] = useState<string | null>(null);

  const loadSnapshot = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await playerApi.favoritesSnapshot();
      setSnapshot(data);
    } catch (caught) {
      setError(errorText(caught, '无法读取收藏数据'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  // Persist layout choices
  const changeLayoutMode = (mode: FavoritesLayoutMode) => {
    setLayoutMode(mode);
    try {
      localStorage.setItem(STORAGE_LAYOUT_KEY, mode);
    } catch {
      // Ignore
    }
  };

  const changeCardDensity = (density: FavoritesCardDensity) => {
    setCardDensity(density);
    try {
      localStorage.setItem(STORAGE_DENSITY_KEY, density);
    } catch {
      // Ignore
    }
  };

  const toggleColumnCollapse = (colKey: string) => {
    setCollapsedCols((current) => {
      const next = new Set(current);
      if (next.has(colKey)) next.delete(colKey);
      else next.add(colKey);
      try {
        localStorage.setItem(
          STORAGE_COLLAPSED_KEY,
          JSON.stringify(Array.from(next)),
        );
      } catch {
        // Ignore
      }
      return next;
    });
  };

  // Overlay patched items
  const activeEntries = useMemo<FavoriteItemEntry[]>(() => {
    if (!snapshot) return [];
    return applyOverlayToFavoriteEntries(snapshot.items, host.overlay);
  }, [snapshot, host.overlay]);

  const categories = useMemo(
    () => snapshot?.categories ?? [],
    [snapshot?.categories],
  );

  const validCategoryIds = useMemo(
    () => new Set(categories.map((c) => c.categoryId)),
    [categories],
  );

  // Filtered entries for Grid and List views
  const filteredEntries = useMemo(() => {
    return filterFavoriteEntries(activeEntries, {
      query,
      watchFilter,
      categoryFilter,
      validCategoryIds,
    });
  }, [activeEntries, query, watchFilter, categoryFilter, validCategoryIds]);

  // Board columns for Vertical Columns view
  const boardColumns = useMemo<FavoriteBoardColumn[]>(() => {
    const rawCols = buildFavoriteBoardColumns(categories, activeEntries);
    if (!query.trim() && watchFilter === 'all') return rawCols;

    return rawCols.map((col) => {
      const filteredItems = filterFavoriteEntries(col.items, {
        query,
        watchFilter,
        validCategoryIds,
      });
      return {
        ...col,
        items: filteredItems,
        totalCount: col.items.length,
        finishedCount: col.items.filter((item) => item.video.finished).length,
      };
    });
  }, [categories, activeEntries, query, watchFilter, validCategoryIds]);

  // Batch selection helpers
  const toggleSelectVideo = (videoId: string) => {
    setSelectedVideoIds((current) => {
      const next = new Set(current);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });
  };

  const clearSelection = () => setSelectedVideoIds(new Set());

  // Category Modal actions
  const openCreateCategory = () => {
    setCategoryModal({ open: true, editingCategory: null });
    setCategoryNameDraft('');
    const nextColor =
      FAVORITE_CATEGORY_COLORS[
        categories.length % FAVORITE_CATEGORY_COLORS.length
      ].id;
    setCategoryColorDraft(nextColor);
    setCategoryChannelsDraft(new Set());
    setCategoryModalError('');
  };

  const openEditCategory = (cat: FavoriteCategory) => {
    setCategoryModal({ open: true, editingCategory: cat });
    setCategoryNameDraft(cat.name);
    setCategoryColorDraft(cat.color);
    setCategoryChannelsDraft(new Set(cat.channelIds));
    setCategoryModalError('');
  };

  const saveCategoryModal = async () => {
    if (categoryModalBusy) return;
    const name = categoryNameDraft.trim();
    if (!name) {
      setCategoryModalError('请填写分类名称');
      return;
    }
    setCategoryModalBusy(true);
    setCategoryModalError('');
    try {
      const input: FavoriteCategoryInput = {
        categoryId: categoryModal.editingCategory?.categoryId ?? null,
        name,
        color: categoryColorDraft,
        channelIds: Array.from(categoryChannelsDraft),
      };
      await playerApi.favoriteCategorySave(input);
      setCategoryModal({ open: false, editingCategory: null });
      await loadSnapshot();
      void host.reloadOverview();
      host.notify(`已保存分类「${name}」`);
    } catch (caught) {
      setCategoryModalError(errorText(caught, '保存分类失败'));
    } finally {
      setCategoryModalBusy(false);
    }
  };

  const deleteCategory = async (categoryId: string, name: string) => {
    if (
      !window.confirm(
        `确定删除分类「${name}」吗？\n该分类下的视频不会被取消收藏，会自动移回「未分类」。`,
      )
    ) {
      return;
    }
    try {
      await playerApi.favoriteCategoryDelete(categoryId);
      setCategoryModal({ open: false, editingCategory: null });
      await loadSnapshot();
      void host.reloadOverview();
      host.notify(`已删除分类「${name}」，视频已归入「未分类」`);
    } catch (caught) {
      host.notify(errorText(caught, '删除分类失败'), 'error');
    }
  };

  // Drag and drop card moves
  const executeCardMove = async (
    videoIds: string[],
    targetCategoryId: string | null,
    targetIndex?: number | null,
  ) => {
    if (videoIds.length === 0) return;
    // Optimistic update
    setSnapshot((current) => {
      if (!current) return current;
      return {
        ...current,
        items: applyOptimisticCategoryMove(
          current.items,
          current.categories,
          videoIds,
          targetCategoryId,
          targetIndex,
        ),
      };
    });

    try {
      await playerApi.favoriteAssign(videoIds, targetCategoryId, targetIndex);
      await loadSnapshot();
      void host.reloadOverview();
    } catch (caught) {
      host.notify(errorText(caught, '移动失败'), 'error');
      await loadSnapshot();
    }
  };

  // Batch move
  const batchMove = async (targetCategoryId: string | null) => {
    const ids = Array.from(selectedVideoIds);
    if (ids.length === 0) return;
    clearSelection();
    await executeCardMove(ids, targetCategoryId, null);
    const targetName =
      targetCategoryId === null
        ? '未分类'
        : (categories.find((c) => c.categoryId === targetCategoryId)?.name ??
          '目标分类');
    host.notify(`已将 ${ids.length} 个视频移至「${targetName}」`);
  };

  // Card note save
  const saveNote = async (videoId: string, noteText: string) => {
    try {
      const clean = noteText.trim();
      await playerApi.favoriteSetNote(videoId, clean || null);
      setEditingNoteVideoId(null);
      setSnapshot((current) => {
        if (!current) return current;
        return {
          ...current,
          items: current.items.map((entry) =>
            entry.video.videoId === videoId
              ? { ...entry, note: clean || null }
              : entry,
          ),
        };
      });
      host.notify(clean ? '已更新收藏备注' : '已清除备注');
    } catch (caught) {
      host.notify(errorText(caught, '更新备注失败'), 'error');
    }
  };

  // Play whole column or filtered list
  const playQueue = (title: string, items: FavoriteItemEntry[]) => {
    if (items.length === 0) return;
    const queue: QueueSource = {
      title,
      items: items.map((e) => e.video),
    };
    host.openVideo(items[0].video, queue);
  };

  // Column reordering
  const onColumnDragStart = (e: DragEvent, categoryId: string) => {
    e.stopPropagation();
    e.dataTransfer.setData('application/seamind-col-id', categoryId);
    e.dataTransfer.effectAllowed = 'move';
    setDraggedColId(categoryId);
  };

  const onColumnDragOver = (e: DragEvent, targetCatId: string) => {
    if (!draggedColId || draggedColId === targetCatId) return;
    e.preventDefault();
    e.stopPropagation();
    setColDragOverId(targetCatId);
  };

  const onColumnDrop = async (e: DragEvent, targetCatId: string) => {
    if (!draggedColId || draggedColId === targetCatId) return;
    e.preventDefault();
    e.stopPropagation();
    const currentIds = categories.map((c) => c.categoryId);
    const reordered = reorderCategoryIds(
      currentIds,
      draggedColId,
      targetCatId,
      false,
    );
    setDraggedColId(null);
    setColDragOverId(null);
    try {
      const saved = await playerApi.favoriteCategoriesReorder(reordered);
      setSnapshot((current) =>
        current ? { ...current, categories: saved } : current,
      );
      void host.reloadOverview();
    } catch (caught) {
      host.notify(errorText(caught, '排序列失败'), 'error');
    }
  };

  // Card drag and drop handlers
  const onCardDragStart = (e: DragEvent, videoId: string) => {
    const ids = selectedVideoIds.has(videoId)
      ? Array.from(selectedVideoIds)
      : [videoId];
    setDraggedVideoIds(ids);
    e.dataTransfer.setData(
      'application/seamind-favorite-ids',
      JSON.stringify(ids),
    );
    e.dataTransfer.effectAllowed = 'move';
  };

  const onCardDragEnd = () => {
    setDraggedVideoIds([]);
    setDropTargetColKey(null);
    setDropHoverVideoId(null);
    setColDragOverId(null);
  };

  const onCardDropOnCapsule = async (
    e: DragEvent,
    targetCategoryId: string | null,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData('application/seamind-favorite-ids');
    const ids: string[] = raw ? JSON.parse(raw) : draggedVideoIds;
    onCardDragEnd();
    if (ids.length > 0) {
      await executeCardMove(ids, targetCategoryId, null);
    }
  };

  const onCardDropInColumn = async (
    e: DragEvent,
    targetCol: FavoriteBoardColumn,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData('application/seamind-favorite-ids');
    const ids: string[] = raw ? JSON.parse(raw) : draggedVideoIds;
    const colVideoIds = targetCol.items.map((entry) => entry.video.videoId);
    const targetIdx = computeDropTargetIndex(
      colVideoIds,
      ids,
      dropHoverVideoId,
      dropPlaceAfter,
    );
    onCardDragEnd();
    if (ids.length > 0) {
      await executeCardMove(ids, targetCol.categoryId, targetIdx);
    }
  };

  // AI Categorization trigger
  const runAiCategorization = async () => {
    if (!bridges?.aiProvider?.model) {
      host.notify('请先在应用右上角设置中配置 AI 模型', 'error');
      return;
    }
    if (!bridges?.agentCapabilities) {
      host.notify('AI 能力尚未就绪', 'error');
      return;
    }
    setAiBusy(true);
    setAiError('');
    try {
      const result = await runFavoritesCategorizeAgentTurn({
        prompt:
          '请读取我当前所有的收藏视频与已有分类，将尚未分类的视频按单主分类划分整理并提议精简分类，提交归类提案。',
        provider: bridges.aiProvider,
        capabilities: bridges.agentCapabilities,
      });
      if (result.proposal) {
        setAiProposal(result.proposal);
      } else {
        host.notify(result.reply || 'AI 未提出新的归类建议');
      }
    } catch (caught) {
      setAiError(errorText(caught, 'AI 归类失败'));
    } finally {
      setAiBusy(false);
    }
  };

  const confirmAiProposal = async () => {
    if (!aiProposal) return;
    setAiBusy(true);
    setAiError('');
    try {
      const summary = await applyFavoritesCategorizationProposal(aiProposal);
      setAiProposal(null);
      await loadSnapshot();
      void host.reloadOverview();
      host.notify(
        `归类完成：已应用 ${summary.assignedVideos} 个视频${
          summary.createdCategories > 0
            ? `，新建 ${summary.createdCategories} 个分类`
            : ''
        }`,
      );
    } catch (caught) {
      setAiError(errorText(caught, '应用归类失败'));
    } finally {
      setAiBusy(false);
    }
  };

  const uncategorizedCount = useMemo(() => {
    return activeEntries.filter((e) => e.categoryId === null).length;
  }, [activeEntries]);

  const sendAgyCliCommand = () => {
    if (!bridges?.onSendTerminalCommand) {
      host.notify('全局终端尚未启用', 'error');
      return;
    }
    const cmd = buildAgyFavoritesCategorizeCommand(
      categories,
      uncategorizedCount,
    );
    bridges.onSendTerminalCommand(cmd, true);
  };

  // Card component renderer
  const renderCard = (entry: FavoriteItemEntry, density = cardDensity) => {
    const video = entry.video;
    const isSelected = selectedVideoIds.has(video.videoId);
    const isDropBefore = dropHoverVideoId === video.videoId && !dropPlaceAfter;
    const isDropAfter = dropHoverVideoId === video.videoId && dropPlaceAfter;
    const isEditingNote = editingNoteVideoId === video.videoId;
    const isCompact = density === 'compact';
    const effectiveCat = resolveEffectiveCategoryId(
      entry.categoryId,
      validCategoryIds,
    );
    const catMeta = getCategoryColorMeta(
      categories.find((c) => c.categoryId === effectiveCat)?.color,
    );

    return (
      <div
        key={video.videoId}
        className={`fav-card${isCompact ? ' is-compact' : ''}${
          isSelected ? ' is-selected' : ''
        }${isDropBefore ? ' is-drop-before' : ''}${
          isDropAfter ? ' is-drop-after' : ''
        }${draggedVideoIds.includes(video.videoId) ? ' is-dragging' : ''}`}
        draggable
        onDragStart={(e) => onCardDragStart(e, video.videoId)}
        onDragEnd={onCardDragEnd}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const relY = e.clientY - rect.top;
          const after = relY > rect.height / 2;
          setDropHoverVideoId(video.videoId);
          setDropPlaceAfter(after);
        }}
      >
        <button
          type="button"
          className="fav-card-thumb"
          aria-label={`播放「${video.title}」`}
          onClick={() =>
            host.openVideo(video, { title: '收藏', items: [video] })
          }
        >
          <img src={thumbnailUrl(video.videoId, 'mq')} alt="" loading="lazy" />
          {video.durationSeconds ? (
            <span className="fav-card-duration">
              {formatDuration(video.durationSeconds)}
            </span>
          ) : null}
          {video.finished ? (
            <span className="fav-card-watched-pill">已看完</span>
          ) : null}
          {video.progressSeconds && !video.finished && video.durationSeconds ? (
            <div className="fav-card-progress">
              <span
                style={{
                  width: `${Math.min(
                    100,
                    (video.progressSeconds / video.durationSeconds) * 100,
                  )}%`,
                }}
              />
            </div>
          ) : null}
          <div
            className="fav-card-select-box"
            onClick={(e) => {
              e.stopPropagation();
              toggleSelectVideo(video.videoId);
            }}
          >
            <input
              type="checkbox"
              checked={isSelected}
              readOnly
              aria-label="选择此视频"
            />
          </div>
        </button>

        <div className="fav-card-content">
          <button
            type="button"
            className="fav-card-title-btn"
            title={video.title}
            onClick={() =>
              host.openVideo(video, { title: '收藏', items: [video] })
            }
          >
            {video.title}
          </button>

          <div className="fav-card-meta">
            {video.channelName ? (
              <button
                type="button"
                className="fav-card-channel-btn"
                title={video.channelName}
                onClick={() =>
                  video.channelId && host.openChannel(video.channelId)
                }
              >
                {video.channelName}
              </button>
            ) : null}
            {video.viewCount ? (
              <span>· {formatViews(video.viewCount, null)}</span>
            ) : null}
            {video.publishedAt ? (
              <span>· {formatAgo(video.publishedAt, host.now)}</span>
            ) : null}
          </div>

          {/* Note section */}
          {isEditingNote ? (
            <div className="fav-card-note-editor">
              <input
                type="text"
                value={noteDraft}
                maxLength={500}
                placeholder="填写一句话收藏看点或笔记…"
                autoFocus
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter')
                    void saveNote(video.videoId, noteDraft);
                  if (e.key === 'Escape') setEditingNoteVideoId(null);
                }}
              />
              <div
                style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}
              >
                <button
                  type="button"
                  className="fav-btn is-subtle"
                  onClick={() => setEditingNoteVideoId(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="fav-btn is-subtle is-primary"
                  onClick={() => void saveNote(video.videoId, noteDraft)}
                >
                  保存
                </button>
              </div>
            </div>
          ) : entry.note ? (
            <div
              className="fav-card-note"
              title="点击编辑备注"
              onClick={() => {
                setEditingNoteVideoId(video.videoId);
                setNoteDraft(entry.note ?? '');
              }}
            >
              {entry.note}
            </div>
          ) : null}

          <div className="fav-card-footer">
            <select
              className="fav-cat-select"
              style={
                {
                  '--cat-accent': catMeta.accent,
                  '--cat-bg': catMeta.softBg,
                  '--cat-border': catMeta.border,
                } as Record<string, string>
              }
              value={effectiveCat ?? ''}
              onChange={(e) => {
                const targetCat = e.target.value || null;
                void executeCardMove([video.videoId], targetCat, null);
              }}
            >
              <option value="">未分类</option>
              {categories.map((c) => (
                <option key={c.categoryId} value={c.categoryId}>
                  {c.name}
                </option>
              ))}
            </select>

            <div className="fav-card-tools">
              {!entry.note && !isEditingNote && (
                <button
                  type="button"
                  className="fav-icon-btn"
                  title="添加备注"
                  aria-label="添加备注"
                  onClick={() => {
                    setEditingNoteVideoId(video.videoId);
                    setNoteDraft('');
                  }}
                >
                  ✎
                </button>
              )}
              <button
                type="button"
                className={`fav-icon-btn${video.watchLater ? ' is-on' : ''}`}
                title={video.watchLater ? '已在稍后看' : '加入稍后看'}
                aria-label={video.watchLater ? '移出稍后看' : '加入稍后看'}
                onClick={() => host.toggleWatchLater(video)}
              >
                <ClockIcon filled={video.watchLater} />
              </button>
              <button
                type="button"
                className={`fav-icon-btn${video.finished ? ' is-on' : ''}`}
                title={video.finished ? '已看' : '标记已看'}
                aria-label={video.finished ? '标记未看' : '标记已看'}
                onClick={() => void host.toggleWatched(video)}
              >
                <CheckIcon filled={video.finished} />
              </button>
              <button
                type="button"
                className="fav-icon-btn is-on"
                title="取消收藏"
                aria-label="取消收藏"
                onClick={() => host.toggleFavorite(video)}
              >
                <StarIcon filled />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="fav-workspace">
      {/* Header bar */}
      <header className="fav-header">
        <div className="fav-header-top">
          <div className="fav-title-group">
            <h2>收藏</h2>
            <span className="fav-stats">
              共 {activeEntries.length} 个视频 · 已分类{' '}
              {activeEntries.length - uncategorizedCount} 个 ·{' '}
              {categories.length} 个分类
            </span>
          </div>

          <div className="fav-toolbar-right">
            {/* View Switcher Segmented Control */}
            <div className="fav-segmented" role="tablist" aria-label="视图模式">
              <button
                type="button"
                className={layoutMode === 'columns' ? 'is-active' : ''}
                role="tab"
                aria-selected={layoutMode === 'columns'}
                onClick={() => changeLayoutMode('columns')}
              >
                竖栏
              </button>
              <button
                type="button"
                className={layoutMode === 'grid' ? 'is-active' : ''}
                role="tab"
                aria-selected={layoutMode === 'grid'}
                onClick={() => changeLayoutMode('grid')}
              >
                网格
              </button>
              <button
                type="button"
                className={layoutMode === 'list' ? 'is-active' : ''}
                role="tab"
                aria-selected={layoutMode === 'list'}
                onClick={() => changeLayoutMode('list')}
              >
                列表
              </button>
            </div>

            {/* Density toggle for columns view */}
            {layoutMode === 'columns' && (
              <div className="fav-segmented" aria-label="卡片密度">
                <button
                  type="button"
                  className={cardDensity === 'comfortable' ? 'is-active' : ''}
                  onClick={() => changeCardDensity('comfortable')}
                  title="标准封面大卡"
                >
                  标准
                </button>
                <button
                  type="button"
                  className={cardDensity === 'compact' ? 'is-active' : ''}
                  onClick={() => changeCardDensity('compact')}
                  title="紧凑小卡"
                >
                  紧凑
                </button>
              </div>
            )}

            {/* AI and AGY Buttons */}
            <button
              type="button"
              className="fav-btn"
              disabled={aiBusy}
              onClick={() => void runAiCategorization()}
              title="调用 AI 智能分析视频标题与频道，提出单主分类整理建议"
            >
              {aiBusy ? '正在分析…' : 'AI 智能归类'}
            </button>
            {bridges?.onSendTerminalCommand && (
              <button
                type="button"
                className="fav-btn"
                onClick={sendAgyCliCommand}
                title="在全局底部终端唤起 Google AGY CLI 运行归类"
              >
                AGY 终端
              </button>
            )}

            <button
              type="button"
              className="fav-btn is-primary"
              onClick={openCreateCategory}
            >
              <PlusIcon /> 新建分类
            </button>
          </div>
        </div>

        {/* Subbar: search and filters */}
        <div className="fav-subbar">
          <div className="fav-search-wrap">
            <input
              type="text"
              className="fav-search-input"
              value={query}
              placeholder="搜索标题、频道或收藏备注…"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="fav-search-clear"
                aria-label="清空搜索"
                onClick={() => setQuery('')}
              >
                <CloseIcon />
              </button>
            )}
          </div>

          <div className="fav-filter-controls">
            {/* Watch filter */}
            <div className="fav-segmented">
              <button
                type="button"
                className={watchFilter === 'all' ? 'is-active' : ''}
                onClick={() => setWatchFilter('all')}
              >
                全部
              </button>
              <button
                type="button"
                className={watchFilter === 'unwatched' ? 'is-active' : ''}
                onClick={() => setWatchFilter('unwatched')}
              >
                未看
              </button>
              <button
                type="button"
                className={watchFilter === 'watched' ? 'is-active' : ''}
                onClick={() => setWatchFilter('watched')}
              >
                已看
              </button>
            </div>

            {layoutMode === 'grid' &&
              categoryFilter === ALL_FAVORITES_FILTER && (
                <button
                  type="button"
                  className={`fav-btn is-subtle${sectionedGrid ? ' is-primary' : ''}`}
                  onClick={() => setSectionedGrid((v) => !v)}
                >
                  {sectionedGrid ? '按分类分节 ✓' : '按分类分节'}
                </button>
              )}
          </div>
        </div>

        {/* Category capsule strip (shown in Grid and List modes) */}
        {layoutMode !== 'columns' && (
          <div className="fav-capsule-bar" role="toolbar" aria-label="分类筛选">
            <button
              type="button"
              className={`fav-capsule${categoryFilter === ALL_FAVORITES_FILTER ? ' is-active' : ''}`}
              onClick={() => setCategoryFilter(ALL_FAVORITES_FILTER)}
            >
              全部 ({activeEntries.length})
            </button>
            <button
              type="button"
              className={`fav-capsule${categoryFilter === UNCATEGORIZED_COLUMN_KEY ? ' is-active' : ''}`}
              onClick={() => setCategoryFilter(UNCATEGORIZED_COLUMN_KEY)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => void onCardDropOnCapsule(e, null)}
              title="拖入卡片可归入未分类"
            >
              <span
                className="fav-capsule-dot"
                style={{ background: '#64748b' }}
              />
              未分类 ({uncategorizedCount})
            </button>

            {categories.map((cat) => {
              const meta = getCategoryColorMeta(cat.color);
              const isActive = categoryFilter === cat.categoryId;
              return (
                <div
                  key={cat.categoryId}
                  className={`fav-capsule${isActive ? ' is-active' : ''}`}
                  style={
                    {
                      '--capsule-accent': meta.accent,
                      '--capsule-bg': meta.softBg,
                    } as Record<string, string>
                  }
                  onClick={() => setCategoryFilter(cat.categoryId)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => void onCardDropOnCapsule(e, cat.categoryId)}
                  title="点击筛选；拖入卡片可移入此分类"
                >
                  <span
                    className="fav-capsule-dot"
                    style={{ background: meta.accent }}
                  />
                  <span>{cat.name}</span>
                  <span className="fav-capsule-count">({cat.itemCount})</span>
                  <button
                    type="button"
                    className="fav-capsule-edit"
                    title="编辑分类"
                    aria-label={`编辑分类「${cat.name}」`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditCategory(cat);
                    }}
                  >
                    ✎
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Multi-select Batch Action Bar */}
        {selectedVideoIds.size > 0 && (
          <div className="fav-batch-bar" role="region" aria-label="批量操作">
            <span>
              已选择 <strong>{selectedVideoIds.size}</strong> 个视频
            </span>
            <div className="fav-batch-actions">
              <select
                className="fav-cat-select"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value !== '') {
                    const target =
                      e.target.value === '__uncat' ? null : e.target.value;
                    void batchMove(target);
                  }
                }}
              >
                <option value="" disabled>
                  移至分类…
                </option>
                <option value="__uncat">移到未分类</option>
                {categories.map((c) => (
                  <option key={c.categoryId} value={c.categoryId}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="fav-btn is-subtle"
                onClick={clearSelection}
              >
                取消选择
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Main Board Area */}
      {loading && !snapshot ? (
        <div style={{ padding: 40, textAlign: 'center', opacity: 0.7 }}>
          正在载入收藏与分类…
        </div>
      ) : error ? (
        <div
          style={{
            padding: 40,
            textAlign: 'center',
            color: 'var(--fav-danger)',
          }}
        >
          {error}
        </div>
      ) : layoutMode === 'columns' ? (
        /* Vertical Columns (Multi-Column Board) */
        <div
          className="fav-columns-viewport"
          role="region"
          aria-label="竖栏看板"
        >
          {boardColumns.map((col) => {
            const isCollapsed = collapsedCols.has(col.key);
            const isDropActive = dropTargetColKey === col.key;
            const isColDragOver =
              Boolean(draggedColId) &&
              Boolean(colDragOverId) &&
              colDragOverId === col.categoryId;

            if (isCollapsed) {
              return (
                <div
                  key={col.key}
                  className="fav-column is-collapsed"
                  style={
                    {
                      '--col-accent': col.colorMeta.accent,
                    } as Record<string, string>
                  }
                  title={`点击展开「${col.name}」(${col.items.length})`}
                  onClick={() => toggleColumnCollapse(col.key)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropTargetColKey(col.key);
                  }}
                  onDrop={(e) => void onCardDropInColumn(e, col)}
                >
                  <span
                    className="fav-capsule-dot"
                    style={{ background: col.colorMeta.accent }}
                  />
                  <span className="fav-column-collapsed-label">{col.name}</span>
                  <span className="fav-column-badge">{col.items.length}</span>
                </div>
              );
            }

            return (
              <section
                key={col.key}
                className={`fav-column${cardDensity === 'compact' ? ' is-compact' : ''}${
                  isDropActive ? ' is-drop-active' : ''
                }${isColDragOver ? ' is-col-drag-over' : ''}`}
                style={
                  {
                    '--col-accent': col.colorMeta.accent,
                    '--col-soft': col.colorMeta.softBg,
                  } as Record<string, string>
                }
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTargetColKey(col.key);
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                  if (dropTargetColKey === col.key) setDropTargetColKey(null);
                }}
                onDrop={(e) => void onCardDropInColumn(e, col)}
              >
                <div
                  className="fav-column-accent-bar"
                  style={{ background: col.colorMeta.accent }}
                />
                <header
                  className="fav-column-head"
                  draggable={!col.isUncategorized}
                  onDragStart={(e) => {
                    if (col.categoryId) onColumnDragStart(e, col.categoryId);
                  }}
                  onDragOver={(e) => {
                    if (col.categoryId) onColumnDragOver(e, col.categoryId);
                  }}
                  onDrop={(e) => {
                    if (col.categoryId) void onColumnDrop(e, col.categoryId);
                  }}
                >
                  <div className="fav-column-title-row">
                    <span
                      className="fav-capsule-dot"
                      style={{ background: col.colorMeta.accent }}
                    />
                    <span className="fav-column-title" title={col.name}>
                      {col.name}
                    </span>
                    <span className="fav-column-badge">
                      {col.finishedCount > 0
                        ? `${col.finishedCount}/${col.items.length}`
                        : col.items.length}
                    </span>
                    {col.category?.channelIds &&
                    col.category.channelIds.length > 0 ? (
                      <span
                        className="fav-column-rule-tag"
                        title={`已绑定 ${col.category.channelIds.length} 个频道的自动归类`}
                      >
                        ⚡ 规则
                      </span>
                    ) : null}
                  </div>

                  <div className="fav-column-actions">
                    {col.items.length > 0 && (
                      <button
                        type="button"
                        className="fav-icon-btn"
                        title={`连续播放「${col.name}」本栏视频`}
                        aria-label={`连续播放「${col.name}」本栏视频`}
                        onClick={() =>
                          playQueue(`收藏 · ${col.name}`, col.items)
                        }
                      >
                        ▶
                      </button>
                    )}
                    {col.category && (
                      <button
                        type="button"
                        className="fav-icon-btn"
                        title="编辑分类"
                        aria-label={`编辑分类「${col.name}」`}
                        onClick={() => openEditCategory(col.category!)}
                      >
                        ✎
                      </button>
                    )}
                    <button
                      type="button"
                      className="fav-icon-btn"
                      title="折叠此竖栏"
                      aria-label={`折叠竖栏「${col.name}」`}
                      onClick={() => toggleColumnCollapse(col.key)}
                    >
                      ‹
                    </button>
                  </div>
                </header>

                <div className="fav-column-body">
                  {col.items.length === 0 ? (
                    <div className="fav-column-empty">
                      <span>本栏暂无视频</span>
                      <small style={{ marginTop: 4, opacity: 0.72 }}>
                        拖入视频卡片即可归入「{col.name}」
                      </small>
                    </div>
                  ) : (
                    col.items.map((entry) => renderCard(entry))
                  )}
                </div>
              </section>
            );
          })}

          {/* Add Category Card at the end of columns */}
          <button
            type="button"
            className="fav-add-column-card"
            onClick={openCreateCategory}
          >
            <span>+ 新建分类</span>
            <small>自定义分类名称、专属色标与频道自动归类</small>
          </button>
        </div>
      ) : layoutMode === 'grid' ? (
        /* Grid View */
        <div className="fav-scroll-stage">
          {sectionedGrid && categoryFilter === ALL_FAVORITES_FILTER ? (
            boardColumns.map((col) => {
              if (col.items.length === 0) return null;
              return (
                <section key={col.key} className="fav-grid-section">
                  <header className="fav-grid-section-head">
                    <div className="fav-grid-section-title">
                      <span
                        className="fav-capsule-dot"
                        style={{ background: col.colorMeta.accent }}
                      />
                      <span>{col.name}</span>
                      <span className="fav-column-badge">
                        {col.items.length}
                      </span>
                    </div>
                    {col.items.length > 0 && (
                      <button
                        type="button"
                        className="fav-btn is-subtle"
                        onClick={() =>
                          playQueue(`收藏 · ${col.name}`, col.items)
                        }
                      >
                        ▶ 播放本组
                      </button>
                    )}
                  </header>
                  <div className="fav-grid">
                    {col.items.map((entry) => renderCard(entry, 'comfortable'))}
                  </div>
                </section>
              );
            })
          ) : (
            <div className="fav-grid">
              {filteredEntries.map((entry) => renderCard(entry, 'comfortable'))}
            </div>
          )}
        </div>
      ) : (
        /* List View */
        <div className="fav-scroll-stage">
          <div className="fav-list">
            {filteredEntries.map((entry) => {
              const video = entry.video;
              const effectiveCat = resolveEffectiveCategoryId(
                entry.categoryId,
                validCategoryIds,
              );
              const catMeta = getCategoryColorMeta(
                categories.find((c) => c.categoryId === effectiveCat)?.color,
              );
              return (
                <div key={video.videoId} className="fav-list-row">
                  <input
                    type="checkbox"
                    checked={selectedVideoIds.has(video.videoId)}
                    onChange={() => toggleSelectVideo(video.videoId)}
                    aria-label="选择此视频"
                  />
                  <button
                    type="button"
                    className="fav-card-thumb"
                    aria-label={`播放「${video.title}」`}
                    onClick={() =>
                      host.openVideo(video, { title: '收藏', items: [video] })
                    }
                  >
                    <img
                      src={thumbnailUrl(video.videoId, 'mq')}
                      alt=""
                      loading="lazy"
                    />
                    {video.durationSeconds ? (
                      <span className="fav-card-duration">
                        {formatDuration(video.durationSeconds)}
                      </span>
                    ) : null}
                  </button>

                  <div className="fav-list-main">
                    <button
                      type="button"
                      className="fav-card-title-btn"
                      title={video.title}
                      onClick={() =>
                        host.openVideo(video, { title: '收藏', items: [video] })
                      }
                    >
                      {video.title}
                    </button>
                    <div className="fav-card-meta">
                      {video.channelName && <span>{video.channelName} · </span>}
                      {video.viewCount ? (
                        <span>{formatViews(video.viewCount, null)} · </span>
                      ) : null}
                      {video.publishedAt ? (
                        <span>{formatAgo(video.publishedAt, host.now)}</span>
                      ) : null}
                    </div>
                    {entry.note && (
                      <div className="fav-card-note">备注：{entry.note}</div>
                    )}
                  </div>

                  <select
                    className="fav-cat-select"
                    style={
                      {
                        '--cat-accent': catMeta.accent,
                        '--cat-bg': catMeta.softBg,
                        '--cat-border': catMeta.border,
                      } as Record<string, string>
                    }
                    value={effectiveCat ?? ''}
                    onChange={(e) => {
                      const target = e.target.value || null;
                      void executeCardMove([video.videoId], target, null);
                    }}
                  >
                    <option value="">未分类</option>
                    {categories.map((c) => (
                      <option key={c.categoryId} value={c.categoryId}>
                        {c.name}
                      </option>
                    ))}
                  </select>

                  <div className="fav-card-tools">
                    <button
                      type="button"
                      className={`fav-icon-btn${video.watchLater ? ' is-on' : ''}`}
                      title={video.watchLater ? '已在稍后看' : '稍后看'}
                      onClick={() => host.toggleWatchLater(video)}
                    >
                      <ClockIcon filled={video.watchLater} />
                    </button>
                    <button
                      type="button"
                      className={`fav-icon-btn${video.finished ? ' is-on' : ''}`}
                      title={video.finished ? '已看' : '标记已看'}
                      onClick={() => void host.toggleWatched(video)}
                    >
                      <CheckIcon filled={video.finished} />
                    </button>
                    <button
                      type="button"
                      className="fav-icon-btn is-on"
                      title="取消收藏"
                      onClick={() => host.toggleFavorite(video)}
                    >
                      <StarIcon filled />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Category Create / Edit Modal */}
      {categoryModal.open && (
        <div
          className="fav-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fav-modal-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !categoryModalBusy) {
              setCategoryModal({ open: false, editingCategory: null });
            }
          }}
        >
          <div className="fav-modal">
            <header className="fav-modal-head">
              <h3 id="fav-modal-title">
                {categoryModal.editingCategory ? '编辑分类' : '新建收藏分类'}
              </h3>
              <button
                type="button"
                className="fav-icon-btn"
                aria-label="关闭"
                disabled={categoryModalBusy}
                onClick={() =>
                  setCategoryModal({ open: false, editingCategory: null })
                }
              >
                <CloseIcon />
              </button>
            </header>

            <div className="fav-modal-body">
              {categoryModalError && (
                <div
                  role="alert"
                  style={{
                    padding: '8px 12px',
                    borderRadius: 4,
                    background: 'rgba(220, 60, 50, 0.12)',
                    color: 'var(--fav-danger)',
                    fontSize: 12,
                  }}
                >
                  {categoryModalError}
                </div>
              )}

              <label className="fav-field">
                <span>分类名称</span>
                <input
                  type="text"
                  value={categoryNameDraft}
                  maxLength={60}
                  placeholder="例如：系统编程、数学可视化、前端进阶"
                  autoFocus
                  onChange={(e) => setCategoryNameDraft(e.target.value)}
                />
              </label>

              <div className="fav-field">
                <span>色标主题</span>
                <div className="fav-color-grid">
                  {FAVORITE_CATEGORY_COLORS.map((swatch) => {
                    const isSelected = categoryColorDraft === swatch.id;
                    return (
                      <button
                        key={swatch.id}
                        type="button"
                        className={`fav-color-swatch${isSelected ? ' is-selected' : ''}`}
                        style={
                          {
                            '--swatch-color': swatch.accent,
                            '--swatch-bg': swatch.softBg,
                          } as Record<string, string>
                        }
                        onClick={() => setCategoryColorDraft(swatch.id)}
                      >
                        <span
                          className="fav-capsule-dot"
                          style={{ background: swatch.accent }}
                        />
                        <span>{swatch.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Channel Auto-Rule Binding */}
              <div className="fav-field">
                <span>自动归类规则（可选绑定已订阅频道）</span>
                <small
                  style={{
                    fontSize: 11.5,
                    fontWeight: 400,
                    opacity: 0.72,
                    marginBottom: 4,
                  }}
                >
                  勾选后，该频道新收藏及目前未分类的视频将自动进入此分类：
                </small>
                {host.channels.length === 0 ? (
                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.64,
                      padding: '8px 0',
                    }}
                  >
                    暂无已订阅频道
                  </div>
                ) : (
                  <div className="fav-channel-rule-list">
                    {host.channels.map((ch) => {
                      const checked = categoryChannelsDraft.has(ch.channelId);
                      return (
                        <label
                          key={ch.channelId}
                          className="fav-channel-rule-item"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setCategoryChannelsDraft((current) => {
                                const next = new Set(current);
                                if (next.has(ch.channelId)) {
                                  next.delete(ch.channelId);
                                } else {
                                  next.add(ch.channelId);
                                }
                                return next;
                              });
                            }}
                          />
                          <span>{ch.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <footer className="fav-modal-foot">
              {categoryModal.editingCategory ? (
                <button
                  type="button"
                  className="fav-danger-btn"
                  disabled={categoryModalBusy}
                  onClick={() =>
                    deleteCategory(
                      categoryModal.editingCategory!.categoryId,
                      categoryModal.editingCategory!.name,
                    )
                  }
                >
                  删除此分类
                </button>
              ) : (
                <div />
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="fav-btn"
                  disabled={categoryModalBusy}
                  onClick={() =>
                    setCategoryModal({ open: false, editingCategory: null })
                  }
                >
                  取消
                </button>
                <button
                  type="button"
                  className="fav-btn is-primary"
                  disabled={categoryModalBusy}
                  onClick={() => void saveCategoryModal()}
                >
                  {categoryModalBusy ? '正在保存…' : '保存分类'}
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {/* AI Proposal Dialog */}
      {aiProposal && (
        <FavoritesProposalDialog
          proposal={aiProposal}
          sourceLabel="ai"
          busy={aiBusy}
          error={aiError}
          onConfirm={() => void confirmAiProposal()}
          onCancel={() => setAiProposal(null)}
        />
      )}
    </div>
  );
}
