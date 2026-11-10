import { describe, expect, it } from 'vitest';
import { LINUX_CHEAT_ITEMS } from '../src/terminal/terminal-cheatsheet';
import {
  commandMatchesFocus,
  commandTextForShell,
  filterCommandLibrary,
  moveFocusedCommand,
  shellsWithCommand,
} from '../src/terminal/terminal-commands';

const catalog = [
  { id: 'powershell' as const, name: 'PowerShell', available: true },
  { id: 'wsl' as const, name: 'WSL Linux', available: false },
  { id: 'bash' as const, name: 'Git Bash', available: true },
  { id: 'cmd' as const, name: 'Command Prompt', available: true },
];

describe('command library list', () => {
  it('keeps a Linux-only command visible and names the shells that have it', () => {
    const strace = LINUX_CHEAT_ITEMS.find((item) => item.id === 'sys-strace');
    expect(strace).toBeDefined();
    if (!strace) return;
    expect(commandTextForShell(strace, 'powershell')).toBeUndefined();
    expect(commandTextForShell(strace, 'bash')).toContain('strace');
    expect(shellsWithCommand(strace, catalog).map((shell) => shell.id)).toEqual(
      ['wsl', 'bash'],
    );
    expect(
      filterCommandLibrary(LINUX_CHEAT_ITEMS, {
        query: 'strace',
        category: 'all',
        view: 'all',
        favoriteIds: [],
        recentIds: [],
      }).map((item) => item.id),
    ).toEqual(['sys-strace']);
  });

  it('uses the shell-specific command when one exists', () => {
    const list = LINUX_CHEAT_ITEMS.find((item) => item.id === 'fs-ls');
    expect(list && commandTextForShell(list, 'powershell')).toContain(
      'Get-ChildItem',
    );
    expect(list && commandTextForShell(list, 'bash')).toBe('ls -lah');
  });

  it('filters by category, favorites, and recent order', () => {
    const options = {
      query: '',
      category: 'fs',
      view: 'all' as const,
      favoriteIds: [],
      recentIds: [],
    };
    expect(
      filterCommandLibrary(LINUX_CHEAT_ITEMS, options).every(
        (item) => item.category === 'fs',
      ),
    ).toBe(true);
    expect(
      filterCommandLibrary(LINUX_CHEAT_ITEMS, {
        ...options,
        category: 'all',
        view: 'favorites',
        favoriteIds: ['sys-strace'],
      }).map((item) => item.id),
    ).toEqual(['sys-strace']);
    expect(
      filterCommandLibrary(LINUX_CHEAT_ITEMS, {
        ...options,
        category: 'all',
        view: 'recent',
        recentIds: ['text-awk', 'fs-ls', 'missing'],
      }).map((item) => item.id),
    ).toEqual(['text-awk', 'fs-ls']);
  });

  it('moves and keeps the focused row inside the visible list', () => {
    expect(moveFocusedCommand(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(moveFocusedCommand(['a', 'b', 'c'], 'a', -1)).toBe('a');
    expect(moveFocusedCommand(['a', 'b'], null, 1)).toBe('a');
    expect(moveFocusedCommand([], 'a', 1)).toBeNull();
    expect(commandMatchesFocus(['a', 'b'], 'b')).toBe('b');
    expect(commandMatchesFocus(['a', 'b'], 'gone')).toBe('a');
    expect(commandMatchesFocus([], 'a')).toBeNull();
  });
});
