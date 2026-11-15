import { describe, expect, it } from 'vitest';
import { isSafeSvgStyle } from '../src/app/svg-sanitize';
import { normalizeKatexDelimiters } from '../src/mindmap/app-mindmap-utils';

describe('svg style security checks', () => {
  it('allows local fragment url(#id) references used by Mermaid markers and gradients', () => {
    expect(
      isSafeSvgStyle(
        '.edgePath .path{stroke:#333;marker-end:url(#arrowhead);} .box{fill:url("#grad1")}',
      ),
    ).toBe(true);
  });

  it('rejects remote, data, and script URLs inside SVG CSS', () => {
    expect(isSafeSvgStyle('.a{background:url(https://evil.test/x.png)}')).toBe(
      false,
    );
    expect(isSafeSvgStyle('.a{fill:url(javascript:alert(1))}')).toBe(false);
    expect(isSafeSvgStyle('@import "https://evil.test/a.css";')).toBe(false);
    expect(isSafeSvgStyle('.a{width:expression(alert(1))}')).toBe(false);
  });
});

describe('normalizeKatexDelimiters', () => {
  it('trims whitespace around ChatGPT inline formulas so markdown-it-katex parses them', () => {
    const input =
      '设 \\( A + B \\) 且同行公式 \\[ x_1 = 2 \\]，代码 `\\( y \\)` 保持不变。';
    expect(normalizeKatexDelimiters(input)).toBe(
      '设 $A + B$ 且同行公式 $x_1 = 2$，代码 `\\( y \\)` 保持不变。',
    );
  });

  it('converts multiline and single-line display delimiters while preserving code fences', () => {
    const input = [
      '\\[',
      'a\\_1 + b\\_2 = c',
      '\\]',
      '```tex',
      '\\[ untouched \\]',
      '```',
    ].join('\n');
    expect(normalizeKatexDelimiters(input)).toBe(
      ['$$', 'a_1 + b_2 = c', '$$', '```tex', '\\[ untouched \\]', '```'].join(
        '\n',
      ),
    );
  });
});
