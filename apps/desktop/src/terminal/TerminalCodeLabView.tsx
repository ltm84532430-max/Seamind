import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { EditorState, Prec } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import type { Theme } from '../app/app-storage';
import { systemApi } from '../system/system-api';
import type {
  PythonWorkerRequest,
  PythonWorkerResponse,
  PythonWorkerVarSummary,
} from '../workbench/python.worker';
import { terminalApi, type PythonEnvInfo } from './terminal-api';
import {
  assembleCCellProgram,
  createStarterCodeLabCells,
  DEFAULT_C_PROLOGUE,
  DEFAULT_CPP_PROLOGUE,
  exportCodeLabToMarkdown,
  makeCodeLabCellId,
  parseIpynbJson,
  serializeIpynbJson,
  type CodeLabCell,
  type CodeLabOutputItem,
} from './terminal-codelab-model';
import {
  BookProseView,
  KatexOutputBlock,
  SafeSvgOutput,
  SandboxedHtmlTableFrame,
} from './TerminalRichContent';
import type {
  TerminalCodeLabLanguage,
  TerminalTab,
  TerminalWorkspaceBridge,
} from './terminal-types';

export interface TerminalCodeLabViewHandle {
  focus: () => void;
  insertAndRunCell: (
    language: TerminalCodeLabLanguage,
    source: string,
    autoRun?: boolean,
  ) => void;
  getScreenText: (maxLines?: number) => string;
  getLastErrorText: () => string;
}

interface TerminalCodeLabViewProps {
  tab: TerminalTab;
  theme: Theme;
  active: boolean;
  isFocused?: boolean;
  style?: React.CSSProperties;
  bridge?: TerminalWorkspaceBridge;
  onFocusPane?: () => void;
  onStatusChange?: (status: TerminalTab['status'], message?: string) => void;
  onSendToShellPane?: (command: string, execute?: boolean) => void;
  onSendToAgentPane?: (prompt: string) => void;
}

interface ReplHistoryEntry {
  id: string;
  code: string;
  language: TerminalCodeLabLanguage;
  ok: boolean;
  text: string;
  images?: string[];
  durationMs?: number;
}

function getLabCmTheme(theme: Theme) {
  const isDark = theme !== 'light';
  const bg =
    theme === 'navy'
      ? '#07101e'
      : theme === 'purple'
        ? '#0d0818'
        : theme === 'dark'
          ? '#11171b'
          : '#ffffff';
  const fg =
    theme === 'navy'
      ? '#dce8f5'
      : theme === 'purple'
        ? '#eee4fa'
        : theme === 'dark'
          ? '#d7e0e4'
          : '#1e2930';
  const gutterBg =
    theme === 'navy'
      ? '#081424'
      : theme === 'purple'
        ? '#130c22'
        : theme === 'dark'
          ? '#141b20'
          : '#f4f6f8';
  return EditorView.theme(
    {
      '&': {
        backgroundColor: bg,
        color: fg,
        fontSize: '12.5px',
        fontFamily: 'var(--mono, "JetBrains Mono", Consolas, monospace)',
      },
      '.cm-content': {
        caretColor: fg,
        padding: '8px 0',
      },
      '.cm-gutters': {
        backgroundColor: gutterBg,
        color: '#6b7d8b',
        borderRight: '1px solid var(--term-border)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
    },
    { dark: isDark },
  );
}

function CodeLabCellEditor({
  value,
  language,
  kind,
  theme,
  shouldFocus,
  onChange,
  onFocus,
  onBlur,
  onRunAndAdvance,
  onRunInPlace,
  onEscapeToCommandMode,
}: {
  value: string;
  language: TerminalCodeLabLanguage;
  kind: 'code' | 'markdown';
  theme: Theme;
  shouldFocus: boolean;
  onChange: (next: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  onRunAndAdvance: () => void;
  onRunInPlace: () => void;
  onEscapeToCommandMode: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacksRef = useRef({
    onChange,
    onFocus,
    onBlur,
    onRunAndAdvance,
    onRunInPlace,
    onEscapeToCommandMode,
  });
  callbacksRef.current = {
    onChange,
    onFocus,
    onBlur,
    onRunAndAdvance,
    onRunInPlace,
    onEscapeToCommandMode,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const langExt =
      kind === 'markdown'
        ? markdown()
        : language === 'python'
          ? python()
          : cpp();

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        history(),
        langExt,
        getLabCmTheme(theme),
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(event) {
              if (event.key === 'Enter' && event.shiftKey) {
                event.preventDefault();
                callbacksRef.current.onRunAndAdvance();
                return true;
              }
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                callbacksRef.current.onRunInPlace();
                return true;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                viewRef.current?.contentDOM.blur();
                callbacksRef.current.onEscapeToCommandMode();
                return true;
              }
              return false;
            },
            focus() {
              callbacksRef.current.onFocus();
              return false;
            },
            blur() {
              callbacksRef.current.onBlur();
              return false;
            },
          }),
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacksRef.current.onChange(update.state.doc.toString());
          }
        }),
        EditorState.tabSize.of(language === 'python' ? 4 : 4),
        // Preserve default keymaps cleanly
        EditorState.allowMultipleSelections.of(false),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Rebuild editor when language, cell kind, or theme changes; value updates sync below.
  }, [language, kind, theme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    if (shouldFocus) {
      requestAnimationFrame(() => {
        viewRef.current?.focus();
      });
    }
  }, [shouldFocus]);

  // Keep defaultKeymap/historyKeymap referenced to guarantee clean editing bundle
  void defaultKeymap;
  void historyKeymap;

  return <div ref={hostRef} className="codelab-cm-host" />;
}

export const TerminalCodeLabView = forwardRef<
  TerminalCodeLabViewHandle,
  TerminalCodeLabViewProps
