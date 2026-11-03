import { describe, expect, it } from 'vitest';
import {
  defaultExamMix,
  examMixTotal,
  makeExamBatches,
  validateGeneratedExam,
} from '../src/epub-exam-generation';
import { resolveExamSourcePlan } from '../src/epub-exam-source';

const toc = [
  {
    href: 'ch5.html',
    label: '第5章 运算符',
    subitems: [{ href: 'ch5.html#s51', label: '5.1' }],
  },
  {
    href: 'ch6.html',
    label: '第6章 C控制语句：循环',
    subitems: [
      {
        href: 'ch6.html#s61',
        label: '6.1 再探while循环',
        subitems: [{ href: 'ch6.html#s611', label: '6.1.1 程序注释' }],
      },
      { href: 'ch6b.html#s62', label: '6.2 while语句' },
    ],
  },
  {
    href: 'ch7.html',
    label: '第7章 分支',
    subitems: [{ href: 'ch7.html#s71', label: '7.1' }],
  },
];
const resolve = (href: string) => ({
  index: href.startsWith('ch5')
    ? 0
    : href.startsWith('ch6b')
      ? 2
      : href.startsWith('ch6')
        ? 1
        : 3,
});

describe('EPUB exam scope and batch allocation', () => {
  it('selects chapter six across two spine files and stops before chapter seven', () => {
    const chapter = resolveExamSourcePlan(
      toc,
      'ch6.html#s61',
      null,
      1,
      resolve,
      'chapter',
    );
    expect(chapter?.label).toContain('第6章');
    expect(chapter?.items.map((item) => item.label)).toEqual([
      '第6章 C控制语句：循环',
      '6.1 再探while循环',
      '6.1.1 程序注释',
      '6.2 while语句',
    ]);
    expect(chapter?.items.map((item) => item.sectionIndex)).toEqual([
      1, 1, 1, 2,
    ]);
    expect(chapter?.items.some((item) => item.label.includes('第7章'))).toBe(
      false,
    );
    const section = resolveExamSourcePlan(
      toc,
      'ch6.html#s61',
      null,
      1,
      resolve,
      'section',
    );
    expect(section?.items.map((item) => item.label)).toEqual([
      '6.1 再探while循环',
      '6.1.1 程序注释',
    ]);
  });

  it('refuses whole chapter scope when the TOC has no chapter boundary', () => {
    expect(
      resolveExamSourcePlan(
        [{ href: 'a.html', label: 'Introduction' }],
        'a.html',
        null,
        0,
        resolve,
        'chapter',
      ),
    ).toBeNull();
  });

  it('allocates 50 questions and all source fragments without silently dropping them', () => {
    const mix = defaultExamMix(50, true);
    expect(examMixTotal(mix)).toBe(50);
    const segments = Array.from({ length: 14 }, (_, index) => ({
      href: `ch6.html#s${index}`,
      label: `6.${index}`,
      text: `内容 ${index}\n`.repeat(800),
      sectionIndex: index,
    }));
    const batches = makeExamBatches(segments, mix);
    expect(batches.every((batch) => examMixTotal(batch.mix) <= 8)).toBe(true);
    expect(
      batches.flatMap((batch) => batch.sources).map((item) => item.href),
    ).toEqual(segments.map((item) => item.href));
    expect(
      batches.reduce((sum, batch) => sum + examMixTotal(batch.mix), 0),
    ).toBe(50);
  });

  it('rejects missing coverage and duplicated prompts', () => {
    const mix = {
      objective: 2,
      comprehensive: 0,
      engineering: 0,
      cProgramming: 0,
    };
    const segments = [
      { href: 'a', label: 'A', text: 'A', sectionIndex: 0 },
      { href: 'b', label: 'B', text: 'B', sectionIndex: 1 },
    ];
    const question = {
      id: '1',
      type: 'singleChoice' as const,
      prompt: '问题',
      options: ['对', '错'],
      answer: '对',
      explanation: '解析',
      sourceRefs: [{ href: 'a', label: 'A' }],
    };
    expect(() =>
      validateGeneratedExam(
        [question, { ...question, id: '2' }],
        mix,
        segments,
      ),
    ).toThrow(/重复/);
    expect(() =>
      validateGeneratedExam(
        [question, { ...question, id: '2', prompt: '不同问题' }],
        mix,
        segments,
      ),
    ).toThrow(/未覆盖/);
  });
});
