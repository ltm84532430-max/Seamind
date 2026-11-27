import {
  MAX_AGENT_BRANCH_CHARS,
  MAX_MARKDOWN_NODE_NOTE_CHARS,
  MAX_MINDMAP_CODE_BLOCK_CHARS,
} from '../../mindmap/commands';
import type { AgentCapabilities, AgentToolResult } from '../tool-api';
import type {
  AgentToolDescriptor,
  KnowledgeDocumentEditMode,
  KnowledgeDocumentEditProposal,
  NodeEditOperation,
} from '../types';
import {
  assertOnlyKeys,
  MAX_SEARCH_RESULTS,
  MAX_TOOL_READ_CHARS,
  optionalString,
  previewDocument,
  requireInteger,
  requireString,
  requireText,
  schema,
} from './parse';

const MAX_KNOWLEDGE_DOC_PROPOSAL_CHARS = 180_000;

function extractMarkdownHeadings(
  markdown: string,
): Array<{ level: number; text: string; offset: number; line: number }> {
  const headings: Array<{
    level: number;
    text: string;
    offset: number;
    line: number;
  }> = [];
  const lines = markdown.split(/\r?\n/);
  let offset = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
    } else if (!inFence) {
      const m = /^(#{1,4})\s+(.+)$/.exec(trimmed);
      if (m) {
        headings.push({
          level: m[1].length,
          text: m[2].trim().slice(0, 120),
          offset,
          line: i + 1,
        });
        if (headings.length >= 60) break;
      }
    }
    offset += raw.length + 1;
  }
  return headings;
}

