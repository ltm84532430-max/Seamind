import { describe, expect, it } from 'vitest';
import type { MapDocument } from '../src/library/library';
import {
  groupKnowledgeBySource,
  knowledgeOrigin,
} from '../src/knowledge/knowledge-origin';

const note = (overrides: Partial<MapDocument> = {}): MapDocument => ({
  id: 'n1',
  relativePath: '笔记.md',
  title: '笔记',
  category: '随笔',
  mapType: '文档',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  kind: 'doc',
  ...overrides,
});

describe('knowledge source pages', () => {
  it('uses explicit provenance before old folder hints', () => {
    expect(
      knowledgeOrigin(note({ origin: 'manual', category: '视频笔记' })),
    ).toBe('manual');
    expect(knowledgeOrigin(note({ origin: 'ebook', category: '随笔' }))).toBe(
      'ebook',
    );
    expect(
      knowledgeOrigin(note({ origin: 'unknown', mapType: '视频字幕' })),
    ).toBe('player');
    expect(knowledgeOrigin(note({ origin: 'unknown', mapType: '通用' }))).toBe(
      'unknown',
    );
  });

  it('keeps sources apart and groups books and channels by stable references', () => {
    const documents = [
      note({ id: 'a', origin: 'manual', title: '随笔' }),
      note({
        id: 'b',
        origin: 'ebook',
        title: '第一章',
        sourceRef: {
          bookRelativePath: '书/C Primer Plus.epub',
          chapterHref: 'ch1.xhtml',
        },
      }),
      note({
        id: 'c',
        origin: 'player',
        title: '经济访谈',
        sourceRef: { videoId: 'abc', channelName: 'Bloomberg Originals' },
      }),
    ];
    expect(
      groupKnowledgeBySource(documents, 'manual', '').flatMap(
        (group) => group.notes,
      ),
    ).toHaveLength(1);
    expect(groupKnowledgeBySource(documents, 'ebook', '')[0].name).toBe(
      'C Primer Plus',
    );
    expect(groupKnowledgeBySource(documents, 'player', '')[0].name).toBe(
      'Bloomberg Originals',
    );
    expect(
      groupKnowledgeBySource(documents, 'player', 'Bloomberg')[0].notes[0]
        .title,
    ).toBe('经济访谈');
  });
});
