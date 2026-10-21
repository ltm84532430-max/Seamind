import type { EditorView as CodeMirrorEditorView } from 'codemirror';
import { invoke } from '@tauri-apps/api/core';
import {
  createMathVisualizationOption,
  parseMathVisualizationSpec,
  type MathVisualizationResult,
  type MathVisualizationSpec,
  type MathVisualizationRangeControl,
  type MathVisualizationWorkerResponse,
} from './math-visualization';
import {
  renderMathSurface3d,
  type MathSurface3dController,
} from './math-surface-3d';

type AppTheme = 'light' | 'dark';

const maxVisualizationSource = 50_000;
let diagramId = 0;

interface EChartsController {
  setOption(option: Record<string, unknown>): void;
  dispose(): void;
}

type PythonWorkerMessage = {
  type: 'result' | 'error';
  output?: string;
  error?: string;
};

export interface CodeBlockHandlers {
  onCodeChange?: (
    language: string,
    previous: string,
    next: string,
    sourceRange?: CodeBlockSourceRange,
  ) => void | boolean;
  onOpenPlantUmlEditor?: (
    source: string,
    language: 'plantuml' | 'puml',
    onSave: (nextSource: string) => void,
    sourceRange?: CodeBlockSourceRange,
  ) => void;
  onMathVisualizationChange?: (
    language: string,
    previous: string,
    next: string,
    nodePath: string | null,
  ) => void;
  onTerminalCommand?: (
    language: string,
    source: string,
    onResult: (output: string) => void,
  ) => void;
}

export interface CodeBlockSourceRange {
  lineIndex: number;
  endLineIndex: number;
}

