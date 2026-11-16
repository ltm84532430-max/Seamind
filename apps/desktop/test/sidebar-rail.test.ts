import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { avatarHue, initialOf } from '../src/player/format';
import { shouldHandleSidebarShortcut } from '../src/components/WorkspaceSidebarRail';

describe('workspace sidebar rail helpers', () => {
  it('handles Ctrl+B and Cmd+B while ignoring editable fields and modified chords', () => {
    expect(
      shouldHandleSidebarShortcut({
        key: 'b',
        ctrlKey: true,
        metaKey: false,
        target: { tagName: 'DIV' },
      }),
    ).toBe(true);

    expect(
      shouldHandleSidebarShortcut({
        key: 'B',
        ctrlKey: false,
        metaKey: true,
        target: null,
      }),
    ).toBe(true);

    expect(
      shouldHandleSidebarShortcut({
        key: 'b',
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        target: { tagName: 'DIV' },
      }),
    ).toBe(false);

    expect(
      shouldHandleSidebarShortcut({
        key: 'b',
        ctrlKey: true,
        metaKey: false,
        target: { tagName: 'INPUT' },
      }),
    ).toBe(false);

    expect(
      shouldHandleSidebarShortcut({
        key: 'b',
        ctrlKey: true,
        metaKey: false,
        target: { tagName: 'DIV', isContentEditable: true },
      }),
    ).toBe(false);
  });

  it('produces deterministic thumbnail initials and hues aligned with Player Avatar', () => {
    expect(initialOf('思科认证CCIE必过')).toBe('思');
    expect(initialOf('network-thinking')).toBe('N');
    expect(initialOf('  ')).toBe('?');
    expect(avatarHue('黑客')).toBe(avatarHue('黑客'));
    expect(avatarHue('黑客')).toBeGreaterThanOrEqual(0);
    expect(avatarHue('黑客')).toBeLessThan(360);
  });

  it('keeps workspace-sidebar-rail.css brace-balanced with flat selectors', () => {
    const css = readFileSync(
      new URL('../src/components/workspace-sidebar-rail.css', import.meta.url),
      'utf8',
    );
    const opens = (css.match(/\{/g) ?? []).length;
    const closes = (css.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThan(5);
  });
});
