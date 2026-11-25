import type { TerminalAgentEngineMode } from './terminal-types';

export interface TerminalSlashCommandSpec {
  id: string;
  command: string;
  title: string;
  description: string;
  hint: string;
  directLocal?: boolean;
}

export interface TerminalMentionSpec {
  id: string;
  token: string;
  label: string;
  description: string;
  category:
    'book' | 'kb' | 'map' | 'exam' | 'player' | 'paper' | 'rss' | 'pane';
}

export interface TerminalAutocompleteCandidate {
  key: string;
  insertText: string;
  badge: string;
  title: string;
  subtitle: string;
}

export interface TerminalAutocompleteMatch {
  kind: 'slash' | 'mention';
  query: string;
  replaceStart: number;
  replaceEnd: number;
  candidates: TerminalAutocompleteCandidate[];
}

export interface ParsedAgentMention {
  raw: string;
  tag: string;
  arg?: string;
}

export interface ParsedTerminalAgentInput {
  raw: string;
  slashCommand: string | null;
  argsText: string;
  mentions: ParsedAgentMention[];
  body: string;
}

export interface TerminalApiPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  requiresKey: boolean;
}

export const TERMINAL_API_PRESETS: TerminalApiPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    requiresKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama 本地 (免密钥)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    requiresKey: false,
  },
  {
    id: 'custom',
    label: '当前全局设置',
    baseUrl: '',
    defaultModel: '',
    requiresKey: true,
  },
];

export const TERMINAL_ENGINE_SPECS: Array<{
  id: TerminalAgentEngineMode;
  badge: string;
  label: string;
  description: string;
}> = [
  {
    id: 'hybrid',
    badge: 'HYBRID',
    label: '混合协同 (API 统筹 × CLI 套娃)',
    description:
      '主对话使用 Seamind API 模型调度全软件工具，并可自动调用 cli_delegate 委派本机 Claude / Codex / AGY 协同执行。',
  },
  {
    id: 'api',
    badge: 'API',
    label: '直连大模型 API',
    description:
      '使用 OpenAI 兼容 / DeepSeek / Ollama 接口与 Seamind 工具链直接对话。',
  },
  {
    id: 'cli:claude',
    badge: 'CLAUDE',
    label: 'Claude Code CLI 内核',
    description:
      '直接无头运行本机 claude CLI，自动反向注入 Seamind MCP 工具并实时流式回传。',
  },
  {
    id: 'cli:codex',
    badge: 'CODEX',
    label: 'OpenAI Codex CLI 内核',
    description: '直接无头运行本机 codex CLI，擅长代码实验、排错与工作区操作。',
  },
  {
    id: 'cli:agy',
    badge: 'AGY',
    label: 'Antigravity CLI 内核',
    description:
      '调用本机 agy CLI，支持自由切换谷歌/多厂商模型并自动挂载 Seamind Data Lab MCP。',
  },
  {
    id: 'cli:gemini',
    badge: 'GEMINI',
    label: 'Google Gemini CLI 内核',
    description:
      '调用本机 gemini CLI，支持切换 Gemini 2.5 / 3 系列模型并自动挂载 Seamind MCP。',
  },
];

/**
 * Strict integer pixel-grid matrix (22 cols × 15 rows) for the metallic open-book + `>_` CLI emblem.
 * Palette codes:
 *  '.' = transparent
 *  'C' = Specular Chrome Highlight (#F8FAFC)
 *  'T' = Brushed Titanium Light (#CBD5E1)
 *  'S' = Forged Steel Midtone (#94A3B8)
 *  'I' = Dark Iron Etching / Fold (#64748B)
 *  'G' = Deep Gunmetal Spine & Shadow (#334155)
 *  'B' = Tempered Bronze Cover Rim (#D97757)
 *  'A' = Specular Amber Gold Rune & Clasp (#F59E0B)
 */
