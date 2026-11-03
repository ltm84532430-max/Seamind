import { applyOverlay } from './queue';
import type { Overlay } from './queue';
import { FAVORITE_CATEGORY_COLORS } from './types';
import type {
  FavoriteCategory,
  FavoriteCategoryColor,
  FavoriteItemEntry,
} from './types';

export const ALL_FAVORITES_FILTER = '__all__';
export const UNCATEGORIZED_COLUMN_KEY = '__uncategorized__';

export type FavoritesLayoutMode = 'columns' | 'grid' | 'list';
export type FavoritesCardDensity = 'comfortable' | 'compact';
export type FavoritesWatchFilter = 'all' | 'unwatched' | 'watched';

export interface CategoryColorMeta {
  id: FavoriteCategoryColor;
  label: string;
  accent: string;
  softBg: string;
  border: string;
}

const SLATE_UNCATEGORIZED_META: CategoryColorMeta = {
  id: 'slate',
  label: '未分类',
  accent: '#64748b',
  softBg: 'rgba(100, 116, 139, 0.11)',
  border: 'rgba(100, 116, 139, 0.30)',
};

export function getCategoryColorMeta(
  color: string | null | undefined,
): CategoryColorMeta {
  if (!color) return SLATE_UNCATEGORIZED_META;
  const matched = FAVORITE_CATEGORY_COLORS.find((entry) => entry.id === color);
  return matched ?? FAVORITE_CATEGORY_COLORS[0];
}

export interface FavoriteBoardColumn {
  key: string;
  categoryId: string | null;
  name: string;
  isUncategorized: boolean;
  colorMeta: CategoryColorMeta;
  category: FavoriteCategory | null;
  items: FavoriteItemEntry[];
  totalCount: number;
  finishedCount: number;
}

/**
 * Applies the live player overlay (`favorite`, `watchLater`, `finished`, `progressSeconds`)
 * to a snapshot of favorite entries, dropping entries that were optimistically unfavorited.
 */
export function applyOverlayToFavoriteEntries(
  entries: FavoriteItemEntry[],
  overlay: Overlay,
): FavoriteItemEntry[] {
  const result: FavoriteItemEntry[] = [];
  for (const entry of entries) {
    const patchedVideo = applyOverlay(entry.video, overlay);
    if (!patchedVideo.favorite) continue;
    result.push(
      patchedVideo === entry.video ? entry : { ...entry, video: patchedVideo },
    );
  }
  return result;
}

export interface FavoriteFilterOptions {
  query?: string;
  watchFilter?: FavoritesWatchFilter;
  categoryFilter?: string;
  validCategoryIds?: ReadonlySet<string>;
}

export function resolveEffectiveCategoryId(
  categoryId: string | null | undefined,
  validCategoryIds?: ReadonlySet<string>,
): string | null {
  if (!categoryId) return null;
  if (validCategoryIds && !validCategoryIds.has(categoryId)) return null;
  return categoryId;
}

export function filterFavoriteEntries(
  entries: FavoriteItemEntry[],
  options: FavoriteFilterOptions = {},
): FavoriteItemEntry[] {
  const {
    query = '',
    watchFilter = 'all',
    categoryFilter = ALL_FAVORITES_FILTER,
    validCategoryIds,
  } = options;
  const normalizedQuery = query.trim().toLowerCase();

  return entries.filter((entry) => {
    const effectiveCategory = resolveEffectiveCategoryId(
      entry.categoryId,
      validCategoryIds,
    );
    if (categoryFilter === UNCATEGORIZED_COLUMN_KEY) {
      if (effectiveCategory !== null) return false;
    } else if (
      categoryFilter &&
      categoryFilter !== ALL_FAVORITES_FILTER &&
      effectiveCategory !== categoryFilter
    ) {
      return false;
    }

    if (watchFilter === 'unwatched' && entry.video.finished) return false;
    if (watchFilter === 'watched' && !entry.video.finished) return false;

    if (normalizedQuery) {
      const titleMatch = entry.video.title
        .toLowerCase()
        .includes(normalizedQuery);
      const channelMatch = (entry.video.channelName ?? '')
        .toLowerCase()
        .includes(normalizedQuery);
      const noteMatch = (entry.note ?? '')
        .toLowerCase()
        .includes(normalizedQuery);
      if (!titleMatch && !channelMatch && !noteMatch) return false;
    }

    return true;
  });
}

