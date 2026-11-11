import type { FavoriteCategoryColor } from '../../player/types';
import type { AgentCapabilities, AgentToolResult } from '../tool-api';
import type { AgentToolDescriptor } from '../types';
import { assertOnlyKeys, requireString, schema } from './parse';

export const favoritesToolCatalog: AgentToolDescriptor[] = [
  {
    version: 1,
    name: 'favorites_get_board',
    description:
      '只读读取播放器「收藏」看板中的已有分类与全部收藏视频（包含 videoId、标题、频道名称、当前所属主分类 categoryId/categoryName、是否看完及收藏备注）。在为用户收藏视频整理归类前必须先调用此工具。',
    permission: 'read',
    inputSchema: schema({}),
  },
  {
    version: 1,
    name: 'favorites_propose_categorization',
    description:
      '为播放器的油管收藏视频提交「单主分类」批量归类提案。每个收藏视频至多归入一个主分类（保证竖栏看板一视频一卡不重复）；优先复用 favorites_get_board 中的已有分类，确有必要时可在 newCategories 中提议创建精简的新分类（可选颜色：terracotta、ocean、sage、amber、plum、teal、rose、slate）。此工具只生成预览弹窗，经用户点击确认后才会应用。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        newCategories: {
          type: 'array',
          maxItems: 20,
          items: schema(
            {
              name: {
                type: 'string',
                minLength: 1,
                maxLength: 60,
                description: '新建分类名称（不可为“未分类”）。',
              },
              color: {
                type: 'string',
                enum: [
                  'terracotta',
                  'ocean',
                  'sage',
                  'amber',
                  'plum',
                  'teal',
                  'rose',
                  'slate',
                ],
                description: '分类色标主题色。',
              },
            },
            ['name'],
          ),
        },
        assignments: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: schema(
            {
              videoId: {
                type: 'string',
                minLength: 1,
                maxLength: 32,
                description:
                  '来自 favorites_get_board 的真实收藏视频 11 位 videoId。',
              },
              categoryName: {
                type: 'string',
                minLength: 1,
                maxLength: 60,
                description:
                  '目标主分类名称（匹配已有分类名或 newCategories 中的分类名）。',
              },
              note: {
                type: ['string', 'null'],
                maxLength: 500,
                description: '可选的一句话看点备注（留空则保留原备注）。',
              },
            },
            ['videoId', 'categoryName'],
          ),
        },
        rationale: {
          type: 'string',
          maxLength: 500,
          description: '简要说明分类划分维度与归类理由。',
        },
      },
      ['assignments', 'rationale'],
    ),
  },
];

async function favorites_get_board(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'favorites_get_board';

  assertOnlyKeys(input, []);
  if (!capabilities.getFavoritesBoard) {
    throw new Error('当前环境尚未启用播放器收藏看板读取能力。');
  }
  const snapshot = await capabilities.getFavoritesBoard();
  const categoryNameById = new Map(
    snapshot.categories.map((cat) => [cat.categoryId, cat.name]),
  );
  const items = snapshot.items.map((entry) => ({
    videoId: entry.video.videoId,
    title: entry.video.title,
    channelName: entry.video.channelName,
    channelId: entry.video.channelId,
    categoryId: entry.categoryId,
    categoryName: entry.categoryId
      ? (categoryNameById.get(entry.categoryId) ?? null)
      : null,
    finished: entry.video.finished,
    note: entry.note,
  }));
  const uncategorizedCount = items.filter(
    (item) => item.categoryId === null,
  ).length;
  return {
    version: 1,
    permission: 'read',
    name,
    label: '读取收藏视频与分类',
    summary: `当前共有 ${snapshot.categories.length} 个分类、${items.length} 个收藏视频（其中未分类 ${uncategorizedCount} 个）。`,
    result: {
      categories: snapshot.categories.map((cat) => ({
        categoryId: cat.categoryId,
        name: cat.name,
        color: cat.color,
        itemCount: cat.itemCount,
        channelIds: cat.channelIds,
      })),
      uncategorizedCount,
      items,
    },
  };
}

async function favorites_propose_categorization(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'favorites_propose_categorization';

  assertOnlyKeys(input, ['newCategories', 'assignments', 'rationale']);
  if (!capabilities.proposeFavoritesCategorization) {
    throw new Error('当前环境尚未启用收藏视频智能归类能力。');
  }
  const allowedColors = new Set<FavoriteCategoryColor>([
    'terracotta',
    'ocean',
    'sage',
    'amber',
    'plum',
    'teal',
    'rose',
    'slate',
  ]);
  let newCategories:
    | Array<{ name: string; color?: FavoriteCategoryColor }>
    | undefined;
  if (input.newCategories !== undefined) {
    if (
      !Array.isArray(input.newCategories) ||
      input.newCategories.length > 20
    ) {
      throw new Error('参数 newCategories 必须是最多 20 项的分类数组。');
    }
    newCategories = input.newCategories.map((rawCat, idx) => {
      if (!rawCat || typeof rawCat !== 'object' || Array.isArray(rawCat)) {
        throw new Error(`第 ${idx + 1} 个新分类格式无效。`);
      }
      const catObj = rawCat as Record<string, unknown>;
      assertOnlyKeys(catObj, ['name', 'color']);
      const catName = requireString(catObj, 'name', 60);
      let color: FavoriteCategoryColor | undefined;
      if (catObj.color !== undefined && catObj.color !== null) {
        const rawColor = requireString(catObj, 'color', 24);
        if (!allowedColors.has(rawColor as FavoriteCategoryColor)) {
          throw new Error(`不支持的分类颜色：${rawColor}`);
        }
        color = rawColor as FavoriteCategoryColor;
      }
      return { name: catName, color };
    });
  }

  if (
    !Array.isArray(input.assignments) ||
    input.assignments.length === 0 ||
    input.assignments.length > 200
  ) {
    throw new Error('参数 assignments 必须是包含 1 到 200 条记录的数组。');
  }
  const assignments = input.assignments.map((rawAssign, idx) => {
    if (
      !rawAssign ||
      typeof rawAssign !== 'object' ||
      Array.isArray(rawAssign)
    ) {
      throw new Error(`第 ${idx + 1} 条归类记录格式无效。`);
    }
    const assignObj = rawAssign as Record<string, unknown>;
    assertOnlyKeys(assignObj, ['videoId', 'categoryName', 'note']);
    const videoId = requireString(assignObj, 'videoId', 32);
    const categoryName = requireString(assignObj, 'categoryName', 60);
    const note =
      assignObj.note === undefined || assignObj.note === null
        ? null
        : requireString(assignObj, 'note', 500, 0);
    return { videoId, categoryName, note };
  });
  const rationale = requireString(input, 'rationale', 500, 0);

  const proposal = await capabilities.proposeFavoritesCategorization({
    newCategories,
    assignments,
    rationale,
  });
  return {
    version: 1,
    permission: 'user_approval',
    name,
    label: '预览收藏视频分类整理',
    summary: `提议新建 ${proposal.newCategories.length} 个分类、归类 ${proposal.assignments.length} 个收藏视频，等待你确认。`,
    result: {
      status: 'awaiting_user_approval',
      newCategoryCount: proposal.newCategories.length,
      assignmentCount: proposal.assignments.length,
      rationale: proposal.rationale,
    },
    favoritesCategorizationProposal: proposal,
  };
}

export const favoritesHandlers = {
  favorites_get_board,
  favorites_propose_categorization,
};
