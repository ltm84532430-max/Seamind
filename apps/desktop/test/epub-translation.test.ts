import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  extractTranslatableElements,
  injectTranslationsIntoDoc,
  toggleBilingualDisplay,
  removeTranslationsFromDoc,
  BILINGUAL_STYLE_ID,
} from '../src/epub-translation-dom';
import {
  getChapterTranslation,
  saveChapterTranslation,
  deleteChapterTranslation,
  listBookTranslations,
} from '../src/epub-translation-store';
import { translateChapterAll } from '../src/epub-translator';

// Mock Tauri invoke
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock simple DOM for testing DOM utilities in Node environment
class MockClassList {
  private classes = new Set<string>();
  add(name: string) {
    this.classes.add(name);
  }
  remove(name: string) {
    this.classes.delete(name);
  }
  contains(name: string) {
    return this.classes.has(name);
  }
}

class MockElement {
  tagName: string;
  textContent: string = '';
  attributes: Record<string, string> = {};
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  classList = new MockClassList();

  constructor(tagName: string, textContent = '') {
    this.tagName = tagName.toUpperCase();
    this.textContent = textContent;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  get id() {
    return this.attributes['id'] ?? '';
  }

  set id(val: string) {
    this.setAttribute('id', val);
  }

  get className() {
    return this.attributes['class'] ?? '';
  }

  set className(val: string) {
    this.setAttribute('class', val);
    val.split(/\s+/).forEach((c) => c && this.classList.add(c));
  }

  appendChild(child: MockElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) {
        this.parentElement.children.splice(idx, 1);
      }
      this.parentElement = null;
    }
  }

  get nextElementSibling(): MockElement | null {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    const idx = siblings.indexOf(this);
    return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
  }

  insertAdjacentElement(position: string, element: MockElement) {
    if (position === 'afterend' && this.parentElement) {
      const siblings = this.parentElement.children;
      const idx = siblings.indexOf(this);
      element.parentElement = this.parentElement;
      siblings.splice(idx + 1, 0, element);
      return element;
    }
    return null;
  }

  closest(selector: string): MockElement | null {
    const selectors = selector.split(',').map((s) => s.trim().toUpperCase());
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let current: MockElement | null = this;
    while (current) {
      for (const sel of selectors) {
        if (sel.startsWith('.')) {
          if (current.classList.contains(sel.slice(1).toLowerCase())) {
            return current;
          }
        } else if (current.tagName === sel) {
          return current;
        }
      }
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector: string): MockElement | null {
    const list = this.querySelectorAll(selector);
    return list.length > 0 ? list[0] : null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const rawSelectors = selector.split(',').map((s) => s.trim());
    const matched: MockElement[] = [];

    const traverse = (node: MockElement) => {
      for (const child of node.children) {
        let matches = false;
        for (const rawSel of rawSelectors) {
          if (rawSel.startsWith('.')) {
            if (child.classList.contains(rawSel.slice(1).toLowerCase())) {
              matches = true;
              break;
            }
          } else if (rawSel.startsWith('[') && rawSel.endsWith(']')) {
            const attrMatch = rawSel
              .slice(1, -1)
              .match(/^([a-zA-Z0-9_-]+)(?:="([^"]*)")?$/);
            if (attrMatch) {
              const [, attr, val] = attrMatch;
              if (val !== undefined) {
                if (child.getAttribute(attr.toLowerCase()) === val)
                  matches = true;
              } else if (child.getAttribute(attr.toLowerCase()) !== null) {
                matches = true;
              }
            }
          } else if (child.tagName === rawSel.toUpperCase()) {
            matches = true;
            break;
          }
        }
        if (matches) matched.push(child);
        traverse(child);
      }
    };

    traverse(this);
    return matched;
  }
}

class MockDocument {
  documentElement = new MockElement('HTML');
  head = new MockElement('HEAD');
  body = new MockElement('BODY');

  constructor() {
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): MockElement {
    return new MockElement(tag);
  }

  getElementById(id: string): MockElement | null {
    const results = this.documentElement.querySelectorAll(`[id="${id}"]`);
    return results.length > 0 ? results[0] : null;
  }

