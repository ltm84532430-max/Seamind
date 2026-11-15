import { libraryApi } from '../../library/library-api';
import {
  normalizeLibraryPath,
  saveEpubKnowledgePath,
} from '../../app/app-storage';
import type { ActiveWorkspace } from '../../app/app-storage';
import {
  findStoredCoverByBookKey,
  loadEpubBookMetadata,
} from '../../ebook/ebook-storage';
import type {
  EpubChapterChangeInfo,
  EpubReaderAgentBridge,
} from '../../ebook/EpubReader';
import { buildBookGalaxyGraph } from '../../ebook/book-galaxy-model';
import {
  createBookKnowledgeStarter,
  createChapterKnowledgeStarter,
  resolveBookChapterKnowledgeTarget,
  resolveBookKnowledgeTarget,
  type ChapterKnowledgeQuery,
} from '../../ebook/book-knowledge-target';
import type {
  EpubBookDocument,
  LibrarySnapshot,
  MapDocument,
} from '../../library/library';
import type { ActiveDocument } from '../../workbench/active-document';
import type { AgentCapabilities } from '../tool-api';
import { flattenReaderToc, matchReaderTocEntry } from './reader-toc';

type OpenReader = {
  progressKey: string;
  relativePath: string;
  title: string;
};

export interface ReaderCapabilityDeps {
  getWorkspace(): ActiveWorkspace;
  getReader(): OpenReader | null;
  getReaderBridge(): EpubReaderAgentBridge | null;
  getLibrarySnapshot(): LibrarySnapshot | null;
  getCurrentChapter(): EpubChapterChangeInfo | null;
  getOpenDocument(): ActiveDocument | null;
  editOpenDocument(markdown: string): void;
  saveOpenDocument(): Promise<boolean>;
  createKnowledgeDocument(options: {
    kind?: 'doc';
    category: string;
    title: string;
    source: string;
    tags?: string[];
    origin?: 'ebook';
    sourceRef?: {
      bookRelativePath?: string;
      chapterHref?: string;
      chapterCfi?: string;
    } | null;
  }): Promise<boolean>;
  reloadLibrary(): Promise<void>;
  openKnowledgeNote(note: MapDocument): Promise<void>;
  navigateToChapter(request: {
    progressKey: string;
    href?: string;
    label: string;
  }): void;
  notify(message: string): void;
}

function requireReader(
  deps: ReaderCapabilityDeps,
  message: string,
): OpenReader {
  const reader = deps.getReader();
  if (deps.getWorkspace() !== 'reader' || !reader) throw new Error(message);
  return reader;
}

function requireSnapshot(
  deps: ReaderCapabilityDeps,
): LibrarySnapshot & { rootPath: string } {
  const snapshot = deps.getLibrarySnapshot();
  const rootPath = snapshot?.rootPath;
  if (!snapshot || !rootPath) throw new Error('文件库尚未就绪。');
  return { ...snapshot, rootPath };
}

function bookRecord(
  snapshot: LibrarySnapshot,
  reader: OpenReader,
): Pick<EpubBookDocument, 'relativePath' | 'title'> {
  return (
    snapshot.books.find(
      (candidate) =>
        normalizeLibraryPath(candidate.relativePath) ===
        normalizeLibraryPath(reader.relativePath),
    ) ?? { relativePath: reader.relativePath, title: reader.title }
  );
}

function chapterQueryFromReader(
  chapter: EpubChapterChangeInfo | null,
  targetLabel?: string,
): ChapterKnowledgeQuery | null {
  if (targetLabel) return { label: targetLabel };
  if (!chapter) return null;
  return {
    label: chapter.chapterLabel,
    href: chapter.chapterHref,
    hierarchy: chapter.chapterHierarchy,
    cfi: chapter.cfi,
  };
}

export function createReaderCapabilities(
  deps: ReaderCapabilityDeps,
): Pick<
  AgentCapabilities,
  | 'readCurrentEpubChapter'
  | 'proposeEpubFootnote'
  | 'readCurrentBookKnowledgeNote'
  | 'updateBookKnowledgeNote'
  | 'appendBookKnowledgeExcerpt'
  | 'queryBookGalaxy'
  | 'syncReaderChapter'
