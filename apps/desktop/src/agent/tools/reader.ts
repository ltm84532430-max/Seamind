import type { AgentCapabilities, AgentToolResult } from '../tool-api';
import type {
  AgentToolDescriptor,
  KnowledgeNoteProposal,
  ReaderChapterProposal,
} from '../types';
import {
  assertOnlyKeys,
  MAX_TOOL_READ_CHARS,
  optionalString,
  requireInteger,
  requireString,
  requireText,
  schema,
} from './parse';

export const readerToolCatalog: AgentToolDescriptor[] = [
  {
    version: 1,
    name: 'epub_get_current_chapter',
    description:
      '读取电子书阅读器当前章节的完整正文，可用 offset 分段读取直到 nextOffset 为 null；每次调用都从当前阅读位置重新读取。返回当前选区的 CFI 和文字，添加脚注时使用该 CFI。',
    permission: 'read',
    inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }),
  },
  {
    version: 1,
    name: 'epub_propose_footnote',
    description:
      '针对阅读器当前选区提交 AI 脚注预览。selectionCfi 必须来自 epub_get_current_chapter 返回的当前选区。用户在阅读器中确认后才会保存；取消或选区变化时失败。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        selectionCfi: { type: 'string', minLength: 1, maxLength: 1000 },
        text: { type: 'string', minLength: 1, maxLength: 800 },
      },
      ['selectionCfi', 'text'],
    ),
  },
  {
    version: 1,
    name: 'knowledge_get_book_note',
    description:
      '读取当前电子书或指定章节对应的知识库 Markdown 读书笔记全文、标题、分类与相对路径。可指定 chapterTarget（如 "8.1" 或 "第8章"），留空则默认读取当前正在阅读的章节。',
    permission: 'read',
    inputSchema: schema({
      chapterTarget: {
        type: 'string',
        description:
          '可选：指定章节序号或标题（如 "8.1" 或 "第8章 字符输入"）。若省略则取当前正文章节。',
      },
    }),
  },
  {
    version: 1,
    name: 'knowledge_update_book_note',
    description:
      '为当前电子书或指定章节的知识库 Markdown 笔记提交修改预览。mode 为 "append" 时准备在文末追加，mode 为 "overwrite" 时准备全量重写。用户在 Seamind 中确认前不会写入。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        content: {
          type: 'string',
          minLength: 1,
          description: '待写入或追加的 Markdown 笔记正文。',
        },
        mode: {
          type: 'string',
          enum: ['append', 'overwrite'],
          description: '写入模式：append 追加或 overwrite 覆盖。',
        },
        chapterTarget: {
          type: 'string',
          description:
            '可选：指定章节序号或标题（如 "8.1" 或 "第8章"）。若省略则归属于当前正文章节。',
        },
        rationale: {
          type: 'string',
          maxLength: 300,
          description: '本次知识沉淀或修改的意图说明。',
        },
      },
      ['content', 'mode'],
    ),
  },
  {
    version: 1,
    name: 'knowledge_query_book_galaxy',
    description:
      '查询当前电子书的完整章节目录树拓扑、星系图节点以及各章节关联知识库笔记的覆盖度与状态，用于全书知识鸟瞰与章节定位。',
    permission: 'read',
    inputSchema: schema({}),
  },
  {
    version: 1,
    name: 'knowledge_sync_reader_chapter',
    description:
      '提交电子书跳转预览：目标章节（如 "8.1" 或 "第8章"）确认后才会翻页，并联动切换右侧知识库笔记。用户确认前阅读位置不变。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        chapterTarget: {
          type: 'string',
          description: '目标章节的编号、标题或名称（如 "8.1" 或 "第8章"）。',
        },
        reason: {
          type: 'string',
          description: '跳转该章节的教学、伴读或复习意图。',
        },
      },
      ['chapterTarget'],
    ),
  },
  {
    version: 1,
    name: 'knowledge_append_excerpt',
    description:
      '把电子书摘录、概念代码或思考整理成知识库笔记中的引用块预览。用户在 Seamind 中确认前不会写入。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        excerpt: {
          type: 'string',
          minLength: 1,
          description: '从书中选取的关键段落或代码。',
        },
        commentary: {
          type: 'string',
          description: 'AI 或用户的思考、解析或扩展洞见。',
        },
        chapterLabel: {
          type: 'string',
          description: '当前章节名称（用于结构化归类）。',
        },
      },
      ['excerpt'],
    ),
  },
];

