import type { PureNode } from 'markmap-lib';
import { defaultOptions as defaultHtmlParserOptions } from 'markmap-html-parser';
import {
  getMarkdownNodeNotes,
  type MarkdownNodeSource,
} from '../mindmap/commands';
import { sanitizeSvgMarkup, sanitizeSvgTree } from './svg-sanitize';
import {
  mapNodeColor,
  mapNodeLineWidth,
  mapNodeLinkAnchor,
} from '../mindmap/map-style-colors';

export {
  mapNodeColor,
  mapNodeLineWidth,
  mapNodeLinkAnchor,
  sanitizeSvgMarkup,
  sanitizeSvgTree,
};

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
  const visit = (node: PureNode, parentPath = ''): PureNode => {
    nodeId += 1;
    const path = parentPath ? `${parentPath}.${nodeId}` : `${nodeId}`;
    const source = sources.get(path);
    const fullNote = source?.id ? notes.get(source.id)?.trim() || '' : '';
    let noteMarkup = '';
    if (fullNote) {
      const rendered = renderMarkdownToHtml(renderer, fullNote);
      const safeNote = sanitizeNode({
        content: rendered,
        children: [],
      }).content;
      const safeNoteId = escapeHtmlText(source?.id ?? '');
      noteMarkup = [
        `<div class="seamind-node-note" data-seamind-note-id="${safeNoteId}">`,
        `<div class="seamind-node-note-content">${safeNote}</div>`,
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
  if (/^seamind-media:[a-f0-9]{64}$/i.test(value)) return true;
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
    .forEach((element) => {
      if (
        element.localName.toLowerCase() === 'style' &&
        element.closest('svg')
      ) {
        return;
      }
      element.remove();
    });
  document.body.querySelectorAll('svg').forEach((element) => {
    if (element.parentElement?.closest('svg')) return;
    sanitizeSvgTree(element, Boolean(element.closest('.katex')));
  });
  document.body.querySelectorAll('*').forEach((element) => {
    if (element.closest('svg')) return;
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name === 'style') {
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