  querySelector(selector: string): MockElement | null {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): MockElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
}

describe('EPUB DOM Extraction and Injection', () => {
  it('extracts readable paragraphs and skips pre, code, svg, and math', () => {
    const doc = new MockDocument();

    const h1 = doc.createElement('h1');
    h1.textContent = 'Chapter 1: Getting Started';
    doc.body.appendChild(h1);

    const p1 = doc.createElement('p');
    p1.textContent =
      'Linux is an open-source operating system widely used in cybersecurity.';
    doc.body.appendChild(p1);

    // Code block inside pre
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.textContent = 'sudo apt-get update && sudo apt-get install nmap';
    pre.appendChild(code);
    doc.body.appendChild(pre);

    // Paragraph containing code tag only
    const pCode = doc.createElement('p');
    const innerCode = doc.createElement('code');
    innerCode.textContent = 'chmod 755 script.sh';
    pCode.appendChild(innerCode);
    doc.body.appendChild(pCode);

    // Short or punctuation line
    const pShort = doc.createElement('p');
    pShort.textContent = '--- 12 ---';
    doc.body.appendChild(pShort);

    const p2 = doc.createElement('p');
    p2.textContent =
      'In this chapter, we will master the shell and directory navigation.';
    doc.body.appendChild(p2);

    const blocks = extractTranslatableElements(doc as unknown as Document);

    expect(blocks.length).toBe(3);
    expect(blocks[0].text).toBe('Chapter 1: Getting Started');
    expect(blocks[0].id).toBe(0);
    expect(h1.getAttribute('data-trans-idx')).toBe('0');

    expect(blocks[1].text).toBe(
      'Linux is an open-source operating system widely used in cybersecurity.',
    );
    expect(blocks[1].id).toBe(1);
    expect(p1.getAttribute('data-trans-idx')).toBe('1');

    expect(blocks[2].text).toBe(
      'In this chapter, we will master the shell and directory navigation.',
    );
    expect(blocks[2].id).toBe(2);
    expect(p2.getAttribute('data-trans-idx')).toBe('2');
  });

  it('injects bilingual translation nodes and styles cleanly', () => {
    const doc = new MockDocument();
    const p = doc.createElement('p');
    p.textContent = 'Hello world';
    p.setAttribute('data-trans-idx', '0');
    doc.body.appendChild(p);

    const translations = [{ id: 0, translation: '你好，世界' }];

    injectTranslationsIntoDoc(doc as unknown as Document, translations);

    // Style injected
    const style = doc.head.querySelector(`[id="${BILINGUAL_STYLE_ID}"]`);
    expect(style).not.toBeNull();

    // Node injected right after target
    const next = p.nextElementSibling;
    expect(next).not.toBeNull();
    expect(next?.classList.contains('seamind-bilingual-trans')).toBe(true);
    expect(next?.getAttribute('data-for-trans-idx')).toBe('0');
    expect(next?.textContent).toBe('你好，世界');

    // Calling again with updated translation updates existing text without creating duplicate
    injectTranslationsIntoDoc(doc as unknown as Document, [
      { id: 0, translation: '你好，整个世界' },
    ]);
    expect(next?.textContent).toBe('你好，整个世界');
    expect(doc.body.children.length).toBe(2);
  });

  it('toggles visibility and removes translations', () => {
    const doc = new MockDocument();
    const p = doc.createElement('p');
    p.textContent = 'Original';
    p.setAttribute('data-trans-idx', '0');
    doc.body.appendChild(p);

    injectTranslationsIntoDoc(doc as unknown as Document, [
      { id: 0, translation: '译文' },
    ]);

    toggleBilingualDisplay(doc as unknown as Document, false);
    expect(doc.body.classList.contains('seamind-bilingual-hidden')).toBe(true);

    toggleBilingualDisplay(doc as unknown as Document, true);
    expect(doc.body.classList.contains('seamind-bilingual-hidden')).toBe(false);

    // Remove
    removeTranslationsFromDoc(doc as unknown as Document);
    expect(p.getAttribute('data-trans-idx')).toBeNull();
    expect(doc.body.children.length).toBe(1);
  });
});

