import type { MapDocument, OpenedDocument } from '../library';
import { MAX_MARKDOWN_NODE_NOTE_CHARS } from '../mindmap/commands';
import type {
  ActiveMindmapSnapshot,
  AgentToolDefinition,
  AgentToolDescriptor,
  NodeEditOperation,
  NodeEditProposal,
} from './types';

export interface ProposeNodeEditInput {
  baseRevision: number;
  nodeId?: string;
  nodePath?: string;
  operation: NodeEditOperation;
  text: string;
  rationale: string;
}

export interface AgentCapabilities {
  getCurrentMindmap(): ActiveMindmapSnapshot;
  searchLibrary(query: string, category?: string): Promise<MapDocument[]>;
  readDocument(relativePath: string): Promise<OpenedDocument>;
  proposeNodeEdit(input: ProposeNodeEditInput): NodeEditProposal;
}

export interface AgentToolResult {
  version: 1;
  permission: 'read' | 'user_approval';
  name: string;
  label: string;
  summary: string;
  result: Record<string, unknown>;
  proposal?: NodeEditProposal;
}

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const agentToolCatalog: AgentToolDescriptor[] = [
  {
    version: 1,
    name: 'mindmap_get_current',
    description:
      '读取当前打开的思维导图结构和节点 Markdown 备注。每个节点包含持久 nodeId（旧节点可能为空）、allowedOperations 和 noteTruncated；只对 allowedOperations 中列出的操作提出修改。节点路径只在返回的 revision 版本内有效；快照若 truncated 为 true，表示只返回了部分节点。修改前必须先调用此工具。',
    permission: 'read',
    inputSchema: schema({}),
  },
  {
    version: 1,
    name: 'library_search',
    description:
      '只读搜索本地文件库中的思维导图，返回标题、分类和相对路径。需要正文时再调用 library_read_document。',
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
      '只读打开文件库中的一个 Markdown 思维导图。relativePath 应来自 library_search；可用 offset 分段读取较长内容。',
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
];

export const agentTools: AgentToolDefinition[] = agentToolCatalog.map(
  ({ name, description, inputSchema }) => ({
    type: 'function',
    function: { name, description, parameters: inputSchema },
  }),
);

const MAX_TOOL_READ_CHARS = 12_000;
const MAX_SEARCH_RESULTS = 8;

function parseObject(raw: string): Record<string, unknown> {
  if (raw.length > 20_000) throw new Error('工具参数过长。');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('工具参数不是有效 JSON。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('工具参数必须是 JSON 对象。');
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  input: Record<string, unknown>,
  allowed: string[],
): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`不支持的参数：${unexpected}`);
}

function requireString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
  minLength = 1,
): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是文本。`);
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new Error(
      `参数 ${key} 长度必须为 ${minLength} 到 ${maxLength} 个字符。`,
    );
  }
  return normalized;
}

function requireText(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
  minLength = 0,
): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是文本。`);
  if (value.trim().length < minLength || value.length > maxLength) {
    throw new Error(
      `参数 ${key} 长度必须为 ${minLength} 到 ${maxLength} 个字符。`,
    );
  }
  return value;
}

function requireInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`参数 ${key} 必须是非负整数。`);
  }
  return value as number;
}

function previewDocument(opened: OpenedDocument, offset: number) {
  const markdown = opened.markdown;
  const start = Math.min(offset, markdown.length);
  const content = markdown.slice(start, start + MAX_TOOL_READ_CHARS);
  const nextOffset = start + content.length;
  return {
    document: {
      title: opened.document.title,
      category: opened.document.category,
      relativePath: opened.document.relativePath,
    },
    totalChars: markdown.length,
    offset: start,
    content,
    nextOffset: nextOffset < markdown.length ? nextOffset : null,
  };
}

export async function executeAgentTool(
  name: string,
  rawArguments: string,
  capabilities: AgentCapabilities,
): Promise<AgentToolResult> {
  const input = parseObject(rawArguments);

  if (name === 'mindmap_get_current') {
    assertOnlyKeys(input, []);
    const current = capabilities.getCurrentMindmap();
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

  if (name === 'library_search') {
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
      mapType: document.mapType,
      relativePath: document.relativePath,
      updatedAt: document.updatedAt,
    }));
    return {
      version: 1,
      permission: 'read',
      name,
      label: '搜索文件库',
      summary: `找到 ${results.length} 个相关导图。`,
      result: { results, truncated: documents.length > results.length },
    };
  }

  if (name === 'library_read_document') {
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
      label: `读取导图「${opened.document.title}」`,
      summary: `读取 ${result.offset}–${result.offset + result.content.length} / ${result.totalChars} 字符。`,
      result,
    };
  }

  if (name === 'mindmap_propose_node_edit') {
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
      operation: operation as NodeEditOperation,
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

  throw new Error(`模型请求了未注册的工具：${name}`);
}
