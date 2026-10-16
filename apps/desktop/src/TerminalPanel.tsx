import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

type AppTheme = 'light' | 'dark';

interface TerminalOutputEvent {
  sessionId: string;
  data: number[];
}

interface TerminalExitEvent {
  sessionId: string;
}

interface TerminalPanelProps {
  cwd: string;
  theme: AppTheme;
  onClose: () => void;
}

export default function TerminalPanel({
  cwd,
  theme,
  onClose,
}: TerminalPanelProps) {
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState('正在启动…');

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    let active = true;
    let sessionId: string | null = null;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let disposeInput: { dispose: () => void } | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    const pendingOutput: number[][] = [];

    const start = async () => {
      const outputListener = await listen<TerminalOutputEvent>(
        'seamind-terminal-output',
        (event) => {
          const payload = event.payload;
          if (!active) return;
          if (!sessionId) {
            pendingOutput.push(payload.data);
            return;
          }
          if (payload.sessionId === sessionId)
            terminal?.write(Uint8Array.from(payload.data));
        },
      );
      const exitListener = await listen<TerminalExitEvent>(
        'seamind-terminal-exit',
        (event) => {
          if (active && event.payload.sessionId === sessionId) {
            setStatus('Shell 已退出');
            terminal?.writeln('\r\n[Shell 已退出]');
          }
        },
      );
      if (!active) {
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
        fontFamily: 'Cascadia Code, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 5000,
        theme: terminalTheme(theme),
      });
      terminalRef.current = terminal;
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(host);
      fitAddon.fit();

      const resize = () => {
        if (!active || !terminal || !fitAddon) return;
        try {
          fitAddon.fit();
          if (sessionId)
            void invoke('terminal_resize', {
              sessionId,
              cols: terminal.cols,
              rows: terminal.rows,
            }).catch(() => undefined);
        } catch {
          // The terminal can briefly have a zero-sized host during layout.
        }
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);

      sessionId = await invoke<string>('terminal_start', {
        cwd,
        cols: terminal.cols,
        rows: terminal.rows,
      });
      if (!active) {
        void invoke('terminal_close', { sessionId }).catch(() => undefined);
        return;
      }
      setStatus(cwd || 'PowerShell');
      terminal.writeln(`seamind terminal  ·  ${cwd || '默认工作目录'}`);
      pendingOutput.splice(0).forEach((data) => {
        terminal?.write(Uint8Array.from(data));
      });
      disposeInput = terminal.onData((data) => {
        if (!sessionId) return;
        const bytes = Array.from(new TextEncoder().encode(data));
        void invoke('terminal_write', { sessionId, data: bytes }).catch(
          (error: unknown) => {
            if (active)
              setStatus(error instanceof Error ? error.message : '输入失败');
          },
        );
      });
      requestAnimationFrame(resize);
    };

    void start().catch((error: unknown) => {
      if (!active) return;
      setStatus(error instanceof Error ? error.message : '终端启动失败');
      terminal?.writeln(`\r\n[终端启动失败：${String(error)}]`);
    });

    return () => {
      active = false;
      resizeObserver?.disconnect();
      disposeInput?.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      terminal?.dispose();
      terminalRef.current = null;
      if (sessionId)
        void invoke('terminal_close', { sessionId }).catch(() => undefined);
    };
  }, [cwd]);

  return (
    <section className="seamind-terminal" aria-label="Seamind 终端">
      <header className="seamind-terminal-heading">
        <div>
          <strong>终端</strong>
          <span title={cwd}>{status}</span>
        </div>
        <div className="seamind-terminal-actions">
          <button
            type="button"
            onClick={() => terminalRef.current?.clear()}
            title="清屏"
          >
            清屏
          </button>
          <button
            type="button"
            className="seamind-terminal-close"
            onClick={onClose}
            aria-label="关闭终端并结束 Shell"
            title="关闭终端并结束 Shell"
          >
            关闭
          </button>
        </div>
      </header>
      <div className="seamind-terminal-host" ref={terminalHostRef} />
      <div className="seamind-terminal-note">
        Shell 命令会以当前 Windows 用户权限运行。关闭终端会结束 Shell 进程。
      </div>
    </section>
  );
}

function terminalTheme(theme: AppTheme) {
  return theme === 'dark'
    ? {
        background: '#11171b',
        foreground: '#d7e0e4',
        cursor: '#e06d55',
        selectionBackground: '#34434b',
        black: '#11171b',
        red: '#db7868',
        green: '#9ab6a2',
        yellow: '#d5b375',
        blue: '#8eaeca',
        magenta: '#be9ec6',
        cyan: '#8ebcb9',
        white: '#d7e0e4',
      }
    : {
        background: '#fff',
        foreground: '#243039',
        cursor: '#d9664f',
        selectionBackground: '#d8e4ec',
      };
}
