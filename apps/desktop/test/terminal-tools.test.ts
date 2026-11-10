import { describe, expect, it } from 'vitest';
import {
  isCommandLibraryShortcut,
  parseLastTerminalTool,
  readLastTerminalTool,
  selectTerminalTool,
  terminalEscapeTarget,
  terminalTabShortcutIndex,
  type TerminalToolChrome,
} from '../src/terminal/terminal-tools';

const chrome = (
  overrides: Partial<TerminalToolChrome> = {},
): TerminalToolChrome => ({
  open: false,
  tool: 'linux',
  pinned: false,
  toolsMenu: false,
  shellMenu: false,
  confirmOpen: false,
  renaming: false,
  ...overrides,
});

describe('terminal tool chrome', () => {
  it('keeps only a known last tool', () => {
    expect(parseLastTerminalTool('knowledge')).toBe('knowledge');
    expect(parseLastTerminalTool('env')).toBe('linux');
    expect(parseLastTerminalTool('matrix')).toBe('linux');
    expect(parseLastTerminalTool(null)).toBe('linux');
  });

  it('falls back when storage throws', () => {
    const storage = {
      getItem() {
        throw new Error('denied');
      },
    };
    expect(readLastTerminalTool(storage)).toBe('linux');
    expect(readLastTerminalTool(null)).toBe('linux');
  });

  it('opens a tool and closes it when chosen again', () => {
    expect(
      selectTerminalTool({ open: false, tool: 'linux' }, 'knowledge'),
    ).toEqual({
      open: true,
      tool: 'knowledge',
    });
    expect(
      selectTerminalTool({ open: true, tool: 'linux' }, 'knowledge'),
    ).toEqual({
      open: true,
      tool: 'knowledge',
    });
    expect(
      selectTerminalTool({ open: true, tool: 'knowledge' }, 'knowledge'),
    ).toEqual({
      open: false,
      tool: 'knowledge',
    });
  });

  it('maps Alt+1 through Alt+9 and Ctrl+Shift+L', () => {
    const plain = {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
    expect(terminalTabShortcutIndex({ ...plain, altKey: true, key: '1' })).toBe(
      0,
    );
    expect(terminalTabShortcutIndex({ ...plain, altKey: true, key: '9' })).toBe(
      8,
    );
    expect(
      terminalTabShortcutIndex({
        ...plain,
        altKey: true,
        ctrlKey: true,
        key: '1',
      }),
    ).toBeNull();
    expect(terminalTabShortcutIndex({ ...plain, key: '1' })).toBeNull();
    expect(
      isCommandLibraryShortcut({
        ...plain,
        ctrlKey: true,
        shiftKey: true,
        key: 'L',
      }),
    ).toBe(true);
    expect(
      isCommandLibraryShortcut({
        ...plain,
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
        key: 'l',
      }),
    ).toBe(false);
  });

  it('closes one layer per Escape and leaves a pinned panel to the terminal', () => {
    expect(
      terminalEscapeTarget(chrome({ confirmOpen: true, shellMenu: true })),
    ).toBe('confirm');
    expect(
      terminalEscapeTarget(chrome({ shellMenu: true, toolsMenu: true })),
    ).toBe('shell-menu');
    expect(
      terminalEscapeTarget(chrome({ toolsMenu: true, renaming: true })),
    ).toBe('tools-menu');
    expect(terminalEscapeTarget(chrome({ renaming: true, open: true }))).toBe(
      'rename',
    );
    expect(terminalEscapeTarget(chrome({ open: true }))).toBe('panel');
    expect(terminalEscapeTarget(chrome({ open: true, pinned: true }))).toBe(
      'terminal',
    );
    expect(terminalEscapeTarget(chrome())).toBe('terminal');
  });
});