export interface CodeBlockHydrationOptions {
  mode?: 'mindmap' | 'markdown-preview';
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

export function updateMarkdownCodeFenceAtRange(
  markdown: string,
  language: string,
  lineIndex: number,
  endLineIndex: number,
  previousSource: string,
  nextSource: string,
): string {
  const lineEnding = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const targetStart = Math.max(0, lineIndex - 1);
  const targetEnd = Math.min(
    lines.length - 1,
    Math.max(lineIndex, endLineIndex),
  );
  for (let start = targetStart; start <= targetEnd; start += 1) {
    const opening = lines[start]?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
    if (!opening) continue;
    const infoLanguage = opening[2]
      .trim()
      .split(/[ \t]+/, 1)[0]
      ?.toLowerCase();
    if (infoLanguage !== language.toLowerCase()) continue;
    const fence = opening[1];
    let end = start + 1;
    for (; end < lines.length; end += 1) {
      const closing = lines[end]?.match(/^ {0,3}(`+|~+)\s*$/);
      if (
        closing &&
        closing[1][0] === fence[0] &&
        closing[1].length >= fence.length
      )
        break;
    }
    if (end >= lines.length || end < lineIndex || start > endLineIndex)
      continue;
    const body = lines.slice(start + 1, end).join('\n');
    if (normalizeFenceSource(body) !== normalizeFenceSource(previousSource))
      continue;
    lines.splice(
      start + 1,
      end - start - 1,
      ...normalizeFenceSource(nextSource).split('\n'),
    );
    return lines.join(lineEnding);
  }

  const matches: Array<[number, number]> = [];
  for (let start = 0; start < lines.length; start += 1) {
    const opening = lines[start]?.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/);
    if (!opening) continue;
    const infoLanguage = opening[2]
      .trim()
      .split(/[ \t]+/, 1)[0]
      ?.toLowerCase();
    if (infoLanguage !== language.toLowerCase()) continue;
    const fence = opening[1];
    let end = start + 1;
    for (; end < lines.length; end += 1) {
      const closing = lines[end]?.match(/^ {0,3}(`+|~+)\s*$/);
      if (
        closing &&
        closing[1][0] === fence[0] &&
        closing[1].length >= fence.length
      )
        break;
    }
    if (
      end < lines.length &&
      normalizeFenceSource(lines.slice(start + 1, end).join('\n')) ===
        normalizeFenceSource(previousSource)
    )
      matches.push([start, end]);
  }
  if (matches.length !== 1) return markdown;
  const [start, end] = matches[0]!;
  lines.splice(
    start + 1,
    end - start - 1,
    ...normalizeFenceSource(nextSource).split('\n'),
  );
  return lines.join(lineEnding);
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
  dispose: (callback: () => void) => void,
): void {
  pre.dataset.seamindHydrated = 'true';
  panel.dataset.language = language;
  panel.dataset.sourceLength = String(source.length);
  pre.replaceWith(panel);
  dispose(() => {
    // Markmap can reuse this foreignObject, so restore the source for the next hydration pass.
    delete pre.dataset.seamindHydrated;
    if (panel.isConnected) panel.replaceWith(pre);
  });
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

const safeSvgPathData = /^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\s]+$/;
const safeSvgPoints = /^[-+\d.eE,\s]+$/;

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
        (key === 'd' &&
          value.length <= 200_000 &&
          safeSvgPathData.test(value)) ||
        (key === 'points' &&
          value.length <= 100_000 &&
          safeSvgPoints.test(value)) ||
        (key === 'preserveaspectratio' &&
          /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/i.test(
            value,
          )) ||
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
  export const sanitizeDiagramSvg = sanitizeMermaidSvg;

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

async function renderPlantUml(
  source: string,
  output: HTMLElement,
  theme: AppTheme,
  signal: AbortSignal,
): Promise<void> {
  if (source.length > maxVisualizationSource)
    throw new Error('PlantUML 源码超过 50 KB。');
  if (signal.aborted || !output.isConnected) return;
  const result = await invoke<{ svg: string; diagnostics: string[] }>(
    'render_plantuml',
    { source, dark: theme === 'dark', authorizedIncludeDirectory: null },
  );
  if (signal.aborted || !output.isConnected) return;
  const diagram = sanitizeMermaidSvg(result.svg);
  if (!diagram) throw new Error('PlantUML 输出未通过 SVG 安全检查。');
  diagram.setAttribute('role', 'img');
  diagram.setAttribute('aria-label', 'PlantUML 图表');
  diagram.classList.add('seamind-diagram-svg');
  output.replaceChildren(diagram);
  if (result.diagnostics?.length) {
    const status = document.createElement('small');
    status.className = 'seamind-plantuml-diagnostics';
    status.textContent = result.diagnostics.join(' · ');
    output.append(status);
  }
}

async function renderEChartsOption(
  option: Record<string, unknown>,
  output: HTMLElement,
  theme: AppTheme,
  dispose: (callback: () => void) => void,
  signal: AbortSignal,
): Promise<EChartsController | null> {
  const [core, charts, components, renderers] = await Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers'),
  ]);
  if (signal.aborted || !output.isConnected) return null;
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
  output.replaceChildren();
  const chart = core.init(output, theme === 'dark' ? 'dark' : undefined, {
    renderer: 'canvas',
  });
  chart.setOption(option);
  const resizeObserver = new ResizeObserver(() => chart.resize());
  resizeObserver.observe(output);
  let disposed = false;
  const controller: EChartsController = {
    setOption(nextOption) {
      if (!disposed) chart.setOption(nextOption, { notMerge: true });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resizeObserver.disconnect();
      chart.dispose();
    },
  };
  dispose(controller.dispose);
  return controller;
}

async function renderECharts(
  source: string,
  output: HTMLElement,
  theme: AppTheme,
  dispose: (callback: () => void) => void,
  signal: AbortSignal,
): Promise<void> {
  await renderEChartsOption(
    parseEChartsOption(source),
    output,
    theme,
    dispose,
    signal,
  );
}

