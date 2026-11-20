import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../app/app-storage';
import { attachStandardXtermAddons } from '../terminal/terminal-addons';
import { normalizeDisplayPath } from '../terminal/terminal-alacritty';
import { terminalApi } from '../terminal/terminal-api';
import {
  loadTerminalPreferences,
  onTerminalPreferencesChanged,
  saveTerminalPreferences,
} from '../terminal/terminal-preferences';
import { openStandaloneTerminalWindow } from '../terminal/terminal-window';

type AppTheme = Theme;

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

interface PendingTerminalCommand {
  id: string;
  language: string;
  source: string;
}

export interface PendingTerminalRawInput {
  id: string;
  text: string;
  execute?: boolean;
}

export interface TerminalPanelProps {
  cwd: string;
  theme: AppTheme;
  dock: 'bottom' | 'right';
  canDockRight: boolean;
  onToggleDock: () => void;
  pendingCommand: PendingTerminalCommand | null;
  pendingRawInput?: PendingTerminalRawInput | null;
  onCommandSubmitted: (id: string) => void;
  onCommandOutput: (id: string, output: string) => void;
  onRawInputSent?: (id: string) => void;
  onClose: () => void;
  title?: string;
  badge?: string;
  hideCliButtons?: boolean;
  hideDockButton?: boolean;
  noteText?: string;
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

async function copyTerminalText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-10000px';
    textarea.style.top = '0';
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

export default function TerminalPanel({
  cwd,
  theme,
  dock,
  canDockRight,
  onToggleDock,
  pendingCommand,
  pendingRawInput = null,
  onCommandSubmitted,
  onCommandOutput,
  onRawInputSent,
  onClose,
  title,
  badge,
  hideCliButtons = false,
  hideDockButton = false,
  noteText,
}: TerminalPanelProps) {
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCommandRef = useRef(pendingCommand);
  const pendingRawInputRef = useRef(pendingRawInput);
  const onCommandSubmittedRef = useRef(onCommandSubmitted);
  const onCommandOutputRef = useRef(onCommandOutput);
  const onRawInputSentRef = useRef(onRawInputSent);
  const submittedCommandIdsRef = useRef(new Set<string>());
  const submittedRawIdsRef = useRef(new Set<string>());
  const commandCaptureRef = useRef<CommandCapture | null>(null);
  const [status, setStatus] = useState('正在启动…');
  const [liveCwd, setLiveCwd] = useState(() => normalizeDisplayPath(cwd));
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [prefs, setPrefs] = useState(() => loadTerminalPreferences());
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  pendingCommandRef.current = pendingCommand;
  pendingRawInputRef.current = pendingRawInput;
  onCommandSubmittedRef.current = onCommandSubmitted;
  onCommandOutputRef.current = onCommandOutput;
  onRawInputSentRef.current = onRawInputSent;

  useEffect(() => {
    setLiveCwd(normalizeDisplayPath(cwd));
  }, [cwd]);

  useEffect(() => {
    return onTerminalPreferencesChanged(setPrefs);
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = prefs.fontSize;
    terminal.options.lineHeight = prefs.lineHeight;
    terminal.options.fontFamily = prefs.fontFamily;
    terminal.options.cursorStyle = prefs.cursorStyle;
    terminal.options.cursorBlink = prefs.cursorBlink;
    fitAddonRef.current?.fit();
  }, [prefs]);

  const queueTerminalWrite = (sessionId: string, data: number[]) => {
    const nextWrite = writeQueueRef.current.then(async () => {
      await terminalApi.write({ sessionId, data });
    });
    writeQueueRef.current = nextWrite.catch(() => undefined);
    return nextWrite;
  };

  const writeRawToSession = (
    sessionId: string,
    text: string,
    execute = false,
  ) => {
    const payload = execute ? `${text}\r` : text;
    const bytes = Array.from(new TextEncoder().encode(payload));
    void queueTerminalWrite(sessionId, bytes)
      .then(() => {
        terminalRef.current?.focus();
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : '输入失败');
      });
  };