export const mindmapToolCatalog: AgentToolDescriptor[] = [
  {
    version: 1,
    name: 'mindmap_get_current',
    description:
      '读取当前打开的思维导图结构和完整 Markdown 原文（仅用于思维导图工作区；若用户在知识库阅读 Markdown 文档请改用 knowledge_get_current_document）。每个节点包含持久 nodeId、allowedOperations 和 noteTruncated；修改导图前必须先调用此工具。',
    permission: 'read',
    inputSchema: schema({}),
  },
  {
    version: 1,
    name: 'knowledge_get_current_document',
    description:
      '读取知识库工作区当前正在打开/阅读的 Markdown 文档（如视频笔记、研究文档、读书笔记等），返回标题、相对路径、总字数、总行数、章节大纲（含字符 offset）以及正文内容。文档较长时可通过 offset（字符偏移）和 maxChars 分段读取直到 nextOffset 为 null。当左侧/主页面为知识库文档时，优先调用此工具。',
    permission: 'read',
    inputSchema: schema({
      offset: {
        type: 'integer',
        minimum: 0,
        description: '可选：正文读取起始字符偏移，默认 0。',
      },
      maxChars: {
        type: 'integer',
        minimum: 500,
        maximum: 24_000,
        description: '可选：单次读取最大字符数，默认 12000，上限 24000。',
      },
    }),
  },
  {
    version: 1,
    name: 'knowledge_propose_document_edit',
    description:
      '对当前打开的知识库 Markdown 文档提出修改、追加或新建副本（如全文翻译、双语对照、摘要整理）的待确认提案。mode="create_copy" 保留原文并新建独立文档（推荐用于长文翻译）；mode="append" 在文末追加；mode="replace" 替换当前文档全文。工具仅生成确认卡片，用户点击确认后才会写入知识库。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        mode: {
          type: 'string',
          enum: ['create_copy', 'append', 'replace'],
          description:
            '写入方式：create_copy 新建译文/整理副本（保留原文）；append 文末追加；replace 替换原文。',
        },
        content: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_KNOWLEDGE_DOC_PROPOSAL_CHARS,
          description: '待写入或追加的完整 Markdown 正文。',
        },
        newTitle: {
          type: 'string',
          minLength: 1,
          maxLength: 180,
          description:
            '可选：mode="create_copy" 时的新文档标题（如「1. Introduction（中文译文）」）。',
        },
        rationale: {
          type: 'string',
          maxLength: 500,
          description: '本次翻译、整理或修改的简明说明。',
        },
      },
      ['mode', 'content', 'rationale'],
    ),
  },
  {
    version: 1,
    name: 'library_search',
    description:
      '只读搜索本地文件库中的知识库文档与思维导图，返回标题、分类、类型（doc/mindmap）和相对路径。需要正文时再调用 library_read_document。',
    permission: 'read',
    inputSchema: schema(
      {
        query: { type: 'string', minLength: 1, maxLength: 120 },
        category: { type: 'string', maxLength: 200 },
      },
      ['query'],
    ),
  },
  {
    version: 1,
    name: 'library_read_document',
    description:
      '只读打开文件库中的任意一篇 Markdown 知识文档或思维导图。relativePath 应来自 library_search 或当前界面状态；可用 offset 分段读取较长内容。',
    permission: 'read',
    inputSchema: schema(
      {
        relativePath: { type: 'string', minLength: 1, maxLength: 1000 },
        offset: { type: 'integer', minimum: 0 },
      },
      ['relativePath'],
    ),
  },
  {
    version: 1,
    name: 'mindmap_propose_node_edit',
    description:
      '为当前思维导图提出节点改名、增删节点或编辑 Markdown/数学公式备注的提案。只能执行目标节点 allowedOperations 中允许的操作。必须使用 mindmap_get_current 返回的 revision；优先提供节点 nodeId，旧节点尚无持久 ID 时可使用 nodePath。set_note 的 text 最长 8,000 字符。此工具只生成预览，必须由用户确认后才会修改。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        baseRevision: { type: 'integer', minimum: 0 },
        nodeId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description:
            '目标节点的持久 ID；优先使用 mindmap_get_current 返回的 nodeId。',
        },
        nodePath: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            '仅当目标 nodeId 为空时使用；必须来自同一 revision 的节点快照。',
        },
        operation: {
          type: 'string',
          enum: ['rename', 'add_child', 'add_sibling', 'delete', 'set_note'],
        },
        text: {
          type: 'string',
          maxLength: MAX_MARKDOWN_NODE_NOTE_CHARS,
          description:
            '改名或新增时的节点文字；set_note 时为 Markdown 备注；delete 时传空字符串。',
        },
        rationale: { type: 'string', maxLength: 500 },
      },
      ['baseRevision', 'operation', 'text', 'rationale'],
    ),
  },
  {
    version: 1,
    name: 'mindmap_propose_node_branch',
    description:
      '在指定节点下生成一组 Markdown 标题层级作为子节点分支。节点标题尽量不超过 20 个汉字（英文 40 个字符）；每个标题或列表项保持单行，禁止在单个节点文字中手动插入换行；长解释用简短父节点加必要子节点表达，一个节点只放一个要点，保留关键条件和公式。数学公式不得放进标题或列表项标签：行内用 $...$，独立公式单独成段使用 $$...$$，每个公式块只放一个完整表达式且不在 LaTeX 内手动换行；推导按假设/定义、代入/变形、结论拆成短节点，每步最多一个公式。较长公式按等价变形分步，不得省略数学内容；静态推导使用 KaTeX，只有绘图或交互时才使用 seamind-math。analysisMode=drilldown 时按定义、起源、实际工程应用与意义、例子组织内容，理学主题按需包含推导，并提炼可迁移结构与元认知案例；analysisMode=visualization 时可用 Mermaid、echarts、python、svg、独立 html 代码块或 YouTube 链接，按主题选择适合的表达。必须基于 mindmap_get_current 的 revision 和目标 nodeId/nodePath。工具只返回预览提案，必须由用户确认后才会修改。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        baseRevision: { type: 'integer', minimum: 0 },
        nodeId: { type: 'string', minLength: 1, maxLength: 128 },
        nodePath: { type: 'string', minLength: 1, maxLength: 200 },
        analysisMode: { type: 'string', enum: ['drilldown', 'visualization'] },
        branchMarkdown: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_AGENT_BRANCH_CHARS,
          description:
            '以 Markdown 标题开头的子树内容；可在标题下包含说明、数学公式和支持的可视化代码块。',
        },
        rationale: { type: 'string', maxLength: 500 },
      },
      ['baseRevision', 'analysisMode', 'branchMarkdown', 'rationale'],
    ),
  },
  {
    version: 1,
    name: 'mindmap_propose_code_block',
    description:
      '为当前思维导图的指定节点插入一个可滑动浏览、全屏编辑与运行的代码块（mode=add_child），或精准替换修改已有代码块（mode=replace，通过 blockIndex 或 startLine/endLine 定位）。必须使用 mindmap_get_current 返回的 revision；只生成待确认 Diff 预览，用户确认后才会写入导图。',
    permission: 'user_approval',
    inputSchema: schema(
      {
        baseRevision: { type: 'integer', minimum: 0 },
        mode: { type: 'string', enum: ['add_child', 'replace'] },
        nodeId: { type: 'string', minLength: 1, maxLength: 128 },
        nodePath: { type: 'string', minLength: 1, maxLength: 200 },
        language: {
          type: 'string',
          minLength: 1,
          maxLength: 32,
          description:
            '代码语言，如 python、cpp、c、sql、typescript、bash 等。',
        },
        title: {
          type: 'string',
          maxLength: 120,
          description: '可选短标题（新增子节点时作为代码块父标题）。',
        },
        code: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MINDMAP_CODE_BLOCK_CHARS,
          description: '完整代码正文（不含外层 ``` 围栏）。',
        },
        blockIndex: {
          type: 'integer',
          minimum: 0,
          description:
            'mode=replace 时可传入 mindmap_get_current 中 codeBlocks 的 blockIndex。',
        },
        startLine: { type: 'integer', minimum: 0 },
        endLine: { type: 'integer', minimum: 0 },
        rationale: { type: 'string', maxLength: 500 },
      },
      ['baseRevision', 'mode', 'language', 'code', 'rationale'],
    ),
  },
  {
    version: 1,
    name: 'mindmap_run_code_block',
    description:
      '直接运行当前思维导图中的已有代码块（传入 blockIndex）或试跑一段 Python / C / C++ 验证代码（传入 language + code），返回 stdout/stderr、耗时与富输出摘要。若传入 blockIndex，运行结果还会直接嵌入显示在导图对应代码块下方。修改或生成可执行代码前可先试跑验证。',
    permission: 'read',
    inputSchema: schema({
      language: {
        type: 'string',
        enum: ['python', 'c', 'cpp'],
        description:
          '直接试跑代码时指定语言；若按 blockIndex 运行已有代码块可省略。',
      },
      code: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_MINDMAP_CODE_BLOCK_CHARS,
        description: '要试跑的源码；与 blockIndex 二选一。',
      },
      blockIndex: {
        type: 'integer',
        minimum: 0,
        description: '运行当前导图 codeBlocks 列表中的第 blockIndex 个代码块。',
      },
      stdinInput: { type: 'string', maxLength: 8_000 },
      runtime: {
        type: 'string',
        enum: ['pyodide', 'local'],
        description:
          'Python 运行时偏好：pyodide（沙盒）或 local（本机 Python/Conda，适合 requests/sqlite3 等三方包）。',
      },
    }),
  },
];

