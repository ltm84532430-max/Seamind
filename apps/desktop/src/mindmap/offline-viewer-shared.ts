import type { PureNode } from 'markmap-lib';
import type {
  MindmapMediaBounds,
  MindmapStyle,
  NodeSpacing,
  Theme,
} from '../app/app-storage';
import type { CodeExecutionResult } from '../workbench/code-execution-service';
import type { StoredExcelTablePayload } from './mindmap-excel';

export interface OfflineTransformState {
  k: number;
  x: number;
  y: number;
}

export interface OfflineDiagramSnapshot {
  kind: 'svg' | 'image';
  markupOrUrl: string;
  language: string;
}

/** Key shared by the live-canvas capture and the offline viewer lookup. */
export function offlineDiagramSnapshotKey(
  language: string,
  source: string,
): string {
  return `${language.trim().toLowerCase()}:${source.trim()}`;
}

export interface OfflineCardStates {
  collapsedTables: string[];
  excelPages: Record<string, number>;
  collapsedNotes: string[];
  expandedNotes: string[];
  collapsedCodeCards: string[];
  collapsedCodeOutputs: string[];
  customMediaWidths: Record<string, number>;
}

export interface MindmapOfflineExportSnapshot {
  version: 1;
  exportId: string;
  title: string;
  exportedAt: string;
  style: MindmapStyle;
  theme: Theme;
  direction: 'both' | 'right' | 'down';
  spacing: NodeSpacing;
  mediaBounds: MindmapMediaBounds;
  viewport?: { width: number; height: number } | null;
  transform: OfflineTransformState | null;
  foldByPath: Record<string, number>;
  cardStates: OfflineCardStates;
  excelDatasets: Record<string, StoredExcelTablePayload>;
  diagramSnapshots: Record<string, OfflineDiagramSnapshot>;
  codeResults: Record<string, CodeExecutionResult>;
  root: PureNode;
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function serializeSnapshotForScriptTag(
  snapshot: MindmapOfflineExportSnapshot,
): string {
  return JSON.stringify(snapshot)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function buildStandaloneMindmapHtml(
  snapshot: MindmapOfflineExportSnapshot,
  assets: {
    viewerScript: string;
    viewerCss: string;
    katexCss?: string;
  },
): string {
  const safeTitle = escapeHtmlAttribute(snapshot.title || 'Seamind 思维导图');
  const safeScriptJson = serializeSnapshotForScriptTag(snapshot);
  const inlineCss = assets.katexCss
    ? `${assets.viewerCss}\n${assets.katexCss}`
    : assets.viewerCss;
  const safeViewerScript = assets.viewerScript.replace(
    /<\/script/gi,
    '<\\/script',
  );

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="generator" content="Seamind Offline Mindmap Exporter" />
    <title>${safeTitle} - Seamind 离线思维导图</title>
    <style>${inlineCss}</style>
  </head>
  <body class="mm-offline-body">
    <div id="seamind-offline-app" class="app-shell mm-offline-shell" style="display:block;grid-template-rows:none;grid-template-columns:none" data-theme="${escapeHtmlAttribute(snapshot.theme)}" data-map-style="${escapeHtmlAttribute(snapshot.style)}"></div>
    <script id="seamind-snapshot" type="application/json">${safeScriptJson}</script>
    <script>${safeViewerScript}</script>
  </body>
</html>
`;
}