describe('EPUB Translation Persistent Store', () => {
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
      get length() {
        return Object.keys(store).length;
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
    };
  })();

  beforeEach(() => {
    vi.resetAllMocks();
    localStorageMock.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorageMock,
      writable: true,
    });
  });

  it('saves and retrieves chapter translation via Tauri backend invoke', async () => {
    const fakeRecord = {
      schemaVersion: 1,
      bookKey: 'book-linux',
      sectionIndex: 3,
      sectionHref: 'ch3.xhtml',
      chapterTitle: 'Chapter 3',
      translatedAt: 1700000000000,
      model: 'gemini-1.5-flash',
      paragraphs: [{ id: 0, translation: '段落译文' }],
    };

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'save_epub_chapter_translation') return fakeRecord;
      if (cmd === 'get_epub_chapter_translation') return fakeRecord;
      if (cmd === 'delete_epub_chapter_translation') return true;
      if (cmd === 'list_epub_book_translations') return [fakeRecord];
      return null;
    });

    const saved = await saveChapterTranslation({
      bookKey: 'book-linux',
      sectionIndex: 3,
      sectionHref: 'ch3.xhtml',
      chapterTitle: 'Chapter 3',
      model: 'gemini-1.5-flash',
      paragraphs: [{ id: 0, translation: '段落译文' }],
    });

    expect(saved.bookKey).toBe('book-linux');
    expect(mockInvoke).toHaveBeenCalledWith(
      'save_epub_chapter_translation',
      expect.objectContaining({
        bookKey: 'book-linux',
        sectionIndex: 3,
      }),
    );

    const retrieved = await getChapterTranslation('book-linux', 3);
    expect(retrieved?.chapterTitle).toBe('Chapter 3');

    const deleted = await deleteChapterTranslation('book-linux', 3);
    expect(deleted).toBe(true);
  });

  it('gracefully falls back to localStorage when Tauri invoke rejects', async () => {
    mockInvoke.mockRejectedValue(new Error('Tauri not running in browser'));

    const saved = await saveChapterTranslation({
      bookKey: 'book-offline',
      sectionIndex: 1,
      sectionHref: 'ch1.xhtml',
      chapterTitle: 'Offline Chapter',
      model: 'gpt-4o',
      paragraphs: [{ id: 0, translation: '离线翻译测试' }],
    });

    expect(saved.bookKey).toBe('book-offline');

    const retrieved = await getChapterTranslation('book-offline', 1);
    expect(retrieved?.paragraphs[0].translation).toBe('离线翻译测试');

    const list = await listBookTranslations('book-offline');
    expect(list.length).toBe(1);
    expect(list[0].chapterTitle).toBe('Offline Chapter');

    const deleted = await deleteChapterTranslation('book-offline', 1);
    expect(deleted).toBe(true);

    const afterDelete = await getChapterTranslation('book-offline', 1);
    expect(afterDelete).toBeNull();
  });
});

describe('EPUB Batch Translator', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('translates paragraphs in batches and reports progress', async () => {
    const paragraphs = [
      { id: 0, text: 'Para 1' },
      { id: 1, text: 'Para 2' },
      { id: 2, text: 'Para 3' },
      { id: 3, text: 'Para 4' },
    ];

    mockInvoke.mockImplementation(
      async (
        _cmd: string,
        args: { paragraphs: Array<{ id: number; text: string }> },
      ) => {
        return args.paragraphs.map((p) => ({
          id: p.id,
          translation: `译：${p.text}`,
        }));
      },
    );

    const progressReports: Array<[number, number]> = [];

    const results = await translateChapterAll({
      bookTitle: 'Test Book',
      chapterTitle: 'Test Chapter',
      paragraphs,
      provider: { baseUrl: 'https://api.test', model: 'test-model' },
      batchSize: 2,
      onProgress: (done, total) => progressReports.push([done, total]),
    });

    expect(results.length).toBe(4);
    expect(results[0]).toEqual({ id: 0, translation: '译：Para 1' });
    expect(results[3]).toEqual({ id: 3, translation: '译：Para 4' });
    expect(progressReports).toEqual([
      [2, 4],
      [4, 4],
    ]);
  });
});
