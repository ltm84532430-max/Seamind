import { describe, expect, it } from 'vitest';
import { groupKnowledgeNotes, UNFILED_FOLDER } from '../src/knowledge-notes';

const note = (
  overrides: Partial<Parameters<typeof groupKnowledgeNotes>[0][number]>,
) => ({
  kind: 'doc',
  relativePath: 'note.md',
  title: '笔记',
  category: '数学',
  updatedAt: 1,
  ...overrides,
});

describe('groupKnowledgeNotes', () => {
  it('lists Markdown notes only and leaves mind maps out', () => {
    const groups = groupKnowledgeNotes(
      [
        note({ relativePath: 'a.md', title: '文档' }),
        note({ relativePath: 'b.md', title: '导图', kind: 'mindmap' }),
      ],
      '',
    );

    expect(
      groups.flatMap((group) => group.notes.map((item) => item.title)),
    ).toEqual(['文档']);
  });

  it('groups notes by folder, sorting folders by name and notes newest first', () => {
    const groups = groupKnowledgeNotes(
      [
        note({
          relativePath: 'old.md',
          title: '旧',
          category: '物理',
          updatedAt: 1,
        }),
        note({
          relativePath: 'new.md',
          title: '新',
          category: '物理',
          updatedAt: 9,
        }),
        note({
          relativePath: 'math.md',
          title: '公式',
          category: '数学',
          updatedAt: 5,
        }),
      ],
      '',
    );

    expect(groups.map((group) => group.name)).toEqual(['数学', '物理']);
    expect(groups[1].notes.map((item) => item.title)).toEqual(['新', '旧']);
  });

  it('files notes without a category under the unfiled folder', () => {
    const groups = groupKnowledgeNotes([note({ category: '' })], '');

    expect(groups[0].name).toBe(UNFILED_FOLDER);
  });

  it('matches the query against title, path and folder, ignoring case', () => {
    const documents = [
      note({
        relativePath: 'linux/kernel.md',
        title: 'Kernel Notes',
        category: '系统',
      }),
      note({
        relativePath: 'misc/formula.md',
        title: '公式',
        category: '数学',
      }),
    ];

    expect(
      groupKnowledgeNotes(documents, 'kernel').flatMap((group) => group.notes),
    ).toHaveLength(1);
    expect(
      groupKnowledgeNotes(documents, 'misc/').flatMap((group) => group.notes)[0]
        .title,
    ).toBe('公式');
    expect(groupKnowledgeNotes(documents, '数学')[0].name).toBe('数学');
    expect(groupKnowledgeNotes(documents, '不存在')).toEqual([]);
  });

  it('includes empty categories when query is blank and matches #tag queries', () => {
    const documents = [
      note({
        relativePath: 'math/calc.md',
        title: '微积分',
        category: '数学',
        tags: ['极限', '导数'],
      }),
    ];

    const withEmpty = groupKnowledgeNotes(documents, '', ['物理', '数学']);
    expect(withEmpty.map((group) => group.name)).toEqual(['数学', '物理']);
    expect(withEmpty[1].notes).toEqual([]);

    const byTag = groupKnowledgeNotes(documents, '#极限', ['物理', '数学']);
    expect(byTag).toHaveLength(1);
    expect(byTag[0].notes[0].title).toBe('微积分');
  });
});
