import { describe, expect, it } from 'vitest';
import {
  ALL_FAVORITES_FILTER,
  UNCATEGORIZED_COLUMN_KEY,
  applyOptimisticCategoryMove,
  buildFavoriteBoardColumns,
  computeDropTargetIndex,
  filterFavoriteEntries,
  getCategoryColorMeta,
  reorderCategoryIds,
  resolveEffectiveCategoryId,
} from '../src/player/favorites-board';
import { buildFavoritesCategorizationProposal } from '../src/player/FavoritesProposalDialog';
import type {
  FavoriteCategory,
  FavoriteItemEntry,
  FavoritesSnapshot,
  VideoItem,
} from '../src/player/types';

function createVideo(
  id: string,
  overrides: Partial<VideoItem> = {},
): VideoItem {
  return {
    videoId: id,
    channelId: 'UC_test',
    channelName: 'Test Channel',
    title: `Video ${id}`,
    publishedAt: null,
    publishedApprox: false,
    durationSeconds: 120,
    viewCount: 1000,
    viewText: '1K',
    thumbnailUrl: null,
    progressSeconds: 0,
    finished: false,
    lastPlayedAt: null,
    favorite: true,
    watchLater: false,
    ...overrides,
  };
}

function createEntry(
  id: string,
  categoryId: string | null = null,
  overrides: { note?: string | null; video?: Partial<VideoItem> } = {},
): FavoriteItemEntry {
  return {
    video: createVideo(id, overrides.video),
    categoryId,
    columnPosition: 0,
    note: overrides.note ?? null,
    addedAt: 1000,
  };
}

function createCategory(
  id: string,
  name: string,
  color: FavoriteCategory['color'] = 'terracotta',
): FavoriteCategory {
  return {
    categoryId: id,
    name,
    color,
    position: 0,
    channelIds: [],
    itemCount: 0,
    createdAt: 1000,
  };
}

describe('favorites-board single primary category invariant', () => {
  it('partitions items so every video belongs to exactly one column with zero duplicate cards', () => {
    const categories: FavoriteCategory[] = [
      createCategory('cat-ai', 'AI & ML', 'teal'),
      createCategory('cat-music', 'Music', 'rose'),
    ];
    const items: FavoriteItemEntry[] = [
      createEntry('v1', 'cat-ai'),
      createEntry('v2', 'cat-music'),
      createEntry('v3', null), // Uncategorized
      createEntry('v4', 'deleted-cat-id'), // Category no longer exists -> falls back to uncategorized
    ];

    const columns = buildFavoriteBoardColumns(categories, items);

    // Should have 1 uncategorized column (triage inbox) + 2 category columns
    expect(columns.length).toBe(3);
    expect(columns[0].key).toBe(UNCATEGORIZED_COLUMN_KEY);
    expect(columns[0].isUncategorized).toBe(true);
    expect(columns[0].items.map((i) => i.video.videoId)).toEqual(['v3', 'v4']);

    expect(columns[1].key).toBe('cat-ai');
    expect(columns[1].isUncategorized).toBe(false);
    expect(columns[1].items.map((i) => i.video.videoId)).toEqual(['v1']);

    expect(columns[2].key).toBe('cat-music');
    expect(columns[2].isUncategorized).toBe(false);
    expect(columns[2].items.map((i) => i.video.videoId)).toEqual(['v2']);

    // Invariant: sum of items across all columns equals total items, and every videoId appears once
    const allColumnVideoIds = columns.flatMap((c) =>
      c.items.map((i) => i.video.videoId),
    );
    expect(allColumnVideoIds).toEqual(['v3', 'v4', 'v1', 'v2']);
    expect(new Set(allColumnVideoIds).size).toBe(4);
  });

  it('renders a single uncategorized column when user has created 0 categories', () => {
    const categories: FavoriteCategory[] = [];
    const items: FavoriteItemEntry[] = [
      createEntry('v1', null),
      createEntry('v2', null),
    ];

    const columns = buildFavoriteBoardColumns(categories, items);

    expect(columns.length).toBe(1);
    expect(columns[0].key).toBe(UNCATEGORIZED_COLUMN_KEY);
    expect(columns[0].name).toBe('未分类');
    expect(columns[0].items.length).toBe(2);
  });

  it('resolves effective category id safely', () => {
    const valid = new Set(['cat-1', 'cat-2']);
    expect(resolveEffectiveCategoryId('cat-1', valid)).toBe('cat-1');
    expect(resolveEffectiveCategoryId('unknown', valid)).toBe(null);
    expect(resolveEffectiveCategoryId(null, valid)).toBe(null);
  });
});

