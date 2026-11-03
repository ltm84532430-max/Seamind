import type { ProposeFavoritesCategorizationInput } from '../agent/capabilities';
import type { FavoritesCategorizationProposal } from '../agent/types';
import { getCategoryColorMeta } from './favorites-board';
import { CloseIcon } from './icons';
import { playerApi } from './player-api';
import { FAVORITE_CATEGORY_COLORS } from './types';
import type { FavoriteCategoryColor, FavoritesSnapshot } from './types';
import { thumbnailUrl } from './video-links';

const COLOR_ROTATION: FavoriteCategoryColor[] = FAVORITE_CATEGORY_COLORS.map(
  (c) => c.id,
);

export function buildFavoritesCategorizationProposal(
  snapshot: FavoritesSnapshot,
  input: ProposeFavoritesCategorizationInput,
): FavoritesCategorizationProposal {
  const existingCategoryByLower = new Map(
    snapshot.categories.map((cat) => [cat.name.trim().toLowerCase(), cat]),
  );
  const categoryNameById = new Map(
    snapshot.categories.map((cat) => [cat.categoryId, cat.name]),
  );
  const itemByVideoId = new Map(
    snapshot.items.map((entry) => [entry.video.videoId, entry]),
  );

  const plannedNewByLower = new Map<
    string,
    { name: string; color: FavoriteCategoryColor }
  >();
  let colorCursor = snapshot.categories.length;

  for (const rawNew of input.newCategories ?? []) {
    const cleanName = rawNew.name.trim();
    if (
      !cleanName ||
      cleanName === '未分类' ||
      cleanName.toLowerCase() === 'uncategorized'
    ) {
      continue;
    }
    const lower = cleanName.toLowerCase();
    if (existingCategoryByLower.has(lower) || plannedNewByLower.has(lower)) {
      continue;
    }
    const color =
      rawNew.color ?? COLOR_ROTATION[colorCursor % COLOR_ROTATION.length];
    colorCursor += 1;
    plannedNewByLower.set(lower, { name: cleanName, color });
  }

  const seenVideos = new Set<string>();
  const assignments: FavoritesCategorizationProposal['assignments'] = [];

  for (const rawAssign of input.assignments) {
    const videoId = rawAssign.videoId.trim();
    if (!videoId || seenVideos.has(videoId)) continue;
    const entry = itemByVideoId.get(videoId);
    if (!entry) {
      throw new Error(`视频 ${videoId} 不在当前收藏列表中，无法归类。`);
    }
    const rawTarget = rawAssign.categoryName.trim();
    if (!rawTarget) continue;

    seenVideos.add(videoId);
    const isUncatTarget =
      rawTarget === '未分类' || rawTarget.toLowerCase() === 'uncategorized';
    let targetCategoryName = '未分类';
    let isNewCategory = false;

    if (!isUncatTarget) {
      const lower = rawTarget.toLowerCase();
      const existing = existingCategoryByLower.get(lower);
      if (existing) {
        targetCategoryName = existing.name;
      } else {
        let planned = plannedNewByLower.get(lower);
        if (!planned) {
          const color = COLOR_ROTATION[colorCursor % COLOR_ROTATION.length];
          colorCursor += 1;
          planned = { name: rawTarget, color };
          plannedNewByLower.set(lower, planned);
        }
        targetCategoryName = planned.name;
        isNewCategory = true;
      }
    }

    const currentCategoryName = entry.categoryId
      ? (categoryNameById.get(entry.categoryId) ?? null)
      : null;

    assignments.push({
      videoId,
      videoTitle: entry.video.title,
      channelName: entry.video.channelName,
      currentCategoryName,
      targetCategoryName,
      isNewCategory,
      note: rawAssign.note?.trim() || null,
    });
  }

  if (assignments.length === 0) {
    throw new Error('没有可应用的收藏视频归类项。');
  }

  const usedNewLowers = new Set(
    assignments
      .filter((a) => a.isNewCategory)
      .map((a) => a.targetCategoryName.toLowerCase()),
  );
  const newCategories = Array.from(plannedNewByLower.entries())
    .filter(([lower]) => usedNewLowers.has(lower))
    .map(([, value]) => value);

  return {
    newCategories,
    assignments,
    rationale: input.rationale.trim(),
  };
}

