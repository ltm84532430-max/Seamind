import { describe, expect, it } from 'vitest';
import {
  flattenReaderToc,
  matchReaderTocEntry,
} from '../src/agent/adapters/reader-toc';

const toc = [
  {
    label: '第1章 引言',
    href: 'ch1.xhtml',
    subitems: [
      { label: '1.1 背景', href: 'ch1.xhtml#s1' },
      {
        label: '1.2 范围',
        href: 'ch1.xhtml#s2',
        subitems: [{ label: '1.2.1 边界', href: 'ch1.xhtml#s2-1' }],
      },
    ],
  },
  { label: '第10章 总结', href: 'ch10.xhtml' },
  { label: 'Chapter 1', href: 'c1.xhtml' },
  { label: 'Chapter 10', href: 'c10.xhtml' },
  { label: 'Introduction', href: 'opening.xhtml' },
];

describe('reader TOC matching', () => {
  it('searches nested subitems and keeps parents ahead of children', () => {
    const flat = flattenReaderToc(toc);
    expect(flat.map((item) => item.label)).toEqual([
      '第1章 引言',
      '1.1 背景',
      '1.2 范围',
      '1.2.1 边界',
      '第10章 总结',
      'Chapter 1',
      'Chapter 10',
      'Introduction',
    ]);
  });

  it('prefers an exact label over a later prefix or contains hit', () => {
    const matched = matchReaderTocEntry(toc, 'Chapter 1');
    expect(matched?.href).toBe('c1.xhtml');
  });

  it('does not let a short number land inside a longer number', () => {
    const flat = flattenReaderToc(toc);
    expect(matchReaderTocEntry(flat, '1')?.label).toBe('第1章 引言');
    expect(matchReaderTocEntry(flat, '1.1')?.label).toBe('1.1 背景');
    expect(matchReaderTocEntry(flat, '10')?.label).toBe('第10章 总结');
    expect(matchReaderTocEntry(flat, '第1章')?.label).toBe('第1章 引言');
    expect(matchReaderTocEntry(flat, '第10章')?.label).toBe('第10章 总结');
    expect(matchReaderTocEntry(flat, '1.2.1')?.label).toBe('1.2.1 边界');
  });

  it('treats a letter prefix as a different word', () => {
    expect(matchReaderTocEntry(toc, 'intro')).toBeUndefined();
    expect(matchReaderTocEntry(toc, 'introduction')?.href).toBe(
      'opening.xhtml',
    );
  });

  it('matches an href exactly ahead of a label that merely contains it', () => {
    const rows = [
      { label: 'see ch1.xhtml later', href: 'notes.xhtml' },
      { label: '正文', href: 'ch1.xhtml' },
    ];
    expect(matchReaderTocEntry(rows, 'ch1.xhtml')?.label).toBe('正文');
  });

  it('keeps the earlier row when two labels rank the same', () => {
    const rows = [
      { label: '概述', href: 'a.xhtml' },
      { label: '概述', href: 'b.xhtml' },
    ];
    expect(matchReaderTocEntry(rows, '概述')?.href).toBe('a.xhtml');
  });

  it('returns nothing for a blank query', () => {
    expect(matchReaderTocEntry(toc, '   ')).toBeUndefined();
  });
});
