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
import type { PureNode } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import type { Markmap as MarkmapInstance } from 'markmap-view';
import { hydrateCodeBlocks, updateMarkdownCodeFence } from './code-blocks';
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
  MindmapNodeSnapshot,
  NodeEditProposal,
} from './agent/types';
const TerminalPanel = lazy(() => import('./TerminalPanel'));
import type {
  LibrarySnapshot,
  MapDocument,
  OpenedDocument,
  SaveDocumentInput,
} from './library';

type ProviderSettings = { baseUrl: string; model: string };
type Theme = 'light' | 'dark';
type MindmapStyle = 'gray' | 'warm' | 'cards';
interface MapColorNode {
  state: { depth: number; path?: string };
}
type StylableMarkmap = Omit<MarkmapInstance, 'setData'> & {
  options: {
    color: (node: MapColorNode) => string;
    linkAnchor: (node: MapColorNode) => 'bottom' | 'center';
  };
  setData(
    data?: PureNode | null,
    options?: {
      color: (node: MapColorNode) => string;
      linkAnchor: (node: MapColorNode) => 'bottom' | 'center';
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
  sourceFile: string;
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
const aiCollapsedStorageKey = 'seamind.ai-collapsed.v1';
const promptSuggestions = [
  '机器学习核心知识体系',
  'Web 全栈架构全景图',
  '微积分核心概念推导脉络',
  '敏捷项目研发与交付流程',
  '用户增长模型与生命周期',
];
const mindmapStyles: {
  id: MindmapStyle;
  label: string;
  description: string;
}[] = [
  { id: 'gray', label: '灰阶层级', description: '白底灰阶，突出层级关系' },
  { id: 'warm', label: '暖色分支', description: '用暖色区分一级分支' },
  { id: 'cards', label: '结构卡片', description: '卡片节点与清晰分组' },
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
  if (style === 'gray') return theme === 'dark' ? '#68747c' : '#b8bbc0';
  if (depth === 0) return theme === 'dark' ? '#87939a' : '#929ba1';

  const branchId = Number(path.split('.')[1] || 1);
  const palette =
    style === 'warm'
      ? theme === 'dark'
        ? ['#e58a62', '#d7aa58', '#84a27e', '#829cbd', '#bd8fc1', '#d17b84']
        : ['#d76e49', '#c89035', '#718b5e', '#6384a5', '#9972a7', '#c36673']
      : theme === 'dark'
        ? ['#8aa7b5', '#8ca897', '#a695bc', '#bea27e', '#7f9bbd', '#b18888']
        : ['#6d8996', '#708c7a', '#8d7ba0', '#9b8665', '#6684a5', '#a17d7d'];
  return palette[(branchId - 1) % palette.length];
}

function mapNodeLinkAnchor(
  style: MindmapStyle,
  depth: number,
): 'bottom' | 'center' {
  const usesCard =
    style === 'cards' || style === 'gray' || (style === 'warm' && depth === 0);
  return usesCard ? 'center' : 'bottom';
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

function sanitizeNode(node: PureNode): PureNode {
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
      } else if (name === 'src' && element.tagName.toLowerCase() !== 'img') {
        element.removeAttribute(attribute.name);
      }
    });
    if (element.tagName.toLowerCase() === 'img') element.removeAttribute('src');
    if (element.getAttribute('target') === '_blank')
      element.setAttribute('rel', 'noopener noreferrer');
  });

  return {
    ...node,
    content: document.body.innerHTML,
    children: node.children.map((child) => sanitizeNode(child)),
  };
}

function markdownTitle(markdown: string): string {
  const heading = markdown.match(/^#{1,2}\s+(.+)\s*$/m)?.[1]?.trim();
  return heading || '新建思维导图';
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
      '.katex, svg, table, pre, img, .seamind-html-card-node, .seamind-html-canvas-node',
    ),
  );
  if (hasVisibleText || hasVisualContent || htmlCardDefinitionFromPayload(root))
    return root;

  const heading = markdown.match(/^#{1,2}\s+(.+?)\s*$/m)?.[1]?.trim();
  const title = heading || documentTitle.trim() || '未命名思维导图';
  return { ...root, content: escapeHtmlText(title) };
}

