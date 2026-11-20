import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { basicSetup, EditorView } from 'codemirror';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { markdown } from '@codemirror/lang-markdown';
import type { Theme } from '../app/app-storage';
import {
  LabCheckIcon,
  LabChevronDownIcon,
  LabCloseIcon,
  LabCopyIcon,
  LabPlayIcon,
  LabResetIcon,
  LabSaveIcon,
  LabSparkIcon,
  LabStopIcon,
  LabTerminalOutIcon,
  LabTrashIcon,
} from '../terminal/CodeLabIcons';
import {
  KatexOutputBlock,
  SafeSvgOutput,
  SandboxedHtmlTableFrame,
} from '../terminal/TerminalRichContent';
import type { PythonEnvInfo } from '../terminal/terminal-api';
import {
  formatDurationCompact,
  truncateOutputForDisplay,
} from '../terminal/terminal-codelab-model';
import {
  codeLanguageBadge,
  codeLanguageDisplayName,
  computeCodeBlockResultKey,
  detectCodeLanguageFromSource,
  detectMindmapPythonEnvs,
  executeMindmapCCode,
  executeMindmapPythonCode,
  getCodeBlockRunCapability,
  getPreferredMindmapPythonRuntime,
  interruptMindmapCodeExecution,
  normalizeCodeBlockLanguage,
  resetMindmapPythonKernel,
  setCachedCodeBlockResult,
  setPreferredMindmapPythonRuntime,
  type CodeExecutionResult,
} from '../workbench/code-execution-service';
import type {
  MindmapCodeBlockAgentRequest,
  MindmapCodeBlockFullscreenRequest,
} from '../workbench/mindmap-code-card';

const LANGUAGE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'python', label: 'Python' },
  { id: 'cpp', label: 'C++' },
  { id: 'c', label: 'C' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'sql', label: 'SQL' },
  { id: 'rust', label: 'Rust' },
  { id: 'go', label: 'Go' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'bash', label: 'Shell / Bash' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'text', label: 'Plain Code' },
];

const modalLangCompartment = new Compartment();
const modalThemeCompartment = new Compartment();

function getModalLanguageExtension(language: string) {
  const norm = normalizeCodeBlockLanguage(language);
  if (norm === 'python') return python();
  if (norm === 'c' || norm === 'cpp') return cpp();
  if (norm === 'markdown') return markdown();
  return [];
}

function getModalCmTheme(theme: Theme) {
  const palette =
    theme === 'navy'
      ? {
          bg: '#081120',
          fg: '#dce8f5',
          gutterBg: '#0a1526',
          gutterFg: '#567594',
          activeLine: 'rgba(104, 160, 224, 0.08)',
          selection: 'rgba(104, 160, 224, 0.22)',
          caret: '#68a0e0',
          dark: true,
        }
      : theme === 'purple'
        ? {
            bg: '#0f091c',
            fg: '#ede2fa',
            gutterBg: '#130c22',
            gutterFg: '#7e6399',
            activeLine: 'rgba(176, 128, 238, 0.09)',
            selection: 'rgba(176, 128, 238, 0.24)',
            caret: '#b680f0',
            dark: true,
          }
        : theme === 'dark'
          ? {
              bg: '#11161b',
              fg: '#d8e1e8',
              gutterBg: '#141a20',
              gutterFg: '#647480',
              activeLine: 'rgba(255, 255, 255, 0.04)',
              selection: 'rgba(229, 138, 98, 0.22)',
              caret: '#e58a62',
              dark: true,
            }
          : {
              bg: '#ffffff',
              fg: '#1f2933',
              gutterBg: '#f7f8fa',
              gutterFg: '#8c99a5',
              activeLine: 'rgba(25, 34, 41, 0.032)',
              selection: 'rgba(184, 86, 56, 0.14)',
              caret: '#b85638',
              dark: false,
            };

  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '13px',
        backgroundColor: palette.bg,
        color: palette.fg,
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily:
          "var(--mono, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace)",
        lineHeight: '1.6',
      },
      '.cm-content': {
        padding: '12px 0',
        caretColor: palette.caret,
      },
      '.cm-line': {
        padding: '0 14px',
      },
      '.cm-gutters': {
        backgroundColor: palette.gutterBg,
        color: palette.gutterFg,
        borderRight: '1px solid var(--line, rgba(128,128,128,0.16))',
        fontVariantNumeric: 'tabular-nums',
      },
      '.cm-activeLine': {
        backgroundColor: palette.activeLine,
      },
      '.cm-activeLineGutter': {
        backgroundColor: palette.activeLine,
      },
      '&.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: palette.selection,
      },
      '.cm-cursor': {
        borderLeftColor: palette.caret,
      },
    },
    { dark: palette.dark },
  );
}

