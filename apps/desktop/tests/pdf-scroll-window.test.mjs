import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPdfPageOffsets,
  pdfPageAtOffset,
  pdfWindowAroundPage,
  pdfWindowAtScroll,
  pdfWindowSpacers,
} from '../src/literature/pdf-scroll-window.ts';

test('keeps a bounded window and full scroll height for a long PDF', () => {
  const offsets = buildPdfPageOffsets(1000, 1, 800, {});
  const window = pdfWindowAtScroll(offsets, offsets[499], 900);
  assert.ok(window.start <= 500 && window.end >= 500);
  assert.ok(window.end - window.start < 12);
  const spacers = pdfWindowSpacers(offsets, window);
  const rendered = (window.end - window.start + 1) * 800 +
    (window.end - window.start) * 16;
  assert.equal(spacers.top + rendered + spacers.bottom, offsets[1000] - 16);
  assert.equal(pdfPageAtOffset(offsets, offsets[999]), 1000);
});

test('accounts for measured pages and clamps page jumps', () => {
  const offsets = buildPdfPageOffsets(4, 1.5, 800, { 2: 400 });
  assert.equal(offsets[2], 1200 + 16 + 600 + 16);
  assert.deepEqual(pdfWindowAroundPage(90, 4), { start: 1, end: 4 });
  assert.deepEqual(pdfWindowAroundPage(1, 4), { start: 1, end: 4 });
  assert.equal(pdfPageAtOffset(offsets, -100), 1);
  assert.equal(pdfPageAtOffset(offsets, Number.POSITIVE_INFINITY), 4);
});