/**
 * Partitions favorite items into `[未分类, ...用户分类]` columns while strictly enforcing
 * the single-primary-category invariant (one video = one card across the entire board).
 */
export function buildFavoriteBoardColumns(
  categories: FavoriteCategory[],
  entries: FavoriteItemEntry[],
): FavoriteBoardColumn[] {
  const sortedCategories = [...categories].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.createdAt - b.createdAt ||
      a.name.localeCompare(b.name, 'zh-CN'),
  );
  const validIds = new Set(sortedCategories.map((c) => c.categoryId));
  const buckets = new Map<string, FavoriteItemEntry[]>();
  buckets.set(UNCATEGORIZED_COLUMN_KEY, []);
  for (const cat of sortedCategories) {
    buckets.set(cat.categoryId, []);
  }

  const seenVideoIds = new Set<string>();
  for (const entry of entries) {
    const videoId = entry.video.videoId;
    if (seenVideoIds.has(videoId)) continue;
    seenVideoIds.add(videoId);

    const effectiveCat = resolveEffectiveCategoryId(entry.categoryId, validIds);
    const bucketKey = effectiveCat ?? UNCATEGORIZED_COLUMN_KEY;
    buckets
      .get(bucketKey)!
      .push(
        effectiveCat === entry.categoryId
          ? entry
          : { ...entry, categoryId: null },
      );
  }

  const uncategorizedItems = buckets.get(UNCATEGORIZED_COLUMN_KEY) ?? [];
  const columns: FavoriteBoardColumn[] = [
    {
      key: UNCATEGORIZED_COLUMN_KEY,
      categoryId: null,
      name: '未分类',
      isUncategorized: true,
      colorMeta: SLATE_UNCATEGORIZED_META,
      category: null,
      items: uncategorizedItems,
      totalCount: uncategorizedItems.length,
      finishedCount: uncategorizedItems.filter((item) => item.video.finished)
        .length,
    },
  ];

  for (const cat of sortedCategories) {
    const colItems = buckets.get(cat.categoryId) ?? [];
    columns.push({
      key: cat.categoryId,
      categoryId: cat.categoryId,
      name: cat.name,
      isUncategorized: false,
      colorMeta: getCategoryColorMeta(cat.color),
      category: cat,
      items: colItems,
      totalCount: colItems.length,
      finishedCount: colItems.filter((item) => item.video.finished).length,
    });
  }

  return columns;
}

/**
 * Computes the insertion index inside `remaining` (the target column's videoIds after
 * removing `draggedVideoIds`) so both intra-column and cross-column drops land accurately.
 */
export function computeDropTargetIndex(
  columnVideoIds: readonly string[],
  draggedVideoIds: readonly string[],
  hoverVideoId: string | null,
  placeAfter: boolean,
): number {
  const draggedSet = new Set(draggedVideoIds);
  const remaining = columnVideoIds.filter((id) => !draggedSet.has(id));
  if (!hoverVideoId) {
    return remaining.length;
  }
  if (draggedSet.has(hoverVideoId)) {
    const originalIndex = columnVideoIds.indexOf(hoverVideoId);
    if (originalIndex < 0) return remaining.length;
    let countBefore = 0;
    for (let i = 0; i < originalIndex; i += 1) {
      if (!draggedSet.has(columnVideoIds[i])) countBefore += 1;
    }
    return countBefore;
  }
  const hoverIndexInRemaining = remaining.indexOf(hoverVideoId);
  if (hoverIndexInRemaining < 0) {
    return remaining.length;
  }
  return placeAfter ? hoverIndexInRemaining + 1 : hoverIndexInRemaining;
}