async function epub_get_current_chapter(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'epub_get_current_chapter';

  assertOnlyKeys(input, ['offset']);
  if (!capabilities.readCurrentEpubChapter)
    throw new Error('当前环境无法读取电子书。');
  const offset =
    input.offset === undefined ? 0 : requireInteger(input, 'offset');
  const chapter = await capabilities.readCurrentEpubChapter();
  const start = Math.min(offset, chapter.text.length);
  const content = chapter.text.slice(start, start + MAX_TOOL_READ_CHARS);
  const nextOffset = start + content.length;
  return {
    version: 1,
    permission: 'read',
    name,
    label: '当前电子书章节',
    summary: `${chapter.bookTitle} · ${chapter.sectionLabel}`,
    result: {
      bookKey: chapter.bookKey,
      bookTitle: chapter.bookTitle,
      sectionIndex: chapter.sectionIndex,
      sectionHref: chapter.sectionHref,
      sectionLabel: chapter.sectionLabel,
      totalChars: chapter.text.length,
      offset: start,
      content,
      nextOffset: nextOffset < chapter.text.length ? nextOffset : null,
      selection: chapter.selection,
    },
  };
}

async function epub_propose_footnote(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'epub_propose_footnote';

  assertOnlyKeys(input, ['selectionCfi', 'text']);
  if (!capabilities.proposeEpubFootnote)
    throw new Error('当前环境无法添加电子书脚注。');
  const selectionCfi = requireString(input, 'selectionCfi', 1000);
  const footnoteText = requireText(input, 'text', 800, 1).trim();
  const saved = await capabilities.proposeEpubFootnote({
    selectionCfi,
    text: footnoteText,
  });
  return {
    version: 1,
    permission: 'user_approval',
    name,
    label: '电子书脚注',
    summary: '用户已确认并保存脚注。',
    result: { annotationId: saved.annotationId, saved: true },
  };
}

async function knowledge_get_book_note(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'knowledge_get_book_note';

  assertOnlyKeys(input, ['chapterTarget']);
  if (!capabilities.readCurrentBookKnowledgeNote)
    throw new Error('当前环境未处于电子书阅读状态，无法获取书籍知识库笔记。');
  const chapterTarget = optionalString(input, 'chapterTarget', 200);
  const note = await capabilities.readCurrentBookKnowledgeNote({
    chapterTarget,
  });
  return {
    version: 1,
    permission: 'read',
    name,
    label: '电子书读书笔记',
    summary: `${note.bookTitle} · ${note.title} (${note.exists ? '已存在' : '新文件'})`,
    result: {
      bookKey: note.bookKey,
      bookTitle: note.bookTitle,
      relativePath: note.relativePath,
      category: note.category,
      title: note.title,
      exists: note.exists,
      markdown: note.markdown,
      isChapterLevel: note.isChapterLevel,
      chapterLabel: note.chapterLabel,
    },
  };
}

