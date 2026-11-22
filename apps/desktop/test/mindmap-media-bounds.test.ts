import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Transformer } from 'markmap-lib';
import { pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import {
  defaultMindmapMediaBounds,
  normalizeMindmapMediaBounds,
} from '../src/app/app-storage';
import { clampCustomMediaWidth } from '../src/workbench/mindmap-media-card';
import {
  applyMarkdownNodeCommand,
  buildMarkdownNodeSourceMap,
  markdownForMindmap,
  normalizeMindmapText,
} from '../src/mindmap/commands';
import {
  extractClipboardImageCandidate,
  formatImagePasteForMarkdownEditor,
  parseNodeImageMarkdownInput,
} from '../src/mindmap/mindmap-image-paste';

const transformer = new Transformer([pluginFrontmatter, pluginSourceLines]);

describe('mindmap imported media bounds', () => {
  it('returns default bounds for empty or invalid input', () => {
    expect(normalizeMindmapMediaBounds(undefined)).toEqual(
      defaultMindmapMediaBounds,
    );
    expect(
      normalizeMindmapMediaBounds({
        minWidth: Number.NaN,
        maxWidth: Infinity,
        maxHeight: -50,
      }),
    ).toEqual({
      minWidth: 160,
      maxWidth: 420,
      maxHeight: 120,
      syncToPreview: true,
    });
  });

  it('clamps bounds within valid limits and enforces maxWidth >= minWidth', () => {
    expect(
      normalizeMindmapMediaBounds({
        minWidth: 360,
        maxWidth: 200,
        maxHeight: 2000,
        syncToPreview: false,
      }),
    ).toEqual({
      minWidth: 360,
      maxWidth: 360,
      maxHeight: 900,
      syncToPreview: false,
    });

    expect(
      normalizeMindmapMediaBounds({
        minWidth: 20,
        maxWidth: 9999,
        maxHeight: 400,
      }),
    ).toEqual({
      minWidth: 80,
      maxWidth: 1200,
      maxHeight: 400,
      syncToPreview: true,
    });
  });

  it('clamps dragged single-image width safely', () => {
    expect(clampCustomMediaWidth(12)).toBe(60);
    expect(clampCustomMediaWidth(520.6)).toBe(521);
    expect(clampCustomMediaWidth(3000)).toBe(1400);
    expect(clampCustomMediaWidth(Number.NaN)).toBe(360);
  });
});

describe('mindmap local screenshot paste & node image promotion', () => {
  const originalDocument = globalThis.document;

  beforeAll(() => {
    if (typeof globalThis.document === 'undefined') {
      (globalThis as unknown as { document: unknown }).document = {
        createElement: () => ({
          set innerHTML(v: string) {
            this._v = String(v).replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
              String.fromCodePoint(Number.parseInt(hex, 16)),
            );
          },
          get value() {
            return this._v ?? '';
          },
          _v: '',
        }),
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
  });

  it('extracts clipboard screenshot files and data-url HTML images', () => {
    const pngFile = {
      name: 'screenshot.png',
      type: 'image/png',
      size: 2048,
    } as File;
    const fromFiles = extractClipboardImageCandidate({
      files: [pngFile],
      items: [],
      getData: () => '',
    } as unknown as DataTransfer);
    expect(fromFiles).toMatchObject({
      kind: 'file',
      label: 'screenshot.png',
      value: pngFile,
    });

    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const fromHtml = extractClipboardImageCandidate({
      files: [],
      items: [],
      getData: (type: string) =>
        type === 'text/html' ? `<img src="${dataUri}" alt="账户接入截图">` : '',
    } as unknown as DataTransfer);
    expect(fromHtml).toMatchObject({
      kind: 'data',
      label: '账户接入截图',
      value: dataUri,
    });
  });

  it('promotes pasted screenshot on 新主题 rename into standalone image node and preserves label', () => {
    const mediaId = 'a'.repeat(64);
    const md = [
      '# 工程',
      '## 账户接入 <!-- seamind:id=acc-1 -->',
      '### 新主题 <!-- seamind:id=node-new -->',
    ].join('\n');

    const { root } = transformer.transform(markdownForMindmap(md));
    const sources = buildMarkdownNodeSourceMap(md, root);
    const targetSource = [...sources.values()].find(
      (src) => src.id === 'node-new',
    )!;

    const imageMd = `![剪贴板截图](seamind-media:${mediaId})`;
    expect(parseNodeImageMarkdownInput(imageMd)).toEqual({
      prefixText: '',
      imageMarkdown: imageMd,
      suffixText: '',
    });

    const result = applyMarkdownNodeCommand(
      md,
      targetSource,
      'rename',
      imageMd,
    );
    expect(result.markdown).not.toContain('### 新主题');
    expect(result.markdown).toContain(
      `<!-- seamind:id=node-new -->\n${imageMd}`,
    );

    const { root: nextRoot } = transformer.transform(
      markdownForMindmap(result.markdown),
    );
    const imageLeaf = nextRoot.children[0].children[0];
    expect(imageLeaf.content).toContain('<img');
    expect(normalizeMindmapText(imageLeaf.content)).toBe('剪贴板截图');

    const nextSources = buildMarkdownNodeSourceMap(result.markdown, nextRoot);
    const savedImageSource = [...nextSources.values()].find(
      (src) => src.id === 'node-new',
    );
    expect(savedImageSource?.kind).toBe('block');
    expect(savedImageSource?.label).toBe('剪贴板截图');
  });

  it('replaces placeholder heading line when pasting screenshot in Markdown editor', () => {
    const mediaId = 'b'.repeat(64);
    const doc = '# 标题\n##### 新主题 <!-- seamind:id=img-holder -->\n后续段落';
    const start = doc.indexOf('新主题');
    const end = start + '新主题'.length;
    const imageLine = `![剪贴板截图](seamind-media:${mediaId})`;

    const edit = formatImagePasteForMarkdownEditor(doc, start, end, imageLine);
    const updated =
      doc.slice(0, edit.replaceFrom) + edit.text + doc.slice(edit.replaceTo);

    expect(updated).toContain(
      `<!-- seamind:id=img-holder -->\n${imageLine}\n\n后续段落`,
    );
    expect(updated).not.toContain('#####');
  });
});
