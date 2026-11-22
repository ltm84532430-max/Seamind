import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  katexCss,
  viewerCss,
  viewerScript,
} from 'virtual:seamind-offline-viewer';
import {
  buildStandaloneMindmapHtml,
  serializeSnapshotForScriptTag,
  type MindmapOfflineExportSnapshot,
} from '../src/mindmap/offline-viewer-shared';
import {
  analyzeExportTreeStats,
  captureLiveCanvasDiagrams,
} from '../src/mindmap/offline-export';
import { offlineDiagramSnapshotKey } from '../src/mindmap/offline-viewer-shared';

describe('mindmap offline HTML export & virtual bundle', () => {
  const originalDomParser = globalThis.DOMParser;

  beforeAll(() => {
    if (typeof globalThis.DOMParser === 'undefined') {
      (globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
        parseFromString(html: string) {
          const imgs = html.match(/<img\b/gi) ?? [];
          const notes = html.match(/seamind-node-note/gi) ?? [];
          const excel = html.match(/language-seamind-excel/gi) ?? [];
          const codes = html.match(/<pre\b[^>]*>\s*<code/gi) ?? [];
          return {
            body: {
              innerHTML: html,
              querySelectorAll: (selector: string) => {
                if (selector === 'img') return imgs;
                if (selector === '.seamind-node-note') return notes;
                if (selector === 'pre > code') {
                  return [
                    ...excel.map(() => ({
                      classList: ['language-seamind-excel'],
                    })),
                    ...Array.from(
                      { length: Math.max(0, codes.length - excel.length) },
                      () => ({ classList: ['language-python'] }),
                    ),
                  ];
                }
                return [];
              },
            },
          };
        }
      };
    }
  });

  afterAll(() => {
    if (originalDomParser === undefined) {
      delete (globalThis as unknown as { DOMParser?: unknown }).DOMParser;
    } else {
      (globalThis as unknown as { DOMParser: unknown }).DOMParser =
        originalDomParser;
    }
  });

  it('builds non-empty, zero-CDN standalone offline viewer script and stylesheets', () => {
    expect(viewerScript.length).toBeGreaterThan(20_000);
    expect(viewerScript).not.toMatch(/https?:\/\/(?:cdn|unpkg)\./i);
    expect(viewerCss).toContain('.mm-offline-bar');
    expect(viewerCss).toContain('.app-shell.mm-offline-shell');
    expect(viewerCss).toContain('grid-template-rows:none');
    expect(viewerCss).toMatch(/\.mm-offline-stage\{position:fixed/);
    expect(viewerCss).toContain('#171d21');
    expect(viewerCss).toContain('.seamind-node-note');
    expect(viewerCss).toContain('.seamind-mm-table-card');
    expect(katexCss).toContain('data:font/woff2;base64,');
    expect(katexCss).not.toContain('url(fonts/');
  });

  it('safely escapes script tags and builds self-contained HTML with snapshot state', () => {
    const snapshot: MindmapOfflineExportSnapshot = {
      version: 1,
      exportId: 'doc-123',
      title: '策略研报 </script>',
      exportedAt: '2026-11-22T08:00:00Z',
      style: 'cards',
      theme: 'navy',
      direction: 'both',
      spacing: { horizontal: 64, vertical: 18 },
      mediaBounds: {
        minWidth: 160,
        maxWidth: 420,
        maxHeight: 320,
        syncToPreview: false,
      },
      transform: { k: 1.15, x: 40, y: 120 },
      foldByPath: { '1.2': 1 },
      cardStates: {
        collapsedTables: [],
        excelPages: { 'excel::1.3::abc': 2 },
        collapsedNotes: ['n1'],
        expandedNotes: ['n2'],
        collapsedCodeCards: [],
        collapsedCodeOutputs: [],
        customMediaWidths: { 'img::1.4::x::0': 520 },
      },
      excelDatasets: {},
      diagramSnapshots: {},
      codeResults: {},
      root: {
        content: '根节点 <script>alert(1)</script>',
        children: [{ content: '子节点 $E=mc^2$', children: [] }],
      },
    };

    const escaped = serializeSnapshotForScriptTag(snapshot);
    expect(escaped).not.toContain('</script>');

    const html = buildStandaloneMindmapHtml(snapshot, {
      viewerScript: 'console.log("viewer");',
      viewerCss: '.mm-offline-body{margin:0}',
      katexCss: '.katex{font-size:1.1em}',
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-theme="navy"');
    expect(html).toContain('data-map-style="cards"');
    expect(html).toContain(
      'style="display:block;grid-template-rows:none;grid-template-columns:none"',
    );
    expect(html).toContain(
      '<script id="seamind-snapshot" type="application/json">',
    );
    expect(html).toContain('console.log("viewer");');
    expect(html).toContain('.katex{font-size:1.1em}');
  });

  it('counts nodes, notes, images, Excel fences, code blocks, and math formulas', () => {
    const stats = analyzeExportTreeStats(
      {
        content: 'Root <div class="seamind-node-note">note</div>',
        children: [
          {
            content:
              '<img src="seamind-media:abcd" /> <pre><code class="language-seamind-excel">{}</code></pre>',
            children: [],
          },
          {
            content:
              '<span class="katex">x</span><pre><code class="language-python">print(1)</code></pre>',
            children: [],
          },
        ],
      },
      true,
    );
    expect(stats).toEqual({
      nodeCount: 3,
      mediaCount: 1,
      excelCount: 1,
      noteCount: 1,
      codeCount: 1,
      hasMath: true,
    });
  });

  it('captures a rendered diagram only when the panel still has its source', () => {
    const originalSerializer = globalThis.XMLSerializer;
    class FakeSerializer {
      serializeToString(node: { attrs?: Record<string, string> }) {
        const attrs = node.attrs ?? {};
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${attrs.width ?? ''}" height="${attrs.height ?? ''}"></svg>`;
      }
    }
    globalThis.XMLSerializer =
      FakeSerializer as unknown as typeof XMLSerializer;

    const source = 'graph TD\nA-->B';
    const rendered = {
      attrs: {} as Record<string, string>,
      getAttribute: () => null,
      setAttribute(name: string, value: string) {
        this.attrs[name] = value;
      },
      cloneNode() {
        return rendered;
      },
      getBoundingClientRect: () => ({ width: 320.4, height: 180.2 }),
    };
    const ready = {
      dataset: { language: 'Mermaid', seamindSource: source },
      querySelector(selector: string) {
        return selector.includes('svg') ? rendered : null;
      },
    };
    const missingSource = {
      dataset: { language: 'echarts', sourceLength: '12' },
      querySelector: () => rendered,
    };
    const root = {
      querySelectorAll: () => [missingSource, ready],
    };

    try {
      const snapshots = captureLiveCanvasDiagrams(
        root as unknown as SVGSVGElement,
      );
      const key = offlineDiagramSnapshotKey('mermaid', source);
      expect(snapshots[key]).toMatchObject({
        kind: 'svg',
        language: 'mermaid',
      });
      expect(snapshots[key]?.markupOrUrl).toContain('width="320"');
      expect(snapshots[key]?.markupOrUrl).toContain('height="180"');
      expect(
        snapshots[offlineDiagramSnapshotKey('echarts', 'unused')],
      ).toBeUndefined();
    } finally {
      if (originalSerializer === undefined) {
        delete (globalThis as { XMLSerializer?: typeof XMLSerializer })
          .XMLSerializer;
      } else {
        globalThis.XMLSerializer = originalSerializer;
      }
    }
  });
});