async function renderMathVisualization(
  source: string,
  panel: HTMLElement,
  output: HTMLElement,
  theme: AppTheme,
  dispose: (callback: () => void) => void,
  signal: AbortSignal,
  handlers: CodeBlockHandlers,
  nodePath: string | null,
  readOnly = false,
): Promise<void> {
  let currentSpec = parseMathVisualizationSpec(source);
  if (signal.aborted) return;
  const controls = document.createElement('div');
  controls.className = 'seamind-math-controls';
  const status = document.createElement('span');
  status.className = 'seamind-math-control-status';
  const applyButton = document.createElement('button');
  applyButton.type = 'button';
  applyButton.className = 'seamind-math-apply';
  applyButton.textContent = '应用到 Markdown';
  applyButton.disabled = true;
  const actionRow = document.createElement('div');
  actionRow.className = 'seamind-math-control-actions';
  actionRow.append(status, applyButton);
  const apply = () => {
    if (handlers.onMathVisualizationChange) {
      handlers.onMathVisualizationChange(
        panel.dataset.language || 'seamind-math',
        source,
        JSON.stringify(currentSpec, null, 2),
        nodePath,
      );
      status.textContent = '已写入 Markdown';
      applyButton.disabled = true;
    } else {
      status.textContent = '当前无法写入 Markdown';
    }
  };
  applyButton.addEventListener('click', apply);
  dispose(() => applyButton.removeEventListener('click', apply));

  let chart: EChartsController | null = null;
  let surfaceRenderer: MathSurface3dController | null = null;
  let chartCreation: Promise<EChartsController | null> | null = null;
  let activeRequest:
    | {
        worker: Worker;
        cancel: () => void;
      }
    | undefined;
  let requestTimer: number | undefined;
  let renderTimer: number | undefined;
  let renderRevision = 0;
  const cancelActiveRequest = () => activeRequest?.cancel();
  dispose(() => {
    if (requestTimer !== undefined) window.clearTimeout(requestTimer);
    if (renderTimer !== undefined) window.clearTimeout(renderTimer);
    cancelActiveRequest();
  });

  const calculate = (spec: MathVisualizationSpec) =>
    new Promise<MathVisualizationResult>((resolve, reject) => {
      cancelActiveRequest();
      const worker = new Worker(
        new URL('./math-visualization.worker.ts', import.meta.url),
        { type: 'module' },
      );
      const id = ++diagramId;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (requestTimer !== undefined) window.clearTimeout(requestTimer);
        signal.removeEventListener('abort', handleAbort);
        worker.terminate();
        if (activeRequest?.worker === worker) activeRequest = undefined;
        callback();
      };
      const handleAbort = () =>
        finish(() => reject(new Error('数学可视化计算已取消。')));
      const cancel = () =>
        finish(() => reject(new Error('数学可视化计算已被新参数替换。')));
      activeRequest = { worker, cancel };
      worker.onmessage = (
        event: MessageEvent<MathVisualizationWorkerResponse>,
      ) => {
        if (event.data.id !== id) return;
        finish(() => {
          if (event.data.error) reject(new Error(event.data.error));
          else if (event.data.result) resolve(event.data.result);
          else reject(new Error('数学可视化 Worker 返回了空结果。'));
        });
      };
      worker.onerror = (event) =>
        finish(() =>
          reject(new Error(event.message || '数学可视化 Worker 执行失败。')),
        );
      signal.addEventListener('abort', handleAbort, { once: true });
      requestTimer = window.setTimeout(
        () =>
          finish(() => reject(new Error('数学可视化计算超过 8 秒，已停止。'))),
        8_000,
      );
      worker.postMessage({ id, spec });
    });

  const draw = async (spec: MathVisualizationSpec, revision: number) => {
    try {
      const result = await calculate(spec);
      if (signal.aborted || revision !== renderRevision || !output.isConnected)
        return;
      if (spec.kind === 'surface-3d') {
        if (!result.surface) throw new Error('三维曲面计算没有返回网格数据。');
        if (!surfaceRenderer) {
          surfaceRenderer = renderMathSurface3d(
            output,
            theme,
            spec,
            result.surface,
          );
          dispose(surfaceRenderer.dispose);
        } else surfaceRenderer.setSurface(spec, result.surface);
        return;
      }
      const option = createMathVisualizationOption(spec, result);
      if (!chart) {
        chartCreation ??= renderEChartsOption(
          option,
          output,
          theme,
          dispose,
          signal,
        ).then((created) => {
          chart = created;
          return created;
        });
        const pendingCreation = chartCreation;
        let renderer: EChartsController | null;
        try {
          renderer = await pendingCreation;
        } finally {
          if (chartCreation === pendingCreation) chartCreation = null;
        }
        if (signal.aborted || revision !== renderRevision || !renderer) return;
        renderer.setOption(option);
      } else chart.setOption(option);
    } catch (error) {
      if (signal.aborted || revision !== renderRevision) return;
      chart?.dispose();
      chart = null;
      surfaceRenderer?.dispose();
      surfaceRenderer = null;
      showError(
        output,
        error instanceof Error ? error.message : '数学可视化计算失败。',
      );
    }
  };

  const scheduleDraw = () => {
    renderRevision += 1;
    const revision = renderRevision;
    if (renderTimer !== undefined) window.clearTimeout(renderTimer);
    cancelActiveRequest();
    renderTimer = window.setTimeout(
      () => void draw(currentSpec, revision),
      100,
    );
  };

  const addSlider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onInput: (value: number) => void,
  ) => {
    const field = document.createElement('label');
    field.className = 'seamind-math-control';
    const heading = document.createElement('span');
    heading.className = 'seamind-math-control-label';
    heading.textContent = label;
    const valueLabel = document.createElement('output');
    valueLabel.textContent = String(value);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const update = () => {
      valueLabel.textContent = input.value;
      onInput(Number(input.value));
    };
    input.addEventListener('input', update);
    field.append(heading, valueLabel, input);
    controls.append(field);
    dispose(() => input.removeEventListener('input', update));
    return {
      input,
      setRange(nextMin: number, nextMax: number) {
        input.min = String(nextMin);
        input.max = String(nextMax);
      },
      setValue(nextValue: number) {
        input.value = String(nextValue);
        valueLabel.textContent = String(nextValue);
      },
    };
  };

  const markChanged = () => {
    applyButton.disabled = false;
    status.textContent = '拖动预览中；点击应用后写回源文本';
  };
  const setDomainRange = (
    spec: MathVisualizationSpec,
    axis: 'x' | 'y',
    range: [number, number],
  ) => {
    if (axis === 'x') spec.domain.x = range;
    else if (
      spec.kind === 'contour-2d' ||
      spec.kind === 'vector-field-2d' ||
      spec.kind === 'surface-3d'
    )
      spec.domain.y = range;
  };
  const getDomainRange = (
    spec: MathVisualizationSpec,
    axis: 'x' | 'y',
  ): [number, number] | undefined => {
    if (axis === 'x') return spec.domain.x;
    if (
      spec.kind === 'contour-2d' ||
      spec.kind === 'vector-field-2d' ||
      spec.kind === 'surface-3d'
    )
      return spec.domain.y;
    return undefined;
  };
  const addPair = (
    label: string,
    current: [number, number],
    bounds: MathVisualizationRangeControl,
    onInput: (range: [number, number]) => void,
  ) => {
    let range: [number, number] = [...current];
    const sliders: ReturnType<typeof addSlider>[] = [];
    const sync = () => {
      const low = sliders[0];
      const high = sliders[1];
      if (!low || !high) return;
      low.setRange(bounds.min, range[1] - bounds.step);
      high.setRange(range[0] + bounds.step, bounds.max);
      low.setValue(range[0]);
      high.setValue(range[1]);
    };
    sliders.push(
      addSlider(
        label + ' 下限',
        range[0],
        bounds.min,
        range[1] - bounds.step,
        bounds.step,
        (value) => {
          range = [Math.min(value, range[1] - bounds.step), range[1]];
          sync();
          onInput([...range]);
        },
      ),
    );
    sliders.push(
      addSlider(
        label + ' 上限',
        range[1],
        range[0] + bounds.step,
        bounds.max,
        bounds.step,
        (value) => {
          range = [range[0], Math.max(value, range[0] + bounds.step)];
          sync();
          onInput([...range]);
        },
      ),
    );
    sync();
  };

  Object.entries(currentSpec.parameters ?? {}).forEach(([name, parameter]) => {
    addSlider(
      parameter.label || name,
      parameter.value,
      parameter.min,
      parameter.max,
      parameter.step,
      (value) => {
        const next = JSON.parse(
          JSON.stringify(currentSpec),
        ) as MathVisualizationSpec;
        if (next.parameters) next.parameters[name]!.value = value;
        currentSpec = next;
        markChanged();
        scheduleDraw();
      },
    );
  });
  (['x', 'y'] as const).forEach((axis) => {
    const bounds = currentSpec.controls?.domain?.[axis];
    const range = getDomainRange(currentSpec, axis);
    if (!bounds || !range) return;
    addPair(axis + ' 范围', range, bounds, (nextRange) => {
      const next = JSON.parse(
        JSON.stringify(currentSpec),
      ) as MathVisualizationSpec;
      setDomainRange(next, axis, nextRange);
      currentSpec = next;
      markChanged();
      scheduleDraw();
    });
  });
  if (currentSpec.kind === 'integral-1d' && currentSpec.controls?.interval) {
    addPair(
      '积分区间',
      currentSpec.interval,
      currentSpec.controls.interval,
      (range) => {
        const next = JSON.parse(
          JSON.stringify(currentSpec),
        ) as MathVisualizationSpec;
        if (next.kind === 'integral-1d') next.interval = range;
        currentSpec = next;
        markChanged();
        scheduleDraw();
      },
    );
  }

  if (controls.childElementCount > 0) {
    controls.addEventListener('pointerdown', (event) =>
      event.stopPropagation(),
    );
    panel.append(controls, actionRow);
    if (readOnly) {
      controls.hidden = true;
      actionRow.hidden = true;
    }
    dispose(() => {
      controls.replaceChildren();
      actionRow.remove();
    });
  } else {
    applyButton.removeEventListener('click', apply);
  }
  void draw(currentSpec, ++renderRevision);
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
  replacePre(pre, panel, source, 'python', dispose);
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
  replacePre(pre, panel, source, language, dispose);
  return panel;
}

