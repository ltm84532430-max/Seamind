import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
import { listen } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../app/app-storage';
import { attachStandardXtermAddons } from './terminal-addons';
import { terminalApi } from './terminal-api';
import {
  computeViSelectionSpan,
  createViState,
  extractTerminalHints,
  moveViCursor,
  normalizeDisplayPath,
  type TerminalHintMatch,
  type ViModeState,
  type ViMotion,
  type VisibleBufferRow,
} from './terminal-alacritty';
import {
  loadTerminalPreferences,
  onTerminalPreferencesChanged,
  saveTerminalPreferences,
} from './terminal-preferences';
import type { TerminalPreferences, TerminalTab } from './terminal-types';

interface TerminalOutputEvent {
  sessionId: string;
  data: number[];
}

interface TerminalExitEvent {
  sessionId: string;
}

interface TerminalCwdEvent {
  sessionId: string;
  cwd: string;
}

interface TerminalBellEvent {
  sessionId: string;
}

export interface TerminalSessionViewHandle {
  sendCommand: (command: string, execute?: boolean) => void;
  clear: () => void;
  focus: () => void;
  openSearch: () => void;
  toggleViMode: () => void;
  triggerHints: () => void;
  getCwd: () => string;
}

interface TerminalSessionViewProps {
  tab: TerminalTab;
  theme: Theme;
  active: boolean;
  isFocused?: boolean;
  style?: CSSProperties;
  onFocusPane?: () => void;
  onStatusChange?: (status: TerminalTab['status'], message?: string) => void;
  onCwdChange?: (cwd: string) => void;
  onBell?: () => void;
}

function resolveTerminalTheme(theme: Theme) {
  if (theme === 'navy') {
    return {
      background: '#070f1e',
      foreground: '#dce8f5',
      cursor: '#38bdf8',
      cursorAccent: '#070f1e',
      selectionBackground: '#173b64',
      black: '#070f1e',
      red: '#f87171',
      green: '#34d399',
      yellow: '#fbbf24',
      blue: '#38bdf8',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#e2eefb',
      brightBlack: '#47688d',
      brightRed: '#fca5a5',
      brightGreen: '#6ee7b7',
      brightYellow: '#fde68a',
      brightBlue: '#60a5fa',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#ffffff',
    };
  }
  if (theme === 'purple') {
    return {
      background: '#0d0818',
      foreground: '#eee4fa',
      cursor: '#c084fc',
      cursorAccent: '#0d0818',
      selectionBackground: '#391c5c',
      black: '#0d0818',
      red: '#f472b6',
      green: '#4ade80',
      yellow: '#facc15',
      blue: '#818cf8',
      magenta: '#c084fc',
      cyan: '#38bdf8',
      white: '#f5eeff',
      brightBlack: '#684a86',
      brightRed: '#fbcfe8',
      brightGreen: '#86efac',
      brightYellow: '#fef08a',
      brightBlue: '#a5b4fc',
      brightMagenta: '#e879f9',
      brightCyan: '#7dd3fc',
      brightWhite: '#ffffff',
    };
  }
  if (theme === 'dark') {
    return {
      background: '#141a1f',
      foreground: '#d7e0e4',
      cursor: '#e06d55',
      cursorAccent: '#141a1f',
      selectionBackground: '#34434b',
      black: '#141a1f',
      red: '#db7868',
      green: '#9ab6a2',
      yellow: '#d5b375',
      blue: '#8eaeca',
      magenta: '#be9ec6',
      cyan: '#8ebcb9',
      white: '#d7e0e4',
      brightBlack: '#5b6b75',
      brightRed: '#e58c7e',
      brightGreen: '#abc4b2',
      brightYellow: '#dfc28e',
      brightBlue: '#a3bece',
      brightMagenta: '#ceb2d4',
      brightCyan: '#a2ccc9',
      brightWhite: '#ffffff',
    };
  }
  return {
    background: '#ffffff',
    foreground: '#243039',
    cursor: '#c54e35',
    cursorAccent: '#ffffff',
    selectionBackground: '#d8e4ec',
    black: '#243039',
    red: '#cf222e',
    green: '#1a7f37',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#ffffff',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#116329',
    brightYellow: '#633c01',
    brightBlue: '#0550ae',
    brightMagenta: '#6639ba',
    brightCyan: '#114f53',
    brightWhite: '#8c959f',
  };
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-10000px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }
}

interface CellMetrics {
  offsetLeft: number;
  offsetTop: number;
  cellWidth: number;
  cellHeight: number;
}

