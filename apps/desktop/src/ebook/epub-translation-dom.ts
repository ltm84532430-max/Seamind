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
  margin-top: 8px;
  margin-bottom: 16px;
  padding: 8px 14px;
  border: 1px solid var(--seamind-trans-border, rgba(217, 87, 59, 0.24));
  border-left: 3.5px solid var(--seamind-trans-accent, #d9573b);
  border-radius: 4px 8px 8px 4px;
  background-color: var(--seamind-trans-bg, rgba(217, 87, 59, 0.08));
  color: var(--seamind-trans-fg, #1e293b) !important;
  box-shadow: var(--seamind-trans-shadow, 0 2px 8px rgba(217, 87, 59, 0.07));
  font-size: 0.94em;
  line-height: 1.72;
  font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-weight: 450;
  letter-spacing: 0.02em;
  text-align: justify;
  -webkit-font-smoothing: antialiased;
  transition: background-color 0.18s ease, border-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease;
}
.seamind-bilingual-trans.is-heading-trans {
  margin-top: 6px;
  margin-bottom: 14px;
  padding: 7px 14px;
  background-color: var(--seamind-trans-heading-bg, rgba(217, 87, 59, 0.12));
  font-size: 0.96em;
  line-height: 1.55;
  font-weight: 600;
  letter-spacing: 0.025em;
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
  const existing = doc.getElementById(BILINGUAL_STYLE_ID);
  if (existing) {
    if (existing.textContent !== BILINGUAL_CSS) {
      existing.textContent = BILINGUAL_CSS;
    }
    return;
  }
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

    const isHeading = /^H[1-6]$/i.test(targetElement.tagName);

    // Check if translation block already exists
    const existing = targetElement.nextElementSibling;
    if (
      isElement(existing) &&
      existing.classList.contains('seamind-bilingual-trans') &&
      existing.getAttribute('data-for-trans-idx') === String(item.id)
    ) {
      if (isHeading) {
        existing.classList.add('is-heading-trans');
      }
      existing.textContent = item.translation.trim();
      continue;
    }

    const transNode = doc.createElement('div');
    transNode.className = isHeading
      ? 'seamind-bilingual-trans is-heading-trans'
      : 'seamind-bilingual-trans';
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
