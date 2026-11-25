import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStarterCodeLabCells,
  duplicateCodeLabFile,
  loadCodeLabCollection,
  upsertCodeLabFile,
} from '../src/terminal/terminal-codelab-model';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

const file = {
  id: 'revision-test-file',
  title: 'revision-test.ipynb',
  folder: '测试',
  language: 'python' as const,
  cells: createStarterCodeLabCells('python'),
  tags: ['Python'],
  starred: false,
};

afterEach(() => vi.unstubAllGlobals());

describe('code lab collection save', () => {
  it('rejects a stale revision instead of overwriting another window', () => {
    vi.stubGlobal('localStorage', createStorage());
    upsertCodeLabFile({ ...file, updatedAt: 100 });
    upsertCodeLabFile({ ...file, updatedAt: 200 }, 100);
    expect(() => upsertCodeLabFile({ ...file, updatedAt: 300 }, 100)).toThrow(
      'CODELAB_REVISION_CONFLICT',
    );
  });

  it('reports a failed write instead of claiming a save succeeded', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => upsertCodeLabFile(file)).toThrow('CODELAB_SAVE_FAILED');
  });

  it('duplicates a notebook into a new file id with independent cloned cells', () => {
    vi.stubGlobal('localStorage', createStorage());
    upsertCodeLabFile({ ...file, updatedAt: 100 });
    const copy = duplicateCodeLabFile(file);
    expect(copy.id).not.toBe(file.id);
    expect(copy.title).toBe('revision-test 副本.ipynb');
    expect(copy.cells.length).toBe(file.cells.length);
    expect(copy.cells[0].id).not.toBe(file.cells[0].id);
    const collection = loadCodeLabCollection();
    expect(collection.some((item) => item.id === copy.id)).toBe(true);
  });
});