  const sendPendingRawRef = useRef<(sessionId: string) => void>(() => {});
  sendPendingRawRef.current = (sessionId) => {
    const raw = pendingRawInputRef.current;
    if (!raw || submittedRawIdsRef.current.has(raw.id)) return;
    submittedRawIdsRef.current.add(raw.id);
    writeRawToSession(sessionId, raw.text, Boolean(raw.execute));
    onRawInputSentRef.current?.(raw.id);
  };

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
    void terminalApi
      .removeScript({ path: capture.scriptPath })
      .catch(() => undefined);
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
        scriptPath = await terminalApi.stageScript({
          source: command,
        });
        if (
          sessionIdRef.current !== sessionId ||
          pendingCommandRef.current?.id !== request.id
        ) {
          void terminalApi
            .removeScript({ path: scriptPath })
            .catch(() => undefined);
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
        await queueTerminalWrite(sessionId, Array.from(bytes));
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
            void terminalApi
              .removeScript({ path: scriptPath })
              .catch(() => undefined);
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
    let disposeSelection: { dispose: () => void } | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenCwd: (() => void) | null = null;
    let disposeAddons: (() => void) | null = null;
    let resizeTimer: number | null = null;
    let outputFrame: number | null = null;
    let outputChunks: Uint8Array[] = [];
    let queuedOutputBytes = 0;
    let omittedOutputBytes = 0;
    const maxQueuedOutputBytes = 2 * 1024 * 1024;
    const pendingOutput: { sessionId: string; data: Uint8Array }[] = [];
    let pendingOutputBytes = 0;

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
        const notice = '\r\n[输出繁忙，已省略 ' + omitted + ' 字节旧内容]\r\n';
        terminal.write(new TextEncoder().encode(notice));
        const capture = commandCaptureRef.current;
        if (capture) {
          capture.truncated = true;
          appendCapturedOutput(capture, notice);
        }
      }
      const batch = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        batch.set(chunk, offset);
        offset += chunk.byteLength;
      }
      terminal.write(batch);
      const capture = commandCaptureRef.current;
      if (capture)
        consumeCommandOutput(capture.decoder.decode(batch, { stream: true }));
    };

    const queueOutput = (data: number[] | Uint8Array) => {
      let chunk =
        data instanceof Uint8Array ? data.slice() : Uint8Array.from(data);
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

    const start = async () => {
      const outputListener = await listen<TerminalOutputEvent>(
        'seamind-terminal-output',
        (event) => {
          const payload = event.payload;
          if (!active) return;
          if (!sessionId) {
            const data = Uint8Array.from(payload.data);
            pendingOutput.push({ sessionId: payload.sessionId, data });
            pendingOutputBytes += data.byteLength;
            while (
              pendingOutputBytes > maxQueuedOutputBytes &&
              pendingOutput.length > 0
            ) {
              const removed = pendingOutput.shift();
              if (removed) pendingOutputBytes -= removed.data.byteLength;
            }
            return;
          }
          if (payload.sessionId === sessionId) {
            queueOutput(payload.data);
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
      const cwdListener = await listen<TerminalCwdEvent>(
        'seamind-terminal-cwd',
        (event) => {
          if (active && event.payload.sessionId === sessionId) {
            const cleaned = normalizeDisplayPath(event.payload.cwd);
            if (cleaned) {
              setLiveCwd(cleaned);
              setStatus(cleaned);
            }
          }
        },
      );
      if (!active) {
        outputListener();
        exitListener();
        cwdListener();
        return;
      }
      unlistenOutput = outputListener;
      unlistenExit = exitListener;
      unlistenCwd = cwdListener;

      const initPrefs = prefsRef.current;
      terminal = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: initPrefs.cursorBlink,
        cursorStyle: initPrefs.cursorStyle,
        fontFamily: initPrefs.fontFamily,
        fontSize: initPrefs.fontSize,
        lineHeight: initPrefs.lineHeight,
        scrollback: initPrefs.scrollback,
        theme: terminalTheme(theme),
      });
      terminalRef.current = terminal;
      disposeSelection = terminal.onSelectionChange(() => {
        if (!prefsRef.current.saveOnSelect || !terminal?.hasSelection()) return;
        void copyTerminalText(terminal.getSelection());
      });
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const lower = event.key.toLowerCase();
        if (event.ctrlKey && event.shiftKey && lower === 'f') {
          event.preventDefault();
          event.stopPropagation();
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
          return false;
        }
        if (
          event.ctrlKey &&
          !event.altKey &&
          (event.key === '=' || event.key === '+')
        ) {
          event.preventDefault();
          saveTerminalPreferences({ fontSize: prefsRef.current.fontSize + 1 });
          return false;
        }
        if (event.ctrlKey && !event.altKey && event.key === '-') {
          event.preventDefault();
          saveTerminalPreferences({ fontSize: prefsRef.current.fontSize - 1 });
          return false;
        }
        if (event.ctrlKey && !event.altKey && event.key === '0') {
          event.preventDefault();
          saveTerminalPreferences({ fontSize: 13 });
          return false;
        }
        const isCopyShortcut =
          (event.ctrlKey || event.metaKey) && !event.shiftKey && lower === 'c';
        if (!isCopyShortcut || event.repeat || !terminal?.hasSelection()) {
          return true;
        }

        event.preventDefault();
        event.stopPropagation();
        void copyTerminalText(terminal.getSelection()).then((copied) => {
          if (!copied && active) setStatus('复制失败，请再试一次');
        });
        return false;
      });
      terminal.open(host);
      const attached = attachStandardXtermAddons(terminal, {
        webglEnabled: initPrefs.webglEnabled,
      });
      fitAddon = attached.fitAddon;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = attached.searchAddon;
      disposeAddons = attached.dispose;
      fitAddon.fit();

      const applyResize = () => {
        if (!active || !terminal || !fitAddon) return;
        try {
          fitAddon.fit();
          if (sessionId)
            void terminalApi
              .resize({
                sessionId,
                cols: terminal.cols,
                rows: terminal.rows,
                pixelWidth: Math.max(0, Math.round(host.clientWidth)),
                pixelHeight: Math.max(0, Math.round(host.clientHeight)),
              })
              .catch(() => undefined);
        } catch {
          // The terminal can briefly have a zero-sized host during layout.
        }
      };
      const scheduleResize = () => {
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          resizeTimer = null;
          requestAnimationFrame(applyResize);
        }, 64);
      };
      resizeObserver = new ResizeObserver(scheduleResize);
      resizeObserver.observe(host);

      const cleanCwd = normalizeDisplayPath(cwd);
      sessionId = await terminalApi.start({
        cwd: cleanCwd,
        cols: terminal.cols,
        rows: terminal.rows,
        pixelWidth: Math.max(0, Math.round(host.clientWidth)),
        pixelHeight: Math.max(0, Math.round(host.clientHeight)),
      });
      sessionIdRef.current = sessionId;
      if (!active) {
        void terminalApi.close({ sessionId }).catch(() => undefined);
        return;
      }
      setStatus(cleanCwd || 'PowerShell');
      terminal.writeln(`Seamind terminal  ·  ${cleanCwd || '默认工作目录'}`);
      pendingOutput.splice(0).forEach((event) => {
        pendingOutputBytes -= event.data.byteLength;
        if (event.sessionId === sessionId) queueOutput(event.data);
      });
      sendPendingCommandRef.current(sessionId);
      sendPendingRawRef.current(sessionId);
      disposeInput = terminal.onData((data) => {
        if (!sessionId) return;
        const bytes = Array.from(new TextEncoder().encode(data));
        void queueTerminalWrite(sessionId, bytes).catch((error: unknown) => {
          if (active)
            setStatus(error instanceof Error ? error.message : '输入失败');
        });
      });
      scheduleResize();
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
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      if (outputFrame !== null) cancelAnimationFrame(outputFrame);
      outputChunks = [];
      pendingOutput.splice(0);
      queuedOutputBytes = 0;
      pendingOutputBytes = 0;
      disposeInput?.dispose();
      disposeSelection?.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      unlistenCwd?.();
      disposeAddons?.();
      searchAddonRef.current = null;
      fitAddonRef.current = null;
      terminal?.dispose();
      terminalRef.current = null;
      const capture = commandCaptureRef.current;
      if (capture)
        completeCommandCapture(capture, '终端已关闭，命令未返回完成标记。');
      if (sessionId)
        void terminalApi.close({ sessionId }).catch(() => undefined);
    };
  }, [cwd]);

  useEffect(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId && pendingCommand) sendPendingCommandRef.current(sessionId);
  }, [pendingCommand]);

  useEffect(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId && pendingRawInput) sendPendingRawRef.current(sessionId);
  }, [pendingRawInput]);

  const sendQuickCli = (cliCommand: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    writeRawToSession(sessionId, cliCommand, true);
  };

  const handlePopoutCli = (cli?: 'agy' | 'claude' | 'codex') => {
    void openStandaloneTerminalWindow({
      cwd: liveCwd || normalizeDisplayPath(cwd),
      shell: 'powershell',
      cli,
      theme,
    }).then((res) => {
      if (!res.ok && res.error) setStatus(res.error);
    });
  };

  return (
    <section className="seamind-terminal" aria-label="Seamind 终端">
      <header className="seamind-terminal-heading">
        <div>
          <strong>{title ?? '终端 · CLI'}</strong>
          {badge && <span className="seamind-terminal-badge">{badge}</span>}
          <span title={liveCwd || cwd}>{status}</span>
        </div>
        <div className="seamind-terminal-actions">
          {!hideDockButton && (
            <button
              type="button"
              onClick={onToggleDock}
              disabled={dock === 'bottom' && !canDockRight}
              title={
                dock === 'right'
                  ? '将终端移回底部'
                  : canDockRight
                    ? '将终端停靠到右侧与面板并行'
                    : '请在宽屏工作区使用侧边停靠'
              }
            >
              {dock === 'right' ? '移到底部' : '收至侧边'}
            </button>
          )}
          <button
            type="button"
            onClick={() => handlePopoutCli()}
            title="新开一个独立桌面终端窗口（支持多开对比运行模型）"
          >
            ↗ 多开窗
          </button>
          {!hideCliButtons && (
            <>
              <button
                type="button"
                onClick={() => sendQuickCli('agy')}
                title="在当前终端启动已接入 Seamind MCP 的 Google AGY CLI"
              >
                agy
              </button>
              <button
                type="button"
                onClick={() => sendQuickCli('claude')}
                title="在当前终端启动已接入 Seamind MCP 的 Claude Code"
              >
                claude
              </button>
              <button
                type="button"
                onClick={() => sendQuickCli('codex')}
                title="在当前终端启动已接入 Seamind MCP 的 Codex CLI"
              >
                codex
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setSearchOpen(true);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            title="搜索终端输出 (Ctrl+Shift+F)"
          >
            搜索
          </button>
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
      {searchOpen && (
        <div className="seamind-terminal-search-bar">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="搜索终端历史输出…"
            value={searchQuery}
            onChange={(e) => {
              const val = e.target.value;
              setSearchQuery(val);
              if (val) searchAddonRef.current?.findNext(val);
              else searchAddonRef.current?.clearDecorations();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchOpen(false);
                searchAddonRef.current?.clearDecorations();
                terminalRef.current?.focus();
              } else if (e.key === 'Enter') {
                if (e.shiftKey)
                  searchAddonRef.current?.findPrevious(searchQuery);
                else searchAddonRef.current?.findNext(searchQuery);
              }
            }}
          />
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findNext(searchQuery)}
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              searchAddonRef.current?.clearDecorations();
              terminalRef.current?.focus();
            }}
          >
            ×
          </button>
        </div>
      )}
      <div
        className="seamind-terminal-host"
        ref={terminalHostRef}
        title="选中终端文字后按 Ctrl+C 复制；Ctrl+Shift+F 搜索"
      />
      {noteText !== undefined ? (
        noteText ? (
          <div className="seamind-terminal-note">{noteText}</div>
        ) : null
      ) : (
        <div className="seamind-terminal-note">
          已自动注入 Seamind MCP 工具（导图 · 知识库 · 播放器学习路径 · 当前
          EPUB 章节 · RSS 原文与订阅）。可直接输入 <code>agy</code>、
          <code>claude</code> 或 <code>codex</code> 调用。
        </div>
      )}
    </section>
  );
}

function terminalTheme(theme: AppTheme) {
  if (theme === 'navy') {
    return {
      background: '#07101e',
      foreground: '#dce8f5',
      cursor: '#38bdf8',
      cursorAccent: '#07101e',
      selectionBackground: '#173b64',
      black: '#07101e',
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
  return theme === 'dark'
    ? {
        background: '#11171b',
        foreground: '#d7e0e4',
        cursor: '#e06d55',
        cursorAccent: '#11171b',
        selectionBackground: '#34434b',
        black: '#11171b',
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
      }
    : {
        background: '#ffffff',
        foreground: '#243039',
        cursor: '#d9664f',
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