async function mindmap_get_current(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'mindmap_get_current';

  assertOnlyKeys(input, []);
  const current = capabilities.getCurrentMindmap();
  if (new TextEncoder().encode(current.markdown).byteLength > 250_000) {
    throw new Error(
      '当前导图超过 250 KB 的完整上下文上限；为避免静默截断，未返回部分导图。请拆分主题后重试。',
    );
  }
  return {
    version: 1,
    permission: 'read',
    name,
    label: '读取当前导图',
    summary: current.truncated
      ? `读取「${current.title}」的部分结构，当前快照包含 ${current.nodeCount} 个节点，结果已截断。`
      : `读取「${current.title}」，共 ${current.nodeCount} 个节点。`,
    result: current as unknown as Record<string, unknown>,
  };
}

async function knowledge_get_current_document(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'knowledge_get_current_document';
  assertOnlyKeys(input, ['offset', 'maxChars']);
  const offset =
    input.offset === undefined ? 0 : requireInteger(input, 'offset');
  const maxChars =
    input.maxChars === undefined
      ? MAX_TOOL_READ_CHARS
      : Math.max(500, Math.min(24_000, requireInteger(input, 'maxChars')));

  const current = capabilities.readCurrentKnowledgeDocument?.() ?? null;
  if (!current) {
    throw new Error(
      '当前知识库工作区尚未打开任何 Markdown 文档（可能停留在概览页）。请先在知识库打开一篇文档，或使用 library_search 检索目标文档。',
    );
  }
  const markdown = current.markdown ?? '';
  const totalChars = markdown.length;
  const totalLines = markdown ? markdown.split(/\r?\n/).length : 0;
  const start = Math.min(offset, totalChars);
  const content = markdown.slice(start, start + maxChars);
  const nextOffset = start + content.length;
  const headings = extractMarkdownHeadings(markdown);

  return {
    version: 1,
    permission: 'read',
    name,
    label: `读取当前知识库文档「${current.title}」`,
    summary: `已读取「${current.title}」(${start}–${nextOffset} / ${totalChars} 字，共 ${totalLines} 行)`,
    result: {
      document: {
        title: current.title,
        relativePath: current.relativePath,
        category: current.category,
        kind: current.kind,
        dirty: Boolean(current.dirty),
      },
      totalChars,
      totalLines,
      offset: start,
      content,
      nextOffset: nextOffset < totalChars ? nextOffset : null,
      headings,
      ...(current.openTabs && current.openTabs.length > 0
        ? { openTabs: current.openTabs }
        : {}),
    },
  };
}

