import { bookMindmapTitle } from './book-mindmap-target';
import type { EpubBookDocument, LibrarySnapshot, MapDocument } from './library';

const normalizePath = (path: string) =>
  path.replaceAll('\\', '/').toLowerCase();

/**
 * Sanitizes a string for use as a folder or file name segment,
 * stripping Windows/POSIX reserved characters while preserving CJK and punctuation.
 */
export const sanitizePathSegment = (value: string, maxLength = 80): string => {
  const trimmed = Array.from(value.trim()).slice(0, maxLength).join('');
  const cleaned = trimmed
    // Windows file names cannot contain control characters or <>:"/\|?*
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned || '章节';
};

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

/**
 * Category for a chapter note. If a parent chapter is available,
 * partitions into e.g. "读书笔记/C Primer Plus/第8章 字符输入输出".
 */
export const bookChapterKnowledgeCategory = (
  bookTitle: string,
  chapterHierarchy?: string[],
): string => {
  const cleanBook = bookMindmapTitle(bookTitle);
  if (!chapterHierarchy || chapterHierarchy.length <= 1) {
    if (chapterHierarchy && chapterHierarchy.length === 1) {
      const parent = sanitizePathSegment(chapterHierarchy[0]);
      return `读书笔记/${cleanBook}/${parent}`;
    }
    return `读书笔记/${cleanBook}`;
  }
  // If multi-level, top-level parent chapter is hierarchy[0]
  const parent = sanitizePathSegment(chapterHierarchy[0]);
  return `读书笔记/${cleanBook}/${parent}`;
};

export const bookChapterKnowledgeNoteTitle = (chapterLabel: string): string => {
  return sanitizePathSegment(chapterLabel);
};

export const bookChapterKnowledgeNotePath = (
  bookTitle: string,
  chapterLabel: string,
  chapterHierarchy?: string[],
): string => {
  const category = bookChapterKnowledgeCategory(bookTitle, chapterHierarchy);
  const title = bookChapterKnowledgeNoteTitle(chapterLabel);
  return `${category}/${title}.md`;
};

export interface ChapterKnowledgeQuery {
  label: string;
  href?: string;
  cfi?: string;
  hierarchy?: string[];
  index?: string;
}

/**
 * Resolves or computes the target knowledge note for a specific book chapter.
 */
export function resolveBookChapterKnowledgeTarget(
  snapshot: LibrarySnapshot,
  book: Pick<EpubBookDocument, 'relativePath' | 'title'>,
  chapter: ChapterKnowledgeQuery,
): {
  relativePath: string;
  document: MapDocument | null;
  category: string;
  title: string;
  isChapterLevel: boolean;
} {
  const cleanBook = bookMindmapTitle(book.title);
  const targetCategory = bookChapterKnowledgeCategory(
    book.title,
    chapter.hierarchy,
  );
  const targetTitle = bookChapterKnowledgeNoteTitle(chapter.label);
  const preferredPath = bookChapterKnowledgeNotePath(
    book.title,
    chapter.label,
    chapter.hierarchy,
  );

  const findDocument = (path: string) =>
    snapshot.documents.find(
      (document) =>
        document.kind === 'doc' &&
        normalizePath(document.relativePath) === normalizePath(path),
    ) ?? null;

  // 1. Direct path match
  const preferredDoc = findDocument(preferredPath);
  if (preferredDoc) {
    return {
      relativePath: preferredDoc.relativePath,
      document: preferredDoc,
      category: preferredDoc.category || targetCategory,
      title: preferredDoc.title,
      isChapterLevel: true,
    };
  }

  // 2. Match by exact title under the book's root or chapter directory
  const normalizedBookCategory = normalizePath(`读书笔记/${cleanBook}`);
  const matchedDoc =
    snapshot.documents.find((doc) => {
      if (doc.kind !== 'doc') return false;
      const docNormCat = normalizePath(doc.category);
      const isUnderBook =
        docNormCat === normalizedBookCategory ||
        docNormCat.startsWith(`${normalizedBookCategory}/`);
      if (!isUnderBook) return false;
      return (
        doc.title === targetTitle ||
        normalizePath(doc.relativePath).endsWith(
          `/${normalizePath(targetTitle)}.md`,
        )
      );
    }) ?? null;

  if (matchedDoc) {
    return {
      relativePath: matchedDoc.relativePath,
      document: matchedDoc,
      category: matchedDoc.category || targetCategory,
      title: matchedDoc.title,
      isChapterLevel: true,
    };
  }

  return {
    relativePath: preferredPath,
    document: null,
    category: targetCategory,
    title: targetTitle,
    isChapterLevel: true,
  };
}

export function parseMarkdownFrontmatter(markdown: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) {
    return { frontmatter: {}, body: markdown };
  }
  const rawYaml = match[1];
  const body = match[2];
  const frontmatter: Record<string, string> = {};
  for (const line of rawYaml.split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      frontmatter[key] = val;
    }
  }
  return { frontmatter, body };
}

export function createChapterKnowledgeStarter(input: {
  bookTitle: string;
  creator?: string;
  chapterTitle: string;
  parentChapter?: string;
  chapterHref?: string;
  chapterIndex?: string;
  cfi?: string;
}): string {
  const book = input.bookTitle.trim() || '电子书';
  const chapter = input.chapterTitle.trim() || '章节笔记';
  const parent = input.parentChapter ? input.parentChapter.trim() : '';
  const href = input.chapterHref ? input.chapterHref.trim() : '';
  const index = input.chapterIndex ? input.chapterIndex.trim() : '';
  const authorLine = input.creator ? `- **作者**：${input.creator}\n` : '';
  const parentLine = parent ? `- **所属大章**：${parent}\n` : '';

  return `---
book_title: "${book.replace(/"/g, '\\"')}"
chapter_title: "${chapter.replace(/"/g, '\\"')}"
parent_chapter: "${parent.replace(/"/g, '\\"')}"
chapter_index: "${index.replace(/"/g, '\\"')}"
chapter_href: "${href.replace(/"/g, '\\"')}"
source_cfi: "${(input.cfi || '').replace(/"/g, '\\"')}"
tags:
  - 读书笔记
  - 电子书
---

# ${chapter}

> 来源书籍：《${book}》${parent ? ` · ${parent}` : ''}

## 基本信息
- **书名**：${book}
${authorLine}${parentLine}- **分类**：${bookChapterKnowledgeCategory(book, parent ? [parent] : [])}
- **阅读状态**：精读中

---

## 核心概念与关键要点
- 

---

## 深度分析与思考
- 

---

## 实践/代码记录
\`\`\`c

\`\`\`

---

## 延伸疑问与前后关联
- 前置章节依赖：
- 实践探索方向：
`;
}

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
