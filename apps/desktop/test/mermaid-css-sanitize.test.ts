import { describe, expect, it } from 'vitest';
import {
  sanitizeMermaidInlineCss,
  sanitizeScopedMermaidCss,
} from '../src/app/mermaid-css-sanitize';

describe('Mermaid SVG CSS sanitization', () => {
  it('keeps theme and class styles scoped to the diagram', () => {
    const css = `
      #seamind-diagram-1 .node rect { fill: #f3f6f4; stroke: #9bada4; stroke-width: 1px; }
      #seamind-diagram-1 .root .anchor path { fill: #687b72 !important; }
      #seamind-diagram-1[data-look="classic"][data-color-id="color-0"].cluster:not(.swimlane) rect { stroke: #9bada4; }
      #seamind-diagram-1 .edgePaths .path { stroke: #687b72; marker-end: url(https://example.test/arrow); }
    `;

    const safe = sanitizeScopedMermaidCss(css, 'seamind-diagram-1');
    expect(safe).toContain('fill:#f3f6f4');
    expect(safe).toContain('fill:#687b72!important');
    expect(safe).toContain('[data-look="classic"]');
    expect(safe).toContain('.edgePaths .path{stroke:#687b72}');
    expect(safe).not.toContain('marker-end');
  });

  it('drops rules outside the SVG and unsafe declarations', () => {
    const css = `
      body, #seamind-diagram-1 .node { display: none; }
      #seamind-diagram-1 + .app-shell { display: none; }
      #seamind-diagram-1 .node { fill: url(https://example.test/x.svg); background-image: url(#x); stroke: #687b72; }
      @import url(https://example.test/a.css);
    `;

    const safe = sanitizeScopedMermaidCss(css, 'seamind-diagram-1');
    expect(safe).toBe('#seamind-diagram-1 .node{stroke:#687b72}');
  });

  it('keeps safe inline attributes and removes CSS escapes', () => {
    expect(
      sanitizeMermaidInlineCss(
        'fill: #f3f6f4 !important; stroke-width: 2px; background-image: url(#x);',
      ),
    ).toBe('fill:#f3f6f4!important;stroke-width:2px');
    expect(sanitizeMermaidInlineCss('fill: url(javascript:alert(1))')).toBe('');
  });
});