export const METALLIC_BOOK_PIXEL_GRID: readonly string[] = [
  '..BTTTTTB....BTTTTTB..',
  '.BCCCCCCTB..BTCCCCCCB.',
  'BCTTTTTTSIBBISTTTTTTCB',
  'BCTTAATTSIGGISTTIIITCB',
  'BCTTTAATSIGGISTTTTTTCB',
  'BCTTTTAASIGGISTTIIITCB',
  'BCTTTAATSIGGISTTTTTTCB',
  'BCTTAATTSIGGISTACCCACB',
  'BCSSSSSSSIAAISSSSSSSCB',
  'BCSSSSSSIGGGGISSSSSSCB',
  'BBIISSSIGGBBGGISSSIIBB',
  '.BBCCCCCIGBBGICCCCCBB.',
  '..BBSSSSSGAAGSSSSSBB..',
  '...BBBBBBBAABBBBBBB...',
  '.....GGGGGGGGGGGG.....',
];

export const METALLIC_BOOK_PALETTE: Record<string, string> = {
  C: '#F8FAFC',
  T: '#CBD5E1',
  S: '#94A3B8',
  I: '#64748B',
  G: '#334155',
  B: '#D97757',
  A: '#F59E0B',
};

/**
 * Pixel dot-matrix open-book + `>_` emblem matching Seamind Book-Terminal TUI aesthetic.
 */
export const DOT_MATRIX_BOOK_SPLASH = [
  '               ·:░░░░░░░░░░░░:·               ',
  '           ·░▒▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒░·           ',
  '        ·░▒▓▓▓                  ▓▓▓▒░·        ',
  '      ·░▒▓▓     ░░░··              ▓▓▒░·      ',
  '     ·░▒▓        ▒▒░░·               ▓▒░·     ',
  '    ·░▒▓          ▒▓▒▒░·             ▓▒░·    ',
  '    ·▒▓            ·░▓▒▓   ▓▓▓▓▓▓▓    ▓▒·    ',
  '    ·▒▓          ·░▓▓▓`    ▒▒▒▒▒▒▒    ▓▒·    ',
  '    ·░▒▓       ·░▓▒▓`                ▓▒░·    ',
  '     ·░▒▓     ·░▓▒`                 ▓▒░·     ',
  '      ·░▒▓▓    ░░░░░░·  ·░░░░░░    ▓▓▒░·      ',
  '        ·░▒▓▓▓  ▒▒▒▒▒▒▓▓▒▒▒▒▒▒  ▓▓▓▒░·        ',
  '           ·░▒▒▓▓▓▓▓▒░  ░▒▓▓▓▓▓▒▒░·           ',
  '               ·:░░░░░  ░░░░░:·               ',
]
  .map((line) => line.padEnd(46, ' '))
  .join('\n');