async function knowledge_propose_document_edit(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'knowledge_propose_document_edit';
  assertOnlyKeys(input, ['mode', 'content', 'newTitle', 'rationale']);
  const mode = input.mode;
  if (mode !== 'create_copy' && mode !== 'append' && mode !== 'replace') {
    throw new Error('mode 仅支持 create_copy、append 或 replace。');
  }
  const content = requireText(
    input,
    'content',
    MAX_KNOWLEDGE_DOC_PROPOSAL_CHARS,
    1,
  );
  const newTitle = optionalString(input, 'newTitle', 180);
  const rationale = requireString(input, 'rationale', 500, 1);

  const current = capabilities.readCurrentKnowledgeDocument?.() ?? null;
  if (!current && mode !== 'create_copy') {
    throw new Error(
      '当前知识库没有打开中的目标文档，无法执行替换或追加；请改用 mode="create_copy" 新建文档。',
    );
  }

  const targetTitle = current?.title || newTitle || '知识库文档';
  const targetCategory = current?.category || '知识笔记';
  const resolvedNewTitle =
    mode === 'create_copy' ? newTitle || `${targetTitle}（整理版）` : undefined;

  const proposal: KnowledgeDocumentEditProposal = {
    mode: mode as KnowledgeDocumentEditMode,
    targetRelativePath: current?.relativePath ?? null,
    targetTitle,
    targetCategory,
    ...(resolvedNewTitle ? { newTitle: resolvedNewTitle } : {}),
    content,
    rationale,
  };

  return {
    version: 1,
    permission: 'user_approval',
    name,
    label:
      mode === 'create_copy'
        ? `新建知识库文档「${resolvedNewTitle}」`
        : mode === 'append'
          ? `向「${targetTitle}」追加内容`
          : `更新知识库文档「${targetTitle}」`,
    summary: `已生成 ${content.length.toLocaleString()} 字文档变更预览，等待确认写入。`,
    result: {
      status: 'awaiting_user_approval',
      mode,
      targetTitle,
      targetRelativePath: proposal.targetRelativePath,
      ...(resolvedNewTitle ? { newTitle: resolvedNewTitle } : {}),
      chars: content.length,
    },
    knowledgeDocumentProposal: proposal,
  };
}