export async function applyFavoritesCategorizationProposal(
  proposal: FavoritesCategorizationProposal,
): Promise<{ createdCategories: number; assignedVideos: number }> {
  const snapshot = await playerApi.favoritesSnapshot();
  const categoryIdByLower = new Map(
    snapshot.categories.map((cat) => [
      cat.name.trim().toLowerCase(),
      cat.categoryId,
    ]),
  );

  let createdCategories = 0;
  for (const newCat of proposal.newCategories) {
    const lower = newCat.name.trim().toLowerCase();
    if (categoryIdByLower.has(lower)) continue;
    const saved = await playerApi.favoriteCategorySave({
      name: newCat.name,
      color: newCat.color,
    });
    categoryIdByLower.set(saved.name.trim().toLowerCase(), saved.categoryId);
    createdCategories += 1;
  }

  const groupedByCategory = new Map<string | null, string[]>();
  for (const item of proposal.assignments) {
    const isUncat =
      item.targetCategoryName === '未分类' ||
      item.targetCategoryName.toLowerCase() === 'uncategorized';
    const resolvedId = isUncat
      ? null
      : (categoryIdByLower.get(item.targetCategoryName.trim().toLowerCase()) ??
        null);
    if (!groupedByCategory.has(resolvedId)) {
      groupedByCategory.set(resolvedId, []);
    }
    groupedByCategory.get(resolvedId)!.push(item.videoId);
  }

  for (const [categoryId, videoIds] of groupedByCategory.entries()) {
    if (videoIds.length > 0) {
      await playerApi.favoriteAssign(videoIds, categoryId, null);
    }
  }

  for (const item of proposal.assignments) {
    if (item.note && item.note.trim()) {
      await playerApi.favoriteSetNote(item.videoId, item.note.trim());
    }
  }

  return {
    createdCategories,
    assignedVideos: proposal.assignments.length,
  };
}

export default function FavoritesProposalDialog({
  proposal,
  sourceLabel = 'ai',
  busy = false,
  error = '',
  onConfirm,
  onCancel,
}: {
  proposal: FavoritesCategorizationProposal;
  sourceLabel?: 'cli' | 'ai';
  busy?: boolean;
  error?: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <div
      className="lp-proposal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="收藏视频分类整理预览"
    >
      <div className="lp-proposal-modal">
        <header className="lp-proposal-head">
          <div>
            <span className="lp-proposal-badge">
              {sourceLabel === 'cli' ? 'AGY / CLI 终端提案' : 'AI 归类提案'} ·
              单主分类整理
            </span>
            <h3>
              归类 {proposal.assignments.length} 个收藏视频
              {proposal.newCategories.length > 0
                ? `（含新建 ${proposal.newCategories.length} 个分类）`
                : ''}
            </h3>
          </div>
          <button
            type="button"
            className="lp-icon-btn"
            aria-label="取消并关闭预览"
            disabled={busy}
            onClick={onCancel}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="lp-proposal-body">
          {error && (
            <div
              role="alert"
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: 'rgba(179, 54, 43, 0.12)',
                color: '#b3362b',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {proposal.rationale && (
            <div className="lp-proposal-rationale">
              <strong>归类说明：</strong>
              {proposal.rationale}
            </div>
          )}

          {proposal.newCategories.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <span style={{ fontSize: 12, opacity: 0.78, lineHeight: '24px' }}>
                将新建分类：
              </span>
              {proposal.newCategories.map((cat) => {
                const meta = getCategoryColorMeta(cat.color);
                return (
                  <span
                    key={cat.name}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '2px 10px',
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      background: meta.softBg,
                      border: `1px solid ${meta.border}`,
                      color: meta.accent,
                    }}
                  >
                    <i
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: meta.accent,
                      }}
                    />
                    {cat.name}
                  </span>
                );
              })}
            </div>
          )}

          <div className="lp-proposal-list">
            {proposal.assignments.map((item) => (
              <div key={item.videoId} className="lp-proposal-item">
                <img
                  src={thumbnailUrl(item.videoId, 'mq')}
                  alt=""
                  loading="lazy"
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={item.videoTitle}
                  >
                    {item.videoTitle}
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      opacity: 0.72,
                      marginTop: 2,
                    }}
                  >
                    {item.channelName || '未知频道'} ·{' '}
                    <span>{item.currentCategoryName ?? '未分类'}</span>
                    {' → '}
                    <strong
                      style={{
                        color: 'var(--player-accent, var(--accent, #df735b))',
                      }}
                    >
                      {item.targetCategoryName}
                      {item.isNewCategory ? '（新）' : ''}
                    </strong>
                  </div>
                  {item.note && (
                    <div
                      style={{
                        fontSize: 11.5,
                        opacity: 0.85,
                        marginTop: 3,
                      }}
                    >
                      备注：{item.note}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <footer className="lp-proposal-foot">
          <button
            type="button"
            className="player-button"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="player-button is-primary"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? '正在应用归类…' : '确认应用归类'}
          </button>
        </footer>
      </div>
    </div>
  );
}