describe('filterFavoriteEntries', () => {
  const entries: FavoriteItemEntry[] = [
    createEntry('v1', 'cat-1', {
      note: 'Deep learning transformer paper',
      video: { title: 'Attention Is All You Need', channelName: 'Yannic' },
    }),
    createEntry('v2', 'cat-1', {
      note: 'Music clip',
      video: {
        title: 'Lofi Chill Beats',
        channelName: 'ChilledCow',
        finished: true,
      },
    }),
    createEntry('v3', null, {
      video: {
        title: 'Rust Concurrency Tutorial',
        channelName: 'Jon Gjengset',
      },
    }),
  ];

  it('filters by keyword in title, channel, and note', () => {
    expect(
      filterFavoriteEntries(entries, { query: 'transformer' }).map(
        (e) => e.video.videoId,
      ),
    ).toEqual(['v1']);

    expect(
      filterFavoriteEntries(entries, { query: 'gjengset' }).map(
        (e) => e.video.videoId,
      ),
    ).toEqual(['v3']);

    expect(
      filterFavoriteEntries(entries, { query: 'lofi' }).map(
        (e) => e.video.videoId,
      ),
    ).toEqual(['v2']);
  });

  it('filters by watch state', () => {
    expect(
      filterFavoriteEntries(entries, { watchFilter: 'watched' }).map(
        (e) => e.video.videoId,
      ),
    ).toEqual(['v2']);

    expect(
      filterFavoriteEntries(entries, { watchFilter: 'unwatched' }).map(
        (e) => e.video.videoId,
      ),
    ).toEqual(['v1', 'v3']);
  });

  it('filters by category selection', () => {
    expect(
      filterFavoriteEntries(entries, { categoryFilter: 'cat-1' }).map(
        (e) => e.video.videoId,
      ),
    ).toEqual(['v1', 'v2']);

    expect(
      filterFavoriteEntries(entries, {
        categoryFilter: UNCATEGORIZED_COLUMN_KEY,
      }).map((e) => e.video.videoId),
    ).toEqual(['v3']);

    expect(
      filterFavoriteEntries(entries, {
        categoryFilter: ALL_FAVORITES_FILTER,
      }).map((e) => e.video.videoId),
    ).toEqual(['v1', 'v2', 'v3']);
  });
});

describe('computeDropTargetIndex for column and card drag-and-drop', () => {
  it('computes correct drop target index when moving within the same column', () => {
    const columnVideoIds = ['v1', 'v2', 'v3', 'v4'];

    // Dragging v1 (index 0) to drop before v3 (index 2)
    // After excluding v1, remaining is [v2, v3, v4]. Target v3 is at index 1.
    // dropPlaceAfter = false -> insert at index 1
    const idx1 = computeDropTargetIndex(columnVideoIds, ['v1'], 'v3', false);
    expect(idx1).toBe(1);

    // Dragging v1 to drop after v3 (index 2)
    // After excluding v1, v3 is at index 1. dropPlaceAfter = true -> insert at index 2
    const idx2 = computeDropTargetIndex(columnVideoIds, ['v1'], 'v3', true);
    expect(idx2).toBe(2);

    // Dragging v4 to drop before v2
    // After excluding v4, remaining is [v1, v2, v3]. Target v2 is at index 1.
    const idx3 = computeDropTargetIndex(columnVideoIds, ['v4'], 'v2', false);
    expect(idx3).toBe(1);
  });

  it('computes correct target index when moving to a different column', () => {
    const targetColumnVideoIds = ['a', 'b'];

    // Dropping before first item 'a'
    const idx1 = computeDropTargetIndex(
      targetColumnVideoIds,
      ['dragged1'],
      'a',
      false,
    );
    expect(idx1).toBe(0);

    // Dropping after last item 'b'
    const idx2 = computeDropTargetIndex(
      targetColumnVideoIds,
      ['dragged1'],
      'b',
      true,
    );
    expect(idx2).toBe(2);

    // Dropping into empty column (hoverVideoId = null)
    const idx3 = computeDropTargetIndex([], ['dragged1'], null, false);
    expect(idx3).toBe(0);
  });
});

