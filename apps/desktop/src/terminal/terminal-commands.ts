import type { LinuxCheatItem, TerminalShellType } from './terminal-types';

export const COMMAND_CATEGORY_FILTERS = [
  ['all', '全部'],
  ['fs', '文件权限'],
  ['text', '三剑客'],
  ['proc', '进程'],
  ['net', '网络'],
  ['sys', '系统'],
] as const;

export type CommandLibraryView = 'all' | 'favorites' | 'recent';

export type ShellCatalogEntry = {
  id: TerminalShellType;
  name: string;
  available: boolean;
};

type CommandSource = Pick<LinuxCheatItem, 'cmd' | 'commandByShell'>;

/** Bash and WSL use the Linux command. Other shells need their own text. */
export function commandTextForShell(
  item: CommandSource,
  shell: TerminalShellType,
): string | undefined {
  const specific = item.commandByShell?.[shell];
  if (specific) return specific;
  if (shell === 'bash' || shell === 'wsl') return item.cmd;
  return undefined;
}

export function shellsWithCommand(
  item: CommandSource,
  catalog: readonly ShellCatalogEntry[],
): Array<ShellCatalogEntry & { command: string }> {
  return catalog.flatMap((shell) => {
    const command = commandTextForShell(item, shell.id);
    return command ? [{ ...shell, command }] : [];
  });
}

export function filterCommandLibrary<T extends LinuxCheatItem>(
  items: readonly T[],
  options: {
    query: string;
    category: string;
    view: CommandLibraryView;
    favoriteIds: readonly string[];
    recentIds: readonly string[];
  },
): T[] {
  const query = options.query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => {
    if (options.category !== 'all' && item.category !== options.category) {
      return false;
    }
    if (
      options.view === 'favorites' &&
      !options.favoriteIds.includes(item.id)
    ) {
      return false;
    }
    if (options.view === 'recent' && !options.recentIds.includes(item.id)) {
      return false;
    }
    if (!query) return true;
    const haystack = [
      item.title,
      item.explanation,
      item.practicalScenario,
      item.cmd,
      ...Object.values(item.commandByShell ?? {}),
    ];
    return haystack.some(
      (value) =>
        typeof value === 'string' && value.toLocaleLowerCase().includes(query),
    );
  });
  if (options.view !== 'recent') return filtered;
  return [...filtered].sort(
    (left, right) =>
      options.recentIds.indexOf(left.id) - options.recentIds.indexOf(right.id),
  );
}

export function commandMatchesFocus(
  ids: readonly string[],
  currentId: string | null,
): string | null {
  if (ids.length === 0) return null;
  if (currentId && ids.includes(currentId)) return currentId;
  return ids[0];
}

export function moveFocusedCommand(
  ids: readonly string[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const index = currentId ? ids.indexOf(currentId) : -1;
  if (index < 0) return direction > 0 ? ids[0] : ids[ids.length - 1];
  const next = index + direction;
  if (next < 0) return ids[0];
  if (next >= ids.length) return ids[ids.length - 1];
  return ids[next];
}
