import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  learningPathBookProgress,
  loadLearningPaths,
  saveLearningPaths,
} from '../src/ebook-learning-path.ts';

const entries = new Map();
globalThis.localStorage = {
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => { entries.set(key, value); },
};

beforeEach(() => entries.clear());

test('stores separate skill paths for separate libraries', () => {
  const paths = [{
    id: 'skill-1', title: '机器学习', createdAt: 1,
    stages: [{
      id: 'stage-1', title: '基础',
      books: [{
        id: 'book-1', progressKey: 'library:book.epub:12:1', title: '示例书',
        targetWords: 12_000, baselineProgress: 0.2, manualWords: 300,
        dueDate: '2026-11-01',
      }],
    }],
  }];
  assert.equal(saveLearningPaths('C:/library/a', paths), true);
  assert.deepEqual(loadLearningPaths('C:/library/a'), paths);
  assert.deepEqual(loadLearningPaths('C:/library/b'), []);
});

test('rejects malformed saved entries without discarding valid stages', () => {
  entries.set('seamind:ebook-learning-paths:v1:root', JSON.stringify([
    { id: 'bad', title: '', stages: [] },
    { id: 'valid', title: '阅读路径', stages: [
      { id: 'stage', title: '入门', books: [
        { id: 'bad-book', title: '缺少键', targetWords: 10 },
        { id: 'good-book', progressKey: 'book-key', title: '有效书', targetWords: 1000 },
      ] },
    ] },
  ]));
  const loaded = loadLearningPaths('root');
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].stages[0].books.length, 1);
  assert.equal(loaded[0].stages[0].books[0].title, '有效书');
});

test('counts reading only after the plan baseline and honors manual progress', () => {
  const entry = {
    targetWords: 10_000, baselineProgress: 0.4, manualWords: 0,
  };
  const activity = { furthestProgress: 0.55, estimatedTotalWords: 20_000 };
  assert.equal(
    learningPathBookProgress(entry, { progress: 0.5 }, activity).completedWords,
    3_000,
  );
  assert.equal(
    learningPathBookProgress({ ...entry, manualWords: 4_000 }, null, activity).completedWords,
    4_000,
  );
  assert.equal(
    learningPathBookProgress({ ...entry, manualWords: 15_000 }, null, null).completedWords,
    10_000,
  );
});
