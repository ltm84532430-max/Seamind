import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sourceDirectory = new URL('../src/', import.meta.url);

/**
 * Finds the first structural problem in a stylesheet: unbalanced braces, or a style rule nested in
 * another style rule. A missing `}` makes browsers read every later rule as a rule nested in the
 * unclosed one (and, inside an @media block, as dead code), so the symptom is a whole section of
 * the page silently losing its styles.
 */
function findCssStructureProblem(css: string): string | null {
  const stack: Array<{ kind: 'rule' | 'at'; line: number }> = [];
  let line = 1;
  let prelude = '';
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === '\n') line += 1;
    if (char === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2);
      const comment = css.slice(index, end === -1 ? css.length : end + 2);
      line += comment.split('\n').length - 1;
      index += comment.length - 1;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < css.length && css[end] !== char)
        end += css[end] === '\\' ? 2 : 1;
      prelude += css.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === '{') {
      const kind = prelude.trim().startsWith('@') ? 'at' : 'rule';
      const parent = stack[stack.length - 1];
      if (kind === 'rule' && parent?.kind === 'rule') {
        return `line ${line}: "${prelude.trim().slice(0, 60)}" is nested in the rule opened on line ${parent.line}; a closing brace is missing before it`;
      }
      stack.push({ kind, line });
      prelude = '';
    } else if (char === '}') {
      if (stack.pop() === undefined)
        return `line ${line}: closing brace without a matching opening brace`;
      prelude = '';
    } else if (char === ';') {
      prelude = '';
    } else {
      prelude += char;
    }
  }
  const unclosed = stack[stack.length - 1];
  return unclosed
    ? `the block opened on line ${unclosed.line} is never closed`
    : null;
}

describe('stylesheet structure', () => {
  const stylesheets = [
    ...readdirSync(sourceDirectory).filter((name) => name.endsWith('.css')),
    ...readdirSync(new URL('workbench/', sourceDirectory))
      .filter((name) => name.endsWith('.css'))
      .map((name) => `workbench/${name}`),
  ];

  it('finds the stylesheets', () => {
    expect(stylesheets).toContain('styles.css');
    expect(stylesheets).toContain('ebook-workspace.css');
    expect(stylesheets).toContain('workbench/workbench.css');
  });

  for (const name of stylesheets) {
    it(`${name} has balanced blocks and no rule nested in another rule`, () => {
      expect(
        findCssStructureProblem(
          readFileSync(new URL(name, sourceDirectory), 'utf8'),
        ),
      ).toBeNull();
    });
  }

  it('reports the unclosed rule that left the e-book heatmap unstyled', () => {
    const css = [
      '@media (max-width: 680px) {',
      '  .a { right: 1px; }',
      '  .b {',
      '    right: 2px;',
      '',
      '/* a section pasted into the open rule */',
      '.heatmap { width: 100%; }',
      '',
    ].join('\n');
    expect(findCssStructureProblem(css)).toMatch(
      /line 7: ".heatmap" is nested in the rule opened on line 3/,
    );
  });

  it('accepts media queries, keyframes, strings and comments', () => {
    const css = [
      '/* { not a block } */',
      '.a::before { content: "}{"; }',
      '@media (max-width: 680px) { .a { color: red; } .b { color: blue; } }',
      '@keyframes spin { from { opacity: 0; } to { opacity: 1; } }',
    ].join('\n');
    expect(findCssStructureProblem(css)).toBeNull();
  });

  it('reports a block that is never closed', () => {
    expect(
      findCssStructureProblem('@media print {\n  .a { color: red; }\n'),
    ).toMatch(/opened on line 1 is never closed/);
  });
});
