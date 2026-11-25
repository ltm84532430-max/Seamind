import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  clearPdfBookData,
  deletePdfBookAnnotation,
  getPdfBookProgress,
  listPdfBookAnnotations,
  savePdfBookAnnotation,
  savePdfBookProgress,
} from '../src/ebook/pdf-book-store.ts';
import { bookmarkKey, preferenceKey } from '../src/literature/paper-reader-keys.ts';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
  key: (index) => Array.from(values.keys())[index] ?? null,
  get length() { return values.size; },
};

beforeEach(() => values.clear());

test('keeps PDF book positions and annotations isolated by library and file hash', () => {
  const root = 'C:/library';
  const path = 'books/guide.pdf';
  const hash = 'a'.repeat(64);
  savePdfBookProgress(root, path, hash, 12, 1.25, 0.37);
  savePdfBookAnnotation(root, path, hash, {
    id: 'note-1',
    paperId: path,
    pageNumber: 12,
    selectedText: 'A selected passage',
    comment: 'Review this',
    color: '#ffd54f',
    rects: [{ x: 1, y: 2, width: 3, height: 4 }],
  });

  assert.equal(getPdfBookProgress(root, path, hash)?.pageNumber, 12);
  assert.equal(getPdfBookProgress(root, path, hash)?.offsetRatio, 0.37);
  savePdfBookProgress(root, path, hash, 12, 1.5);
  assert.equal(getPdfBookProgress(root, path, hash)?.offsetRatio, 0.37);
  assert.equal(listPdfBookAnnotations(root, path, hash)[0]?.comment, 'Review this');
  assert.deepEqual(listPdfBookAnnotations('C:/other', path, hash), []);
  assert.deepEqual(listPdfBookAnnotations(root, path, 'b'.repeat(64)), []);
  assert.equal(getPdfBookProgress(root, path, 'b'.repeat(64)), null);

  deletePdfBookAnnotation(root, path, hash, 'note-1');
  assert.deepEqual(listPdfBookAnnotations(root, path, hash), []);
});

test('removing a PDF book clears its progress, bookmarks and view settings', () => {
  const root = 'C:/library';
  const path = 'books/guide.pdf';
  const hash = 'a'.repeat(64);
  const readerId = `book:${root}:${path}`;
  savePdfBookProgress(root, path, hash, 3, 1);
  values.set(bookmarkKey(readerId, hash), '[]');
  values.set(preferenceKey(readerId, hash), '{}');
  values.set(bookmarkKey(readerId, 'b'.repeat(64)), '[]');

  clearPdfBookData(root, path);

  assert.equal(getPdfBookProgress(root, path, hash), null);
  assert.equal(values.has(bookmarkKey(readerId, hash)), false);
  assert.equal(values.has(bookmarkKey(readerId, 'b'.repeat(64))), false);
  assert.equal(values.has(preferenceKey(readerId, hash)), false);
});