async function knowledge_update_book_note(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'knowledge_update_book_note';

  assertOnlyKeys(input, ['content', 'mode', 'rationale', 'chapterTarget']);
  if (!capabilities.updateBookKnowledgeNote)
    throw new Error('当前环境未处于电子书阅读状态，无法更新知识库笔记。');
  const content = requireText(input, 'content', 150_000, 1);
  const mode = requireString(input, 'mode', 20) as 'append' | 'overwrite';
  if (mode !== 'append' && mode !== 'overwrite') {
    throw new Error('mode 仅支持 "append" 或 "overwrite"。');
  }
  const rationale = optionalString(input, 'rationale', 300) ?? '';
  const chapterTarget = optionalString(input, 'chapterTarget', 200);
  const knowledgeNoteProposal: KnowledgeNoteProposal = {
    kind: 'update',
    content,
    mode,
    ...(chapterTarget ? { chapterTarget } : {}),
    rationale,
  };
  return {
    version: 1,
    permission: 'user_approval',
    name,
    label: '更新读书笔记',
    summary: `已准备${mode === 'append' ? '追加' : '覆盖'}读书笔记，等待你确认。`,
    result: {
      status: 'awaiting_user_approval',
      mode,
      chapterTarget: chapterTarget ?? null,
      rationale,
      contentChars: content.length,
    },
    knowledgeNoteProposal,
  };
}

async function knowledge_query_book_galaxy(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'knowledge_query_book_galaxy';

  assertOnlyKeys(input, []);
  if (!capabilities.queryBookGalaxy)
    throw new Error('当前环境未处于电子书阅读状态，无法查询星系图数据。');
  const galaxy = await capabilities.queryBookGalaxy();
  return {
    version: 1,
    permission: 'read',
    name,
    label: '全书知识星系',
    summary: `${galaxy.bookTitle} · 共 ${galaxy.totalChapters} 章节 (笔记覆盖 ${galaxy.notesCount})`,
    result: galaxy,
  };
}

async function knowledge_sync_reader_chapter(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'knowledge_sync_reader_chapter';

  assertOnlyKeys(input, ['chapterTarget', 'reason']);
  if (!capabilities.syncReaderChapter)
    throw new Error('当前环境无法跳转电子书章节。');
  const chapterTarget = requireString(input, 'chapterTarget', 200);
  const reason = optionalString(input, 'reason', 300) ?? '';
  const readerChapterProposal: ReaderChapterProposal = {
    kind: 'chapter',
    chapterTarget,
    reason,
  };
  return {
    version: 1,
    permission: 'user_approval',
    name,
    label: '同步阅读章节',
    summary: `已准备跳转到「${chapterTarget}」，等待你确认。`,
    result: {
      status: 'awaiting_user_approval',
      chapterTarget,
      reason,
    },
    readerChapterProposal,
  };
}

async function knowledge_append_excerpt(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'knowledge_append_excerpt';

  assertOnlyKeys(input, ['excerpt', 'commentary', 'chapterLabel']);
  if (!capabilities.appendBookKnowledgeExcerpt)
    throw new Error('当前环境未处于电子书阅读状态，无法沉淀摘录至知识库。');
  const excerpt = requireText(input, 'excerpt', 10_000, 1);
  const commentary = optionalString(input, 'commentary', 5_000);
  const chapterLabel = optionalString(input, 'chapterLabel', 200);
  const knowledgeNoteProposal: KnowledgeNoteProposal = {
    kind: 'excerpt',
    excerpt,
    ...(commentary ? { commentary } : {}),
    ...(chapterLabel ? { chapterLabel } : {}),
  };
  return {
    version: 1,
    permission: 'user_approval',
    name,
    label: '知识库摘录沉淀',
    summary: '已准备把摘录写入读书笔记，等待你确认。',
    result: {
      status: 'awaiting_user_approval',
      chapterLabel: chapterLabel ?? null,
      excerptChars: excerpt.length,
    },
    knowledgeNoteProposal,
  };
}

export const readerHandlers = {
  epub_get_current_chapter,
  epub_propose_footnote,
  knowledge_get_book_note,
  knowledge_update_book_note,
  knowledge_query_book_galaxy,
  knowledge_sync_reader_chapter,
  knowledge_append_excerpt,
};