function errorMessage(error: unknown, fallback: string): string {
  return typeof error === 'string' ? error : fallback;
}

type MarkdownNodeSource =
  | {
      kind: 'heading';
      lineIndex: number;
      prefix: string;
      level: number;
      label: string;
    }
  | {
      kind: 'list';
      lineIndex: number;
      prefix: string;
      indent: string;
      marker: string;
      hasCheckbox: boolean;
      label: string;
    };

function normalizeMindmapText(value: string): string {
  const decoded = document.createElement('textarea');
  decoded.innerHTML = value;
  return decoded.value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/[\\`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function parseMarkdownNodeSource(
  line: string,
  lineIndex: number,
): MarkdownNodeSource | null {
  const heading = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
  if (heading) {
    const content = heading[4].replace(/\s+#+\s*$/, '');
    return {
      kind: 'heading',
      lineIndex,
      prefix: `${heading[1]}${heading[2]}${heading[3]}`,
      level: heading[2].length,
      label: normalizeMindmapText(content),
    };
  }

  const list = line.match(/^(\s*)([-+*]|\d+[.)])(\s+)((?:\[[ xX]\]\s+)?)(.*)$/);
  if (!list) return null;
  return {
    kind: 'list',
    lineIndex,
    prefix: `${list[1]}${list[2]}${list[3]}${list[4]}`,
    indent: list[1],
    marker: list[2],
    hasCheckbox: Boolean(list[4]),
    label: normalizeMindmapText(list[5]),
  };
}

function buildMarkdownNodeSourceMap(
  markdown: string,
  root: PureNode,
): Map<string, MarkdownNodeSource> {
  const sourceLines = markdown.split(/\r?\n/).flatMap((line, lineIndex) => {
    const source = parseMarkdownNodeSource(line, lineIndex);
    return source ? [source] : [];
  });
  const result = new Map<string, MarkdownNodeSource>();
  let sourceCursor = 0;
  let nodeId = 0;

  const visit = (node: PureNode, parentPath = '') => {
    nodeId += 1;
    const path = parentPath ? `${parentPath}.${nodeId}` : `${nodeId}`;
    const isHtmlCard = Boolean(htmlCardDefinitionFromPayload(node));
    const nodeDocument = new DOMParser().parseFromString(
      node.content,
      'text/html',
    );
    nodeDocument.body
      .querySelectorAll('svg')
      .forEach((element) => element.remove());
    const containsKatex = Boolean(nodeDocument.body.querySelector('.katex'));
    const label = containsKatex
      ? ''
      : normalizeMindmapText(nodeDocument.body.textContent ?? '');
    if (label && !isHtmlCard) {
      while (
        sourceCursor < sourceLines.length &&
        sourceLines[sourceCursor].label !== label
      )
        sourceCursor += 1;
      if (sourceCursor < sourceLines.length) {
        result.set(path, sourceLines[sourceCursor]);
        sourceCursor += 1;
      }
    }
    node.children.forEach((child) => visit(child, path));
  };

  visit(root);
  return result;
}

function updateMarkdownFromCanvas(
  markdown: string,
  source: MarkdownNodeSource,
  value: string,
  addNode?: 'sibling' | 'child',
): string {
  const lines = markdown.split(/\r?\n/);
  const nextLabel = value.replace(/\s*\n+\s*/g, ' ').trim();
  if (source.lineIndex < 0 || source.lineIndex >= lines.length) return markdown;
  lines[source.lineIndex] = `${source.prefix}${nextLabel}`;
  if (!addNode) return lines.join('\n');

  let insertionIndex = source.lineIndex + 1;
  let newLine: string;
  if (
    source.kind === 'heading' &&
    (addNode === 'sibling' || source.level < 6)
  ) {
    const level = addNode === 'child' ? source.level + 1 : source.level;
    newLine = `${'#'.repeat(level)} ${'新主题'}`;
    if (addNode === 'sibling') {
      insertionIndex = lines.length;
      for (let index = source.lineIndex + 1; index < lines.length; index += 1) {
        const next = parseMarkdownNodeSource(lines[index], index);
        if (next?.kind === 'heading' && next.level <= source.level) {
          insertionIndex = index;
          break;
        }
      }
    }
  } else {
    const indent = source.kind === 'list' ? source.indent : '';
    const marker = source.kind === 'list' ? source.marker : '-';
    const taskPrefix =
      source.kind === 'list' && source.hasCheckbox ? '[ ] ' : '';
    const childIndent = addNode === 'child' ? `${indent}  ` : indent;
    newLine = `${childIndent}${marker} ${taskPrefix}新主题`;
    if (addNode === 'sibling' && source.kind === 'list') {
      insertionIndex = lines.length;
      for (let index = source.lineIndex + 1; index < lines.length; index += 1) {
        const next = parseMarkdownNodeSource(lines[index], index);
        if (
          next?.kind === 'heading' ||
          (next?.kind === 'list' && next.indent.length <= source.indent.length)
        ) {
          insertionIndex = index;
          break;
        }
      }
    }
  }

  lines.splice(insertionIndex, 0, newLine);
  return lines.join('\n');
}

function buildAgentMindmapTree(
  root: PureNode,
  editablePaths: Set<string>,
): {
  root: MindmapNodeSnapshot;
  nodeCount: number;
} {
  const maxNodes = 240;
  let nextId = 0;
  let nodeCount = 0;
  const visit = (
    node: PureNode,
    parentPath = '',
  ): MindmapNodeSnapshot | null => {
    if (nodeCount >= maxNodes) return null;
    nextId += 1;
    nodeCount += 1;
    const path = parentPath ? `${parentPath}.${nextId}` : `${nextId}`;
    const document = new DOMParser().parseFromString(node.content, 'text/html');
    document.body
      .querySelectorAll('svg')
      .forEach((element) => element.remove());
    const isHtmlCard = Boolean(htmlCardDefinitionFromPayload(node));
    const containsKatex = Boolean(document.body.querySelector('.katex'));
    const label = normalizeMindmapText(document.body.textContent ?? '').slice(
      0,
      300,
    );
    const children = node.children
      .map((child) => visit(child, path))
      .filter((child): child is MindmapNodeSnapshot => child !== null);
    return {
      path,
      label,
      editable: editablePaths.has(path) && !isHtmlCard && !containsKatex,
      children,
    };
  };
  return {
    root: visit(root) ?? {
      path: '1',
      label: '',
      editable: false,
      children: [],
    },
    nodeCount,
  };
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
  const [mindmapStyleMenuOpen, setMindmapStyleMenuOpen] = useState(false);
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
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
  const [pendingEpubImport, setPendingEpubImport] = useState(false);
  const [epubDropActive, setEpubDropActive] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [saveMessage, setSaveMessage] = useState('正在初始化文件库…');
  const [htmlImportBusy, setHtmlImportBusy] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreviewSelection | null>(
    null,
  );
  const [htmlPreviewSrc, setHtmlPreviewSrc] = useState('');
  const [htmlPreviewError, setHtmlPreviewError] = useState('');
  const [htmlCanvasEmbed, setHtmlCanvasEmbed] =
    useState<HtmlCanvasEmbedding | null>(null);
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [providerSettings, setProviderSettings] =
    useState<ProviderSettings>(readProviderSettings);
  const [aiMode, setAiMode] = useState<'generate' | 'agent'>('generate');
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [lastUpdated, setLastUpdated] = useState('已同步');
  const [cliAgentProposal, setCliAgentProposal] =
    useState<CliAgentProposal | null>(null);
  const cliAgentProposalRef = useRef<CliAgentProposal | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const codeBlocksAbortRef = useRef<AbortController | null>(null);
  const codeBlocksCleanupRef = useRef<(() => void) | null>(null);
  const mindmapStylePickerRef = useRef<HTMLDivElement>(null);
  const markmapRef = useRef<MarkmapInstance | null>(null);
  const markdownNodeSourcesRef = useRef<Map<string, MarkdownNodeSource>>(
    new Map(),
  );
  const draftRef = useRef(editorDraft);
  const agentCapabilitiesRef = useRef<AgentCapabilities | null>(null);
  const librarySnapshotRef = useRef<LibrarySnapshot | null>(null);
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
    const instance = new Transformer([]);
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

  const installDraft = (next: EditorDraft) => {
    draftRef.current = next;
    setEditorDraft(next);
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

  const getAgentMindmap = (): ActiveMindmapSnapshot => {
    const current = draftRef.current;
    const root = transformer.transform(current.markdown).root;
    const sources = buildMarkdownNodeSourceMap(current.markdown, root);
    const tree = buildAgentMindmapTree(root, new Set(sources.keys()));
    return {
      title: current.title,
      revision: current.revision,
      relativePath: current.relativePath,
      nodeCount: tree.nodeCount,
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
    const root = transformer.transform(current.markdown).root;
    const source = buildMarkdownNodeSourceMap(current.markdown, root).get(
      input.nodePath,
    );
    if (!source) {
      throw new Error('找不到这个节点的 Markdown 源位置，请重新读取导图。');
    }
    if (
      input.operation === 'add_child' &&
      source.kind === 'heading' &&
      source.level >= 6
    ) {
      throw new Error('这个标题已经达到 Markdown 的最大层级，无法添加子标题。');
    }

    const operation =
      input.operation === 'add_child'
        ? 'child'
        : input.operation === 'add_sibling'
          ? 'sibling'
          : undefined;
    const markdown = updateMarkdownFromCanvas(
      current.markdown,
      source,
      input.text,
      operation,
    );
    if (markdown === current.markdown) {
      throw new Error('提案没有产生任何 Markdown 变化。');
    }
    return {
      baseRevision: current.revision,
      baseRelativePath: current.relativePath,
      baseMarkdown: current.markdown,
      baseTitle: current.title,
      markdown,
      title: markdownTitle(markdown),
      nodePath: input.nodePath,
      operation: input.operation,
      previousLabel: source.label,
      nextLabel: input.text.replace(/\s*\n+\s*/g, ' ').trim(),
      rationale: input.rationale,
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

  const applyAgentProposal = (proposal: NodeEditProposal): number | null => {
    const current = draftRef.current;
    if (
      current.revision !== proposal.baseRevision ||
      current.relativePath !== proposal.baseRelativePath ||
      current.markdown !== proposal.baseMarkdown
    ) {
      return null;
    }
    patchDraft({ markdown: proposal.markdown, title: proposal.title });
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
    const appliedRevision = applyAgentProposal(pending.proposal);
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

  const undoAgentProposal = (
    proposal: NodeEditProposal,
    appliedRevision: number,
  ): boolean => {
    const current = draftRef.current;
    if (
      current.revision !== appliedRevision ||
      (proposal.baseRelativePath !== null &&
        current.relativePath !== proposal.baseRelativePath) ||
      current.markdown !== proposal.markdown
    ) {
      return false;
    }
    patchDraft({
      markdown: proposal.baseMarkdown,
      title: proposal.baseTitle,
    });
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
    if (markdown !== activeDraft.markdown) patchDraft({ markdown });
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

  const importEpubPath = async (path: string, droppedEpubCount = 1) => {
    if (epubImportInFlightRef.current) return;
    epubImportInFlightRef.current = true;
    setLibraryBusy(true);
    setSaveMessage('正在读取 EPUB 目录…');
    setLibraryError('');
    try {
      const outline = await invoke<EpubOutline>('import_epub_toc', { path });
      const currentDraft = draftRef.current;
      installDraft(
        createDraft({
          title: outline.title,
          category: categoryFilter || '未分类',
          mapType: 'EPUB 目录',
          tags: 'EPUB, 目录',
          markdown: outline.markdown,
          dirty: true,
          revision: currentDraft.revision + 1,
        }),
      );
      setPendingEpubImport(true);
      const droppedNotice =
        droppedEpubCount > 1
          ? `（检测到 ${droppedEpubCount} 本 EPUB，本次先导入第一本）`
          : '';
      setSaveMessage(
        `已从 ${outline.sourceFile} 导入 ${outline.chapterCount} 个目录条目，请检查后保存${droppedNotice}`,
      );
    } catch (error) {
      setLibraryError(errorMessage(error, '导入 EPUB 目录失败'));
      setSaveMessage('EPUB 导入失败');
    } finally {
      epubImportInFlightRef.current = false;
      setLibraryBusy(false);
    }
  };

  const importDroppedEpubs = async (paths: string[]) => {
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
    await importEpubPath(epubPaths[0], epubPaths.length);
  };

  epubDropHandlerRef.current = (paths) => {
    void importDroppedEpubs(paths);
  };

  const importEpub = async () => {
    if (!(await prepareForEpubImport())) return;
    try {
      const selected = await openDialog({
        multiple: false,
        title: '导入 EPUB 目录',
        filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      });
      if (typeof selected !== 'string') return;
      await importEpubPath(selected);
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
    } catch (error) {
      setGenerationError(
        errorMessage(error, '生成失败，请检查模型设置后重试。'),
      );
      setLastUpdated('生成失败');
    } finally {
      setIsGenerating(false);
    }
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
      direction: 'both',
      linkShape: 'rounded-orthogonal',
      linkRadius: 8,
      linkAnchor: (node: MapColorNode) =>
        mapNodeLinkAnchor(mindmapStyle, node.state.depth),
      color: (node: MapColorNode) =>
        mapNodeColor(
          mindmapStyle,
          node.state.depth,
          node.state.path || '',
          theme,
        ),
      maxWidth: 260,
      spacingHorizontal: 56,
      spacingVertical: 14,
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
        '编辑思维导图节点；按 Enter 添加同级节点，按 Tab 添加子节点',
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
        const titleLineIndex = activeDraft.markdown
          .split(/\r?\n/)
          .findIndex((line) => /^#{1,2}\s+.+/.test(line));
        const markdown = updateMarkdownFromCanvas(
          activeDraft.markdown,
          source,
          nextText,
          action === 'sibling' || action === 'child' ? action : undefined,
        );
        if (markdown !== activeDraft.markdown) {
          patchDraft({
            markdown,
            ...(source.lineIndex === titleLineIndex
              ? { title: markdownTitle(markdown) }
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
        } else if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          finish('sibling');
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

    svg.addEventListener('click', handleHtmlCardClick, true);
    svg.addEventListener('dblclick', handleCanvasDoubleClick, true);
    return () => {
      svg.removeEventListener('click', handleHtmlCardClick, true);
      svg.removeEventListener('dblclick', handleCanvasDoubleClick, true);
      map.destroy();
      markmapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = markmapRef.current as StylableMarkmap | null;
    if (!map) return;
    void map.setData(undefined, {
      color: (node) =>
        mapNodeColor(
          mindmapStyle,
          node.state.depth,
          node.state.path || '',
          theme,
        ),
      linkAnchor: (node) => mapNodeLinkAnchor(mindmapStyle, node.state.depth),
    });
  }, [mindmapStyle, theme]);

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
        normalizeKatexDelimiters(editorDraft.markdown),
        htmlCardParserOptions,
      );
      const embedding =
        htmlCanvasEmbed?.documentRelativePath === editorDraft.relativePath
          ? htmlCanvasEmbed
          : undefined;
      const embeddingApplied = { value: false };
      const safeRoot = prepareHtmlCardNodes(
        sanitizeNode(root),
        embedding,
        embeddingApplied,
      );
      const displayRoot = addFallbackMindmapTitle(
        safeRoot,
        editorDraft.markdown,
        editorDraft.title,
      );
      markdownNodeSourcesMarkdownRef.current = editorDraft.markdown;
      markdownNodeSourcesRef.current = buildMarkdownNodeSourceMap(
        editorDraft.markdown,
        safeRoot,
      );
      await map.setData(displayRoot);
      if (codeBlocksAbort.signal.aborted) return;
      const cleanupCodeBlocks = await hydrateCodeBlocks(
        svg,
        theme,
        codeBlocksAbort.signal,
        {
          onCodeChange: (language, previous, next) =>
            codeBlockEditHandlerRef.current(language, previous, next),
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

  const handleZoom = (factor: number) => {
    void markmapRef.current?.rescale(factor);
  };

  return (
    <main
      className="app-shell"
      data-theme={theme}
      data-map-style={mindmapStyle}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path d="M9 23c-3 0-4.5-2.2-4.5-4.4s1.6-3.8 4.7-3.8h4.4c3 0 4.7-1.6 4.7-3.8S16.8 7 13.8 7" />
              <path d="M18.3 14.8h3.3c3 0 4.9 1.6 4.9 3.8s-1.7 4.4-4.9 4.4" />
              <circle cx="9" cy="23" r="2" />
              <circle cx="13.8" cy="7" r="2" />
              <circle cx="21.6" cy="23" r="2" />
            </svg>
          </div>
          <div>
            <div className="brand-name">seamind</div>
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
        className={`workspace${sourceCollapsed ? ' is-source-collapsed' : ''}${libraryCollapsed ? ' is-library-collapsed' : ''}${aiCollapsed ? ' is-ai-collapsed' : ''}${terminalOpen ? ' is-terminal-open' : ''}`}
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
          onSearch={setLibraryQuery}
          onChooseRoot={() => void chooseLibraryRoot()}
          onRefresh={() => void loadLibrary(false)}
          onCreateDocument={createNewDocument}
          onImportEpub={() => void importEpub()}
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
              aria-controls="markdown-editor"
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
          <label className="editor-label" htmlFor="markdown-editor">
            编辑源文本
          </label>
          <textarea
            id="markdown-editor"
            className="markdown-editor"
            spellCheck={false}
            value={editorDraft.markdown}
            onChange={(event) => patchDraft({ markdown: event.target.value })}
            aria-label="Markdown 源文本"
          />
          <div className="editor-footer">
            <span>{saveMessage}</span>
            <span>{editorDraft.markdown.length} 字符</span>
          </div>
        </section>

        <section className="preview-pane">
          <div className="pane-heading preview-heading">
            <div>
              <span className="pane-kicker">02 / CANVAS</span>
              <h1>思维导图</h1>
            </div>
            <div className="canvas-tools" aria-label="画布工具">
              {htmlCanvasEmbed?.documentRelativePath ===
                editorDraft.relativePath && (
                <button
                  type="button"
                  className="html-canvas-mode-button"
                  onClick={() => setHtmlCanvasEmbed(null)}
                >
                  退出 HTML 交互
                </button>
              )}
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
                          <strong>{style.label}</strong>
                          <small>{style.description}</small>
                        </span>
                        <span className="map-style-check" aria-hidden="true">
                          {mindmapStyle === style.id ? '✓' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="tool-divider" />
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
              <span className="tool-divider" />
              <button
                type="button"
                className="fit-button"
                onClick={() => void markmapRef.current?.fit()}
              >
                <Icon name="fit" />
                <span>适应画布</span>
              </button>
            </div>
          </div>
          <div className="canvas-wrap">
            <div
              className={`canvas-hint${htmlCanvasEmbed?.documentRelativePath === editorDraft.relativePath ? ' is-html-interactive' : ''}`}
            >
              <span className="hint-dot" />
              {htmlCanvasEmbed?.documentRelativePath ===
              editorDraft.relativePath ? (
                <>
                  HTML 交互模式：组件区域接收鼠标操作{' '}
                  <span className="hint-separator">·</span>{' '}
                  点击节点顶部或工具栏“退出 HTML 交互”恢复画布操作
                </>
              ) : (
                <>
                  实时预览 <span className="hint-separator">·</span> 拖动平移{' '}
                  <span className="hint-separator">·</span> 滚轮缩放{' '}
                  <span className="hint-separator">·</span> 双击编辑{' '}
                  <span className="hint-separator">·</span> Enter 同级 / Tab
                  子级 <span className="hint-separator">·</span> Mermaid /
                  ECharts / Python 代码围栏
                </>
              )}
            </div>
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
              <div
                className="ai-model-badge"
                title={`当前连接模型：${providerSettings.model}`}
              >
                <span className="model-dot" />
                <span>{providerSettings.model}</span>
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
            <div className="ai-mode-switch" role="tablist" aria-label="AI 模式">
              <button
                type="button"
                role="tab"
                aria-selected={aiMode === 'generate'}
                className={aiMode === 'generate' ? 'is-active' : ''}
                onClick={() => setAiMode('generate')}
              >
                生成新图
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={aiMode === 'agent'}
                className={aiMode === 'agent' ? 'is-active' : ''}
                onClick={() => setAiMode('agent')}
              >
                助手
              </button>
            </div>
            <div
              className="ai-mode-content ai-generation-mode"
              hidden={aiMode !== 'generate'}
            >
              <div className="ai-intro">
                <p>
                  输入知识主题或长文资料，LLM
                  将自动推理逻辑架构、梳理多层级关系并即刻呈现为工整的思维导图。
                </p>
              </div>
              <form
                className="ai-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleGenerate();
                }}
              >
                <label className="ai-prompt-label" htmlFor="ai-prompt">
                  构想主题或内容梗概
                </label>
                <div className="ai-textarea-wrap">
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
                    rows={4}
                    maxLength={4000}
                    placeholder="例如：梳理大语言模型 (LLM) 的预训练、指令微调、RLHF 对齐与推理优化全流程…"
                    aria-label="LLM 提示词"
                  />
                  {generationError && (
                    <div className="generation-error" role="alert">
                      {generationError}
                    </div>
                  )}
                </div>
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
                <button
                  className="ai-generate-button"
                  type="submit"
                  disabled={isGenerating || !prompt.trim()}
                >
                  {isGenerating ? (
                    <>
                      <span className="spinner" />
                      正在构筑思维导图…
                    </>
                  ) : (
                    '生成思维导图'
                  )}
                </button>
                <div className="ai-hint-footer">
                  Ctrl + Enter 快捷发送 · 自动保存入库
                </div>
              </form>
            </div>
            <div
              className="ai-mode-content ai-agent-mode"
              hidden={aiMode !== 'agent'}
            >
              <AgentPanel
                provider={providerSettings}
                capabilities={agentCapabilities}
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
                : `在「${cliAgentProposal.proposal.previousLabel}」${cliAgentProposal.proposal.operation === 'add_child' ? '下' : '旁'}添加「${cliAgentProposal.proposal.nextLabel}」`}
            </p>
            {cliAgentProposal.proposal.rationale && (
              <p className="agent-cli-approval-rationale">
                {cliAgentProposal.proposal.rationale}
              </p>
            )}
            <details>
              <summary>查看修改内容</summary>
              <pre>{`− ${cliAgentProposal.proposal.previousLabel}\n+ ${cliAgentProposal.proposal.nextLabel}`}</pre>
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
