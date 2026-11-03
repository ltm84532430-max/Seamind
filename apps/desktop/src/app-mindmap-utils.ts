import type { PureNode } from 'markmap-lib';
import type {
  GeneratedHtmlAsset,
  MindmapNodeSnapshot,
  NodeEditOperation,
} from './agent/types';
import type { DocumentVersion } from './library';
import {
  getMarkdownNodeNotes,
  markdownBody,
  markdownForMindmap,
  normalizeMindmapText,
  type MarkdownNodeSource,
} from './mindmap/commands';
import {
  escapeHtmlText,
  htmlCardDefinitionFromPayload,
  type HtmlCardDefinition,
} from './app-style-utils';

export function markdownTitle(markdown: string): string {
  const rawHeading = markdownForMindmap(markdownBody(markdown))
    .match(/^#{1,2}\s+(.+)\s*$/m)?.[1]
    ?.trim();
  const heading = rawHeading
    ?.replace(/&#10;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return heading || '新建思维导图';
}

export function prepareGeneratedBranchAssets(markdown: string): {
  markdown: string;
  assets: GeneratedHtmlAsset[];
} {
  if (/```\s*seamind-html-card\b/i.test(markdown)) {
    throw new Error(
      'AI 不能直接伪造 HTML 资源引用，请改为输出独立 HTML 代码块。',
    );
  }
  const assets: GeneratedHtmlAsset[] = [];
  const prepared = markdown.replace(
    /```(?:html|htm)\s*\r?\n([\s\S]*?)\r?\n```/gi,
    (_fence, rawHtml: string) => {
      const html = rawHtml.trim();
      if (!html) throw new Error('HTML 代码块不能为空。');
      if (new TextEncoder().encode(html).byteLength > 256 * 1024) {
        throw new Error('单个生成的 HTML 组件不能超过 256 KB。');
      }
      if (assets.length >= 8) throw new Error('一次最多生成 8 个 HTML 组件。');
      const title =
        html
          .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
          ?.replace(/<[^>]*>/g, '')
          .trim()
          .slice(0, 120) || `HTML 可视化 ${assets.length + 1}`;
      const asset: GeneratedHtmlAsset = {
        assetId: crypto.randomUUID(),
        entryPath: 'index.html',
        title,
        html,
      };
      assets.push(asset);
      const card: HtmlCardDefinition = {
        assetId: asset.assetId,
        entryPath: asset.entryPath,
        title: asset.title,
        width: 420,
        height: 260,
      };
      return `\`\`\`seamind-html-card\n${JSON.stringify(card, null, 2)}\n\`\`\``;
    },
  );
  return { markdown: prepared, assets };
}

export function markdownTitleLineIndex(markdown: string): number {
  const body = markdownBody(markdown);
  const bodyOffset = markdown.length - body.length;
  const headingIndex = body
    .split(/\r?\n/)
    .findIndex((line) => /^#{1,2}\s+.+/.test(line));
  if (headingIndex < 0) return -1;
  const lineOffset = (markdown.slice(0, bodyOffset).match(/\n/g) || []).length;
  return lineOffset + headingIndex;
}

export function addFallbackMindmapTitle(
  root: PureNode,
  markdown: string,
  documentTitle: string,
): PureNode {
  const rootDocument = new DOMParser().parseFromString(
    root.content,
    'text/html',
  );
  const hasVisibleText = normalizeMindmapText(
    rootDocument.body.textContent ?? '',
  );
  const hasVisualContent = Boolean(
    rootDocument.body.querySelector(
      '.katex, svg, table, pre, img, .seamind-html-card-node, .seamind-html-canvas-node, .seamind-youtube-card',
    ),
  );
  if (hasVisibleText || hasVisualContent || htmlCardDefinitionFromPayload(root))
    return root;

  const title =
    markdownTitle(markdown) || documentTitle.trim() || '未命名思维导图';
  return { ...root, content: escapeHtmlText(title) };
}

export function errorMessage(error: unknown, fallback: string): string {
  return typeof error === 'string' ? error : fallback;
}

export function formatHistoryTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp * 1000));
}

export function historySourceLabel(source: DocumentVersion['source']): string {
  if (source === 'baseline') return '初始快照';
  if (source === 'manual') return '手动保存';
  if (source === 'ai') return 'AI 精修';
  if (source === 'restore') return '恢复记录';
  return '自动保存';
}

export function formatHistoryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function providerLabel(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.includes('deepseek')) return 'DeepSeek API';
    if (host.includes('openai')) return 'OpenAI API';
    if (host.includes('anthropic')) return 'Anthropic API';
    return host || '兼容 API';
  } catch {
    return '兼容 API';
  }
}