interface MindmapCodeWorkbenchModalProps {
  request: MindmapCodeBlockFullscreenRequest;
  theme: Theme;
  cwd?: string | null;
  onClose: () => void;
  onSaveCode: (nextLanguage: string, nextSource: string) => boolean;
  onOpenInCodeLab?: (language: 'python' | 'c' | 'cpp', source: string) => void;
  onTerminalCommand?: (
    language: string,
    source: string,
    onResult: (output: string) => void,
  ) => void;
  onAskAgent?: (request: MindmapCodeBlockAgentRequest) => void;
}

export function MindmapCodeWorkbenchModal({
  request,
  theme,
  cwd,
  onClose,
  onSaveCode,
  onOpenInCodeLab,
  onTerminalCommand,
  onAskAgent,
}: MindmapCodeWorkbenchModalProps) {
  const [language, setLanguage] = useState<string>(() =>
    normalizeCodeBlockLanguage(request.language),
  );
  const [source, setSource] = useState<string>(() =>
    request.source.replace(/\r\n?/g, '\n').replace(/\n$/, ''),
  );
  const [savedSource, setSavedSource] = useState<string>(() =>
    request.source.replace(/\r\n?/g, '\n').replace(/\n$/, ''),
  );
  const [savedLanguage, setSavedLanguage] = useState<string>(() =>
    normalizeCodeBlockLanguage(request.language),
  );
  const [result, setResult] = useState<CodeExecutionResult | null>(
    request.initialResult,
  );
  const [running, setRunning] = useState(false);
  const [stdinInput, setStdinInput] = useState('');
  const [showStdin, setShowStdin] = useState(false);
  const [pythonEnvs, setPythonEnvs] = useState<PythonEnvInfo[]>([]);
  const [selectedPyRuntime, setSelectedPyRuntime] = useState<string>(() =>
    getPreferredMindmapPythonRuntime(),
  );
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [showRuntimeMenu, setShowRuntimeMenu] = useState(false);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [notice, setNotice] = useState('');
  const [expandedTextOutputs, setExpandedTextOutputs] = useState<
    Record<number, boolean>
  >({});
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);

  const editorHostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const languageRef = useRef(language);
  languageRef.current = language;
  const langMenuRef = useRef<HTMLDivElement>(null);
  const runtimeMenuRef = useRef<HTMLDivElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);

  const runCap = getCodeBlockRunCapability(language);
  const dirty = source !== savedSource || language !== savedLanguage;
  const lineCount = useMemo(() => source.split('\n').length, [source]);

  const showTempNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => {
      setNotice((curr) => (curr === msg ? '' : curr));
    }, 2200);
  }, []);

  // Probe local Python envs once lazily
  useEffect(() => {
    let cancelled = false;
    void detectMindmapPythonEnvs(cwd).then((envs) => {
      if (!cancelled) setPythonEnvs(envs);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Dismiss menus on outside mousedown
  useEffect(() => {
    if (!showLangMenu && !showRuntimeMenu && !showAgentMenu) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (!target) return;
      if (showLangMenu && !langMenuRef.current?.contains(target)) {
        setShowLangMenu(false);
      }
      if (showRuntimeMenu && !runtimeMenuRef.current?.contains(target)) {
        setShowRuntimeMenu(false);
      }
      if (showAgentMenu && !agentMenuRef.current?.contains(target)) {
        setShowAgentMenu(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showAgentMenu, showLangMenu, showRuntimeMenu]);

  const commitSave = useCallback(() => {
    const liveCode = viewRef.current?.state.doc.toString() ?? sourceRef.current;
    const liveLang = languageRef.current;
    const ok = onSaveCode(liveLang, liveCode);
    if (ok) {
      setSource(liveCode);
      setSavedSource(liveCode);
      setSavedLanguage(liveLang);
      if (result) {
        const nextKey = computeCodeBlockResultKey(
          liveLang,
          liveCode,
          request.sourceRange,
        );
        setCachedCodeBlockResult(nextKey, result);
      }
      showTempNotice('已保存并写回导图代码块');
    } else {
      showTempNotice('未检测到文本变化或无法定位原围栏');
    }
  }, [onSaveCode, request.sourceRange, result, showTempNotice]);

  const handleRun = useCallback(
    async (overrideRuntime?: string) => {
      const liveCode =
        viewRef.current?.state.doc.toString() ?? sourceRef.current;
      const liveLang = languageRef.current;
      const cap = getCodeBlockRunCapability(liveLang);
      if (!cap) return;

      if (running) {
        interruptMindmapCodeExecution();
        setRunning(false);
        return;
      }

      if (cap === 'shell') {
        if (!onTerminalCommand) return;
        setRunning(true);
        const started = performance.now();
        onTerminalCommand(liveLang, liveCode, (text) => {
          setRunning(false);
          const res: CodeExecutionResult = {
            ok: true,
            language: liveLang,
            runtimeLabel: liveLang === 'powershell' ? 'PowerShell' : 'Shell',
            outputs: [
              { kind: 'stream', name: 'stdout', text: text || '(执行完成)' },
            ],
            durationMs: Math.round(performance.now() - started),
            plainSummary: text || '(执行完成)',
            errorText: '',
            timestamp: Date.now(),
          };
          setResult(res);
          setCachedCodeBlockResult(request.resultKey, res);
        });
        return;
      }

      setRunning(true);
      setExpandedTextOutputs({});
      try {
        const res =
          cap === 'python'
            ? await executeMindmapPythonCode({
                source: liveCode,
                runtime: overrideRuntime ?? selectedPyRuntime,
                cwd,
              })
            : await executeMindmapCCode({
                source: liveCode,
                isCpp: cap === 'cpp',
                stdinInput,
              });
        setResult(res);
        setCachedCodeBlockResult(request.resultKey, res);
        const liveKey = computeCodeBlockResultKey(
          liveLang,
          liveCode,
          request.sourceRange,
        );
        if (liveKey !== request.resultKey) {
          setCachedCodeBlockResult(liveKey, res);
        }
      } finally {
        setRunning(false);
      }
    },
    [
      cwd,
      onTerminalCommand,
      request.resultKey,
      request.sourceRange,
      running,
      selectedPyRuntime,
      stdinInput,
    ],
  );

  const actionsRef = useRef({ handleRun, commitSave, onClose });
  actionsRef.current = { handleRun, commitSave, onClose };

  // Mount CodeMirror 6 editor once for the modal session
  useEffect(() => {
    const host = editorHostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: sourceRef.current,
      extensions: [
        basicSetup,
        modalLangCompartment.of(getModalLanguageExtension(languageRef.current)),
        modalThemeCompartment.of(getModalCmTheme(theme)),
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(event) {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                void actionsRef.current.handleRun();
                return true;
              }
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === 's'
              ) {
                event.preventDefault();
                actionsRef.current.commitSave();
                return true;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                actionsRef.current.onClose();
                return true;
              }
              return false;
            },
          }),
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setSource(update.state.doc.toString());
          }
        }),
        EditorState.tabSize.of(4),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    requestAnimationFrame(() => view.focus());
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: modalLangCompartment.reconfigure(
        getModalLanguageExtension(language),
      ),
    });
  }, [language]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: modalThemeCompartment.reconfigure(getModalCmTheme(theme)),
    });
  }, [theme]);

  // Global Esc shortcut when focus is outside CM6
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (zoomedImage) {
          setZoomedImage(null);
          return;
        }
        onClose();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        commitSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commitSave, onClose, zoomedImage]);

  const activeEnv = pythonEnvs.find((e) => e.pythonPath === selectedPyRuntime);

  const modal = (
    <div
      className="mm-code-modal-backdrop"
      data-theme={theme}
      role="dialog"
      aria-modal="true"
      aria-label="思维导图代码块全屏工作台"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mm-code-modal-shell">
        <header className="mm-code-modal-bar">
          <div className="mm-code-modal-bar-left">
            <span className="mm-code-modal-kicker">CODE WORKBENCH</span>

            <div className="mm-code-popover-wrap" ref={langMenuRef}>
              <button
                type="button"
                className="mm-code-bar-btn is-lang"
                onClick={() => setShowLangMenu((v) => !v)}
              >
                <span>{codeLanguageDisplayName(language)}</span>
                <LabChevronDownIcon size={10} />
              </button>
              {showLangMenu && (
                <div className="mm-code-popover-menu" role="menu">
                  {LANGUAGE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={language === opt.id ? 'is-active' : ''}
                      onClick={() => {
                        setLanguage(opt.id);
                        setShowLangMenu(false);
                      }}
                    >
                      <span>{opt.label}</span>
                      {language === opt.id && <LabCheckIcon size={11} />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <span className="mm-code-modal-meta">{lineCount} 行</span>
            {notice && <span className="mm-code-modal-notice">{notice}</span>}
          </div>

          <div className="mm-code-modal-bar-center">
            {runCap && (
              <button
                type="button"
                className={`mm-code-bar-btn ${running ? 'is-danger' : 'is-primary'}`}
                onClick={() => void handleRun()}
                title="运行代码 (Ctrl+Enter)"
              >
                {running ? (
                  <LabStopIcon size={11} />
                ) : (
                  <LabPlayIcon size={11} />
                )}
                <span>{running ? '停止' : '运行'}</span>
              </button>
            )}

            {runCap === 'python' && (
              <div className="mm-code-popover-wrap" ref={runtimeMenuRef}>
                <button
                  type="button"
                  className="mm-code-bar-btn"
                  onClick={() => setShowRuntimeMenu((v) => !v)}
                  title="切换 Python 运行时内核"
                >
                  <span
                    className={`mm-code-rt-dot${selectedPyRuntime === 'pyodide' ? '' : ' is-local'}`}
                  />
                  <span>
                    {selectedPyRuntime === 'pyodide'
                      ? 'Pyodide WASM'
                      : activeEnv?.label || 'Local Python'}
                  </span>
                  <LabChevronDownIcon size={10} />
                </button>
                {showRuntimeMenu && (
                  <div className="mm-code-popover-menu is-wide" role="menu">
                    <div className="mm-code-popover-head">Python 内核</div>
                    <button
                      type="button"
                      className={
                        selectedPyRuntime === 'pyodide' ? 'is-active' : ''
                      }
                      onClick={() => {
                        setSelectedPyRuntime('pyodide');
                        setPreferredMindmapPythonRuntime('pyodide');
                        setShowRuntimeMenu(false);
                      }}
                    >
                      <span>Pyodide · WebAssembly 沙盒</span>
                      {selectedPyRuntime === 'pyodide' && (
                        <LabCheckIcon size={11} />
                      )}
                    </button>
                    {pythonEnvs.map((env) => (
                      <button
                        key={env.id}
                        type="button"
                        className={
                          selectedPyRuntime === env.pythonPath
                            ? 'is-active'
                            : ''
                        }
                        onClick={() => {
                          setSelectedPyRuntime(env.pythonPath);
                          setPreferredMindmapPythonRuntime(env.pythonPath);
                          setShowRuntimeMenu(false);
                        }}
                      >
                        <span>
                          {env.label}
                          {env.version ? ` v${env.version}` : ''}
                        </span>
                        {selectedPyRuntime === env.pythonPath && (
                          <LabCheckIcon size={11} />
                        )}
                      </button>
                    ))}
                    <div className="mm-code-popover-sep" />
                    <button
                      type="button"
                      onClick={() => {
                        setShowRuntimeMenu(false);
                        void resetMindmapPythonKernel(selectedPyRuntime).then(
                          () => showTempNotice('Python 内核变量空间已重置'),
                        );
                      }}
                    >
                      <LabResetIcon size={11} />
                      <span>重置内核状态</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {(runCap === 'c' || runCap === 'cpp') && (
              <button
                type="button"
                className={`mm-code-bar-btn${showStdin ? ' is-active' : ''}`}
                onClick={() => setShowStdin((s) => !s)}
              >
                <span>stdin</span>
              </button>
            )}
          </div>

          <div className="mm-code-modal-bar-right">
            <button
              type="button"
              className="mm-code-bar-btn"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(viewRef.current?.state.doc.toString() ?? source)
                  .then(() => {
                    setCopiedCode(true);
                    window.setTimeout(() => setCopiedCode(false), 1200);
                  });
              }}
            >
              {copiedCode ? (
                <LabCheckIcon size={12} />
              ) : (
                <LabCopyIcon size={12} />
              )}
              <span>{copiedCode ? '已复制' : '复制'}</span>
            </button>

            {(runCap === 'python' || runCap === 'c' || runCap === 'cpp') &&
              onOpenInCodeLab && (
                <button
                  type="button"
                  className="mm-code-bar-btn"
                  onClick={() => {
                    onOpenInCodeLab(
                      runCap,
                      viewRef.current?.state.doc.toString() ?? source,
                    );
                    onClose();
                  }}
                  title="带入终端 Code Lab 继续多格实验"
                >
                  <LabTerminalOutIcon size={12} />
                  <span>终端 Lab</span>
                </button>
              )}

            {onAskAgent && (
              <div className="mm-code-popover-wrap" ref={agentMenuRef}>
                <button
                  type="button"
                  className="mm-code-bar-btn is-agent"
                  onClick={() => setShowAgentMenu((v) => !v)}
                >
                  <LabSparkIcon size={12} />
                  <span>问 Agent</span>
                  <LabChevronDownIcon size={10} />
                </button>
                {showAgentMenu && (
                  <div className="mm-code-popover-menu is-right" role="menu">
                    <button
                      type="button"
                      onClick={() => {
                        setShowAgentMenu(false);
                        onAskAgent({
                          intent: 'explain',
                          language,
                          source:
                            viewRef.current?.state.doc.toString() ?? source,
                          sourceRange: request.sourceRange,
                          nodePath: request.nodePath,
                          outputSummary: result?.plainSummary,
                          errorText: result?.errorText,
                        });
                        onClose();
                      }}
                    >
                      逐段解释这段代码逻辑
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAgentMenu(false);
                        onAskAgent({
                          intent: 'diagnose',
                          language,
                          source:
                            viewRef.current?.state.doc.toString() ?? source,
                          sourceRange: request.sourceRange,
                          nodePath: request.nodePath,
                          outputSummary: result?.plainSummary,
                          errorText: result?.errorText,
                        });
                        onClose();
                      }}
                    >
                      诊断运行报错并给出修正提案
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAgentMenu(false);
                        onAskAgent({
                          intent: 'refactor',
                          language,
                          source:
                            viewRef.current?.state.doc.toString() ?? source,
                          sourceRange: request.sourceRange,
                          nodePath: request.nodePath,
                          outputSummary: result?.plainSummary,
                          errorText: result?.errorText,
                        });
                        onClose();
                      }}
                    >
                      优化重构并提案写回导图
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              className={`mm-code-bar-btn${dirty ? ' is-primary' : ''}`}
              disabled={!dirty}
              onClick={commitSave}
              title="保存并写回导图 Markdown (Ctrl+S)"
            >
              <LabSaveIcon size={12} />
              <span>{dirty ? '保存写回' : '已同步'}</span>
            </button>

            <button
              type="button"
              className="mm-code-icon-close"
              onClick={onClose}
              aria-label="关闭全屏代码块"
              title="关闭 (Esc)"
            >
              <LabCloseIcon size={14} />
            </button>
          </div>
        </header>

        <div className="mm-code-modal-body">
          <div className="mm-code-modal-editor-pane">
            <div ref={editorHostRef} className="mm-code-modal-cm-host" />
          </div>

          <aside className="mm-code-modal-output-pane">
            <div className="mm-code-output-head">
              <span className="mm-code-output-title">
                {running
                  ? 'RUNNING…'
                  : result
                    ? `${result.ok ? 'OUTPUT' : 'ERROR'} · ${result.runtimeLabel}${result.durationMs ? ` · ${formatDurationCompact(result.durationMs)}` : ''}`
                    : runCap
                      ? `CONSOLE · ${codeLanguageBadge(language)}`
                      : 'PREVIEW METADATA'}
              </span>
              {result && (
                <div className="mm-code-output-actions">
                  <button
                    type="button"
                    className="mm-code-mini-btn"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(result.plainSummary)
                        .then(() => showTempNotice('已复制运行输出'));
                    }}
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    className="mm-code-mini-btn"
                    onClick={() => {
                      setResult(null);
                      setCachedCodeBlockResult(request.resultKey, null);
                    }}
                    title="清空输出"
                  >
                    <LabTrashIcon size={11} />
                  </button>
                </div>
              )}
            </div>

            {showStdin && (runCap === 'c' || runCap === 'cpp') && (
              <div className="mm-code-stdin-box">
                <label>标准输入 (stdin)</label>
                <textarea
                  rows={3}
                  value={stdinInput}
                  onChange={(e) => setStdinInput(e.target.value)}
                  placeholder="预设标准输入，多项以空格或换行分隔…"
                  spellCheck={false}
                />
              </div>
            )}

            <div className="mm-code-output-scroll">
              {running ? (
                <div className="mm-code-output-empty">
                  正在执行 {codeLanguageDisplayName(language)} 代码…
                </div>
              ) : !result ? (
                <div className="mm-code-output-empty">
                  {runCap
                    ? '按 Ctrl+Enter 或点击上方「运行」执行此代码块；运行结果会自动嵌入思维导图该代码块下方。'
                    : `${codeLanguageDisplayName(language)} 代码块支持全屏编辑、语法高亮与 Agent 代码分析。`}
                </div>
              ) : (
                <div
                  className={`mm-code-output-stream is-${result.ok ? 'success' : 'error'}`}
                >
                  {result.outputs.length === 0 ? (
                    <div className="mm-code-output-empty">
                      {result.plainSummary}
                    </div>
                  ) : (
                    result.outputs.map((item, idx) => {
                      if (item.kind === 'stream' || item.kind === 'text') {
                        const slice = truncateOutputForDisplay(item.text);
                        const isExpanded = Boolean(expandedTextOutputs[idx]);
                        return (
                          <div
                            key={idx}
                            className={`mm-code-out-text${item.kind === 'stream' && item.name === 'stderr' ? ' is-stderr' : ''}`}
                          >
                            <pre>
                              {isExpanded ? item.text : slice.previewText}
                            </pre>
                            {slice.truncated && (
                              <button
                                type="button"
                                className="mm-code-mini-btn"
                                onClick={() =>
                                  setExpandedTextOutputs((prev) => ({
                                    ...prev,
                                    [idx]: !prev[idx],
                                  }))
                                }
                              >
                                {isExpanded
                                  ? '折叠长输出'
                                  : `展开全部（共 ${slice.totalLines} 行）`}
                              </button>
                            )}
                          </div>
                        );
                      }
                      if (item.kind === 'error') {
                        const suggestLocal =
                          result.language === 'python' &&
                          result.runtimeLabel === 'Pyodide WASM' &&
                          pythonEnvs.length > 0 &&
                          /ModuleNotFoundError|No module named|cannot import|OSError|URLError|ConnectionError/i.test(
                            item.message,
                          );
                        return (
                          <div key={idx} className="mm-code-out-error">
                            <pre>{item.message}</pre>
                            <div className="mm-code-out-error-actions">
                              {suggestLocal && (
                                <button
                                  type="button"
                                  className="mm-code-mini-btn is-accent"
                                  onClick={() => {
                                    const nextRt = pythonEnvs[0].pythonPath;
                                    setSelectedPyRuntime(nextRt);
                                    setPreferredMindmapPythonRuntime(nextRt);
                                    void handleRun(nextRt);
                                  }}
                                >
                                  切到本机 {pythonEnvs[0].label} 重新运行
                                </button>
                              )}
                              {onAskAgent && (
                                <button
                                  type="button"
                                  className="mm-code-mini-btn is-agent"
                                  onClick={() => {
                                    onAskAgent({
                                      intent: 'diagnose',
                                      language,
                                      source:
                                        viewRef.current?.state.doc.toString() ??
                                        source,
                                      sourceRange: request.sourceRange,
                                      nodePath: request.nodePath,
                                      outputSummary: result.plainSummary,
                                      errorText: item.message,
                                    });
                                    onClose();
                                  }}
                                >
                                  让 Agent 诊断报错
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      }
                      if (item.kind === 'image/png') {
                        return (
                          <div key={idx} className="mm-code-out-figure">
                            <img
                              src={item.dataUrl}
                              alt="图表输出"
                              onClick={() => setZoomedImage(item.dataUrl)}
                            />
                          </div>
                        );
                      }
                      if (item.kind === 'image/svg+xml') {
                        return <SafeSvgOutput key={idx} svg={item.svg} />;
                      }
                      if (item.kind === 'text/html') {
                        return (
                          <SandboxedHtmlTableFrame
                            key={idx}
                            html={item.html}
                            theme={theme}
                          />
                        );
                      }
                      if (item.kind === 'text/latex') {
                        return (
                          <KatexOutputBlock key={idx} latex={item.latex} />
                        );
                      }
                      return null;
                    })
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      {zoomedImage && (
        <div
          className="mm-code-lightbox"
          onClick={() => setZoomedImage(null)}
          role="dialog"
          aria-modal="true"
        >
          <img src={zoomedImage} alt="放大预览" />
        </div>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}

interface MindmapCodeInsertDialogProps {
  nodeLabel: string;
  theme: Theme;
  error: string;
  onCancel: () => void;
  onConfirm: (payload: {
    language: string;
    title: string;
    code: string;
  }) => void;
}

export function MindmapCodeInsertDialog({
  nodeLabel,
  theme,
  error,
  onCancel,
  onConfirm,
}: MindmapCodeInsertDialogProps) {
  const [language, setLanguage] = useState('python');
  const [autoDetected, setAutoDetected] = useState(true);
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');

  const handleCodeChange = (next: string) => {
    setCode(next);
    if (autoDetected && next.trim().length >= 8) {
      setLanguage(detectCodeLanguageFromSource(next));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    onConfirm({ language, title, code });
  };

  const dialog = (
    <div
      className="settings-backdrop"
      data-theme={theme}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        className="settings-dialog mm-code-insert-dialog"
        onSubmit={handleSubmit}
      >
        <div className="settings-heading">
          <div>
            <span className="pane-kicker">CODE BLOCK</span>
            <h2>插入可运行代码块</h2>
          </div>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭"
            onClick={onCancel}
          >
            ×
          </button>
        </div>

        <p className="settings-note">
          将作为「<strong>{nodeLabel || '当前节点'}</strong>
          」的子代码块插入，支持固定滑轨浏览、原地运行、结果嵌底与全屏编辑。
        </p>

        <div
          className="mm-code-insert-lang-bar"
          role="radiogroup"
          aria-label="选择代码语言"
        >
          {LANGUAGE_OPTIONS.slice(0, 10).map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={language === opt.id}
              className={`mm-code-insert-lang-pill${language === opt.id ? ' is-active' : ''}`}
              onClick={() => {
                setAutoDetected(false);
                setLanguage(opt.id);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <label className="settings-field">
          节点标题（可选，留空直接挂代码块）
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：API 抓取脚本"
          />
        </label>

        <label className="settings-field">
          代码内容
          <textarea
            className="mm-code-insert-textarea"
            rows={10}
            autoFocus
            spellCheck={false}
            value={code}
            onChange={(e) => handleCodeChange(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.ctrlKey || e.metaKey) &&
                e.key === 'Enter' &&
                code.trim()
              ) {
                e.preventDefault();
                onConfirm({ language, title, code });
              }
            }}
            placeholder="粘贴或输入代码（自动识别 Python / C / C++ / SQL / TS 等语言）…"
          />
        </label>

        {error && (
          <p className="generation-error" role="alert">
            {error}
          </p>
        )}

        <div className="settings-footer">
          <span>Ctrl + Enter 快速插入</span>
          <button type="button" className="text-button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="done-button" disabled={!code.trim()}>
            插入代码块
          </button>
        </div>
      </form>
    </div>
  );

  return createPortal(dialog, document.body);
}