async function library_search(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'library_search';

  assertOnlyKeys(input, ['query', 'category']);
  const query = requireString(input, 'query', 120);
  const category =
    input.category === undefined
      ? undefined
      : requireString(input, 'category', 200, 0);
  const documents = await capabilities.searchLibrary(query, category);
  const results = documents.slice(0, MAX_SEARCH_RESULTS).map((document) => ({
    title: document.title,
    category: document.category,
    kind: document.kind,
    mapType: document.mapType,
    relativePath: document.relativePath,
    updatedAt: document.updatedAt,
  }));
  return {
    version: 1,
    permission: 'read',
    name,
    label: '搜索文件库',
    summary: `找到 ${results.length} 篇相关知识文档/导图。`,
    result: { results, truncated: documents.length > results.length },
  };
}

async function library_read_document(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'library_read_document';

  assertOnlyKeys(input, ['relativePath', 'offset']);
  const relativePath = requireString(input, 'relativePath', 1000);
  const offset =
    input.offset === undefined ? 0 : requireInteger(input, 'offset');
  const opened = await capabilities.readDocument(relativePath);
  const result = previewDocument(opened, offset);
  return {
    version: 1,
    permission: 'read',
    name,
    label: `读取文档「${opened.document.title}」`,
    summary: `读取 ${result.offset}–${result.offset + result.content.length} / ${result.totalChars} 字符。`,
    result,
  };
}

async function mindmap_propose_node_edit(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'mindmap_propose_node_edit';

  assertOnlyKeys(input, [
    'baseRevision',
    'nodeId',
    'nodePath',
    'operation',
    'text',
    'rationale',
  ]);
  const operation = input.operation;
  if (
    operation !== 'rename' &&
    operation !== 'add_child' &&
    operation !== 'add_sibling' &&
    operation !== 'delete' &&
    operation !== 'set_note'
  ) {
    throw new Error('操作类型不受支持。');
  }
  const nodeId =
    input.nodeId === undefined
      ? undefined
      : requireString(input, 'nodeId', 128);
  const nodePath =
    input.nodePath === undefined
      ? undefined
      : requireString(input, 'nodePath', 200);
  if (!nodeId && !nodePath) throw new Error('必须提供 nodeId 或 nodePath。');
  const proposal = capabilities.proposeNodeEdit({
    baseRevision: requireInteger(input, 'baseRevision'),
    nodeId,
    nodePath,
    operation: operation as Exclude<
      NodeEditOperation,
      'add_branch' | 'add_code_block' | 'update_code_block'
    >,
    text: requireText(
      input,
      'text',
      operation === 'set_note' ? MAX_MARKDOWN_NODE_NOTE_CHARS : 300,
      operation === 'delete' || operation === 'set_note' ? 0 : 1,
    ),
    rationale: requireString(input, 'rationale', 500, 0),
  });
  return {
    version: 1,
    permission: 'user_approval',
    name,
    label: '提出节点修改',
    summary:
      proposal.operation === 'rename'
        ? `将「${proposal.previousLabel}」改为「${proposal.nextLabel}」，等待你确认。`
        : proposal.operation === 'add_child'
          ? `在「${proposal.previousLabel}」下添加「${proposal.nextLabel}」，等待你确认。`
          : proposal.operation === 'add_sibling'
            ? `在「${proposal.previousLabel}」旁添加「${proposal.nextLabel}」，等待你确认。`
            : proposal.operation === 'delete'
              ? `删除「${proposal.previousLabel}」及其子节点，等待你确认。`
              : `更新「${proposal.previousLabel}」的备注，等待你确认。`,
    result: {
      status: 'awaiting_user_approval',
      nodeId: proposal.nodeId,
      nodePath: proposal.nodePath,
      operation: proposal.operation,
      previousLabel: proposal.previousLabel,
      nextLabel: proposal.nextLabel,
      previousNote: proposal.previousNote,
      nextNote: proposal.nextNote,
      rationale: proposal.rationale,
    },
    proposal,
  };
}

