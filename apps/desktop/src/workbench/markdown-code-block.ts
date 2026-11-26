export interface MarkdownCodeFence {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  lineIndex: number;
  endLineIndex: number;
  marker: string;
  info: string;
  language: string;
  code: string;
}

/** Locate fenced blocks using source offsets so identical snippets remain distinct. */
export function findMarkdownCodeFences(source: string): MarkdownCodeFence[] {
  const lines = source.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const fences: MarkdownCodeFence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*)$/.exec(
      (lines[index] ?? '').replace(/\r$/, ''),
    );
    if (!opening) continue;
    const marker = opening[1];
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(
        (lines[end] ?? '').replace(/\r$/, ''),
      );
      if (
        closing &&
        closing[1][0] === marker[0] &&
        closing[1].length >= marker.length
      ) {
        break;
      }
    }
    if (end >= lines.length) continue;
    const bodyFrom = starts[index] + lines[index].length + 1;
    const bodyTo = starts[end];
    const info = (opening[2] ?? '').trim();
    fences.push({
      from: starts[index],
      to: starts[end] + lines[end].length,
      bodyFrom,
      bodyTo,
      lineIndex: index,
      endLineIndex: end + 1,
      marker,
      info,
      language: info.split(/\s+/, 1)[0] ?? '',
      // The last newline separates the body from the closing fence.
      code: source
        .slice(bodyFrom, bodyTo)
        .replace(/\r\n?/g, '\n')
        .replace(/\n$/, ''),
    });
    index = end;
  }
  return fences;
}

export function codeFenceAtSelection(
  source: string,
  from: number,
  to: number,
): MarkdownCodeFence | null {
  return (
    findMarkdownCodeFences(source).find(
      (fence) => from >= fence.bodyFrom && to <= fence.bodyTo,
    ) ?? null
  );
}

export function codeFenceForPreview(
  source: string,
  range: { lineIndex: number; endLineIndex: number } | undefined,
  renderedCode: string,
): MarkdownCodeFence | null {
  const fences = findMarkdownCodeFences(source);
  if (range) {
    const exact = fences.find(
      (fence) =>
        fence.lineIndex === range.lineIndex &&
        fence.endLineIndex === range.endLineIndex,
    );
    if (exact) return exact;
  }
  const normalized = renderedCode.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const matches = fences.filter(
    (fence) => fence.code.replace(/\n+$/, '') === normalized,
  );
  return matches.length === 1 ? matches[0] : null;
}

export function wouldCloseCodeFence(
  fence: MarkdownCodeFence,
  code: string,
): boolean {
  return code
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .some((line) => {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      return (
        closing !== null &&
        closing[1][0] === fence.marker[0] &&
        closing[1].length >= fence.marker.length
      );
    });
}

export function fencedCodeMarkdown(
  language: string,
  code: string,
  previousInfo?: string,
): string {
  const cleanLanguage =
    language
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_+.-]/g, '') || 'text';
  const info =
    previousInfo?.split(/\s+/, 1)[0]?.toLowerCase() === cleanLanguage
      ? previousInfo
      : cleanLanguage;
  const normalized = code.replace(/\r\n?/g, '\n');
  let longest = 0;
  for (const run of normalized.matchAll(/`+/g))
    longest = Math.max(longest, run[0].length);
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}${info}\n${normalized}\n${marker}`;
}

/** Separate a newly inserted fenced block from surrounding prose. */
export function separateMarkdownBlock(
  source: string,
  from: number,
  to: number,
  block: string,
): string {
  const before = source.slice(0, from);
  const after = source.slice(to);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const prefix =
    !before || before.endsWith(newline + newline)
      ? ''
      : before.endsWith(newline)
        ? newline
        : newline + newline;
  const suffix =
    !after || after.startsWith(newline + newline)
      ? ''
      : after.startsWith(newline)
        ? newline
        : newline + newline;
  return `${prefix}${block}${suffix}`;
}
