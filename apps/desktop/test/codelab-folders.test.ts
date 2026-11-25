import { beforeEach, describe, expect, it } from 'vitest';
import {
  CODELAB_FOLDERS_STORAGE_KEY,
  createCodeLabFolder,
  createCodeLabSavedFile,
  deleteCodeLabFolder,
  groupCodeLabFilesByFolder,
  loadCodeLabCollection,
  loadCodeLabFolders,
  moveCodeLabFileToFolder,
  renameCodeLabFolder,
  UNCATEGORIZED_CODELAB_FOLDER,
} from '../src/terminal/terminal-codelab-model';

const memoryStorage = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStorage.delete(key);
    },
    clear: () => {
      memoryStorage.clear();
    },
  },
});

describe('codelab notebook folders & note creation', () => {
  beforeEach(() => {
    memoryStorage.clear();
  });

  it('creates custom notebook folders and renders empty notebooks in grouped tree', () => {
    const { folders, createdName } = createCodeLabFolder('高频量化研究');
    expect(createdName).toBe('高频量化研究');
    expect(folders).toContain('高频量化研究');
    expect(folders[folders.length - 1]).toBe(UNCATEGORIZED_CODELAB_FOLDER);

    // Duplicate creation is rejected cleanly
    const dup = createCodeLabFolder('高频量化研究');
    expect(dup.createdName).toBeNull();

    const groups = groupCodeLabFilesByFolder(
      loadCodeLabCollection(),
      '',
      'all',
      folders,
    );
    const customGroup = groups.find((g) => g.folder === '高频量化研究');
    expect(customGroup).toBeDefined();
    expect(customGroup?.items).toEqual([]);
  });

  it('creates persisted notes inside a specific notebook folder', () => {
    createCodeLabFolder('统计建模');
    const created = createCodeLabSavedFile('r', '统计建模');
    expect(created.file.folder).toBe('统计建模');
    expect(created.file.language).toBe('r');
    expect(created.file.title.endsWith('.R')).toBe(true);
    expect(created.files.some((f) => f.id === created.file.id)).toBe(true);
  });

  it('renames a notebook and migrates its notes', () => {
    createCodeLabFolder('临时实验');
    const created = createCodeLabSavedFile('python', '临时实验');

    const renamed = renameCodeLabFolder('临时实验', '正式回测');
    expect(renamed.renamedTo).toBe('正式回测');
    expect(renamed.folders).toContain('正式回测');
    expect(renamed.folders).not.toContain('临时实验');
    expect(renamed.files.find((f) => f.id === created.file.id)?.folder).toBe(
      '正式回测',
    );
  });

  it('deletes a custom notebook while preserving its notes under uncategorized', () => {
    createCodeLabFolder('待清理目录');
    const created = createCodeLabSavedFile('sql', '待清理目录');

    const deleted = deleteCodeLabFolder('待清理目录');
    expect(deleted.folders).not.toContain('待清理目录');
    expect(loadCodeLabFolders()).not.toContain('待清理目录');
    expect(deleted.files.find((f) => f.id === created.file.id)?.folder).toBe(
      UNCATEGORIZED_CODELAB_FOLDER,
    );
    expect(memoryStorage.get(CODELAB_FOLDERS_STORAGE_KEY)).toBeTruthy();
  });

  it('moves a note file into another notebook folder and ignores same-folder drops', () => {
    createCodeLabFolder('源目录');
    createCodeLabFolder('目标目录');
    const created = createCodeLabSavedFile('python', '源目录');

    const moved = moveCodeLabFileToFolder(created.file.id, '目标目录');
    expect(moved.movedFile?.folder).toBe('目标目录');
    expect(moved.fromFolder).toBe('源目录');
    expect(
      loadCodeLabCollection().find((f) => f.id === created.file.id)?.folder,
    ).toBe('目标目录');

    const noop = moveCodeLabFileToFolder(created.file.id, '目标目录');
    expect(noop.movedFile).toBeNull();
  });
});
