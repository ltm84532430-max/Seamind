import { describe, expect, it } from 'vitest';
import { extractMarkdownHeadings } from '../src/workbench/markdown-outline';

const outline = (markdown: string) =>
  extractMarkdownHeadings(markdown).map(
    ({ depth, text, lineIndex }) => `${depth}:${text}@${lineIndex}`,
  );

describe('extractMarkdownHeadings', () => {
  it('lists # headings with their depth and line', () => {
    expect(outline('# One\n\ntext\n\n## Two\n###### Six\n')).toEqual([
      '1:One@0',
      '2:Two@4',
      '6:Six@5',
    ]);
  });

  it('needs a space after the hashes and allows at most six', () => {
    expect(outline('#hashtag\n####### seven\n#\n## real')).toEqual([
      '2:real@3',
    ]);
  });

  it('drops the closing hashes and the inline markup', () => {
    expect(
      outline(
        '## Title ##\n# C#\n# a **bold** and `code` and [link](http://x) and ![alt](y.png)\n# snake_case_name _em_',
      ),
    ).toEqual([
      '2:Title@0',
      '1:C#@1',
      '1:a bold and code and link and alt@2',
      '1:snake_case_name em@3',
    ]);
  });

  it('skips headings inside code fences, whatever the fence is', () => {
    const markdown = [
      '# Real',
      '```md',
      '# not a heading',
      '```',
      '~~~~',
      '## nor this',
      '~~~',
      '## still inside the longer fence',
      '~~~~',
      '## After',
    ].join('\n');
    expect(outline(markdown)).toEqual(['1:Real@0', '2:After@9']);
  });

  it('does not take inline code that starts a line for a fence', () => {
    expect(outline('```x``` is inline\n# Heading')).toEqual(['1:Heading@1']);
  });

  it('skips HTML comments and a leading front matter', () => {
    const markdown = [
      '---',
      'title: x',
      '# yaml comment',
      '---',
      '# Title',
      '<!--',
      '# hidden',
      '-->',
      '## Visible',
    ].join('\n');
    expect(outline(markdown)).toEqual(['1:Title@4', '2:Visible@8']);
  });

  it('finds setext headings, also under several paragraph lines', () => {
    const markdown = [
      'Big',
      '===',
      '',
      'Small',
      '---',
      '',
      'Two line',
      'heading',
      '---',
      '',
      'plain paragraph',
      'continues here',
      '',
      '---',
    ].join('\n');
    expect(outline(markdown)).toEqual([
      '1:Big@0',
      '2:Small@3',
      '2:Two line heading@6',
    ]);
  });

  it('does not take a list item or a quote for a setext heading', () => {
    expect(outline('- item\n---\n\n> quote\n===\n')).toEqual([]);
  });

  it('puts a setext heading right after an ATX heading', () => {
    expect(outline('# Top\nbody line\n---\n')).toEqual([
      '1:Top@0',
      '2:body line@1',
    ]);
  });

  it('reads CRLF text and skips indented code', () => {
    expect(outline('# A\r\n\r\n    # code\r\n## B\r\n')).toEqual([
      '1:A@0',
      '2:B@3',
    ]);
  });

  it('has nothing for an empty document', () => {
    expect(outline('')).toEqual([]);
    expect(outline('just text')).toEqual([]);
  });
});
