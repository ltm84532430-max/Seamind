import { describe, expect, it, vi } from 'vitest';
import {
  bookChapterKnowledgeCategory,
  bookChapterKnowledgeNotePath,
  bookChapterKnowledgeNoteTitle,
  bookKnowledgeCategory,
  bookKnowledgeNotePath,
  bookKnowledgeNoteTitle,
  createBookKnowledgeStarter,
  createChapterKnowledgeStarter,
  parseMarkdownFrontmatter,
  resolveBookChapterKnowledgeTarget,
  resolveBookKnowledgeTarget,
} from '../src/book-knowledge-target';
import { executeAgentTool } from '../src/agent/capabilities';
import type { AgentCapabilities } from '../src/agent/capabilities';
import type { LibrarySnapshot, MapDocument } from '../src/library';

function capabilities(
  overrides: Partial<AgentCapabilities>,
): AgentCapabilities {
  return overrides as AgentCapabilities;
}

describe('Book Knowledge Target & Tools', () => {
  it('formats category, note title, and relative path with book stem', () => {
    const bookTitle = 'C Primer Plus';
    expect(bookKnowledgeCategory(bookTitle)).toBe('读书笔记/C Primer Plus');
    expect(bookKnowledgeNoteTitle(bookTitle)).toBe('C Primer Plus 读书笔记');
    expect(bookKnowledgeNotePath(bookTitle)).toBe(
      '读书笔记/C Primer Plus/C Primer Plus 读书笔记.md',
    );
  });

  it('resolves existing knowledge note from snapshot documents', () => {
    const existingDoc: MapDocument = {
      id: 'doc-1',
      relativePath: '读书笔记/C Primer Plus/C Primer Plus 读书笔记.md',
      title: 'C Primer Plus 读书笔记',
      category: '读书笔记/C Primer Plus',
      mapType: '文档',
      tags: ['读书笔记'],
      createdAt: 1000,
      updatedAt: 2000,
      kind: 'doc',
    };
    const snapshot: LibrarySnapshot = {
      rootPath: 'C:/books',
      documents: [existingDoc],
      books: [],
      plantumlFiles: [],
      textDocuments: [],
      categories: ['读书笔记/C Primer Plus'],
    };

    const target = resolveBookKnowledgeTarget(snapshot, {
      relativePath: 'books/C Primer Plus.epub',
      title: 'C Primer Plus',
    });

    expect(target.document).toBe(existingDoc);
    expect(target.relativePath).toBe(
      '读书笔记/C Primer Plus/C Primer Plus 读书笔记.md',
    );
  });

  it('generates structured starter markdown with metadata and chapter sections', () => {
    const starter = createBookKnowledgeStarter({
      title: '深入理解计算机系统',
      creator: 'Randal E. Bryant',
      currentChapter: '第1章 计算机系统漫游',
    });
    expect(starter).toContain('# 《深入理解计算机系统》读书笔记');
    expect(starter).toContain('- **作者**：Randal E. Bryant');
    expect(starter).toContain('### 第1章 计算机系统漫游');
    expect(starter).toContain('## 核心认知与主干思考');
  });

  it('executes knowledge_get_book_note agent tool successfully', async () => {
    const readCurrentBookKnowledgeNote = vi.fn(async () => ({
      bookKey: 'book-key-1',
      bookTitle: 'C Primer Plus',
      relativePath: '读书笔记/C Primer Plus/C Primer Plus 读书笔记.md',
      category: '读书笔记/C Primer Plus',
      title: 'C Primer Plus 读书笔记',
      exists: true,
      markdown: '# C Primer Plus 笔记\n\n循环控制逻辑分析',
    }));

    const api = capabilities({ readCurrentBookKnowledgeNote });
    const response = await executeAgentTool(
      'knowledge_get_book_note',
      JSON.stringify({}),
      api,
    );

    expect(response.name).toBe('knowledge_get_book_note');
    expect(response.result.bookTitle).toBe('C Primer Plus');
    expect(response.result.markdown).toContain('循环控制逻辑分析');
    expect(readCurrentBookKnowledgeNote).toHaveBeenCalledTimes(1);
  });

  it('executes knowledge_update_book_note and knowledge_append_excerpt tools', async () => {
    const updateBookKnowledgeNote = vi.fn(async () => ({
      relativePath: '读书笔记/C Primer Plus/C Primer Plus 读书笔记.md',
      title: 'C Primer Plus 读书笔记',
      category: '读书笔记/C Primer Plus',
      updated: true,
    }));
    const appendBookKnowledgeExcerpt = vi.fn(async () => ({
      relativePath: '读书笔记/C Primer Plus/C Primer Plus 读书笔记.md',
      title: 'C Primer Plus 读书笔记',
      appended: true,
    }));

    const api = capabilities({
      updateBookKnowledgeNote,
      appendBookKnowledgeExcerpt,
    });

    const updateRes = await executeAgentTool(
      'knowledge_update_book_note',
      JSON.stringify({
        content: '### 第6章 循环深入\n- while 循环求和示例',
        mode: 'append',
        rationale: '记录第6章循环分析',
      }),
      api,
    );
    expect(updateRes.result.updated).toBe(true);
    expect(updateBookKnowledgeNote).toHaveBeenCalledWith({
      content: '### 第6章 循环深入\n- while 循环求和示例',
      mode: 'append',
      rationale: '记录第6章循环分析',
    });

    const appendRes = await executeAgentTool(
      'knowledge_append_excerpt',
      JSON.stringify({
        excerpt: 'while (status == 1) { sum = sum + num; }',
        commentary: '此段展示使用 scanf 的返回值控制输入循环终止。',
        chapterLabel: '第6章 C控制语句：循环',
      }),
      api,
    );
    expect(appendRes.result.appended).toBe(true);
    expect(appendBookKnowledgeExcerpt).toHaveBeenCalledWith({
      excerpt: 'while (status == 1) { sum = sum + num; }',
      commentary: '此段展示使用 scanf 的返回值控制输入循环终止。',
      chapterLabel: '第6章 C控制语句：循环',
    });
  });

  it('executes chapter-aware agent tools: query_galaxy and sync_reader_chapter', async () => {
    const queryBookGalaxy = vi.fn(async () => ({
      bookTitle: 'C Primer Plus',
      totalChapters: 12,
      notesCount: 3,
      completionPercentage: 25,
      currentChapter: '8.1 单字符I/O',
      nodes: [
        { id: 'sun-root', label: 'C Primer Plus', kind: 'sun', hasNote: true },
        {
          id: 'planet-8-1',
          label: '8.1 单字符I/O',
          kind: 'planet',
          chapterIndex: '8.1',
          hasNote: true,
          isCurrent: true,
        },
      ],
    }));

    const syncReaderChapter = vi.fn(
      async ({ chapterTarget }: { chapterTarget: string }) => ({
        synced: true,
        targetChapter: chapterTarget,
        notePath: '读书笔记/C Primer Plus/第8章/8.1 单字符IO.md',
      }),
    );

    const api = capabilities({
      queryBookGalaxy,
      syncReaderChapter,
    });

    const galaxyRes = await executeAgentTool(
      'knowledge_query_book_galaxy',
      JSON.stringify({}),
      api,
    );
    expect(galaxyRes.name).toBe('knowledge_query_book_galaxy');
    expect(galaxyRes.result.totalChapters).toBe(12);
    expect(galaxyRes.result.nodes.length).toBe(2);
    expect(queryBookGalaxy).toHaveBeenCalledTimes(1);

    const syncRes = await executeAgentTool(
      'knowledge_sync_reader_chapter',
      JSON.stringify({
        chapterTarget: '8.1',
        reason: '跳转到单字符IO小节并打开对应的研读笔记',
      }),
      api,
    );
    expect(syncRes.name).toBe('knowledge_sync_reader_chapter');
    expect(syncRes.result.synced).toBe(true);
    expect(syncRes.result.targetChapter).toBe('8.1');
    expect(syncReaderChapter).toHaveBeenCalledWith({
      chapterTarget: '8.1',
      reason: '跳转到单字符IO小节并打开对应的研读笔记',
    });
  });

  it('formats chapter level category, title and partitioned file path', () => {
    const bookTitle = 'C Primer Plus';
    const hierarchy = [
      '第8章 字符输入/输出和输入验证',
      '8.1 单字符I/O: getchar()和putchar()',
    ];
    const chapterLabel = '8.1 单字符I/O: getchar()和putchar()';

    const category = bookChapterKnowledgeCategory(bookTitle, hierarchy);
    expect(category).toBe(
      '读书笔记/C Primer Plus/第8章 字符输入 输出和输入验证',
    );

    const title = bookChapterKnowledgeNoteTitle(chapterLabel);
    expect(title).toBe('8.1 单字符I O getchar()和putchar()');

    const path = bookChapterKnowledgeNotePath(
      bookTitle,
      chapterLabel,
      hierarchy,
    );
    expect(path).toBe(
      '读书笔记/C Primer Plus/第8章 字符输入 输出和输入验证/8.1 单字符I O getchar()和putchar().md',
    );
  });

  it('resolves chapter knowledge note from snapshot and generates structured frontmatter starter', () => {
    const book = {
      relativePath: 'books/C Primer Plus.epub',
      title: 'C Primer Plus',
    };
    const chapterQuery = {
      label: '8.1 单字符I/O: getchar()和putchar()',
      hierarchy: [
        '第8章 字符输入/输出和输入验证',
        '8.1 单字符I/O: getchar()和putchar()',
      ],
      href: 'text/ch08.xhtml#sec8_1',
      index: '8.1',
    };

    const emptySnapshot: LibrarySnapshot = {
      rootPath: 'C:/books',
      documents: [],
      books: [],
      plantumlFiles: [],
      textDocuments: [],
      categories: [],
    };

    const target = resolveBookChapterKnowledgeTarget(
      emptySnapshot,
      book,
      chapterQuery,
    );
    expect(target.document).toBeNull();
    expect(target.isChapterLevel).toBe(true);
    expect(target.relativePath).toContain('第8章 字符输入 输出和输入验证');
    expect(target.relativePath).toContain(
      '8.1 单字符I O getchar()和putchar().md',
    );

    // Test starter creation and frontmatter parsing
    const starter = createChapterKnowledgeStarter({
      bookTitle: book.title,
      creator: 'Stephen Prata',
      chapterTitle: chapterQuery.label,
      parentChapter: '第8章 字符输入/输出和输入验证',
      chapterHref: chapterQuery.href,
      chapterIndex: chapterQuery.index,
    });

    expect(starter).toContain('book_title: "C Primer Plus"');
    expect(starter).toContain(
      'chapter_title: "8.1 单字符I/O: getchar()和putchar()"',
    );
    expect(starter).toContain('chapter_href: "text/ch08.xhtml#sec8_1"');
    expect(starter).toContain('# 8.1 单字符I/O: getchar()和putchar()');

    const parsed = parseMarkdownFrontmatter(starter);
    expect(parsed.frontmatter.book_title).toBe('C Primer Plus');
    expect(parsed.frontmatter.chapter_title).toBe(
      '8.1 单字符I/O: getchar()和putchar()',
    );
    expect(parsed.frontmatter.chapter_href).toBe('text/ch08.xhtml#sec8_1');
    expect(parsed.body).toContain('## 核心概念与关键要点');
  });
});
