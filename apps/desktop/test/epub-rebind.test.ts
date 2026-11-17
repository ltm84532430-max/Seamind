import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findLibraryEpubForTask,
  loadEpubAnnotations,
  loadEpubBookmarks,
  rebindRenamedEpubProgress,
  sameEpubProgressFile,
} from '../src/ebook/ebook-storage';

const OLD_KEY = 'library:books/C Primer Plus (2).epub:10502534:1781344045';
const NEW_KEY = 'library:books/C Primer Plus.epub:10502534:1781344045';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

function storageKey(prefix: string, progressKey: string) {
  return `${prefix}${encodeURIComponent(progressKey)}`;
}

describe('renamed epub progress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats the same size and modification time as one file', () => {
    expect(sameEpubProgressFile(OLD_KEY, NEW_KEY)).toBe(true);
    expect(
      sameEpubProgressFile(
        OLD_KEY,
        'library:books/C Primer Plus.epub:10502535:1781344045',
      ),
    ).toBe(false);
    expect(sameEpubProgressFile('test-book-key', NEW_KEY)).toBe(false);
  });

  it('finds the renamed book when only one file still matches', () => {
    const renamed = {
      relativePath: 'books/C Primer Plus.epub',
      fileSize: 10502534,
      updatedAt: 1781344045,
    };
    const other = {
      relativePath: 'books/other.epub',
      fileSize: 10502534,
      updatedAt: 1781344045,
    };
    expect(
      findLibraryEpubForTask([renamed, other], {
        bookId: 'books/c primer plus (2).epub',
        relativePath: 'books/C Primer Plus (2).epub',
        progressKey: OLD_KEY,
      }),
    ).toBeUndefined();
    expect(
      findLibraryEpubForTask([renamed], {
        bookId: 'books/c primer plus (2).epub',
        relativePath: 'books/C Primer Plus (2).epub',
        progressKey: OLD_KEY,
      }),
    ).toBe(renamed);
  });

  it('copies notes from the old filename when the new lists are empty', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const annotations = JSON.stringify([
      {
        id: 'note-1',
        cfi: 'epubcfi(/6/4!/4)',
        sectionIndex: 1,
        text: 'kept',
        note: '',
        color: '#f6c',
        style: 'highlight',
        label: 'note',
        fraction: 0.2,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const bookmarks = JSON.stringify([
      { cfi: 'epubcfi(/6/8!/4)', label: 'mark', fraction: 0.2, createdAt: 1 },
    ]);
    localStorage.setItem(
      storageKey('seamind:epub-annotations:v1:', OLD_KEY),
      annotations,
    );
    localStorage.setItem(
      storageKey('seamind:epub-bookmarks:v1:', OLD_KEY),
      bookmarks,
    );
    localStorage.setItem(
      storageKey('seamind:epub-annotations:v1:', NEW_KEY),
      '[]',
    );
    localStorage.setItem(
      storageKey('seamind:epub-bookmarks:v1:', NEW_KEY),
      '[]',
    );

    expect(loadEpubAnnotations(NEW_KEY)).toEqual([
      {
        id: 'note-1',
        cfi: 'epubcfi(/6/4!/4)',
        sectionIndex: 1,
        text: 'kept',
        note: '',
        color: '#f6c',
        style: 'highlight',
        label: 'note',
        fraction: 0.2,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(loadEpubBookmarks(NEW_KEY)).toEqual([
      { cfi: 'epubcfi(/6/8!/4)', label: 'mark', fraction: 0.2, createdAt: 1 },
    ]);
    expect(
      localStorage.getItem(storageKey('seamind:epub-annotations:v1:', OLD_KEY)),
    ).toBeNull();
  });

  it('keeps notes already stored under the current filename', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const current = JSON.stringify([{ id: 'current', text: 'stay' }]);
    localStorage.setItem(
      storageKey('seamind:epub-annotations:v1:', NEW_KEY),
      current,
    );
    localStorage.setItem(
      storageKey('seamind:epub-annotations:v1:', OLD_KEY),
      JSON.stringify([{ id: 'legacy', text: 'old' }]),
    );

    rebindRenamedEpubProgress(NEW_KEY);

    expect(
      localStorage.getItem(storageKey('seamind:epub-annotations:v1:', NEW_KEY)),
    ).toBe(current);
  });

  it('does not restore notes after the reader has already reconnected them', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    localStorage.setItem(
      storageKey('seamind:epub-annotations:v1:', OLD_KEY),
      JSON.stringify([{ id: 'note-1', text: 'kept' }]),
    );
    rebindRenamedEpubProgress(NEW_KEY);
    localStorage.setItem(
      storageKey('seamind:epub-annotations:v1:', NEW_KEY),
      '[]',
    );
    localStorage.setItem(
      storageKey('seamind:epub-annotations:v1:', OLD_KEY),
      JSON.stringify([{ id: 'note-1', text: 'kept' }]),
    );

    rebindRenamedEpubProgress(NEW_KEY);

    expect(
      localStorage.getItem(storageKey('seamind:epub-annotations:v1:', NEW_KEY)),
    ).toBe('[]');
  });

  it('leaves a different file alone', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const other = 'library:books/C Primer Plus.epub:999:1781344045';
    const legacy = JSON.stringify([{ id: 'note-1', text: 'other-file' }]);
    localStorage.setItem(
      storageKey('seamind:epub-annotations:v1:', OLD_KEY),
      legacy,
    );

    rebindRenamedEpubProgress(other);

    expect(loadEpubAnnotations(other)).toEqual([]);
    expect(
      localStorage.getItem(storageKey('seamind:epub-annotations:v1:', OLD_KEY)),
    ).toBe(legacy);
  });

  it('restores a further reading position from the old filename', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    localStorage.setItem(
      storageKey('seamind:epub-metadata:v1:', NEW_KEY),
      JSON.stringify({ progress: 0, title: 'C Primer Plus' }),
    );
    localStorage.setItem(
      storageKey('seamind:epub-progress:v1:', NEW_KEY),
      'epubcfi(/6/2!/4)',
    );
    localStorage.setItem(
      storageKey('seamind:epub-metadata:v1:', OLD_KEY),
      JSON.stringify({ progress: 0.42, title: 'C Primer Plus' }),
    );
    localStorage.setItem(
      storageKey('seamind:epub-progress:v1:', OLD_KEY),
      'epubcfi(/6/14!/4)',
    );

    rebindRenamedEpubProgress(NEW_KEY);

    expect(
      JSON.parse(
        localStorage.getItem(
          storageKey('seamind:epub-metadata:v1:', NEW_KEY),
        ) ?? '{}',
      ),
    ).toMatchObject({ progress: 0.42 });
    expect(
      localStorage.getItem(storageKey('seamind:epub-progress:v1:', NEW_KEY)),
    ).toBe('epubcfi(/6/14!/4)');
  });

  it('ignores progress keys that are not library file identities', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const key = storageKey('seamind:epub-annotations:v1:', 'test-book-key');
    localStorage.setItem(key, '[{"id":"a"}]');

    rebindRenamedEpubProgress('test-book-key');

    expect(localStorage.getItem(key)).toBe('[{"id":"a"}]');
    expect(
      localStorage.getItem(
        storageKey('seamind:epub-rebind:v1:', 'test-book-key'),
      ),
    ).toBeNull();
  });
});