export const TERMINAL_SLASH_COMMANDS: TerminalSlashCommandSpec[] = [
  {
    id: 'book',
    command: '/book',
    title: '电子书伴读与结构抽取',
    description: '读取当前阅读章节、书籍目录或提问书中内容并直接打开阅读器',
    hint: '/book 解析当前章节核心推导',
  },
  {
    id: 'kb',
    command: '/kb',
    title: '知识库笔记读写联动',
    description: '检索、总结或追加笔记到 Obsidian / Markdown 知识库',
    hint: '/kb 检索计算机网络笔记并总结',
  },
  {
    id: 'map',
    command: '/map',
    title: '思维导图读取与下探提案',
    description: '分析当前导图或生成节点下探预览卡片',
    hint: '/map 为当前节点展开工程案例分支',
  },
  {
    id: 'exam',
    command: '/exam',
    title: '试卷中心与错题诊断',
    description: '查看已有 EPUB 试卷、得分情况并剖析错题',
    hint: '/exam 列出待复习试卷并总结薄弱点',
  },
  {
    id: 'player',
    command: '/player',
    title: '双螺旋视频学习路径',
    description: '查看现有视频路线、搜索名校课程与规划学习星图',
    hint: '/player 查找操作系统 MIT 6.828 课程路线',
  },
  {
    id: 'paper',
    command: '/paper',
    title: '论文文献库检索',
    description: '搜索本地收集论文的标题、摘要与个人批注',
    hint: '/paper 检索 Transformer 相关论文笔记',
  },
  {
    id: 'rss',
    command: '/rss',
    title: 'RSS 订阅阅读分析',
    description: '读取当前订阅文章与关注频道列表',
    hint: '/rss 提炼当前 RSS 文章核心观点',
  },
  {
    id: 'data',
    command: '/data',
    title: '数据分析 · SQL / CSV / Parquet / Anaconda / R',
    description:
      '自动读取当前挂载的数据文件、数据库连接、Anaconda/R 环境与实验本内容，执行分析并直接生成表格/单元格',
    hint: '/data 读取当前挂载的数据文件并做分组汇总表',
  },
  {
    id: 'mcp',
    command: '/mcp',
    title: '查看 Seamind MCP 接入通道状态',
    description:
      '查看当前已注册给内置 Agent 与 Claude/Codex/AGY CLI 的 MCP 工具清单与连接地址',
    hint: '/mcp',
    directLocal: true,
  },
  {
    id: 'code',
    command: '/code',
    title: '推送/运行 Python 或 C/C++ 实验',
    description:
      '执行 Python / GCC 代码片段，或直接在右侧打开 Euporie Code Lab',
    hint: '/code python 验证快速傅里叶变换示例',
  },
  {
    id: 'exec',
    command: '/exec',
    title: '协同同屏终端窗格执行与诊断',
    description: '读取 #pane 输出或生成命令待确认发送到右侧 Shell 窗格',
    hint: '/exec 检查当前目录 Git 与 Python 环境',
  },
  {
    id: 'model',
    command: '/model',
    title: '切换模型内核 / 套娃调度模式',
    description:
      '支持 API / Claude CLI / Codex CLI / AGY CLI / Hybrid 混合架构',
    hint: '/model hybrid | /model cli:claude | /model api',
    directLocal: true,
  },
  {
    id: 'compact',
    command: '/compact',
    title: '压缩对话上下文',
    description: '立即折叠早期工具返回内容，节省上下文 Token 预算',
    hint: '/compact',
    directLocal: true,
  },
  {
    id: 'clear',
    command: '/clear',
    title: '清空会话屏幕',
    description: '重绘书籍点阵欢迎屏并重置对话历史',
    hint: '/clear',
    directLocal: true,
  },
  {
    id: 'help',
    command: '/help',
    title: '显示 /## 协议速查手册',
    description: '打印所有斜杠命令与 # 资源引用用法',
    hint: '/help',
    directLocal: true,
  },
];

export const TERMINAL_RESOURCE_MENTIONS: TerminalMentionSpec[] = [
  {
    id: 'book',
    token: '#book',
    label: '当前书架与 EPUB',
    description: '注入书库中匹配的书籍列表或当前阅读书籍信息',
    category: 'book',
  },
  {
    id: 'chapter',
    token: '#chapter',
    label: '当前 EPUB 章节正文',
    description: '自动抽取阅读器当前所在章节（含选中文本）',
    category: 'book',
  },
  {
    id: 'kb',
    token: '#kb',
    label: '知识库 Markdown 文档',
    description: '引用匹配的知识库笔记或当前打开的文档上下文',
    category: 'kb',
  },
  {
    id: 'map',
    token: '#map',
    label: '当前思维导图',
    description: '引用当前导图标题与目录结构',
    category: 'map',
  },
  {
    id: 'exam',
    token: '#exam',
    label: '试卷中心记录',
    description: '注入当前 EPUB 测验试卷与错题统计',
    category: 'exam',
  },
  {
    id: 'video',
    token: '#video',
    label: '视频学习路径与收藏',
    description: '注入当前播放器学习路线概览',
    category: 'player',
  },
  {
    id: 'paper',
    token: '#paper',
    label: '文献论文库',
    description: '注入已保存论文清单与阅读状态',
    category: 'paper',
  },
  {
    id: 'rss',
    token: '#rss',
    label: 'RSS 订阅动态',
    description: '注入当前打开的 RSS 文章与频道列表',
    category: 'rss',
  },
  {
    id: 'data',
    token: '#data',
    label: '当前挂载的数据文件与数据库连接',
    description:
      '注入左侧「数据」面板中的 CSV/Parquet/JSON 文件路径、字段 Schema 与 SQLite/DuckDB/PG/MySQL 连接',
    category: 'pane',
  },
  {
    id: 'env',
    token: '#env',
    label: '本地 Anaconda / Python 与 R 运行环境',
    description: '注入已检测到的 Conda 环境、R 解释器路径及已安装数据科学包',
    category: 'pane',
  },
  {
    id: 'lab',
    token: '#lab',
    label: '当前打开的实验本全部单元格与表格输出',
    description: '完整注入当前 Code Lab 窗口中的代码格、SQL 与运行结果表',
    category: 'pane',
  },
  {
    id: 'last-error',
    token: '#last-error',
    label: '最近终端/代码报错输出',
    description: '自动抓取同屏终端窗格或 Code Lab 的尾部错误信息',
    category: 'pane',
  },
  {
    id: 'pane-1',
    token: '#pane:1',
    label: '窗格 #1 实时屏幕输出',
    description: '读取分屏第 1 窗格的终端缓冲区内容与路径',
    category: 'pane',
  },
  {
    id: 'pane-2',
    token: '#pane:2',
    label: '窗格 #2 实时屏幕输出',
    description: '读取分屏第 2 窗格的终端缓冲区内容与路径',
    category: 'pane',
  },
  {
    id: 'pane-3',
    token: '#pane:3',
    label: '窗格 #3 实时屏幕输出',
    description: '读取分屏第 3 窗格的终端缓冲区内容与路径',
    category: 'pane',
  },
  {
    id: 'pane-4',
    token: '#pane:4',
    label: '窗格 #4 实时屏幕输出',
    description: '读取分屏第 4 窗格的终端缓冲区内容与路径',
    category: 'pane',
  },
];

