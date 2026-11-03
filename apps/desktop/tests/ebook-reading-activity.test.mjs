import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  clearReadingActivityForDate,
  clearAllReadingActivity,
  loadEpubReadingActivity,
} from '../src/ebook-storage.ts';

const entries = new Map();
globalThis.localStorage = {
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => {
    entries.set(key, value);
  },
  removeItem: (key) => {
    entries.delete(key);
  },
  key: (index) => Array.from(entries.keys())[index] ?? null,
  get length() {
    return entries.size;
  },
};

beforeEach(() => entries.clear());

test('clears reading activity word count for a specific date', () => {
  const pk = 'test-book-key';
  const storageKey = `seamind:epub-reading-activity:v1:${encodeURIComponent(pk)}`;
  entries.set(
    storageKey,
    JSON.stringify({
      furthestProgress: 0.5,
      estimatedTotalWords: 50000,
      dailyWords: {
        '2026-10-20': 10994,
        '2026-10-21': 216757,
      },
      pendingProgress: {
        '2026-10-20': 0.1,
      },
      wordCountUnavailable: false,
    }),
  );

  const cleared = clearReadingActivityForDate('2026-10-20', [pk]);
  assert.equal(cleared, 1);

  const activity = loadEpubReadingActivity(pk);
  assert.equal(activity.dailyWords['2026-10-20'], undefined);
  assert.equal(activity.dailyWords['2026-10-21'], 216757);
  assert.equal(activity.pendingProgress['2026-10-20'], undefined);
});

test('clears all reading activity daily words across all books', () => {
  const pk1 = 'book-1';
  const pk2 = 'book-2';
  entries.set(
    `seamind:epub-reading-activity:v1:${encodeURIComponent(pk1)}`,
    JSON.stringify({
      furthestProgress: 0.3,
      dailyWords: { '2026-10-20': 5000 },
      pendingProgress: {},
    }),
  );
  entries.set(
    `seamind:epub-reading-activity:v1:${encodeURIComponent(pk2)}`,
    JSON.stringify({
      furthestProgress: 0.8,
      dailyWords: { '2026-10-21': 12000 },
      pendingProgress: {},
    }),
  );

  const cleared = clearAllReadingActivity();
  assert.equal(cleared, 2);

  const a1 = loadEpubReadingActivity(pk1);
  const a2 = loadEpubReadingActivity(pk2);
  assert.deepEqual(a1.dailyWords, {});
  assert.deepEqual(a2.dailyWords, {});
});