function measureCellMetrics(
  host: HTMLElement | null,
  terminal: Terminal | null,
): CellMetrics | null {
  if (!host || !terminal) return null;
  const screenEl = host.querySelector('.xterm-screen');
  if (!(screenEl instanceof HTMLElement)) return null;
  const hostRect = host.getBoundingClientRect();
  const screenRect = screenEl.getBoundingClientRect();
  if (screenRect.width <= 0 || screenRect.height <= 0) return null;
  return {
    offsetLeft: Math.round(screenRect.left - hostRect.left),
    offsetTop: Math.round(screenRect.top - hostRect.top),
    cellWidth: screenRect.width / Math.max(1, terminal.cols),
    cellHeight: screenRect.height / Math.max(1, terminal.rows),
  };
}

export const TerminalSessionView = forwardRef<
  TerminalSessionViewHandle,
  TerminalSessionViewProps
>(function TerminalSessionView(
  {
    tab,
    theme,
    active,
    isFocused = false,
    style,
    onFocusPane,
    onStatusChange,
    onCwdChange,
    onBell,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const resizeScheduleRef = useRef<() => void>(() => undefined);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const initialCliSentRef = useRef(false);

  const [prefs, setPrefs] = useState<TerminalPreferences>(() =>
    loadTerminalPreferences(),
  );
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const [liveCwd, setLiveCwd] = useState(() => normalizeDisplayPath(tab.cwd));
  const liveCwdRef = useRef(liveCwd);
  liveCwdRef.current = liveCwd;

  const [dimensions, setDimensions] = useState({ cols: 80, rows: 24 });
  const [internalStatus, setInternalStatus] = useState('正在启动');
  const [webglActive, setWebglActive] = useState(false);
  const [bellPulse, setBellPulse] = useState(false);
  const [flashNotice, setFlashNotice] = useState('');

  // Alacritty Search Bar
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchMatchInfo, setSearchMatchInfo] = useState<{
    resultIndex: number;
    resultCount: number;
  } | null>(null);

  // Alacritty Vi Mode
  const [viState, setViState] = useState<ViModeState | null>(null);
  const viStateRef = useRef<ViModeState | null>(null);
  viStateRef.current = viState;
  const pendingGKeyRef = useRef(false);
  const [viewportTick, setViewportTick] = useState(0);

  // Alacritty Hints
  const [hints, setHints] = useState<TerminalHintMatch[]>([]);
  const [hintTyped, setHintTyped] = useState('');
  const hintsRef = useRef<TerminalHintMatch[]>([]);
  hintsRef.current = hints;
  const hintTypedRef = useRef('');
  hintTypedRef.current = hintTyped;

  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  const onBellRef = useRef(onBell);
  onBellRef.current = onBell;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  activeRef.current = active;

  const showToast = useCallback((msg: string) => {
    setFlashNotice(msg);
    window.setTimeout(() => {
      setFlashNotice((curr) => (curr === msg ? '' : curr));
    }, 1500);
  }, []);

  const queueTerminalInput = useCallback(
    (sessionId: string, data: number[]) => {
      const nextWrite = writeQueueRef.current.then(async () => {
        await terminalApi.write({ sessionId, data });
      });
      writeQueueRef.current = nextWrite.catch(() => undefined);
      return nextWrite;
    },
    [],
  );

  const sendCommand = useCallback(
    (command: string, execute = true) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      const payload = execute ? `${command}\r` : command;
      const bytes = Array.from(new TextEncoder().encode(payload));
      void queueTerminalInput(sessionId, bytes)
        .then(() => {
          terminalRef.current?.focus();
        })
        .catch((err: unknown) => {
          setInternalStatus(err instanceof Error ? err.message : '输入失败');
        });
    },
    [queueTerminalInput],
  );

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const exitViMode = useCallback(() => {
    pendingGKeyRef.current = false;
    setViState(null);
    terminalRef.current?.clearSelection();
  }, []);

  const toggleViMode = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    if (viStateRef.current?.active) {
      exitViMode();
      return;
    }
    setHints([]);
    setHintTyped('');
    const buf = term.buffer.active;
    const absLine = buf.baseY + buf.cursorY;
    setViState(createViState(absLine, buf.cursorX));
    term.focus();
  }, [exitViMode]);

  const applyViMotion = useCallback((motion: ViMotion) => {
    const term = terminalRef.current;
    const current = viStateRef.current;
    if (!term || !current?.active) return;
    const buf = term.buffer.active;
    const next = moveViCursor(current, motion, {
      totalLines: buf.length,
      cols: term.cols,
      viewportRows: term.rows,
      viewportY: buf.viewportY,
      semanticEscapeChars: prefsRef.current.semanticEscapeChars,
      getLineText: (absLine) =>
        buf.getLine(absLine)?.translateToString(false) ?? '',
    });
    setViState(next);
    // Keep Vi cursor inside visible viewport
    if (next.absLine < buf.viewportY) {
      term.scrollToLine(next.absLine);
    } else if (next.absLine >= buf.viewportY + term.rows) {
      term.scrollToLine(next.absLine - term.rows + 1);
    }
    setViewportTick((n) => n + 1);

    const span = computeViSelectionSpan(next, term.cols);
    if (span) {
      term.select(span.column, span.row, span.length);
    } else {
      term.clearSelection();
    }
  }, []);

  const executeHintAction = useCallback(
    (hint: TerminalHintMatch, copyOnly: boolean) => {
      setHints([]);
      setHintTyped('');
      if (hint.kind === 'url' && !copyOnly) {
        window.open(hint.value, '_blank', 'noopener,noreferrer');
        showToast('已打开链接');
      } else {
        void copyTextToClipboard(hint.value).then((ok) => {
          if (ok) showToast(`已复制: ${hint.value.slice(0, 28)}`);
        });
      }
      terminalRef.current?.focus();
    },
    [showToast],
  );

  const triggerHints = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    if (hintsRef.current.length > 0) {
      setHints([]);
      setHintTyped('');
      term.focus();
      return;
    }
    const buf = term.buffer.active;
    const rows: VisibleBufferRow[] = [];
    for (let r = 0; r < term.rows; r += 1) {
      const line = buf.getLine(buf.viewportY + r);
      if (!line) continue;
      rows.push({
        viewportRow: r,
        text: line.translateToString(true),
        isWrapped: line.isWrapped,
      });
    }
    const matched = extractTerminalHints(rows);
    if (matched.length === 0) {
      showToast('当前屏幕未检测到链接或路径');
      return;
    }
    setViState(null);
    setHints(matched);
    setHintTyped('');
    term.focus();
  }, [showToast]);

  useImperativeHandle(
    ref,
    () => ({
      sendCommand,
      clear: () => terminalRef.current?.clear(),
      focus: () => terminalRef.current?.focus(),
      openSearch,
      toggleViMode,
      triggerHints,
      getCwd: () => liveCwdRef.current,
    }),
    [openSearch, sendCommand, toggleViMode, triggerHints],
  );

  // Sync terminal preferences in real time
  useEffect(() => {
    return onTerminalPreferencesChanged((next) => {
      setPrefs(next);
    });
  }, []);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontSize = prefs.fontSize;
    term.options.lineHeight = prefs.lineHeight;
    term.options.fontFamily = prefs.fontFamily;
    term.options.cursorStyle = prefs.cursorStyle;
    term.options.cursorBlink = prefs.cursorBlink;
    term.options.scrollback = prefs.scrollback;
    if (webglAddonRef.current) {
      webglAddonRef.current.clearTextureAtlas();
    }
    resizeScheduleRef.current();
  }, [prefs]);

  useEffect(() => {
    let alive = true;
    let sessionId: string | null = null;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let searchAddon: SearchAddon | null = null;
    let webglAddon: WebglAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenCwd: (() => void) | null = null;
    let unlistenBell: (() => void) | null = null;
    let resizeTimer: number | null = null;
    let cliLaunchTimer: number | null = null;
    let bellResetTimer: number | null = null;
    let outputFrame: number | null = null;
    let outputChunks: Uint8Array[] = [];
    let queuedOutputBytes = 0;
    let omittedOutputBytes = 0;
    const maxQueuedOutputBytes = 2 * 1024 * 1024;
    initialCliSentRef.current = false;

    const flushOutput = () => {
      outputFrame = null;
      if (!terminal || outputChunks.length === 0) return;
      const chunks = outputChunks;
      const byteLength = queuedOutputBytes;
      const omitted = omittedOutputBytes;
      outputChunks = [];
      queuedOutputBytes = 0;
      omittedOutputBytes = 0;
      if (omitted > 0) {
        terminal.write(
          new TextEncoder().encode(
            '\r\n[输出繁忙，已省略 ' + omitted + ' 字节旧内容]\r\n',
          ),
        );
      }
      const batch = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        batch.set(chunk, offset);
        offset += chunk.byteLength;
      }
      terminal.write(batch);

      if (tab.initialCli && !initialCliSentRef.current && sessionId) {
        const sid = sessionId;
        const cli = tab.initialCli;
        initialCliSentRef.current = true;
        cliLaunchTimer = window.setTimeout(() => {
          if (!alive) return;
          const bytes = Array.from(new TextEncoder().encode(`${cli}\r`));
          void queueTerminalInput(sid, bytes);
        }, 220);
      }
    };

    const queueOutput = (data: number[]) => {
      let chunk = Uint8Array.from(data);
      if (chunk.byteLength > maxQueuedOutputBytes) {
        omittedOutputBytes += chunk.byteLength - maxQueuedOutputBytes;
        chunk = chunk.slice(chunk.byteLength - maxQueuedOutputBytes);
      }
      outputChunks.push(chunk);
      queuedOutputBytes += chunk.byteLength;
      while (
        queuedOutputBytes > maxQueuedOutputBytes &&
        outputChunks.length > 0
      ) {
        const removed = outputChunks.shift();
        if (removed) {
          queuedOutputBytes -= removed.byteLength;
          omittedOutputBytes += removed.byteLength;
        }
      }
      if (outputFrame === null)
        outputFrame = requestAnimationFrame(flushOutput);
    };

    const startSession = async () => {
      const host = hostRef.current;
      if (!host) return;

      const outputListener = await listen<TerminalOutputEvent>(
        'seamind-terminal-output',
        (event) => {
          if (alive && event.payload.sessionId === sessionId) {
            queueOutput(event.payload.data);
          }
        },
      );

      const exitListener = await listen<TerminalExitEvent>(
        'seamind-terminal-exit',
        (event) => {
          if (alive && event.payload.sessionId === sessionId) {
            setInternalStatus('Shell 已退出');
            onStatusChangeRef.current?.('exited', '会话进程已结束');
            terminal?.writeln('\r\n[会话进程已退出]');
          }
        },
      );

      const cwdListener = await listen<TerminalCwdEvent>(
        'seamind-terminal-cwd',
        (event) => {
          if (alive && event.payload.sessionId === sessionId) {
            const clean = normalizeDisplayPath(event.payload.cwd);
            if (clean) {
              setLiveCwd(clean);
              onCwdChangeRef.current?.(clean);
            }
          }
        },
      );

      const bellListener = await listen<TerminalBellEvent>(
        'seamind-terminal-bell',
        (event) => {
          if (alive && event.payload.sessionId === sessionId) {
            setBellPulse(true);
            onBellRef.current?.();
            if (bellResetTimer !== null) window.clearTimeout(bellResetTimer);
            bellResetTimer = window.setTimeout(() => {
              setBellPulse(false);
            }, 1300);
          }
        },
      );

      if (!alive) {
        outputListener();
        exitListener();
        cwdListener();
        bellListener();
        return;
      }
      unlistenOutput = outputListener;
      unlistenExit = exitListener;
      unlistenCwd = cwdListener;
      unlistenBell = bellListener;

      const initialPrefs = prefsRef.current;
      terminal = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: initialPrefs.cursorBlink,
        cursorStyle: initialPrefs.cursorStyle,
        fontFamily: initialPrefs.fontFamily,
        fontSize: initialPrefs.fontSize,
        lineHeight: initialPrefs.lineHeight,
        scrollback: initialPrefs.scrollback,
        theme: resolveTerminalTheme(theme),
      });
      terminalRef.current = terminal;

      terminal.open(host);

      const attached = attachStandardXtermAddons(terminal, {
        webglEnabled: initialPrefs.webglEnabled,
        onSearchResults: (res) => {
          if (alive) setSearchMatchInfo(res ?? null);
        },
        onWebglStateChange: (webglOn) => {
          if (alive) setWebglActive(webglOn);
        },
      });
      fitAddon = attached.fitAddon;
      fitAddonRef.current = fitAddon;
      searchAddon = attached.searchAddon;
      searchAddonRef.current = searchAddon;
      webglAddon = attached.getWebglAddon();
      webglAddonRef.current = webglAddon;

      terminal.onScroll(() => {
        if (viStateRef.current?.active || hintsRef.current.length > 0) {
          setViewportTick((n) => n + 1);
        }
      });

      terminal.onSelectionChange(() => {
        if (viStateRef.current?.active) return;
        if (!prefsRef.current.saveOnSelect) return;
        const selected = terminal?.getSelection() ?? '';
        if (!selected) return;
        void copyTextToClipboard(selected).then((ok) => {
          if (ok && alive) showToast('选区已复制');
        });
      });

      terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== 'keydown') return true;
        const ctrl = ev.ctrlKey;
        const shift = ev.shiftKey;
        const keyLower = ev.key.toLowerCase();

        // 1. Hints interaction mode
        if (hintsRef.current.length > 0) {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            setHints([]);
            setHintTyped('');
            return false;
          }
          if (!ctrl && !ev.altKey && !ev.metaKey && /^[a-z]$/i.test(ev.key)) {
            ev.preventDefault();
            const nextTyped = hintTypedRef.current + keyLower;
            const candidates = hintsRef.current.filter((item) =>
              item.label.startsWith(nextTyped),
            );
            if (candidates.length === 1 && candidates[0].label === nextTyped) {
              executeHintAction(candidates[0], shift);
            } else if (candidates.length === 0) {
              setHints([]);
              setHintTyped('');
            } else {
              setHintTyped(nextTyped);
            }
            return false;
          }
          return false;
        }

        // 2. Vi Mode toggle (Ctrl+Shift+Space)
        if (ctrl && shift && !ev.altKey && ev.code === 'Space') {
          ev.preventDefault();
          toggleViMode();
          return false;
        }

        // 3. Vi Mode key handling
        if (viStateRef.current?.active) {
          if (ev.key === 'Escape' || (!ctrl && keyLower === 'q')) {
            ev.preventDefault();
            exitViMode();
            return false;
          }
          if (ev.key === '/' || ev.key === '?') {
            ev.preventDefault();
            openSearch();
            return false;
          }
          if (ctrl && keyLower === 'u') {
            ev.preventDefault();
            applyViMotion('page-up');
            return false;
          }
          if (ctrl && keyLower === 'd') {
            ev.preventDefault();
            applyViMotion('page-down');
            return false;
          }
          if (ev.key === 'h' || ev.key === 'ArrowLeft') {
            ev.preventDefault();
            applyViMotion('left');
            return false;
          }
          if (ev.key === 'j' || ev.key === 'ArrowDown') {
            ev.preventDefault();
            applyViMotion('down');
            return false;
          }
          if (ev.key === 'k' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            applyViMotion('up');
            return false;
          }
          if (ev.key === 'l' || ev.key === 'ArrowRight') {
            ev.preventDefault();
            applyViMotion('right');
            return false;
          }
          if (ev.key === '0') {
            ev.preventDefault();
            applyViMotion('line-start');
            return false;
          }
          if (ev.key === '^') {
            ev.preventDefault();
            applyViMotion('line-first-nonblank');
            return false;
          }
          if (ev.key === '$') {
            ev.preventDefault();
            applyViMotion('line-end');
            return false;
          }
          if (ev.key === 'w' || ev.key === 'W') {
            ev.preventDefault();
            applyViMotion('word-next');
            return false;
          }
          if (ev.key === 'b' || ev.key === 'B') {
            ev.preventDefault();
            applyViMotion('word-prev');
            return false;
          }
          if (ev.key === 'e' || ev.key === 'E') {
            ev.preventDefault();
            applyViMotion('word-end');
            return false;
          }
          if (ev.key === 'g') {
            ev.preventDefault();
            if (pendingGKeyRef.current) {
              pendingGKeyRef.current = false;
              applyViMotion('top');
            } else {
              pendingGKeyRef.current = true;
            }
            return false;
          }
          pendingGKeyRef.current = false;
          if (ev.key === 'G') {
            ev.preventDefault();
            applyViMotion('bottom');
            return false;
          }
          if (ev.key === 'H') {
            ev.preventDefault();
            applyViMotion('screen-top');
            return false;
          }
          if (ev.key === 'M') {
            ev.preventDefault();
            applyViMotion('screen-mid');
            return false;
          }
          if (ev.key === 'L') {
            ev.preventDefault();
            applyViMotion('screen-bottom');
            return false;
          }
          if (ev.key === 'v') {
            ev.preventDefault();
            applyViMotion('toggle-char');
            return false;
          }
          if (ev.key === 'V') {
            ev.preventDefault();
            applyViMotion('toggle-line');
            return false;
          }
          if (ev.key === 'y' || ev.key === 'Enter') {
            ev.preventDefault();
            const selected = terminal?.getSelection() ?? '';
            const textToCopy =
              selected ||
              (terminal?.buffer.active
                .getLine(viStateRef.current.absLine)
                ?.translateToString(true) ??
                '');
            void copyTextToClipboard(textToCopy).then((ok) => {
              if (ok) showToast('已复制 [VI]');
            });
            exitViMode();
            return false;
          }
          return false;
        }

        // 4. Global terminal shortcuts (Search / Hints / Clipboard / Font Zoom)
        if (ctrl && shift && keyLower === 'f') {
          ev.preventDefault();
          openSearch();
          return false;
        }
        if (ctrl && shift && keyLower === 'o') {
          ev.preventDefault();
          triggerHints();
          return false;
        }
        if (ctrl && shift && keyLower === 'c') {
          const selected = terminal?.getSelection() ?? '';
          if (selected) {
            ev.preventDefault();
            void copyTextToClipboard(selected).then((ok) => {
              if (ok) showToast('已复制');
            });
          }
          return false;
        }
        if (ctrl && shift && keyLower === 'v') {
          ev.preventDefault();
          void navigator.clipboard.readText().then((txt) => {
            if (txt) terminal?.paste(txt);
          });
          return false;
        }
        if (
          ctrl &&
          !shift &&
          !ev.altKey &&
          keyLower === 'c' &&
          prefsRef.current.smartCopyPaste &&
          terminal?.hasSelection()
        ) {
          ev.preventDefault();
          const selected = terminal.getSelection();
          terminal.clearSelection();
          void copyTextToClipboard(selected).then((ok) => {
            if (ok) showToast('已复制');
          });
          return false;
        }
        if (ctrl && !ev.altKey && (ev.key === '=' || ev.key === '+')) {
          ev.preventDefault();
          saveTerminalPreferences({ fontSize: prefsRef.current.fontSize + 1 });
          return false;
        }
        if (ctrl && !ev.altKey && ev.key === '-') {
          ev.preventDefault();
          saveTerminalPreferences({ fontSize: prefsRef.current.fontSize - 1 });
          return false;
        }
        if (ctrl && !ev.altKey && ev.key === '0') {
          ev.preventDefault();
          saveTerminalPreferences({ fontSize: 13 });
          return false;
        }

        return true;
      });

      fitAddon.fit();
      setDimensions({ cols: terminal.cols, rows: terminal.rows });

      const applyResize = () => {
        if (!alive || !activeRef.current || !terminal || !fitAddon) return;
        try {
          fitAddon.fit();
          setDimensions({ cols: terminal.cols, rows: terminal.rows });
          setViewportTick((n) => n + 1);
          const hostEl = hostRef.current;
          const pixelWidth = hostEl
            ? Math.max(0, Math.round(hostEl.clientWidth))
            : undefined;
          const pixelHeight = hostEl
            ? Math.max(0, Math.round(hostEl.clientHeight))
            : undefined;
          if (sessionId) {
            void terminalApi
              .resize({
                sessionId,
                cols: terminal.cols,
                rows: terminal.rows,
                pixelWidth,
                pixelHeight,
              })
              .catch(() => undefined);
          }
        } catch {
          // ignore layout transition errors
        }
      };

      const scheduleResize = () => {
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          resizeTimer = null;
          requestAnimationFrame(applyResize);
        }, 48);
      };
      resizeScheduleRef.current = scheduleResize;
      resizeObserver = new ResizeObserver(scheduleResize);
      resizeObserver.observe(host);

      const cleanStartCwd = normalizeDisplayPath(tab.cwd);
      sessionId = await terminalApi.start({
        cwd: cleanStartCwd,
        cols: terminal.cols,
        rows: terminal.rows,
        pixelWidth: Math.max(0, Math.round(host.clientWidth)),
        pixelHeight: Math.max(0, Math.round(host.clientHeight)),
        shell: tab.shell,
      });

      sessionIdRef.current = sessionId;
      if (!alive) {
        void terminalApi.close({ sessionId }).catch(() => undefined);
        return;
      }

      setInternalStatus('就绪');
      onStatusChangeRef.current?.('ready', '运行就绪');
      terminal.writeln(
        `Seamind Terminal [${tab.shell.toUpperCase()}] · ${cleanStartCwd || '默认工作目录'}`,
      );

      terminal.onData((data) => {
        if (!sessionId) return;
        const bytes = Array.from(new TextEncoder().encode(data));
        void queueTerminalInput(sessionId, bytes).catch((err: unknown) => {
          if (alive) {
            setInternalStatus(err instanceof Error ? err.message : '写入异常');
          }
        });
      });

      scheduleResize();
    };

    void startSession().catch((err: unknown) => {
      if (!alive) return;
      const msg = err instanceof Error ? err.message : String(err);
      setInternalStatus(`失败`);
      onStatusChangeRef.current?.('error', msg);
      terminalRef.current?.writeln(`\r\n[终端会话启动失败：${msg}]`);
    });

    return () => {
      alive = false;
      sessionIdRef.current = null;
      resizeObserver?.disconnect();
      resizeScheduleRef.current = () => undefined;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (cliLaunchTimer !== null) window.clearTimeout(cliLaunchTimer);
      if (bellResetTimer !== null) window.clearTimeout(bellResetTimer);
      if (outputFrame !== null) cancelAnimationFrame(outputFrame);
      outputChunks = [];
      queuedOutputBytes = 0;
      unlistenOutput?.();
      unlistenExit?.();
      unlistenCwd?.();
      unlistenBell?.();
      try {
        webglAddon?.dispose();
      } catch {
        // noop
      }
      webglAddonRef.current = null;
      searchAddon?.dispose();
      searchAddonRef.current = null;
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      if (sessionId) {
        void terminalApi.close({ sessionId }).catch(() => undefined);
      }
    };
  }, [
    tab.id,
    tab.shell,
    tab.cwd,
    tab.initialCli,
    applyViMotion,
    executeHintAction,
    exitViMode,
    openSearch,
    queueTerminalInput,
    showToast,
    toggleViMode,
    triggerHints,
  ]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = resolveTerminalTheme(theme);
    }
  }, [theme]);

  useEffect(() => {
    if (active) resizeScheduleRef.current();
  }, [active]);

  const runSearch = (direction: 'next' | 'prev', term = searchQuery) => {
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (!term) {
      addon.clearDecorations();
      setSearchMatchInfo(null);
      return;
    }
    const options: ISearchOptions = {
      caseSensitive: searchCase,
      regex: searchRegex,
      incremental: direction === 'next',
    };
    const found =
      direction === 'next'
        ? addon.findNext(term, options)
        : addon.findPrevious(term, options);
    if (!found) {
      setSearchMatchInfo({ resultIndex: -1, resultCount: 0 });
    }
    if (viStateRef.current?.active && terminalRef.current) {
      const selPos = terminalRef.current.getSelectionPosition();
      if (selPos) {
        setViState((prev) =>
          prev
            ? {
                ...prev,
                absLine: selPos.start.y,
                col: selPos.start.x,
              }
            : null,
        );
      }
    }
  };

  // Compute live overlay geometry for Hints and Vi Cursor
  void viewportTick;
  const metrics =
    viState?.active || hints.length > 0
      ? measureCellMetrics(hostRef.current, terminalRef.current)
      : null;
  const activeBuf = terminalRef.current?.buffer.active;
  const viViewportRow =
    viState?.active && activeBuf ? viState.absLine - activeBuf.viewportY : -1;
  const showViCursor =
    Boolean(viState?.active && metrics) &&
    viViewportRow >= 0 &&
    viViewportRow < (terminalRef.current?.rows ?? 0);

  return (
    <div
      className={`terminal-session-container${active ? ' is-active' : ' is-inactive'}${isFocused ? ' is-focused' : ''}${bellPulse ? ' is-bell' : ''}`}
      style={{ ...style, display: active ? 'flex' : 'none' }}
      onMouseDown={() => onFocusPane?.()}
    >
      <div
        className="terminal-session-host"
        ref={hostRef}
        onContextMenu={(event) => {
          const term = terminalRef.current;
          if (!term) return;
          if (term.hasSelection()) {
            event.preventDefault();
            const text = term.getSelection();
            term.clearSelection();
            void copyTextToClipboard(text).then((ok) => {
              if (ok) showToast('已复制');
            });
          } else {
            event.preventDefault();
            void navigator.clipboard.readText().then((txt) => {
              if (txt) term.paste(txt);
            });
          }
        }}
      />

      {/* Vi Mode Cursor Overlay */}
      {showViCursor && metrics && viState && (
        <div
          className={`terminal-vi-cursor is-${viState.selectionMode}`}
          aria-hidden="true"
          style={{
            left: `${Math.round(metrics.offsetLeft + viState.col * metrics.cellWidth)}px`,
            top: `${Math.round(metrics.offsetTop + viViewportRow * metrics.cellHeight)}px`,
            width: `${Math.max(6, Math.round(metrics.cellWidth))}px`,
            height: `${Math.max(12, Math.round(metrics.cellHeight))}px`,
          }}
        />
      )}

      {/* Alacritty Hints Overlay */}
      {hints.length > 0 && metrics && (
        <div
          className="terminal-hints-layer"
          aria-label="屏幕 Hints 跳转层（输入字母跳转，Shift+字母复制，Esc 关闭）"
        >
          {hints.map((hint) => {
            const matchesPrefix =
              !hintTyped || hint.label.startsWith(hintTyped);
            const firstSeg = hint.segments[0];
            return (
              <div key={hint.id}>
                {hint.segments.map((seg, idx) => (
                  <span
                    key={`${hint.id}-seg-${idx}`}
                    className={`terminal-hint-underline is-${hint.kind}${matchesPrefix ? '' : ' is-dimmed'}`}
                    style={{
                      left: `${Math.round(metrics.offsetLeft + seg.col * metrics.cellWidth)}px`,
                      top: `${Math.round(metrics.offsetTop + seg.viewportRow * metrics.cellHeight)}px`,
                      width: `${Math.round(seg.length * metrics.cellWidth)}px`,
                      height: `${Math.round(metrics.cellHeight)}px`,
                    }}
                    onClick={(ev) => executeHintAction(hint, ev.shiftKey)}
                  />
                ))}
                {firstSeg && matchesPrefix && (
                  <button
                    type="button"
                    className={`terminal-hint-badge is-${hint.kind}`}
                    style={{
                      left: `${Math.round(metrics.offsetLeft + firstSeg.col * metrics.cellWidth)}px`,
                      top: `${Math.round(metrics.offsetTop + firstSeg.viewportRow * metrics.cellHeight)}px`,
                    }}
                    onClick={(ev) => executeHintAction(hint, ev.shiftKey)}
                    title={`${hint.value}（点击打开，Shift+点击复制）`}
                  >
                    {hint.label.toUpperCase()}
                  </button>
                )}
              </div>
            );
          })}
          <div className="terminal-hints-banner">
            HINTS · 敲按键跳转（Shift 复制） · {hints.length} 项 · Esc 退出
          </div>
        </div>
      )}

      {/* Alacritty Search Bar */}
      {searchOpen && (
        <div
          className="terminal-search-bar"
          role="search"
          aria-label="终端缓冲区搜索"
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              ev.stopPropagation();
              setSearchOpen(false);
              searchAddonRef.current?.clearDecorations();
              setSearchMatchInfo(null);
              terminalRef.current?.focus();
            }
          }}
        >
          <input
            ref={searchInputRef}
            type="text"
            className="terminal-search-input"
            placeholder="搜索屏幕与历史输出…"
            value={searchQuery}
            onChange={(ev) => {
              const val = ev.target.value;
              setSearchQuery(val);
              runSearch('next', val);
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                runSearch(ev.shiftKey ? 'prev' : 'next');
              }
            }}
          />
          <button
            type="button"
            className={`terminal-search-flag${searchCase ? ' is-active' : ''}`}
            onClick={() => {
              const next = !searchCase;
              setSearchCase(next);
              searchAddonRef.current?.findNext(searchQuery, {
                caseSensitive: next,
                regex: searchRegex,
              });
            }}
            title="区分大小写"
          >
            Aa
          </button>
          <button
            type="button"
            className={`terminal-search-flag${searchRegex ? ' is-active' : ''}`}
            onClick={() => {
              const next = !searchRegex;
              setSearchRegex(next);
              searchAddonRef.current?.findNext(searchQuery, {
                caseSensitive: searchCase,
                regex: next,
              });
            }}
            title="正则表达式"
          >
            .*
          </button>
          <span className="terminal-search-count">
            {searchMatchInfo
              ? searchMatchInfo.resultCount > 0
                ? `${searchMatchInfo.resultIndex + 1}/${searchMatchInfo.resultCount}`
                : '0'
              : ''}
          </span>
          <button
            type="button"
            className="terminal-search-nav"
            onClick={() => runSearch('prev')}
            title="上一匹配 (Shift+Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            className="terminal-search-nav"
            onClick={() => runSearch('next')}
            title="下一匹配 (Enter)"
          >
            ↓
          </button>
          <button
            type="button"
            className="terminal-search-nav"
            onClick={() => {
              setSearchOpen(false);
              searchAddonRef.current?.clearDecorations();
              setSearchMatchInfo(null);
              terminalRef.current?.focus();
            }}
            title="关闭搜索 (Esc)"
          >
            ×
          </button>
        </div>
      )}

      {/* Clean Crisp Pixel Statusbar */}
      <footer className="terminal-session-statusbar">
        <span className="terminal-status-badge">{tab.shell.toUpperCase()}</span>
        <span className="terminal-status-cwd" title={liveCwd || '工作目录'}>
          {liveCwd || '.'}
        </span>

        {viState?.active && (
          <span className="terminal-status-pill is-vi">
            VI{' '}
            {viState.selectionMode === 'line'
              ? 'LINE'
              : viState.selectionMode === 'char'
                ? 'VISUAL'
                : 'NORMAL'}
          </span>
        )}
        {hints.length > 0 && (
          <span className="terminal-status-pill is-hints">HINTS</span>
        )}
        {flashNotice && (
          <span className="terminal-status-pill is-toast">{flashNotice}</span>
        )}
        {internalStatus !== '就绪' && (
          <span className="terminal-status-pill is-state">
            {internalStatus}
          </span>
        )}

        <div className="terminal-status-right">
          <span className="terminal-status-meta" title="当前渲染引擎与尺寸">
            {webglActive ? 'GL' : 'DOM'} · {dimensions.cols}×{dimensions.rows}
          </span>

          <div
            className="terminal-status-zoom"
            role="group"
            aria-label="字体缩放"
          >
            <button
              type="button"
              className="terminal-status-btn"
              onClick={() =>
                saveTerminalPreferences({ fontSize: prefs.fontSize - 1 })
              }
              title="缩小字号 (Ctrl+-)"
            >
              -
            </button>
            <span className="terminal-status-zoom-val">{prefs.fontSize}px</span>
            <button
              type="button"
              className="terminal-status-btn"
              onClick={() =>
                saveTerminalPreferences({ fontSize: prefs.fontSize + 1 })
              }
              title="放大字号 (Ctrl+=)"
            >
              +
            </button>
          </div>

          <button
            type="button"
            className={`terminal-status-btn${prefs.saveOnSelect ? ' is-active' : ''}`}
            onClick={() =>
              saveTerminalPreferences({ saveOnSelect: !prefs.saveOnSelect })
            }
            title="Alacritty save_to_clipboard：鼠标拖选后自动复制到剪贴板"
          >
            选即复制
          </button>

          <button
            type="button"
            className={`terminal-status-btn${searchOpen ? ' is-active' : ''}`}
            onClick={openSearch}
            title="缓冲区搜索 (Ctrl+Shift+F)"
          >
            搜索
          </button>

          <button
            type="button"
            className={`terminal-status-btn${viState?.active ? ' is-active' : ''}`}
            onClick={toggleViMode}
            title="Vi 键盘光标与选择模式 (Ctrl+Shift+Space)"
          >
            VI
          </button>

          <button
            type="button"
            className={`terminal-status-btn${hints.length > 0 ? ' is-active' : ''}`}
            onClick={triggerHints}
            title="屏幕 URL 与文件路径快捷标号跳转 (Ctrl+Shift+O)"
          >
            Hints
          </button>

          <button
            type="button"
            className="terminal-status-btn"
            onClick={() => terminalRef.current?.clear()}
            title="清空当前终端屏幕"
          >
            清屏
          </button>
        </div>
      </footer>
    </div>
  );
});
