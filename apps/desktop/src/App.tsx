import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import katex from 'katex';
import markdownItKatex from '@vscode/markdown-it-katex';
import { defaultOptions as defaultHtmlParserOptions } from 'markmap-html-parser';
import { Transformer } from 'markmap-lib';
import { pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import type { PureNode } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import type { Markmap as MarkmapInstance } from 'markmap-view';
import {
  hydrateCodeBlocks,
  updateMarkdownCodeFence,
  updateMarkdownCodeFenceAtRange,
} from './code-blocks';
import MarkdownEditor from './MarkdownEditor';
import type { MarkdownEditorHandle, MarkdownSelection } from './MarkdownEditor';
import MarkdownPreview from './MarkdownPreview';
import {
  buildYouTubeEmbedUrl,
  nextYouTubeThumbnail,
  prepareYouTubeCards,
} from './youtube';
import {
  canOfferAlternativePlayback,
  loadYouTubeIframeApi,
  youtubePlaybackStateLabels,
  youtubePlayerErrorMessage,
} from './youtube-player';
import type {
  YouTubeIframePlayer,
  YouTubePlaybackState,
} from './youtube-player';
import 'katex/dist/katex.min.css';
import LibraryPanel from './LibraryPanel';
import AgentPanel from './AgentPanel';
import { agentToolCatalog, executeAgentTool } from './agent/capabilities';
import type {
  AgentCapabilities,
  ProposeNodeEditInput,
} from './agent/capabilities';
import type {
  ActiveMindmapSnapshot,
  AgentAnalysisMode,
  GeneratedHtmlAsset,
  MindmapNodeSnapshot,
  NodeEditOperation,
  NodeEditProposal,
} from './agent/types';
import {
  applyMarkdownNodeBranch,
  applyMarkdownNodeCommand,
  buildMarkdownNodeSourceMap,
  findSourcePathForLine,
  getMarkdownNodeNote,
  getMarkdownNodeNotes,
  MAX_AGENT_BRANCH_CHARS,
  MAX_MARKDOWN_NODE_NOTE_CHARS,
  markdownBody,
  markdownForMindmap,
  normalizeMindmapText,
  type MarkdownNodeSource,
} from './mindmap/commands';
const TerminalPanel = lazy(() => import('./TerminalPanel'));
import type {
  DocumentVersion,
  DocumentVersionSnapshot,
  LibrarySnapshot,
  MapDocument,
  OpenedDocument,
  SaveDocumentInput,
} from './library';

type ProviderSettings = { baseUrl: string; model: string };
type Theme = 'light' | 'dark';
type MindmapStyle = 'gray' | 'roots' | 'cards' | 'warm';
interface MapColorNode {
  state: { depth: number; path?: string };
}
type StylableMarkmap = Omit<MarkmapInstance, 'setData'> & {
  options: {
    color: (node: MapColorNode) => string;
    lineWidth: (node: MapColorNode) => number;
    linkAnchor: (node: MapColorNode) => 'bottom' | 'center';
    direction?: 'right' | 'both' | 'down';
    linkShape?: 'curve' | 'orthogonal' | 'rounded-orthogonal';
    linkRadius?: number;
  };
  setData(
    data?: PureNode | null,
    options?: {
      color: (node: MapColorNode) => string;
      lineWidth: (node: MapColorNode) => number;
      linkAnchor: (node: MapColorNode) => 'bottom' | 'center';
      direction?: 'right' | 'both' | 'down';
      linkShape?: 'curve' | 'orthogonal' | 'rounded-orthogonal';
      linkRadius?: number;
    },
  ): Promise<void>;
};

interface EditorDraft {
  id: string | null;
  relativePath: string | null;
  title: string;
  category: string;
  mapType: string;
  tags: string;
  markdown: string;
  dirty: boolean;
  revision: number;
}

interface CliAgentToolRequest {
  requestId: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface CliAgentProposal {
  requestId: string;
  proposal: NodeEditProposal;
}

interface EpubOutline {
  title: string;
  markdown: string;
  chapterCount: number;
  sectionCount: number;
  enrichedChapterCount: number;
  skippedChapterCount: number;
  warnings: string[];
  sourceFile: string;
}

interface EpubSummaryResult {
  markdown: string;
  summarizedChapterCount: number;
  unavailableChapterCount: number;
  omittedChapterCount: number;
  truncatedChapterCount: number;
  notSummarizedChapterCount: number;
}

interface ImportedHtmlAsset {
  assetId: string;
  entryPath: string;
  title: string;
}

interface HtmlCardDefinition extends ImportedHtmlAsset {
  width: number;
  height: number;
}

interface HtmlPreviewSelection extends HtmlCardDefinition {
  documentRelativePath: string;
}

interface HtmlCanvasEmbedding extends HtmlPreviewSelection {
  src: string;
}

interface YouTubePreviewSelection {
  id: string;
  title: string;
  src: string;
  startSeconds: number;
}

type YouTubePlaybackMode = 'embed' | 'local';

interface TerminalCommandRequest {
  id: string;
  language: string;
  source: string;
}

const isEpubPath = (path: string) =>
  path.trim().toLowerCase().endsWith('.epub');

const settingsStorageKey = 'markmap.desktop.provider-settings.v1';
const themeStorageKey = 'seamind.theme.v1';
const mindmapStyleStorageKey = 'seamind.map-style.v1';
const nodeSpacingStorageKey = 'seamind.node-spacing.v1';
const aiCollapsedStorageKey = 'seamind.ai-collapsed.v1';
interface NodeSpacing {
  horizontal: number;
  vertical: number;
}

const defaultNodeSpacing: NodeSpacing = { horizontal: 56, vertical: 14 };
const promptSuggestions = [
  '机器学习核心知识体系',
  'Web 全栈架构全景图',
  '微积分核心概念推导脉络',
  '敏捷项目研发与交付流程',
  '用户增长模型与生命周期',
];
interface MindmapStyleDefinition {
  id: MindmapStyle;
  label: string;
  badge: string;
  summary: string;
  bestFor: string;
  direction: 'both' | 'down';
}

const mindmapStyles: MindmapStyleDefinition[] = [
  {
    id: 'gray',
    label: '学术专著',
    badge: '经典发散',
    summary: '墨砚高对比实线 · 严谨出版级排印',
    bestFor: '论文答辩、研究综述、技术白皮书',
    direction: 'both',
  },
  {
    id: 'roots',
    label: '树根架构',
    badge: '向下扎根',
    summary: '主旨顶置 · 自顶向下垂直分叉 · 树根演进脉络',
    bestFor: '系统架构拆解、因果溯源 (5-Whys)、项目 WBS、版本路线图',
    direction: 'down',
  },
  {
    id: 'cards',
    label: '工程卡片',
    badge: '模块工整',
    summary: '板岩蓝卡片容器 · 高信息密度 · 清晰分组边界',
    bestFor: '系统组件全景、API 接口规范、需求清单、模块归属',
    direction: 'both',
  },
  {
    id: 'warm',
    label: '暖色聚类',
    badge: '思维发散',
    summary: '陶土茶色分支染色 · 柔和护眼 · 模块亲和聚类',
    bestFor: '头脑风暴、概念发散、多主线交叉思考',
    direction: 'both',
  },
];
const defaultProviderSettings: ProviderSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

const starterMarkdown = `# AI 思维导图工作台

## 用 Markdown 描述结构
- 一级标题会成为中心主题
- 二级标题和列表项会形成分支
  - 支持继续嵌套
  - 编辑内容后预览自动更新

## 交互预览
- 拖动空白区域平移画布
- 滚轮缩放，点击分支连接处折叠分支
- 使用右上角按钮让整张图适应窗口

## AI 生成
- 输入主题，生成结构清楚的 Markdown
- 编辑内容会自动保存到本机文件库
`;

function createDraft(overrides: Partial<EditorDraft> = {}): EditorDraft {
  return {
    id: null,
    relativePath: null,
    title: 'AI 思维导图工作台',
    category: '未分类',
    mapType: '通用',
    tags: '',
    markdown: starterMarkdown,
    dirty: false,
    revision: 0,
    ...overrides,
  };
}

function readProviderSettings(): ProviderSettings {
  try {
    const saved = localStorage.getItem(settingsStorageKey);
    if (!saved) return defaultProviderSettings;
    const parsed = JSON.parse(saved) as Partial<ProviderSettings>;
    return {
      baseUrl:
        typeof parsed.baseUrl === 'string'
          ? parsed.baseUrl
          : defaultProviderSettings.baseUrl,
      model:
        typeof parsed.model === 'string'
          ? parsed.model
          : defaultProviderSettings.model,
    };
  } catch {
    return defaultProviderSettings;
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem(themeStorageKey) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function readMindmapStyle(): MindmapStyle {
  try {
    const saved = localStorage.getItem(mindmapStyleStorageKey);
    return mindmapStyles.some((style) => style.id === saved)
      ? (saved as MindmapStyle)
      : 'gray';
  } catch {
    return 'gray';
  }
}

function normalizeNodeSpacingValue(
  value: unknown,
  axis: keyof NodeSpacing,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return defaultNodeSpacing[axis];

  const min = axis === 'horizontal' ? 28 : 7;
  const max = axis === 'horizontal' ? 112 : 28;
  const step = axis === 'horizontal' ? 4 : 1;
  const clamped = Math.min(max, Math.max(min, value));
  return Math.min(max, min + Math.round((clamped - min) / step) * step);
}

function readNodeSpacing(): NodeSpacing {
  try {
    const saved = localStorage.getItem(nodeSpacingStorageKey);
    if (saved === null) return defaultNodeSpacing;

    const parsed: unknown = JSON.parse(saved);
    if (typeof parsed === 'number' && parsed >= 50 && parsed <= 200) {
      const scale = parsed / 100;
      return {
        horizontal: normalizeNodeSpacingValue(
          defaultNodeSpacing.horizontal * scale,
          'horizontal',
        ),
        vertical: normalizeNodeSpacingValue(
          defaultNodeSpacing.vertical * scale,
          'vertical',
        ),
      };
    }

    if (parsed && typeof parsed === 'object') {
      const values = parsed as Partial<NodeSpacing>;
      return {
        horizontal: normalizeNodeSpacingValue(values.horizontal, 'horizontal'),
        vertical: normalizeNodeSpacingValue(values.vertical, 'vertical'),
      };
    }
  } catch {
    // Use the current map spacing when local storage is unavailable.
  }
  return defaultNodeSpacing;
}

function readAiCollapsed(): boolean {
  try {
    return localStorage.getItem(aiCollapsedStorageKey) === 'true';
  } catch {
    return false;
  }
}

function mapNodeColor(
  style: MindmapStyle,
  depth: number,
  path: string,
  theme: Theme,
): string {
  if (style === 'gray') return theme === 'dark' ? '#94a3b8' : '#475569';
  if (style === 'roots') return theme === 'dark' ? '#94a3b8' : '#334155';
  if (depth === 0) return theme === 'dark' ? '#cbd5e1' : '#0f172a';

  const branchId = Number(path.split('.')[1] || 1);
  const palette =
    style === 'warm'
      ? theme === 'dark'
        ? ['#e58a62', '#d7aa58', '#84a27e', '#829cbd', '#bd8fc1', '#d17b84']
        : ['#c25e38', '#b57c26', '#5d7d4c', '#4a6f94', '#845893', '#b34d5c']
      : theme === 'dark'
        ? ['#8aa7b5', '#8ca897', '#a695bc', '#bea27e', '#7f9bbd', '#b18888']
        : ['#475569', '#3b5a6c', '#5a4f6e', '#6e5a40', '#3b5c77', '#6c4b4b'];
  return palette[(branchId - 1) % palette.length];
}

function mapNodeLinkAnchor(
  style: MindmapStyle,
  depth: number,
): 'bottom' | 'center' {
  const usesCard =
    style === 'cards' ||
    style === 'gray' ||
    style === 'roots' ||
    (style === 'warm' && depth === 0);
  return usesCard ? 'center' : 'bottom';
}

function mapNodeLineWidth(depth: number): number {
  if (depth === 0) return 2.4;
  if (depth === 1) return 1.9;
  return 1.5;
}

function sanitizeHref(href: string): boolean {
  const value = href.trim();
  if (!value) return false;
  if (/^(#|\/|\.\/|\.\.\/)/.test(value)) return true;
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
  } catch {
    return false;
  }
}

const katexStyleProperties = new Set([
  'height',
  'width',
  'min-width',
  'max-width',
  'vertical-align',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'margin-left',
  'margin-right',
  'padding-left',
  'padding-right',
  'border-left-width',
  'border-right-width',
  'border-bottom-width',
  'font-size',
  'display',
  'text-align',
]);

const katexLength = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|%)?$/i;
const katexStyleKeywordValues: Record<string, Set<string>> = {
  position: new Set(['relative', 'absolute']),
  display: new Set(['block', 'inline', 'inline-block', 'none']),
  'text-align': new Set(['left', 'right', 'center']),
  'max-width': new Set(['none']),
};
const katexSvgElements = new Set(['svg', 'path', 'line']);
const katexSvgAttributes = new Set([
  'xmlns',
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'd',
  'x1',
  'y1',
  'x2',
  'y2',
  'stroke-width',
  'class',
  'style',
  'aria-hidden',
]);

const safeSvgElements = new Set([
  'svg',
  'g',
  'path',
  'line',
  'circle',
  'rect',
  'ellipse',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
]);
const safeSvgAttributes = new Set([
  'xmlns',
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'x',
  'y',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'y1',
  'x2',
  'y2',
  'd',
  'points',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-rule',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'dx',
  'dy',
  'letter-spacing',
  'transform',
  'role',
  'aria-label',
  'aria-hidden',
]);
const svgNumber = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:px|%)?$/i;
const svgNonNegativeNumber =
  /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:px|%)?$/i;
const svgViewBox =
  /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:[\s,]+[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?){3}\s*$/i;
const svgPathData = /^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\s]+$/;
const svgPoints = /^[-+\d.eE,\s]+$/;

const htmlCardParserOptions = {
  ...defaultHtmlParserOptions,
  selector: `${defaultHtmlParserOptions.selector},svg`,
  selectorRules: {
    ...defaultHtmlParserOptions.selectorRules,
    svg: ({
      $node,
      getContent,
    }: Parameters<
      (typeof defaultHtmlParserOptions.selectorRules)['div,p']
    >[0]) => getContent($node),
  },
};

function isSafeKatexSvgAttribute(name: string, value: string): boolean {
  const normalizedValue = value.trim();
  if (name === 'xmlns') return normalizedValue === 'http://www.w3.org/2000/svg';
  if (name === 'viewbox')
    return /^[-+\d.]+(?:\s+[-+\d.]+){3}$/.test(normalizedValue);
  if (name === 'preserveaspectratio')
    return /^(?:xMin|xMid|xMax)(?:YMin|YMid|YMax)(?:\s+(?:meet|slice))?$/i.test(
      normalizedValue,
    );
  if (name === 'd')
    return /^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\s]+$/.test(normalizedValue);
  if (
    name === 'width' ||
    name === 'height' ||
    name === 'stroke-width' ||
    /^x[12]$|^y[12]$/.test(name)
  ) {
    return katexLength.test(normalizedValue);
  }
  if (name === 'aria-hidden')
    return normalizedValue === 'true' || normalizedValue === 'false';
  if (name === 'class') return /^[\w\s-]*$/.test(normalizedValue);
  return name === 'style';
}

function sanitizeKatexStyle(element: Element, value: string): string | null {
  // KaTeX uses inline layout declarations to position fractions, scripts, and
  // delimiters. Raw Markdown HTML is disabled, so retain them only on KaTeX output.
  if (!element.closest('.katex')) return null;

  const parsedStyle = document.createElement('span').style;
  parsedStyle.cssText = value;
  const safeStyle = document.createElement('span').style;

  for (let index = 0; index < parsedStyle.length; index += 1) {
    const property = parsedStyle.item(index).toLowerCase();
    const cssValue = parsedStyle
      .getPropertyValue(property)
      .trim()
      .toLowerCase();
    if (!katexStyleProperties.has(property)) continue;
    if (
      katexLength.test(cssValue) ||
      katexStyleKeywordValues[property]?.has(cssValue)
    ) {
      safeStyle.setProperty(property, cssValue);
    }
  }

  return safeStyle.length ? safeStyle.cssText : null;
}

function isSafeSvgAttribute(name: string, value: string): boolean {
  const normalizedValue = value.trim();
  const boundedNumber = (allowNegative: boolean) => {
    const matcher = allowNegative ? svgNumber : svgNonNegativeNumber;
    if (!matcher.test(normalizedValue)) return false;
    const number = Number(normalizedValue.replace(/(?:px|%)$/i, ''));
    return Number.isFinite(number) && Math.abs(number) <= 100_000;
  };
  if (name === 'xmlns') return normalizedValue === 'http://www.w3.org/2000/svg';
  if (name === 'viewbox') {
    if (!svgViewBox.test(normalizedValue)) return false;
    const values = normalizedValue
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    return (
      values.every(
        (number) => Number.isFinite(number) && Math.abs(number) <= 1_000_000,
      ) &&
      values[2] > 0 &&
      values[3] > 0
    );
  }
  if (name === 'preserveaspectratio')
    return /^(?:none|xMinYMin|xMidYMin|xMaxYMin|xMinYMid|xMidYMid|xMaxYMid|xMinYMax|xMidYMax|xMaxYMax)(?:\s+(?:meet|slice))?$/i.test(
      normalizedValue,
    );
  if (name === 'd') return svgPathData.test(normalizedValue);
  if (name === 'points') return svgPoints.test(normalizedValue);
  if (['width', 'height', 'r', 'rx', 'ry', 'stroke-width'].includes(name))
    return boundedNumber(false);
  if (['x', 'y', 'cx', 'cy', 'x1', 'y1', 'x2', 'y2'].includes(name))
    return boundedNumber(true);
  if (['dx', 'dy', 'letter-spacing'].includes(name)) return boundedNumber(true);
  if (name === 'font-size') return boundedNumber(false);
  if (name === 'font-weight')
    return /^(?:normal|bold|[1-9]00)$/i.test(normalizedValue);
  if (name === 'font-family') return /^[\w\s,'-]{1,80}$/.test(normalizedValue);
  if (name === 'text-anchor')
    return ['start', 'middle', 'end'].includes(normalizedValue);
  if (name === 'dominant-baseline')
    return [
      'auto',
      'middle',
      'central',
      'hanging',
      'text-before-edge',
      'text-after-edge',
    ].includes(normalizedValue);
  if (['fill', 'stroke'].includes(name))
    return /^(?:none|currentcolor|transparent|#[\da-f]{3,8}|[a-z]{1,20})$/i.test(
      normalizedValue,
    );
  if (name === 'stroke-linecap')
    return ['butt', 'round', 'square'].includes(normalizedValue);
  if (name === 'stroke-linejoin')
    return ['miter', 'round', 'bevel'].includes(normalizedValue);
  if (name === 'fill-rule')
    return normalizedValue === 'evenodd' || normalizedValue === 'nonzero';
  if (['opacity', 'fill-opacity', 'stroke-opacity'].includes(name)) {
    const number = Number(normalizedValue);
    return Number.isFinite(number) && number >= 0 && number <= 1;
  }
  if (name === 'transform')
    return /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\s*\(\s*[-+\d.eE,\s]+\)\s*)+$/i.test(
      normalizedValue,
    );
  if (name === 'role')
    return ['img', 'presentation', 'graphics-symbol'].includes(normalizedValue);
  if (name === 'aria-hidden')
    return normalizedValue === 'true' || normalizedValue === 'false';
  if (name === 'aria-label') return normalizedValue.length <= 240;
  return false;
}

