import { describe, expect, it } from 'vitest';
import {
  cleanPdfSelectionText,
  computePageContentHash,
  groupTextBoxesIntoParagraphs,
  isShortTermSelection,
  pagesForMode,
  resolvedMode,
  spreadStart,
  type RawTextBox,
} from '../src/literature/paper-pdf-layout';

describe('cleanPdfSelectionText', () => {
  it('joins hyphenated academic line wraps and flattens soft newlines', () => {
    const raw =
      'Explainable artificial intel-\nligence enables stake-\nholders to audit model behavior.\n\nSecond para-\ngraph starts here.';
    expect(cleanPdfSelectionText(raw)).toBe(
      'Explainable artificial intelligence enables stakeholders to audit model behavior.\n\nSecond paragraph starts here.',
    );
  });

  it('joins CJK wrapped lines without inserting extraneous spaces', () => {
    const raw = '机器学习模型在复杂场景下\n的可解释性评估研究';
    expect(cleanPdfSelectionText(raw)).toBe(
      '机器学习模型在复杂场景下的可解释性评估研究',
    );
  });
});

describe('isShortTermSelection', () => {
  it('detects single words and compact academic terms vs full sentences', () => {
    expect(isShortTermSelection('explainability')).toBe(true);
    expect(isShortTermSelection('Gradient Attribution')).toBe(true);
    expect(isShortTermSelection('自注意力机制')).toBe(true);
    expect(
      isShortTermSelection(
        'This method significantly outperforms existing baselines across benchmarks.',
      ),
    ).toBe(false);
    expect(isShortTermSelection('123.45')).toBe(false);
  });
});

describe('groupTextBoxesIntoParagraphs', () => {
  it('reconstructs reading order for hybrid title plus two-column layout and filters margins', () => {
    const boxes: RawTextBox[] = [
      // Vertical arXiv watermark
      {
        str: 'arXiv:2410.11896v1',
        x: 0.02,
        y: 0.35,
        width: 0.02,
        height: 0.25,
        isVertical: true,
      },
      // Full-span title
      {
        str: 'Study on Explainable AI',
        x: 0.22,
        y: 0.1,
        width: 0.56,
        height: 0.024,
      },
      // Left column paragraph 1 (two lines)
      {
        str: 'Artificial intelligence systems require',
        x: 0.08,
        y: 0.2,
        width: 0.38,
        height: 0.014,
      },
      {
        str: 'transparent evaluation protocols.',
        x: 0.08,
        y: 0.22,
        width: 0.32,
        height: 0.014,
      },
      // Left column paragraph 2 (with vertical gap)
      {
        str: 'Second left paragraph continues',
        x: 0.08,
        y: 0.265,
        width: 0.38,
        height: 0.014,
      },
      {
        str: 'the empirical discussion here.',
        x: 0.08,
        y: 0.285,
        width: 0.33,
        height: 0.014,
      },
      // Right column at the SAME Y as left column!
      {
        str: 'Meanwhile the right column starts',
        x: 0.54,
        y: 0.2,
        width: 0.38,
        height: 0.014,
      },
      {
        str: 'after finishing the left column.',
        x: 0.54,
        y: 0.22,
        width: 0.35,
        height: 0.014,
      },
      // Footer page number
      {
        str: '2',
        x: 0.49,
        y: 0.955,
        width: 0.02,
        height: 0.012,
      },
    ];

    const blocks = groupTextBoxesIntoParagraphs(boxes, 1);
    expect(blocks.length).toBe(4);
    expect(blocks[0]).toMatchObject({
      column: 'full',
      isHeading: true,
      text: 'Study on Explainable AI',
    });
    expect(blocks[1]).toMatchObject({
      column: 'left',
      text: 'Artificial intelligence systems require transparent evaluation protocols.',
    });
    expect(blocks[2]).toMatchObject({
      column: 'left',
      text: 'Second left paragraph continues the empirical discussion here.',
    });
    expect(blocks[3]).toMatchObject({
      column: 'right',
      text: 'Meanwhile the right column starts after finishing the left column.',
    });
  });

  it('keeps single-column pages with short trailing lines in strict vertical order', () => {
    const boxes: RawTextBox[] = [
      {
        str: 'First paragraph has a long opening line across the width',
        x: 0.14,
        y: 0.18,
        width: 0.72,
        height: 0.015,
      },
      {
        str: 'and a short concluding line.',
        x: 0.14,
        y: 0.2,
        width: 0.28,
        height: 0.015,
      },
      {
        str: '1 Introduction',
        x: 0.14,
        y: 0.25,
        width: 0.2,
        height: 0.02,
      },
      {
        str: 'Second section begins with another broad single-column line.',
        x: 0.14,
        y: 0.29,
        width: 0.7,
        height: 0.015,
      },
    ];

    const blocks = groupTextBoxesIntoParagraphs(boxes, 2);
    expect(blocks.map((b) => b.column)).toEqual(['full', 'full', 'full']);
    expect(blocks[0].text).toBe(
      'First paragraph has a long opening line across the width and a short concluding line.',
    );
    expect(blocks[1].isHeading).toBe(true);
    expect(blocks[2].text).toContain('Second section begins');
  });

  it('produces deterministic 64-char sha256 hex digests for page paragraphs', async () => {
    const hashA = await computePageContentHash([
      { id: 0, text: 'Hello   world' },
      { id: 1, text: 'Second paragraph' },
    ]);
    const hashB = await computePageContentHash([
      { id: 0, text: 'Hello world' },
      { id: 1, text: 'Second paragraph' },
    ]);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashA).toBe(hashB);
  });
});

describe('paper reader layout', () => {
  it('picks a spread on a wide page and keeps a single page on a narrow one', () => {
    expect(resolvedMode('auto', 1200, 800)).toBe('spread');
    expect(resolvedMode('auto', 900, 800)).toBe('single');
    expect(resolvedMode('scroll', 1200, 800)).toBe('scroll');
    expect(spreadStart(4)).toBe(3);
    expect(pagesForMode(4, 10, 'spread')).toEqual([3, 4]);
    expect(pagesForMode(10, 10, 'spread')).toEqual([9, 10]);
    expect(pagesForMode(3, 10, 'single')).toEqual([3]);
  });
});
