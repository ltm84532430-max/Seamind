import { describe, expect, it } from 'vitest';
import { renderLinkPath } from '../src/view';

describe('renderLinkPath', () => {
  it('renders standard orthogonal link', () => {
    const path = renderLinkPath(
      { source: [0, 0], target: [100, 50] },
      'orthogonal',
    );
    expect(path).toBe('M0,0H50V50H100');
  });

  it('renders rounded orthogonal link to the right', () => {
    const path = renderLinkPath(
      { source: [0, 0], target: [100, 50] },
      'rounded-orthogonal',
      8,
    );
    expect(path).toBe('M0,0H42Q50,0 50,8V42Q50,50 58,50H100');
  });

  it('renders rounded orthogonal link to the left', () => {
    const path = renderLinkPath(
      { source: [100, 0], target: [0, 50] },
      'rounded-orthogonal',
      8,
    );
    expect(path).toBe('M100,0H58Q50,0 50,8V42Q50,50 42,50H0');
  });

  it('falls back to straight line when dy is small', () => {
    const path = renderLinkPath(
      { source: [0, 0], target: [100, 1] },
      'rounded-orthogonal',
      8,
    );
    expect(path).toBe('M0,0H50V1H100');
  });
});
