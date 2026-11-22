import { systemApi } from '../system/system-api';
import { terminalApi, type PythonEnvInfo } from '../terminal/terminal-api';
import {
  assembleCCellProgram,
  DEFAULT_C_PROLOGUE,
  DEFAULT_CPP_PROLOGUE,
  type CodeLabOutputItem,
} from '../terminal/terminal-codelab-model';
import type {
  PythonWorkerRequest,
  PythonWorkerResponse,
  PythonWorkerVarSummary,
} from './python.worker';
import {
  codeLanguageBadge,
  codeLanguageDisplayName,
  computeCodeBlockResultKey,
  isDiagramCodeLanguage,
  normalizeCodeBlockLanguage,
  renderCodeLinesInto,
  tokenizeUniversalCodeLine,
  type CodeSyntaxToken,
  type CodeTokenKind,
} from './code-syntax-utils';

export {
  codeLanguageBadge,
  codeLanguageDisplayName,
  computeCodeBlockResultKey,
  isDiagramCodeLanguage,
  normalizeCodeBlockLanguage,
  renderCodeLinesInto,
  tokenizeUniversalCodeLine,
  type CodeSyntaxToken,
  type CodeTokenKind,
};

export interface CodeExecutionResult {
  ok: boolean;
  language: string;
  runtimeLabel: string;
  outputs: CodeLabOutputItem[];
  durationMs: number;
  exitCode?: number | null;
  stage?: string;
  variables?: PythonWorkerVarSummary[];
  plainSummary: string;
  errorText: string;
  timestamp: number;
}

export const MINDMAP_CODE_RUNTIME_STORAGE_KEY = 'seamind:mindmap-py-runtime:v1';

export type CodeBlockRunCapability = 'python' | 'c' | 'cpp' | 'shell' | null;

export function getCodeBlockRunCapability(
  language: string,
): CodeBlockRunCapability {
  const norm = normalizeCodeBlockLanguage(language);
  if (norm === 'python') return 'python';
  if (norm === 'c') return 'c';
  if (norm === 'cpp') return 'cpp';
  if (norm === 'powershell' || norm === 'bash') return 'shell';
  return null;
}

export function isRunnableCodeBlockLanguage(language: string): boolean {
  return getCodeBlockRunCapability(language) !== null;
}

export function detectCodeLanguageFromSource(source: string): string {
  const text = source.trim();
  if (!text) return 'python';
  if (
    /^\s*(?:from\s+\S+\s+import\s+|import\s+[a-zA-Z_]|def\s+\w+\s*\(|class\s+\w+.*:)/m.test(
      text,
    )
  ) {
    return 'python';
  }
  if (
    /#include\s*<(?:iostream|vector|string|algorithm|map|unordered_map|bits\/stdc\+\+\.h)>|\bstd::|\bcout\s*<</.test(
      text,
    )
  ) {
    return 'cpp';
  }
  if (
    /#include\s*<(?:stdio|stdlib|string|stdint|math)\.h>|\bprintf\s*\(/.test(
      text,
    )
  ) {
    return 'c';
  }
  if (
    /^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|WITH\s+\w+\s+AS)\b/im.test(
      text,
    )
  ) {
    return 'sql';
  }
  if (
    /^\s*(?:fn\s+\w+|let\s+mut\s+|use\s+std::|impl\s+\w+|pub\s+struct\s+)/m.test(
      text,
    )
  ) {
    return 'rust';
  }
  if (/^\s*(?:package\s+\w+|func\s+\w+|import\s+\()/m.test(text)) {
    return 'go';
  }
  if (
    /^\s*(?:interface\s+\w+|type\s+\w+\s*=|export\s+(?:async\s+)?function\b|const\s+\w+\s*:\s*\w+)/m.test(
      text,
    )
  ) {
    return 'typescript';
  }
  if (
    /^\s*(?:const|let|var|function|export\s+default|import\s+.*from\s+['"])/m.test(
      text,
    )
  ) {
    return 'javascript';
  }
  if (/^\s*[[{][\s\S]*[\]}]\s*$/.test(text)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      // not valid JSON
    }
  }
  if (
    /^\s*(?:\$|#!\/bin\/(?:ba)?sh|sudo\s+|curl\s+|git\s+|pip\s+|conda\s+)/m.test(
      text,
    )
  ) {
    return 'bash';
  }
  if (/\b(?:Get-|Set-|Invoke-|Write-Host|\$env:)/i.test(text)) {
    return 'powershell';
  }
  return 'python';
}

