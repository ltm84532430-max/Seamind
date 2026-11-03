import type { PureNode } from 'markmap-lib';
import { defaultOptions as defaultHtmlParserOptions } from 'markmap-html-parser';
import {
  getMarkdownNodeNotes,
  type MarkdownNodeSource,
} from './mindmap/commands';
import type { MindmapStyle, Theme } from './app-storage';

export interface HtmlCardDefinition {
  assetId: string;
  entryPath: string;
  title: string;
  width: number;
  height: number;
}

export interface HtmlPreviewSelection extends HtmlCardDefinition {
  documentRelativePath: string;
}

export interface HtmlCanvasEmbedding extends HtmlPreviewSelection {
  src: string;
}

export function mapNodeColor(
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

export function mapNodeLinkAnchor(
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

export function mapNodeLineWidth(depth: number): number {
  if (depth === 0) return 2.4;
  if (depth === 1) return 1.9;
  return 1.5;
}

export function sanitizeHref(href: string): boolean {
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

export const katexStyleProperties = new Set([
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

export const htmlCardParserOptions = {
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

export function sanitizeKatexStyle(
  element: Element,
  value: string,
): string | null {
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

export function sanitizeSvgTree(root: Element, isKatex = false): void {
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

export function sanitizeSvgMarkup(source: string): string | null {
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

export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseHtmlCardDefinition(
  value: unknown,
): HtmlCardDefinition | null {
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

export function htmlCardDefinitionFromPayload(
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

export function htmlCardNodeMarkup(
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

export function prepareHtmlCardNodes(
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

export function renderMarkdownToHtml(
  renderer: unknown,
  source: string,
): string {
  return (renderer as { render(markdown: string): string }).render(source);
}

export function addMarkdownNodeNoteCards(
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

export function isSafeMarkdownImageSource(source: string): boolean {
  const value = source.trim();
  if (/^(?:\/(?!\/)|\.\.?\/)/.test(value)) return true;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sanitizeNode(
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
