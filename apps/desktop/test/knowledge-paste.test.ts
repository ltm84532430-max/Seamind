import { describe, expect, it } from 'vitest';
import {
  analyzeKnowledgePaste,
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
});
