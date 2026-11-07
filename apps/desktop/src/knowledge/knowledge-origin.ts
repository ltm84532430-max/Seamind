import type { DocumentOrigin, MapDocument } from '../library/library';
import {
  groupKnowledgeNotes,
  type KnowledgeFolder,
  UNFILED_FOLDER,
} from './knowledge-notes';

export type KnowledgeSourcePage = DocumentOrigin;

export const KNOWLEDGE_SOURCE_PAGES: readonly {
  id: KnowledgeSourcePage;
  label: string;
}[] = [
  { id: 'manual', label: '我的笔记' },
  { id: 'ebook', label: '电子书' },
  { id: 'player', label: '播放器' },
  { id: 'unknown', label: '待归类' },
];

/** 旧笔记仅作视图推断；不写回文件，也不挪动原路径。 */
export function knowledgeOrigin(
  document: Pick<MapDocument, 'origin' | 'category' | 'mapType' | 'tags'>,
): DocumentOrigin {
  if (document.origin && document.origin !== 'unknown') return document.origin;
  const category = document.category.replaceAll('\\', '/');
  const ebook =
    document.tags.includes('电子书') ||
    category === '读书笔记' ||
    category.startsWith('读书笔记/');
  const player =
    document.mapType === '视频字幕' ||
    document.tags.includes('视频字幕') ||
    category === '视频笔记' ||
    category.startsWith('视频笔记/');
  if (ebook && player) return 'unknown';
  if (ebook) return 'ebook';
  if (player) return 'player';
  if (document.mapType === '文档') return 'manual';
  return 'unknown';
}

export function sourceGroupName(
  document: MapDocument,
  page: KnowledgeSourcePage,
): string {
  if (page === 'manual' || page === 'unknown')
    return document.category || UNFILED_FOLDER;
  if (page === 'ebook') {
    const bookPath = document.sourceRef?.bookRelativePath;
    if (bookPath)
      return (
        bookPath
          .replaceAll('\\', '/')
          .split('/')
          .at(-1)
          ?.replace(/\.epub$/i, '') || '未关联书籍'
      );
    return (
      document.category.replaceAll('\\', '/').split('/')[1] || '未关联书籍'
    );
  }
  return (
    document.sourceRef?.channelName?.trim() ||
    document.tags.find(
      (tag) => !['YouTube', '视频字幕', 'AI精修'].includes(tag),
    ) ||
    '未关联频道'
  );
}

export function groupKnowledgeBySource(
  documents: readonly MapDocument[],
  page: KnowledgeSourcePage,
  query: string,
  manualCategories: readonly string[] = [],
): KnowledgeFolder<MapDocument>[] {
  const scoped = documents.filter(
    (document) => document.kind === 'doc' && knowledgeOrigin(document) === page,
  );
  if (page === 'manual')
    return groupKnowledgeNotes(scoped, query, manualCategories);
  const needle = query.trim().replace(/^#/, '').toLocaleLowerCase();
  const groups = new Map<string, MapDocument[]>();
  for (const document of scoped) {
    const name = sourceGroupName(document, page);
    if (
      needle &&
      ![
        name,
        document.title,
        document.relativePath,
        document.category,
        ...(document.tags ?? []),
      ].some((value) => value.toLocaleLowerCase().includes(needle))
    )
      continue;
    const notes = groups.get(name) ?? [];
    notes.push(document);
    groups.set(name, notes);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
    .map(([name, notes]) => ({
      name,
      notes: notes.sort((a, b) => b.updatedAt - a.updatedAt),
    }));
}