/**
 * Optimistically moves `videoIds` into `targetCategoryId` at `targetIndex` on a local
 * `FavoriteItemEntry[]` array so drag-and-drop updates immediately without flicker.
 */
export function applyOptimisticCategoryMove(
  entries: FavoriteItemEntry[],
  categories: FavoriteCategory[],
  videoIds: readonly string[],
  targetCategoryId: string | null,
  targetIndex?: number | null,
): FavoriteItemEntry[] {
  const validCatIds = new Set(categories.map((c) => c.categoryId));
  const normalizedTarget =
    targetCategoryId && validCatIds.has(targetCategoryId)
      ? targetCategoryId
      : null;

  const movedSet = new Set(videoIds);
  const byId = new Map(entries.map((entry) => [entry.video.videoId, entry]));
  const movedEntries: FavoriteItemEntry[] = [];
  for (const id of videoIds) {
    const found = byId.get(id);
    if (found) {
      movedEntries.push({ ...found, categoryId: normalizedTarget });
    }
  }
  if (movedEntries.length === 0) return entries;

  const targetRemaining = entries.filter((entry) => {
    if (movedSet.has(entry.video.videoId)) return false;
    return (
      resolveEffectiveCategoryId(entry.categoryId, validCatIds) ===
      normalizedTarget
    );
  });

  const insertAt =
    targetIndex === undefined || targetIndex === null
      ? 0
      : Math.max(0, Math.min(targetRemaining.length, targetIndex));

  const reorderedTarget = [...targetRemaining];
  reorderedTarget.splice(insertAt, 0, ...movedEntries);
  const updatedTargetWithPos = reorderedTarget.map((entry, idx) => ({
    ...entry,
    categoryId: normalizedTarget,
    columnPosition: idx,
  }));

  const otherEntries = entries.filter((entry) => {
    if (movedSet.has(entry.video.videoId)) return false;
    return (
      resolveEffectiveCategoryId(entry.categoryId, validCatIds) !==
      normalizedTarget
    );
  });

  return [...updatedTargetWithPos, ...otherEntries].sort(
    (a, b) => a.columnPosition - b.columnPosition || b.addedAt - a.addedAt,
  );
}

export function reorderCategoryIds(
  currentIds: readonly string[],
  draggedId: string,
  targetId: string,
  placeAfter: boolean,
): string[] {
  if (draggedId === targetId) return [...currentIds];
  if (!currentIds.includes(draggedId) || !currentIds.includes(targetId)) {
    return [...currentIds];
  }
  const remaining = currentIds.filter((id) => id !== draggedId);
  const targetIdx = remaining.indexOf(targetId);
  const insertAt = placeAfter ? targetIdx + 1 : targetIdx;
  const next = [...remaining];
  next.splice(insertAt, 0, draggedId);
  return next;
}

export function buildAgyFavoritesCategorizeCommand(
  categories: FavoriteCategory[],
  uncategorizedCount: number,
): string {
  const existingHint =
    categories.length > 0
      ? `我目前已有分类：${categories.map((c) => c.name).join('、')}。优先复用合适分类，确有必要时可提议新建精简分类。`
      : '我目前还没有创建分类，请根据收藏视频的主题类型提议几个清晰精简的分类。';
  const scopeHint =
    uncategorizedCount > 0
      ? `重点将当前 ${uncategorizedCount} 个未分类收藏视频按单主分类归入对应分类`
      : '检查当前收藏视频并按单主分类整理归类';
  const prompt = `请调用 seamind MCP 的 favorites_get_board 读取我的播放器收藏视频与分类，${existingHint}${scopeHint}，然后调用 favorites_propose_categorization 提交分类预览让我确认。`;
  const escaped = prompt.replace(/"/g, '\\"');
  return `agy -i "${escaped}"`;
}