async function mindmap_propose_node_branch(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'mindmap_propose_node_branch';

  assertOnlyKeys(input, [
    'baseRevision',
    'nodeId',
    'nodePath',
    'analysisMode',
    'branchMarkdown',
    'rationale',
  ]);
  const analysisMode = input.analysisMode;
  if (analysisMode !== 'drilldown' && analysisMode !== 'visualization') {
    throw new Error('分析模式不受支持。');
  }
  const nodeId =
    input.nodeId === undefined
      ? undefined
      : requireString(input, 'nodeId', 128);
  const nodePath =
    input.nodePath === undefined
      ? undefined
      : requireString(input, 'nodePath', 200);
  if (!nodeId && !nodePath) throw new Error('必须提供 nodeId 或 nodePath。');
  const proposal = await capabilities.proposeNodeBranch({
    baseRevision: requireInteger(input, 'baseRevision'),
    nodeId,
    nodePath,
    analysisMode,
    branchMarkdown: requireText(
      input,
      'branchMarkdown',
      MAX_AGENT_BRANCH_CHARS,
      1,
    ),
    rationale: requireString(input, 'rationale', 500, 0),
  });
  const modeLabel = analysisMode === 'drilldown' ? '节点下探' : '可视化分析';
  return {
    version: 1,
    permission: 'user_approval',
    name,
    label: `预览${modeLabel}分支`,
    summary: `为「${proposal.previousLabel}」生成${modeLabel}分支，等待你确认。`,
    result: {
      status: 'awaiting_user_approval',
      nodeId: proposal.nodeId,
      nodePath: proposal.nodePath,
      analysisMode,
      previousLabel: proposal.previousLabel,
      nextLabel: proposal.nextLabel,
      rationale: proposal.rationale,
      htmlAssetCount: proposal.htmlAssets?.length || 0,
    },
    proposal,
  };
}

async function mindmap_propose_code_block(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'mindmap_propose_code_block';
  assertOnlyKeys(input, [
    'baseRevision',
    'mode',
    'nodeId',
    'nodePath',
    'language',
    'title',
    'code',
    'blockIndex',
    'startLine',
    'endLine',
    'rationale',
  ]);
  const mode = input.mode;
  if (mode !== 'add_child' && mode !== 'replace') {
    throw new Error('mode 必须为 add_child 或 replace。');
  }
  if (!capabilities.proposeCodeBlock) {
    throw new Error('当前工作区暂未挂载代码块提案能力。');
  }
  const nodeId =
    input.nodeId === undefined
      ? undefined
      : requireString(input, 'nodeId', 128);
  const nodePath =
    input.nodePath === undefined
      ? undefined
      : requireString(input, 'nodePath', 200);
  if (mode === 'add_child' && !nodeId && !nodePath) {
    throw new Error('新增代码块时必须提供 nodeId 或 nodePath。');
  }
  const blockIndex =
    input.blockIndex === undefined
      ? undefined
      : requireInteger(input, 'blockIndex');
  const startLine =
    input.startLine === undefined
      ? undefined
      : requireInteger(input, 'startLine');
  const endLine =
    input.endLine === undefined ? undefined : requireInteger(input, 'endLine');
  if (
    mode === 'replace' &&
    blockIndex === undefined &&
    startLine === undefined
  ) {
    throw new Error('替换代码块时必须提供 blockIndex 或 startLine。');
  }
  const language = requireString(input, 'language', 32);
  const title =
    input.title === undefined
      ? undefined
      : requireString(input, 'title', 120, 0);
  const code = requireText(input, 'code', MAX_MINDMAP_CODE_BLOCK_CHARS, 1);
  const rationale = requireString(input, 'rationale', 500, 0);

  const proposal = capabilities.proposeCodeBlock({
    baseRevision: requireInteger(input, 'baseRevision'),
    mode,
    nodeId,
    nodePath,
    language,
    title,
    code,
    blockIndex,
    startLine,
    endLine,
    rationale,
  });

  return {
    version: 1,
    permission: 'user_approval',
    name,
    label: mode === 'replace' ? '提案更新代码块' : '提案插入代码块',
    summary:
      mode === 'replace'
        ? `更新 ${language.toUpperCase()} 代码块「${proposal.nextLabel}」，等待你确认。`
        : `在「${proposal.previousLabel}」下插入 ${language.toUpperCase()} 代码块，等待你确认。`,
    result: {
      status: 'awaiting_user_approval',
      mode,
      language,
      nodeId: proposal.nodeId,
      nodePath: proposal.nodePath,
      previousLabel: proposal.previousLabel,
      nextLabel: proposal.nextLabel,
      rationale: proposal.rationale,
    },
    proposal,
  };
}

