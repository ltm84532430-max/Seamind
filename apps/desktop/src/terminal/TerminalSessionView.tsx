import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from 'react';
import type { CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../app/app-storage';
import type { TerminalTab } from './terminal-types';

interface TerminalOutputEvent {
  sessionId: string;
  data: number[];
}

interface TerminalExitEvent {
  sessionId: string;
}

export interface TerminalSessionViewHandle {
  sendCommand: (command: string, execute?: boolean) => void;
  clear: () => void;
  focus: () => void;
}

interface TerminalSessionViewProps {
  tab: TerminalTab;
  theme: Theme;
  active: boolean;
  style?: CSSProperties;
  onStatusChange?: (status: TerminalTab['status'], message?: string) => void;
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

export const TerminalSessionView = forwardRef<
  TerminalSessionViewHandle,
  TerminalSessionViewProps
>(function TerminalSessionView(
  { tab, theme, active, style, onStatusChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const resizeScheduleRef = useRef<() => void>(() => undefined);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [internalStatus, setInternalStatus] = useState<string>('正在初始化…');

  activeRef.current = active;

  const queueTerminalInput = useCallback(
    (sessionId: string, data: number[]) => {
      const nextWrite = writeQueueRef.current.then(async () => {
        await invoke('terminal_write', { sessionId, data });
      });
      writeQueueRef.current = nextWrite.catch(() => undefined);
      return nextWrite;
    },
    [],
  );

  const sendCommand = (command: string, execute = true) => {
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
  };

  useImperativeHandle(ref, () => ({
    sendCommand,
    clear: () => terminalRef.current?.clear(),
    focus: () => terminalRef.current?.focus(),
  }));

  useEffect(() => {
    let alive = true;
    let sessionId: string | null = null;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let resizeTimer: number | null = null;
    let outputFrame: number | null = null;
    let outputChunks: Uint8Array[] = [];
    let queuedOutputBytes = 0;
    let omittedOutputBytes = 0;
    const maxQueuedOutputBytes = 2 * 1024 * 1024;

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
            onStatusChange?.('exited', '会话进程已结束');
            terminal?.writeln('\r\n[会话进程已退出]');
          }
        },
      );

      if (!alive) {
        outputListener();
        exitListener();
        return;
      }
      unlistenOutput = outputListener;
      unlistenExit = exitListener;

      terminal = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        fontFamily: 'Cascadia Code, Consolas, "JetBrains Mono", monospace',
        fontSize: 12.5,
        lineHeight: 1.25,
        scrollback: 8000,
        theme: resolveTerminalTheme(theme),
      });
      terminalRef.current = terminal;

      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminal.open(host);
      fitAddon.fit();

      const applyResize = () => {
        if (!alive || !activeRef.current || !terminal || !fitAddon) return;
        try {
          fitAddon.fit();
          if (sessionId) {
            void invoke('terminal_resize', {
              sessionId,
              cols: terminal.cols,
              rows: terminal.rows,
            }).catch(() => undefined);
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
        }, 64);
      };
      resizeScheduleRef.current = scheduleResize;
      resizeObserver = new ResizeObserver(scheduleResize);
      resizeObserver.observe(host);

      sessionId = await invoke<string>('terminal_start', {
        cwd: tab.cwd,
        cols: terminal.cols,
        rows: terminal.rows,
        shell: tab.shell,
      });

      sessionIdRef.current = sessionId;
      if (!alive) {
        void invoke('terminal_close', { sessionId }).catch(() => undefined);
        return;
      }

      setInternalStatus(tab.cwd || '已就绪');
      onStatusChange?.('ready', '运行就绪');
      terminal.writeln(
        `Seamind Terminal Session [${tab.shell.toUpperCase()}] · ${tab.cwd || '默认工作目录'}`,
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
      setInternalStatus(`启动失败: ${msg}`);
      onStatusChange?.('error', msg);
      terminalRef.current?.writeln(`\r\n[终端会话启动失败：${msg}]`);
    });

    return () => {
      alive = false;
      sessionIdRef.current = null;
      resizeObserver?.disconnect();
      resizeScheduleRef.current = () => undefined;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (outputFrame !== null) cancelAnimationFrame(outputFrame);
      outputChunks = [];
      queuedOutputBytes = 0;
      unlistenOutput?.();
      unlistenExit?.();
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      if (sessionId) {
        void invoke('terminal_close', { sessionId }).catch(() => undefined);
      }
    };
  }, [tab.id, tab.shell, tab.cwd]);

  // Adjust theme dynamically without respawning session
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = resolveTerminalTheme(theme);
    }
  }, [theme]);

  // Refit when tab becomes active
  useEffect(() => {
    if (active) resizeScheduleRef.current();
  }, [active]);

  return (
    <div
      className={`terminal-session-container ${active ? 'is-active' : 'is-inactive'}`}
      style={{ ...style, display: active ? 'flex' : 'none' }}
    >
      <div className="terminal-session-host" ref={hostRef} />
      <footer className="terminal-session-statusbar">
        <span className="terminal-status-badge">{tab.shell.toUpperCase()}</span>
        <span className="terminal-status-cwd" title={tab.cwd || '工作目录'}>
          {tab.cwd || '.'}
        </span>
        <span className="terminal-status-info">{internalStatus}</span>
        <div className="terminal-status-actions">
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