function sanitizeSvgTree(root: Element, isKatex = false): void {
  const allowedElements = isKatex ? katexSvgElements : safeSvgElements;
  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  elements.forEach((element) => {
    if (!allowedElements.has(element.localName.toLowerCase())) {
      element.remove();
      return;
    }
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const isAllowed = isKatex
        ? katexSvgAttributes.has(name) &&
          isSafeKatexSvgAttribute(name, attribute.value)
        : safeSvgAttributes.has(name) &&
          isSafeSvgAttribute(name, attribute.value);
      if (!isAllowed) element.removeAttribute(attribute.name);
    });
  });
}

function sanitizeSvgMarkup(source: string): string | null {
  if (source.length > 100_000 || /<!doctype|<!entity/i.test(source))
    return null;
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = parsed.documentElement;
  if (
    parsed.querySelector('parsererror') ||
    root.localName.toLowerCase() !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  )
    return null;
  sanitizeSvgTree(root);
  return new XMLSerializer().serializeToString(root);
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseHtmlCardDefinition(value: unknown): HtmlCardDefinition | null {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object') return null;
  const input = candidate as Record<string, unknown>;
  const assetId = typeof input.assetId === 'string' ? input.assetId : '';
  const entryPath = typeof input.entryPath === 'string' ? input.entryPath : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const width = Number(input.width);
  const height = Number(input.height);
  const normalizedPath = entryPath.replace(/\\/g, '/');
  const pathParts = normalizedPath.split('/');
  if (
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      assetId,
    ) ||
    !normalizedPath ||
    normalizedPath.startsWith('/') ||
    /^[a-z]:/i.test(normalizedPath) ||
    pathParts.some((part) => !part || part === '.' || part === '..') ||
    !/\.html?$/i.test(normalizedPath) ||
    !Number.isInteger(width) ||
    width < 180 ||
    width > 960 ||
    !Number.isInteger(height) ||
    height < 120 ||
    height > 700
  )
    return null;
  return {
    assetId,
    entryPath: normalizedPath,
    title: (title || 'HTML 组件').slice(0, 120),
    width,
    height,
  };
}

function htmlCardDefinitionFromPayload(
  node: PureNode,
): HtmlCardDefinition | null {
  const payload = node.payload as Record<string, unknown> | undefined;
  if (payload?.seamindCard !== 'html') return null;
  return parseHtmlCardDefinition({
    assetId: payload.seamindAssetId,
    entryPath: payload.seamindEntryPath,
    title: payload.seamindTitle,
    width: payload.seamindWidth,
    height: payload.seamindHeight,
  });
}

function htmlCardNodeMarkup(
  card: HtmlCardDefinition,
  iframeSource?: string,
): string {
  const title = escapeHtmlText(card.title);
  const assetId = escapeHtmlText(card.assetId);
  const entryPath = escapeHtmlText(card.entryPath);
  if (iframeSource) {
    return `<div class="seamind-html-canvas-node" style="width:${card.width}px;height:${card.height}px"><div class="seamind-html-canvas-toolbar"><span>${title}</span><button type="button" data-seamind-html-exit="true" aria-label="退出 HTML 交互">退出交互</button></div><iframe class="seamind-html-canvas-frame" title="${title}画布交互" src="${escapeHtmlText(iframeSource)}" sandbox="allow-scripts" referrerpolicy="no-referrer" tabindex="0"></iframe></div>`;
  }
  return `<button type="button" class="seamind-html-card-node" data-seamind-html-card="true" data-seamind-asset-id="${assetId}" data-seamind-entry-path="${entryPath}" data-seamind-title="${title}" data-seamind-width="${card.width}" data-seamind-height="${card.height}" style="width:${card.width}px;height:${card.height}px" aria-label="打开 HTML 组件：${title}"><span class="seamind-html-card-eyebrow">HTML COMPONENT</span><strong>${title}</strong><span class="seamind-html-card-action">点击打开交互预览</span></button>`;
}

function prepareHtmlCardNodes(
  node: PureNode,
  embedding?: HtmlCanvasEmbedding,
  embeddingApplied = { value: false },
): PureNode {
  const payload = node.payload as Record<string, unknown> | undefined;
  const card = htmlCardDefinitionFromPayload(node);
  const isEmbedded = Boolean(
    embedding &&
      !embeddingApplied.value &&
      card?.assetId === embedding.assetId &&
      card.entryPath === embedding.entryPath,
  );
  if (isEmbedded) embeddingApplied.value = true;
  return {
    ...node,
    content:
      payload?.seamindCard === 'html' && card
        ? htmlCardNodeMarkup(card, isEmbedded ? embedding?.src : undefined)
        : node.content,
    children: node.children.map((child) =>
      prepareHtmlCardNodes(child, embedding, embeddingApplied),
    ),
  };
}

function isSafeMarkdownImageSource(source: string): boolean {
  const value = source.trim();
  if (/^(?:\/(?!\/)|\.\.?\/)/.test(value)) return true;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function renderMarkdownToHtml(renderer: unknown, source: string): string {
  return (renderer as { render(markdown: string): string }).render(source);
}

function addMarkdownNodeNoteCards(
  root: PureNode,
  sources: Map<string, MarkdownNodeSource>,
  markdown: string,
  renderer: unknown,
): PureNode {
  const notes = getMarkdownNodeNotes(markdown);
  if (!notes.size) return root;

  let nodeId = 0;
  let remainingNoteChars = 12_000;
  const visit = (node: PureNode, parentPath = ''): PureNode => {
    nodeId += 1;
    const path = parentPath ? `${parentPath}.${nodeId}` : `${nodeId}`;
    const source = sources.get(path);
    const fullNote = source?.id ? notes.get(source.id)?.trim() || '' : '';
    let noteMarkup = '';
    if (fullNote && remainingNoteChars > 0) {
      const note = fullNote.slice(0, Math.min(800, remainingNoteChars));
      remainingNoteChars = Math.max(0, remainingNoteChars - note.length);
      const rendered = renderMarkdownToHtml(renderer, note);
      const safeNote = sanitizeNode({
        content: rendered,
        children: [],
      }).content;
      const ellipsisMarkup =
        note.length < fullNote.length
          ? '<span class="seamind-node-note-ellipsis">…</span>'
          : '';
      noteMarkup = [
        '<div class="seamind-node-note">',
        `<div class="seamind-node-note-content">${safeNote}${ellipsisMarkup}</div>`,
        '</div>',
      ].join('');
    }
    return {
      ...node,
      content: `${node.content}${noteMarkup}`,
      children: node.children.map((child) => visit(child, path)),
    };
  };

  return visit(root);
}

function sanitizeNode(
  node: PureNode,
  options: { allowMarkdownImages?: boolean } = {},
): PureNode {
  const document = new DOMParser().parseFromString(node.content, 'text/html');
  document.body
    .querySelectorAll(
      'script,style,iframe,object,embed,form,input,button,meta,base,link,audio,video,source,track',
    )
    .forEach((element) => element.remove());
  document.body
    .querySelectorAll('svg')
    .forEach((element) =>
      sanitizeSvgTree(element, Boolean(element.closest('.katex'))),
    );
  document.body.querySelectorAll('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
        const isKatex = Boolean(element.closest('.katex'));
        const allowed = isKatex
          ? katexSvgElements.has(element.localName.toLowerCase()) &&
            katexSvgAttributes.has(name) &&
            isSafeKatexSvgAttribute(name, attribute.value)
          : safeSvgElements.has(element.localName.toLowerCase()) &&
            safeSvgAttributes.has(name) &&
            isSafeSvgAttribute(name, attribute.value);
        if (!allowed) element.removeAttribute(attribute.name);
      } else if (name === 'style') {
        const safeStyle = sanitizeKatexStyle(element, attribute.value);
        if (safeStyle) element.setAttribute(attribute.name, safeStyle);
        else element.removeAttribute(attribute.name);
      } else if (name.startsWith('on') || name === 'srcdoc') {
        element.removeAttribute(attribute.name);
      } else if (name === 'href' && !sanitizeHref(attribute.value)) {
        element.removeAttribute(attribute.name);
      } else if (name === 'src') {
        const isMarkdownImage =
          options.allowMarkdownImages &&
          element.tagName.toLowerCase() === 'img' &&
          isSafeMarkdownImageSource(attribute.value);
        if (!isMarkdownImage) element.removeAttribute(attribute.name);
      }
    });
    if (
      element.tagName.toLowerCase() === 'img' &&
      (!options.allowMarkdownImages ||
        !isSafeMarkdownImageSource(element.getAttribute('src') || ''))
    )
      element.removeAttribute('src');
    if (element.getAttribute('target') === '_blank')
      element.setAttribute('rel', 'noopener noreferrer');
  });

  return {
    ...node,
    content: document.body.innerHTML,
    children: node.children.map((child) => sanitizeNode(child, options)),
  };
}

