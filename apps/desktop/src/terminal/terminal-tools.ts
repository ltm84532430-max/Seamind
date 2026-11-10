export type TerminalToolId = 'linux' | 'knowledge';

export const TERMINAL_TOOLS: readonly {
  id: TerminalToolId;
  label: string;
}[] = [
  { id: 'linux', label: '命令库' },
  { id: 'knowledge', label: '知识修正' },
];

export const COMMAND_LIBRARY_SHORTCUT_LABEL = 'Ctrl+Shift+L';

export type TerminalKeyEvent = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export const LAST_TERMINAL_TOOL_KEY = 'seamind:terminal-last-tool:v1';

export type TerminalToolChrome = {
  open: boolean;
  tool: TerminalToolId;
  pinned: boolean;
  toolsMenu: boolean;
  shellMenu: boolean;
  confirmOpen: boolean;
  renaming: boolean;
};

export type TerminalEscapeTarget =
  | 'confirm'
  | 'shell-menu'
  | 'tools-menu'
  | 'rename'
  | 'panel'
  | 'terminal';

export function parseLastTerminalTool(value: string | null): TerminalToolId {
  if (value === 'linux' || value === 'knowledge') return value;
  return 'linux';
}

/** Alt+1 through Alt+9. Other modifiers stay with the terminal. */
export function terminalTabShortcutIndex(
  event: TerminalKeyEvent,
): number | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (!/^[1-9]$/.test(event.key)) return null;
  return Number(event.key) - 1;
}

export function isCommandLibraryShortcut(event: TerminalKeyEvent): boolean {
  return (
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === 'l'
  );
}

export function readLastTerminalTool(
  storage: Pick<Storage, 'getItem'> | null,
): TerminalToolId {
  try {
    return parseLastTerminalTool(
      storage?.getItem(LAST_TERMINAL_TOOL_KEY) ?? null,
    );
  } catch {
    return 'linux';
  }
}

/** Open a tool, or close the panel when that tool is already showing. */
export function selectTerminalTool(
  chrome: Pick<TerminalToolChrome, 'open' | 'tool'>,
  next: TerminalToolId,
): { open: boolean; tool: TerminalToolId } {
  if (chrome.open && chrome.tool === next) {
    return { open: false, tool: next };
  }
  return { open: true, tool: next };
}

/**
 * One Escape closes one layer. A pinned panel stays open so the key
 * reaches the terminal. Renaming wins over the panel because the field
 * is the focused edit.
 */
export function terminalEscapeTarget(
  chrome: TerminalToolChrome,
): TerminalEscapeTarget {
  if (chrome.confirmOpen) return 'confirm';
  if (chrome.shellMenu) return 'shell-menu';
  if (chrome.toolsMenu) return 'tools-menu';
  if (chrome.renaming) return 'rename';
  if (chrome.open && !chrome.pinned) return 'panel';
  return 'terminal';
}
