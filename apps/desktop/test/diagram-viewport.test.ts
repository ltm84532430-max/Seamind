import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitViewport,
  inlineSvgVariables,
  panBy,
  zoomAt,
} from '../src/workbench/diagram-viewport';

describe('fitViewport', () => {
  it('centres a diagram that is smaller than the frame at no more than the fit limit', () => {
    const view = fitViewport(
      { width: 100, height: 50 },
      { width: 1000, height: 800 },
    );
    expect(view.scale).toBe(1.6);
    expect(view.x).toBeCloseTo((1000 - 100 * 1.6) / 2);
    expect(view.y).toBeCloseTo((800 - 50 * 1.6) / 2);
  });

  it('shrinks a large diagram to the frame less the padding', () => {
    const view = fitViewport(
      { width: 2000, height: 500 },
      { width: 1000, height: 800 },
    );
    expect(view.scale).toBeCloseTo((1000 - 48) / 2000);
    expect(view.x).toBeCloseTo(24);
    expect(view.y).toBeCloseTo((800 - 500 * view.scale) / 2);
  });

  it('falls back to the identity before anything has a size', () => {
    expect(
      fitViewport({ width: 0, height: 0 }, { width: 10, height: 10 }),
    ).toEqual({ x: 0, y: 0, scale: 1 });
    expect(
      fitViewport({ width: 10, height: 10 }, { width: 0, height: 0 }),
    ).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe('zoomAt', () => {
  it('keeps the point under the pointer where it is', () => {
    const before = { x: 30, y: -20, scale: 1.5 };
    const anchor = { x: 400, y: 250 };
    const content = {
      x: (anchor.x - before.x) / before.scale,
      y: (anchor.y - before.y) / before.scale,
    };
    const after = zoomAt(before, 1.8, anchor);
    expect(after.scale).toBeCloseTo(2.7);
    expect(content.x * after.scale + after.x).toBeCloseTo(anchor.x);
    expect(content.y * after.scale + after.y).toBeCloseTo(anchor.y);
  });

  it('stops at the scale limits without drifting', () => {
    const top = zoomAt({ x: 0, y: 0, scale: MAX_SCALE }, 2, { x: 50, y: 50 });
    expect(top).toEqual({ x: 0, y: 0, scale: MAX_SCALE });
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 1e-9, { x: 0, y: 0 }).scale).toBe(
      MIN_SCALE,
    );
  });
});

describe('clampScale and panBy', () => {
  it('clamps to the range and survives a bad number', () => {
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it('moves the diagram by the drag distance', () => {
    expect(panBy({ x: 1, y: 2, scale: 3 }, 10, -5)).toEqual({
      x: 11,
      y: -3,
      scale: 3,
    });
  });
});

describe('inlineSvgVariables', () => {
  const variables = { '--pele-bg': '#fff', '--pele-fg': ' #25323a ' };

  it('puts the variables in front of the root style', () => {
    const svg =
      '<svg xmlns="x" viewBox="0 0 1 1" style="max-width:100%"><g/></svg>';
    expect(inlineSvgVariables(svg, variables)).toBe(
      '<svg xmlns="x" viewBox="0 0 1 1" style="--pele-bg:#fff;--pele-fg:#25323a;max-width:100%"><g/></svg>',
    );
  });

  it('adds a style attribute when the root has none', () => {
    expect(inlineSvgVariables('<svg xmlns="x"><g/></svg>', variables)).toBe(
      '<svg xmlns="x" style="--pele-bg:#fff;--pele-fg:#25323a"><g/></svg>',
    );
  });

  it('is not fooled by a > inside an attribute value', () => {
    const svg = '<svg aria-label="a > b"><g/></svg>';
    expect(inlineSvgVariables(svg, { '--pele-bg': '#000' })).toBe(
      '<svg aria-label="a > b" style="--pele-bg:#000"><g/></svg>',
    );
  });

  it('leaves unsafe or empty values and non-svg text alone', () => {
    const svg = '<svg><g/></svg>';
    expect(inlineSvgVariables(svg, { '--x': '', 'not-a-variable': '1' })).toBe(
      svg,
    );
    expect(inlineSvgVariables(svg, { '--pele-bg': 'red;" onload="x' })).toBe(
      '<svg style="--pele-bg:red onload=x"><g/></svg>',
    );
    expect(inlineSvgVariables('<p>text</p>', variables)).toBe('<p>text</p>');
  });
});