export function parseTerminalAgentInput(raw: string): ParsedTerminalAgentInput {
  const trimmed = raw.trim();
  let slashCommand: string | null = null;
  let rest = trimmed;

  const slashMatch = /^(\/[a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (slashMatch) {
    slashCommand = slashMatch[1].toLowerCase();
    rest = (slashMatch[2] ?? '').trim();
  }

  const mentions: ParsedAgentMention[] = [];
  const seen = new Set<string>();
  const mentionRe = /(?:^|\s)(#([a-zA-Z0-9\u4e00-\u9fa5_-]+)(?::([^\s#]+))?)/g;
  for (const match of trimmed.matchAll(mentionRe)) {
    const full = match[1];
    if (seen.has(full)) continue;
    seen.add(full);
    mentions.push({
      raw: full,
      tag: `#${match[2].toLowerCase()}`,
      arg: match[3],
    });
  }

  return {
    raw: trimmed,
    slashCommand,
    argsText: rest,
    mentions,
    body: rest,
  };
}

export function detectTriggerAutocomplete(
  input: string,
  caret: number,
  dynamicResources: {
    books?: Array<{ title: string }>;
    documents?: Array<{ title: string }>;
  } = {},
): TerminalAutocompleteMatch | null {
  const clampedCaret = Math.max(0, Math.min(caret, input.length));
  const before = input.slice(0, clampedCaret);

  // Find current token bounds backwards until whitespace or newline
  let tokenStart = clampedCaret;
  while (tokenStart > 0 && !/\s/.test(before[tokenStart - 1])) {
    tokenStart -= 1;
  }
  const token = before.slice(tokenStart);
  if (!token) return null;

  if (token.startsWith('/') && tokenStart === 0) {
    const query = token.slice(1).toLowerCase();
    const matched = TERMINAL_SLASH_COMMANDS.filter(
      (item) =>
        !query ||
        item.id.includes(query) ||
        item.title.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query),
    ).sort((a, b) => {
      const aPrefix = a.id.startsWith(query) ? 0 : 1;
      const bPrefix = b.id.startsWith(query) ? 0 : 1;
      return aPrefix - bPrefix;
    });
    const candidates: TerminalAutocompleteCandidate[] = matched.map((item) => ({
      key: `cmd:${item.id}`,
      insertText: `${item.command} `,
      badge: 'CMD',
      title: item.command,
      subtitle: `${item.title} — ${item.description}`,
    }));
    if (candidates.length === 0) return null;
    return {
      kind: 'slash',
      query,
      replaceStart: tokenStart,
      replaceEnd: clampedCaret,
      candidates,
    };
  }

  if (token.startsWith('#')) {
    const query = token.slice(1).toLowerCase();
    const staticMatches: TerminalAutocompleteCandidate[] =
      TERMINAL_RESOURCE_MENTIONS.filter(
        (item) =>
          !query ||
          item.token.slice(1).toLowerCase().includes(query) ||
          item.label.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query),
      ).map((item) => ({
        key: `mention:${item.id}`,
        insertText: `${item.token} `,
        badge: item.category.toUpperCase(),
        title: item.token,
        subtitle: `${item.label} · ${item.description}`,
      }));

    const extraBooks: TerminalAutocompleteCandidate[] = [];
    if (query.startsWith('book:') || query.length >= 1) {
      const bookQuery = query.startsWith('book:') ? query.slice(5) : query;
      for (const b of dynamicResources.books ?? []) {
        if (!bookQuery || b.title.toLowerCase().includes(bookQuery)) {
          const safeName = b.title.replace(/\s+/g, '_').slice(0, 28);
          extraBooks.push({
            key: `dyn-book:${b.title}`,
            insertText: `#book:${safeName} `,
            badge: 'EPUB',
            title: `#book:${safeName}`,
            subtitle: `电子书：《${b.title}》`,
          });
        }
        if (extraBooks.length >= 4) break;
      }
    }

    const extraDocs: TerminalAutocompleteCandidate[] = [];
    if (query.startsWith('kb:') || query.length >= 1) {
      const docQuery = query.startsWith('kb:') ? query.slice(3) : query;
      for (const d of dynamicResources.documents ?? []) {
        if (!docQuery || d.title.toLowerCase().includes(docQuery)) {
          const safeTitle = d.title.replace(/\s+/g, '_').slice(0, 28);
          extraDocs.push({
            key: `dyn-doc:${d.title}`,
            insertText: `#kb:${safeTitle} `,
            badge: 'NOTE',
            title: `#kb:${safeTitle}`,
            subtitle: `知识文档：${d.title}`,
          });
        }
        if (extraDocs.length >= 4) break;
      }
    }

    const candidates = [...staticMatches, ...extraBooks, ...extraDocs].slice(
      0,
      12,
    );
    if (candidates.length === 0) return null;
    return {
      kind: 'mention',
      query,
      replaceStart: tokenStart,
      replaceEnd: clampedCaret,
      candidates,
    };
  }

  return null;
}

export function applyAutocompleteCandidate(
  input: string,
  match: TerminalAutocompleteMatch,
  candidate: TerminalAutocompleteCandidate,
): { nextValue: string; nextCaret: number } {
  const before = input.slice(0, match.replaceStart);
  const after = input.slice(match.replaceEnd);
  const nextValue = `${before}${candidate.insertText}${after}`;
  const nextCaret = before.length + candidate.insertText.length;
  return { nextValue, nextCaret };
}

export interface PromptEntitySegment {
  kind: 'text' | 'slash' | 'mention';
  value: string;
}

/**
 * Splits a prompt string into text, leading /command, and inline #resource mentions
 * so the Book-Terminal UI can highlight structured tokens distinctly.
 */
export function tokenizePromptEntities(input: string): PromptEntitySegment[] {
  const segments: PromptEntitySegment[] = [];
  if (!input) return segments;

  const leadingSlash = /^(\s*)(\/[a-zA-Z0-9_-]+)/.exec(input);
  let cursor = 0;
  if (leadingSlash) {
    if (leadingSlash[1]) {
      segments.push({ kind: 'text', value: leadingSlash[1] });
    }
    segments.push({ kind: 'slash', value: leadingSlash[2] });
    cursor = leadingSlash[0].length;
  }

  const tail = input.slice(cursor);
  const mentionRe = /(#[a-zA-Z0-9\u4e00-\u9fa5_-]+(?::[^\s#]+)?)/g;
  let lastIndex = 0;
  for (const match of tail.matchAll(mentionRe)) {
    const start = match.index ?? 0;
    const prevChar = start > 0 ? tail[start - 1] : '';
    if (start > 0 && !/\s/.test(prevChar)) continue;
    if (start > lastIndex) {
      segments.push({ kind: 'text', value: tail.slice(lastIndex, start) });
    }
    segments.push({ kind: 'mention', value: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < tail.length) {
    segments.push({ kind: 'text', value: tail.slice(lastIndex) });
  }
  return segments;
}

export interface WorkspacePresetSlot {
  kind: 'shell' | 'agent' | 'lab';
  labLanguage?: 'python' | 'sql' | 'r' | 'c' | 'cpp';
  cliPreset?: 'agy' | 'gemini' | 'claude' | 'codex';
  title: string;
}

export interface WorkspacePresetSpec {
  id: string;
  title: string;
  badge: string;
  description: string;
  splitMode: 'vertical' | 'tri' | 'quad';
  slots: WorkspacePresetSlot[];
}

export const WORKSPACE_LAYOUT_PRESETS: WorkspacePresetSpec[] = [
  {
    id: 'agent-shell',
    title: '伴读推理工作台',
    badge: '2P',
    description: '左栏 Seamind Agent 书卷对话，右栏 PowerShell 随时验证命令',
    splitMode: 'vertical',
    slots: [
      { kind: 'agent', title: 'Seamind Agent' },
      { kind: 'shell', title: 'PowerShell' },
    ],
  },
  {
    id: 'data-analysis',
    title: '数据与统计分析台',
    badge: '2P',
    description:
      '左栏 SQL / Python / R 数据实验本，右栏终端管理 Conda 环境与数据库',
    splitMode: 'vertical',
    slots: [
      { kind: 'lab', labLanguage: 'sql', title: 'SQL 数据实验本' },
      { kind: 'shell', title: 'Conda / Shell' },
    ],
  },
  {
    id: 'lab-shell',
    title: 'Python 交互实验台',
    badge: '2P',
    description: '左栏 Euporie Python 实验本，右栏终端环境管理/包安装',
    splitMode: 'vertical',
    slots: [
      { kind: 'lab', labLanguage: 'python', title: 'Python Lab' },
      { kind: 'shell', title: 'PowerShell' },
    ],
  },
  {
    id: 'c-debug',
    title: 'C/C++ 编译调试台',
    badge: '2P',
    description: '左栏 C/C++ 分步实验本，右栏一键跳转 GDB / 交互 stdin 运行',
    splitMode: 'vertical',
    slots: [
      { kind: 'lab', labLanguage: 'c', title: 'C/C++ Lab' },
      { kind: 'shell', title: 'GDB / Shell' },
    ],
  },
  {
    id: 'research-tri',
    title: '全景三窗研究台',
    badge: '3P',
    description: '主栏 Agent 统筹推理 · 右上 Code Lab 实测 · 右下 Shell 终端',
    splitMode: 'tri',
    slots: [
      { kind: 'agent', title: 'Seamind Agent' },
      { kind: 'lab', labLanguage: 'python', title: 'Python Lab' },
      { kind: 'shell', title: 'PowerShell' },
    ],
  },
  {
    id: 'cli-dual',
    title: 'CLI 套娃对照台',
    badge: '2P',
    description: '左栏 Claude CLI，右栏 Codex/Shell 并行比对执行',
    splitMode: 'vertical',
    slots: [
      { kind: 'shell', cliPreset: 'claude', title: 'CLAUDE CLI' },
      { kind: 'shell', cliPreset: 'codex', title: 'CODEX CLI' },
    ],
  },
];

export function hasTerminalErrorSignal(text: string): boolean {
  if (!text.trim()) return false;
  return /(?:traceback \(most recent|error:|fatal:|exception|syntaxerror|undefined reference|segmentation fault|compilation terminated|无法|失败)/i.test(
    text,
  );
}

export interface FooterShortcutHint {
  keys: string;
  label: string;
}

export function buildSmartFooterHints(
  kind: 'shell' | 'agent' | 'lab',
  isZoomed: boolean,
): FooterShortcutHint[] {
  const zoomHint: FooterShortcutHint = {
    keys: 'Ctrl+Shift+M',
    label: isZoomed ? '还原分屏' : '放大窗格',
  };
  if (kind === 'agent') {
    return [
      { keys: '/ #', label: '指令与引用' },
      { keys: 'Ctrl+M', label: '模型套娃' },
      { keys: 'Ctrl+K', label: '命令面板' },
      zoomHint,
    ];
  }
  if (kind === 'lab') {
    return [
      { keys: 'Shift+↵', label: '运行并下移' },
      { keys: 'Esc', label: '命令模式' },
      { keys: 'Ctrl+K', label: '命令面板' },
      zoomHint,
    ];
  }
  return [
    { keys: 'Ctrl+Shift+F', label: '搜索' },
    { keys: 'Ctrl+Shift+Space', label: 'Vi' },
    { keys: 'Ctrl+K', label: '命令面板' },
    zoomHint,
  ];
}
