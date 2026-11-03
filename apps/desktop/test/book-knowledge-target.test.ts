import { describe, expect, it, vi } from 'vitest';
import {
  bookKnowledgeCategory,
  bookKnowledgeNotePath,
  bookKnowledgeNoteTitle,
  createBookKnowledgeStarter,
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
});