> {
  const readCurrentBookKnowledgeNote: NonNullable<
    AgentCapabilities['readCurrentBookKnowledgeNote']
  > = async (input) => {
    const reader = requireReader(deps, '请先在电子书阅读器中打开一本书。');
    const snapshot = requireSnapshot(deps);
    const book = bookRecord(snapshot, reader);
    const chapterQuery = chapterQueryFromReader(
      deps.getCurrentChapter(),
      input?.chapterTarget,
    );

    if (chapterQuery?.label) {
      const chapterTarget = resolveBookChapterKnowledgeTarget(
        snapshot,
        book,
        chapterQuery,
      );
      const currentDoc = deps.getOpenDocument();
      if (
        currentDoc &&
        currentDoc.kind === 'doc' &&
        normalizeLibraryPath(currentDoc.relativePath) ===
          normalizeLibraryPath(chapterTarget.relativePath)
      ) {
        return {
          bookKey: reader.progressKey,
          bookTitle: reader.title,
          relativePath: currentDoc.relativePath,
          category: currentDoc.category || chapterTarget.category,
          title: currentDoc.title,
          exists: true,
          markdown: currentDoc.source,
          isChapterLevel: true,
          chapterLabel: chapterQuery.label,
        };
      }
      if (chapterTarget.document) {
        const opened = await libraryApi.openDocument({
          relativePath: chapterTarget.document.relativePath,
        });
        return {
          bookKey: reader.progressKey,
          bookTitle: reader.title,
          relativePath: chapterTarget.document.relativePath,
          category: chapterTarget.document.category || chapterTarget.category,
          title: chapterTarget.document.title,
          exists: true,
          markdown: opened.markdown,
          isChapterLevel: true,
          chapterLabel: chapterQuery.label,
        };
      }
      return {
        bookKey: reader.progressKey,
        bookTitle: reader.title,
        relativePath: chapterTarget.relativePath,
        category: chapterTarget.category,
        title: chapterTarget.title,
        exists: false,
        markdown: createChapterKnowledgeStarter({
          bookTitle: reader.title,
          chapterTitle: chapterQuery.label,
          parentChapter: chapterQuery.hierarchy?.[0],
          chapterHref: chapterQuery.href,
          cfi: chapterQuery.cfi,
        }),
        isChapterLevel: true,
        chapterLabel: chapterQuery.label,
      };
    }

    const target = resolveBookKnowledgeTarget(snapshot, book);
    const currentDoc = deps.getOpenDocument();
    if (
      currentDoc &&
      currentDoc.kind === 'doc' &&
      normalizeLibraryPath(currentDoc.relativePath) ===
        normalizeLibraryPath(target.relativePath)
    ) {
      return {
        bookKey: reader.progressKey,
        bookTitle: reader.title,
        relativePath: currentDoc.relativePath,
        category: currentDoc.category || target.category,
        title: currentDoc.title,
        exists: true,
        markdown: currentDoc.source,
        isChapterLevel: false,
      };
    }
    if (target.document) {
      const opened = await libraryApi.openDocument({
        relativePath: target.document.relativePath,
      });
      return {
        bookKey: reader.progressKey,
        bookTitle: reader.title,
        relativePath: target.document.relativePath,
        category: target.document.category || target.category,
        title: target.document.title,
        exists: true,
        markdown: opened.markdown,
        isChapterLevel: false,
      };
    }
    return {
      bookKey: reader.progressKey,
      bookTitle: reader.title,
      relativePath: target.relativePath,
      category: target.category,
      title: target.title,
      exists: false,
      markdown: createBookKnowledgeStarter({
        title: reader.title,
      }),
      isChapterLevel: false,
    };
  };

  const updateBookKnowledgeNote: NonNullable<
    AgentCapabilities['updateBookKnowledgeNote']
  > = async ({ content, mode, rationale, chapterTarget: targetLabel }) => {
    const reader = requireReader(deps, '请先在电子书阅读器中打开一本书。');
    const snapshot = requireSnapshot(deps);
    const book = bookRecord(snapshot, reader);
    const chapterQuery = chapterQueryFromReader(
      deps.getCurrentChapter(),
      targetLabel,
    );
    const target =
      chapterQuery && chapterQuery.label
        ? resolveBookChapterKnowledgeTarget(snapshot, book, chapterQuery)
        : resolveBookKnowledgeTarget(snapshot, book);

    let baseMarkdown = '';
    const currentDoc = deps.getOpenDocument();
    const isCurrentlyOpen =
      currentDoc &&
      currentDoc.kind === 'doc' &&
      normalizeLibraryPath(currentDoc.relativePath) ===
        normalizeLibraryPath(target.relativePath);

    if (isCurrentlyOpen && currentDoc) {
      baseMarkdown = currentDoc.source;
    } else if (target.document) {
      const opened = await libraryApi.openDocument({
        relativePath: target.document.relativePath,
      });
      baseMarkdown = opened.markdown;
    } else if (chapterQuery && chapterQuery.label) {
      baseMarkdown = createChapterKnowledgeStarter({
        bookTitle: reader.title,
        chapterTitle: chapterQuery.label,
        parentChapter: chapterQuery.hierarchy?.[0],
        chapterHref: chapterQuery.href,
        cfi: chapterQuery.cfi,
      });
    } else {
      baseMarkdown = createBookKnowledgeStarter({
        title: reader.title,
      });
    }

    const nextMarkdown =
      mode === 'append'
        ? `${baseMarkdown.trimEnd()}\n\n${content.trim()}\n`
        : content.trim();

    if (isCurrentlyOpen) {
      deps.editOpenDocument(nextMarkdown);
      await deps.saveOpenDocument();
    } else if (target.document) {
      await libraryApi.saveDocument({
        input: {
          id: target.document.id,
          relativePath: target.document.relativePath,
          title: target.document.title,
          category: target.document.category || target.category,
          mapType: '文档',
          tags: target.document.tags,
          markdown: nextMarkdown,
          historySource: 'ai',
          kind: 'doc',
          origin: 'ebook',
          sourceRef: {
            bookRelativePath: book.relativePath,
            chapterHref: chapterQuery?.href,
            chapterCfi: chapterQuery?.cfi,
          },
        },
      });
      await deps.reloadLibrary();
    } else {
      await deps.createKnowledgeDocument({
        kind: 'doc',
        category: target.category,
        title: target.title,
        source: nextMarkdown,
        tags: ['读书笔记', '电子书'],
        origin: 'ebook',
        sourceRef: {
          bookRelativePath: book.relativePath,
          chapterHref: chapterQuery?.href,
          chapterCfi: chapterQuery?.cfi,
        },
      });
      saveEpubKnowledgePath(
        snapshot.rootPath,
        reader.relativePath,
        target.relativePath,
      );
    }

    deps.notify(
      rationale ? `AI 更新读书笔记：${rationale}` : 'AI 已更新读书笔记',
    );
    return {
      relativePath: target.relativePath,
      title: target.title,
      category: target.category,
      updated: true,
      isChapterLevel: Boolean(chapterQuery?.label),
    };
  };

  return {
    readCurrentEpubChapter: () => {
      const bridge = deps.getReaderBridge();
      if (deps.getWorkspace() !== 'reader' || !bridge) {
        throw new Error('请先在电子书阅读器中打开一本书。');
      }
      return bridge.readCurrentChapter();
    },
    proposeEpubFootnote: (input) => {
      const bridge = deps.getReaderBridge();
      if (deps.getWorkspace() !== 'reader' || !bridge) {
        throw new Error('请先在电子书阅读器中打开一本书。');
      }
      return bridge.proposeFootnote(input);
    },
    readCurrentBookKnowledgeNote,
    updateBookKnowledgeNote,
    queryBookGalaxy: async () => {
      const reader = requireReader(
        deps,
        '当前环境未处于电子书阅读状态，无法查询星系图数据。',
      );
      const snapshot = requireSnapshot(deps);
      const chapter = deps.getCurrentChapter();
      const coverDataUrl =
        loadEpubBookMetadata(reader.progressKey)?.coverDataUrl ||
        findStoredCoverByBookKey(reader.progressKey) ||
        undefined;
      const graph = buildBookGalaxyGraph(
        reader.title,
        reader.progressKey,
        chapter?.toc ?? [],
        snapshot,
        chapter?.chapterHref,
        coverDataUrl,
      );
      return {
        bookTitle: graph.bookTitle,
        totalChapters: graph.stats.totalChapters,
        notesCount: graph.stats.notesCount,
        completionPercentage: graph.stats.completionPercentage,
        currentChapter: chapter?.chapterLabel,
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          label: node.label,
          kind: node.kind,
          chapterIndex: node.chapterIndex,
          hasNote: node.hasNote,
          notePath: node.notePath,
          isCurrent: node.isCurrent,
        })),
      };
    },
    syncReaderChapter: async ({ chapterTarget, reason }) => {
      const reader = requireReader(deps, '当前环境无法跳转电子书章节。');
      const snapshot = requireSnapshot(deps);
      const book = snapshot.books.find(
        (candidate) =>
          normalizeLibraryPath(candidate.relativePath) ===
          normalizeLibraryPath(reader.relativePath),
      );
      const chapter = deps.getCurrentChapter();
      const flatToc = chapter?.toc ? flattenReaderToc(chapter.toc) : [];
      const matched = matchReaderTocEntry(flatToc, chapterTarget);
      const targetLabel = matched
        ? typeof matched.label === 'string'
          ? matched.label
          : chapterTarget
        : chapterTarget;
      const targetHref = matched?.href;

      deps.navigateToChapter({
        progressKey: reader.progressKey,
        href: targetHref,
        label: targetLabel,
      });

      let notePath: string | undefined;
      if (book) {
        const target = resolveBookChapterKnowledgeTarget(snapshot, book, {
          label: targetLabel,
          href: targetHref,
        });
        if (target.document) {
          await deps.openKnowledgeNote(target.document);
          notePath = target.document.relativePath;
        }
      }

      if (reason) deps.notify(`AI 同步阅读章节：${reason}`);
      return {
        synced: true,
        targetChapter: targetLabel,
        notePath,
      };
    },
    appendBookKnowledgeExcerpt: async ({
      excerpt,
      commentary,
      chapterLabel,
    }) => {
      const heading = chapterLabel ? `### ${chapterLabel}\n` : '';
      const noteBlock = [
        heading,
        `> [!QUOTE] 章节摘录`,
        `> ${excerpt.trim().replace(/\n/g, '\n> ')}`,
        commentary?.trim()
          ? `\n**深度思考 / 见解**：\n${commentary.trim()}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      const result = await updateBookKnowledgeNote({
        content: noteBlock,
        mode: 'append',
        rationale: chapterLabel
          ? `摘录沉淀至「${chapterLabel}」`
          : '摘录沉淀至读书笔记',
      });
      return {
        relativePath: result.relativePath,
        title: result.title,
        appended: result.updated,
      };
    },
  };
}
