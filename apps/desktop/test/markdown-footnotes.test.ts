import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createMarkdownFootnoteEditorExtension } from '../src/workbench/markdown-footnote-cm';
import {
  appendEpubFootnoteToMarkdown,
  buildFootnotesSectionHtml,
  computeFootnoteEnterContinuation,
  computeFootnotePopoverGeometry,
  extractFootnoteAnchorContext,
  extractMarkdownFootnoteSyntaxZones,
  formatFootnoteDefinitionBlock,
  formatTextForFootnotePaste,
  insertFootnoteIntoMarkdown,
  parseMarkdownFootnotes,
  removeFootnoteFromMarkdown,
  upsertFootnoteInMarkdown,
} from '../src/workbench/markdown-footnotes';

describe('markdown-footnotes', () => {
  it('parses multi-line footnotes, orders by body reference, and ignores regex/code/frontmatter brackets', () => {
    const markdown = [
      '---',
      'title: "[^front]: fake"',
      '---',
      '',
      '# 第10章 指针与数组',
      '',
      '输入过滤 regex [^0-9] 与行内代码 `[^inline]: ignored` 不应识别为脚注。',
      '',
      '这里先引用命名脚注[^ptr]，再引用数字脚注[^1]。',
      '',
      '```c',
      '// [^1]: inside code fence',
      'scanf("%[^\\n]", buf);',
      '```',
      '',
      '<!--',
      '[^hidden]: inside html comment',
      '-->',
      '',
      '[^1]: 数字脚注正文。',
      '[^ptr]: 指针步长等于所指类型字节数。',
      '',
      '    第二段缩进续行 *要点*。',
      '[^orphan]: 未在正文引用但已定义的脚注。',
    ].join('\n');

    const parsed = parseMarkdownFootnotes(markdown);

    expect(parsed.footnotes).toHaveLength(3);
    expect(parsed.footnotes.map((fn) => fn.id)).toEqual(['ptr', '1', 'orphan']);
    expect(parsed.footnotes.map((fn) => fn.index)).toEqual([1, 2, 3]);
    expect(parsed.footnotes[0].content).toContain('第二段缩进续行');
    expect(parsed.footnotes[0].plainText).toContain('要点');
    expect(parsed.footnotes[0].refLineIndices).toEqual([8]);
    expect(parsed.footnotes[2].refLineIndices).toEqual([]);

    expect(parsed.bodyWithoutDefinitions).not.toContain('[^ptr]:');
    expect(parsed.bodyWithoutDefinitions).not.toContain('第二段缩进续行');
    expect(parsed.bodyWithoutDefinitions).toContain('regex [^0-9]');
    expect(parsed.bodyWithoutDefinitions).toContain('[^1]: inside code fence');
  });

  it('inserts sequential footnote references and computes exact cursor offset inside definition', () => {
    const start = '指针变量保存地址。\n';
    const first = insertFootnoteIntoMarkdown(start, { from: 8, to: 8 }, '');

    expect(first.id).toBe('1');
    expect(first.nextSource).toContain('指针变量保存地址[^1]。');
    expect(first.nextSource.trimEnd().endsWith('[^1]:')).toBe(true);
    expect(
      first.nextSource.slice(0, first.defCursorOffset).endsWith('[^1]: '),
    ).toBe(true);

    const second = insertFootnoteIntoMarkdown(
      first.nextSource.replace('[^1]: ', '[^1]: 首条说明'),
      { from: 2, to: 2 },
      '',
    );
    expect(second.id).toBe('2');
    expect(second.nextSource).toContain('指针[^2]变量保存地址[^1]。');
    expect(second.nextSource).toContain('[^2]: ');
  });

  it('appends EPUB annotations cleanly and updates existing synced annotations in place without duplication', () => {
    const initial = '# 笔记\n\n已有的记录。\n';
    const firstSync = appendEpubFootnoteToMarkdown(initial, {
      annotationId: 'ann-42',
      quote: 'const int *p 与 int * const p 的区别',
      note: '前者指向常量，后者指针本身不可变',
      chapterLabel: '10.4 const 指针',
    });

    expect(firstSync.isUpdate).toBe(false);
    expect(firstSync.footnoteId).toBe('epub-1');
    expect(firstSync.nextSource).toContain(
      '> “const int *p 与 int * const p 的区别”[^epub-1]',
    );
    expect(firstSync.nextSource).toContain('<!-- epub:ann-42 -->');

    const parsedOnce = parseMarkdownFootnotes(firstSync.nextSource);
    expect(parsedOnce.footnotes).toHaveLength(1);
    expect(parsedOnce.footnotes[0].epubAnnotationId).toBe('ann-42');
    expect(parsedOnce.footnotes[0].plainText).not.toContain('epub:ann-42');

    const secondSync = appendEpubFootnoteToMarkdown(firstSync.nextSource, {
      annotationId: 'ann-42',
      quote: 'const int *p 与 int * const p 的区别',
      note: '已补充：右结合原则判定 const 修饰目标',
      aiAnalysis: '【核心】从右向左读声明',
      chapterLabel: '10.4 const 指针',
    });

    expect(secondSync.isUpdate).toBe(true);
    expect(secondSync.footnoteId).toBe('epub-1');

    const parsedTwice = parseMarkdownFootnotes(secondSync.nextSource);
    expect(parsedTwice.footnotes).toHaveLength(1);
    expect(parsedTwice.footnotes[0].plainText).toContain('右结合原则');
    expect(parsedTwice.footnotes[0].plainText).toContain('AI 解析');
  });

  it('renders footnotes section HTML with escaped IDs and ordered backref links', () => {
    const { footnotes } = parseMarkdownFootnotes(
      '第一句[^a/b]，再次引用[^a/b]。\n\n[^a/b]: **强调说明**\n',
    );
    const refCounts = new Map<string, number>([['a/b', 2]]);
    const html = buildFootnotesSectionHtml(
      footnotes,
      (md) => `<p>${md}</p>`,
      refCounts,
    );

    expect(html).toContain('class="seamind-footnotes"');
    expect(html).toContain('data-footnote-def-id="a/b"');
    expect(html).toContain('data-footnote-backref="a/b"');
    expect(html).toContain('↩1');
    expect(html).toContain('↩2');
  });

  it('removes a footnote definition, continuation lines, and inline references cleanly while preserving code fences', () => {
    const markdown = [
      '# 笔记',
      '',
      '这里有一个脚注[^2]，行内代码 `[^2]` 与代码块应当保留。',
      '',
      '```md',
      '[^2] 示例代码内引用',
      '[^2]: 示例代码内定义',
      '```',
      '',
      '后续引用[^keep]与[^2]。',
      '',
      '[^2]: 要删除的多行脚注。',
      '',
      '    第二段缩进内容。',
      '[^keep]: 保留的脚注。',
    ].join('\n');

    const removedTarget = removeFootnoteFromMarkdown(markdown, '2');
    expect(removedTarget.removed).toBe(true);
    expect(removedTarget.nextSource).not.toContain('要删除的多行脚注');
    expect(removedTarget.nextSource).not.toContain('第二段缩进内容');
    expect(removedTarget.nextSource).toContain(
      '这里有一个脚注，行内代码 `[^2]`',
    );
    expect(removedTarget.nextSource).toContain('后续引用[^keep]与。');
    expect(removedTarget.nextSource).toContain('[^2] 示例代码内引用');
    expect(removedTarget.nextSource).toContain('[^keep]: 保留的脚注。');

    const removedLast = removeFootnoteFromMarkdown(
      `${removedTarget.nextSource}\n`,
      'keep',
    );
    expect(removedLast.removed).toBe(true);
    expect(removedLast.nextSource.endsWith('[^keep]: 保留的脚注。\n')).toBe(
      false,
    );
    expect(removedLast.nextSource.endsWith('\n\n')).toBe(false);
    expect(
      parseMarkdownFootnotes(removedLast.nextSource).footnotes,
    ).toHaveLength(0);

    const missing = removeFootnoteFromMarkdown(removedLast.nextSource, 'nope');
    expect(missing.removed).toBe(false);
    expect(missing.nextSource).toBe(removedLast.nextSource);
  });

  it('computes bounded below/above popover geometry inside the preview frame', () => {
    const frameRect = {
      left: 100,
      top: 50,
      right: 780,
      bottom: 650,
      width: 680,
      height: 600,
    };
    const contentRect = {
      left: 100,
      top: 50,
      right: 700,
      bottom: 650,
      width: 600,
      height: 600,
    };

    const nearTop = computeFootnotePopoverGeometry(frameRect, contentRect, {
      left: 640,
      top: 120,
      right: 660,
      bottom: 138,
      width: 20,
      height: 18,
    });
    expect(nearTop.width).toBe(380);
    expect(nearTop.left).toBe(208);
    expect(nearTop.top).toBe(94);
    expect(nearTop.bottom).toBeUndefined();
    expect(nearTop.maxHeight).toBe(360);

    const nearBottom = computeFootnotePopoverGeometry(frameRect, contentRect, {
      left: 180,
      top: 590,
      right: 200,
      bottom: 610,
      width: 20,
      height: 20,
    });
    expect(nearBottom.top).toBeUndefined();
    expect(nearBottom.bottom).toBe(66);
    expect(nearBottom.maxHeight).toBe(360);
  });

  it('serializes multi-paragraph and fenced footnotes cleanly via formatFootnoteDefinitionBlock and upsertFootnoteInMarkdown', () => {
    const pastedBody = [
      '动态内存分配（Dynamic Memory Allocation）在实际工程中非常重要：',
      '',
      '程序运行之前，我们不一定知道需要多少内存。',
      '',
      '例如，每天读取的行情规模不同。',
    ].join('\n');

    const block = formatFootnoteDefinitionBlock('2', pastedBody);
    expect(block).toBe(
      [
        '[^2]: 动态内存分配（Dynamic Memory Allocation）在实际工程中非常重要：',
        '',
        '    程序运行之前，我们不一定知道需要多少内存。',
        '',
        '    例如，每天读取的行情规模不同。',
      ].join('\n'),
    );

    const fencedBlock = formatFootnoteDefinitionBlock(
      '3',
      '```c\nint *p = malloc(sizeof(int));\n```',
      'epub-ann-9',
    );
    expect(fencedBlock).toBe(
      [
        '[^3]: <!-- epub:epub-ann-9 -->',
        '    ```c',
        '    int *p = malloc(sizeof(int));',
        '    ```',
      ].join('\n'),
    );

    const doc = '# 标题\n\n动态内存分配就是为了解决这类问题。\n';
    const created = upsertFootnoteInMarkdown(doc, {
      mode: 'create',
      selection: { from: doc.length - 1, to: doc.length - 1 },
      content: pastedBody,
    });
    expect(created.id).toBe('1');
    expect(created.cursorOffsetAfterRef).toBe(doc.length - 1 + '[^1]'.length);

    const parsedCreated = parseMarkdownFootnotes(created.nextSource);
    expect(parsedCreated.bodyWithoutDefinitions.trim()).toBe(
      '# 标题\n\n动态内存分配就是为了解决这类问题。[^1]',
    );
    expect(parsedCreated.footnotes).toHaveLength(1);
    expect(parsedCreated.footnotes[0].content).toContain(
      '例如，每天读取的行情规模不同。',
    );
  });

  it('edits an existing footnote in-place while preserving epub markers and body text', () => {
    const src = [
      '正文一段[^fn1]。',
      '',
      '正文二段。',
      '',
      '[^fn1]: <!-- epub:hl-77 --> 旧注释内容',
      '    旧第二行',
      '',
      '[^2]: 其他脚注',
    ].join('\n');

    const edited = upsertFootnoteInMarkdown(src, {
      mode: 'edit',
      id: 'fn1',
      content: '更新后的第一段\n\n更新后的第二段',
    });

    expect(edited.id).toBe('fn1');
    expect(edited.nextSource).toContain('<!-- epub:hl-77 --> 更新后的第一段');
    expect(edited.nextSource).toContain('    更新后的第二段');
    expect(edited.nextSource).toContain('正文二段。');
    expect(edited.nextSource).toContain('[^2]: 其他脚注');

    const parsed = parseMarkdownFootnotes(edited.nextSource);
    expect(parsed.footnotes.map((fn) => fn.id)).toEqual(['fn1', '2']);
    expect(parsed.footnotes[0].content).toBe(
      '更新后的第一段\n\n更新后的第二段',
    );
    expect(parsed.footnotes[0].epubAnnotationId).toBe('hl-77');
  });

  it('extracts accurate syntax zones, auto-indents pastes, and continues or exits Enter inside footnotes', () => {
    const doc = [
      '正文引用[^a]与[^b]。',
      '',
      '[^a]: 第一行',
      '',
      '    第二段',
      '',
      '回归正文。',
    ].join('\n');

    const zones = extractMarkdownFootnoteSyntaxZones(doc);
    expect(zones.definitions).toEqual([
      {
        id: 'a',
        index: 1,
        startLine: 2,
        endLine: 4,
        markerLength: 5,
      },
    ]);
    expect(zones.references).toEqual([
      { id: 'a', lineIndex: 0, fromCol: 4, toCol: 8 },
    ]);

    // Pasting multi-paragraph text after `[^a]: 第一行` keeps later paragraphs inside footnote
    const pasteOffset = doc.indexOf('第一行') + '第一行'.length;
    const pasteResult = formatTextForFootnotePaste(
      doc,
      pasteOffset,
      pasteOffset,
      '补充\n\n跨空行段落',
    );
    expect(pasteResult).toEqual({
      insideFootnote: true,
      text: '补充\n\n    跨空行段落',
    });

    // Cursor inside `[^a]:` marker prefix or in body text leaves paste untouched
    const bodyPaste = formatTextForFootnotePaste(doc, 2, 2, 'A\n\nB');
    expect(bodyPaste).toEqual({ insideFootnote: false, text: 'A\n\nB' });

    const beforeColonOffset = doc.indexOf('[^a]:') + 2;
    expect(
      formatTextForFootnotePaste(
        doc,
        beforeColonOffset,
        beforeColonOffset,
        'A\nB',
      ).insideFootnote,
    ).toBe(false);

    // Enter inside a footnote continues with 4 spaces; Enter on an empty 4-space line exits
    const enterContinue = computeFootnoteEnterContinuation(doc, pasteOffset);
    expect(enterContinue).toEqual({
      from: pasteOffset,
      to: pasteOffset,
      insert: '\n    ',
      cursorOffset: pasteOffset + 5,
    });

    const docWithEmptyIndent = '[^1]: 内容\n    \n正文';
    const emptyLineStart = docWithEmptyIndent.indexOf('    ');
    const enterExit = computeFootnoteEnterContinuation(
      docWithEmptyIndent,
      emptyLineStart + 4,
    );
    expect(enterExit).toEqual({
      from: emptyLineStart,
      to: emptyLineStart + 4,
      insert: '\n',
      cursorOffset: emptyLineStart + 1,
    });

    // Anchor context trims cleanly around cursor
    expect(extractFootnoteAnchorContext(doc, 4)).toBe('正文引用[^a]与[^b]。');

    // CodeMirror extension initializes cleanly without throwing on valid footnote docs
    const cmState = EditorState.create({
      doc,
      extensions: [createMarkdownFootnoteEditorExtension()],
    });
    expect(cmState.doc.toString()).toBe(doc);
  });
});
