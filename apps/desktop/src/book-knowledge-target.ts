import { bookMindmapTitle } from './book-mindmap-target';
import type { EpubBookDocument, LibrarySnapshot, MapDocument } from './library';

const normalizePath = (path: string) =>
  path.replaceAll('\\', '/').toLowerCase();

export const bookKnowledgeCategory = (title: string): string => {
  const clean = bookMindmapTitle(title);
  return `读书笔记/${clean}`;
};

export const bookKnowledgeNoteTitle = (title: string): string => {
  const clean = bookMindmapTitle(title);
  return `${clean} 读书笔记`;
};

export const bookKnowledgeNotePath = (title: string): string => {
  const clean = bookMindmapTitle(title);
  return `读书笔记/${clean}/${clean} 读书笔记.md`;
};

export function resolveBookKnowledgeTarget(
  snapshot: LibrarySnapshot,
  book: Pick<EpubBookDocument, 'relativePath' | 'title'>,
  readSavedPath?: (epubRelativePath: string) => string | null,
): {
  relativePath: string;
  document: MapDocument | null;
  category: string;
  title: string;
} {
  const targetCategory = bookKnowledgeCategory(book.title);
  const targetTitle = bookKnowledgeNoteTitle(book.title);
  const preferredPath = bookKnowledgeNotePath(book.title);

  const findDocument = (path: string) =>
    snapshot.documents.find(
      (document) =>
        document.kind === 'doc' &&
        normalizePath(document.relativePath) === normalizePath(path),
    ) ?? null;

  const savedPath = readSavedPath?.(book.relativePath);
  const savedDocument = savedPath ? findDocument(savedPath) : null;
  if (savedDocument) {
    return {
      relativePath: savedDocument.relativePath,
      document: savedDocument,
      category: savedDocument.category || targetCategory,
      title: savedDocument.title,
    };
  }

  // Look for exact preferred path
  const preferredDocument = findDocument(preferredPath);
  if (preferredDocument) {
    return {
      relativePath: preferredDocument.relativePath,
      document: preferredDocument,
      category: preferredDocument.category || targetCategory,
      title: preferredDocument.title,
    };
  }

  // Look for any existing note in this book's category or titled with the book title
  const normalizedCategory = normalizePath(targetCategory);
  const matchedDocument =
    snapshot.documents.find(
      (document) =>
        document.kind === 'doc' &&
        (normalizePath(document.category) === normalizedCategory ||
          document.title === targetTitle ||
          document.title === `${book.title} 读书笔记`),
    ) ?? null;

  if (matchedDocument) {
    return {
      relativePath: matchedDocument.relativePath,
      document: matchedDocument,
      category: matchedDocument.category || targetCategory,
      title: matchedDocument.title,
    };
  }

  return {
    relativePath: preferredPath,
    document: null,
    category: targetCategory,
    title: targetTitle,
  };
}

export function createBookKnowledgeStarter(book: {
  title: string;
  creator?: string;
  currentChapter?: string;
}): string {
  const title = book.title.trim() || '电子书';
  const authorLine = book.creator ? `- **作者**：${book.creator}\n` : '';
  const chapterLine = book.currentChapter
    ? `### ${book.currentChapter}\n- `
    : '### 核心要点\n- ';

  return `# 《${title}》读书笔记

## 基本信息
- **书名**：${title}
${authorLine}- **分类**：${bookKnowledgeCategory(title)}
- **状态**：精读中

---

## 核心认知与主干思考
> 记录全书最关键的洞察、核心定理与架构逻辑。

-

---

## 章节深度笔记
${chapterLine}

---

## 疑问与实践延伸
-
`;
}
