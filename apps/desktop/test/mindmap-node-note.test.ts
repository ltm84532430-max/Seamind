import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Transformer } from 'markmap-lib';
import { pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import { addMarkdownNodeNoteCards } from '../src/app/app-style-utils';
import {
  buildMarkdownNodeSourceMap,
  markdownForMindmap,
  setMarkdownNodeNote,
} from '../src/mindmap/commands';

const transformer = new Transformer([pluginFrontmatter, pluginSourceLines]);

describe('mindmap node note full rendering & CSS invariants', () => {
  const originalDocument = globalThis.document;
  const originalDomParser = globalThis.DOMParser;

  beforeAll(() => {
    if (typeof globalThis.document === 'undefined') {
      (globalThis as unknown as { document: unknown }).document = {
        createElement: () => ({
          set innerHTML(v: string) {
            this._v = v;
          },
          get value() {
            return this._v ?? '';
          },
          _v: '',
          style: {
            cssText: '',
            length: 0,
            item: () => '',
            getPropertyValue: () => '',
            setProperty: () => {},
          },
        }),
      };
    }
    if (typeof globalThis.DOMParser === 'undefined') {
      (globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
        parseFromString(html: string) {
          return {
            body: {
              innerHTML: html,
              querySelectorAll: () => [],
            },
          };
        }
      };
    }
  });

  afterAll(() => {
    if (originalDocument === undefined) {
      delete (globalThis as unknown as { document?: unknown }).document;
    } else {
      (globalThis as unknown as { document: unknown }).document =
        originalDocument;
    }
    if (originalDomParser === undefined) {
      delete (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
    } else {
      (globalThis as unknown as { DOMParser: unknown }).DOMParser =
        originalDomParser;
    }
  });

  it('renders full multi-thousand-char notes across all nodes without 800/12000 truncation', () => {
    let md = [
      '# 主题 <!-- seamind:id=n1 -->',
      '## 分支A <!-- seamind:id=n2 -->',
      '## 分支B <!-- seamind:id=n3 -->',
      '## 分支C <!-- seamind:id=n4 -->',
    ].join('\n');

    const longSentence = '详细备注条款内容，禁止静默截断，保留完整链接与说明。';
    const longNote = Array.from({ length: 120 }, () => longSentence).join('');
    expect(longNote.length).toBeGreaterThan(3000);

    md = setMarkdownNodeNote(md, 'n1', longNote);
    md = setMarkdownNodeNote(md, 'n2', longNote);
    md = setMarkdownNodeNote(md, 'n3', longNote);
    md = setMarkdownNodeNote(md, 'n4', `${longNote}【末尾标记】`);

    const { root } = transformer.transform(markdownForMindmap(md));
    const sources = buildMarkdownNodeSourceMap(md, root);
    const withNotes = addMarkdownNodeNoteCards(
      root,
      sources,
      md,
      transformer.md,
    );

    const lastChild = withNotes.children[2];
    expect(lastChild?.content).toContain('data-seamind-note-id="n4"');
    expect(lastChild?.content).toContain('【末尾标记】');
    expect(lastChild?.content).not.toContain('seamind-node-note-ellipsis');
  });

  it('removes 2.8em CSS clipping and excludes note nodes from fixed plain-label width clamp', () => {
    const css = readFileSync(
      new URL('../src/styles.css', import.meta.url),
      'utf8',
    );
    expect(css).not.toMatch(
      /\.seamind-node-note-content\s*\{[^}]*max-height:\s*2\.8em/s,
    );
    expect(css).toMatch(
      /\.seamind-node-note\.is-expanded\s+\.seamind-node-note-content\s*\{[^}]*max-height:\s*none/s,
    );
    expect(css).toMatch(
      /\.seamind-node-note\.is-collapsed\s+\.seamind-node-note-content\s*\{[^}]*display:\s*none/s,
    );
    expect(css).toMatch(/:not\(\s*:has\([^)]*\.seamind-node-note/s);
  });
});
