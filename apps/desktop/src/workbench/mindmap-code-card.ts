import katex from 'katex';
import type { Theme } from '../app/app-storage';
import { parseSafeSvgElement } from '../app/svg-sanitize';
import {
  formatDurationCompact,
  truncateOutputForDisplay,
} from '../terminal/terminal-codelab-model';
import type { PythonEnvInfo } from '../terminal/terminal-api';
import {
  codeLanguageBadge,
  computeCodeBlockResultKey,
  detectMindmapPythonEnvs,
  executeMindmapCCode,
  executeMindmapPythonCode,
  getCachedCodeBlockResult,
  getCodeBlockRunCapability,
  getPreferredMindmapPythonRuntime,
  interruptMindmapCodeExecution,
  normalizeCodeBlockLanguage,
  setCachedCodeBlockResult,
  setPreferredMindmapPythonRuntime,
  subscribeCodeBlockResult,
  tokenizeUniversalCodeLine,
  type CodeExecutionResult,
} from './code-execution-service';
import type { CodeBlockSourceRange } from './code-blocks';

export interface MindmapCodeBlockFullscreenRequest {
  language: string;
  rawLanguage: string;
  source: string;
  sourceRange?: CodeBlockSourceRange;
  nodePath: string | null;
  resultKey: string;
  initialResult: CodeExecutionResult | null;
}

export interface MindmapCodeBlockAgentRequest {
  intent: 'explain' | 'diagnose' | 'refactor';
  language: string;
  source: string;
  sourceRange?: CodeBlockSourceRange;
  nodePath: string | null;
  outputSummary?: string;
  errorText?: string;
}

export interface MindmapCodeCardHandlers {
  onCodeChange?: (
    language: string,
    previous: string,
    next: string,
    sourceRange?: CodeBlockSourceRange,
  ) => void | boolean;
  onTerminalCommand?: (
    language: string,
    source: string,
    onResult: (output: string) => void,
  ) => void;
  onRunInTerminal?: (language: string, source: string, title?: string) => void;
  onOpenInCodeLab?: (
    language: 'python' | 'c' | 'cpp',
    source: string,
    title?: string,
  ) => void;
  onOpenCodeFullscreen?: (request: MindmapCodeBlockFullscreenRequest) => void;
  onAskAgentAboutCode?: (request: MindmapCodeBlockAgentRequest) => void;
  onZoomImage?: (dataUrl: string) => void;
}

const collapsedCardKeys = new Set<string>();
const collapsedOutputKeys = new Set<string>();

function createSvgIcon(paths: string, size = 12): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.45');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

const ICON_PLAY =
  '<polygon points="4.5 3 13 8 4.5 13 4.5 3" fill="currentColor" stroke="none" />';
const ICON_STOP =
  '<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none" />';
const ICON_COPY =
  '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />';
const ICON_CHECK = '<polyline points="3 8.5 6.5 12 13 4.5" />';
const ICON_EXPAND =
  '<polyline points="9.5 2.5 13.5 2.5 13.5 6.5" /><polyline points="6.5 13.5 2.5 13.5 2.5 9.5" /><line x1="13.5" y1="2.5" x2="9" y2="7" /><line x1="2.5" y1="13.5" x2="7" y2="9" />';
const ICON_TERMINAL =
  '<polyline points="3 5 6.5 8 3 11" /><line x1="8" y1="11" x2="13" y2="11" />';
const ICON_SPARK =
  '<path d="M8 2.2 9.4 6.2 13.5 7.5 9.4 8.8 8 12.8 6.6 8.8 2.5 7.5 6.6 6.2 8 2.2Z" />';
const ICON_CHEVRON_DOWN = '<polyline points="4 6 8 10 12 6" />';
const ICON_CHEVRON_RIGHT = '<polyline points="6 4 10 8 6 12" />';
const ICON_TRASH =
  '<path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.6 8.5h4.8l.6-8.5" />';