export function normalizeKatexDelimiters(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let fenceMarker = '';
  let displayMath = false;
  const normalizeTex = (formula: string) => formula.replace(/\\_/g, '_');

  return lines
    .map((line) => {
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        const marker = fence[1];
        if (!fenceMarker) fenceMarker = marker[0].repeat(marker.length);
        else if (
          marker[0] === fenceMarker[0] &&
          marker.length >= fenceMarker.length
        )
          fenceMarker = '';
        return line;
      }
      if (fenceMarker) return line;

      if (displayMath) {
        if (/^\s*\\{1,2}\]\s*$/.test(line)) {
          displayMath = false;
          return '$$';
        }
        return normalizeTex(line);
      }

      const singleLineDisplay = line.match(
        /^(\s*)\\{1,2}\[(.*?)\\{1,2}\](\s*)$/,
      );
      if (singleLineDisplay) {
        return `${singleLineDisplay[1]}$$ ${normalizeTex(singleLineDisplay[2])} $$${singleLineDisplay[3]}`;
      }

      const displayOpen = line.match(/^(\s*)\\{1,2}\[\s*$/);
      if (displayOpen) {
        displayMath = true;
        return `${displayOpen[1]}$$`;
      }

      const displayClose = line.match(/^(\s*)\\{1,2}\]\s*$/);
      if (displayClose) return `${displayClose[1]}$$`;

      const convertInline = (text: string) =>
        text.replace(
          /\\{1,2}\((.+?)\\{1,2}\)/g,
          (_, formula: string) => `$${normalizeTex(formula)}$`,
        );
      let result = '';
      let cursor = 0;
      while (cursor < line.length) {
        const tickStart = line.indexOf('`', cursor);
        if (tickStart < 0) {
          result += convertInline(line.slice(cursor));
          break;
        }
        result += convertInline(line.slice(cursor, tickStart));
        let tickEnd = tickStart + 1;
        while (line[tickEnd] === '`') tickEnd += 1;
        const ticks = line.slice(tickStart, tickEnd);
        const codeEnd = line.indexOf(ticks, tickEnd);
        if (codeEnd < 0) {
          result += line.slice(tickStart);
          break;
        }
        result += line.slice(tickStart, codeEnd + ticks.length);
        cursor = codeEnd + ticks.length;
      }
      return result;
    })
    .join('\n');
}

export function countKatexRenderErrors(root: PureNode): number {
  let errorCount = 0;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    const parsed = new DOMParser().parseFromString(node.content, 'text/html');
    errorCount += parsed.body.querySelectorAll('.katex-error').length;
    pending.push(...(node.children || []));
  }
  return errorCount;
}

export function findMathInNodeLabelLines(markdown: string): number[] {
  let fenceMarker = '';
  const issueLines: number[] = [];
  markdown.split(/\r?\n/).forEach((line, index) => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      if (!fenceMarker) fenceMarker = marker[0].repeat(marker.length);
      else if (
        marker[0] === fenceMarker[0] &&
        marker.length >= fenceMarker.length
      ) {
        fenceMarker = '';
      }
      return;
    }
    if (fenceMarker) return;

    const isNodeLabel =
      /^ {0,3}#{1,6}\s+/.test(line) || /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
    if (!isNodeLabel) return;

    const text = line.replace(/\\\$/g, '');
    const hasMath =
      text.includes('$$') ||
      /(^|[^\\])\$[^$\r\n]+\$/.test(text) ||
      /\\{1,2}[[(]/.test(text);
    if (hasMath) issueLines.push(index + 1);
  });
  return issueLines;
}

export function buildAgentMindmapTree(
  root: PureNode,
  sources: Map<string, MarkdownNodeSource>,
  markdown: string,
): {
  root: MindmapNodeSnapshot;
  nodeCount: number;
  truncated: boolean;
} {
  const maxNodes = 200;
  const maxNoteCharsPerNode = 800;
  let remainingNoteChars = 12_000;
  let truncated = false;
  const markdownNotes = getMarkdownNodeNotes(markdown);
  let nextId = 0;
  let nodeCount = 0;
  const visit = (
    node: PureNode,
    parentPath = '',
  ): MindmapNodeSnapshot | null => {
    if (nodeCount >= maxNodes) {
      truncated = true;
      return null;
    }
    nextId += 1;
    nodeCount += 1;
    const path = parentPath ? `${parentPath}.${nextId}` : `${nextId}`;
    const document = new DOMParser().parseFromString(node.content, 'text/html');
    document.body
      .querySelectorAll('svg')
      .forEach((element) => element.remove());
    const isHtmlCard = Boolean(htmlCardDefinitionFromPayload(node));
    const payload = node.payload as Record<string, unknown> | undefined;
    const isYouTubeCard = payload?.seamindCard === 'youtube';
    const containsKatex = Boolean(document.body.querySelector('.katex'));
    const source = sources.get(path);
    const label = (
      isYouTubeCard && typeof payload?.seamindVideoTitle === 'string'
        ? payload.seamindVideoTitle
        : normalizeMindmapText(document.body.textContent ?? '')
    ).slice(0, 160);
    const children = node.children
      .map((child) => visit(child, path))
      .filter((child): child is MindmapNodeSnapshot => child !== null);
    const fullNote = source?.id ? markdownNotes.get(source.id) || '' : '';
    const note = fullNote.slice(
      0,
      Math.min(maxNoteCharsPerNode, remainingNoteChars),
    );
    remainingNoteChars = Math.max(0, remainingNoteChars - note.length);
    const allowedOperations: NodeEditOperation[] = source
      ? ['set_note', 'delete']
      : [];
    if (
      source &&
      source.kind !== 'block' &&
      !isHtmlCard &&
      !isYouTubeCard &&
      !containsKatex
    ) {
      allowedOperations.unshift(
        'rename',
        'add_child',
        'add_sibling',
        'add_branch',
      );
    }
    return {
      path,
      nodeId: source?.id || null,
      label,
      note,
      noteTruncated: note.length < fullNote.length,
      allowedOperations,
      editable: allowedOperations.length > 0,
      children,
    };
  };
  return {
    root: visit(root) ?? {
      path: '1',
      nodeId: null,
      label: '',
      note: '',
      noteTruncated: false,
      allowedOperations: [],
      editable: false,
      children: [],
    },
    nodeCount,
    truncated,
  };
}

export function findAgentMindmapNode(
  root: MindmapNodeSnapshot,
  path: string,
): MindmapNodeSnapshot | null {
  if (root.path === path) return root;
  for (const child of root.children) {
    const match = findAgentMindmapNode(child, path);
    if (match) return match;
  }
  return null;
}