>(function TerminalCodeLabView(
  {
    tab,
    theme,
    active,
    isFocused = false,
    style,
    bridge,
    onFocusPane,
    onStatusChange,
    onSendToShellPane,
    onSendToAgentPane,
  },
  ref,
) {
  const initialLang: TerminalCodeLabLanguage = tab.labLanguage ?? 'python';
  const [language, setLanguage] =
    useState<TerminalCodeLabLanguage>(initialLang);
  const [cells, setCells] = useState<CodeLabCell[]>(() =>
    createStarterCodeLabCells(initialLang),
  );
  const [focusedCellId, setFocusedCellId] = useState<string>(
    () => cells[1]?.id ?? cells[0]?.id ?? '',
  );
  const [interactionMode, setInteractionMode] = useState<'command' | 'edit'>(
    'edit',
  );
  const [editingCellId, setEditingCellId] = useState<string | null>(
    () => cells[1]?.id ?? null,
  );
  const [showPrologue, setShowPrologue] = useState(initialLang !== 'python');
  const [prologueSource, setPrologueSource] = useState(() =>
    initialLang === 'cpp' ? DEFAULT_CPP_PROLOGUE : DEFAULT_C_PROLOGUE,
  );

  // Python Kernels: 'pyodide' or local pythonPath
  const [pythonEnvs, setPythonEnvs] = useState<PythonEnvInfo[]>([]);
  const [selectedPyRuntime, setSelectedPyRuntime] = useState<string>('pyodide');
  const [localKernelId, setLocalKernelId] = useState<string | null>(null);
  const [variables, setVariables] = useState<PythonWorkerVarSummary[]>([]);
  const [showVars, setShowVars] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [zoomedImageSrc, setZoomedImageSrc] = useState<string | null>(null);

  // C/C++ compiler status
  const [cCompilerReady, setCCompilerReady] = useState<boolean | null>(null);
  const [cCompilerError, setCCompilerError] = useState<string>('');

  // Bottom Euporie-style quick console REPL
  const [replInput, setReplInput] = useState('');
  const [replBusy, setReplBusy] = useState(false);
  const [replHistory, setReplHistory] = useState<ReplHistoryEntry[]>([]);
  const [notice, setNotice] = useState('');

  const execCounterRef = useRef(0);
  const pyodideWorkerRef = useRef<Worker | null>(null);
  const workerPendingRef = useRef<
    Map<
      string,
      {
        resolve: (res: PythonWorkerResponse) => void;
        reject: (err: Error) => void;
      }
    >
  >(new Map());
  const localKernelIdRef = useRef<string | null>(null);
  localKernelIdRef.current = localKernelId;
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const lastDKeyTimeRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const rootContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showExportMenu) return;
    const onDown = (e: MouseEvent) => {
      if (
        exportMenuRef.current &&
        e.target instanceof Node &&
        !exportMenuRef.current.contains(e.target)
      ) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showExportMenu]);

  const showTempNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => {
      setNotice((curr) => (curr === msg ? '' : curr));
    }, 2400);
  }, []);

  useEffect(() => {
    onStatusChange?.('ready', 'Euporie 实验本就绪');
  }, [onStatusChange]);

  useEffect(() => {
    if (!active) return;
    terminalApi
      .detectPythonEnvs({ cwd: tab.cwd || null })
      .then((envs) => setPythonEnvs(envs))
      .catch(() => setPythonEnvs([]));

    systemApi
      .checkCEnvironment()
      .then((res) => {
        setCCompilerReady(res.available);
        setCCompilerError(res.error ?? '');
      })
      .catch(() => setCCompilerReady(false));
  }, [active, tab.cwd]);

  // Terminate worker + close Rust kernel cleanly on unmount
  useEffect(() => {
    const pending = workerPendingRef.current;
    return () => {
      if (pyodideWorkerRef.current) {
        pyodideWorkerRef.current.terminate();
        pyodideWorkerRef.current = null;
      }
      for (const [, waiter] of pending) {
        waiter.reject(new Error('实验本标签已关闭'));
      }
      pending.clear();
      if (localKernelIdRef.current) {
        void terminalApi
          .closePythonKernel({ kernelId: localKernelIdRef.current })
          .catch(() => undefined);
      }
    };
  }, []);

  const ensurePyodideWorker = useCallback(() => {
    if (pyodideWorkerRef.current) return pyodideWorkerRef.current;
    const worker = new Worker(
      new URL('../workbench/python.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (event: MessageEvent<PythonWorkerResponse>) => {
      const reqId = event.data.requestId;
      if (!reqId) return;
      const waiter = workerPendingRef.current.get(reqId);
      if (!waiter) return;
      workerPendingRef.current.delete(reqId);
      if (event.data.type === 'error') {
        waiter.resolve(event.data);
      } else {
        waiter.resolve(event.data);
      }
    };
    worker.onerror = (event) => {
      for (const [id, waiter] of workerPendingRef.current) {
        waiter.reject(new Error(event.message || 'Pyodide Worker 崩溃'));
        workerPendingRef.current.delete(id);
      }
      pyodideWorkerRef.current = null;
    };
    pyodideWorkerRef.current = worker;
    return worker;
  }, []);

  const runWorkerRequest = useCallback(
    (action: 'exec' | 'reset' | 'vars', source: string) =>
      new Promise<PythonWorkerResponse>((resolve, reject) => {
        const worker = ensurePyodideWorker();
        const requestId = `pyw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const timer = window.setTimeout(() => {
          workerPendingRef.current.delete(requestId);
          worker.terminate();
          pyodideWorkerRef.current = null;
          reject(new Error('Pyodide 执行超过 25 秒超时，Worker 已重置。'));
        }, 25_000);
        workerPendingRef.current.set(requestId, {
          resolve: (res) => {
            window.clearTimeout(timer);
            resolve(res);
          },
          reject: (err) => {
            window.clearTimeout(timer);
            reject(err);
          },
        });
        const indexURL = new URL('pyodide/', document.baseURI).href;
        const moduleURL = new URL('pyodide/pyodide.mjs', document.baseURI).href;
        const payload: PythonWorkerRequest = {
          requestId,
          action,
          source,
          indexURL,
          moduleURL,
        };
        worker.postMessage(payload);
      }),
    [ensurePyodideWorker],
  );

  const ensureLocalPythonKernel = useCallback(async (): Promise<string> => {
    if (localKernelIdRef.current) return localKernelIdRef.current;
    const kernelId = await terminalApi.startPythonKernel({
      pythonPath: selectedPyRuntime === 'pyodide' ? null : selectedPyRuntime,
      cwd: tab.cwd || null,
    });
    localKernelIdRef.current = kernelId;
    setLocalKernelId(kernelId);
    return kernelId;
  }, [selectedPyRuntime, tab.cwd]);

  const executePythonSnippet = useCallback(
    async (
      code: string,
    ): Promise<{
      ok: boolean;
      outputs: CodeLabOutputItem[];
      durationMs: number;
      vars: PythonWorkerVarSummary[];
      plainError: string;
    }> => {
      const started = performance.now();
      const outputs: CodeLabOutputItem[] = [];
      let vars: PythonWorkerVarSummary[] = [];
      let plainError = '';
      let ok = true;

      if (selectedPyRuntime === 'pyodide') {
        const res = await runWorkerRequest('exec', code);
        if (res.output?.trim()) {
          outputs.push({ kind: 'stream', name: 'stdout', text: res.output });
        }
        if (res.stderr?.trim()) {
          outputs.push({ kind: 'stream', name: 'stderr', text: res.stderr });
        }
        for (const img of res.images ?? []) {
          outputs.push({ kind: 'image/png', dataUrl: img });
        }
        for (const svg of res.svgs ?? []) {
          outputs.push({ kind: 'image/svg+xml', svg });
        }
        for (const html of res.htmls ?? []) {
          outputs.push({ kind: 'text/html', html });
        }
        for (const latex of res.latexes ?? []) {
          outputs.push({ kind: 'text/latex', latex });
        }
        if (
          res.resultText?.trim() &&
          (res.htmls?.length ?? 0) === 0 &&
          (res.svgs?.length ?? 0) === 0 &&
          (res.images?.length ?? 0) === 0
        ) {
          outputs.push({ kind: 'text', text: res.resultText });
        }
        if (res.type === 'error' || res.error) {
          ok = false;
          plainError = res.error || 'Python 执行失败';
          outputs.push({ kind: 'error', message: plainError });
        }
        vars = res.variables ?? [];
      } else {
        const kernelId = await ensureLocalPythonKernel();
        const res = await terminalApi.evalPythonKernel({ kernelId, code });
        if (res.stdout.trim()) {
          outputs.push({ kind: 'stream', name: 'stdout', text: res.stdout });
        }
        if (res.stderr.trim()) {
          outputs.push({ kind: 'stream', name: 'stderr', text: res.stderr });
        }
        for (const img of res.images) {
          outputs.push({ kind: 'image/png', dataUrl: img });
        }
        for (const svg of res.svgs) {
          outputs.push({ kind: 'image/svg+xml', svg });
        }
        for (const html of res.htmls) {
          outputs.push({ kind: 'text/html', html });
        }
        for (const latex of res.latexes) {
          outputs.push({ kind: 'text/latex', latex });
        }
        if (
          res.resultText.trim() &&
          res.htmls.length === 0 &&
          res.svgs.length === 0 &&
          res.images.length === 0
        ) {
          outputs.push({ kind: 'text', text: res.resultText });
        }
        if (!res.ok || res.error) {
          ok = false;
          plainError = res.error || res.stderr || '本地 Python 内核报错';
          outputs.push({ kind: 'error', message: plainError });
        }
        vars = res.variables;
      }

      return {
        ok,
        outputs,
        durationMs: Math.round(performance.now() - started),
        vars,
        plainError,
      };
    },
    [ensureLocalPythonKernel, runWorkerRequest, selectedPyRuntime],
  );

  const runCellById = useCallback(
    async (cellId: string, advance = false) => {
      const targetIndex = cellsRef.current.findIndex((c) => c.id === cellId);
      if (targetIndex < 0) return;
      const cell = cellsRef.current[targetIndex];

      if (cell.kind === 'markdown') {
        setEditingCellId((curr) => (curr === cellId ? null : curr));
        if (advance) {
          const next = cellsRef.current[targetIndex + 1];
          if (next) setFocusedCellId(next.id);
        }
        return;
      }

      execCounterRef.current += 1;
      const runNumber = execCounterRef.current;

      setCells((prev) =>
        prev.map((item) =>
          item.id === cellId ? { ...item, status: 'running' } : item,
        ),
      );
      onStatusChange?.('starting', `正在执行格 [${runNumber}]`);

      try {
        if (cell.language === 'python') {
          const res = await executePythonSnippet(cell.source);
          setVariables(res.vars);
          setCells((prev) =>
            prev.map((item) =>
              item.id === cellId
                ? {
                    ...item,
                    executionCount: runNumber,
                    status: res.ok ? 'success' : 'error',
                    outputs: res.outputs,
                    durationMs: res.durationMs,
                  }
                : item,
            ),
          );
          onStatusChange?.(
            res.ok ? 'ready' : 'error',
            res.ok
              ? `Python [${runNumber}] · ${res.durationMs}ms`
              : 'Python 运行出错',
          );
        } else {
          const isCpp = cell.language === 'cpp';
          const assembled = assembleCCellProgram(
            prologueSource,
            cell.source,
            isCpp,
          );
          const res = await systemApi.runCCode({
            source: assembled,
            stdinInput: cell.stdinInput ? cell.stdinInput : null,
            isCpp,
          });
          const outputs: CodeLabOutputItem[] = [];
          if (res.stdout.trim()) {
            outputs.push({ kind: 'stream', name: 'stdout', text: res.stdout });
          }
          if (res.stderr.trim()) {
            if (res.success) {
              outputs.push({
                kind: 'stream',
                name: 'stderr',
                text: res.stderr,
              });
            } else {
              outputs.push({ kind: 'error', message: res.stderr });
            }
          }
          if (!res.success && !res.stderr.trim()) {
            outputs.push({
              kind: 'error',
              message: `${res.stage} 失败，退出码: ${res.exitCode ?? 'unknown'}`,
            });
          }
          setCells((prev) =>
            prev.map((item) =>
              item.id === cellId
                ? {
                    ...item,
                    executionCount: runNumber,
                    status: res.success ? 'success' : 'error',
                    outputs,
                    durationMs: res.durationMs,
                    stage: res.stage,
                    exitCode: res.exitCode ?? null,
                  }
                : item,
            ),
          );
          onStatusChange?.(
            res.success ? 'ready' : 'error',
            `${isCpp ? 'C++' : 'C'} [${runNumber}] · ${res.durationMs}ms`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setCells((prev) =>
          prev.map((item) =>
            item.id === cellId
              ? {
                  ...item,
                  executionCount: runNumber,
                  status: 'error',
                  outputs: [{ kind: 'error', message: msg }],
                }
              : item,
          ),
        );
        onStatusChange?.('error', msg);
      }

      if (advance) {
        const snapshot = cellsRef.current;
        const nextCell = snapshot[targetIndex + 1];
        if (nextCell) {
          setFocusedCellId(nextCell.id);
          if (nextCell.kind === 'code') {
            setEditingCellId(nextCell.id);
          }
        } else {
          const added: CodeLabCell = {
            id: makeCodeLabCellId(),
            kind: 'code',
            language: cell.language,
            source: '',
            stdinInput: '',
            executionCount: null,
            status: 'idle',
            outputs: [],
          };
          setCells((prev) => [...prev, added]);
          setFocusedCellId(added.id);
          setEditingCellId(added.id);
        }
      }
    },
    [executePythonSnippet, onStatusChange, prologueSource],
  );

  const insertCell = useCallback(
    (
      relative: 'above' | 'below',
      kind: 'code' | 'markdown' = 'code',
      overrideLang?: TerminalCodeLabLanguage,
    ) => {
      const idx = cellsRef.current.findIndex((c) => c.id === focusedCellId);
      const insertAt =
        idx < 0
          ? cellsRef.current.length
          : relative === 'above'
            ? idx
            : idx + 1;
      const newCell: CodeLabCell = {
        id: makeCodeLabCellId(),
        kind,
        language: overrideLang ?? language,
        source: '',
        stdinInput: '',
        executionCount: null,
        status: 'idle',
        outputs: [],
      };
      setCells((prev) => [
        ...prev.slice(0, insertAt),
        newCell,
        ...prev.slice(insertAt),
      ]);
      setFocusedCellId(newCell.id);
      setEditingCellId(newCell.id);
      setInteractionMode('edit');
    },
    [focusedCellId, language],
  );

  const deleteCellById = useCallback((id: string) => {
    setCells((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((c) => c.id === id);
      const next = prev.filter((c) => c.id !== id);
      const nextFocus = next[Math.max(0, Math.min(idx, next.length - 1))];
      if (nextFocus) setFocusedCellId(nextFocus.id);
      return next;
    });
  }, []);

  const handleResetPythonKernel = useCallback(async () => {
    try {
      if (selectedPyRuntime === 'pyodide') {
        await runWorkerRequest('reset', '');
      } else if (localKernelIdRef.current) {
        await terminalApi.resetPythonKernel({
          kernelId: localKernelIdRef.current,
        });
      }
      setVariables([]);
      showTempNotice('Python 内核变量空间已清空重置');
    } catch (err) {
      showTempNotice(err instanceof Error ? err.message : '内核重置失败');
    }
  }, [runWorkerRequest, selectedPyRuntime, showTempNotice]);

  const handleSwitchPythonRuntime = useCallback(
    async (nextRuntime: string) => {
      if (nextRuntime === selectedPyRuntime) return;
      if (localKernelIdRef.current) {
        const oldId = localKernelIdRef.current;
        localKernelIdRef.current = null;
        setLocalKernelId(null);
        await terminalApi
          .closePythonKernel({ kernelId: oldId })
          .catch(() => undefined);
      }
      setSelectedPyRuntime(nextRuntime);
      setVariables([]);
      showTempNotice(
        nextRuntime === 'pyodide'
          ? '已切换到 Pyodide WebAssembly 沙盒内核'
          : '已切换本地 Python / Conda 内核（下次运行自动拉起）',
      );
    },
    [selectedPyRuntime, showTempNotice],
  );

  const handleSendCellToShell = useCallback(
    async (cell: CodeLabCell) => {
      if (cell.language === 'python') {
        const stagedPath = await terminalApi
          .stageScript({ source: cell.source })
          .catch(() => null);
        const cmd =
          selectedPyRuntime !== 'pyodide'
            ? stagedPath
              ? `& '${selectedPyRuntime}' '${stagedPath}'`
              : `${selectedPyRuntime} -i`
            : stagedPath
              ? `python '${stagedPath}'`
              : 'python';
        onSendToShellPane?.(cmd, Boolean(stagedPath));
        return;
      }

      const isCpp = cell.language === 'cpp';
      const assembled = assembleCCellProgram(
        prologueSource,
        cell.source,
        isCpp,
      );
      try {
        const staged = await terminalApi.stageCSource({
          source: assembled,
          suggestedName: `lab_${cell.id.slice(-4)}`,
          workspaceRoot: tab.cwd || null,
          isCpp,
        });
        onSendToShellPane?.(staged.command, true);
        showTempNotice(`已编译并推入右侧终端：${staged.fileName}`);
      } catch (err) {
        showTempNotice(err instanceof Error ? err.message : '导出到终端失败');
      }
    },
    [
      onSendToShellPane,
      prologueSource,
      selectedPyRuntime,
      showTempNotice,
      tab.cwd,
    ],
  );

  const handleRunAll = useCallback(async () => {
    for (const cell of cellsRef.current) {
      if (cell.kind === 'code') {
        await runCellById(cell.id, false);
      }
    }
  }, [runCellById]);

  const handleRunQuickRepl = useCallback(async () => {
    const code = replInput.trim();
    if (!code || replBusy) return;
    setReplBusy(true);
    try {
      if (language === 'python') {
        const res = await executePythonSnippet(code);
        setVariables(res.vars);
        const lines: string[] = [];
        for (const o of res.outputs) {
          if (o.kind === 'stream' || o.kind === 'text')
            lines.push(o.text.trimEnd());
          if (o.kind === 'error') lines.push(o.message);
        }
        const images = res.outputs
          .filter(
            (o): o is Extract<CodeLabOutputItem, { kind: 'image/png' }> =>
              o.kind === 'image/png',
          )
          .map((o) => o.dataUrl);
        setReplHistory((prev) => [
          ...prev.slice(-14),
          {
            id: `repl-${Date.now()}`,
            code,
            language,
            ok: res.ok,
            text: lines.join('\n') || (res.ok ? '(ok)' : 'error'),
            images,
            durationMs: res.durationMs,
          },
        ]);
      } else {
        const isCpp = language === 'cpp';
        const assembled = assembleCCellProgram(prologueSource, code, isCpp);
        const res = await systemApi.runCCode({
          source: assembled,
          stdinInput: null,
          isCpp,
        });
        setReplHistory((prev) => [
          ...prev.slice(-14),
          {
            id: `repl-${Date.now()}`,
            code,
            language,
            ok: res.success,
            text:
              (res.success ? res.stdout : res.stderr) ||
              `exit ${res.exitCode ?? 0}`,
            durationMs: res.durationMs,
          },
        ]);
      }
      setReplInput('');
    } catch (err) {
      setReplHistory((prev) => [
        ...prev.slice(-14),
        {
          id: `repl-${Date.now()}`,
          code,
          language,
          ok: false,
          text: err instanceof Error ? err.message : String(err),
        },
      ]);
    } finally {
      setReplBusy(false);
    }
  }, [executePythonSnippet, language, prologueSource, replBusy, replInput]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        rootContainerRef.current?.focus();
      },
      insertAndRunCell: (lang, source, autoRun = true) => {
        setLanguage(lang);
        if (lang !== 'python') setShowPrologue(true);
        const newCell: CodeLabCell = {
          id: makeCodeLabCellId(),
          kind: 'code',
          language: lang,
          source,
          stdinInput: '',
          executionCount: null,
          status: 'idle',
          outputs: [],
        };
        setCells((prev) => [...prev, newCell]);
        setFocusedCellId(newCell.id);
        setEditingCellId(newCell.id);
        if (autoRun) {
          requestAnimationFrame(() => {
            void runCellById(newCell.id, false);
          });
        }
      },
      getScreenText: (maxLines = 80) => {
        const lines: string[] = [];
        for (const c of cellsRef.current) {
          if (c.kind === 'markdown') continue;
          lines.push(
            `[${c.language.toUpperCase()} In[${c.executionCount ?? ' '}]]:`,
          );
          lines.push(c.source);
          for (const out of c.outputs) {
            if (out.kind === 'stream' || out.kind === 'text') {
              lines.push(out.text);
            } else if (out.kind === 'error') {
              lines.push(`[ERROR] ${out.message}`);
            }
          }
        }
        const joined = lines.join('\n').split('\n');
        return joined.slice(-maxLines).join('\n');
      },
      getLastErrorText: () => {
        for (let i = cellsRef.current.length - 1; i >= 0; i -= 1) {
          const cell = cellsRef.current[i];
          const errOut = cell.outputs.find((o) => o.kind === 'error');
          if (errOut && errOut.kind === 'error') {
            return `语言: ${cell.language}\n代码:\n${cell.source}\n报错:\n${errOut.message}`;
          }
        }
        return '';
      },
    }),
    [runCellById],
  );

  // Euporie / Jupyter Command Mode hotkeys when focus is on container outside editors
  const handleContainerKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    if (interactionMode === 'edit') return;
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.closest('.cm-editor'))
    ) {
      return;
    }

    const idx = cells.findIndex((c) => c.id === focusedCellId);
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      const next = cells[Math.min(cells.length - 1, Math.max(0, idx + 1))];
      if (next) setFocusedCellId(next.id);
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      const prev = cells[Math.max(0, idx - 1)];
      if (prev) setFocusedCellId(prev.id);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      setInteractionMode('edit');
      setEditingCellId(focusedCellId);
    } else if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      void runCellById(focusedCellId, true);
    } else if (event.key === 'a') {
      event.preventDefault();
      insertCell('above', 'code');
    } else if (event.key === 'b') {
      event.preventDefault();
      insertCell('below', 'code');
    } else if (event.key === 'm') {
      event.preventDefault();
      setCells((prev) =>
        prev.map((c) =>
          c.id === focusedCellId ? { ...c, kind: 'markdown' } : c,
        ),
      );
    } else if (event.key === 'y') {
      event.preventDefault();
      setCells((prev) =>
        prev.map((c) => (c.id === focusedCellId ? { ...c, kind: 'code' } : c)),
      );
    } else if (event.key === 'd') {
      const now = Date.now();
      if (now - lastDKeyTimeRef.current < 450) {
        deleteCellById(focusedCellId);
        lastDKeyTimeRef.current = 0;
      } else {
        lastDKeyTimeRef.current = now;
      }
    }
  };

  const handleExportIpynb = () => {
    const content = serializeIpynbJson(cells, language, tab.title);
    const blob = new Blob([content], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tab.title.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.ipynb`;
    a.click();
    URL.revokeObjectURL(url);
    showTempNotice('已导出标准 .ipynb 文件');
  };

  const handleExportMarkdownNote = async () => {
    const md = exportCodeLabToMarkdown(tab.title, language, cells);
    if (bridge?.onSaveMarkdownNote) {
      const ok = await bridge.onSaveMarkdownNote({
        title: `${tab.title} 实验笔记`,
        category: '代码实验',
        source: md,
      });
      showTempNotice(ok ? '已写入 Seamind 知识库！' : '保存知识库失败');
    } else {
      await navigator.clipboard?.writeText(md);
      showTempNotice('已复制 Markdown 实验笔记到剪贴板');
    }
  };

  const activeEnvObj = useMemo(
    () => pythonEnvs.find((e) => e.pythonPath === selectedPyRuntime),
    [pythonEnvs, selectedPyRuntime],
  );

  return (
    <div
      ref={rootContainerRef}
      tabIndex={0}
      className={`codelab-root${active ? '' : ' is-hidden-pane'}${isFocused ? ' is-focused' : ''}`}
      style={style}
      onMouseDown={() => onFocusPane?.()}
      onKeyDown={handleContainerKeyDown}
    >
      {/* Euporie-Style Compact Top Notebook Toolbar */}
      <div className="codelab-toolbar">
        <div className="codelab-toolbar-group">
          <div className="codelab-lang-seg" role="group" aria-label="默认语言">
            {(['python', 'c', 'cpp'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                className={`codelab-seg-btn${language === lang ? ' is-active' : ''}`}
                onClick={() => {
                  setLanguage(lang);
                  if (lang !== 'python') {
                    setShowPrologue(true);
                    setPrologueSource(
                      lang === 'cpp'
                        ? DEFAULT_CPP_PROLOGUE
                        : DEFAULT_C_PROLOGUE,
                    );
                  }
                }}
              >
                {lang === 'python'
                  ? 'Python'
                  : lang === 'c'
                    ? 'C (GCC)'
                    : 'C++ (G++)'}
              </button>
            ))}
          </div>

          {language === 'python' ? (
            <select
              className="codelab-kernel-select"
              value={selectedPyRuntime}
              onChange={(e) => void handleSwitchPythonRuntime(e.target.value)}
              aria-label="选择 Python 内核环境"
            >
              <option value="pyodide">
                Pyodide · WebAssembly 沙盒（免配置）
              </option>
              {pythonEnvs.map((env) => {
                const pkgs = [
                  env.hasNumpy ? 'np' : '',
                  env.hasMatplotlib ? 'plt' : '',
                  env.hasPandas ? 'pd' : '',
                ]
                  .filter(Boolean)
                  .join('/');
                return (
                  <option key={env.id} value={env.pythonPath}>
                    {env.label}
                    {env.version ? ` v${env.version}` : ''}
                    {pkgs ? ` [${pkgs}]` : ''}
                  </option>
                );
              })}
            </select>
          ) : (
            <span
              className={`codelab-compiler-badge${cCompilerReady ? ' is-ok' : ' is-warn'}`}
              title={cCompilerError || '本地 GCC/G++ 编译链路就绪'}
            >
              {cCompilerReady === false ? '未检测到 GCC' : 'GCC/G++ 就绪'}
            </span>
          )}

          {activeEnvObj && (
            <span className="codelab-kernel-pill">
              {localKernelId ? '内核存活' : '按需拉起'}
            </span>
          )}
        </div>

        <div className="codelab-toolbar-group">
          <span
            className={`codelab-mode-badge is-${interactionMode}`}
            title="Esc 切入命令模式 (j/k 选格, a/b 插格, dd 删格); Enter 返回编辑"
          >
            {interactionMode === 'edit' ? 'EDIT' : 'COMMAND'}
          </span>

          <button
            type="button"
            className="codelab-tool-btn is-primary"
            onClick={() => void runCellById(focusedCellId, false)}
            title="运行当前格 (Ctrl+Enter)"
          >
            ▶ 运行
          </button>
          <button
            type="button"
            className="codelab-tool-btn"
            onClick={() => void handleRunAll()}
            title="顺序运行全部代码格"
          >
            ▶▶ 全部
          </button>
          <button
            type="button"
            className="codelab-tool-btn"
            onClick={() => insertCell('below', 'code')}
          >
            + 代码
          </button>
          <button
            type="button"
            className="codelab-tool-btn"
            onClick={() => insertCell('below', 'markdown')}
          >
            + 笔记
          </button>
          {language === 'python' ? (
            <>
              <button
                type="button"
                className="codelab-tool-btn"
                onClick={() => void handleResetPythonKernel()}
                title="清空 Python 全局变量并重置"
              >
                ↺ 重置
              </button>
              <button
                type="button"
                className={`codelab-tool-btn${showVars ? ' is-active' : ''}`}
                onClick={() => setShowVars((v) => !v)}
              >
                变量 ({variables.length})
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`codelab-tool-btn${showPrologue ? ' is-active' : ''}`}
              onClick={() => setShowPrologue((s) => !s)}
            >
              #include 前置
            </button>
          )}
          <div className="codelab-export-wrap" ref={exportMenuRef}>
            <button
              type="button"
              className={`codelab-tool-btn${showExportMenu ? ' is-active' : ''}`}
              onClick={() => setShowExportMenu((v) => !v)}
              aria-expanded={showExportMenu}
            >
              导出 / 笔记 ▾
            </button>
            {showExportMenu && (
              <div className="codelab-export-menu" role="menu">
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    fileInputRef.current?.click();
                  }}
                >
                  打开 / 导入 .ipynb
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    handleExportIpynb();
                  }}
                >
                  导出标准 .ipynb 文件
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowExportMenu(false);
                    void handleExportMarkdownNote();
                  }}
                >
                  保存为知识库 Markdown
                </button>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".ipynb,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                try {
                  const imported = parseIpynbJson(String(reader.result ?? ''));
                  setLanguage(imported.language);
                  setCells(imported.cells);
                  if (imported.cells[0]) setFocusedCellId(imported.cells[0].id);
                  showTempNotice(`已导入 ${imported.cells.length} 个实验格`);
                } catch {
                  showTempNotice('解析 .ipynb JSON 失败');
                }
              };
              reader.readAsText(file);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {notice && <div className="codelab-notice-strip">{notice}</div>}

      <div className="codelab-main-area">
        <div className="codelab-cells-scroll">
          {/* C/C++ Shared Prologue Header Strip */}
          {showPrologue && language !== 'python' && (
            <div className="codelab-prologue-box">
              <div className="codelab-prologue-head">
                <span>
                  SHARED PROLOGUE · {language === 'cpp' ? 'C++' : 'C'}{' '}
                  公共头文件 / 结构体与辅助函数（编译每格时自动前置合并）
                </span>
                <button
                  type="button"
                  className="codelab-mini-btn"
                  onClick={() => setShowPrologue(false)}
                >
                  收起
                </button>
              </div>
              <textarea
                className="codelab-prologue-input"
                rows={4}
                value={prologueSource}
                onChange={(e) => setPrologueSource(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}

          {/* Euporie Notebook Cells */}
          {cells.map((cell, index) => {
            const isCellFocused = cell.id === focusedCellId;
            const hasErr = cell.outputs.some((o) => o.kind === 'error');
            const isMarkdownPreview =
              cell.kind === 'markdown' && editingCellId !== cell.id;

            return (
              <div
                key={cell.id}
                className={`codelab-cell is-${cell.status}${isCellFocused ? ' is-cell-focused' : ''}`}
                onClick={() => {
                  setFocusedCellId(cell.id);
                }}
              >
                <div className="codelab-cell-gutter">
                  <span className="codelab-cell-prompt">
                    {cell.kind === 'markdown'
                      ? 'MD'
                      : cell.status === 'running'
                        ? '[*]'
                        : `[${cell.executionCount ?? ' '}]`}
                  </span>
                  <span className="codelab-cell-idx">#{index + 1}</span>
                </div>

                <div className="codelab-cell-body">
                  <div className="codelab-cell-bar">
                    <div className="codelab-cell-bar-left">
                      {cell.kind === 'code' ? (
                        <select
                          className="codelab-cell-lang-select"
                          value={cell.language}
                          onChange={(e) => {
                            const nextLang = e.target
                              .value as TerminalCodeLabLanguage;
                            setCells((prev) =>
                              prev.map((c) =>
                                c.id === cell.id
                                  ? { ...c, language: nextLang }
                                  : c,
                              ),
                            );
                          }}
                          aria-label="单元格语言"
                        >
                          <option value="python">Python</option>
                          <option value="c">C</option>
                          <option value="cpp">C++</option>
                        </select>
                      ) : (
                        <span className="codelab-cell-kind-tag">MARKDOWN</span>
                      )}
                      {cell.durationMs !== undefined && (
                        <span className="codelab-cell-meta">
                          {cell.stage ? `${cell.stage} · ` : ''}
                          {cell.durationMs}ms
                        </span>
                      )}
                    </div>

                    <div className="codelab-cell-actions">
                      {cell.kind === 'markdown' ? (
                        <button
                          type="button"
                          className="codelab-mini-btn"
                          onClick={() =>
                            setEditingCellId((curr) =>
                              curr === cell.id ? null : cell.id,
                            )
                          }
                        >
                          {editingCellId === cell.id ? '预览' : '编辑'}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="codelab-mini-btn is-run"
                            onClick={() => void runCellById(cell.id, false)}
                            disabled={cell.status === 'running'}
                          >
                            ▶ 运行
                          </button>
                          {onSendToShellPane && (
                            <button
                              type="button"
                              className="codelab-mini-btn"
                              onClick={() => void handleSendCellToShell(cell)}
                              title="保存文件并在右侧终端窗格交互运行 / GDB"
                            >
                              ↗ 终端运行
                            </button>
                          )}
                          {hasErr && onSendToAgentPane && (
                            <button
                              type="button"
                              className="codelab-mini-btn is-debug"
                              onClick={() => {
                                const err = cell.outputs.find(
                                  (o) => o.kind === 'error',
                                );
                                onSendToAgentPane(
                                  `/code 请诊断这段 ${cell.language.toUpperCase()} 代码的报错并给出修正：\n\`\`\`${cell.language}\n${cell.source}\n\`\`\`\n报错信息：\n${err && err.kind === 'error' ? err.message : ''}`,
                                );
                              }}
                            >
                              ⚡ Agent 排错
                            </button>
                          )}
                        </>
                      )}
                      {cells.length > 1 && (
                        <button
                          type="button"
                          className="codelab-mini-btn is-danger"
                          onClick={() => deleteCellById(cell.id)}
                          title="删除此格"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>

                  {isMarkdownPreview ? (
                    <div
                      className="codelab-md-preview"
                      onDoubleClick={() => {
                        setEditingCellId(cell.id);
                        setInteractionMode('edit');
                      }}
                    >
                      <BookProseView
                        content={cell.source || '*双击编辑笔记…*'}
                      />
                    </div>
                  ) : (
                    <CodeLabCellEditor
                      value={cell.source}
                      language={cell.language}
                      kind={cell.kind}
                      theme={theme}
                      shouldFocus={editingCellId === cell.id && isCellFocused}
                      onChange={(next) => {
                        setCells((prev) =>
                          prev.map((c) =>
                            c.id === cell.id ? { ...c, source: next } : c,
                          ),
                        );
                      }}
                      onFocus={() => {
                        setFocusedCellId(cell.id);
                        setEditingCellId(cell.id);
                        setInteractionMode('edit');
                      }}
                      onBlur={() => {
                        if (cell.kind === 'markdown') {
                          setEditingCellId((curr) =>
                            curr === cell.id ? null : curr,
                          );
                        }
                      }}
                      onRunAndAdvance={() => void runCellById(cell.id, true)}
                      onRunInPlace={() => void runCellById(cell.id, false)}
                      onEscapeToCommandMode={() => {
                        setInteractionMode('command');
                        if (cell.kind === 'markdown') setEditingCellId(null);
                        rootContainerRef.current?.focus();
                      }}
                    />
                  )}

                  {cell.kind === 'code' && cell.language !== 'python' && (
                    <div className="codelab-stdin-row">
                      <span className="codelab-stdin-label">stdin</span>
                      <input
                        type="text"
                        className="codelab-stdin-input"
                        value={cell.stdinInput}
                        onChange={(e) => {
                          const nextStdin = e.target.value;
                          setCells((prev) =>
                            prev.map((c) =>
                              c.id === cell.id
                                ? { ...c, stdinInput: nextStdin }
                                : c,
                            ),
                          );
                        }}
                        placeholder="可选：传递给 scanf / cin 的标准输入内容…"
                      />
                    </div>
                  )}

                  {cell.outputs.length > 0 && (
                    <div className="codelab-outputs">
                      {cell.outputs.map((out, oIdx) => {
                        if (out.kind === 'stream') {
                          return (
                            <pre
                              key={oIdx}
                              className={`codelab-stream is-${out.name}`}
                            >
                              {out.text}
                            </pre>
                          );
                        }
                        if (out.kind === 'text') {
                          return (
                            <pre key={oIdx} className="codelab-text-out">
                              {out.text}
                            </pre>
                          );
                        }
                        if (out.kind === 'image/png') {
                          return (
                            <div key={oIdx} className="codelab-image-wrap">
                              <img
                                src={out.dataUrl}
                                alt="实验绘图输出（点击放大）"
                                title="点击放大查看图表"
                                onClick={() => setZoomedImageSrc(out.dataUrl)}
                              />
                            </div>
                          );
                        }
                        if (out.kind === 'image/svg+xml') {
                          return <SafeSvgOutput key={oIdx} svg={out.svg} />;
                        }
                        if (out.kind === 'text/html') {
                          return (
                            <SandboxedHtmlTableFrame
                              key={oIdx}
                              html={out.html}
                            />
                          );
                        }
                        if (out.kind === 'text/latex') {
                          return (
                            <KatexOutputBlock key={oIdx} latex={out.latex} />
                          );
                        }
                        return (
                          <pre key={oIdx} className="codelab-error-out">
                            {out.message}
                          </pre>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Side Variable Inspector Drawer */}
        {showVars && language === 'python' && (
          <aside
            className="codelab-vars-panel"
            aria-label="Python 内存变量面板"
          >
            <div className="codelab-vars-header">
              <span>变量监视 ({variables.length})</span>
              <button
                type="button"
                className="codelab-mini-btn"
                onClick={() => setShowVars(false)}
              >
                ×
              </button>
            </div>
            <div className="codelab-vars-list">
              {variables.length === 0 ? (
                <div className="codelab-vars-empty">当前工作区尚无用户变量</div>
              ) : (
                variables.map((v) => (
                  <div key={v.name} className="codelab-var-row">
                    <div className="codelab-var-top">
                      <strong>{v.name}</strong>
                      <span className="codelab-var-type">{v.typeName}</span>
                    </div>
                    <div className="codelab-var-val">{v.preview}</div>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Euporie Console REPL Transcript + Quick Input Strip */}
      <div className="codelab-repl-dock">
        {replHistory.length > 0 && (
          <div className="codelab-repl-log">
            {replHistory.slice(-4).map((entry) => (
              <div
                key={entry.id}
                className={`codelab-repl-entry${entry.ok ? '' : ' is-err'}`}
              >
                <div className="codelab-repl-in">
                  <code>
                    {entry.language === 'python'
                      ? '>>> '
                      : `${entry.language}> `}
                    {entry.code}
                  </code>
                  {entry.durationMs !== undefined && (
                    <span>{entry.durationMs}ms</span>
                  )}
                </div>
                <pre className="codelab-repl-out">{entry.text}</pre>
                {entry.images?.map((src, idx) => (
                  <img
                    key={idx}
                    src={src}
                    alt="REPL 绘图"
                    className="codelab-repl-img"
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="codelab-repl-input-row">
          <span className="codelab-repl-prompt">
            {language === 'python' ? '>>>' : `${language}>`}
          </span>
          <input
            type="text"
            className="codelab-repl-input"
            value={replInput}
            onChange={(e) => setReplInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleRunQuickRepl();
              }
            }}
            placeholder={
              language === 'python'
                ? 'Euporie 快速求值控制台（共享上方全部变量）· Enter 运行'
                : `快速执行单行 ${language.toUpperCase()} 语句（共享头文件前置）· Enter 运行`
            }
          />
          <button
            type="button"
            className="codelab-tool-btn is-primary"
            disabled={replBusy || !replInput.trim()}
            onClick={() => void handleRunQuickRepl()}
          >
            {replBusy ? '运行中…' : '执行'}
          </button>
          {replHistory.length > 0 && (
            <button
              type="button"
              className="codelab-tool-btn"
              onClick={() => setReplHistory([])}
            >
              清屏
            </button>
          )}
        </div>
      </div>

      {/* Euporie Chart Lightbox */}
      {zoomedImageSrc && (
        <div
          className="codelab-lightbox-backdrop"
          onClick={() => setZoomedImageSrc(null)}
          role="dialog"
          aria-modal="true"
          aria-label="实验图表放大预览"
        >
          <div
            className="codelab-lightbox-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="codelab-lightbox-head">
              <span>实验图表大图预览</span>
              <button
                type="button"
                className="codelab-mini-btn"
                onClick={() => setZoomedImageSrc(null)}
              >
                × 关闭
              </button>
            </div>
            <img src={zoomedImageSrc} alt="实验图表放大预览" />
          </div>
        </div>
      )}
    </div>
  );
});