export function looksLikeMultiLineCodeSnippet(rawText: string): boolean {
  const normalized = rawText.replace(/&#10;/gi, '\n').trim();
  const lines = normalized.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;
  const codeSignals = [
    /^\s*(?:import|from)\s+[a-zA-Z0-9_.]+/m,
    /^\s*(?:def|class|async\s+def)\s+[a-zA-Z_]/m,
    /^\s*#include\s*[<"]/m,
    /^\s*(?:const|let|var|function|export|interface|type)\s+[a-zA-Z_]/m,
    /^\s*(?:SELECT|CREATE\s+TABLE|INSERT\s+INTO|WITH\s+)/im,
    /^\s*(?:fn|pub\s+fn|struct|impl|package|func)\s+[a-zA-Z_]/m,
    /[{}[\]];?\s*$/m,
    /\w+\s*=\s*(?:\{|\[|["'\d]|\w+\()/m,
    /\b(?:return|for|while|if|elif|else|try|except|catch|with)\b/,
  ];
  let score = 0;
  for (const pattern of codeSignals) {
    if (pattern.test(normalized)) score += 1;
  }
  return score >= 2;
}

// =============================================================================
// Shared Mindmap Python & C/C++ Execution Service
// =============================================================================

let sharedPyodideWorker: Worker | null = null;
const pendingWorkerRequests = new Map<
  string,
  {
    resolve: (res: PythonWorkerResponse) => void;
    reject: (err: Error) => void;
  }
>();

let cachedPythonEnvs: PythonEnvInfo[] | null = null;
let envDetectionPromise: Promise<PythonEnvInfo[]> | null = null;
let activeLocalKernel: { pythonPath: string; kernelId: string } | null = null;

export function getPreferredMindmapPythonRuntime(): string {
  try {
    return localStorage.getItem(MINDMAP_CODE_RUNTIME_STORAGE_KEY) || 'pyodide';
  } catch {
    return 'pyodide';
  }
}

export function setPreferredMindmapPythonRuntime(runtime: string): void {
  try {
    localStorage.setItem(MINDMAP_CODE_RUNTIME_STORAGE_KEY, runtime);
  } catch {
    // ignore storage errors
  }
}

export async function detectMindmapPythonEnvs(
  cwd?: string | null,
  force = false,
): Promise<PythonEnvInfo[]> {
  if (!force && cachedPythonEnvs) return cachedPythonEnvs;
  if (!force && envDetectionPromise) return envDetectionPromise;
  envDetectionPromise = terminalApi
    .detectPythonEnvs({ cwd: cwd ?? null })
    .then((envs) => {
      cachedPythonEnvs = envs;
      return envs;
    })
    .catch(() => {
      cachedPythonEnvs = [];
      return [];
    })
    .finally(() => {
      envDetectionPromise = null;
    });
  return envDetectionPromise;
}

function ensureSharedPyodideWorker(): Worker {
  if (sharedPyodideWorker) return sharedPyodideWorker;
  const worker = new Worker(new URL('./python.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (event: MessageEvent<PythonWorkerResponse>) => {
    const reqId = event.data.requestId;
    if (!reqId) return;
    const waiter = pendingWorkerRequests.get(reqId);
    if (!waiter) return;
    pendingWorkerRequests.delete(reqId);
    waiter.resolve(event.data);
  };
  worker.onerror = (event) => {
    for (const [id, waiter] of pendingWorkerRequests) {
      waiter.reject(new Error(event.message || 'Pyodide Worker 崩溃'));
      pendingWorkerRequests.delete(id);
    }
    sharedPyodideWorker = null;
  };
  sharedPyodideWorker = worker;
  return worker;
}

function runPyodideWorkerAction(
  action: 'exec' | 'reset' | 'vars',
  source: string,
  timeoutMs = 25_000,
): Promise<PythonWorkerResponse> {
  return new Promise<PythonWorkerResponse>((resolve, reject) => {
    const worker = ensureSharedPyodideWorker();
    const requestId = `mm-py-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timer = window.setTimeout(() => {
      pendingWorkerRequests.delete(requestId);
      worker.terminate();
      sharedPyodideWorker = null;
      reject(new Error('Pyodide 执行超过 25 秒超时，Worker 已重置。'));
    }, timeoutMs);
    pendingWorkerRequests.set(requestId, {
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
  });
}

export function interruptMindmapCodeExecution(): void {
  if (sharedPyodideWorker) {
    sharedPyodideWorker.terminate();
    sharedPyodideWorker = null;
  }
  for (const [id, waiter] of pendingWorkerRequests) {
    waiter.reject(new Error('已由用户手动中断执行'));
    pendingWorkerRequests.delete(id);
  }
}

export async function resetMindmapPythonKernel(
  runtime?: string,
): Promise<void> {
  const chosen = runtime ?? getPreferredMindmapPythonRuntime();
  if (chosen === 'pyodide') {
    if (sharedPyodideWorker) {
      await runPyodideWorkerAction('reset', '').catch(() => undefined);
    }
    return;
  }
  if (activeLocalKernel) {
    await terminalApi
      .resetPythonKernel({ kernelId: activeLocalKernel.kernelId })
      .catch(() => undefined);
  }
}

function summarizeOutputs(
  outputs: CodeLabOutputItem[],
  ok: boolean,
): {
  plainSummary: string;
  errorText: string;
} {
  const textParts: string[] = [];
  const errParts: string[] = [];
  let mediaCount = 0;
  for (const out of outputs) {
    if (out.kind === 'stream' || out.kind === 'text') {
      if (out.text.trim()) textParts.push(out.text.trimEnd());
    } else if (out.kind === 'error') {
      errParts.push(out.message.trim());
    } else if (
      out.kind === 'image/png' ||
      out.kind === 'image/svg+xml' ||
      out.kind === 'text/html' ||
      out.kind === 'text/latex'
    ) {
      mediaCount += 1;
    }
  }
  const errorText = errParts.join('\n');
  if (textParts.length > 0) {
    return { plainSummary: textParts.join('\n'), errorText };
  }
  if (errorText) {
    return { plainSummary: errorText, errorText };
  }
  if (mediaCount > 0) {
    return {
      plainSummary: `生成了 ${mediaCount} 项可视化/富媒体输出`,
      errorText: '',
    };
  }
  return {
    plainSummary: ok ? '(执行完成，无标准输出)' : '执行失败',
    errorText,
  };
}

export async function executeMindmapPythonCode(options: {
  source: string;
  runtime?: string;
  cwd?: string | null;
}): Promise<CodeExecutionResult> {
  const { source, cwd } = options;
  const started = performance.now();
  const runtime = options.runtime ?? getPreferredMindmapPythonRuntime();

  if (runtime === 'pyodide') {
    try {
      const res = await runPyodideWorkerAction('exec', source);
      const outputs: CodeLabOutputItem[] = [];
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
      const ok = res.type !== 'error' && !res.error;
      if (!ok) {
        outputs.push({
          kind: 'error',
          message: res.error || 'Python 执行失败',
        });
      }
      const { plainSummary, errorText } = summarizeOutputs(outputs, ok);
      return {
        ok,
        language: 'python',
        runtimeLabel: 'Pyodide WASM',
        outputs,
        durationMs: Math.round(performance.now() - started),
        variables: res.variables ?? [],
        plainSummary,
        errorText,
        timestamp: Date.now(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        language: 'python',
        runtimeLabel: 'Pyodide WASM',
        outputs: [{ kind: 'error', message: msg }],
        durationMs: Math.round(performance.now() - started),
        plainSummary: msg,
        errorText: msg,
        timestamp: Date.now(),
      };
    }
  }

  // Local Python / Conda kernel via Rust backend
  try {
    if (activeLocalKernel && activeLocalKernel.pythonPath !== runtime) {
      const oldId = activeLocalKernel.kernelId;
      activeLocalKernel = null;
      await terminalApi
        .closePythonKernel({ kernelId: oldId })
        .catch(() => undefined);
    }
    if (!activeLocalKernel) {
      const kernelId = await terminalApi.startPythonKernel({
        pythonPath: runtime,
        cwd: cwd ?? null,
      });
      activeLocalKernel = { pythonPath: runtime, kernelId };
    }
    const res = await terminalApi.evalPythonKernel({
      kernelId: activeLocalKernel.kernelId,
      code: source,
    });
    const outputs: CodeLabOutputItem[] = [];
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
    const ok = res.ok && !res.error;
    if (!ok) {
      outputs.push({
        kind: 'error',
        message: res.error || res.stderr || '本地 Python 内核报错',
      });
    }
    const envMeta = cachedPythonEnvs?.find((e) => e.pythonPath === runtime);
    const { plainSummary, errorText } = summarizeOutputs(outputs, ok);
    return {
      ok,
      language: 'python',
      runtimeLabel: envMeta?.label || 'Local Python',
      outputs,
      durationMs: res.durationMs || Math.round(performance.now() - started),
      variables: res.variables,
      plainSummary,
      errorText,
      timestamp: Date.now(),
    };
  } catch (err) {
    activeLocalKernel = null;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      language: 'python',
      runtimeLabel: 'Local Python',
      outputs: [{ kind: 'error', message: msg }],
      durationMs: Math.round(performance.now() - started),
      plainSummary: msg,
      errorText: msg,
      timestamp: Date.now(),
    };
  }
}

export async function executeMindmapCCode(options: {
  source: string;
  isCpp: boolean;
  stdinInput?: string;
}): Promise<CodeExecutionResult> {
  const { source, isCpp, stdinInput } = options;
  const started = performance.now();
  const assembled = assembleCCellProgram(
    isCpp ? DEFAULT_CPP_PROLOGUE : DEFAULT_C_PROLOGUE,
    source,
    isCpp,
  );
  try {
    const res = await systemApi.runCCode({
      source: assembled,
      stdinInput: stdinInput?.trim() ? stdinInput : null,
      isCpp,
    });
    const outputs: CodeLabOutputItem[] = [];
    if (res.stdout.trim()) {
      outputs.push({ kind: 'stream', name: 'stdout', text: res.stdout });
    }
    if (res.stderr.trim()) {
      if (res.success) {
        outputs.push({ kind: 'stream', name: 'stderr', text: res.stderr });
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
    const { plainSummary, errorText } = summarizeOutputs(outputs, res.success);
    return {
      ok: res.success,
      language: isCpp ? 'cpp' : 'c',
      runtimeLabel: isCpp ? 'G++' : 'GCC',
      outputs,
      durationMs: res.durationMs || Math.round(performance.now() - started),
      exitCode: res.exitCode ?? null,
      stage: res.stage,
      plainSummary,
      errorText,
      timestamp: Date.now(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      language: isCpp ? 'cpp' : 'c',
      runtimeLabel: isCpp ? 'G++' : 'GCC',
      outputs: [{ kind: 'error', message: msg }],
      durationMs: Math.round(performance.now() - started),
      plainSummary: msg,
      errorText: msg,
      timestamp: Date.now(),
    };
  }
}

// =============================================================================
// Shared Per-CodeBlock Result Cache (keeps embedded outputs across SVG redraws)
// =============================================================================

const codeBlockResultCache = new Map<string, CodeExecutionResult>();
const resultListeners = new Map<
  string,
  Set<(result: CodeExecutionResult | null) => void>
>();

export function getCachedCodeBlockResult(
  key: string,
): CodeExecutionResult | null {
  return codeBlockResultCache.get(key) ?? null;
}

export function getAllCachedCodeBlockResults(): Record<
  string,
  CodeExecutionResult
> {
  return Object.fromEntries(codeBlockResultCache);
}

export function setCachedCodeBlockResult(
  key: string,
  result: CodeExecutionResult | null,
): void {
  if (result) {
    if (codeBlockResultCache.size > 120) {
      const oldest = codeBlockResultCache.keys().next().value;
      if (oldest !== undefined) codeBlockResultCache.delete(oldest);
    }
    codeBlockResultCache.set(key, result);
  } else {
    codeBlockResultCache.delete(key);
  }
  const listeners = resultListeners.get(key);
  if (listeners) {
    for (const fn of listeners) fn(result);
  }
}

export function subscribeCodeBlockResult(
  key: string,
  listener: (result: CodeExecutionResult | null) => void,
): () => void {
  let set = resultListeners.get(key);
  if (!set) {
    set = new Set();
    resultListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) {
      resultListeners.delete(key);
    }
  };
}