export async function hydrateCodeBlocks(
  container: ParentNode,
  theme: AppTheme,
  signal: AbortSignal,
  handlers: CodeBlockHandlers = {},
  options: CodeBlockHydrationOptions = {},
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
    container.querySelectorAll<HTMLElement>('pre > code[class*="language-"]'),
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
        'seamind-math',
        'seamind-viz',
        'python',
        'py',
        'powershell',
        'pwsh',
      ].includes(language)
    )
      continue;

    if (language === 'python' || language === 'py') {
      if (options.mode === 'markdown-preview') continue;
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
      if (options.mode === 'markdown-preview') continue;
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
    const isPlantUml = language === 'plantuml' || language === 'puml';
    const isMathVisualization =
      language === 'seamind-math' || language === 'seamind-viz';
    const panel = createPanel(
      isMermaid
        ? 'MERMAID'
        : isPlantUml
          ? 'PLANTUML'
          : isMathVisualization
            ? '数学可视化'
            : 'ECharts 图表',
      isMermaid
        ? 'mermaid'
        : isPlantUml
          ? 'plantuml'
          : isMathVisualization
            ? 'math'
            : 'echarts',
    );
    if (isPlantUml && handlers.onOpenPlantUmlEditor) {
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'seamind-plantuml-edit';
      editButton.textContent = '在画布中编辑';
      editButton.setAttribute('aria-label', '在思维导图画布中编辑 PlantUML');
      let persistedSource = source;
      const lineRange = pre.dataset.lines?.split(',').map(Number);
      const sourceRange =
        lineRange?.length === 2 && lineRange.every(Number.isFinite)
          ? { lineIndex: lineRange[0]! + 1, endLineIndex: lineRange[1]! }
          : undefined;
      const openEditor = () => {
        handlers.onOpenPlantUmlEditor?.(
          persistedSource,
          language as 'plantuml' | 'puml',
          (nextSource) => {
            const updated = handlers.onCodeChange?.(
              language,
              persistedSource,
              nextSource,
              sourceRange,
            );
            if (updated === false)
              throw new Error('无法定位原 PlantUML 围栏，Markdown 未更新。');
            persistedSource = nextSource;
          },
          sourceRange,
        );
      };
      editButton.addEventListener('click', openEditor);
      panel.querySelector('.seamind-code-panel-heading')?.append(editButton);
      dispose(() => editButton.removeEventListener('click', openEditor));
    }
    const output = document.createElement('div');
    output.className = 'seamind-viz-output';
    panel.append(output);
    replacePre(pre, panel, source, language, dispose);

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
    } else if (isPlantUml) {
      try {
        await renderPlantUml(source, output, theme, signal);
      } catch (error) {
        if (!signal.aborted)
          showError(
            output,
            error instanceof Error ? error.message : 'PlantUML 渲染失败。',
          );
      }
    } else if (isMathVisualization) {
      try {
        await renderMathVisualization(
          source,
          panel,
          output,
          theme,
          dispose,
          signal,
          handlers,
          pre
            .closest<SVGGElement>('g.markmap-node')
            ?.getAttribute('data-path') ?? null,
          options.mode === 'markdown-preview',
        );
      } catch (error) {
        if (!signal.aborted)
          showError(
            output,
            error instanceof Error ? error.message : '数学可视化渲染失败。',
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
