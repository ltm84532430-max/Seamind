import { describe, expect, it } from 'vitest';
import {
  buildShelfGridCssVars,
  clampShelfColumns,
  computeShelfGridMetrics,
  MAX_SHELF_COLUMNS,
  MIN_SHELF_COLUMNS,
} from '../src/ebook/ebook-shelf-density';

describe('ebook-shelf-density parametric pixel algorithm', () => {
  it('clamps column counts strictly within 6..11', () => {
    expect(clampShelfColumns(3)).toBe(6);
    expect(clampShelfColumns(6)).toBe(6);
    expect(clampShelfColumns(8.4)).toBe(8);
    expect(clampShelfColumns(11)).toBe(11);
    expect(clampShelfColumns(18)).toBe(11);
    expect(clampShelfColumns(Number.NaN)).toBe(6);
  });

  it('produces monotonically tightening pixel metrics across every step from 6 to 11', () => {
    const all = Array.from(
      { length: MAX_SHELF_COLUMNS - MIN_SHELF_COLUMNS + 1 },
      (_, idx) => computeShelfGridMetrics(MIN_SHELF_COLUMNS + idx),
    );

    for (let i = 1; i < all.length; i += 1) {
      const prev = all[i - 1];
      const curr = all[i];
      expect(curr.columns).toBe(prev.columns + 1);
      expect(curr.gapX).toBeLessThanOrEqual(prev.gapX);
      expect(curr.gapY).toBeLessThanOrEqual(prev.gapY);
      expect(curr.footerHeight).toBeLessThanOrEqual(prev.footerHeight);
      expect(curr.examWidth).toBeLessThanOrEqual(prev.examWidth);
      expect(curr.menuWidth).toBeLessThanOrEqual(prev.menuWidth);
      expect(curr.titleMinHeight).toBe(curr.titleLineHeight * 2);
      expect(Number.isInteger(curr.gapX)).toBe(true);
      expect(Number.isInteger(curr.gapY)).toBe(true);
      expect(Number.isInteger(curr.footerHeight)).toBe(true);
    }
  });

  it('emits exact CSS variables for dynamic grid rendering', () => {
    const vars9 = buildShelfGridCssVars(9) as Record<string, string>;
    expect(vars9['--shelf-cols']).toBe('9');
    expect(vars9['--shelf-gap-x']).toBe('14px');
    expect(vars9['--shelf-footer-h']).toBe('24px');

    const vars11 = buildShelfGridCssVars(11) as Record<string, string>;
    expect(vars11['--shelf-cols']).toBe('11');
    expect(vars11['--shelf-gap-x']).toBe('10px');
    expect(vars11['--shelf-exam-w']).toBe('38px');
    expect(vars11['--shelf-menu-w']).toBe('20px');
  });
});
