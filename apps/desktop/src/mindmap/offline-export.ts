import type { PureNode } from 'markmap-lib';
import {
  katexCss,
  viewerCss,
  viewerScript,
} from 'virtual:seamind-offline-viewer';
import type {
  MindmapMediaBounds,
  MindmapStyle,
  NodeSpacing,
  Theme,
} from '../app/app-storage';
import { libraryApi } from '../library/library-api';
import { mediaIdFromSource } from '../knowledge/knowledge-paste';
import { computeCodeBlockResultKey } from '../workbench/code-syntax-utils';
import {
  getAllCachedCodeBlockResults,
  type CodeExecutionResult,
} from '../workbench/code-execution-service';
import { getCodeCardStateSnapshot } from '../workbench/mindmap-code-card';
import { getMediaCardStateSnapshot } from '../workbench/mindmap-media-card';
import { getNoteCardStateSnapshot } from '../workbench/mindmap-note-card';
import { getTableCardStateSnapshot } from '../workbench/mindmap-table-card';
import {
  parseExcelFenceDescriptor,
  type StoredExcelTablePayload,
} from './mindmap-excel';
import {
  buildStandaloneMindmapHtml,
  offlineDiagramSnapshotKey,
  type MindmapOfflineExportSnapshot,
  type OfflineDiagramSnapshot,
  type OfflineTransformState,
} from './offline-viewer-shared';

export interface OfflineExportOptions {
  scope: 'full' | 'focused';
  preserveFoldAndView: boolean;
  includeMediaAndExcel: boolean;
  includeCodeResults: boolean;
  includeNotes: boolean;
}

export interface OfflineExportStats {
  nodeCount: number;
  mediaCount: number;
  excelCount: number;
  noteCount: number;
  codeCount: number;
  hasMath: boolean;
}

function cloneTreeFiltered(node: PureNode, includeNotes: boolean): PureNode {
  let content = node.content;
  if (!includeNotes && content.includes('seamind-node-note')) {
    const doc = new DOMParser().parseFromString(content, 'text/html');
    doc.body
      .querySelectorAll('.seamind-node-note')
      .forEach((el) => el.remove());
    content = doc.body.innerHTML;
  }
  return {
    content,
    ...(node.payload ? { payload: { ...node.payload } } : {}),
    children: (node.children || []).map((child) =>
      cloneTreeFiltered(child, includeNotes),
    ),
  };
}

export function analyzeExportTreeStats(
  root: PureNode,
  includeNotes = true,
): OfflineExportStats {
  let nodeCount = 0;
  let mediaCount = 0;
  let excelCount = 0;
  let noteCount = 0;
  let codeCount = 0;
  let hasMath = false;

  const visit = (node: PureNode) => {
    nodeCount += 1;
    const html = node.content || '';
    if (html.includes('katex') || html.includes('$')) hasMath = true;
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    mediaCount += parsed.body.querySelectorAll('img').length;
    if (includeNotes) {
      noteCount += parsed.body.querySelectorAll('.seamind-node-note').length;
    }
    parsed.body.querySelectorAll('pre > code').forEach((codeEl) => {
      const lang =
        Array.from(codeEl.classList)
          .find((c) => c.startsWith('language-'))
          ?.slice('language-'.length)
          .toLowerCase() ?? '';
      if (lang === 'seamind-excel') {
        excelCount += 1;
      } else {
        codeCount += 1;
      }
    });
    (node.children || []).forEach(visit);
  };
  visit(root);

  return {
    nodeCount,
    mediaCount,
    excelCount,
    noteCount,
    codeCount,
    hasMath,
  };
}