async function mindmap_run_code_block(
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const name = 'mindmap_run_code_block';
  assertOnlyKeys(input, [
    'language',
    'code',
    'blockIndex',
    'stdinInput',
    'runtime',
  ]);
  if (!capabilities.runMindmapCodeBlock) {
    throw new Error('当前工作区暂未挂载导图代码块运行引擎。');
  }
  const language =
    input.language === undefined
      ? undefined
      : (requireString(input, 'language', 16) as 'python' | 'c' | 'cpp');
  if (
    language !== undefined &&
    language !== 'python' &&
    language !== 'c' &&
    language !== 'cpp'
  ) {
    throw new Error('language 仅支持 python、c 或 cpp。');
  }
  const code =
    input.code === undefined
      ? undefined
      : requireText(input, 'code', MAX_MINDMAP_CODE_BLOCK_CHARS, 1);
  const blockIndex =
    input.blockIndex === undefined
      ? undefined
      : requireInteger(input, 'blockIndex');
  if (blockIndex === undefined && !code) {
    throw new Error(
      '请传入 blockIndex（运行导图已有代码块）或 code（试跑源码）。',
    );
  }
  const stdinInput =
    input.stdinInput === undefined
      ? undefined
      : requireText(input, 'stdinInput', 8_000, 0);
  const runtime =
    input.runtime === undefined
      ? undefined
      : (requireString(input, 'runtime', 16) as 'pyodide' | 'local');
  if (runtime !== undefined && runtime !== 'pyodide' && runtime !== 'local') {
    throw new Error('runtime 仅支持 pyodide 或 local。');
  }

  const execResult = await capabilities.runMindmapCodeBlock({
    language,
    code,
    blockIndex,
    stdinInput,
    runtime,
  });
  const ok = execResult.ok === true;
  const runtimeLabel =
    typeof execResult.runtimeLabel === 'string'
      ? execResult.runtimeLabel
      : language || 'code';
  return {
    version: 1,
    permission: 'read',
    name,
    label:
      blockIndex !== undefined
        ? `运行导图代码块 #${blockIndex}`
        : `试跑 ${(language || 'python').toUpperCase()} 代码`,
    summary: ok ? `${runtimeLabel} 执行成功` : `${runtimeLabel} 执行出错`,
    result: execResult,
  };
}

export const mindmapHandlers = {
  mindmap_get_current,
  knowledge_get_current_document,
  knowledge_propose_document_edit,
  library_search,
  library_read_document,
  mindmap_propose_node_edit,
  mindmap_propose_node_branch,
  mindmap_propose_code_block,
  mindmap_run_code_block,
};