function markdownTitle(markdown: string): string {
  const rawHeading = markdownForMindmap(markdownBody(markdown))
    .match(/^#{1,2}\s+(.+)\s*$/m)?.[1]
    ?.trim();
  const heading = rawHeading
    ?.replace(/&#10;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return heading || '新建思维导图';
}

function prepareGeneratedBranchAssets(markdown: string): {
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

function markdownTitleLineIndex(markdown: string): number {
  const body = markdownBody(markdown);
  const bodyOffset = markdown.length - body.length;
  const headingIndex = body
    .split(/\r?\n/)
    .findIndex((line) => /^#{1,2}\s+.+/.test(line));
  if (headingIndex < 0) return -1;
  const lineOffset = (markdown.slice(0, bodyOffset).match(/\n/g) || []).length;
  return lineOffset + headingIndex;
}

function addFallbackMindmapTitle(
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

function errorMessage(error: unknown, fallback: string): string {
  return typeof error === 'string' ? error : fallback;
}

function formatHistoryTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function historySourceLabel(source: DocumentVersion['source']): string {
  if (source === 'baseline') return '初始快照';
  if (source === 'manual') return '手动保存';
  if (source === 'restore') return '恢复记录';
  return '自动保存';
}

function formatHistoryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function providerLabel(baseUrl: string): string {
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

function normalizeKatexDelimiters(markdown: string): string {
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

      // Convert only outside inline code spans. The attached article uses both
      // single- and double-backslash delimiters, while markdown-it-katex expects
      // dollar delimiters by default.
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

function countKatexRenderErrors(root: PureNode): number {
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

function findMathInNodeLabelLines(markdown: string): number[] {
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

function buildAgentMindmapTree(
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

function findAgentMindmapNode(
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

function Icon({
  name,
}: {
  name: 'fit' | 'minus' | 'plus' | 'collapse' | 'expand' | 'sun' | 'moon';
}) {
  if (name === 'fit') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4M2 2l4 4m8-4-4 4m4 8-4-4m-8 4 4-4" />
      </svg>
    );
  }
  if (name === 'collapse' || name === 'expand') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="m9.5 3-5 5 5 5" />
      </svg>
    );
  }
  if (name === 'moon') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13.3 10.5A5.8 5.8 0 0 1 5.5 2.7 5.9 5.9 0 1 0 13.3 10.5Z" />
      </svg>
    );
  }
  if (name === 'sun') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4m-11.1-4 1 1m6.2 6.2 1 1m0-8.2-1 1m-6.2 6.2-1 1" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={name === 'plus' ? 'M8 3v10M3 8h10' : 'M3 8h10'} />
    </svg>
  );
}

export default function App() {
  const [editorDraft, setEditorDraft] = useState<EditorDraft>(() =>
    createDraft(),
  );
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [mindmapStyle, setMindmapStyle] =
    useState<MindmapStyle>(readMindmapStyle);
  const [nodeSpacing, setNodeSpacing] = useState<NodeSpacing>(readNodeSpacing);
  const activeNodeSpacing =
    nodeSpacing && typeof nodeSpacing === 'object'
      ? nodeSpacing
      : readNodeSpacing();
  const [mindmapStyleMenuOpen, setMindmapStyleMenuOpen] = useState(false);
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
  const [markdownPaneMode, setMarkdownPaneMode] = useState<'edit' | 'preview'>(
    'edit',
  );
  const [markdownFullscreen, setMarkdownFullscreen] = useState(false);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCommandConfirmation, setTerminalCommandConfirmation] =
    useState<TerminalCommandRequest | null>(null);
  const [pendingTerminalCommand, setPendingTerminalCommand] =
    useState<TerminalCommandRequest | null>(null);
  const terminalCommandResultsRef = useRef(
    new Map<string, (output: string) => void>(),
  );
  const [aiCollapsed, setAiCollapsed] = useState<boolean>(readAiCollapsed);
  const [librarySnapshot, setLibrarySnapshot] =
    useState<LibrarySnapshot | null>(null);
  const [libraryDocuments, setLibraryDocuments] = useState<MapDocument[]>([]);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [summarizeEpubOnImport, setSummarizeEpubOnImport] = useState(false);
  const [pendingEpubImport, setPendingEpubImport] = useState(false);
  const [epubDropActive, setEpubDropActive] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [saveMessage, setSaveMessage] = useState('正在初始化文件库…');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<DocumentVersion[]>([]);
  const [historyPreview, setHistoryPreview] =
    useState<DocumentVersionSnapshot | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [htmlImportBusy, setHtmlImportBusy] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreviewSelection | null>(
    null,
  );
  const [htmlPreviewSrc, setHtmlPreviewSrc] = useState('');
  const [htmlPreviewError, setHtmlPreviewError] = useState('');
  const [youtubePreview, setYoutubePreview] =
    useState<YouTubePreviewSelection | null>(null);
  const [youtubeFrameStatus, setYoutubeFrameStatus] =
    useState<YouTubePlaybackState>('loading');
  const [youtubePlaybackMode, setYoutubePlaybackMode] =
    useState<YouTubePlaybackMode>('embed');
  const [youtubeLocalSource, setYoutubeLocalSource] = useState('');
  const [youtubeLocalPlaybackError, setYoutubeLocalPlaybackError] =
    useState('');
  const [youtubeLocalPlaybackBusy, setYoutubeLocalPlaybackBusy] =
    useState(false);
  const [youtubeNativePlaybackBusy, setYoutubeNativePlaybackBusy] =
    useState(false);
  const [youtubeNativePlaybackLaunched, setYoutubeNativePlaybackLaunched] =
    useState(false);
  const [youtubePlayerError, setYoutubePlayerError] = useState<number | null>(
    null,
  );
  const youtubeCardOpenerRef = useRef<HTMLElement | null>(null);
  const youtubeCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const youtubeFrameRef = useRef<HTMLIFrameElement | null>(null);
  const youtubeVideoRef = useRef<HTMLVideoElement | null>(null);
  const youtubePlayerRef = useRef<YouTubeIframePlayer | null>(null);
  const [htmlCanvasEmbed, setHtmlCanvasEmbed] =
    useState<HtmlCanvasEmbedding | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [providerSettings, setProviderSettings] =
    useState<ProviderSettings>(readProviderSettings);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [providerModelsLoading, setProviderModelsLoading] = useState(false);
  const [providerModelsError, setProviderModelsError] = useState('');
  const [providerModelQuery, setProviderModelQuery] = useState('');
  const [manualProviderModel, setManualProviderModel] = useState('');
  const [aiMode, setAiMode] = useState<AgentAnalysisMode>('drilldown');
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [lastUpdated, setLastUpdated] = useState('已同步');
  const [cliAgentProposal, setCliAgentProposal] =
    useState<CliAgentProposal | null>(null);
  const [activeMapPath, setActiveMapPath] = useState<string | null>(null);
  const [nodeNoteDialog, setNodeNoteDialog] = useState<{
    nodeId: string | null;
    nodePath: string;
    label: string;
    markdown: string;
    error: string;
  } | null>(null);
  const [sourceMapVersion, setSourceMapVersion] = useState(0);
  const [markdownEditorSession, setMarkdownEditorSession] = useState(0);
  const cliAgentProposalRef = useRef<CliAgentProposal | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const markdownEditorRef = useRef<MarkdownEditorHandle | null>(null);
  const markdownPaneModeRef = useRef(markdownPaneMode);
  markdownPaneModeRef.current = markdownPaneMode;
  const pendingMarkdownTitleRef = useRef<string | null>(null);
  const codeBlocksAbortRef = useRef<AbortController | null>(null);
  const codeBlocksCleanupRef = useRef<(() => void) | null>(null);
  const mindmapStylePickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const markmapRef = useRef<MarkmapInstance | null>(null);
  const markdownNodeSourcesRef = useRef<Map<string, MarkdownNodeSource>>(
    new Map(),
  );
  const draftRef = useRef(editorDraft);
  const agentCapabilitiesRef = useRef<AgentCapabilities | null>(null);
  const librarySnapshotRef = useRef<LibrarySnapshot | null>(null);
  const historyLoadRequestRef = useRef(0);
  const libraryQueryRef = useRef('');
  const categoryFilterRef = useRef('');
  const activeSaveRef = useRef<Promise<boolean> | null>(null);
  const codeBlockEditHandlerRef = useRef<
    (language: string, previous: string, next: string) => void
  >(() => {});
  const epubImportInFlightRef = useRef(false);
  const epubDropHandlerRef = useRef<(paths: string[]) => void>(() => {});
  const searchRequestRef = useRef(0);
  const markdownNodeSourcesMarkdownRef = useRef(editorDraft.markdown);
  const transformer = useMemo(() => {
    const instance = new Transformer([pluginFrontmatter, pluginSourceLines]);
    instance.md.set({ html: false });
    instance.md.use(markdownItKatex, { katex, throwOnError: false });
    const defaultFenceRenderer = instance.md.renderer.rules.fence;
    instance.md.renderer.rules.fence = (
      tokens,
      index,
      options,
      env,
      renderer,
    ) => {
      const token = tokens[index];
      const language = token.info.trim().split(/\s+/, 1)[0]?.toLowerCase();
      if (language === 'svg') {
        const svg = sanitizeSvgMarkup(token.content);
        return svg
          ? `${svg}\n`
          : `<pre><code>${escapeHtmlText(token.content)}</code></pre>\n`;
      }
      if (language === 'seamind-html-card') {
        const card = parseHtmlCardDefinition(token.content);
        if (!card)
          return '<pre><code>HTML 卡片声明无效，请重新导入 HTML 文件。</code></pre>\n';
        return `<h6 data-seamind-card="html" data-seamind-asset-id="${escapeHtmlText(card.assetId)}" data-seamind-entry-path="${escapeHtmlText(card.entryPath)}" data-seamind-title="${escapeHtmlText(card.title)}" data-seamind-width="${card.width}" data-seamind-height="${card.height}">${escapeHtmlText(card.title)}</h6>\n`;
      }
      return defaultFenceRenderer
        ? defaultFenceRenderer(tokens, index, options, env, renderer)
        : renderer.renderToken(tokens, index, options);
    };
    return instance;
  }, []);
  const ensureAiMathRenderable = (
    markdown: string,
    source: string,
    checkNodeLabels = true,
  ) => {
    const crowdedMathLines = checkNodeLabels
      ? findMathInNodeLabelLines(markdown)
      : [];
    if (crowdedMathLines.length > 0) {
      const lines = crowdedMathLines.slice(0, 5).join('、');
      const remaining = crowdedMathLines.length - 5;
      throw new Error(
        `${source}把数学公式放进了标题或列表节点（第 ${lines}${remaining > 0 ? ` 等 ${crowdedMathLines.length} 处` : ''} 行）。请将公式移到独立数学段落后再应用。`,
      );
    }
    const { root } = transformer.transform(
      normalizeKatexDelimiters(markdownForMindmap(markdown)),
      htmlCardParserOptions,
    );
    const errorCount = countKatexRenderErrors(root);
    if (errorCount > 0) {
      throw new Error(
        `${source}中有 ${errorCount} 处数学公式无法由 KaTeX 渲染；请让模型修正公式后再应用。`,
      );
    }
  };
  const nodeNotePreviewHtml = useMemo(() => {
    if (!nodeNoteDialog?.markdown.trim()) return '';
    const rendered = renderMarkdownToHtml(
      transformer.md,
      `\n${nodeNoteDialog.markdown}`,
    );
    return sanitizeNode({ content: rendered, children: [] }).content;
  }, [nodeNoteDialog?.markdown, transformer]);
  const markdownPreviewSource = useMemo(
    () => normalizeKatexDelimiters(markdownBody(editorDraft.markdown)),
    [editorDraft.markdown],
  );
  const markdownPreviewHtml = useMemo(() => {
    const source = markdownPreviewSource;
    if (!source.trim()) return '<p>暂无 Markdown 内容</p>';
    const rendered = renderMarkdownToHtml(transformer.md, source);
    return sanitizeNode(
      { content: rendered, children: [] },
      { allowMarkdownImages: true },
    ).content;
  }, [markdownPreviewSource, transformer]);
  const historyPreviewHtml = useMemo(() => {
    if (!historyPreview?.markdown.trim())
      return '<p>此版本没有 Markdown 内容。</p>';
    const rendered = renderMarkdownToHtml(
      transformer.md,
      normalizeKatexDelimiters(markdownBody(historyPreview.markdown)),
    );
    return sanitizeNode(
      { content: rendered, children: [] },
      { allowMarkdownImages: true },
    ).content;
  }, [historyPreview?.markdown, transformer]);

  useEffect(() => {
    if (!markdownFullscreen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMarkdownFullscreen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [markdownFullscreen]);

  const installDraft = (next: EditorDraft) => {
    draftRef.current = next;
    setEditorDraft(next);
    setMarkdownEditorSession((session) => session + 1);
    setActiveMapPath(null);
    setNodeNoteDialog(null);
  };

  const patchDraft = (patch: Partial<EditorDraft>) => {
    const next = {
      ...draftRef.current,
      ...patch,
      dirty: true,
      revision: draftRef.current.revision + 1,
    };
    draftRef.current = next;
    setEditorDraft(next);
    setPendingEpubImport(false);
    setSaveMessage('有未保存修改');
  };

  const handleMarkdownEditorChange = (markdown: string) => {
    const current = draftRef.current;
    const title =
      pendingMarkdownTitleRef.current ||
      (current.title === markdownTitle(current.markdown)
        ? markdownTitle(markdown)
        : null);
    pendingMarkdownTitleRef.current = null;
    patchDraft({ markdown, ...(title ? { title } : {}) });
  };

  const applyMarkdownFromCanvas = (
    markdown: string,
    options: {
      lineIndex?: number;
      endLineIndex?: number;
      focus?: boolean;
      title?: string;
    } = {},
  ) => {
    if (markdown === draftRef.current.markdown) return;
    pendingMarkdownTitleRef.current = options.title || null;
    if (markdownEditorRef.current) {
      markdownEditorRef.current.applyDocument(markdown, options);
    } else {
      pendingMarkdownTitleRef.current = null;
      patchDraft({
        markdown,
        ...(options.title ? { title: options.title } : {}),
      });
    }
  };

  const handleMarkdownSelectionChange = (selection: MarkdownSelection) => {
    setActiveMapPath(
      findSourcePathForLine(
        selection.lineIndex,
        markdownNodeSourcesRef.current,
      ),
    );
  };

  const applySelectedNodeOperation = (
    operation: 'child' | 'sibling' | 'delete',
  ) => {
    if (!activeMapPath) return;
    if (markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown)
      return;
    const source = markdownNodeSourcesRef.current.get(activeMapPath);
    if (!source || (source.kind === 'block' && operation !== 'delete')) return;
    const markdown = draftRef.current.markdown;
    try {
      const command = applyMarkdownNodeCommand(
        markdown,
        source,
        operation === 'child'
          ? 'add_child'
          : operation === 'sibling'
            ? 'add_sibling'
            : 'delete',
        '新主题',
      );
      if (command.markdown === markdown) return;
      if (operation === 'delete') setActiveMapPath(null);
      applyMarkdownFromCanvas(command.markdown, {
        lineIndex: command.lineIndex,
        focus: true,
        ...(source.lineIndex === markdownTitleLineIndex(markdown)
          ? { title: markdownTitle(command.markdown) }
          : {}),
      });
    } catch (error) {
      setLibraryError(errorMessage(error, '无法修改所选节点。'));
    }
  };

  const openSelectedNodeNote = () => {
    if (!activeMapPath) return;
    if (markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown)
      return;
    const source = markdownNodeSourcesRef.current.get(activeMapPath);
    if (!source) return;
    const current = draftRef.current.markdown;
    setNodeNoteDialog({
      nodeId: source.id || null,
      nodePath: activeMapPath,
      label: source.label,
      markdown: source.id ? getMarkdownNodeNote(current, source.id) : '',
      error: '',
    });
  };

  const saveSelectedNodeNote = () => {
    if (!nodeNoteDialog) return;
    if (!nodeNoteDialog.nodeId && !nodeNoteDialog.markdown.trim()) {
      setNodeNoteDialog(null);
      return;
    }
    const current = draftRef.current.markdown;
    const root = transformer.transform(markdownForMindmap(current)).root;
    const sources = buildMarkdownNodeSourceMap(current, root);
    const source = nodeNoteDialog.nodeId
      ? [...sources.values()].find(
          (candidate) => candidate.id === nodeNoteDialog.nodeId,
        )
      : sources.get(nodeNoteDialog.nodePath);
    if (!source) {
      setNodeNoteDialog((dialog) =>
        dialog
          ? { ...dialog, error: '节点已变化，请关闭后重新打开备注。' }
          : dialog,
      );
      return;
    }
    try {
      const command = applyMarkdownNodeCommand(
        current,
        source,
        'set_note',
        nodeNoteDialog.markdown,
      );
      if (command.markdown !== current)
        applyMarkdownFromCanvas(command.markdown);
      setNodeNoteDialog(null);
    } catch (error) {
      setNodeNoteDialog((dialog) =>
        dialog
          ? { ...dialog, error: errorMessage(error, '节点备注无法保存。') }
          : dialog,
      );
    }
  };

  const getAgentMindmap = (): ActiveMindmapSnapshot => {
    const current = draftRef.current;
    const root = transformer.transform(
      markdownForMindmap(current.markdown),
    ).root;
    const sources = buildMarkdownNodeSourceMap(current.markdown, root);
    const tree = buildAgentMindmapTree(root, sources, current.markdown);
    return {
      title: current.title,
      revision: current.revision,
      relativePath: current.relativePath,
      nodeCount: tree.nodeCount,
      truncated: tree.truncated,
      markdown: current.markdown,
      root: tree.root,
    };
  };

  const proposeAgentNodeEdit = (
    input: ProposeNodeEditInput,
  ): NodeEditProposal => {
    const current = draftRef.current;
    if (current.revision !== input.baseRevision) {
      throw new Error('当前导图已变化，请重新读取后再提出修改。');
    }
    const root = transformer.transform(
      markdownForMindmap(current.markdown),
    ).root;
    const sources = buildMarkdownNodeSourceMap(current.markdown, root);
    const targetEntry = input.nodeId
      ? [...sources.entries()].find(([, source]) => source.id === input.nodeId)
      : input.nodePath
        ? ([input.nodePath, sources.get(input.nodePath)] as const)
        : undefined;
    const [nodePath, source] = targetEntry || [];
    if (!nodePath || !source) {
      throw new Error('找不到这个节点的 Markdown 源位置，请重新读取导图。');
    }
    const targetSnapshot = findAgentMindmapNode(
      buildAgentMindmapTree(root, sources, current.markdown).root,
      nodePath,
    );
    if (!targetSnapshot?.allowedOperations.includes(input.operation)) {
      throw new Error(
        '此节点不支持该操作，请按当前导图快照中的 allowedOperations 修改。',
      );
    }
    const command = applyMarkdownNodeCommand(
      current.markdown,
      source,
      input.operation,
      input.text,
    );
    if (command.markdown === current.markdown) {
      throw new Error('提案没有产生任何 Markdown 变化。');
    }
    if (input.operation !== 'delete') {
      if (input.operation === 'set_note') {
        ensureAiMathRenderable(input.text, 'AI 节点备注', false);
      } else {
        const nodeLabel = input.text.replace(/\s*\n+\s*/g, ' ').trim();
        ensureAiMathRenderable(`- ${nodeLabel}`, 'AI 节点修改');
      }
    }
    const previousNote = source.id
      ? getMarkdownNodeNote(current.markdown, source.id)
      : '';
    const nextLabel =
      input.operation === 'delete'
        ? '删除该节点及其子节点'
        : input.operation === 'set_note'
          ? '更新节点备注'
          : input.operation === 'rename'
            ? input.text.replace(/\s*\n+\s*/g, ' ').trim()
            : input.text.replace(/\s*\n+\s*/g, ' ').trim() || '新主题';
    return {
      baseRevision: current.revision,
      baseRelativePath: current.relativePath,
      baseMarkdown: current.markdown,
      baseTitle: current.title,
      markdown: command.markdown,
      title: markdownTitle(command.markdown),
      nodeId: command.nodeId || source.id || null,
      nodePath,
      operation: input.operation,
      previousLabel: source.label,
      nextLabel,
      ...(input.operation === 'set_note'
        ? { previousNote, nextNote: input.text }
        : {}),
      rationale: input.rationale,
    };
  };

  const proposeAgentNodeBranch = (input: {
    baseRevision: number;
    nodeId?: string;
    nodePath?: string;
    analysisMode: AgentAnalysisMode;
    branchMarkdown: string;
    rationale: string;
  }): NodeEditProposal => {
    const current = draftRef.current;
    if (current.revision !== input.baseRevision) {
      throw new Error('当前导图已变化，请重新读取后再生成下探分支。');
    }
    if (input.branchMarkdown.length > MAX_AGENT_BRANCH_CHARS) {
      throw new Error('生成的下探分支超过字符上限，请缩小主题后重试。');
    }
    const root = transformer.transform(
      markdownForMindmap(current.markdown),
    ).root;
    const sources = buildMarkdownNodeSourceMap(current.markdown, root);
    const targetEntry = input.nodeId
      ? [...sources.entries()].find(([, source]) => source.id === input.nodeId)
      : input.nodePath
        ? ([input.nodePath, sources.get(input.nodePath)] as const)
        : undefined;
    const [nodePath, source] = targetEntry || [];
    if (!nodePath || !source) {
      throw new Error('找不到目标节点的 Markdown 源位置，请重新选择节点。');
    }
    const target = findAgentMindmapNode(
      buildAgentMindmapTree(root, sources, current.markdown).root,
      nodePath,
    );
    if (!target?.allowedOperations.includes('add_branch')) {
      throw new Error('该节点不支持添加下探分支，请选择普通标题或列表节点。');
    }
    const prepared = prepareGeneratedBranchAssets(input.branchMarkdown);
    ensureAiMathRenderable(prepared.markdown, 'AI 分支');
    const command = applyMarkdownNodeBranch(
      current.markdown,
      source,
      prepared.markdown,
    );
    const firstHeading = prepared.markdown.match(/^\s*#{1,6}\s+(.+)$/m)?.[1];
    const nextLabel = firstHeading
      ? normalizeMindmapText(firstHeading)
      : '下探分支';
    return {
      baseRevision: current.revision,
      baseRelativePath: current.relativePath,
      baseMarkdown: current.markdown,
      baseTitle: current.title,
      markdown: command.markdown,
      title: markdownTitle(command.markdown),
      nodeId: command.nodeId || source.id || null,
      nodePath,
      operation: 'add_branch',
      previousLabel: source.label,
      nextLabel,
      rationale: input.rationale,
      analysisMode: input.analysisMode,
      branchMarkdown: prepared.markdown,
      ...(prepared.assets.length ? { htmlAssets: prepared.assets } : {}),
    };
  };

  const agentCapabilities: AgentCapabilities = {
    getCurrentMindmap: getAgentMindmap,
    searchLibrary: (query, category) =>
      invoke<MapDocument[]>('search_library', {
        query,
        category: category || null,
      }),
    readDocument: (relativePath) =>
      invoke<OpenedDocument>('open_document', { relativePath }),
    proposeNodeEdit: proposeAgentNodeEdit,
    proposeNodeBranch: proposeAgentNodeBranch,
  };
  agentCapabilitiesRef.current = agentCapabilities;

  useEffect(() => {
    const tools = agentToolCatalog.map(
      ({ name, description, permission, inputSchema, version }) => ({
        name,
        description,
        inputSchema,
        annotations: {
          readOnlyHint: permission === 'read',
          destructiveHint: permission === 'user_approval',
          openWorldHint: false,
        },
        _meta: {
          'seamind/version': version,
          'seamind/permission': permission,
          ...(permission === 'user_approval'
            ? { 'anthropic/requiresUserInteraction': true }
            : {}),
        },
      }),
    );
    void invoke('agent_bridge_set_tools', { tools }).catch((error: unknown) => {
      console.error('Unable to register Seamind MCP tools', error);
    });

    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<CliAgentToolRequest>(
      'seamind-cli-tool-request',
      async (event) => {
        const { requestId, name, arguments: input } = event.payload;
        const capabilities = agentCapabilitiesRef.current;
        if (!capabilities) {
          await invoke('agent_bridge_resolve', {
            requestId,
            result: {},
            error: 'Seamind 能力尚未初始化。',
          }).catch(() => undefined);
          return;
        }
        try {
          const execution = await executeAgentTool(
            name,
            JSON.stringify(input ?? {}),
            capabilities,
          );
          if (execution.proposal) {
            if (cliAgentProposalRef.current) {
              await invoke('agent_bridge_resolve', {
                requestId,
                result: {},
                error: 'Seamind 正在等待你确认另一条导图修改提案。',
              }).catch(() => undefined);
              return;
            }
            const pending = { requestId, proposal: execution.proposal };
            cliAgentProposalRef.current = pending;
            setCliAgentProposal(pending);
            return;
          }
          const structuredContent = {
            version: execution.version,
            permission: execution.permission,
            ...execution.result,
          };
          await invoke('agent_bridge_resolve', {
            requestId,
            result: {
              content: [
                { type: 'text', text: JSON.stringify(structuredContent) },
              ],
              structuredContent,
            },
            error: null,
          });
        } catch (caught) {
          await invoke('agent_bridge_resolve', {
            requestId,
            result: {},
            error: caught instanceof Error ? caught.message : '工具执行失败。',
          }).catch(() => undefined);
        }
      },
    )
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch((error: unknown) => {
        console.error('Unable to listen for Seamind MCP requests', error);
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const applyAgentProposal = async (
    proposal: NodeEditProposal,
  ): Promise<number | null> => {
    const current = draftRef.current;
    if (
      current.revision !== proposal.baseRevision ||
      current.relativePath !== proposal.baseRelativePath ||
      current.markdown !== proposal.baseMarkdown
    ) {
      return null;
    }
    if (proposal.htmlAssets?.length) {
      if (!current.relativePath) {
        throw new Error('请先保存当前思维导图，再插入生成的 HTML 资源。');
      }
      const assetIds = proposal.htmlAssets.map((asset) => asset.assetId);
      await invoke('save_generated_html_assets', {
        documentRelativePath: current.relativePath,
        assets: proposal.htmlAssets,
      });
      const latest = draftRef.current;
      if (
        latest.revision !== proposal.baseRevision ||
        latest.relativePath !== proposal.baseRelativePath ||
        latest.markdown !== proposal.baseMarkdown
      ) {
        await invoke('discard_generated_html_assets', {
          documentRelativePath: current.relativePath,
          assetIds,
        }).catch(() => undefined);
        return null;
      }
    }
    applyMarkdownFromCanvas(proposal.markdown, { title: proposal.title });
    return draftRef.current.revision;
  };

  const resolveCliAgentProposal = async (apply: boolean) => {
    const pending = cliAgentProposalRef.current;
    if (!pending) return;
    cliAgentProposalRef.current = null;
    setCliAgentProposal(null);
    if (!apply) {
      await invoke('agent_bridge_resolve', {
        requestId: pending.requestId,
        result: {},
        error: '用户在 Seamind 中拒绝了导图修改提案；导图没有变化。',
      }).catch(() => undefined);
      return;
    }
    let appliedRevision: number | null;
    try {
      appliedRevision = await applyAgentProposal(pending.proposal);
    } catch (error) {
      await invoke('agent_bridge_resolve', {
        requestId: pending.requestId,
        result: {},
        error: errorMessage(error, '无法保存下探分支资源。'),
      }).catch(() => undefined);
      return;
    }
    if (appliedRevision === null) {
      await invoke('agent_bridge_resolve', {
        requestId: pending.requestId,
        result: {},
        error: '当前导图在提案生成后发生了变化。请重新读取导图并提出新提案。',
      }).catch(() => undefined);
      return;
    }
    await invoke('agent_bridge_resolve', {
      requestId: pending.requestId,
      result: {
        content: [
          { type: 'text', text: '用户已在 Seamind 中确认并应用修改。' },
        ],
        structuredContent: {
          status: 'applied',
          title: pending.proposal.title,
          relativePath: pending.proposal.baseRelativePath,
          revision: appliedRevision,
        },
      },
      error: null,
    }).catch(() => undefined);
  };

  const undoAgentProposal = async (
    proposal: NodeEditProposal,
    appliedRevision: number,
  ): Promise<boolean> => {
    const current = draftRef.current;
    if (
      current.revision !== appliedRevision ||
      (proposal.baseRelativePath !== null &&
        current.relativePath !== proposal.baseRelativePath) ||
      current.markdown !== proposal.markdown
    ) {
      return false;
    }
    applyMarkdownFromCanvas(proposal.baseMarkdown, {
      title: proposal.baseTitle,
    });
    if (proposal.htmlAssets?.length && proposal.baseRelativePath) {
      await invoke('discard_generated_html_assets', {
        documentRelativePath: proposal.baseRelativePath,
        assetIds: proposal.htmlAssets.map((asset) => asset.assetId),
      }).catch(() => undefined);
    }
    return true;
  };

  codeBlockEditHandlerRef.current = (
    language: string,
    previous: string,
    next: string,
  ) => {
    const activeDraft = draftRef.current;
    const markdown = updateMarkdownCodeFence(
      activeDraft.markdown,
      language,
      previous,
      next,
    );
    if (markdown !== activeDraft.markdown) applyMarkdownFromCanvas(markdown);
  };

  const handleMathVisualizationChange = (
    language: string,
    previous: string,
    next: string,
    nodePath: string | null,
  ) => {
    if (
      !nodePath ||
      markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown
    )
      return;
    const source = markdownNodeSourcesRef.current.get(nodePath);
    if (!source || source.kind !== 'block') return;
    const current = draftRef.current.markdown;
    const markdown = updateMarkdownCodeFenceAtRange(
      current,
      language,
      source.lineIndex,
      source.endLineIndex,
      previous,
      next,
    );
    if (markdown === current) {
      setLibraryError('无法定位该数学可视化代码块，请先从源文本重新渲染。');
      return;
    }
    setLibraryError('');
    applyMarkdownFromCanvas(markdown, {
      lineIndex: source.lineIndex,
      endLineIndex: source.endLineIndex,
      focus: true,
    });
  };

  const installLibrarySnapshot = (snapshot: LibrarySnapshot) => {
    librarySnapshotRef.current = snapshot;
    setLibrarySnapshot(snapshot);
    setLibraryDocuments(snapshot.documents);
  };

  const searchLibrary = async (
    query = libraryQuery,
    category = categoryFilter,
  ) => {
    const documents = await invoke<MapDocument[]>('search_library', {
      query,
      category: category || null,
    });
    setLibraryDocuments(documents);
  };

  const loadHistoryVersion = async (versionId: string) => {
    const documentId = draftRef.current.id;
    if (!documentId) return;
    const request = ++historyLoadRequestRef.current;
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const snapshot = await invoke<DocumentVersionSnapshot>(
        'load_document_version',
        { documentId, versionId },
      );
      if (
        request === historyLoadRequestRef.current &&
        draftRef.current.id === documentId
      ) {
        setHistoryPreview(snapshot);
      }
    } catch (error) {
      if (request === historyLoadRequestRef.current)
        setHistoryError(errorMessage(error, '无法读取历史版本内容。'));
    } finally {
      if (request === historyLoadRequestRef.current) setHistoryLoading(false);
    }
  };

  const closeDocumentHistory = () => {
    historyLoadRequestRef.current += 1;
    setHistoryOpen(false);
  };

  const openDocumentHistory = async () => {
    const current = draftRef.current;
    if (!current.id || !current.relativePath) return;
    const request = ++historyLoadRequestRef.current;
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError('');
    setHistoryPreview(null);
    setHistoryVersions([]);
    if (current.dirty && !(await saveDraft())) {
      if (request === historyLoadRequestRef.current) {
        setHistoryError('当前修改尚未保存，历史记录未能加载。');
        setHistoryLoading(false);
      }
      return;
    }
    if (request !== historyLoadRequestRef.current) return;
    const target = draftRef.current;
    if (!target.id || target.id !== current.id) {
      setHistoryError('当前思维导图已变化，请重新打开历史记录。');
      setHistoryLoading(false);
      return;
    }
    try {
      const versions = await invoke<DocumentVersion[]>(
        'list_document_versions',
        { documentId: target.id },
      );
      if (
        request !== historyLoadRequestRef.current ||
        draftRef.current.id !== target.id
      ) {
        return;
      }
      setHistoryVersions(versions);
      if (versions[0]) await loadHistoryVersion(versions[0].versionId);
    } catch (error) {
      if (request === historyLoadRequestRef.current)
        setHistoryError(errorMessage(error, '无法读取历史版本列表。'));
    } finally {
      if (request === historyLoadRequestRef.current) setHistoryLoading(false);
    }
  };

  const restoreHistoryVersion = async () => {
    const selected = historyPreview;
    const current = draftRef.current;
    if (
      !selected ||
      !current.id ||
      !current.relativePath ||
      current.id !== selected.documentId
    ) {
      setHistoryError('当前思维导图已变化，请重新打开历史记录。');
      return;
    }
    setHistoryBusy(true);
    setHistoryError('');
    try {
      if (current.dirty && !(await saveDraft())) return;
      const latest = draftRef.current;
      if (latest.id !== selected.documentId || !latest.relativePath) {
        setHistoryError('当前思维导图已变化，未执行恢复。');
        return;
      }
      const restored = await invoke<OpenedDocument>(
        'restore_document_version',
        {
          documentId: selected.documentId,
          relativePath: latest.relativePath,
          versionId: selected.versionId,
        },
      );
      installDraft(
        createDraft({
          id: restored.document.id,
          relativePath: restored.document.relativePath,
          title: restored.document.title,
          category: restored.document.category || '未分类',
          mapType: restored.document.mapType || '通用',
          tags: restored.document.tags.join(', '),
          markdown: restored.markdown,
          revision: latest.revision + 1,
        }),
      );
      const updatedLibrary = librarySnapshotRef.current;
      if (updatedLibrary) {
        const parts = restored.document.category.split('/').filter(Boolean);
        const categories = new Set(updatedLibrary.categories);
        for (let index = 1; index <= parts.length; index += 1)
          categories.add(parts.slice(0, index).join('/'));
        const nextLibrary = {
          ...updatedLibrary,
          categories: [...categories].sort(),
          documents: [
            restored.document,
            ...updatedLibrary.documents.filter(
              (document) => document.id !== restored.document.id,
            ),
          ],
        };
        installLibrarySnapshot(nextLibrary);
      }
      void searchLibrary().catch((error) =>
        setLibraryError(errorMessage(error, '更新搜索索引失败')),
      );
      closeDocumentHistory();
      setHistoryPreview(null);
      setSaveMessage('已恢复到所选版本');
      setLibraryError('');
    } catch (error) {
      setHistoryError(errorMessage(error, '恢复历史版本失败。'));
    } finally {
      setHistoryBusy(false);
    }
  };

  const saveDraft = async (force = false): Promise<boolean> => {
    const activeSave = activeSaveRef.current;
    if (activeSave) {
      const saved = await activeSave;
      if (!saved) return false;
      if (draftRef.current.dirty) return saveDraft(force);
      return true;
    }

    const snapshot = draftRef.current;
    if (!force && !snapshot.dirty && snapshot.relativePath) return true;
    if (!librarySnapshotRef.current?.rootPath) {
      setSaveMessage('请先选择文件库目录');
      return false;
    }

    const input: SaveDocumentInput = {
      id: snapshot.id,
      relativePath: snapshot.relativePath,
      title: snapshot.title.trim() || markdownTitle(snapshot.markdown),
      category: snapshot.category,
      mapType: snapshot.mapType,
      tags: snapshot.tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      markdown: snapshot.markdown,
      historySource: force ? 'manual' : 'autosave',
    };
    setSaveMessage('正在保存…');
    const task = (async () => {
      try {
        const savedDocument = await invoke<MapDocument>('save_document', {
          input,
        });
        const latest = draftRef.current;
        const unchanged = latest.revision === snapshot.revision;
        const next: EditorDraft = {
          ...latest,
          id: savedDocument.id,
          relativePath: savedDocument.relativePath,
          ...(unchanged
            ? {
                title: savedDocument.title,
                category: savedDocument.category,
                mapType: savedDocument.mapType,
                tags: savedDocument.tags.join(', '),
              }
            : {}),
          dirty: !unchanged,
        };
        draftRef.current = next;
        setEditorDraft(next);
        setPendingEpubImport(false);
        setSaveMessage(unchanged ? '已保存到本机' : '正在保存后续修改…');
        setLibraryError('');

        const currentLibrary = librarySnapshotRef.current;
        if (currentLibrary) {
          const categories = new Set(currentLibrary.categories);
          const parts = savedDocument.category.split('/').filter(Boolean);
          for (let index = 1; index <= parts.length; index += 1)
            categories.add(parts.slice(0, index).join('/'));
          const documents = [
            savedDocument,
            ...currentLibrary.documents.filter(
              (document) =>
                document.relativePath !== savedDocument.relativePath &&
                document.id !== savedDocument.id,
            ),
          ];
          const updatedLibrary = {
            ...currentLibrary,
            categories: [...categories].sort(),
            documents,
          };
          librarySnapshotRef.current = updatedLibrary;
          setLibrarySnapshot(updatedLibrary);
        }
        void searchLibrary().catch((error) =>
          setLibraryError(errorMessage(error, '更新搜索索引失败')),
        );
        return true;
      } catch (error) {
        setSaveMessage(errorMessage(error, '保存失败'));
        return false;
      }
    })();
    activeSaveRef.current = task;
    const saved = await task;
    if (activeSaveRef.current === task) activeSaveRef.current = null;
    if (
      saved &&
      draftRef.current.dirty &&
      draftRef.current.revision !== snapshot.revision
    ) {
      return saveDraft(true);
    }
    return saved;
  };

  const openMap = async (document: MapDocument) => {
    if (draftRef.current.dirty && !(await saveDraft())) return;
    setSaveMessage('正在打开思维导图…');
    try {
      const opened = await invoke<OpenedDocument>('open_document', {
        relativePath: document.relativePath,
      });
      const next = createDraft({
        id: opened.document.id,
        relativePath: opened.document.relativePath,
        title: opened.document.title,
        category: opened.document.category || '未分类',
        mapType: opened.document.mapType || '通用',
        tags: opened.document.tags.join(', '),
        markdown: opened.markdown,
      });
      installDraft(next);
      setSaveMessage('已打开');
      setLibraryError('');
    } catch (error) {
      setLibraryError(errorMessage(error, '打开思维导图失败'));
      setSaveMessage('打开失败');
    }
  };

  const loadLibrary = async (openRecent: boolean) => {
    setLibraryBusy(true);
    try {
      const snapshot = await invoke<LibrarySnapshot>('library_status');
      installLibrarySnapshot(snapshot);
      setLibraryError('');
      setSaveMessage(snapshot.rootPath ? '文件库已就绪' : '请选择文件库目录');
      if (openRecent && snapshot.documents[0])
        await openMap(snapshot.documents[0]);
    } catch (error) {
      setLibraryError(errorMessage(error, '无法读取文件库'));
      setSaveMessage('文件库不可用');
    } finally {
      setLibraryBusy(false);
    }
  };

  const chooseLibraryRoot = async () => {
    if (draftRef.current.dirty && !(await saveDraft())) return;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: '选择 Markmap 思维导图库',
      });
      if (typeof selected !== 'string') return;
      setLibraryBusy(true);
      const snapshot = await invoke<LibrarySnapshot>('set_library_root', {
        path: selected,
      });
      installLibrarySnapshot(snapshot);
      setLibraryError('');
      setCategoryFilter('');
      setLibraryQuery('');
      if (snapshot.documents[0]) {
        await openMap(snapshot.documents[0]);
      } else {
        installDraft(
          createDraft({
            title: '新建思维导图',
            category: '未分类',
            markdown: '# 新建思维导图\n\n## 主题\n',
          }),
        );
        setSaveMessage('文件库已设置');
      }
    } catch (error) {
      setLibraryError(errorMessage(error, '设置文件库失败'));
    } finally {
      setLibraryBusy(false);
    }
  };

  const createNewDocument = async () => {
    if (draftRef.current.dirty && !(await saveDraft())) return;
    const revision = draftRef.current.revision + 1;
    const category = categoryFilter || '未分类';
    installDraft(
      createDraft({
        title: '新建思维导图',
        category,
        mapType: category.split('/').at(-1) || '通用',
        markdown: '# 新建思维导图\n\n## 主题\n',
        dirty: true,
        revision,
      }),
    );
    setSaveMessage('正在创建…');
  };

  const prepareForEpubImport = async () => {
    if (pendingEpubImport) {
      return window.confirm(
        '当前 EPUB 目录草稿还没有保存。继续导入会替换这份草稿，是否继续？',
      );
    } else if (draftRef.current.dirty && !(await saveDraft())) {
      return false;
    }
    return true;
  };

  const importEpubPath = async (
    path: string,
    droppedEpubCount = 1,
    includeAiSummary = false,
  ) => {
    if (epubImportInFlightRef.current) return;
    epubImportInFlightRef.current = true;
    setLibraryBusy(true);
    setSaveMessage('正在读取 EPUB 目录…');
    setLibraryError('');
    try {
      const outline = await invoke<EpubOutline>('import_epub_toc', { path });
      const currentDraft = draftRef.current;
      const importedDraft = createDraft({
        title: outline.title,
        category: categoryFilter || '未分类',
        mapType: 'EPUB 目录',
        tags: 'EPUB, 目录',
        markdown: outline.markdown,
        dirty: true,
        revision: currentDraft.revision + 1,
      });
      installDraft(importedDraft);
      setPendingEpubImport(true);
      const droppedNotice =
        droppedEpubCount > 1
          ? `（检测到 ${droppedEpubCount} 本 EPUB，本次先导入第一本）`
          : '';
      const sectionNotice =
        outline.sectionCount > 0
          ? `提取正文小节 ${outline.sectionCount} 个，覆盖 ${outline.enrichedChapterCount} 个目录项`
          : '正文未检测到小节标题';
      const skippedNotice =
        outline.skippedChapterCount > 0
          ? `；${outline.skippedChapterCount} 个目录项的小节未能解析`
          : '';
      const warningNotice = outline.warnings[0]
        ? `；提示：${outline.warnings[0]}`
        : '';
      const importNotice = `已从 ${outline.sourceFile} 导入 ${outline.chapterCount} 个目录条目；${sectionNotice}${skippedNotice}${warningNotice}，请检查后保存${droppedNotice}`;
      let aiSummaryNotice = '';
      if (includeAiSummary) {
        setSaveMessage('目录已导入，正在将章节正文发送到当前 AI 模型生成摘要…');
        try {
          const result = await invoke<EpubSummaryResult>(
            'summarize_epub_chapters',
            {
              path,
              baseUrl: providerSettings.baseUrl,
              model: providerSettings.model,
              markdown: outline.markdown,
            },
          );
          if (draftRef.current === importedDraft) {
            installDraft({
              ...importedDraft,
              markdown: result.markdown,
              dirty: true,
              revision: importedDraft.revision + 1,
            });
            aiSummaryNotice = `；AI 已生成 ${result.summarizedChapterCount} 章摘要`;
            if (result.truncatedChapterCount > 0) {
              aiSummaryNotice += `（${result.truncatedChapterCount} 章仅使用前约 4000 字）`;
            }
            if (result.unavailableChapterCount > 0) {
              aiSummaryNotice += `；${result.unavailableChapterCount} 章正文未能提取`;
            }
            if (result.notSummarizedChapterCount > 0) {
              aiSummaryNotice += `；${result.notSummarizedChapterCount} 章未获得摘要`;
            }
            if (result.omittedChapterCount > 0) {
              aiSummaryNotice += `；为控制请求范围，跳过 ${result.omittedChapterCount} 章`;
            }
          } else {
            aiSummaryNotice =
              '；AI 摘要已返回，但导入后草稿发生了编辑，未覆盖你的修改';
          }
        } catch (error) {
          aiSummaryNotice = `；AI 摘要失败，仍保留本地目录：${errorMessage(error, '摘要请求失败')}`;
        }
      }
      setSaveMessage(`${importNotice}${aiSummaryNotice}`);
    } catch (error) {
      setLibraryError(errorMessage(error, '导入 EPUB 目录失败'));
      setSaveMessage('EPUB 导入失败');
    } finally {
      epubImportInFlightRef.current = false;
      setLibraryBusy(false);
      setSummarizeEpubOnImport(false);
    }
  };

  const importDroppedEpubs = async (paths: string[]) => {
    const includeAiSummary = summarizeEpubOnImport;
    setSummarizeEpubOnImport(false);
    const epubPaths = paths.filter(isEpubPath);
    if (epubPaths.length === 0) {
      setLibraryError('请拖入 .epub 电子书文件以导入目录。');
      return;
    }
    if (libraryBusy || epubImportInFlightRef.current) {
      setLibraryError('文件库正在处理其他操作，请稍后再导入 EPUB。');
      return;
    }
    if (!(await prepareForEpubImport())) return;
    await importEpubPath(epubPaths[0], epubPaths.length, includeAiSummary);
  };

  epubDropHandlerRef.current = (paths) => {
    void importDroppedEpubs(paths);
  };

  const importEpub = async () => {
    const includeAiSummary = summarizeEpubOnImport;
    setSummarizeEpubOnImport(false);
    if (!(await prepareForEpubImport())) return;
    try {
      const selected = await openDialog({
        multiple: false,
        title: '导入 EPUB 目录',
        filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      });
      if (typeof selected !== 'string') return;
      await importEpubPath(selected, 1, includeAiSummary);
    } catch (error) {
      setLibraryError(errorMessage(error, '导入 EPUB 目录失败'));
      setSaveMessage('EPUB 导入失败');
    }
  };

  const insertSvgTemplate = () => {
    const template = [
      '```svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="130" viewBox="0 0 220 130">',
      '  <rect x="8" y="8" width="204" height="114" rx="12" fill="#f3f6f7" stroke="#758a96" stroke-width="3"/>',
      '  <circle cx="110" cy="65" r="24" fill="#d76e49"/>',
      '</svg>',
      '```',
    ].join('\n');
    const markdown = draftRef.current.markdown.trimEnd();
    patchDraft({
      markdown: `${markdown ? `${markdown}\n\n` : ''}${template}\n`,
    });
    setSaveMessage('已插入 SVG 模板');
  };

  const importHtmlAsset = async () => {
    if (htmlImportBusy) return;
    if (!librarySnapshotRef.current?.rootPath) {
      setLibraryError('请先设置文件库，再导入 HTML 文件。');
      return;
    }
    setLibraryError('');
    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: '导入 HTML 组件',
        filters: [{ name: 'HTML 文件', extensions: ['html', 'htm'] }],
      });
      if (typeof selected !== 'string') return;
      if (!(await saveDraft(true))) return;
      const current = draftRef.current;
      if (!current.relativePath) {
        setLibraryError('请先保存当前思维导图，再导入 HTML 组件。');
        return;
      }

      setHtmlImportBusy(true);
      setSaveMessage('正在导入 HTML 资源…');
      const imported = await invoke<ImportedHtmlAsset>('import_html_asset', {
        documentRelativePath: current.relativePath,
        sourcePath: selected,
      });
      const card: HtmlCardDefinition = {
        ...imported,
        width: 420,
        height: 260,
      };
      const cardFence = `\`\`\`seamind-html-card\n${JSON.stringify(card, null, 2)}\n\`\`\``;
      const markdown = current.markdown.trimEnd();
      patchDraft({
        markdown: `${markdown ? `${markdown}\n\n` : ''}${cardFence}\n`,
      });
      setSaveMessage('HTML 组件已插入思维导图');
      setLibraryError('');
    } catch (error) {
      setLibraryError(errorMessage(error, '导入 HTML 组件失败'));
      setSaveMessage('HTML 导入失败');
    } finally {
      setHtmlImportBusy(false);
    }
  };

  const closeHtmlPreview = () => {
    setHtmlPreview(null);
    setHtmlPreviewSrc('');
    setHtmlPreviewError('');
  };

  const embedHtmlPreviewInCanvas = () => {
    if (!htmlPreview || !htmlPreviewSrc) return;
    setHtmlCanvasEmbed({ ...htmlPreview, src: htmlPreviewSrc });
    closeHtmlPreview();
  };

  const closeYouTubePreview = () => setYoutubePreview(null);

  const canTryLocalYouTubePlayback = canOfferAlternativePlayback(
    youtubeFrameStatus,
    youtubePlayerError,
  );

  const tryLocalYouTubePlayback = async () => {
    if (!youtubePreview || youtubeLocalPlaybackBusy) return;
    setYoutubeLocalPlaybackBusy(true);
    setYoutubeLocalPlaybackError('');
    setYoutubeFrameStatus('loading');
    try {
      const source = await invoke<string>('youtube_local_playback_source', {
        videoId: youtubePreview.id,
      });
      setYoutubeLocalSource(source);
      setYoutubePlaybackMode('local');
      setYoutubeFrameStatus('ready');
    } catch (error) {
      setYoutubeLocalPlaybackError(
        errorMessage(error, '本地解析器无法提供兼容的播放流。'),
      );
      setYoutubeFrameStatus('error');
    } finally {
      setYoutubeLocalPlaybackBusy(false);
    }
  };

  const tryNativeYouTubePlayback = async () => {
    if (!youtubePreview || youtubeNativePlaybackBusy) return;
    setYoutubeNativePlaybackBusy(true);
    setYoutubeLocalPlaybackError('');
    try {
      await invoke('youtube_open_with_mpv', {
        videoId: youtubePreview.id,
        startSeconds: youtubePreview.startSeconds,
      });
      setYoutubeNativePlaybackLaunched(true);
      setYoutubeLocalPlaybackError('mpv 已启动，正在外部窗口加载视频。');
    } catch (error) {
      setYoutubeLocalPlaybackError(errorMessage(error, '无法启动外部播放器。'));
    } finally {
      setYoutubeNativePlaybackBusy(false);
    }
  };

  const returnToYouTubeEmbed = () => {
    setYoutubeLocalPlaybackError('');
    setYoutubeLocalSource('');
    setYoutubePlaybackMode('embed');
    setYoutubePlayerError(null);
    setYoutubeFrameStatus('loading');
  };

  const createCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!categoryDraft.trim()) return;
    try {
      const normalizedCategory = categoryDraft
        .trim()
        .replaceAll('\\', '/')
        .split('/')
        .map((part) => part.trim())
        .join('/');
      const snapshot = await invoke<LibrarySnapshot>('create_category', {
        category: categoryDraft.trim(),
      });
      installLibrarySnapshot(snapshot);
      setCategoryFilter(normalizedCategory);
      setCategoryDraft('');
      setCategoryDialogOpen(false);
      setLibraryError('');
    } catch (error) {
      setLibraryError(errorMessage(error, '创建分类失败'));
    }
  };

  const deleteMap = async (document: MapDocument) => {
    if (
      !window.confirm(
        `确定删除“${document.title}”吗？此操作会删除文件库中的 Markdown 文件。`,
      )
    )
      return;
    if (
      draftRef.current.relativePath === document.relativePath &&
      draftRef.current.dirty
    ) {
      if (!(await saveDraft())) return;
    }
    try {
      await invoke('delete_document', { relativePath: document.relativePath });
      if (draftRef.current.relativePath === document.relativePath) {
        installDraft(
          createDraft({
            title: '新建思维导图',
            category: categoryFilter || '未分类',
            markdown: '# 新建思维导图\n\n## 主题\n',
          }),
        );
      }
      await loadLibrary(false);
      setSaveMessage('已删除');
    } catch (error) {
      setLibraryError(errorMessage(error, '删除失败'));
    }
  };

  const handleGenerate = async () => {
    if (isGenerating || !prompt.trim()) return;
    setGenerationError('');
    setIsGenerating(true);
    setLastUpdated('正在请求 AI…');
    try {
      const generatedMarkdown = await invoke<string>('generate_mindmap', {
        baseUrl: providerSettings.baseUrl,
        model: providerSettings.model,
        prompt: prompt.trim(),
      });
      ensureAiMathRenderable(generatedMarkdown, 'AI 生成结果');
      const activeDraft = draftRef.current;
      if (activeDraft.relativePath) {
        if (activeDraft.dirty && !(await saveDraft())) {
          setGenerationError(
            '当前思维导图的修改未能保存，AI 结果尚未应用。请先处理保存问题后重试。',
          );
          setLastUpdated('生成未应用');
          return;
        }
        const currentDraft = draftRef.current;
        installDraft(
          createDraft({
            title: markdownTitle(generatedMarkdown),
            category: currentDraft.category,
            mapType: currentDraft.mapType,
            markdown: generatedMarkdown,
            dirty: true,
            revision: currentDraft.revision + 1,
          }),
        );
        setSaveMessage('AI 思维导图已生成，正在保存为新文件…');
      } else {
        patchDraft({
          markdown: generatedMarkdown,
          title: markdownTitle(generatedMarkdown),
        });
      }
      setLastUpdated('AI 已生成');
      setGenerationDialogOpen(false);
    } catch (error) {
      setGenerationError(
        errorMessage(error, '生成失败，请检查模型设置后重试。'),
      );
      setLastUpdated('生成失败');
    } finally {
      setIsGenerating(false);
    }
  };

  const loadProviderModels = async () => {
    setProviderModelsLoading(true);
    setProviderModels([]);
    setProviderModelsError('');
    try {
      const models = await invoke<string[]>('list_provider_models', {
        baseUrl: providerSettings.baseUrl,
      });
      setProviderModels(models);
    } catch (error) {
      setProviderModels([]);
      setProviderModelsError(
        errorMessage(error, '无法获取模型列表；可以手动填写模型 ID。'),
      );
    } finally {
      setProviderModelsLoading(false);
    }
  };

  const toggleModelPicker = () => {
    if (modelPickerOpen) {
      setModelPickerOpen(false);
      return;
    }
    setProviderModelQuery('');
    setManualProviderModel(providerSettings.model);
    setModelPickerOpen(true);
    void loadProviderModels();
  };

  const chooseProviderModel = (model: string) => {
    const selected = model.trim();
    if (!selected) return;
    setProviderSettings((current) => ({ ...current, model: selected }));
    setManualProviderModel(selected);
    setModelPickerOpen(false);
  };

  const openSettings = () => {
    setSettingsMessage('');
    setSettingsOpen(true);
    void invoke<boolean>('has_api_key')
      .then(setApiKeySaved)
      .catch((error) =>
        setSettingsMessage(errorMessage(error, '无法读取密钥状态。')),
      );
  };

  const saveApiKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!apiKeyDraft.trim()) return;
    setSettingsMessage('正在安全保存…');
    try {
      await invoke('save_api_key', { apiKey: apiKeyDraft.trim() });
      setApiKeyDraft('');
      setApiKeySaved(true);
      setSettingsMessage('密钥已保存到 Windows 凭据管理器。');
    } catch (error) {
      setSettingsMessage(errorMessage(error, '保存密钥失败。'));
    }
  };

  const removeApiKey = async () => {
    setSettingsMessage('');
    try {
      await invoke('delete_api_key');
      setApiKeySaved(false);
      setSettingsMessage('已删除保存的 API 密钥。');
    } catch (error) {
      setSettingsMessage(errorMessage(error, '删除密钥失败。'));
    }
  };

  useEffect(() => {
    localStorage.setItem(settingsStorageKey, JSON.stringify(providerSettings));
  }, [providerSettings]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !modelPickerRef.current?.contains(event.target)
      ) {
        setModelPickerOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModelPickerOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [modelPickerOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Keep the selected theme for this session when storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(mindmapStyleStorageKey, mindmapStyle);
    } catch {
      // Keep the selected map style for this session when storage is unavailable.
    }
  }, [mindmapStyle]);

  useEffect(() => {
    if (!nodeSpacing || typeof nodeSpacing !== 'object') {
      const migrated = readNodeSpacing();
      setNodeSpacing(migrated);
      try {
        localStorage.setItem(nodeSpacingStorageKey, JSON.stringify(migrated));
      } catch {
        // Keep the selected node spacing for this session.
      }
      return;
    }
    try {
      localStorage.setItem(nodeSpacingStorageKey, JSON.stringify(nodeSpacing));
    } catch {
      // Keep the selected node spacing for this session.
    }
  }, [nodeSpacing]);

  useEffect(() => {
    try {
      localStorage.setItem(aiCollapsedStorageKey, String(aiCollapsed));
    } catch {
      // Keep the state for this session when storage is unavailable.
    }
  }, [aiCollapsed]);

  useEffect(() => {
    if (!mindmapStyleMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !mindmapStylePickerRef.current?.contains(event.target)
      ) {
        setMindmapStyleMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMindmapStyleMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [mindmapStyleMenuOpen]);

  useEffect(() => {
    void invoke<boolean>('has_api_key')
      .then(setApiKeySaved)
      .catch(() => setApiKeySaved(false));
    void loadLibrary(true);
  }, []);

  useEffect(() => {
    libraryQueryRef.current = libraryQuery;
    categoryFilterRef.current = categoryFilter;
  }, [libraryQuery, categoryFilter]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<LibrarySnapshot>('library-changed', (event) => {
      librarySnapshotRef.current = event.payload;
      setLibrarySnapshot(event.payload);
      void invoke<MapDocument[]>('search_library', {
        query: libraryQueryRef.current,
        category: categoryFilterRef.current || null,
      })
        .then(setLibraryDocuments)
        .catch((error) =>
          setLibraryError(errorMessage(error, '更新文件库索引失败')),
        );
    })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch((error) =>
        setLibraryError(errorMessage(error, '无法监控文件库变化')),
      );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter') {
          setEpubDropActive(payload.paths.some(isEpubPath));
        } else if (payload.type === 'leave') {
          setEpubDropActive(false);
        } else if (payload.type === 'drop') {
          setEpubDropActive(false);
          epubDropHandlerRef.current(payload.paths);
        }
      })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch((error) =>
        setLibraryError(errorMessage(error, '无法启用文件拖放导入')),
      );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!editorDraft.dirty || !librarySnapshot?.rootPath || pendingEpubImport)
      return;
    const timer = window.setTimeout(() => {
      void saveDraft();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    editorDraft.dirty,
    editorDraft.revision,
    librarySnapshot?.rootPath,
    pendingEpubImport,
  ]);

  useEffect(() => {
    if (!librarySnapshot?.rootPath) return;
    const sequence = ++searchRequestRef.current;
    const timer = window.setTimeout(() => {
      void invoke<MapDocument[]>('search_library', {
        query: libraryQuery,
        category: categoryFilter || null,
      })
        .then((documents) => {
          if (sequence === searchRequestRef.current)
            setLibraryDocuments(documents);
        })
        .catch((error) =>
          setLibraryError(errorMessage(error, '搜索文件库失败')),
        );
    }, 160);
    return () => {
      window.clearTimeout(timer);
      searchRequestRef.current += 1;
    };
  }, [librarySnapshot?.rootPath, libraryQuery, categoryFilter]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = svgRef.current;
    const map = Markmap.create(svgRef.current, {
      autoFit: true,
      duration: 220,
      direction:
        mindmapStyles.find((s) => s.id === mindmapStyle)?.direction || 'both',
      linkShape: 'orthogonal',
      linkRadius: 0,
      linkAnchor: (node: MapColorNode) =>
        mapNodeLinkAnchor(mindmapStyle, node.state.depth),
      lineWidth: (node: MapColorNode) => mapNodeLineWidth(node.state.depth),
      color: (node: MapColorNode) =>
        mapNodeColor(
          mindmapStyle,
          node.state.depth,
          node.state.path || '',
          theme,
        ),
      maxWidth: 380,
      spacingHorizontal: defaultNodeSpacing.horizontal,
      spacingVertical: defaultNodeSpacing.vertical,
      fitRatio: 0.9,
      pan: true,
      zoom: true,
    });
    markmapRef.current = map;

    const handleCanvasDoubleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          '.seamind-code-panel, button, input, textarea, .cm-editor',
        )
      )
        return;
      const nodeGroup = target.closest<SVGGElement>('g.markmap-node');
      if (!nodeGroup) return;
      const sourcePath = nodeGroup.getAttribute('data-path');
      const source = sourcePath
        ? markdownNodeSourcesRef.current.get(sourcePath)
        : undefined;
      const editor = nodeGroup.querySelector<HTMLElement>(
        'foreignObject > div > div',
      );
      if (
        !source ||
        source.kind === 'block' ||
        !editor ||
        markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown
      )
        return;
      if (svg.querySelector('[contenteditable="true"]')) return;

      event.preventDefault();
      event.stopPropagation();
      const originalText = editor.innerText || editor.textContent || '';
      let finished = false;
      editor.contentEditable = 'true';
      editor.setAttribute('role', 'textbox');
      editor.setAttribute(
        'aria-label',
        '\u6309 Enter \u6362\u884c\uff0c\u6309 Ctrl+Enter \u6dfb\u52a0\u540c\u7ea7\uff0c\u6309 Tab \u6dfb\u52a0\u5b50\u8282\u70b9',
      );
      editor.setAttribute('spellcheck', 'false');
      editor.classList.add('is-canvas-editing');

      const finish = (action?: 'cancel' | 'sibling' | 'child') => {
        if (finished) return;
        finished = true;
        editor.removeEventListener('keydown', handleKeyDown);
        editor.removeEventListener('blur', handleBlur);
        const nextText =
          action === 'cancel'
            ? originalText
            : editor.innerText || editor.textContent || '';
        editor.contentEditable = 'false';
        editor.removeAttribute('role');
        editor.removeAttribute('aria-label');
        editor.removeAttribute('spellcheck');
        editor.classList.remove('is-canvas-editing');

        if (action === 'cancel') {
          editor.textContent = originalText;
          return;
        }
        const activeDraft = draftRef.current;
        const titleLineIndex = markdownTitleLineIndex(activeDraft.markdown);
        const command = applyMarkdownNodeCommand(
          activeDraft.markdown,
          source,
          action === 'child'
            ? 'add_child'
            : action === 'sibling'
              ? 'add_sibling'
              : 'rename',
          nextText,
        );
        if (command.markdown !== activeDraft.markdown) {
          applyMarkdownFromCanvas(command.markdown, {
            lineIndex: command.lineIndex,
            focus: true,
            ...(!action && source.lineIndex === titleLineIndex
              ? { title: markdownTitle(command.markdown) }
              : {}),
          });
        }
      };

      const handleKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.isComposing) return;
        if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          finish('cancel');
        } else if (
          keyEvent.key === 'Enter' &&
          (keyEvent.ctrlKey || keyEvent.metaKey)
        ) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          finish('sibling');
        } else if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          if (!editor.contains(range.startContainer)) return;
          range.deleteContents();
          const lineBreak = document.createElement('br');
          range.insertNode(lineBreak);
          range.setStartAfter(lineBreak);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        } else if (keyEvent.key === 'Tab') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          finish('child');
        }
      };
      const handleBlur = () => finish();
      editor.addEventListener('keydown', handleKeyDown);
      editor.addEventListener('blur', handleBlur);
      editor.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    };

    const handleHtmlCardClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const exitButton = target.closest<HTMLElement>(
        '[data-seamind-html-exit="true"]',
      );
      if (exitButton) {
        event.preventDefault();
        event.stopPropagation();
        setHtmlCanvasEmbed(null);
        return;
      }
      const cardElement = target.closest<HTMLElement>(
        'button[data-seamind-html-card="true"]',
      );
      if (!cardElement) return;
      event.preventDefault();
      event.stopPropagation();
      const card = parseHtmlCardDefinition({
        assetId: cardElement.dataset.seamindAssetId,
        entryPath: cardElement.dataset.seamindEntryPath,
        title: cardElement.dataset.seamindTitle,
        width: cardElement.dataset.seamindWidth,
        height: cardElement.dataset.seamindHeight,
      });
      const documentRelativePath = draftRef.current.relativePath;
      if (!card || !documentRelativePath) {
        setLibraryError('卡片信息无效，请重新导入 HTML 文件。');
        return;
      }
      setHtmlPreviewError('');
      setHtmlPreviewSrc('');
      setHtmlPreview({ ...card, documentRelativePath });
    };

    const handleMapNodeClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          'button, input, textarea, select, .cm-editor, [contenteditable="true"]',
        )
      )
        return;
      if (markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown)
        return;
      if (!target.closest('foreignObject')) return;
      const nodeGroup = target.closest<SVGGElement>('g.markmap-node');
      const path = nodeGroup?.getAttribute('data-path');
      if (!nodeGroup || !path) return;
      setActiveMapPath(path);
      const source = markdownNodeSourcesRef.current.get(path);
      if (source) {
        const selectSource = () =>
          markdownEditorRef.current?.selectLines(
            source.lineIndex,
            source.endLineIndex,
            true,
          );
        if (markdownPaneModeRef.current === 'preview') {
          setMarkdownPaneMode('edit');
          window.requestAnimationFrame(selectSource);
        } else {
          selectSource();
        }
      }
    };

    const handleYouTubeCardClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest<HTMLButtonElement>(
        'button[data-seamind-youtube-card="true"]',
      );
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      const id = card.dataset.seamindYoutubeId || '';
      const startSeconds = Number(card.dataset.seamindYoutubeStart || '0');
      const src = buildYouTubeEmbedUrl(id, startSeconds);
      if (!src) return;
      youtubeCardOpenerRef.current = card;
      setYoutubeFrameStatus('loading');
      setYoutubePlayerError(null);
      setYoutubePlaybackMode('embed');
      setYoutubeLocalSource('');
      setYoutubeLocalPlaybackError('');
      setYoutubeLocalPlaybackBusy(false);
      setYoutubeNativePlaybackBusy(false);
      setYoutubeNativePlaybackLaunched(false);
      setYoutubePreview({
        id,
        src,
        title: card.dataset.seamindYoutubeTitle || 'YouTube 视频',
        startSeconds: Number.isSafeInteger(startSeconds) ? startSeconds : 0,
      });
    };

    const handleYouTubeThumbnailError = (event: Event) => {
      const image = event.target;
      if (
        !(image instanceof HTMLImageElement) ||
        image.dataset.seamindYoutubeThumbnail !== 'true'
      )
        return;
      const videoId = image.dataset.seamindYoutubeId || '';
      const currentQuality = Number(image.dataset.seamindYoutubeQuality || '0');
      const fallback = nextYouTubeThumbnail(videoId, currentQuality);
      if (fallback) {
        image.dataset.seamindYoutubeQuality = String(fallback.quality);
        image.src = fallback.src;
        return;
      }
      const placeholder = document.createElement('div');
      placeholder.className = 'seamind-youtube-thumbnail-fallback';
      placeholder.textContent = '封面暂不可用';
      image.replaceWith(placeholder);
    };

    svg.addEventListener('click', handleMapNodeClick, true);
    svg.addEventListener('click', handleHtmlCardClick, true);
    svg.addEventListener('click', handleYouTubeCardClick, true);
    svg.addEventListener('error', handleYouTubeThumbnailError, true);
    svg.addEventListener('dblclick', handleCanvasDoubleClick, true);
    return () => {
      svg.removeEventListener('click', handleMapNodeClick, true);
      svg.removeEventListener('click', handleHtmlCardClick, true);
      svg.removeEventListener('click', handleYouTubeCardClick, true);
      svg.removeEventListener('error', handleYouTubeThumbnailError, true);
      svg.removeEventListener('dblclick', handleCanvasDoubleClick, true);
      map.destroy();
      markmapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = markmapRef.current as StylableMarkmap | null;
    if (!map) return;
    void map
      .setData(undefined, {
        direction:
          mindmapStyles.find((s) => s.id === mindmapStyle)?.direction || 'both',
        linkShape: 'orthogonal',
        linkRadius: 0,
        color: (node) =>
          mapNodeColor(
            mindmapStyle,
            node.state.depth,
            node.state.path || '',
            theme,
          ),
        lineWidth: (node) => mapNodeLineWidth(node.state.depth),
        linkAnchor: (node) => mapNodeLinkAnchor(mindmapStyle, node.state.depth),
      })
      .then(() => setSourceMapVersion((version) => version + 1));
  }, [mindmapStyle, theme]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg
      .querySelectorAll<SVGGElement>('g.markmap-node[data-path]')
      .forEach((nodeGroup) => {
        if (nodeGroup.getAttribute('data-path') === activeMapPath) {
          nodeGroup.setAttribute('data-active', 'true');
        } else {
          nodeGroup.removeAttribute('data-active');
        }
      });
  }, [activeMapPath, sourceMapVersion]);

  useEffect(() => {
    if (!htmlPreview) return;
    let active = true;
    setHtmlPreviewSrc('');
    setHtmlPreviewError('');
    void invoke<string>('resolve_html_asset', {
      documentRelativePath: htmlPreview.documentRelativePath,
      assetId: htmlPreview.assetId,
      entryPath: htmlPreview.entryPath,
    })
      .then((path) => {
        if (active) setHtmlPreviewSrc(convertFileSrc(path));
      })
      .catch((error) => {
        if (active)
          setHtmlPreviewError(errorMessage(error, '无法打开 HTML 组件。'));
      });
    return () => {
      active = false;
    };
  }, [htmlPreview]);

  useEffect(() => {
    if (
      htmlCanvasEmbed &&
      htmlCanvasEmbed.documentRelativePath !== editorDraft.relativePath
    ) {
      setHtmlCanvasEmbed(null);
    }
  }, [editorDraft.relativePath, htmlCanvasEmbed]);

  useEffect(() => {
    if (!htmlPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeHtmlPreview();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [htmlPreview]);

  useEffect(() => {
    if (!youtubePreview || youtubePlaybackMode === 'local') return;
    let cancelled = false;
    let player: YouTubeIframePlayer | null = null;

    void loadYouTubeIframeApi()
      .then((api) => {
        const frame = youtubeFrameRef.current;
        if (cancelled || !frame) return;
        player = new api.Player(frame, {
          events: {
            onReady: () => {
              if (!cancelled) setYoutubeFrameStatus('ready');
            },
            onStateChange: (event) => {
              if (cancelled) return;
              switch (event.data) {
                case api.PlayerState.PLAYING:
                  setYoutubeFrameStatus('playing');
                  break;
                case api.PlayerState.PAUSED:
                  setYoutubeFrameStatus('paused');
                  break;
                case api.PlayerState.BUFFERING:
                  setYoutubeFrameStatus('buffering');
                  break;
                case api.PlayerState.ENDED:
                  setYoutubeFrameStatus('ended');
                  break;
                case api.PlayerState.UNSTARTED:
                case api.PlayerState.CUED:
                default:
                  setYoutubeFrameStatus('ready');
              }
            },
            onError: (event) => {
              if (cancelled) return;
              setYoutubePlayerError(event.data);
              setYoutubeFrameStatus('error');
            },
          },
        });
        youtubePlayerRef.current = player;
      })
      .catch(() => {
        if (!cancelled) setYoutubeFrameStatus('error');
      });

    return () => {
      cancelled = true;
      const activePlayer = player ?? youtubePlayerRef.current;
      if (activePlayer) {
        activePlayer.destroy();
        if (youtubePlayerRef.current === activePlayer)
          youtubePlayerRef.current = null;
      }
    };
  }, [youtubePreview, youtubePlaybackMode]);

  useEffect(() => {
    if (!youtubePreview) return;
    const opener = youtubeCardOpenerRef.current;
    youtubeCloseButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeYouTubePreview();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      if (opener?.isConnected) opener.focus();
    };
  }, [youtubePreview]);

  useEffect(() => {
    if (!youtubePreview) return;
    const timeout = window.setTimeout(() => {
      setYoutubeFrameStatus((status) =>
        status === 'loading' ? 'timeout' : status,
      );
    }, 15000);
    return () => window.clearTimeout(timeout);
  }, [youtubePreview]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const map = markmapRef.current;
      const svg = svgRef.current;
      if (!map || !svg) return;
      codeBlocksAbortRef.current?.abort();
      codeBlocksCleanupRef.current?.();
      codeBlocksCleanupRef.current = null;
      const codeBlocksAbort = new AbortController();
      codeBlocksAbortRef.current = codeBlocksAbort;
      const { root } = transformer.transform(
        normalizeKatexDelimiters(markdownForMindmap(editorDraft.markdown)),
        htmlCardParserOptions,
      );
      const embedding =
        htmlCanvasEmbed?.documentRelativePath === editorDraft.relativePath
          ? htmlCanvasEmbed
          : undefined;
      const embeddingApplied = { value: false };
      const safeRoot = prepareHtmlCardNodes(
        prepareYouTubeCards(sanitizeNode(root)),
        embedding,
        embeddingApplied,
      );
      const displayRoot = addFallbackMindmapTitle(
        safeRoot,
        editorDraft.markdown,
        editorDraft.title,
      );
      const nextMarkdownNodeSources = buildMarkdownNodeSourceMap(
        editorDraft.markdown,
        safeRoot,
      );
      const rootWithNoteCards = addMarkdownNodeNoteCards(
        displayRoot,
        nextMarkdownNodeSources,
        editorDraft.markdown,
        transformer.md,
      );
      await map.setData(rootWithNoteCards);
      if (codeBlocksAbort.signal.aborted) return;
      markdownNodeSourcesMarkdownRef.current = editorDraft.markdown;
      markdownNodeSourcesRef.current = nextMarkdownNodeSources;
      const selection = markdownEditorRef.current?.getSelection();
      if (selection)
        setActiveMapPath(
          findSourcePathForLine(
            selection.lineIndex,
            markdownNodeSourcesRef.current,
          ),
        );
      setSourceMapVersion((version) => version + 1);
      const cleanupCodeBlocks = await hydrateCodeBlocks(
        svg,
        theme,
        codeBlocksAbort.signal,
        {
          onCodeChange: (language, previous, next) =>
            codeBlockEditHandlerRef.current(language, previous, next),
          onMathVisualizationChange: (language, previous, next, nodePath) =>
            handleMathVisualizationChange(language, previous, next, nodePath),
          onTerminalCommand: (language, source, onResult) => {
            const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            terminalCommandResultsRef.current.set(id, onResult);
            setTerminalCommandConfirmation({ id, language, source });
          },
        },
      );
      if (codeBlocksAbort.signal.aborted) cleanupCodeBlocks();
      else codeBlocksCleanupRef.current = cleanupCodeBlocks;
      if (embedding && !embeddingApplied.value) setHtmlCanvasEmbed(null);
      setLastUpdated('已同步');
    }, 180);
    setLastUpdated('正在更新…');
    return () => {
      window.clearTimeout(timer);
      codeBlocksAbortRef.current?.abort();
      codeBlocksCleanupRef.current?.();
      codeBlocksAbortRef.current = null;
      codeBlocksCleanupRef.current = null;
    };
  }, [
    editorDraft.markdown,
    editorDraft.relativePath,
    htmlCanvasEmbed,
    theme,
    transformer,
  ]);

  useEffect(() => {
    const map = markmapRef.current;
    if (!map) return;

    const spacingHorizontal = activeNodeSpacing.horizontal;
    const spacingVertical = activeNodeSpacing.vertical;
    if (
      map.options.spacingHorizontal === spacingHorizontal &&
      map.options.spacingVertical === spacingVertical
    )
      return;

    const timer = window.setTimeout(() => {
      if (markmapRef.current !== map) return;
      const previousAutoFit = map.options.autoFit;
      const previousDuration = map.options.duration;
      void map
        .setData(undefined, {
          autoFit: false,
          duration: 0,
          spacingHorizontal,
          spacingVertical,
        })
        .catch((error) => {
          console.error('Failed to update mindmap spacing', error);
        })
        .finally(() => {
          if (markmapRef.current === map)
            map.setOptions({
              autoFit: previousAutoFit,
              duration: previousDuration,
            });
        });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [nodeSpacing]);

  const handleZoom = (factor: number) => {
    void markmapRef.current?.rescale(factor);
  };

  const selectedNodeSource = activeMapPath
    ? markdownNodeSourcesRef.current.get(activeMapPath)
    : undefined;
  const sourceMapIsCurrent =
    markdownNodeSourcesMarkdownRef.current === editorDraft.markdown;
  const canAddSelectedNode = Boolean(
    sourceMapIsCurrent &&
      selectedNodeSource &&
      selectedNodeSource.kind !== 'block',
  );
  const canDeleteSelectedNode = Boolean(
    sourceMapIsCurrent && selectedNodeSource,
  );
  const canEditSelectedNodeNote = Boolean(
    sourceMapIsCurrent && selectedNodeSource,
  );
  const selectedAiTarget =
    sourceMapIsCurrent &&
    activeMapPath &&
    selectedNodeSource &&
    selectedNodeSource.kind !== 'block'
      ? {
          nodeId: selectedNodeSource.id || null,
          nodePath: activeMapPath,
          label: selectedNodeSource.label,
        }
      : null;
  const isHtmlInteractiveCanvas =
    htmlCanvasEmbed?.documentRelativePath === editorDraft.relativePath;

  return (
    <main
      className="app-shell"
      data-theme={theme}
      data-map-style={mindmapStyle}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <path
                d="M16 8V3.5M16 24v4.5M11.5 16H4M20.5 16h7.5M12 11.5L6.5 8M20 11.5l5.5-3.5M12 20.5l-5.5 3.5M20 20.5l5.5 3.5"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
                opacity="0.45"
              />
              <circle
                cx="16"
                cy="3.5"
                r="1.3"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="16"
                cy="28.5"
                r="1.3"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="4"
                cy="16"
                r="1.3"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="28"
                cy="16"
                r="1.3"
                fill="currentColor"
                stroke="none"
              />
              <circle cx="6.5" cy="8" r="1" fill="currentColor" stroke="none" />
              <circle
                cx="25.5"
                cy="8"
                r="1"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="6.5"
                cy="24"
                r="1"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="25.5"
                cy="24"
                r="1"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="16"
                cy="16"
                r="9.2"
                stroke="currentColor"
                strokeWidth="0.9"
                strokeDasharray="2.5 2"
                opacity="0.35"
              />
              <path
                d="M21 10.5C21 7.8 18.8 6.2 16 6.2C12.8 6.2 10.8 8.2 10.8 11.2C10.8 15 15.2 16.2 17.2 17.6C19.8 19.4 21.2 20.8 21.2 23.2C21.2 26.2 18.8 27.2 16 27.2C12.8 27.2 10.8 25.4 10.8 22.8"
                stroke="currentColor"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M14.2 8.6C12.8 10.2 13.2 13.2 16 16C18.6 18.6 19.2 21.8 17.6 24.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                opacity="0.75"
              />
            </svg>
          </div>
          <div>
            <div className="brand-name">Seamind</div>
            <div
              className="document-name"
              title={editorDraft.relativePath ?? ''}
            >
              <span>{editorDraft.title || '未命名思维导图'}</span>
              <i className={editorDraft.dirty ? 'is-dirty' : ''} />
            </div>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="sync-state">
            <b />
            {lastUpdated}
          </span>
          <button
            type="button"
            className="theme-toggle-button"
            title={theme === 'light' ? '切换到暗色主题' : '切换到浅色主题'}
            aria-label={theme === 'light' ? '切换到暗色主题' : '切换到浅色主题'}
            onClick={() =>
              setTheme((current) => (current === 'light' ? 'dark' : 'light'))
            }
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} />
          </button>
          <button
            type="button"
            className="save-document-button"
            onClick={() => void saveDraft(true)}
            disabled={saveMessage === '正在保存…'}
          >
            保存
          </button>
          <button
            type="button"
            className={`terminal-toggle-button${terminalOpen ? ' is-active' : ''}`}
            aria-expanded={terminalOpen}
            aria-controls="seamind-terminal-panel"
            onClick={() => setTerminalOpen((open) => !open)}
          >
            终端
          </button>
          <span className="phase-badge">AI · SEAMIND</span>
          <button
            type="button"
            className="settings-button"
            onClick={openSettings}
          >
            模型设置
          </button>
        </div>
      </header>

      <section
        className={`workspace${sourceCollapsed ? ' is-source-collapsed' : ''}${libraryCollapsed ? ' is-library-collapsed' : ''}${aiCollapsed ? ' is-ai-collapsed' : ''}${terminalOpen ? ' is-terminal-open' : ''}${markdownFullscreen ? ' is-markdown-fullscreen' : ''}`}
        aria-label="Markdown 思维导图编辑器"
      >
        <LibraryPanel
          snapshot={librarySnapshot}
          documents={libraryDocuments}
          selectedPath={editorDraft.relativePath}
          collapsed={libraryCollapsed}
          categoryFilter={categoryFilter}
          query={libraryQuery}
          busy={libraryBusy}
          summarizeEpubOnImport={summarizeEpubOnImport}
          onSearch={setLibraryQuery}
          onChooseRoot={() => void chooseLibraryRoot()}
          onRefresh={() => void loadLibrary(false)}
          onCreateDocument={createNewDocument}
          onCreateWithAi={() => {
            setPrompt('');
            setGenerationError('');
            setGenerationDialogOpen(true);
          }}
          onImportEpub={() => void importEpub()}
          onToggleEpubSummary={setSummarizeEpubOnImport}
          onCreateCategory={() => {
            setCategoryDraft('');
            setLibraryError('');
            setCategoryDialogOpen(true);
          }}
          onSelectCategory={setCategoryFilter}
          onOpenDocument={(document) => void openMap(document)}
          onDeleteDocument={(document) => void deleteMap(document)}
          onToggleCollapse={() =>
            setLibraryCollapsed((collapsed) => !collapsed)
          }
        />

        <section
          className={`editor-pane${sourceCollapsed ? ' is-collapsed' : ''}`}
        >
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">01 / SOURCE</span>
              <h1>Markdown</h1>
            </div>
            {!sourceCollapsed && (
              <div className="source-header-actions">
                <div
                  className="markdown-mode-switch"
                  role="group"
                  aria-label="Markdown 查看模式"
                >
                  <button
                    type="button"
                    className={markdownPaneMode === 'edit' ? 'is-active' : ''}
                    aria-pressed={markdownPaneMode === 'edit'}
                    onClick={() => setMarkdownPaneMode('edit')}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className={
                      markdownPaneMode === 'preview' ? 'is-active' : ''
                    }
                    aria-pressed={markdownPaneMode === 'preview'}
                    onClick={() => setMarkdownPaneMode('preview')}
                  >
                    预览
                  </button>
                </div>
                <button
                  type="button"
                  className="source-history-button"
                  title="查看并恢复历史版本"
                  aria-label="查看历史版本"
                  disabled={!editorDraft.id || !editorDraft.relativePath}
                  onClick={() => void openDocumentHistory()}
                >
                  历史
                </button>
                <span className="format-badge">.md</span>
                <div className="source-insert-tools" aria-label="插入节点">
                  <button
                    type="button"
                    aria-label="插入 SVG 模板"
                    title="在 Markdown 末尾插入 SVG 模板"
                    onClick={insertSvgTemplate}
                  >
                    SVG
                  </button>
                  <button
                    type="button"
                    aria-label="导入 HTML 文件"
                    title="导入 HTML 文件并插入本地交互卡片"
                    disabled={htmlImportBusy}
                    onClick={() => void importHtmlAsset()}
                  >
                    {htmlImportBusy ? '…' : 'HTML'}
                  </button>
                </div>
                <button
                  type="button"
                  className="markdown-fullscreen-button"
                  aria-label={
                    markdownFullscreen ? '退出 Markdown 全屏' : 'Markdown 全屏'
                  }
                  title={
                    markdownFullscreen ? '退出全屏（Esc）' : 'Markdown 全屏'
                  }
                  aria-pressed={markdownFullscreen}
                  onClick={() =>
                    setMarkdownFullscreen((fullscreen) => !fullscreen)
                  }
                >
                  {markdownFullscreen ? '退出' : '全屏'}
                </button>
              </div>
            )}
            <button
              type="button"
              className="pane-collapse-button"
              title={
                sourceCollapsed
                  ? '展开 Markdown 源文本栏'
                  : '收起 Markdown 源文本栏'
              }
              aria-label={
                sourceCollapsed
                  ? '展开 Markdown 源文本栏'
                  : '收起 Markdown 源文本栏'
              }
              aria-expanded={!sourceCollapsed}
              aria-controls="markdown-pane-content"
              onClick={() => setSourceCollapsed((collapsed) => !collapsed)}
            >
              <Icon name={sourceCollapsed ? 'expand' : 'collapse'} />
            </button>
          </div>
          <div className="document-metadata">
            <label className="metadata-title-field">
              标题
              <input
                value={editorDraft.title}
                onChange={(event) => patchDraft({ title: event.target.value })}
                aria-label="思维导图标题"
                maxLength={120}
              />
            </label>
            <div className="metadata-grid">
              <label>
                分类文件夹
                <input
                  list="library-category-options"
                  value={editorDraft.category}
                  onChange={(event) =>
                    patchDraft({ category: event.target.value })
                  }
                  placeholder="例如：学习/AI"
                  aria-label="思维导图分类文件夹"
                />
                <datalist id="library-category-options">
                  {librarySnapshot?.categories.map((category) => (
                    <option value={category} key={category} />
                  ))}
                </datalist>
              </label>
              <label>
                类型
                <input
                  value={editorDraft.mapType}
                  onChange={(event) =>
                    patchDraft({ mapType: event.target.value })
                  }
                  placeholder="例如：读书笔记"
                  aria-label="思维导图类型"
                  maxLength={40}
                />
              </label>
            </div>
            <label className="metadata-tags-field">
              标签
              <input
                value={editorDraft.tags}
                onChange={(event) => patchDraft({ tags: event.target.value })}
                placeholder="用逗号分隔，例如：AI, 入门"
                aria-label="思维导图标签"
              />
            </label>
          </div>
          <div id="markdown-pane-content" className="markdown-pane-content">
            <label
              className="editor-label"
              htmlFor="markdown-editor"
              hidden={markdownPaneMode !== 'edit'}
            >
              编辑源文本
            </label>
            <div
              className="markdown-editor-frame"
              hidden={markdownPaneMode !== 'edit'}
            >
              <MarkdownEditor
                key={markdownEditorSession}
                ref={markdownEditorRef}
                id="markdown-editor"
                value={editorDraft.markdown}
                onChange={handleMarkdownEditorChange}
                onSelectionChange={handleMarkdownSelectionChange}
              />
            </div>
            {markdownPaneMode === 'preview' && (
              <MarkdownPreview
                html={markdownPreviewHtml}
                source={markdownPreviewSource}
                theme={theme}
              />
            )}
          </div>
          <div className="editor-footer">
            <span>{saveMessage}</span>
            <span>{editorDraft.markdown.length} 字符</span>
          </div>
        </section>

        <section className="preview-pane">
          <div className="pane-heading preview-heading">
            <div className="preview-title">
              <span className="pane-kicker">02 / CANVAS</span>
              <h1>思维导图</h1>
            </div>
            <div className="canvas-tools" role="toolbar" aria-label="画布工具">
              <div className="canvas-tool-actions">
                {isHtmlInteractiveCanvas && (
                  <button
                    type="button"
                    className="html-canvas-mode-button"
                    onClick={() => setHtmlCanvasEmbed(null)}
                  >
                    退出 HTML 交互
                  </button>
                )}
                <button
                  type="button"
                  className="canvas-node-action"
                  title="添加子节点"
                  aria-label="添加子节点"
                  disabled={!canAddSelectedNode}
                  onClick={() => applySelectedNodeOperation('child')}
                >
                  子级＋
                </button>
                <button
                  type="button"
                  className="canvas-node-action"
                  title="添加同级节点"
                  aria-label="添加同级节点"
                  disabled={!canAddSelectedNode}
                  onClick={() => applySelectedNodeOperation('sibling')}
                >
                  同级＋
                </button>
                <button
                  type="button"
                  className="canvas-node-action"
                  title="删除所选节点及其子节点，可用撤销恢复"
                  aria-label="删除所选节点"
                  disabled={!canDeleteSelectedNode}
                  onClick={() => applySelectedNodeOperation('delete')}
                >
                  删除
                </button>
                <button
                  type="button"
                  className="canvas-node-action"
                  title="编辑所选节点的 Markdown 备注"
                  aria-label="编辑节点备注"
                  disabled={!canEditSelectedNodeNote}
                  onClick={openSelectedNodeNote}
                >
                  备注
                </button>
                <span className="tool-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="canvas-node-action"
                  title="撤销"
                  aria-label="撤销"
                  onClick={() => markdownEditorRef.current?.undo()}
                >
                  撤销
                </button>
                <button
                  type="button"
                  className="canvas-node-action"
                  title="重做"
                  aria-label="重做"
                  onClick={() => markdownEditorRef.current?.redo()}
                >
                  重做
                </button>
              </div>
              <div className="canvas-tool-view">
                <details className="canvas-help">
                  <summary
                    title="查看画布操作说明"
                    aria-label={
                      isHtmlInteractiveCanvas
                        ? '查看 HTML 交互模式说明'
                        : '查看画布操作说明'
                    }
                  >
                    <span
                      className={`hint-dot${isHtmlInteractiveCanvas ? ' is-active' : ''}`}
                      aria-hidden="true"
                    />
                    {isHtmlInteractiveCanvas ? 'HTML 交互' : '帮助'}
                  </summary>
                  <div
                    className="canvas-help-popover"
                    role="group"
                    aria-label="画布操作说明"
                  >
                    <p>
                      <strong>画布</strong>拖动平移 · 滚轮缩放 · 实时预览
                    </p>
                    <p>
                      <strong>节点</strong>
                      双击编辑 · Enter 换行 · Ctrl+Enter 添加同级 · Tab 添加子级
                    </p>
                    <p>
                      <strong>自动换行</strong>约 20
                      个汉字；短文本按内容宽度显示
                    </p>
                    <p>
                      <strong>内容</strong>支持
                      Markdown、数学公式、Mermaid、ECharts 和 Python 代码围栏
                    </p>
                    {isHtmlInteractiveCanvas && (
                      <p className="canvas-help-active">
                        <strong>HTML 交互</strong>
                        组件区域接收鼠标操作；点击节点顶部或工具栏中的退出按钮可恢复画布操作。
                      </p>
                    )}
                  </div>
                </details>
                <div
                  className="canvas-spacing-control"
                  role="group"
                  aria-label="节点水平和垂直间距"
                  title="分别调整水平和垂直间距；默认值为 56 和 14"
                >
                  <label className="canvas-spacing-axis" title="水平节点间距">
                    <span>横</span>
                    <input
                      type="range"
                      min={28}
                      max={112}
                      step={4}
                      value={activeNodeSpacing.horizontal}
                      aria-label="水平节点距离"
                      aria-valuetext={`${activeNodeSpacing.horizontal}`}
                      onChange={(event) =>
                        setNodeSpacing({
                          ...activeNodeSpacing,
                          horizontal: Number(event.target.value),
                        })
                      }
                    />
                    <output>{activeNodeSpacing.horizontal}</output>
                  </label>
                  <label className="canvas-spacing-axis" title="垂直节点间距">
                    <span>竖</span>
                    <input
                      type="range"
                      min={7}
                      max={28}
                      step={1}
                      value={activeNodeSpacing.vertical}
                      aria-label="垂直节点距离"
                      aria-valuetext={`${activeNodeSpacing.vertical}`}
                      onChange={(event) =>
                        setNodeSpacing({
                          ...activeNodeSpacing,
                          vertical: Number(event.target.value),
                        })
                      }
                    />
                    <output>{activeNodeSpacing.vertical}</output>
                  </label>
                </div>
                <span className="tool-divider" aria-hidden="true" />
                <button
                  type="button"
                  title="缩小"
                  aria-label="缩小"
                  onClick={() => handleZoom(0.82)}
                >
                  <Icon name="minus" />
                </button>
                <button
                  type="button"
                  title="放大"
                  aria-label="放大"
                  onClick={() => handleZoom(1.22)}
                >
                  <Icon name="plus" />
                </button>
                <span className="tool-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="fit-button"
                  title="适应画布"
                  aria-label="适应画布"
                  onClick={() => void markmapRef.current?.fit()}
                >
                  <Icon name="fit" />
                  <span>适应画布</span>
                </button>
                <div className="map-style-picker" ref={mindmapStylePickerRef}>
                  <button
                    type="button"
                    className="map-style-trigger"
                    aria-haspopup="menu"
                    aria-expanded={mindmapStyleMenuOpen}
                    aria-label={`思维导图样式：${mindmapStyles.find((style) => style.id === mindmapStyle)?.label}，点击切换`}
                    onClick={() => setMindmapStyleMenuOpen((open) => !open)}
                  >
                    <span
                      className={`map-style-trigger-swatch is-${mindmapStyle}`}
                      aria-hidden="true"
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>样式</span>
                    <span className="map-style-current">
                      {
                        mindmapStyles.find((style) => style.id === mindmapStyle)
                          ?.label
                      }
                    </span>
                    <span className="map-style-caret" aria-hidden="true">
                      ⌄
                    </span>
                  </button>
                  {mindmapStyleMenuOpen && (
                    <div
                      className="map-style-menu"
                      role="menu"
                      aria-label="选择思维导图样式"
                    >
                      {mindmapStyles.map((style) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={mindmapStyle === style.id}
                          className={`map-style-option${mindmapStyle === style.id ? ' is-selected' : ''}`}
                          key={style.id}
                          onClick={() => {
                            setMindmapStyle(style.id);
                            setMindmapStyleMenuOpen(false);
                          }}
                        >
                          <span
                            className={`map-style-preview is-${style.id}`}
                            aria-hidden="true"
                          >
                            <i />
                            <i />
                            <i />
                          </span>
                          <span className="map-style-option-copy">
                            <span className="map-style-title-row">
                              <strong>{style.label}</strong>
                              <span className="map-style-badge">
                                {style.badge}
                              </span>
                            </span>
                            <span className="map-style-summary">
                              {style.summary}
                            </span>
                            <span className="map-style-best-for">
                              <em>适用：</em>
                              {style.bestFor}
                            </span>
                          </span>
                          <span className="map-style-check" aria-hidden="true">
                            {mindmapStyle === style.id ? '✓' : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="canvas-wrap">
            <svg
              ref={svgRef}
              className="mindmap-canvas"
              aria-label="Markdown 思维导图预览"
            />
            <div className="canvas-corner">
              MARKMAP <span>0.18</span>
            </div>
          </div>
        </section>

        <aside
          id="ai-sidebar"
          className={`ai-sidebar${aiCollapsed ? ' is-collapsed' : ''}`}
          aria-label="LLM 面板"
        >
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">03 / CO-PILOT</span>
              <h1>LLM</h1>
            </div>
            {!aiCollapsed && (
              <div className="ai-model-picker" ref={modelPickerRef}>
                <button
                  type="button"
                  className="ai-model-badge ai-model-picker-trigger"
                  aria-haspopup="dialog"
                  aria-expanded={modelPickerOpen}
                  aria-label={'选择 API 模型，当前为 ' + providerSettings.model}
                  title="选择当前 API 提供的模型"
                  onClick={toggleModelPicker}
                >
                  <span className="model-dot" />
                  <span>API · {providerLabel(providerSettings.baseUrl)}</span>
                  <strong>{providerSettings.model || '未配置'}</strong>
                  <span className="ai-model-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </button>
                {modelPickerOpen && (
                  <div
                    className="ai-model-menu"
                    role="dialog"
                    aria-label="选择 API 模型"
                  >
                    <div className="ai-model-menu-heading">
                      <strong>选择 API 模型</strong>
                      <button
                        type="button"
                        className="ai-model-refresh"
                        disabled={providerModelsLoading}
                        onClick={() => void loadProviderModels()}
                      >
                        {providerModelsLoading ? '读取中…' : '刷新列表'}
                      </button>
                    </div>
                    <small className="ai-model-menu-endpoint">
                      {providerSettings.baseUrl}
                    </small>
                    <input
                      className="ai-model-search"
                      type="search"
                      value={providerModelQuery}
                      onChange={(event) =>
                        setProviderModelQuery(event.target.value)
                      }
                      placeholder="筛选模型"
                      aria-label="筛选模型"
                    />
                    {providerModelsLoading && (
                      <div className="ai-model-menu-status">
                        正在读取 API 模型…
                      </div>
                    )}
                    {!providerModelsLoading && providerModelsError && (
                      <div className="ai-model-menu-error" role="status">
                        {providerModelsError}
                      </div>
                    )}
                    {!providerModelsLoading &&
                      providerModels.length === 0 &&
                      !providerModelsError && (
                        <div className="ai-model-menu-status">
                          API 尚未返回模型列表，可在下方手动输入。
                        </div>
                      )}
                    <div
                      className="ai-model-options"
                      role="listbox"
                      aria-label="API 可用模型"
                    >
                      {providerModels
                        .filter((model) =>
                          model
                            .toLowerCase()
                            .includes(providerModelQuery.trim().toLowerCase()),
                        )
                        .map((model) => (
                          <button
                            key={model}
                            type="button"
                            role="option"
                            aria-selected={providerSettings.model === model}
                            className={
                              providerSettings.model === model
                                ? 'is-selected'
                                : ''
                            }
                            onClick={() => chooseProviderModel(model)}
                          >
                            {model}
                          </button>
                        ))}
                    </div>
                    {!providerModelsLoading &&
                      providerModels.length > 0 &&
                      !providerModels.some((model) =>
                        model
                          .toLowerCase()
                          .includes(providerModelQuery.trim().toLowerCase()),
                      ) && (
                        <div className="ai-model-menu-status">
                          没有匹配的模型。
                        </div>
                      )}
                    <form
                      className="ai-model-manual"
                      onSubmit={(event) => {
                        event.preventDefault();
                        chooseProviderModel(manualProviderModel);
                      }}
                    >
                      <label htmlFor="manual-api-model">手动输入模型 ID</label>
                      <div>
                        <input
                          id="manual-api-model"
                          value={manualProviderModel}
                          onChange={(event) =>
                            setManualProviderModel(event.target.value)
                          }
                          maxLength={200}
                          placeholder="例如 deepseek-chat"
                        />
                        <button
                          type="submit"
                          disabled={!manualProviderModel.trim()}
                        >
                          使用
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              className="pane-collapse-button"
              title={aiCollapsed ? '展开 LLM 栏' : '收起 LLM 栏'}
              aria-label={aiCollapsed ? '展开 LLM 栏' : '收起 LLM 栏'}
              aria-expanded={!aiCollapsed}
              aria-controls="ai-sidebar"
              onClick={() => setAiCollapsed((collapsed) => !collapsed)}
            >
              <Icon name={aiCollapsed ? 'expand' : 'collapse'} />
            </button>
          </div>
          <div className="ai-content">
            <div
              className="ai-mode-switch"
              role="tablist"
              aria-label="LLM 分析模式"
            >
              <button
                type="button"
                role="tab"
                aria-selected={aiMode === 'drilldown'}
                className={aiMode === 'drilldown' ? 'is-active' : ''}
                onClick={() => setAiMode('drilldown')}
              >
                节点下探
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={aiMode === 'visualization'}
                className={aiMode === 'visualization' ? 'is-active' : ''}
                onClick={() => setAiMode('visualization')}
              >
                可视化分析
              </button>
            </div>
            <div
              className="ai-mode-content ai-agent-mode"
              hidden={aiMode !== 'drilldown'}
            >
              <AgentPanel
                mode="drilldown"
                provider={providerSettings}
                providerLabel={providerLabel(providerSettings.baseUrl)}
                capabilities={agentCapabilities}
                target={selectedAiTarget}
                mapTitle={editorDraft.title}
                mapMarkdown={editorDraft.markdown}
                currentRevision={editorDraft.revision}
                onApplyProposal={applyAgentProposal}
                onUndoProposal={undoAgentProposal}
              />
            </div>
            <div
              className="ai-mode-content ai-agent-mode"
              hidden={aiMode !== 'visualization'}
            >
              <AgentPanel
                mode="visualization"
                provider={providerSettings}
                providerLabel={providerLabel(providerSettings.baseUrl)}
                capabilities={agentCapabilities}
                target={selectedAiTarget}
                mapTitle={editorDraft.title}
                mapMarkdown={editorDraft.markdown}
                currentRevision={editorDraft.revision}
                onApplyProposal={applyAgentProposal}
                onUndoProposal={undoAgentProposal}
              />
            </div>
          </div>
        </aside>

        {terminalOpen && (
          <Suspense
            fallback={
              <div
                id="seamind-terminal-panel"
                className="seamind-terminal-loading"
              >
                正在加载终端…
              </div>
            }
          >
            <div id="seamind-terminal-panel">
              <TerminalPanel
                key={librarySnapshot?.rootPath ?? 'default-terminal-directory'}
                cwd={librarySnapshot?.rootPath ?? ''}
                theme={theme}
                pendingCommand={pendingTerminalCommand}
                onCommandSubmitted={(id) =>
                  setPendingTerminalCommand((current) =>
                    current?.id === id ? null : current,
                  )
                }
                onCommandOutput={(id, output) => {
                  const callback = terminalCommandResultsRef.current.get(id);
                  if (!callback) return;
                  terminalCommandResultsRef.current.delete(id);
                  callback(output);
                }}
                onClose={() => {
                  const request = pendingTerminalCommand;
                  if (request) {
                    const callback = terminalCommandResultsRef.current.get(
                      request.id,
                    );
                    terminalCommandResultsRef.current.delete(request.id);
                    callback?.('终端已关闭，命令未执行。');
                  }
                  setPendingTerminalCommand(null);
                  setTerminalOpen(false);
                }}
              />
            </div>
          </Suspense>
        )}
      </section>

      <footer className="statusbar">
        <span>
          <i className="status-indicator" />
          阶段 4 · 本地文件库
        </span>
        <span
          className="status-library-path"
          title={librarySnapshot?.rootPath ?? ''}
        >
          {librarySnapshot?.rootPath ?? '文件库目录尚未设置'}
        </span>
      </footer>

      {epubDropActive && (
        <div className="epub-drop-overlay" role="status" aria-live="polite">
          <div>
            <strong>导入 EPUB 目录</strong>
            <span>松开鼠标，解析目录并生成 Markdown 草稿</span>
          </div>
        </div>
      )}

      {libraryError && (
        <div className="library-error" role="alert">
          <span>{libraryError}</span>
          <button
            type="button"
            onClick={() => setLibraryError('')}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      )}

      {historyOpen && (
        <div
          className="settings-backdrop history-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !historyBusy)
              closeDocumentHistory();
          }}
        >
          <section
            className="settings-dialog history-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-history-title"
          >
            <div className="settings-heading history-heading">
              <div>
                <span className="pane-kicker">DOCUMENT HISTORY</span>
                <h2 id="document-history-title">版本回溯</h2>
                <p>{editorDraft.title}</p>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭版本历史"
                disabled={historyBusy}
                onClick={closeDocumentHistory}
              >
                ×
              </button>
            </div>
            <div className="history-layout">
              <div className="history-version-list" aria-label="历史版本列表">
                {historyVersions.length === 0 && !historyLoading && (
                  <div className="history-empty">
                    暂无历史版本。文件打开后会建立初始快照。
                  </div>
                )}
                {historyVersions.map((version) => (
                  <button
                    type="button"
                    key={version.versionId}
                    className={`history-version-item${historyPreview?.versionId === version.versionId ? ' is-selected' : ''}`}
                    aria-pressed={
                      historyPreview?.versionId === version.versionId
                    }
                    onClick={() => void loadHistoryVersion(version.versionId)}
                  >
                    <strong>{formatHistoryTimestamp(version.createdAt)}</strong>
                    <span>
                      {historySourceLabel(version.source)} ·{' '}
                      {formatHistoryBytes(version.markdownBytes)}
                    </span>
                    <small>{version.title}</small>
                  </button>
                ))}
              </div>
              <div className="history-preview-column">
                <div className="history-preview-heading">
                  <strong>
                    {historyPreview
                      ? `${historyPreview.title} · ${historySourceLabel(historyPreview.source)}`
                      : '版本内容预览'}
                  </strong>
                  {historyPreview && (
                    <span>
                      {formatHistoryTimestamp(historyPreview.createdAt)}
                    </span>
                  )}
                </div>
                {historyLoading ? (
                  <div className="history-preview-message" role="status">
                    正在读取版本…
                  </div>
                ) : historyPreview ? (
                  <div className="history-markdown-preview">
                    <MarkdownPreview
                      html={historyPreviewHtml}
                      source={historyPreview.markdown}
                      theme={theme}
                    />
                  </div>
                ) : (
                  <div className="history-preview-message">
                    选择左侧版本查看当时保存的 Markdown。
                  </div>
                )}
              </div>
            </div>
            {historyError && (
              <div className="history-error" role="alert">
                {historyError}
              </div>
            )}
            <div className="settings-footer history-footer">
              <span>恢复会保留当前版本，并新增一条恢复记录。</span>
              <button
                type="button"
                className="text-button"
                disabled={historyBusy}
                onClick={closeDocumentHistory}
              >
                关闭
              </button>
              <button
                type="button"
                className="done-button"
                disabled={!historyPreview || historyBusy || historyLoading}
                onClick={() => void restoreHistoryVersion()}
              >
                {historyBusy ? '正在恢复…' : '恢复到此版本'}
              </button>
            </div>
          </section>
        </div>
      )}

      {htmlPreview && (
        <div
          className="html-preview-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeHtmlPreview();
          }}
        >
          <section
            className="html-preview-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="html-preview-title"
          >
            <div className="html-preview-heading">
              <div>
                <span className="pane-kicker">LOCAL HTML COMPONENT</span>
                <h2 id="html-preview-title">{htmlPreview.title}</h2>
              </div>
              <div className="html-preview-actions">
                <button
                  type="button"
                  className="html-preview-embed-button"
                  disabled={!htmlPreviewSrc || Boolean(htmlPreviewError)}
                  onClick={embedHtmlPreviewInCanvas}
                >
                  在画布中交互
                </button>
                <button
                  type="button"
                  className="dialog-close"
                  aria-label="关闭 HTML 预览"
                  onClick={closeHtmlPreview}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="html-preview-meta">
              本地资源 · {htmlPreview.width} × {htmlPreview.height} 卡片
            </div>
            <div
              className="html-preview-content"
              aria-busy={!htmlPreviewSrc && !htmlPreviewError}
            >
              {htmlPreviewError ? (
                <div className="html-preview-message" role="alert">
                  {htmlPreviewError}
                </div>
              ) : htmlPreviewSrc ? (
                <iframe
                  className="html-preview-frame"
                  title={`${htmlPreview.title}交互预览`}
                  src={htmlPreviewSrc}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="html-preview-message" role="status">
                  正在打开本地 HTML 组件…
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {youtubePreview && (
        <div
          className="youtube-player-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeYouTubePreview();
          }}
        >
          <section
            className="youtube-player-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="youtube-player-title"
          >
            <div className="youtube-player-heading">
              <div>
                <span className="pane-kicker">YOUTUBE PLAYER</span>
                <h2 id="youtube-player-title">{youtubePreview.title}</h2>
              </div>
              <button
                ref={youtubeCloseButtonRef}
                type="button"
                className="dialog-close youtube-player-close"
                aria-label="关闭 YouTube 播放器"
                onClick={closeYouTubePreview}
              >
                ×
              </button>
            </div>
            <div className="youtube-player-stage">
              {youtubePlaybackMode === 'embed' &&
                youtubeFrameStatus === 'loading' && (
                  <div className="youtube-player-loading" role="status">
                    {youtubeLocalPlaybackBusy
                      ? '正在解析可播放的 MP4 媒体流…'
                      : '正在连接 YouTube 播放器…'}
                  </div>
                )}
              {youtubePlaybackMode === 'embed' &&
                (youtubeFrameStatus === 'error' ||
                  youtubeFrameStatus === 'timeout') && (
                  <div className="youtube-player-notice" role="alert">
                    {youtubeLocalPlaybackError ||
                      (youtubeFrameStatus === 'timeout'
                        ? 'YouTube 播放器连接超时，可以打开视频页面继续观看。'
                        : `${youtubePlayerErrorMessage(youtubePlayerError)} 可以打开视频页面继续观看。`)}
                  </div>
                )}
              <iframe
                key={youtubePreview.id}
                ref={youtubeFrameRef}
                title={`播放 ${youtubePreview.title}`}
                src={youtubePreview.src}
                allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
                style={{
                  display: youtubePlaybackMode === 'embed' ? 'block' : 'none',
                }}
                onError={() => setYoutubeFrameStatus('error')}
              />
              {youtubePlaybackMode === 'embed' &&
                canTryLocalYouTubePlayback && (
                  <div className="youtube-player-actions">
                    <button
                      type="button"
                      className="youtube-player-action"
                      onClick={() => void tryLocalYouTubePlayback()}
                      disabled={youtubeLocalPlaybackBusy}
                    >
                      {youtubeLocalPlaybackBusy
                        ? '正在解析…'
                        : '尝试本地 HTML5 播放'}
                    </button>
                    <button
                      type="button"
                      className="youtube-player-action"
                      onClick={() => void tryNativeYouTubePlayback()}
                      disabled={youtubeNativePlaybackBusy}
                    >
                      {youtubeNativePlaybackBusy
                        ? '正在启动 mpv…'
                        : '用 mpv 外部播放'}
                    </button>
                  </div>
                )}
              {youtubePlaybackMode === 'local' && youtubeLocalSource && (
                <video
                  ref={youtubeVideoRef}
                  className="youtube-player-video"
                  src={youtubeLocalSource}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    if (
                      youtubePreview.startSeconds > 0 &&
                      Number.isFinite(video.duration) &&
                      youtubePreview.startSeconds < video.duration
                    )
                      video.currentTime = youtubePreview.startSeconds;
                    setYoutubeFrameStatus('ready');
                  }}
                  onPlay={() => setYoutubeFrameStatus('playing')}
                  onPause={() => setYoutubeFrameStatus('paused')}
                  onWaiting={() => setYoutubeFrameStatus('buffering')}
                  onEnded={() => setYoutubeFrameStatus('ended')}
                  onError={() => {
                    setYoutubeLocalPlaybackError(
                      '浏览器无法播放该媒体流，或者播放地址已过期。',
                    );
                    setYoutubeFrameStatus('error');
                  }}
                />
              )}
              {youtubePlaybackMode === 'local' &&
                youtubeFrameStatus === 'error' && (
                  <div className="youtube-player-notice" role="alert">
                    <div className="youtube-player-notice-content">
                      <span>
                        {youtubeLocalPlaybackError ||
                          '本地媒体流无法在当前 WebView 播放。'}
                      </span>
                      <button
                        type="button"
                        className="youtube-player-action"
                        onClick={() => void tryNativeYouTubePlayback()}
                        disabled={youtubeNativePlaybackBusy}
                      >
                        {youtubeNativePlaybackBusy
                          ? '正在启动 mpv…'
                          : '用 mpv 外部播放'}
                      </button>
                      <button
                        type="button"
                        className="youtube-player-action"
                        onClick={returnToYouTubeEmbed}
                      >
                        返回 YouTube 内嵌播放
                      </button>
                    </div>
                  </div>
                )}
            </div>
            <div className="youtube-player-meta">
              <span
                className="youtube-player-state"
                data-state={
                  youtubeNativePlaybackLaunched ? 'ready' : youtubeFrameStatus
                }
                aria-live="polite"
              >
                <span className="youtube-player-state-dot" aria-hidden="true" />
                {youtubeNativePlaybackLaunched
                  ? 'mpv 已启动'
                  : youtubePlaybackStateLabels[youtubeFrameStatus]}
              </span>
              <span>
                {youtubePlaybackMode === 'local'
                  ? '本地 HTML5 媒体播放'
                  : '视频由 YouTube 提供'}
              </span>
              {youtubePlaybackMode === 'local' && (
                <button
                  type="button"
                  className="youtube-player-action youtube-player-return"
                  onClick={returnToYouTubeEmbed}
                >
                  返回内嵌播放
                </button>
              )}
              <a
                href={`https://www.youtube.com/watch?v=${youtubePreview.id}${
                  youtubePreview.startSeconds > 0
                    ? `&t=${youtubePreview.startSeconds}s`
                    : ''
                }`}
                target="_blank"
                rel="noopener noreferrer"
              >
                在 YouTube 打开
              </a>
            </div>
          </section>
        </div>
      )}

      {generationDialogOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isGenerating)
              setGenerationDialogOpen(false);
          }}
        >
          <form
            className="settings-dialog ai-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-create-title"
            onSubmit={(event) => {
              event.preventDefault();
              void handleGenerate();
            }}
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">AI · NEW MAP</span>
                <h2 id="ai-create-title">AI 新建思维导图</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭 AI 新建窗口"
                disabled={isGenerating}
                onClick={() => setGenerationDialogOpen(false)}
              >
                ×
              </button>
            </div>
            <label className="settings-field" htmlFor="ai-prompt">
              构想主题或内容梗概
              <textarea
                id="ai-prompt"
                className="ai-prompt-textarea"
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setGenerationError('');
                }}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === 'Enter'
                  ) {
                    event.preventDefault();
                    void handleGenerate();
                  }
                }}
                rows={5}
                maxLength={4000}
                autoFocus
                placeholder="例如：梳理大语言模型的预训练、指令微调、对齐与推理优化全流程…"
              />
            </label>
            <div className="ai-suggestions">
              <span className="suggestions-title">快速灵感主题</span>
              <div className="suggestion-tags">
                {promptSuggestions.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion}
                    onClick={() => {
                      setPrompt(suggestion);
                      setGenerationError('');
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
            {generationError && (
              <p className="generation-error" role="alert">
                {generationError}
              </p>
            )}
            <div className="settings-footer">
              <span>生成结果将创建为新的思维导图文件</span>
              <button
                type="button"
                className="text-button"
                disabled={isGenerating}
                onClick={() => setGenerationDialogOpen(false)}
              >
                取消
              </button>
              <button
                className="done-button"
                type="submit"
                disabled={isGenerating || !prompt.trim()}
              >
                {isGenerating ? '正在生成…' : '生成并保存'}
              </button>
            </div>
          </form>
        </div>
      )}

      {categoryDialogOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setCategoryDialogOpen(false);
          }}
        >
          <form
            className="settings-dialog category-dialog"
            onSubmit={(event) => void createCategory(event)}
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">FOLDER</span>
                <h2>新建分类文件夹</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭"
                onClick={() => setCategoryDialogOpen(false)}
              >
                ×
              </button>
            </div>
            <label className="settings-field">
              分类名称
              <input
                autoFocus
                value={categoryDraft}
                onChange={(event) => setCategoryDraft(event.target.value)}
                placeholder="例如：学习/人工智能"
              />
            </label>
            <p className="settings-note">
              使用斜杠可以一次创建多级分类，例如“工作/产品规划”。
            </p>
            <div className="settings-footer">
              <span>分类会对应文件库中的文件夹</span>
              <button
                type="submit"
                className="done-button"
                disabled={!categoryDraft.trim()}
              >
                创建
              </button>
            </div>
          </form>
        </div>
      )}

      {settingsOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">PROVIDER</span>
                <h2 id="settings-title">模型连接设置</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭设置"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>
            <label className="settings-field">
              兼容接口地址
              <input
                value={providerSettings.baseUrl}
                onChange={(event) =>
                  setProviderSettings({
                    ...providerSettings,
                    baseUrl: event.target.value,
                  })
                }
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label className="settings-field">
              模型名称
              <input
                value={providerSettings.model}
                onChange={(event) =>
                  setProviderSettings({
                    ...providerSettings,
                    model: event.target.value,
                  })
                }
                placeholder="gpt-4o-mini"
              />
            </label>
            <div className="secret-status">
              <span className={apiKeySaved ? 'key-dot is-saved' : 'key-dot'} />
              {apiKeySaved ? 'API 密钥已安全保存' : '尚未保存 API 密钥'}
            </div>
            <form
              className="key-form"
              onSubmit={(event) => {
                void saveApiKey(event);
              }}
            >
              <label className="settings-field">
                API 密钥
                <input
                  type="password"
                  autoComplete="new-password"
                  value={apiKeyDraft}
                  onChange={(event) => setApiKeyDraft(event.target.value)}
                  placeholder={
                    apiKeySaved ? '输入新密钥以替换' : '粘贴 API 密钥'
                  }
                />
              </label>
              <div className="settings-actions">
                {apiKeySaved && (
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() => void removeApiKey()}
                  >
                    删除已保存密钥
                  </button>
                )}
                <button
                  type="submit"
                  className="save-key-button"
                  disabled={!apiKeyDraft.trim()}
                >
                  保存密钥
                </button>
              </div>
            </form>
            <p className="settings-note">
              密钥只交给桌面端 Rust 后端，并存入 Windows
              凭据管理器；接口地址和模型名保存在本机浏览器存储中。
            </p>
            {settingsMessage && (
              <p className="settings-message" role="status">
                {settingsMessage}
              </p>
            )}
            <div className="settings-footer">
              <span>支持 OpenAI Chat Completions 兼容接口</span>
              <button
                type="button"
                className="done-button"
                onClick={() => setSettingsOpen(false)}
              >
                完成
              </button>
            </div>
          </section>
        </div>
      )}
      {nodeNoteDialog && (
        <div className="settings-backdrop node-note-backdrop">
          <section
            className="settings-dialog node-note-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="node-note-title"
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">NODE NOTE · MARKDOWN</span>
                <h2 id="node-note-title">{nodeNoteDialog.label} · 备注</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭节点备注"
                onClick={() => setNodeNoteDialog(null)}
              >
                ×
              </button>
            </div>
            <label
              className="node-note-editor-label"
              htmlFor="node-note-editor"
            >
              支持 Markdown、代码块和数学公式；备注会保存在导图的 YAML
              frontmatter 中。
            </label>
            <textarea
              id="node-note-editor"
              className="node-note-editor"
              value={nodeNoteDialog.markdown}
              maxLength={MAX_MARKDOWN_NODE_NOTE_CHARS}
              onChange={(event) =>
                setNodeNoteDialog((dialog) =>
                  dialog
                    ? { ...dialog, markdown: event.target.value, error: '' }
                    : dialog,
                )
              }
              placeholder={'补充节点说明…\n\n例如：$E = mc^2$'}
              autoFocus
            />
            <div className="node-note-preview-wrap">
              <div className="node-note-preview-heading">预览</div>
              {nodeNotePreviewHtml ? (
                <div
                  className="node-note-preview markdown-body"
                  dangerouslySetInnerHTML={{ __html: nodeNotePreviewHtml }}
                />
              ) : (
                <div className="node-note-preview-empty">备注为空</div>
              )}
            </div>
            {nodeNoteDialog.error && (
              <p className="node-note-error" role="alert">
                {nodeNoteDialog.error}
              </p>
            )}
            <div className="node-note-actions">
              <span>
                {nodeNoteDialog.markdown.length} /{' '}
                {MAX_MARKDOWN_NODE_NOTE_CHARS.toLocaleString()}
              </span>
              <button
                type="button"
                className="agent-reject-button"
                onClick={() => setNodeNoteDialog(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="agent-apply-button"
                onClick={saveSelectedNodeNote}
              >
                保存备注
              </button>
            </div>
          </section>
        </div>
      )}
      {cliAgentProposal && (
        <div className="settings-backdrop agent-cli-approval-backdrop">
          <section
            className="settings-dialog agent-cli-approval-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-cli-approval-title"
          >
            <div className="agent-cli-approval-kicker">CLI · SEAMIND MCP</div>
            <h2 id="agent-cli-approval-title">确认导图修改</h2>
            <p>
              {cliAgentProposal.proposal.operation === 'rename'
                ? `将「${cliAgentProposal.proposal.previousLabel}」改为「${cliAgentProposal.proposal.nextLabel}」`
                : cliAgentProposal.proposal.operation === 'add_child'
                  ? `在「${cliAgentProposal.proposal.previousLabel}」下添加「${cliAgentProposal.proposal.nextLabel}」`
                  : cliAgentProposal.proposal.operation === 'add_sibling'
                    ? `在「${cliAgentProposal.proposal.previousLabel}」旁添加「${cliAgentProposal.proposal.nextLabel}」`
                    : cliAgentProposal.proposal.operation === 'add_branch'
                      ? `在「${cliAgentProposal.proposal.previousLabel}」下插入${cliAgentProposal.proposal.analysisMode === 'visualization' ? '可视化' : '下探'}分支「${cliAgentProposal.proposal.nextLabel}」`
                      : cliAgentProposal.proposal.operation === 'delete'
                        ? `删除「${cliAgentProposal.proposal.previousLabel}」及其子节点`
                        : `更新「${cliAgentProposal.proposal.previousLabel}」的备注`}
            </p>
            {cliAgentProposal.proposal.htmlAssets?.length ? (
              <p className="agent-cli-approval-rationale">
                确认后保存 {cliAgentProposal.proposal.htmlAssets.length} 个隔离
                HTML 组件。
              </p>
            ) : null}
            {cliAgentProposal.proposal.rationale && (
              <p className="agent-cli-approval-rationale">
                {cliAgentProposal.proposal.rationale}
              </p>
            )}
            <details>
              <summary>查看修改内容</summary>
              <pre>
                {cliAgentProposal.proposal.operation === 'add_branch'
                  ? cliAgentProposal.proposal.branchMarkdown || '(分支为空)'
                  : cliAgentProposal.proposal.operation === 'set_note'
                    ? `− ${cliAgentProposal.proposal.previousNote || '(空备注)'}\n+ ${cliAgentProposal.proposal.nextNote || '(空备注)'}`
                    : cliAgentProposal.proposal.operation === 'delete'
                      ? `− ${cliAgentProposal.proposal.previousLabel}（及其子节点）`
                      : `− ${cliAgentProposal.proposal.previousLabel}\n+ ${cliAgentProposal.proposal.nextLabel}`}
              </pre>
            </details>
            <p className="agent-cli-approval-note">
              确认后会更新当前编辑器草稿，并按现有设置自动保存。导图若已变化，提案将无法应用。
            </p>
            <div className="agent-cli-approval-actions">
              <button
                type="button"
                className="agent-cli-reject-button"
                onClick={() => void resolveCliAgentProposal(false)}
              >
                拒绝
              </button>
              <button
                type="button"
                className="agent-cli-apply-button"
                onClick={() => void resolveCliAgentProposal(true)}
              >
                应用并自动保存
              </button>
            </div>
          </section>
        </div>
      )}
      {terminalCommandConfirmation && (
        <div
          className="settings-backdrop terminal-command-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              const callback = terminalCommandResultsRef.current.get(
                terminalCommandConfirmation.id,
              );
              terminalCommandResultsRef.current.delete(
                terminalCommandConfirmation.id,
              );
              callback?.('已取消执行。');
              setTerminalCommandConfirmation(null);
            }
          }}
        >
          <section
            className="settings-dialog terminal-command-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="terminal-command-title"
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">LOCAL TERMINAL</span>
                <h2 id="terminal-command-title">运行本机命令？</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="取消运行"
                onClick={() => {
                  const callback = terminalCommandResultsRef.current.get(
                    terminalCommandConfirmation.id,
                  );
                  terminalCommandResultsRef.current.delete(
                    terminalCommandConfirmation.id,
                  );
                  callback?.('已取消执行。');
                  setTerminalCommandConfirmation(null);
                }}
              >
                ×
              </button>
            </div>
            <p className="terminal-command-warning">
              这段 {terminalCommandConfirmation.language} 代码将在{' '}
              {librarySnapshot?.rootPath || '当前工作目录'} 中，以当前 Windows
              用户权限执行。请先检查完整命令。
            </p>
            <pre className="terminal-command-preview">
              <code>{terminalCommandConfirmation.source}</code>
            </pre>
            <div className="settings-footer">
              <button
                type="button"
                className="done-button"
                onClick={() => {
                  const callback = terminalCommandResultsRef.current.get(
                    terminalCommandConfirmation.id,
                  );
                  terminalCommandResultsRef.current.delete(
                    terminalCommandConfirmation.id,
                  );
                  callback?.('已取消执行。');
                  setTerminalCommandConfirmation(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="save-key-button"
                onClick={() => {
                  setPendingTerminalCommand(terminalCommandConfirmation);
                  setTerminalOpen(true);
                  setTerminalCommandConfirmation(null);
                }}
              >
                确认并运行
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
