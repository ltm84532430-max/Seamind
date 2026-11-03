export interface TranslatableBlock {
  element: HTMLElement;
  id: number;
  text: string;
}

const EXCLUDE_SELECTOR =
  'pre, code, samp, kbd, math, svg, script, style, .highlight, .seamind-bilingual-trans';

export const BILINGUAL_STYLE_ID = 'seamind-bilingual-style';

const BILINGUAL_CSS = `
.seamind-bilingual-trans {
  display: block;
  margin-top: 6px;
  margin-bottom: 14px;
  padding: 4px 8px 4px 12px;
  border-left: 2.5px solid #6366f1;
  font-size: 0.92em;
  line-height: 1.6;
  color: #475569;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-weight: 400;
  letter-spacing: 0.015em;
  border-radius: 0 4px 4px 0;
  background-color: rgba(99, 102, 241, 0.04);
}
:root[data-theme='dark'] .seamind-bilingual-trans,
body.dark .seamind-bilingual-trans,
[data-color-mode='dark'] .seamind-bilingual-trans {
  color: #94a3b8;
  border-left-color: #818cf8;
  background-color: rgba(129, 140, 248, 0.06);
}
.seamind-bilingual-hidden .seamind-bilingual-trans {
  display: none !important;
}
`;

function isDocument(container: Document | Element): container is Document {
  return typeof Document !== 'undefined'
    ? container instanceof Document
    : 'documentElement' in container;
}

function isElement(element: unknown): element is HTMLElement {
  return typeof HTMLElement !== 'undefined'
    ? element instanceof HTMLElement
    : Boolean(element && typeof element === 'object' && 'classList' in element);
}

export function injectBilingualStyles(doc: Document): void {
  if (doc.getElementById(BILINGUAL_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = BILINGUAL_STYLE_ID;
  style.textContent = BILINGUAL_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function extractTranslatableElements(
  container: Document | Element,
): TranslatableBlock[] {
  const root = isDocument(container)
    ? (container.body ?? container.documentElement)
    : container;
  if (!root) return [];

  const candidates = root.querySelectorAll<HTMLElement>(
    'p, h1, h2, h3, h4, h5, h6, li, blockquote, dt, dd',
  );
  const results: TranslatableBlock[] = [];
  let idCounter = 0;

  candidates.forEach((element) => {
    // Skip if inside code block, formula, or already translated element
    if (element.closest(EXCLUDE_SELECTOR)) return;

    // Skip if element only contains child tags that are code/pre/img
    if (element.querySelector('pre, code, svg, math')) return;

    const rawText = (element.textContent ?? '').trim();
    // Skip empty or pure punctuation/number lines (e.g., page numbers, dividers)
    if (!rawText || /^[\d\s.\-_~:;#*()[\]{}]+$/u.test(rawText)) return;
    if (rawText.length < 2) return;

    element.setAttribute('data-trans-idx', String(idCounter));
    results.push({
      element,
      id: idCounter,
      text: rawText,
    });
    idCounter += 1;
  });

  return results;
}

export function injectTranslationsIntoDoc(
  doc: Document,
  translations: Array<{ id: number; translation: string }>,
): void {
  injectBilingualStyles(doc);

  for (const item of translations) {
    if (!item.translation || !item.translation.trim()) continue;
    const targetElement = doc.querySelector<HTMLElement>(
      `[data-trans-idx="${item.id}"]`,
    );
    if (!targetElement) continue;

    // Check if translation block already exists
    const existing = targetElement.nextElementSibling;
    if (
      isElement(existing) &&
      existing.classList.contains('seamind-bilingual-trans') &&
      existing.getAttribute('data-for-trans-idx') === String(item.id)
    ) {
      existing.textContent = item.translation.trim();
      continue;
    }

    const transNode = doc.createElement('div');
    transNode.className = 'seamind-bilingual-trans';
    transNode.setAttribute('data-for-trans-idx', String(item.id));
    transNode.textContent = item.translation.trim();
    targetElement.insertAdjacentElement('afterend', transNode);
  }
}

export function toggleBilingualDisplay(doc: Document, show: boolean): void {
  const target = doc.body ?? doc.documentElement;
  if (!target) return;
  if (show) {
    target.classList.remove('seamind-bilingual-hidden');
  } else {
    target.classList.add('seamind-bilingual-hidden');
  }
}

export function removeTranslationsFromDoc(doc: Document): void {
  const transNodes = doc.querySelectorAll('.seamind-bilingual-trans');
  transNodes.forEach((node) => node.remove());

  const taggedElements = doc.querySelectorAll('[data-trans-idx]');
  taggedElements.forEach((node) => node.removeAttribute('data-trans-idx'));
}
