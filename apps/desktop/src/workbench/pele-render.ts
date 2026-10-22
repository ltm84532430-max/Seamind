import { sanitizeDiagramSvg } from '../code-blocks';

/** The same cap a `pele` fence in a Markdown preview has. */
export const MAX_PELE_SOURCE_CHARS = 50_000;

/** Used for measuring labels and as the diagram's fallback font, to match the app's own text. */
const PELE_FONT_FAMILY = "'Segoe UI', 'Microsoft YaHei UI', sans-serif";

export interface PeleDiagram {
  /** Sanitized SVG markup, safe to inject. */
  svg: string;
  width: number;
  height: number;
}

export type PeleFailureCode =
  | 'empty'
  | 'too-large'
  | 'syntax'
  | 'semantic'
  | 'limit'
  | 'unsupported-diagram'
  | 'unsafe-output'
  | 'unknown';

export interface PeleFailure {
  code: PeleFailureCode;
  /** Pele's own message, which can span several lines. */
  message: string;
  /** One-based line in the source Pele names, or null when it names none. */
  line: number | null;
  column: number | null;
  /** The offending source line and a caret line under it. */
  snippet: string;
}

export type PeleOutcome =
  | { ok: true; diagram: PeleDiagram }
  | { ok: false; failure: PeleFailure };

const peleCodes = new Set<PeleFailureCode>([
  'syntax',
  'semantic',
  'limit',
  'unsupported-diagram',
]);

function failure(
  code: PeleFailureCode,
  message: string,
  extra: Partial<Pick<PeleFailure, 'line' | 'column' | 'snippet'>> = {},
): PeleFailure {
  return {
    code,
    message,
    line: extra.line ?? null,
    column: extra.column ?? null,
    snippet: extra.snippet ?? '',
  };
}

/**
 * Turns whatever `renderAsync` threw into a failure the panel can show. Pele's error class is
 * recognised by its fields rather than by `instanceof`, because the build mangles its name.
 */
export function describePeleError(error: unknown): PeleFailure {
  if (error && typeof error === 'object') {
    const candidate = error as {
      code?: unknown;
      line?: unknown;
      column?: unknown;
      snippet?: unknown;
      message?: unknown;
    };
    const message =
      typeof candidate.message === 'string' && candidate.message
        ? candidate.message
        : 'Pele 图表渲染失败。';
    if (
      typeof candidate.code === 'string' &&
      peleCodes.has(candidate.code as PeleFailureCode)
    ) {
      const line =
        typeof candidate.line === 'number' && candidate.line > 0
          ? candidate.line
          : null;
      const column =
        typeof candidate.column === 'number' && candidate.column > 0
          ? candidate.column
          : null;
      return failure(candidate.code as PeleFailureCode, message, {
        line,
        column,
        snippet: typeof candidate.snippet === 'string' ? candidate.snippet : '',
      });
    }
    return failure('unknown', message);
  }
  return failure('unknown', 'Pele 图表渲染失败。');
}

/**
 * The line to select for a failure, one-based. Pele counts lines after it has removed the `%%`
 * comment lines, so its number can fall short of the editor's; the offending line it quotes is
 * looked up in the source instead, taking the one closest to the number it gave.
 */
export function locatePeleErrorLine(
  source: string,
  failure: Pick<PeleFailure, 'line' | 'snippet'>,
): number | null {
  const lines = source.split(/\r?\n/);
  const reported =
    failure.line !== null ? Math.min(failure.line, lines.length) : null;
  const quoted = failure.snippet.split('\n')[0]?.trimEnd() ?? '';
  if (quoted.trim()) {
    let best: number | null = null;
    lines.forEach((line, index) => {
      if (line.trimEnd() !== quoted) return;
      const lineNumber = index + 1;
      if (
        best === null ||
        reported === null ||
        Math.abs(lineNumber - reported) <= Math.abs(best - reported)
      )
        best = lineNumber;
    });
    if (best !== null) return best;
  }
  return reported;
}

/** Renders Mermaid source with Pele and passes the result through the app's SVG sanitizer. */
export async function renderPeleDiagram(source: string): Promise<PeleOutcome> {
  if (!source.trim())
    return { ok: false, failure: failure('empty', '图表源码为空。') };
  if (source.length > MAX_PELE_SOURCE_CHARS)
    return {
      ok: false,
      failure: failure('too-large', 'Pele 图表源码超过 50 KB。'),
    };
  try {
    const { renderAsync } = await import('pele/lazy');
    const result = await renderAsync(source, {
      links: false,
      images: false,
      limit: MAX_PELE_SOURCE_CHARS,
      outputLimit: 300_000,
      maxEdges: 500,
      autoDirection: false,
      fontFamily: PELE_FONT_FAMILY,
    });
    const root = sanitizeDiagramSvg(result.svg);
    if (!root)
      return {
        ok: false,
        failure: failure('unsafe-output', 'Pele 输出未通过 SVG 安全检查。'),
      };
    return {
      ok: true,
      diagram: {
        svg: new XMLSerializer().serializeToString(root),
        width: result.width,
        height: result.height,
      },
    };
  } catch (error) {
    return { ok: false, failure: describePeleError(error) };
  }
}
