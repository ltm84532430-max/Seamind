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

interface PendingTerminalCommand {
  id: string;
  language: string;
  source: string;
}

interface TerminalPanelProps {
  cwd: string;
  theme: AppTheme;
  pendingCommand: PendingTerminalCommand | null;
  onCommandSubmitted: (id: string) => void;
  onCommandOutput: (id: string, output: string) => void;
  onClose: () => void;
}

interface CommandCapture {
  id: string;
  scriptPath: string;
  beginMarker: string;
  endMarker: string;
  decoder: TextDecoder;
  beforeStart: string;
  tail: string;
  output: string;
  started: boolean;
  truncated: boolean;
}

const maxCapturedOutput = 60_000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  }
  return btoa(binary);
}

function stripAnsi(value: string): string {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  return value
    .replace(
      new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, 'g'),
      '',
    )
    .replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export default function TerminalPanel({
  cwd,
  theme,
  pendingCommand,
  onCommandSubmitted,
  onCommandOutput,
  onClose,
}: TerminalPanelProps) {
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingCommandRef = useRef(pendingCommand);
  const onCommandSubmittedRef = useRef(onCommandSubmitted);
  const onCommandOutputRef = useRef(onCommandOutput);
  const submittedCommandIdsRef = useRef(new Set<string>());
  const commandCaptureRef = useRef<CommandCapture | null>(null);
  const [status, setStatus] = useState('正在启动…');
  pendingCommandRef.current = pendingCommand;
  onCommandSubmittedRef.current = onCommandSubmitted;
  onCommandOutputRef.current = onCommandOutput;

  const appendCapturedOutput = (capture: CommandCapture, value: string) => {
    if (!value) return;
    const remaining = maxCapturedOutput - capture.output.length;
    if (remaining <= 0) {
      capture.truncated = true;
      return;
    }
    capture.output += value.slice(0, remaining);
    if (value.length > remaining) capture.truncated = true;
  };

  const completeCommandCapture = (
    capture: CommandCapture,
    fallback: string,
  ) => {
    if (commandCaptureRef.current !== capture) return;
    commandCaptureRef.current = null;
    const completed = fallback === '执行完成（无输出）。';
    const output = stripAnsi(capture.output + (completed ? '' : capture.tail));
    const suffix = capture.truncated
      ? '\n[输出已截断，最多保留 60,000 个字符。]'
      : '';
    const result = output
      ? `${output}${suffix}${completed ? '' : `\n\n[${fallback}]`}`
      : fallback;
    void invoke('terminal_remove_script', { path: capture.scriptPath }).catch(
      () => undefined,
    );
    onCommandOutputRef.current(capture.id, result);
  };

  const consumeCommandOutput = (value: string) => {
    const capture = commandCaptureRef.current;
    if (!capture || !value) return;
    let remaining = value;
    if (!capture.started) {
      const combined = capture.beforeStart + remaining;
      const startIndex = combined.indexOf(capture.beginMarker);
      if (startIndex < 0) {
        capture.beforeStart = combined.slice(-(capture.beginMarker.length - 1));
        return;
      }
      capture.started = true;
      capture.beforeStart = '';
      remaining = combined.slice(startIndex + capture.beginMarker.length);
    }

    const combined = capture.tail + remaining;
    const endIndex = combined.indexOf(capture.endMarker);
    if (endIndex >= 0) {
      appendCapturedOutput(capture, combined.slice(0, endIndex));
      completeCommandCapture(capture, '执行完成（无输出）。');
      return;
    }
    const safeLength = Math.max(
      0,
      combined.length - capture.endMarker.length + 1,
    );
    appendCapturedOutput(capture, combined.slice(0, safeLength));
    capture.tail = combined.slice(safeLength);
  };

  const sendPendingCommandRef = useRef<(sessionId: string) => void>(() => {});
  sendPendingCommandRef.current = (sessionId) => {
    const request = pendingCommandRef.current;
    if (!request || submittedCommandIdsRef.current.has(request.id)) return;
    submittedCommandIdsRef.current.add(request.id);
    const command = request.source.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    void (async () => {
      let scriptPath: string | null = null;
      try {
        scriptPath = await invoke<string>('terminal_stage_script', {
          source: command,
        });
        if (
          sessionIdRef.current !== sessionId ||
          pendingCommandRef.current?.id !== request.id
        ) {
          void invoke('terminal_remove_script', { path: scriptPath }).catch(
            () => undefined,
          );
          return;
        }

        const safeId = request.id.replace(/[^A-Za-z0-9]/g, '');
        const beginMarker = `__SEAMIND_BEGIN_${safeId}__`;
        const endMarker = `__SEAMIND_END_${safeId}__`;
        const encodedBegin = toBase64(new TextEncoder().encode(beginMarker));
        const encodedEnd = toBase64(new TextEncoder().encode(endMarker));
        const quotedScriptPath = `'${scriptPath.replace(/'/g, "''")}'`;
        const runLine = `Write-Output ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedBegin}'))); try { $__seamind_script=[IO.File]::ReadAllText(${quotedScriptPath}); & ([ScriptBlock]::Create($__seamind_script)) 2>&1 | Out-String -Width 4096 } catch { Write-Output ($_ | Out-String) }; Remove-Variable __seamind_script -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ${quotedScriptPath} -Force -ErrorAction SilentlyContinue; Write-Output ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedEnd}')))`;
        const bytes = new TextEncoder().encode(`${runLine}\r`);
        commandCaptureRef.current = {
          id: request.id,
          scriptPath,
          beginMarker,
          endMarker,
          decoder: new TextDecoder(),
          beforeStart: '',
          tail: '',
          output: '',
          started: false,
          truncated: false,
        };
        await invoke('terminal_write', {
          sessionId,
          data: Array.from(bytes),
        });
        onCommandSubmittedRef.current(request.id);
      } catch (error) {
        submittedCommandIdsRef.current.delete(request.id);
        setStatus(error instanceof Error ? error.message : '命令发送失败');
        const capture = commandCaptureRef.current;
        if (capture?.id === request.id) {
          completeCommandCapture(
            capture,
            error instanceof Error
              ? `命令发送失败：${error.message}`
              : '命令发送失败。',
          );
        } else {
          if (scriptPath)
            void invoke('terminal_remove_script', { path: scriptPath }).catch(
              () => undefined,
            );
          onCommandOutputRef.current(
            request.id,
            error instanceof Error
              ? `命令发送失败：${error.message}`
              : '命令发送失败。',
          );
        }
        onCommandSubmittedRef.current(request.id);
      }
    })();
  };

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
          if (payload.sessionId === sessionId) {
            const bytes = Uint8Array.from(payload.data);
            terminal?.write(bytes);
            const capture = commandCaptureRef.current;
            if (capture)
              consumeCommandOutput(
                capture.decoder.decode(bytes, { stream: true }),
              );
          }
        },
      );
      const exitListener = await listen<TerminalExitEvent>(
        'seamind-terminal-exit',
        (event) => {
          if (active && event.payload.sessionId === sessionId) {
            setStatus('Shell 已退出');
            terminal?.writeln('\r\n[Shell 已退出]');
            const capture = commandCaptureRef.current;
            if (capture)
              window.setTimeout(() => {
                if (commandCaptureRef.current === capture)
                  completeCommandCapture(
                    capture,
                    'Shell 已退出，命令未返回完成标记。',
                  );
              }, 150);
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
      sessionIdRef.current = sessionId;
      if (!active) {
        void invoke('terminal_close', { sessionId }).catch(() => undefined);
        return;
      }
      setStatus(cwd || 'PowerShell');
      terminal.writeln(`Seamind terminal  ·  ${cwd || '默认工作目录'}`);
      pendingOutput.splice(0).forEach((data) => {
        terminal?.write(Uint8Array.from(data));
      });
      sendPendingCommandRef.current(sessionId);
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
      const request = pendingCommandRef.current;
      if (request) {
        onCommandSubmittedRef.current(request.id);
        onCommandOutputRef.current(
          request.id,
          `终端启动失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    return () => {
      active = false;
      sessionIdRef.current = null;
      resizeObserver?.disconnect();
      disposeInput?.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      terminal?.dispose();
      terminalRef.current = null;
      const capture = commandCaptureRef.current;
      if (capture)
        completeCommandCapture(capture, '终端已关闭，命令未返回完成标记。');
      if (sessionId)
        void invoke('terminal_close', { sessionId }).catch(() => undefined);
    };
  }, [cwd]);

  useEffect(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId && pendingCommand) sendPendingCommandRef.current(sessionId);
  }, [pendingCommand]);

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