export function collectLiveFoldMapFromMarkmap(
  liveRoot: unknown,
): Record<string, number> {
  const folds: Record<string, number> = {};
  const walk = (node: any) => {
    if (!node) return;
    const path = node.state?.path;
    if (typeof path === 'string' && path && node.payload?.fold) {
      folds[path] = Number(node.payload.fold) || 1;
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };
  walk(liveRoot);
  return folds;
}

export function captureCanvasTransform(
  markmap: { getTransform?: () => OfflineTransformState } | null,
): OfflineTransformState | null {
  if (!markmap?.getTransform) return null;
  try {
    const t = markmap.getTransform();
    if (
      Number.isFinite(t.k) &&
      Number.isFinite(t.x) &&
      Number.isFinite(t.y) &&
      t.k > 0
    ) {
      return { k: t.k, x: t.x, y: t.y };
    }
  } catch {
    // ignore uninitialized zoom
  }
  return null;
}

export function captureLiveCanvasDiagrams(
  svg: SVGSVGElement | null,
): Record<string, OfflineDiagramSnapshot> {
  const snapshots: Record<string, OfflineDiagramSnapshot> = {};
  if (!svg) return snapshots;

  const panels = Array.from(
    svg.querySelectorAll<HTMLElement>(
      '.seamind-code-panel, .seamind-viz-panel',
    ),
  );
  for (const panel of panels) {
    const lang = (panel.dataset.language || '').trim().toLowerCase();
    const source = (
      panel.dataset.seamindSource ||
      panel.dataset.source ||
      ''
    ).trim();
    if (!lang || !source) continue;
    const key = offlineDiagramSnapshotKey(lang, source);
    if (snapshots[key]) continue;

    let snapshot: OfflineDiagramSnapshot | null = null;
    const svgEl = panel.querySelector<SVGSVGElement>(
      '.seamind-viz-output svg, .seamind-mermaid-output svg, .seamind-plantuml-output svg',
    );
    if (svgEl) {
      const clone = svgEl.cloneNode(true) as SVGSVGElement;
      if (!clone.getAttribute('xmlns')) {
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      }
      const rect = svgEl.getBoundingClientRect?.();
      if (rect && rect.width > 1 && rect.height > 1) {
        const width = String(Math.round(rect.width));
        const height = String(Math.round(rect.height));
        clone.setAttribute('width', width);
        clone.setAttribute('height', height);
        if (!clone.getAttribute('viewBox')) {
          clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
        }
      }
      snapshot = {
        kind: 'svg',
        language: lang,
        markupOrUrl: new XMLSerializer().serializeToString(clone),
      };
    } else {
      const canvasEl = panel.querySelector<HTMLCanvasElement>('canvas');
      if (canvasEl && canvasEl.width > 1 && canvasEl.height > 1) {
        try {
          snapshot = {
            kind: 'image',
            language: lang,
            markupOrUrl: canvasEl.toDataURL('image/png'),
          };
        } catch {
          // Ignore tainted canvas
        }
      }
    }
    if (!snapshot) continue;
    snapshots[key] = snapshot;
    const alias = computeCodeBlockResultKey(lang, source);
    if (!snapshots[alias]) snapshots[alias] = snapshot;
  }

  return snapshots;
}

async function resolveMediaDataUrlMap(
  root: PureNode,
  documentRelativePath?: string,
  liveSvg?: SVGSVGElement | null,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const mediaIds = new Set<string>();

  const scan = (node: PureNode) => {
    const doc = new DOMParser().parseFromString(
      node.content || '',
      'text/html',
    );
    doc.body.querySelectorAll('img[src]').forEach((img) => {
      const id = mediaIdFromSource(img.getAttribute('src') ?? '');
      if (id) mediaIds.add(id);
    });
    (node.children || []).forEach(scan);
  };
  scan(root);

  if (mediaIds.size === 0) return result;

  if (documentRelativePath) {
    await Promise.all(
      [...mediaIds].map(async (mediaId) => {
        try {
          const dataUrl = await libraryApi.readDocumentMediaDataUrl({
            documentRelativePath,
            mediaId,
          });
          if (dataUrl) result.set(mediaId, dataUrl);
        } catch {
          // Fallback below to live canvas image conversion
        }
      }),
    );
  }

  // Fallback for any unresolved image currently loaded in canvas DOM
  if (liveSvg) {
    for (const img of Array.from(
      liveSvg.querySelectorAll<HTMLImageElement>('img[data-seamind-media-id]'),
    )) {
      const mediaId = img.dataset.seamindMediaId;
      if (!mediaId || result.has(mediaId)) continue;
      if (img.complete && img.naturalWidth > 0) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            result.set(mediaId, canvas.toDataURL('image/png'));
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return result;
}

function inlineMediaDataUrlsInTree(
  node: PureNode,
  mediaMap: Map<string, string>,
): PureNode {
  let content = node.content || '';
  if (mediaMap.size > 0 && content.includes('seamind-media:')) {
    const doc = new DOMParser().parseFromString(content, 'text/html');
    let mutated = false;
    doc.body.querySelectorAll('img[src]').forEach((img) => {
      const id = mediaIdFromSource(img.getAttribute('src') ?? '');
      const replacement = id ? mediaMap.get(id) : undefined;
      if (replacement) {
        img.setAttribute('src', replacement);
        mutated = true;
      }
    });
    if (mutated) content = doc.body.innerHTML;
  }
  return {
    ...node,
    content,
    children: (node.children || []).map((child) =>
      inlineMediaDataUrlsInTree(child, mediaMap),
    ),
  };
}

async function loadExcelDatasetsForTree(
  root: PureNode,
  documentRelativePath?: string,
): Promise<Record<string, StoredExcelTablePayload>> {
  const datasets: Record<string, StoredExcelTablePayload> = {};
  if (!documentRelativePath) return datasets;

  const assetIds = new Set<string>();
  const scan = (node: PureNode) => {
    const doc = new DOMParser().parseFromString(
      node.content || '',
      'text/html',
    );
    doc.body
      .querySelectorAll('pre > code.language-seamind-excel')
      .forEach((el) => {
        const parsed = parseExcelFenceDescriptor(el.textContent ?? '');
        if (parsed?.assetId) assetIds.add(parsed.assetId);
      });
    (node.children || []).forEach(scan);
  };
  scan(root);

  await Promise.all(
    [...assetIds].map(async (assetId) => {
      try {
        const rawJson = await libraryApi.readMindmapTableAsset({
          documentRelativePath,
          assetId,
        });
        datasets[assetId] = JSON.parse(rawJson) as StoredExcelTablePayload;
      } catch {
        // Descriptor previewRows remain available inside the fence
      }
    }),
  );

  return datasets;
}

function collectRelevantCodeResults(
  root: PureNode,
): Record<string, CodeExecutionResult> {
  const allResults = getAllCachedCodeBlockResults();
  const matched: Record<string, CodeExecutionResult> = {};
  const entries = Object.entries(allResults);
  if (entries.length === 0) return matched;

  const scan = (node: PureNode) => {
    const doc = new DOMParser().parseFromString(
      node.content || '',
      'text/html',
    );
    doc.body.querySelectorAll('pre > code').forEach((codeEl) => {
      const lang =
        Array.from(codeEl.classList)
          .find((n) => n.startsWith('language-'))
          ?.slice('language-'.length)
          .toLowerCase() ?? '';
      if (!lang || lang === 'seamind-excel') return;
      const source = codeEl.textContent ?? '';
      const anyKey = computeCodeBlockResultKey(lang, source);
      const hashSuffix = anyKey.split(':').at(-1) ?? '';
      const found =
        allResults[anyKey] ??
        entries.find(([k]) => k.endsWith(`:${hashSuffix}`))?.[1];
      if (found) {
        matched[anyKey] = found;
      }
    });
    (node.children || []).forEach(scan);
  };
  scan(root);

  return matched;
}

function hashExportFingerprint(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function generateOfflineMindmapHtml(params: {
  title: string;
  documentId?: string | null;
  documentRelativePath?: string | null;
  targetRoot: PureNode;
  liveMarkmap: {
    state?: { data?: unknown };
    getTransform?: () => OfflineTransformState;
  } | null;
  svg: SVGSVGElement | null;
  style: MindmapStyle;
  theme: Theme;
  direction: 'both' | 'right' | 'down';
  spacing: NodeSpacing;
  mediaBounds: MindmapMediaBounds;
  options: OfflineExportOptions;
}): Promise<{ html: string; stats: OfflineExportStats }> {
  const {
    title,
    documentId,
    documentRelativePath,
    targetRoot,
    liveMarkmap,
    svg,
    style,
    theme,
    direction,
    spacing,
    mediaBounds,
    options,
  } = params;

  let exportTree = cloneTreeFiltered(targetRoot, options.includeNotes);
  const docRelPath = documentRelativePath ?? undefined;

  let excelDatasets: Record<string, StoredExcelTablePayload> = {};
  if (options.includeMediaAndExcel) {
    const mediaMap = await resolveMediaDataUrlMap(exportTree, docRelPath, svg);
    exportTree = inlineMediaDataUrlsInTree(exportTree, mediaMap);
    excelDatasets = await loadExcelDatasetsForTree(exportTree, docRelPath);
  }

  const stats = analyzeExportTreeStats(exportTree, options.includeNotes);
  const foldByPath = options.preserveFoldAndView
    ? collectLiveFoldMapFromMarkmap(liveMarkmap?.state?.data ?? null)
    : {};
  const transform = options.preserveFoldAndView
    ? captureCanvasTransform(liveMarkmap)
    : null;
  const svgRect = svg?.getBoundingClientRect?.();
  const viewport =
    options.preserveFoldAndView &&
    svgRect &&
    Number.isFinite(svgRect.width) &&
    Number.isFinite(svgRect.height) &&
    svgRect.width > 64 &&
    svgRect.height > 64
      ? {
          width: Math.round(svgRect.width),
          height: Math.round(svgRect.height),
        }
      : null;

  const tableState = getTableCardStateSnapshot();
  const noteState = getNoteCardStateSnapshot();
  const codeState = getCodeCardStateSnapshot();
  const customMediaWidths = getMediaCardStateSnapshot();

  const snapshot: MindmapOfflineExportSnapshot = {
    version: 1,
    exportId: `${documentId || hashExportFingerprint(title + exportTree.content)}`,
    title,
    exportedAt: new Date().toISOString(),
    style,
    theme,
    direction,
    spacing,
    mediaBounds,
    viewport,
    transform,
    foldByPath,
    cardStates: {
      collapsedTables: options.preserveFoldAndView
        ? tableState.collapsedTables
        : [],
      excelPages: options.preserveFoldAndView ? tableState.excelPages : {},
      collapsedNotes: options.preserveFoldAndView
        ? noteState.collapsedNotes
        : [],
      expandedNotes: options.preserveFoldAndView ? noteState.expandedNotes : [],
      collapsedCodeCards: options.preserveFoldAndView
        ? codeState.collapsedCodeCards
        : [],
      collapsedCodeOutputs: options.preserveFoldAndView
        ? codeState.collapsedCodeOutputs
        : [],
      customMediaWidths: options.preserveFoldAndView ? customMediaWidths : {},
    },
    excelDatasets,
    diagramSnapshots: captureLiveCanvasDiagrams(svg),
    codeResults: options.includeCodeResults
      ? collectRelevantCodeResults(exportTree)
      : {},
    root: exportTree,
  };

  const html = buildStandaloneMindmapHtml(snapshot, {
    viewerScript,
    viewerCss,
    katexCss: stats.hasMath ? katexCss : '',
  });

  return { html, stats };
}
