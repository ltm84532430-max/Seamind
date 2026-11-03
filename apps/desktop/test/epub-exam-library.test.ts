import { beforeEach, describe, expect, it } from 'vitest';
import { findStoredCoverByBookKey } from '../src/ebook-storage';

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe('findStoredCoverByBookKey', () => {
  const mockStorage = new MockStorage();

  beforeEach(() => {
    mockStorage.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
  });

  it('returns null when bookKey is empty or missing', () => {
    expect(findStoredCoverByBookKey('')).toBeNull();
    expect(findStoredCoverByBookKey('non_existent.epub')).toBeNull();
  });

  it('finds cached coverDataUrl when matching epub metadata exists in storage', () => {
    const bookKey = 'c-primer-plus.epub';
    const progressKey = `library:${bookKey}:1048576:1700000000000`;
    const storageKey = `seamind:epub-metadata:v1:${encodeURIComponent(progressKey)}`;
    const coverDataUrl = 'data:image/jpeg;base64,samplebase64data';

    mockStorage.setItem(
      storageKey,
      JSON.stringify({
        title: 'C Primer Plus',
        author: 'Stephen Prata',
        coverDataUrl,
      }),
    );

    expect(findStoredCoverByBookKey(bookKey)).toBe(coverDataUrl);
  });

  it('ignores metadata without coverDataUrl or with invalid prefix', () => {
    const bookKey = 'no-cover.epub';
    const progressKey = `library:${bookKey}:2048:1700000000000`;
    const storageKey = `seamind:epub-metadata:v1:${encodeURIComponent(progressKey)}`;

    mockStorage.setItem(
      storageKey,
      JSON.stringify({
        title: 'Book without cover',
        coverDataUrl: 'https://example.com/not-data-image.png',
      }),
    );

    expect(findStoredCoverByBookKey(bookKey)).toBeNull();
  });
});
