import { describe, expect, it } from 'vitest';
import { renderAsync } from 'pele/lazy';
import {
  describePeleError,
  locatePeleErrorLine,
} from '../src/workbench/pele-render';
import { NEW_FILE_TEMPLATES } from '../src/workbench/templates';

const failureOf = async (source: string) => {
  try {
    await renderAsync(source, { links: false, images: false });
  } catch (error) {
    return describePeleError(error);
  }
  throw new Error('expected Pele to refuse this source');
};

describe('the new-file templates', () => {
  it('give a Pele diagram Pele can render', async () => {
    const result = await renderAsync(NEW_FILE_TEMPLATES.mermaid.source, {
      links: false,
      images: false,
    });
    expect(result.type).toBe('flowchart');
    expect(result.width).toBeGreaterThan(0);
    expect(result.svg).toContain('开始');
  });

  it('keep the PlantUML template a complete diagram', () => {
    const { source } = NEW_FILE_TEMPLATES.plantuml;
    expect(source.startsWith('@startuml\n')).toBe(true);
    expect(source.trimEnd().endsWith('@enduml')).toBe(true);
  });
});

describe('describePeleError', () => {
  it('reads the position of a syntax error', async () => {
    const failure = await failureOf('flowchart TD\n  A --> B\n  C --> --> D\n');
    expect(failure.code).toBe('syntax');
    expect(failure.line).toBe(3);
    expect(failure.column).toBeGreaterThan(0);
    expect(failure.snippet).toContain('C --> --> D');
    expect(failure.message).toContain('Parse error');
  });

  it('has no position for text that is not a diagram', async () => {
    const failure = await failureOf('this is not a diagram');
    expect(failure.code).toBe('unsupported-diagram');
    expect(failure.line).toBeNull();
    expect(failure.column).toBeNull();
  });

  it('describes an error that is not Pele’s as unknown', () => {
    expect(describePeleError(new Error('boom'))).toMatchObject({
      code: 'unknown',
      message: 'boom',
      line: null,
    });
    expect(describePeleError('plain string').message).toBe(
      'Pele 图表渲染失败。',
    );
    expect(describePeleError(null).code).toBe('unknown');
  });
});

describe('locatePeleErrorLine', () => {
  it('trusts the line Pele gives when nothing contradicts it', async () => {
    const source = 'flowchart TD\n  A --> B\n  C --> --> D\n  E --> F\n';
    expect(locatePeleErrorLine(source, await failureOf(source))).toBe(3);
  });

  it('finds the quoted line when Pele has not counted the comment lines', async () => {
    const source =
      '%% a note\n%% another\nflowchart TD\n  A --> B\n  C --> --> D\n';
    const failure = await failureOf(source);
    // Pele counts from the first line after the comments, so it is two short of the editor.
    expect(failure.line).toBe(3);
    expect(locatePeleErrorLine(source, failure)).toBe(5);
  });

  it('takes the repeated line nearest to the reported number', () => {
    const source = 'x --> y\nflowchart TD\nx --> y\nx --> y\n';
    expect(
      locatePeleErrorLine(source, { line: 4, snippet: 'x --> y\n-----^' }),
    ).toBe(4);
    expect(
      locatePeleErrorLine(source, { line: 1, snippet: 'x --> y\n-----^' }),
    ).toBe(1);
  });

  it('falls back to the reported line, kept inside the source', () => {
    const source = 'flowchart TD\n  A --> B\n';
    expect(locatePeleErrorLine(source, { line: 99, snippet: '\n^' })).toBe(3);
    expect(locatePeleErrorLine(source, { line: 2, snippet: '' })).toBe(2);
    expect(locatePeleErrorLine(source, { line: null, snippet: '' })).toBeNull();
  });
});