describe('applyOptimisticCategoryMove', () => {
  it('moves entries to target category at specified index optimistically', () => {
    const categories: FavoriteCategory[] = [
      createCategory('cat-1', 'Category 1'),
      createCategory('cat-2', 'Category 2'),
    ];
    const initial: FavoriteItemEntry[] = [
      createEntry('v1', 'cat-1'),
      createEntry('v2', 'cat-1'),
      createEntry('v3', 'cat-2'),
    ];

    const updated = applyOptimisticCategoryMove(
      initial,
      categories,
      ['v1'],
      'cat-2',
      0, // Insert at top of cat-2
    );

    const v1 = updated.find((e) => e.video.videoId === 'v1');
    expect(v1?.categoryId).toBe('cat-2');

    const cat2Items = updated.filter((e) => e.categoryId === 'cat-2');
    expect(cat2Items.map((e) => e.video.videoId)).toEqual(['v1', 'v3']);
  });
});

describe('reorderCategoryIds', () => {
  it('moves category ID before or after another category', () => {
    const ids = ['c1', 'c2', 'c3', 'c4'];
    // Move c1 after c3
    const result1 = reorderCategoryIds(ids, 'c1', 'c3', true);
    expect(result1).toEqual(['c2', 'c3', 'c1', 'c4']);

    // Move c4 before c2
    const result2 = reorderCategoryIds(ids, 'c4', 'c2', false);
    expect(result2).toEqual(['c1', 'c4', 'c2', 'c3']);

    // Non-existent category returns original array
    expect(reorderCategoryIds(ids, 'unknown', 'c2', false)).toEqual(ids);
  });
});

describe('buildFavoritesCategorizationProposal', () => {
  const snapshot: FavoritesSnapshot = {
    categories: [createCategory('cat-dev', '编程开发', 'ocean')],
    items: [
      createEntry('vid-1', null, {
        video: { title: 'Rust Systems Programming' },
      }),
      createEntry('vid-2', null, { video: { title: 'Chopin Nocturne Op.9' } }),
    ],
  };

  it('builds proposal with valid category resolution and distinct color fallback', () => {
    const proposal = buildFavoritesCategorizationProposal(snapshot, {
      newCategories: [{ name: '古典音乐', color: 'rose' }],
      assignments: [
        {
          videoId: 'vid-1',
          categoryName: '编程开发', // existing category
          note: 'Rust reference',
        },
        {
          videoId: 'vid-2',
          categoryName: '古典音乐', // newly proposed category
          note: 'Piano masterpiece',
        },
      ],
      rationale: '按内容类型拆分为开发与古典音乐',
    });

    expect(proposal.newCategories.length).toBe(1);
    expect(proposal.newCategories[0].name).toBe('古典音乐');
    expect(proposal.newCategories[0].color).toBe('rose');

    expect(proposal.assignments.length).toBe(2);
    expect(proposal.assignments[0].videoId).toBe('vid-1');
    expect(proposal.assignments[0].targetCategoryName).toBe('编程开发');
    expect(proposal.assignments[0].isNewCategory).toBe(false);

    expect(proposal.assignments[1].videoId).toBe('vid-2');
    expect(proposal.assignments[1].targetCategoryName).toBe('古典音乐');
    expect(proposal.assignments[1].isNewCategory).toBe(true);

    expect(proposal.rationale).toBe('按内容类型拆分为开发与古典音乐');
  });

  it('throws an error if an unknown videoId is referenced in assignments', () => {
    expect(() =>
      buildFavoritesCategorizationProposal(snapshot, {
        newCategories: [],
        assignments: [
          {
            videoId: 'non-existent-video',
            categoryName: '编程开发',
          },
        ],
        rationale: 'Invalid assignment',
      }),
    ).toThrow('视频 non-existent-video 不在当前收藏列表中');
  });

  it('normalizes category color and metadata properly', () => {
    const terracottaMeta = getCategoryColorMeta('terracotta');
    expect(terracottaMeta.id).toBe('terracotta');
    expect(terracottaMeta.accent).toBe('#d9573b');

    const fallbackMeta = getCategoryColorMeta(undefined);
    expect(fallbackMeta.id).toBe('slate');
  });
});
