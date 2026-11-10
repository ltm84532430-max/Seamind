import {
  injectBilingualStyles,
  injectTranslationsIntoDoc,
} from '../ebook/epub-translation-dom';
import {
  isTranslatableText,
  normalizeBlockText,
} from './feed-translation-blocks';

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dt, dd';
const SKIP_ANCESTOR =
  'pre, svg, math, script, style, .highlight, .seamind-bilingual-trans, .feed-article-placeholder, .feed-article-original-link';

function isBr(node: Node): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR'
  );
}

function leafBlocks(body: HTMLElement): HTMLElement[] {
  return [...body.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter(
    (element) => {
      if (element.closest(SKIP_ANCESTOR)) return false;
      if (element.querySelector('pre, svg, math')) return false;
      if (element.querySelector(BLOCK_SELECTOR)) return false;
      return isTranslatableText(blockText(element));
    },
  );
}

function blockText(element: HTMLElement): string {
  let text = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName.toLowerCase();
    if (
      tag === 'script' ||
      tag === 'style' ||
      tag === 'svg' ||
      tag === 'math'
    ) {
      return;
    }
    if (tag === 'br' || tag === 'hr') {
      text += '\n';
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(element);
  return normalizeBlockText(text);
}

function textsMatch(elements: HTMLElement[], expected: string[]): boolean {
  return (
    elements.length === expected.length &&
    elements.every((element, index) => blockText(element) === expected[index])
  );
}

function wrapFlatFlow(host: HTMLElement): HTMLElement[] {
  const doc = host.ownerDocument;
  const groups: Node[][] = [];
  let current: Node[] = [];
  const flush = () => {
    if (current.some((node) => (node.textContent ?? '').trim())) {
      groups.push(current);
    }
    current = [];
  };

  for (const node of [...host.childNodes]) {
    if (isBr(node)) {
      flush();
      continue;
    }
    if (
      node.nodeType === Node.TEXT_NODE &&
      /\n\s*\n/u.test(node.textContent ?? '')
    ) {
      const parts = (node.textContent ?? '').split(/\n\s*\n/u);
      parts.forEach((part, partIndex) => {
        if (partIndex > 0) flush();
        if (part.trim()) current.push(doc.createTextNode(part));
      });
      continue;
    }
    current.push(node);
  }
  flush();

  const created: HTMLElement[] = [];
  const fragment = doc.createDocumentFragment();
  for (const group of groups) {
    const paragraph = doc.createElement('p');
    paragraph.dataset.feedFlatPara = '1';
    for (const node of group) paragraph.appendChild(node);
    fragment.appendChild(paragraph);
    created.push(paragraph);
  }
  host.replaceChildren(fragment);
  return created;
}

function wrapDeep(host: HTMLElement): HTMLElement[] {
  const elementChildren = [...host.children];
  const onlyWrapper =
    elementChildren.length === 1 &&
    ['DIV', 'SECTION', 'ARTICLE'].includes(elementChildren[0]?.tagName ?? '') &&
    ![...host.childNodes].some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim(),
    );
  if (onlyWrapper && elementChildren[0]) return wrapDeep(elementChildren[0]);
  return wrapFlatFlow(host);
}

function materializeFlat(body: HTMLElement, expected: string[]): HTMLElement[] {
  const clone = body.cloneNode(true) as HTMLElement;
  const preview = wrapDeep(clone);
  if (!textsMatch(preview, expected)) return [];
  return wrapDeep(body);
}

export function clearFeedTranslationNodes(root: HTMLElement) {
  root
    .querySelectorAll('.seamind-bilingual-trans')
    .forEach((node) => node.remove());
  root.querySelectorAll('[data-trans-idx]').forEach((node) => {
    node.removeAttribute('data-trans-idx');
  });
}

export function assignFeedAnchors(
  root: HTMLElement,
  texts: string[],
): HTMLElement[] {
  clearFeedTranslationNodes(root);
  const anchors: HTMLElement[] = [];
  let index = 0;
  const headline = root.querySelector<HTMLElement>('h1.feed-article-headline');
  if (
    headline &&
    texts[0] &&
    normalizeBlockText(headline.textContent ?? '') === texts[0]
  ) {
    anchors.push(headline);
    index = 1;
  }

  const bodyTexts = texts.slice(index);
  if (bodyTexts.length === 0) return anchors;

  const body = root.querySelector<HTMLElement>('.feed-article-body');
  if (!body) return [];
  let elements = leafBlocks(body);
  if (elements.length === 0) {
    elements = materializeFlat(body, bodyTexts);
  }
  if (!textsMatch(elements, bodyTexts)) return [];
  return [...anchors, ...elements];
}

export function paintFeedTranslations(
  root: HTMLElement,
  texts: string[],
  paragraphs: Array<{ id: number; translation: string }>,
  visible: boolean,
): boolean {
  const anchors = assignFeedAnchors(root, texts);
  if (anchors.length !== texts.length) return false;
  anchors.forEach((element, index) => {
    element.setAttribute('data-trans-idx', String(index));
  });
  injectBilingualStyles(root.ownerDocument);
  injectTranslationsIntoDoc(root.ownerDocument, paragraphs);
  root.classList.toggle('seamind-bilingual-hidden', !visible);
  return true;
}