function buildSandboxedTableSrcDoc(html: string, theme: Theme): string {
  const palette =
    theme === 'navy'
      ? {
          bg: '#0b1627',
          fg: '#dce8f5',
          border: '#1d324d',
          headBg: '#102036',
          zebra: 'rgba(255,255,255,0.025)',
        }
      : theme === 'purple'
        ? {
            bg: '#130c22',
            fg: '#ede2fa',
            border: '#2e2047',
            headBg: '#1b1230',
            zebra: 'rgba(255,255,255,0.025)',
          }
        : theme === 'dark'
          ? {
              bg: '#14191e',
              fg: '#d7e0e4',
              border: '#273139',
              headBg: '#1b2228',
              zebra: 'rgba(255,255,255,0.025)',
            }
          : {
              bg: '#ffffff',
              fg: '#1e272e',
              border: '#e3e8ec',
              headBg: '#f6f8fa',
              zebra: '#fafbfc',
            };
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 6px; font: 11px/1.45 ui-monospace, 'Cascadia Code', Consolas, monospace; font-variant-numeric: tabular-nums; background: ${palette.bg}; color: ${palette.fg}; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { padding: 4px 7px; border: 1px solid ${palette.border}; text-align: left; }
    thead th { background: ${palette.headBg}; font-weight: 600; }
    tbody tr:nth-child(even) { background: ${palette.zebra}; }
  </style></head><body>${html}</body></html>`;
}

function renderCodeLines(
  codeEl: HTMLElement,
  gutterEl: HTMLElement,
  source: string,
  language: string,
): number {
  const normalized = source.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const lines = normalized.split('\n');
  const gutterFrag = document.createDocumentFragment();
  const codeFrag = document.createDocumentFragment();

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNo = document.createElement('span');
    lineNo.textContent = String(idx + 1);
    gutterFrag.append(lineNo);

    const row = document.createElement('div');
    row.className = 'seamind-mm-code-line';
    const tokens = tokenizeUniversalCodeLine(lines[idx] ?? '', language);
    for (const tok of tokens) {
      if (tok.kind === 'plain') {
        row.append(document.createTextNode(tok.text));
      } else {
        const span = document.createElement('span');
        span.className = `cl-tok-${tok.kind}`;
        span.textContent = tok.text;
        row.append(span);
      }
    }
    codeFrag.append(row);
  }

  gutterEl.replaceChildren(gutterFrag);
  codeEl.replaceChildren(codeFrag);
  return lines.length;
}

function renderOutputItemsInto(
  bodyEl: HTMLElement,
  result: CodeExecutionResult,
  theme: Theme,
  options: {
    onZoomImage?: (dataUrl: string) => void;
    onSwitchLocalPythonAndRun?: () => void;
    hasLocalPythonEnv: boolean;
  },
): void {
  const frag = document.createDocumentFragment();

  if (result.outputs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'seamind-code-note-empty';
    empty.textContent = result.ok ? '(执行完成，无标准输出)' : '执行失败';
    frag.append(empty);
  }

  for (const item of result.outputs) {
    if (item.kind === 'stream' || item.kind === 'text') {
      const slice = truncateOutputForDisplay(item.text, 60, 12_000);
      const wrap = document.createElement('div');
      wrap.className =
        item.kind === 'stream' && item.name === 'stderr'
          ? 'seamind-code-note-stream is-stderr'
          : 'seamind-code-note-stream';
      const pre = document.createElement('pre');
      pre.textContent = slice.previewText;
      wrap.append(pre);
      if (slice.truncated) {
        let expanded = false;
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'seamind-code-note-inline-btn';
        toggleBtn.textContent = `展开完整输出（共 ${slice.totalLines} 行）`;
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          expanded = !expanded;
          pre.textContent = expanded ? item.text : slice.previewText;
          toggleBtn.textContent = expanded
            ? '折叠长输出'
            : `展开完整输出（共 ${slice.totalLines} 行）`;
        });
        wrap.append(toggleBtn);
      }
      frag.append(wrap);
    } else if (item.kind === 'error') {
      const errPre = document.createElement('pre');
      errPre.className = 'seamind-code-note-error';
      errPre.textContent = item.message;
      frag.append(errPre);

      if (
        result.language === 'python' &&
        result.runtimeLabel === 'Pyodide WASM' &&
        /ModuleNotFoundError|No module named|cannot import|OSError|URLError|ConnectionError/i.test(
          item.message,
        ) &&
        options.hasLocalPythonEnv &&
        options.onSwitchLocalPythonAndRun
      ) {
        const hintRow = document.createElement('div');
        hintRow.className = 'seamind-code-note-hint-row';
        const hintBtn = document.createElement('button');
        hintBtn.type = 'button';
        hintBtn.className = 'seamind-code-note-inline-btn is-accent';
        hintBtn.textContent = '切换本机 Python 内核重新运行';
        hintBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          options.onSwitchLocalPythonAndRun?.();
        });
        hintRow.append(hintBtn);
        frag.append(hintRow);
      }
    } else if (item.kind === 'image/png') {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'seamind-code-note-figure';
      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = '代码运行图表输出';
      img.title = '点击放大查看图表';
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        options.onZoomImage?.(item.dataUrl);
      });
      imgWrap.append(img);
      frag.append(imgWrap);
    } else if (item.kind === 'image/svg+xml') {
      const svgEl = parseSafeSvgElement(item.svg);
      if (svgEl) {
        const svgWrap = document.createElement('div');
        svgWrap.className = 'seamind-code-note-figure';
        svgWrap.append(svgEl);
        frag.append(svgWrap);
      }
    } else if (item.kind === 'text/html') {
      const frame = document.createElement('iframe');
      frame.className = 'seamind-code-note-html-frame';
      frame.setAttribute('sandbox', '');
      frame.setAttribute('title', '表格输出');
      frame.srcdoc = buildSandboxedTableSrcDoc(item.html, theme);
      frag.append(frame);
    } else if (item.kind === 'text/latex') {
      const texWrap = document.createElement('div');
      texWrap.className = 'seamind-code-note-latex';
      const cleaned = item.latex
        .trim()
        .replace(/^\$\$([\s\S]+)\$\$$/, '$1')
        .replace(/^\$([\s\S]+)\$$/, '$1');
      try {
        texWrap.innerHTML = katex.renderToString(cleaned, {
          displayMode: true,
          throwOnError: false,
          strict: false,
        });
      } catch {
        texWrap.textContent = item.latex;
      }
      frag.append(texWrap);
    }
  }

  bodyEl.replaceChildren(frag);
}

export function createMindmapCodeCard(args: {
  pre: HTMLElement;
  source: string;
  rawLanguage: string;
  language: string;
  theme: Theme;
  signal: AbortSignal;
  dispose: (callback: () => void) => void;
  handlers: MindmapCodeCardHandlers;
  cwd?: string | null;
}): HTMLElement {
  const {
    pre,
    source,
    rawLanguage,
    language,
    theme,
    signal,
    dispose,
    handlers,
    cwd,
  } = args;
  const normLang = normalizeCodeBlockLanguage(language);
  const runCap = getCodeBlockRunCapability(normLang);
  const nodePath =
    pre.closest<SVGGElement>('g.markmap-node')?.getAttribute('data-path') ??
    null;

  const lineRange = pre.dataset.lines?.split(',').map(Number);
  const sourceRange: CodeBlockSourceRange | undefined =
    lineRange?.length === 2 && lineRange.every(Number.isFinite)
      ? { lineIndex: lineRange[0]!, endLineIndex: lineRange[1]! }
      : undefined;

  const resultKey = computeCodeBlockResultKey(normLang, source, sourceRange);
  let currentResult: CodeExecutionResult | null =
    getCachedCodeBlockResult(resultKey);
  let isRunning = false;
  let detectedEnvs: PythonEnvInfo[] = [];

  // Root container
  const root = document.createElement('section');
  root.className = 'seamind-code-panel seamind-mm-code-card';
  root.dataset.seamindCodeInteractive = 'true';
  root.dataset.language = normLang;
  root.setAttribute('aria-label', `${codeLanguageBadge(normLang)} 代码块`);

  // Header
  const head = document.createElement('div');
  head.className = 'seamind-mm-code-head';

  const headLeft = document.createElement('div');
  headLeft.className = 'seamind-mm-code-head-left';

  const langBadge = document.createElement('span');
  langBadge.className = `seamind-mm-code-lang is-${runCap ?? 'static'}`;
  langBadge.textContent = codeLanguageBadge(normLang);

  const lineCountLabel = document.createElement('span');
  lineCountLabel.className = 'seamind-mm-code-lines-meta';

  headLeft.append(langBadge, lineCountLabel);

  // Python runtime switch pill (WASM <-> Local Python)
  let runtimeBtn: HTMLButtonElement | null = null;
  const syncRuntimePill = () => {
    if (!runtimeBtn) return;
    const activeRt = getPreferredMindmapPythonRuntime();
    if (activeRt === 'pyodide') {
      runtimeBtn.textContent = 'WASM';
      runtimeBtn.title =
        detectedEnvs.length > 0
          ? `当前 Pyodide 沙盒；点击切至本机 ${detectedEnvs[0].label}`
          : '当前 Pyodide WebAssembly 沙盒';
      runtimeBtn.classList.remove('is-local');
    } else {
      const env = detectedEnvs.find((e) => e.pythonPath === activeRt);
      runtimeBtn.textContent = env ? env.label.slice(0, 14) : '本机 PY';
      runtimeBtn.title = `当前本机内核：${activeRt}；点击切回 WASM 沙盒`;
      runtimeBtn.classList.add('is-local');
    }
  };

  if (runCap === 'python') {
    runtimeBtn = document.createElement('button');
    runtimeBtn.type = 'button';
    runtimeBtn.className = 'seamind-mm-code-runtime';
    syncRuntimePill();
    runtimeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = getPreferredMindmapPythonRuntime();
      if (cur === 'pyodide' && detectedEnvs.length > 0) {
        setPreferredMindmapPythonRuntime(detectedEnvs[0].pythonPath);
      } else {
        setPreferredMindmapPythonRuntime('pyodide');
      }
      syncRuntimePill();
    });
    headLeft.append(runtimeBtn);

    void detectMindmapPythonEnvs(cwd).then((envs) => {
      if (signal.aborted) return;
      detectedEnvs = envs;
      syncRuntimePill();
    });
  }

  const headActions = document.createElement('div');
  headActions.className = 'seamind-mm-code-actions';

  let runBtn: HTMLButtonElement | null = null;
  if (runCap) {
    runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'seamind-mm-code-btn is-run';
    runBtn.title =
      runCap === 'shell'
        ? '预览并在本机终端运行'
        : `运行 ${codeLanguageBadge(normLang)} 代码`;
    runBtn.append(createSvgIcon(ICON_PLAY, 11));
    const runText = document.createElement('span');
    runText.textContent = '运行';
    runBtn.append(runText);
    headActions.append(runBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'seamind-mm-code-icon-btn';
  copyBtn.title = '复制代码';
  copyBtn.setAttribute('aria-label', '复制代码');
  copyBtn.append(createSvgIcon(ICON_COPY, 12));
  headActions.append(copyBtn);

  let termBtn: HTMLButtonElement | null = null;
  if (
    (runCap === 'python' || runCap === 'c' || runCap === 'cpp') &&
    (handlers.onOpenInCodeLab || handlers.onRunInTerminal)
  ) {
    termBtn = document.createElement('button');
    termBtn.type = 'button';
    termBtn.className = 'seamind-mm-code-icon-btn';
    termBtn.title = '在终端 Code Lab 中打开';
    termBtn.setAttribute('aria-label', '在终端 Code Lab 中打开');
    termBtn.append(createSvgIcon(ICON_TERMINAL, 12));
    headActions.append(termBtn);
  }

  let agentBtn: HTMLButtonElement | null = null;
  if (handlers.onAskAgentAboutCode) {
    agentBtn = document.createElement('button');
    agentBtn.type = 'button';
    agentBtn.className = 'seamind-mm-code-icon-btn is-agent';
    agentBtn.title = '让 Agent 解释、诊断或优化这段代码';
    agentBtn.setAttribute('aria-label', '问 Agent');
    agentBtn.append(createSvgIcon(ICON_SPARK, 12));
    headActions.append(agentBtn);
  }

  let fullscreenBtn: HTMLButtonElement | null = null;
  if (handlers.onOpenCodeFullscreen) {
    fullscreenBtn = document.createElement('button');
    fullscreenBtn.type = 'button';
    fullscreenBtn.className = 'seamind-mm-code-icon-btn';
    fullscreenBtn.title = '全屏编辑与运行';
    fullscreenBtn.setAttribute('aria-label', '全屏打开代码块');
    fullscreenBtn.append(createSvgIcon(ICON_EXPAND, 12));
    headActions.append(fullscreenBtn);
  }

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'seamind-mm-code-icon-btn';
  collapseBtn.title = '折叠 / 展开代码';
  collapseBtn.setAttribute('aria-label', '折叠或展开代码');
  headActions.append(collapseBtn);

  head.append(headLeft, headActions);

  // Scrollable Code Viewport (Literature flat 8px scrollbar)
  const viewport = document.createElement('div');
  viewport.className = 'seamind-mm-code-viewport';
  viewport.dataset.seamindCodeScroll = 'true';

  const codeGrid = document.createElement('div');
  codeGrid.className = 'seamind-mm-code-grid';

  const gutter = document.createElement('div');
  gutter.className = 'seamind-mm-code-gutter';
  gutter.setAttribute('aria-hidden', 'true');

  const codePre = document.createElement('pre');
  codePre.className = 'seamind-mm-code-pre';

  const totalLines = renderCodeLines(codePre, gutter, source, normLang);
  lineCountLabel.textContent = `${totalLines} 行`;

  codeGrid.append(gutter, codePre);
  viewport.append(codeGrid);

  // Embedded Note-Style Output Container (styled like .seamind-node-note)
  const noteOutput = document.createElement('div');
  noteOutput.className = 'seamind-code-note-output';
  noteOutput.hidden = true;

  const noteHead = document.createElement('div');
  noteHead.className = 'seamind-code-note-head';

  const noteMeta = document.createElement('span');
  noteMeta.className = 'seamind-code-note-meta';

  const noteHeadActions = document.createElement('div');
  noteHeadActions.className = 'seamind-code-note-actions';

  const noteDiagnoseBtn = document.createElement('button');
  noteDiagnoseBtn.type = 'button';
  noteDiagnoseBtn.className = 'seamind-code-note-btn is-diagnose';
  noteDiagnoseBtn.textContent = 'Agent 诊断';
  noteDiagnoseBtn.hidden = true;

  const noteCopyBtn = document.createElement('button');
  noteCopyBtn.type = 'button';
  noteCopyBtn.className = 'seamind-code-note-btn';
  noteCopyBtn.textContent = '复制';

  const noteToggleBtn = document.createElement('button');
  noteToggleBtn.type = 'button';
  noteToggleBtn.className = 'seamind-code-note-btn';
  noteToggleBtn.textContent = '收起';

  const noteClearBtn = document.createElement('button');
  noteClearBtn.type = 'button';
  noteClearBtn.className = 'seamind-code-note-icon-btn';
  noteClearBtn.title = '清空输出';
  noteClearBtn.append(createSvgIcon(ICON_TRASH, 11));

  noteHeadActions.append(
    noteDiagnoseBtn,
    noteCopyBtn,
    noteToggleBtn,
    noteClearBtn,
  );
  noteHead.append(noteMeta, noteHeadActions);

  const noteBody = document.createElement('div');
  noteBody.className = 'seamind-code-note-body';
  noteBody.dataset.seamindCodeScroll = 'true';

  noteOutput.append(noteHead, noteBody);

  root.append(head, viewport, noteOutput);

  const applyCollapseState = () => {
    const isCollapsed = collapsedCardKeys.has(resultKey);
    root.classList.toggle('is-collapsed', isCollapsed);
    viewport.hidden = isCollapsed;
    collapseBtn.replaceChildren(
      createSvgIcon(isCollapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN, 12),
    );
    collapseBtn.title = isCollapsed ? '展开代码块' : '折叠代码块';
  };
  applyCollapseState();

  const updateRunBtnUi = () => {
    if (!runBtn) return;
    runBtn.classList.toggle('is-running', isRunning);
    runBtn.replaceChildren(
      createSvgIcon(isRunning ? ICON_STOP : ICON_PLAY, 11),
    );
    const span = document.createElement('span');
    span.textContent = isRunning ? '停止' : '运行';
    runBtn.append(span);
    runBtn.title = isRunning
      ? '停止当前运行'
      : `运行 ${codeLanguageBadge(normLang)} 代码`;
  };

  const renderNoteOutput = (res: CodeExecutionResult | null) => {
    currentResult = res;
    if (!res && !isRunning) {
      noteOutput.hidden = true;
      return;
    }
    noteOutput.hidden = false;
    noteOutput.classList.remove('is-running', 'is-success', 'is-error');
    if (isRunning) {
      noteOutput.classList.add('is-running');
      noteMeta.textContent = `RUN · 正在执行 ${codeLanguageBadge(normLang)}…`;
      noteDiagnoseBtn.hidden = true;
      noteBody.hidden = false;
      noteBody.textContent = '执行中…';
      return;
    }
    if (!res) return;
    noteOutput.classList.add(res.ok ? 'is-success' : 'is-error');
    const dur = formatDurationCompact(res.durationMs);
    const statusTag = res.ok ? 'OUT' : 'ERR';
    noteMeta.textContent = [statusTag, res.runtimeLabel, dur]
      .filter(Boolean)
      .join(' · ');
    noteDiagnoseBtn.hidden = !handlers.onAskAgentAboutCode || res.ok;

    const outCollapsed = collapsedOutputKeys.has(resultKey);
    noteBody.hidden = outCollapsed;
    noteToggleBtn.textContent = outCollapsed ? '展开' : '收起';

    renderOutputItemsInto(noteBody, res, theme, {
      onZoomImage: handlers.onZoomImage,
      hasLocalPythonEnv: detectedEnvs.length > 0,
      onSwitchLocalPythonAndRun: () => {
        if (detectedEnvs.length > 0) {
          setPreferredMindmapPythonRuntime(detectedEnvs[0].pythonPath);
          syncRuntimePill();
          void triggerRun();
        }
      },
    });
  };

  const triggerRun = async () => {
    if (signal.aborted || !runCap) return;
    if (isRunning) {
      interruptMindmapCodeExecution();
      isRunning = false;
      updateRunBtnUi();
      renderNoteOutput(currentResult);
      return;
    }

    if (runCap === 'shell') {
      if (!handlers.onTerminalCommand) return;
      isRunning = true;
      updateRunBtnUi();
      renderNoteOutput(null);
      const started = performance.now();
      handlers.onTerminalCommand(normLang, source, (resultText) => {
        if (signal.aborted) return;
        isRunning = false;
        updateRunBtnUi();
        const res: CodeExecutionResult = {
          ok: true,
          language: normLang,
          runtimeLabel: normLang === 'powershell' ? 'PowerShell' : 'Shell',
          outputs: [
            {
              kind: 'stream',
              name: 'stdout',
              text: resultText || '(执行完成)',
            },
          ],
          durationMs: Math.round(performance.now() - started),
          plainSummary: resultText || '(执行完成)',
          errorText: '',
          timestamp: Date.now(),
        };
        setCachedCodeBlockResult(resultKey, res);
      });
      return;
    }

    isRunning = true;
    collapsedOutputKeys.delete(resultKey);
    updateRunBtnUi();
    renderNoteOutput(null);

    try {
      const res =
        runCap === 'python'
          ? await executeMindmapPythonCode({ source, cwd })
          : await executeMindmapCCode({ source, isCpp: runCap === 'cpp' });
      if (signal.aborted) return;
      isRunning = false;
      updateRunBtnUi();
      setCachedCodeBlockResult(resultKey, res);
    } catch (err) {
      if (signal.aborted) return;
      isRunning = false;
      updateRunBtnUi();
      const msg = err instanceof Error ? err.message : String(err);
      setCachedCodeBlockResult(resultKey, {
        ok: false,
        language: normLang,
        runtimeLabel: codeLanguageBadge(normLang),
        outputs: [{ kind: 'error', message: msg }],
        durationMs: 0,
        plainSummary: msg,
        errorText: msg,
        timestamp: Date.now(),
      });
    }
  };

  // Restore any cached output immediately
  if (currentResult) {
    renderNoteOutput(currentResult);
  }

  const unsubscribe = subscribeCodeBlockResult(resultKey, (nextRes) => {
    if (signal.aborted) return;
    isRunning = false;
    updateRunBtnUi();
    renderNoteOutput(nextRes);
  });

  // Wire buttons
  const onRunClick = (e: MouseEvent) => {
    e.stopPropagation();
    void triggerRun();
  };
  runBtn?.addEventListener('click', onRunClick);

  let copyTimer: number | null = null;
  const onCopyClick = (e: MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(source).then(() => {
      copyBtn.replaceChildren(createSvgIcon(ICON_CHECK, 12));
      copyBtn.classList.add('is-copied');
      if (copyTimer !== null) window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        copyBtn.replaceChildren(createSvgIcon(ICON_COPY, 12));
        copyBtn.classList.remove('is-copied');
      }, 1200);
    });
  };
  copyBtn.addEventListener('click', onCopyClick);

  const onTermClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (runCap === 'python' || runCap === 'c' || runCap === 'cpp') {
      if (handlers.onOpenInCodeLab) {
        handlers.onOpenInCodeLab(runCap, source);
      } else if (handlers.onRunInTerminal && runCap !== 'python') {
        handlers.onRunInTerminal(runCap, source);
      }
    }
  };
  termBtn?.addEventListener('click', onTermClick);

  const onAgentClick = (e: MouseEvent) => {
    e.stopPropagation();
    handlers.onAskAgentAboutCode?.({
      intent: currentResult && !currentResult.ok ? 'diagnose' : 'explain',
      language: normLang,
      source,
      sourceRange,
      nodePath,
      outputSummary: currentResult?.plainSummary,
      errorText: currentResult?.errorText,
    });
  };
  agentBtn?.addEventListener('click', onAgentClick);

  const openFullscreen = () => {
    handlers.onOpenCodeFullscreen?.({
      language: normLang,
      rawLanguage,
      source,
      sourceRange,
      nodePath,
      resultKey,
      initialResult: currentResult,
    });
  };
  const onFullscreenClick = (e: MouseEvent) => {
    e.stopPropagation();
    openFullscreen();
  };
  fullscreenBtn?.addEventListener('click', onFullscreenClick);

  const onViewportDblClick = (e: MouseEvent) => {
    e.stopPropagation();
    openFullscreen();
  };
  viewport.addEventListener('dblclick', onViewportDblClick);

  const onCollapseClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (collapsedCardKeys.has(resultKey)) {
      collapsedCardKeys.delete(resultKey);
    } else {
      collapsedCardKeys.add(resultKey);
    }
    applyCollapseState();
  };
  collapseBtn.addEventListener('click', onCollapseClick);

  const onNoteDiagnose = (e: MouseEvent) => {
    e.stopPropagation();
    handlers.onAskAgentAboutCode?.({
      intent: 'diagnose',
      language: normLang,
      source,
      sourceRange,
      nodePath,
      outputSummary: currentResult?.plainSummary,
      errorText: currentResult?.errorText,
    });
  };
  noteDiagnoseBtn.addEventListener('click', onNoteDiagnose);

  const onNoteCopy = (e: MouseEvent) => {
    e.stopPropagation();
    if (!currentResult) return;
    void navigator.clipboard?.writeText(currentResult.plainSummary).then(() => {
      noteCopyBtn.textContent = '已复制';
      window.setTimeout(() => {
        noteCopyBtn.textContent = '复制';
      }, 1100);
    });
  };
  noteCopyBtn.addEventListener('click', onNoteCopy);

  const onNoteToggle = (e: MouseEvent) => {
    e.stopPropagation();
    if (collapsedOutputKeys.has(resultKey)) {
      collapsedOutputKeys.delete(resultKey);
    } else {
      collapsedOutputKeys.add(resultKey);
    }
    renderNoteOutput(currentResult);
  };
  noteToggleBtn.addEventListener('click', onNoteToggle);

  const onNoteClear = (e: MouseEvent) => {
    e.stopPropagation();
    collapsedOutputKeys.delete(resultKey);
    setCachedCodeBlockResult(resultKey, null);
  };
  noteClearBtn.addEventListener('click', onNoteClear);

  // Guard wheel / pointer events inside scrollable regions from hijacking D3 canvas zoom/pan
  const stopCanvasDrag = (e: Event) => {
    e.stopPropagation();
  };
  const stopCanvasWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    const target = e.target instanceof Element ? e.target : null;
    const scroller = target?.closest<HTMLElement>('[data-seamind-code-scroll]');
    if (
      scroller &&
      (scroller.scrollHeight > scroller.clientHeight + 1 ||
        scroller.scrollWidth > scroller.clientWidth + 1)
    ) {
      e.stopPropagation();
    }
  };
  root.addEventListener('mousedown', stopCanvasDrag);
  root.addEventListener('pointerdown', stopCanvasDrag);
  root.addEventListener('dblclick', stopCanvasDrag);
  root.addEventListener('wheel', stopCanvasWheel, { passive: true });

  dispose(() => {
    unsubscribe();
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    runBtn?.removeEventListener('click', onRunClick);
    copyBtn.removeEventListener('click', onCopyClick);
    termBtn?.removeEventListener('click', onTermClick);
    agentBtn?.removeEventListener('click', onAgentClick);
    fullscreenBtn?.removeEventListener('click', onFullscreenClick);
    viewport.removeEventListener('dblclick', onViewportDblClick);
    collapseBtn.removeEventListener('click', onCollapseClick);
    noteDiagnoseBtn.removeEventListener('click', onNoteDiagnose);
    noteCopyBtn.removeEventListener('click', onNoteCopy);
    noteToggleBtn.removeEventListener('click', onNoteToggle);
    noteClearBtn.removeEventListener('click', onNoteClear);
    root.removeEventListener('mousedown', stopCanvasDrag);
    root.removeEventListener('pointerdown', stopCanvasDrag);
    root.removeEventListener('dblclick', stopCanvasDrag);
    root.removeEventListener('wheel', stopCanvasWheel);
  });

  return root;
}
