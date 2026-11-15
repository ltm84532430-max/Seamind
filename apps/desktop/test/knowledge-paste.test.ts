import { describe, expect, it } from 'vitest';
import {
  analyzeKnowledgePaste,
  finalizeSkippedPasteMedia,
  htmlToKnowledgeMarkdown,
  isContentSvgElement,
  mediaIdFromSource,
  needsKnowledgePasteReview,
  pasteTextWithMedia,
  svgMarkdown,
} from '../src/knowledge/knowledge-paste';

const id = 'a'.repeat(64);

describe('knowledge paste media inventory', () => {
  it('lets ordinary rich text paste directly when no media needs review', () => {
    const draft = analyzeKnowledgePaste({
      getData: (type: string) =>
        type === 'text/plain' ? '第一段\r\n第二段' : '',
      files: [],
    } as unknown as DataTransfer);
    expect(needsKnowledgePasteReview({ ...draft, richHtml: true }, true)).toBe(
      false,
    );
    expect(needsKnowledgePasteReview({ ...draft, richHtml: true }, false)).toBe(
      true,
    );
  });

  it('keeps ChatGPT image links as opt-in candidates and reports missing diagram data', () => {
    const text =
      '# 架构图\n\n[Godot 图](https://images.openai.com/static-rsc-4/example?purpose=inline)\n\nPlayerAttack -> EnemyHealth';
    const clipboard = {
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      files: [],
    } as unknown as DataTransfer;
    const draft = analyzeKnowledgePaste(clipboard);
    expect(draft.linkCount).toBe(1);
    expect(draft.media).toMatchObject([
      { kind: 'remote', selected: false, label: 'Godot 图' },
    ]);
    expect(draft.svgCount).toBe(0);
    expect(draft.possibleMissingDiagram).toBe(true);
  });

  it('replaces a selected link in place and appends clipboard images', () => {
    const link = '[图片](https://images.openai.com/example)';
    const text = `前文\n\n${link}\n\n后文`;
    const result = pasteTextWithMedia(text, [
      {
        candidate: {
          key: 'remote',
          label: '图片',
          kind: 'remote',
          value: 'https://images.openai.com/example',
          selected: true,
          markdownLink: link,
        },
        mediaId: id,
      },
      {
        candidate: {
          key: 'file',
          label: '屏幕截图.png',
          kind: 'file',
          value: {} as File,
          selected: true,
        },
        mediaId: id,
      },
    ]);
    expect(result).toBe(
      `前文\n\n![图片](seamind-media:${id})\n\n后文\n\n![屏幕截图.png](seamind-media:${id})`,
    );
    expect(mediaIdFromSource(`seamind-media:${id}`)).toBe(id);
    expect(mediaIdFromSource('file:///C:/private.png')).toBe(null);
  });

  it('replaces repeated links to the same imported image without duplicating its file', () => {
    const url = 'https://images.openai.com/static-rsc-4/example';
    const text = `[第一处](${url})\n\n[第二处](${url})`;
    const draft = analyzeKnowledgePaste({
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      files: [],
    } as unknown as DataTransfer);
    expect(draft.media).toHaveLength(1);
    const result = pasteTextWithMedia(text, [
      { candidate: draft.media[0], mediaId: id },
    ]);
    expect(result).toBe(
      `![第一处](seamind-media:${id})\n\n![第二处](seamind-media:${id})`,
    );
  });

  it('keeps a plain SVG diagram at its original position as editable source', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>';
    const text = `前文\n\n${svg}\n\n后文`;
    const draft = analyzeKnowledgePaste({
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      files: [],
    } as unknown as DataTransfer);
    expect(draft.svgCount).toBe(1);
    expect(draft.media).toMatchObject([
      { kind: 'svg', selected: true, sourceText: svg },
    ]);
    expect(
      pasteTextWithMedia(text, [{ candidate: draft.media[0], svgSource: svg }]),
    ).toBe(`前文\n\n${svgMarkdown(svg)}\n\n后文`);
  });

  it('uses a longer fence when SVG text contains backticks', () => {
    expect(
      svgMarkdown('<svg><text>```</text></svg>').startsWith('````svg\n'),
    ).toBe(true);
  });

  it('recognizes uppercase SVG fences and CDN query-param image URLs', () => {
    const draft = analyzeKnowledgePaste({
      getData: (type: string) =>
        type === 'text/plain'
          ? [
              '```SVG',
              '<svg viewBox="0 0 100 50"><rect width="100" height="50"/></svg>',
              '```',
              '',
              '![diagram](https://cdn.example.com/media/12345?format=webp)',
            ].join('\n')
          : '',
      files: [],
    } as unknown as DataTransfer);
    expect(draft.svgCount).toBe(1);
    expect(draft.media.map((item) => item.kind)).toEqual(['remote', 'svg']);
    expect(draft.media[0]).toMatchObject({ selected: true });
  });

  it('strips unresolved data placeholders when skipping images', () => {
    const raw = '前文\n\n<!-- seamind-paste-data:0 -->\n\n后文';
    expect(finalizeSkippedPasteMedia(raw)).toBe('前文\n\n后文');
  });

  it('converts ChatGPT HTML code fences, tables, KaTeX, images, and skips UI icons', () => {
    type AttrMap = Record<string, string>;
    class FakeNode {
      nodeType: number;
      localName: string;
      textContent: string | null;
      attrs: AttrMap;
      childNodes: FakeNode[] = [];
      parentElement: FakeNode | null = null;
      private serialized?: string;

      constructor(
        localName: string,
        attrs: AttrMap = {},
        children: Array<FakeNode | string> = [],
        serialized?: string,
      ) {
        if (localName === '#text') {
          this.nodeType = 3;
          this.localName = '#text';
          this.textContent = attrs.text ?? '';
          this.attrs = {};
          return;
        }
        this.nodeType = 1;
        this.localName = localName;
        this.attrs = attrs;
        this.textContent = null;
        this.serialized = serialized;
        for (const child of children) {
          const node =
            typeof child === 'string'
              ? new FakeNode('#text', { text: child })
              : child;
          node.parentElement = this;
          this.childNodes.push(node);
        }
        this.textContent = this.collectText();
      }

      private collectText(): string {
        if (this.nodeType === 3) return this.textContent ?? '';
        return this.childNodes.map((c) => c.collectText()).join('');
      }

      get children(): FakeNode[] {
        return this.childNodes.filter((c) => c.nodeType === 1);
      }

      get classList() {
        const set = new Set(
          (this.attrs.class ?? '').split(/\s+/).filter(Boolean),
        );
        return { contains: (name: string) => set.has(name) };
      }

      get outerHTML(): string {
        return this.serialized ?? `<${this.localName}></${this.localName}>`;
      }

      getAttribute(name: string): string | null {
        return this.attrs[name] ?? null;
      }

      matchesSelector(selector: string): boolean {
        return selector
          .split(',')
          .map((part) => part.trim())
          .some((part) => {
            if (part === '[role="button"]') return this.attrs.role === 'button';
            if (part.startsWith('.'))
              return this.classList.contains(part.slice(1));
            return this.localName.toLowerCase() === part.toLowerCase();
          });
      }

      closest(selector: string): FakeNode | null {
        if (this.matchesSelector(selector)) return this;
        let cur: FakeNode | null = this.parentElement;
        while (cur && cur.nodeType === 1) {
          if (cur.matchesSelector(selector)) return cur;
          cur = cur.parentElement;
        }
        return null;
      }

      querySelectorAll(selector: string): FakeNode[] {
        const out: FakeNode[] = [];
        const walk = (node: FakeNode) => {
          for (const child of node.children) {
            if (child.matchesSelector(selector)) out.push(child);
            walk(child);
          }
        };
        walk(this);
        return out;
      }

      querySelector(selector: string): FakeNode | null {
        return this.querySelectorAll(selector)[0] ?? null;
      }
    }

    const el = (
      tag: string,
      attrs: AttrMap = {},
      children: Array<FakeNode | string> = [],
      outerHTML?: string,
    ) => new FakeNode(tag, attrs, children, outerHTML);

    const katexInline = el('span', { class: 'katex' }, [
      el('span', { class: 'katex-mathml' }, [
        el('annotation', { encoding: 'application/x-tex' }, ['x^2 + y^2']),
      ]),
      el('span', { class: 'katex-html' }, ['garbled']),
    ]);
    const katexDisplay = el('span', { class: 'katex-display' }, [
      el('span', { class: 'katex' }, [
        el('annotation', { encoding: 'application/x-tex' }, ['P = I V']),
      ]),
    ]);
    const uiIconSvg = el('svg', { width: '16', height: '16' }, [
      el('path', { d: 'M0 0' }),
    ]);
    const chartSvg = el(
      'svg',
      { viewBox: '0 0 320 120' },
      [el('rect', { width: '100', height: '40' }), el('text', {}, ['ARP'])],
      '<svg viewBox="0 0 320 120"><rect width="100" height="40"/><text>ARP</text></svg>',
    );
    const body = el('body', {}, [
      el('h3', {}, ['ARP 原理']),
      el('p', {}, ['满足 ', katexInline, '。']),
      katexDisplay,
      el('pre', {}, [
        el('div', {}, [
          el('span', {}, ['mermaid']),
          el('button', {}, [uiIconSvg, '复制代码']),
        ]),
        el('code', { class: 'language-mermaid' }, ['graph TD\nA-->B']),
      ]),
      el('table', {}, [
        el('tr', {}, [el('th', {}, ['字段']), el('th', {}, ['值'])]),
        el('tr', {}, [el('td', {}, ['Opcode']), el('td', {}, ['1 | Request'])]),
      ]),
      el('img', {
        alt: 'ARP Packet',
        src: 'https://images.openai.com/static-rsc-4/arp',
      }),
      el('a', { href: 'https://cdn.example.com/ethernet-switch.jpg' }, [
        el('div', {}, [
          el('span', { class: 'sr-only' }, ['Open image']),
          el('img', {
            alt: 'ethernet switch',
            src: 'https://cdn.example.com/ethernet-switch.jpg',
          }),
        ]),
      ]),
      chartSvg,
    ]);

    expect(isContentSvgElement(uiIconSvg as unknown as Element)).toBe(false);
    expect(isContentSvgElement(chartSvg as unknown as Element)).toBe(true);

    const markdown = htmlToKnowledgeMarkdown({ body } as unknown as Document);
    expect(markdown).toContain('### ARP 原理');
    expect(markdown).toContain('满足 $x^2 + y^2$。');
    expect(markdown).not.toContain('garbled');
    expect(markdown).toContain('$$\nP = I V\n$$');
    expect(markdown).toContain('```mermaid\ngraph TD\nA-->B\n```');
    expect(markdown).not.toContain('复制代码');
    expect(markdown).toContain(
      '| 字段 | 值 |\n| --- | --- |\n| Opcode | 1 \\| Request |',
    );
    expect(markdown).toContain(
      '![ARP Packet](https://images.openai.com/static-rsc-4/arp)',
    );
    expect(markdown).toContain(
      '![ethernet switch](https://cdn.example.com/ethernet-switch.jpg)',
    );
    expect(markdown).not.toContain(
      '[![ethernet switch](https://cdn.example.com/ethernet-switch.jpg)]',
    );
    expect(markdown).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});
