import type { EditorView as CodeMirrorEditorView } from 'codemirror';

type AppTheme = 'light' | 'dark';

const maxVisualizationSource = 50_000;
let diagramId = 0;

type PythonWorkerMessage = {
  type: 'result' | 'error';
  output?: string;
  error?: string;
};

export interface CodeBlockHandlers {
  onCodeChange?: (language: string, previous: string, next: string) => void;
  onTerminalCommand?: (
    language: string,
    source: string,
    onResult: (output: string) => void,
  ) => void;
}

function normalizeFenceSource(source: string): string {
  return source.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

export function updateMarkdownCodeFence(
  markdown: string,
  language: string,
  previousSource: string,
  nextSource: string,
): string {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  for (let start = 0; start < lines.length; start += 1) {
    const opening = lines[start].match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
    if (!opening) continue;
    const infoLanguage = opening[2]
      .trim()
      .split(/[ \t]+/, 1)[0]
      ?.toLowerCase();
    if (infoLanguage !== language.toLowerCase()) continue;

    const fence = opening[1];
    let end = start + 1;
    for (; end < lines.length; end += 1) {
      const closing = lines[end].match(/^ {0,3}(`+|~+)\s*$/);
      if (
        closing &&
        closing[1][0] === fence[0] &&
        closing[1].length >= fence.length
      )
        break;
    }
    if (end === lines.length) continue;

    const body = lines.slice(start + 1, end).join('\n');
    if (normalizeFenceSource(body) !== normalizeFenceSource(previousSource)) {
      start = end;
      continue;
    }

    const replacement = normalizeFenceSource(nextSource).split('\n');
    lines.splice(start + 1, end - start - 1, ...replacement);
    return lines.join(lineEnding);
  }
  return markdown;
}

function createPanel(title: string, kind: string): HTMLElement {
  const panel = document.createElement('section');
  panel.className = `seamind-code-panel seamind-${kind}-panel`;
  panel.setAttribute('aria-label', title);

  const heading = document.createElement('div');
  heading.className = 'seamind-code-panel-heading';
  const label = document.createElement('strong');
  label.textContent = title;
  heading.append(label);
  panel.append(heading);
  return panel;
}

function replacePre(
  pre: HTMLElement,
  panel: HTMLElement,
  source: string,
  language: string,
): void {
  pre.dataset.seamindHydrated = 'true';
  panel.dataset.language = language;
  panel.dataset.sourceLength = String(source.length);
  pre.replaceWith(panel);
}

const safeSvgElements = new Set([
  'svg',
  'g',
  'path',
  'line',
  'circle',
  'rect',
  'ellipse',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'defs',
  'marker',
  'clippath',
  'style',
]);

const safeSvgAttributes = new Set([
  'xmlns',
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'x',
  'y',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'y1',
  'x2',
  'y2',
  'd',
  'points',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-rule',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'dx',
  'dy',
  'letter-spacing',
  'transform',
  'class',
  'id',
  'style',
  'marker-start',
  'marker-mid',
  'marker-end',
  'clip-path',
  'role',
  'aria-label',
  'aria-hidden',
]);

function isSafeSvgStyle(value: string): boolean {
  return (
    value.length <= 100_000 &&
    !/(?:@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding|url\(\s*(?!#))/i.test(
      value,
    ) &&
    /^[\w\s#.,:;{}()%[\]"'+/!*>-]+$/.test(value)
  );
}

function sanitizeMermaidSvg(source: string): SVGSVGElement | null {
  if (source.length > 300_000 || /<!doctype|<!entity/i.test(source))
    return null;
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = parsed.documentElement;
  if (
    parsed.querySelector('parsererror') ||
    root.localName.toLowerCase() !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  )
    return null;

  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  elements.forEach((element) => {
    const name = element.localName.toLowerCase();
    if (!safeSvgElements.has(name)) {
      element.remove();
      return;
    }
    if (name === 'style') {
      if (!isSafeSvgStyle(element.textContent ?? '')) element.remove();
      return;
    }
    Array.from(element.attributes).forEach((attribute) => {
      const key = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const valid =
        (key === 'xmlns' && value === 'http://www.w3.org/2000/svg') ||
        (key === 'viewbox' && /^[-+\d.eE,\s]+$/.test(value)) ||
        (key === 'id' && /^[\w-]{1,120}$/.test(value)) ||
        (key === 'class' && /^[\w\s-]{0,300}$/.test(value)) ||
        (key === 'style' && isSafeSvgStyle(value)) ||
        (['marker-start', 'marker-mid', 'marker-end', 'clip-path'].includes(
          key,
        ) &&
          /^url\(#[\w-]{1,120}\)$/.test(value)) ||
        ((key === 'fill' || key === 'stroke') &&
          /^(?:none|currentcolor|transparent|#[\da-f]{3,8}|[a-z]{1,20}|rgba?\([\d.,%\s]+\))$/i.test(
            value,
          )) ||
        (key === 'font-family' && /^[\w\s,'-]{1,100}$/.test(value)) ||
        (key === 'font-weight' && /^(?:normal|bold|[1-9]00)$/i.test(value)) ||
        (key === 'text-anchor' && ['start', 'middle', 'end'].includes(value)) ||
        (key === 'role' && ['img', 'presentation'].includes(value)) ||
        (key === 'aria-hidden' && ['true', 'false'].includes(value)) ||
        (key === 'aria-label' && value.length <= 240) ||
        (safeSvgAttributes.has(key) &&
          /^(?:[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?(?:px|%)?|[-+\d.eE,\s]+)$/i.test(
            value,
          ));
      if (!safeSvgAttributes.has(key) || !valid) {
        element.removeAttribute(attribute.name);
      }
    });
  });
  return root as unknown as SVGSVGElement;
}

function showError(container: HTMLElement, message: string): void {
  const error = document.createElement('p');
  error.className = 'seamind-code-error';
  error.textContent = message;
  container.replaceChildren(error);
}

function parseEChartsOption(source: string): Record<string, unknown> {
  if (source.length > maxVisualizationSource)
    throw new Error('ECharts JSON 超过 50 KB。');
  const candidate: unknown = JSON.parse(source);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('ECharts 代码块必须是 JSON 对象。');

  const option = candidate as Record<string, unknown>;
  if (Array.isArray(option.tooltip))
    throw new Error('tooltip 请使用单个对象，以保留安全的富文本渲染。');
  const series = option.series;
  if (series !== undefined) {
    if (!Array.isArray(series)) throw new Error('series 必须是数组。');
    const supported = new Set(['bar', 'line', 'pie', 'scatter']);
    for (const item of series) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('每个 series 都必须是 JSON 对象。');
      const type = (item as Record<string, unknown>).type;
      if (typeof type !== 'string' || !supported.has(type)) {
        throw new Error('目前支持 bar、line、pie 和 scatter 图表。');
      }
    }
  }

  const sanitize = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value))
      return value.map((item) => sanitize(item, key === 'symbol' ? key : ''));
    if (!value || typeof value !== 'object') {
      if (
        key === 'symbol' &&
        typeof value === 'string' &&
        value.startsWith('image://')
      )
        return 'circle';
      return value;
    }
    const result: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(
      ([childKey, child]) => {
        if (
          /^on/i.test(childKey) ||
          [
            'formatter',
            'renderItem',
            'graphic',
            'toolbox',
            'link',
            'href',
          ].includes(childKey)
        )
          return;
        result[childKey] = sanitize(child, childKey);
      },
    );
    if (key === 'tooltip') result.renderMode = 'richText';
    return result;
  };

  return sanitize(option) as Record<string, unknown>;
}

async function renderMermaid(
  source: string,
  output: HTMLElement,
  theme: AppTheme,
  signal: AbortSignal,
): Promise<void> {
  if (source.length > maxVisualizationSource)
    throw new Error('Mermaid 代码块超过 50 KB。');
  const { default: mermaid } = await import('mermaid');
  if (signal.aborted || !output.isConnected) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: maxVisualizationSource,
    maxEdges: 500,
    theme: theme === 'dark' ? 'dark' : 'neutral',
    flowchart: { htmlLabels: false, useMaxWidth: true },
  });
  const { svg } = await mermaid.render(
    `seamind-diagram-${++diagramId}`,
    source,
  );
  if (signal.aborted || !output.isConnected) return;
  const diagram = sanitizeMermaidSvg(svg);
  if (!diagram) throw new Error('Mermaid 输出未通过 SVG 安全检查。');
  diagram.setAttribute('role', 'img');
  diagram.setAttribute('aria-label', 'Mermaid 思维图');
  diagram.classList.add('seamind-diagram-svg');
  output.replaceChildren(diagram);
}

async function renderECharts(
  source: string,
  output: HTMLElement,
  theme: AppTheme,
  dispose: (callback: () => void) => void,
  signal: AbortSignal,
): Promise<void> {
  const option = parseEChartsOption(source);
  const [core, charts, components, renderers] = await Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers'),
  ]);
  if (signal.aborted || !output.isConnected) return;
  core.use([
    charts.BarChart,
    charts.LineChart,
    charts.PieChart,
    charts.ScatterChart,
    components.TitleComponent,
    components.TooltipComponent,
    components.LegendComponent,
    components.GridComponent,
    components.DatasetComponent,
    renderers.CanvasRenderer,
  ]);
  const chart = core.init(output, theme === 'dark' ? 'dark' : undefined, {
    renderer: 'canvas',
  });
  chart.setOption(option);
  const resizeObserver = new ResizeObserver(() => chart.resize());
  resizeObserver.observe(output);
  dispose(() => {
    resizeObserver.disconnect();
    chart.dispose();
  });
}

function createPythonPanel(
  pre: HTMLElement,
  source: string,
  language: string,
  theme: AppTheme,
  signal: AbortSignal,
  dispose: (callback: () => void) => void,
  onCodeChange?: CodeBlockHandlers['onCodeChange'],
): HTMLElement {
  const panel = createPanel('Python · 点击运行', 'python');
  const header = panel.querySelector<HTMLElement>(
    '.seamind-code-panel-heading',
  );
  const runButton = document.createElement('button');
  runButton.type = 'button';
  runButton.className = 'seamind-python-run';
  runButton.textContent = '运行';
  runButton.setAttribute('aria-label', '运行 Python 代码');
  header?.append(runButton);

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'seamind-python-edit';
  editButton.textContent = '编辑代码';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.textContent = '保存';
  saveButton.hidden = true;
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = '取消';
  cancelButton.hidden = true;
  header?.append(editButton, saveButton, cancelButton);

  const code = document.createElement('pre');
  code.className = 'seamind-python-source';
  const codeText = document.createElement('code');
  codeText.textContent = source;
  code.append(codeText);
  const editorHost = document.createElement('div');
  editorHost.className = 'seamind-python-editor';
  editorHost.hidden = true;
  const output = document.createElement('pre');
  output.className = 'seamind-python-output';
  output.textContent = '第三方包未启用；可直接使用 Python 标准库。';
  panel.append(code, editorHost, output);

  let currentSource = source;
  let persistedSource = source;
  let editor: CodeMirrorEditorView | null = null;
  let worker: Worker | null = null;
  let timeout: number | undefined;
  const closeEditor = () => {
    editor?.destroy();
    editor = null;
    editorHost.hidden = true;
    code.hidden = false;
    runButton.disabled = false;
    editButton.disabled = false;
    editButton.hidden = false;
    saveButton.hidden = true;
    cancelButton.hidden = true;
  };
  const startEditing = async () => {
    editButton.disabled = true;
    output.textContent = '正在加载 Python 编辑器…';
    try {
      const [codemirror, pythonLanguage] = await Promise.all([
        import('codemirror'),
        import('@codemirror/lang-python'),
      ]);
      if (signal.aborted) return;
      editorHost.hidden = false;
      code.hidden = true;
      runButton.disabled = true;
      editButton.hidden = true;
      saveButton.hidden = false;
      cancelButton.hidden = false;
      editor = new codemirror.EditorView({
        doc: currentSource,
        parent: editorHost,
        extensions: [
          codemirror.basicSetup,
          pythonLanguage.python(),
          codemirror.EditorView.theme(
            {
              '&': {
                fontSize: '12px',
                maxHeight: '240px',
                backgroundColor: theme === 'dark' ? '#11171b' : '#ffffff',
                color: theme === 'dark' ? '#d7e0e4' : '#263238',
              },
              '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace' },
              '.cm-gutters': {
                backgroundColor: theme === 'dark' ? '#11171b' : '#f5f7f8',
                color: theme === 'dark' ? '#71818a' : '#7a878d',
                border: 'none',
              },
            },
            { dark: theme === 'dark' },
          ),
        ],
      });
      editor.focus();
    } catch (error) {
      output.textContent = `编辑器加载失败：${error instanceof Error ? error.message : String(error)}`;
      editButton.disabled = false;
    }
  };
  const openEditor = () => void startEditing();
  const saveEditing = () => {
    if (!editor) return;
    currentSource = editor.state.doc.toString();
    codeText.textContent = currentSource;
    const previousSource = persistedSource;
    persistedSource = currentSource;
    closeEditor();
    onCodeChange?.(language, previousSource, currentSource);
    output.textContent = '代码已保存到 Markdown。';
  };
  const cancelEditing = () => {
    if (!editor) return;
    closeEditor();
    output.textContent = '已取消编辑，代码未更改。';
  };
  const run = () => {
    if (signal.aborted) return;
    if (timeout !== undefined) window.clearTimeout(timeout);
    if (currentSource.length > 30_000) {
      output.textContent = 'Python 代码块超过 30 KB。';
      return;
    }
    worker ??= new Worker(new URL('./python.worker.ts', import.meta.url), {
      type: 'module',
    });
    runButton.disabled = true;
    runButton.textContent = '启动中…';
    output.textContent = '正在启动 Python WebAssembly…';
    const workerRef = worker;
    worker.onmessage = (event: MessageEvent<PythonWorkerMessage>) => {
      if (worker !== workerRef) return;
      if (timeout !== undefined) window.clearTimeout(timeout);
      runButton.disabled = false;
      runButton.textContent = '重新运行';
      output.textContent =
        event.data.type === 'error'
          ? `错误：${event.data.error || '执行失败'}`
          : event.data.output || '执行完成（无输出）。';
    };
    worker.onerror = (event) => {
      if (worker !== workerRef) return;
      if (timeout !== undefined) window.clearTimeout(timeout);
      runButton.disabled = false;
      runButton.textContent = '重新运行';
      output.textContent = `Python Worker 错误：${event.message}`;
      worker?.terminate();
      worker = null;
    };
    const indexURL = new URL('pyodide/', document.baseURI).href;
    const moduleURL = new URL('pyodide/pyodide.mjs', document.baseURI).href;
    worker.postMessage({ source: currentSource, indexURL, moduleURL });
    timeout = window.setTimeout(() => {
      worker?.terminate();
      worker = null;
      runButton.disabled = false;
      runButton.textContent = '重新运行';
      output.textContent = '执行超过 20 秒，已停止本次 Python Worker。';
    }, 20_000);
  };
  runButton.addEventListener('click', run);
  editButton.addEventListener('click', openEditor);
  saveButton.addEventListener('click', saveEditing);
  cancelButton.addEventListener('click', cancelEditing);
  dispose(() => {
    runButton.removeEventListener('click', run);
    editButton.removeEventListener('click', openEditor);
    saveButton.removeEventListener('click', saveEditing);
    cancelButton.removeEventListener('click', cancelEditing);
    if (timeout !== undefined) window.clearTimeout(timeout);
    worker?.terminate();
    worker = null;
    editor?.destroy();
    editor = null;
  });
  replacePre(pre, panel, source, 'python');
  return panel;
}

function createTerminalCommandPanel(
  pre: HTMLElement,
  source: string,
  language: string,
  signal: AbortSignal,
  dispose: (callback: () => void) => void,
  onTerminalCommand?: CodeBlockHandlers['onTerminalCommand'],
): HTMLElement {
  const panel = createPanel(
    `${language.toUpperCase()} · 本机终端`,
    'terminal-code',
  );
  const header = panel.querySelector<HTMLElement>(
    '.seamind-code-panel-heading',
  );
  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'seamind-terminal-code-run';
  sendButton.textContent = '请求运行';
  sendButton.setAttribute('aria-label', '请求在本机终端运行此命令');
  header?.append(sendButton);
  const code = document.createElement('pre');
  code.className = 'seamind-terminal-code-source';
  code.textContent = source;
  const output = document.createElement('pre');
  output.className = 'seamind-terminal-code-output';
  output.hidden = true;
  const note = document.createElement('p');
  note.className = 'seamind-terminal-code-note';
  note.textContent = '点击后先预览完整命令；确认后才会在本机终端执行。';
  if (new TextEncoder().encode(source).length > 40_000) {
    sendButton.disabled = true;
    sendButton.textContent = '命令过长';
    note.textContent = '终端命令超过 40 KB，无法发送。';
  }
  panel.append(code, note, output);
  const requestRun = () => {
    if (signal.aborted) return;
    if (!onTerminalCommand) return;
    sendButton.disabled = true;
    sendButton.textContent = '等待确认';
    output.hidden = false;
    output.textContent = '等待确认并启动终端…';
    onTerminalCommand(language, source, (result) => {
      if (signal.aborted) return;
      output.textContent = result || '执行完成（无输出）。';
      sendButton.disabled = false;
      sendButton.textContent = '请求运行';
    });
  };
  sendButton.addEventListener('click', requestRun);
  dispose(() => sendButton.removeEventListener('click', requestRun));
  replacePre(pre, panel, source, language);
  return panel;
}

export async function hydrateCodeBlocks(
  svg: SVGSVGElement,
  theme: AppTheme,
  signal: AbortSignal,
  handlers: CodeBlockHandlers = {},
): Promise<() => void> {
  const cleanupCallbacks: Array<() => void> = [];
  let cleaned = false;
  const dispose = (callback: () => void) => cleanupCallbacks.push(callback);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupCallbacks
      .splice(0)
      .reverse()
      .forEach((callback) => callback());
    signal.removeEventListener('abort', cleanup);
  };
  signal.addEventListener('abort', cleanup, { once: true });

  const codeNodes = Array.from(
    svg.querySelectorAll<HTMLElement>(
      'g.markmap-node pre > code[class*="language-"]',
    ),
  );
  for (const code of codeNodes) {
    if (signal.aborted || cleaned) break;
    const pre = code.parentElement;
    if (!(pre instanceof HTMLElement) || pre.dataset.seamindHydrated) continue;
    const language = Array.from(code.classList)
      .find((name) => name.startsWith('language-'))
      ?.slice('language-'.length)
      .toLowerCase();
    const source = code.textContent ?? '';
    if (
      !language ||
      ![
        'mermaid',
        'echarts',
        'echart',
        'python',
        'py',
        'powershell',
        'pwsh',
      ].includes(language)
    )
      continue;

    if (language === 'python' || language === 'py') {
      createPythonPanel(
        pre,
        source,
        language,
        theme,
        signal,
        dispose,
        handlers.onCodeChange,
      );
      continue;
    }

    if (language === 'powershell' || language === 'pwsh') {
      createTerminalCommandPanel(
        pre,
        source,
        language,
        signal,
        dispose,
        handlers.onTerminalCommand,
      );
      continue;
    }

    const isMermaid = language === 'mermaid';
    const panel = createPanel(
      isMermaid ? 'MERMAID' : 'ECHARTS · JSON',
      isMermaid ? 'mermaid' : 'echarts',
    );
    const output = document.createElement('div');
    output.className = 'seamind-viz-output';
    panel.append(output);
    replacePre(pre, panel, source, language);

    if (isMermaid) {
      try {
        await renderMermaid(source, output, theme, signal);
      } catch (error) {
        if (!signal.aborted)
          showError(
            output,
            error instanceof Error ? error.message : 'Mermaid 渲染失败。',
          );
      }
    } else {
      try {
        await renderECharts(source, output, theme, dispose, signal);
      } catch (error) {
        if (!signal.aborted)
          showError(
            output,
            error instanceof Error ? error.message : 'ECharts 渲染失败。',
          );
      }
    }
  }
  if (signal.aborted) cleanup();
  return cleanup;
}
