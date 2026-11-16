import { describe, expect, it } from 'vitest';
import {
  computeViSelectionSpan,
  createViState,
  extractTerminalHints,
  generateHintLabels,
  moveViCursor,
  normalizeDisplayPath,
  type ViMotionContext,
} from '../src/terminal/terminal-alacritty';
import {
  DEFAULT_TERMINAL_PREFERENCES,
  normalizeTerminalPreferences,
} from '../src/terminal/terminal-preferences';
import {
  buildStandaloneTerminalUrl,
  normalizePaneTabAssignments,
  visiblePaneCountForMode,
} from '../src/terminal/terminal-window';

describe('terminal alacritty integration models', () => {
  it('strips Windows verbatim UNC prefixes for clean statusbar and prompt paths', () => {
    expect(
      normalizeDisplayPath('\\\\?\\C:\\Users\\l8453\\Desktop\\books'),
    ).toBe('C:\\Users\\l8453\\Desktop\\books');
    expect(normalizeDisplayPath('\\\\?\\UNC\\nas\\share\\docs')).toBe(
      '\\\\nas\\share\\docs',
    );
    expect(normalizeDisplayPath('/home/user/repo')).toBe('/home/user/repo');
  });

  it('extracts URL and file path hints across wrapped terminal lines with clean labels', () => {
    const hints = extractTerminalHints([
      {
        viewportRow: 0,
        text: 'Open https://github.com/alacritty/',
        isWrapped: false,
      },
      {
        viewportRow: 1,
        text: 'alacritty, or inspect src/terminal/TerminalWorkspace.tsx:42.',
        isWrapped: true,
      },
      {
        viewportRow: 2,
        text: 'See C:\\Users\\l8453\\markmap\\README.md:10',
        isWrapped: false,
      },
    ]);

    expect(hints.map((h) => [h.kind, h.value])).toEqual([
      ['url', 'https://github.com/alacritty/alacritty'],
      ['path', 'src/terminal/TerminalWorkspace.tsx:42'],
      ['path', 'C:\\Users\\l8453\\markmap\\README.md:10'],
    ]);
    // Wrapped URL must map back onto both row 0 and row 1 segments
    expect(hints[0].segments).toHaveLength(2);
    expect(hints[0].segments[0].viewportRow).toBe(0);
    expect(hints[0].segments[1].viewportRow).toBe(1);
    expect(hints.map((h) => h.label)).toEqual(['a', 's', 'd']);
    expect(generateHintLabels(30).slice(0, 3)).toEqual(['aa', 'as', 'ad']);
  });

  it('navigates Vi Mode cursor and computes char/line xterm selections', () => {
    const lines = [
      '  hello alacritty_terminal',
      'line two src/main.tsx:12',
      'last line',
    ];
    const ctx: ViMotionContext = {
      totalLines: lines.length,
      cols: 40,
      viewportRows: 10,
      viewportY: 0,
      semanticEscapeChars: DEFAULT_TERMINAL_PREFERENCES.semanticEscapeChars,
      getLineText: (absLine) => lines[absLine] ?? '',
    };

    let state = createViState(0, 0);
    state = moveViCursor(state, 'line-first-nonblank', ctx);
    expect(state.col).toBe(2); // 'hello...'

    state = moveViCursor(state, 'word-next', ctx);
    expect(state.col).toBe(8); // 'alacritty_terminal'

    state = moveViCursor(state, 'toggle-char', ctx);
    state = moveViCursor(state, 'down', ctx);
    state = moveViCursor(state, 'line-start', ctx);
    const charSel = computeViSelectionSpan(state, 40);
    expect(charSel).toEqual({ column: 8, row: 0, length: 33 });

    let lineState = createViState(1, 3);
    lineState = moveViCursor(lineState, 'toggle-line', ctx);
    lineState = moveViCursor(lineState, 'down', ctx);
    expect(computeViSelectionSpan(lineState, 40)).toEqual({
      column: 0,
      row: 1,
      length: 80,
    });
  });

  it('normalizes terminal preferences and multi-pane window orchestration', () => {
    const prefs = normalizeTerminalPreferences({
      fontSize: 99,
      cursorStyle: 'bar',
      saveOnSelect: true,
      scrollback: 500,
    });
    expect(prefs.fontSize).toBe(22);
    expect(prefs.cursorStyle).toBe('bar');
    expect(prefs.saveOnSelect).toBe(true);
    expect(prefs.scrollback).toBe(1000);

    expect(visiblePaneCountForMode('single')).toBe(1);
    expect(visiblePaneCountForMode('vertical')).toBe(2);
    expect(visiblePaneCountForMode('tri')).toBe(3);
    expect(visiblePaneCountForMode('quad')).toBe(4);

    expect(
      normalizePaneTabAssignments(['t2', 'missing'], ['t1', 't2', 't3'], 3),
    ).toEqual(['t2', 't1', 't3']);

    const url = buildStandaloneTerminalUrl({
      cwd: 'C:\\repo',
      shell: 'powershell',
      cli: 'claude',
      theme: 'navy',
    });
    expect(url).toContain('window=terminal');
    expect(url).toContain('cli=claude');
    expect(url).toContain('theme=navy');
  });
});
