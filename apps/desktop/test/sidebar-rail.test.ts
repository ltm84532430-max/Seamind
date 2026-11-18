import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { avatarHue, initialOf } from '../src/player/format';
import {
  formatRailIndexCode,
  shouldHandleSidebarShortcut,
} from '../src/components/WorkspaceSidebarRail';

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

  it('formats institutional 1-2 character index codes for textual rail navigation', () => {
    expect(formatRailIndexCode('阿杉电脑')).toBe('阿杉');
    expect(formatRailIndexCode('湖科大教书匠 Gj Teacher')).toBe('湖科');
    expect(formatRailIndexCode('C语言全链路进阶修炼路径')).toBe('C语');
    expect(formatRailIndexCode('综合学习计划')).toBe('综合');
    expect(formatRailIndexCode('Bloomberg-Originals')).toBe('BO');
    expect(formatRailIndexCode('Corey-Schafer')).toBe('CS');
    expect(formatRailIndexCode('MIT OpenCourseWare')).toBe('MO');
    expect(formatRailIndexCode('J.P. Morgan - Eye on the Market')).toBe('JP');
    expect(formatRailIndexCode('UK Ministry of Defence - GOV.UK')).toBe('UM');
    expect(formatRailIndexCode('WorkBuddy')).toBe('WO');
    expect(formatRailIndexCode('  ')).toBe('--');
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
