import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bookMindmapPath,
  bookMindmapTitle,
  resolveBookMindmapTarget,
} from '../src/book-mindmap-target.ts';

const book = {
  relativePath: 'books/Linux.epub',
  title: 'Linux Command Line, Cover All Essential Linux Commands, A Reference Guide (3rd Edition)_ Linux Book and Linux Kernel',
};

test('book mindmap path matches the backend filename for long and punctuated titles', () => {
  assert.equal(bookMindmapPath(book.title), `books/${book.title}.md`);
  assert.equal(bookMindmapPath('A: B / C'), 'books/A B C.md');
  assert.equal(bookMindmapTitle('CON'), '电子书-CON');
  assert.equal(Array.from(bookMindmapTitle('x'.repeat(130))).length, 120);
});

test('recovers a book map when the stored path comes from the old truncated naming rule', () => {
  const existing = { relativePath: bookMindmapPath(book.title), title: book.title };
  const snapshot = {
    rootPath: 'C:/books', documents: [existing], books: [book],
  };
  const target = resolveBookMindmapTarget(
    snapshot, book, () => `books/${book.title.slice(0, 100)}.md`,
  );
  assert.equal(target.document, existing);
  assert.equal(target.relativePath, existing.relativePath);
});

test('keeps a valid saved book map association', () => {
  const existing = { relativePath: 'books/custom-name.md', title: book.title };
  const snapshot = { rootPath: 'C:/books', documents: [existing], books: [book] };
  const target = resolveBookMindmapTarget(snapshot, book, () => existing.relativePath);
  assert.equal(target.document, existing);
});

test('gives books with the same title distinct titles and backend-compatible paths', () => {
  const other = { ...book, relativePath: 'books/Linux-copy.epub' };
  const snapshot = { rootPath: 'C:/books', documents: [], books: [book, other] };
  const saved = (path) => path === other.relativePath ? bookMindmapPath(book.title) : null;
  const target = resolveBookMindmapTarget(snapshot, book, saved);
  assert.notEqual(target.relativePath, bookMindmapPath(book.title));
  assert.equal(target.relativePath, bookMindmapPath(target.title));
  assert.ok(Array.from(target.title).length <= 120);
});
