import MarkdownIt from 'markdown-it';
import md_ins from 'markdown-it-ins';
import md_mark from 'markdown-it-mark';
import md_sub from 'markdown-it-sub';
import md_sup from 'markdown-it-sup';

function isTableSeparatorSegment(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = stripped.split('|').map((cell) => cell.trim());
  return cells.length >= 1 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function isTableRowSegment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.split('|').length >= 2;
}

function splitEncodedTableNodeLine(rawLine: string): {
  expanded: string;
} | null {
  if (!rawLine.includes('|') || !/&#10;/i.test(rawLine)) return null;
  const withoutComments = rawLine
    .replace(/<!--\s*seamind:id=[\w-]{1,128}\s*-->/g, '')
    .replace(/<!--\s*seamind:epub-href=[A-Za-z0-9%._~-]{1,4096}\s*-->/g, '')
    .trim();

  let nodePrefix = '';
  let body = withoutComments;
  const headingMatch = withoutComments.match(/^(#{1,6}\s+)(.*)$/);
  if (headingMatch) {
    nodePrefix = headingMatch[1];
    body = headingMatch[2];
  } else {
    const listMatch = withoutComments.match(
      /^((?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)(.*)$/,
    );
    if (listMatch) {
      nodePrefix = listMatch[1];
      body = listMatch[2];
    }
  }

  const segments = body
    .split(/&#10;/gi)
    .map((part) => part.trim())
    .filter((part, index, list) => {
      if (part) return true;
      return index > 0 && index < list.length - 1;
    });
  if (segments.length < 2) return null;

  let tableStart = -1;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (
      isTableRowSegment(segments[index]) &&
      isTableSeparatorSegment(segments[index + 1])
    ) {
      tableStart = index;
      break;
    }
  }
  if (tableStart < 0) return null;

  let tableEnd = tableStart + 2;
  while (
    tableEnd < segments.length &&
    segments[tableEnd] &&
    isTableRowSegment(segments[tableEnd])
  ) {
    tableEnd += 1;
  }

  const prefixText = segments.slice(0, tableStart).join(' ').trim();
  const tableLines = segments.slice(tableStart, tableEnd).join('\n');
  const suffixText = segments.slice(tableEnd).join('\n').trim();
  const parts: string[] = [];
  if (prefixText) parts.push(`${nodePrefix}${prefixText}`);
  parts.push(tableLines);
  if (suffixText) parts.push(suffixText);
  return { expanded: parts.join('\n\n') };
}

export function initializeMarkdownIt() {
  const md = MarkdownIt({
    html: true,
    breaks: true,
  });
  md.use(md_ins).use(md_mark).use(md_sub).use(md_sup);

  // Decode legacy single-line node strings where a multi-line GFM table was
  // flattened via `&#10;` beneath a heading/list marker (`##### | A | &#10; | --- |`).
  md.block.ruler.before(
    'heading',
    'seamind_encoded_table',
    (state, startLine, _endLine, silent) => {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const startPos = state.bMarks[startLine] + state.tShift[startLine];
      const maxPos = state.eMarks[startLine];
      const rawLine = state.src.slice(startPos, maxPos);
      const parsed = splitEncodedTableNodeLine(rawLine);
      if (!parsed) return false;
      if (silent) return true;

      const subTokens: InstanceType<typeof state.Token>[] = [];
      state.md.block.parse(parsed.expanded, state.md, state.env, subTokens);
      for (const token of subTokens) {
        if (token.map) {
          token.map = [startLine, startLine + 1];
        }
        state.tokens.push(token);
      }
      state.line = startLine + 1;
      return true;
    },
  );

  return md;
}
