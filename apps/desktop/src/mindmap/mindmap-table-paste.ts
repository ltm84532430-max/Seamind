export interface ExtractedMarkdownTable {
  prefixLines: string[];
  tableLines: string[];
  suffixLines: string[];
}

export interface ParsedNodeTableInput {
  prefixText: string;
  tableMarkdown: string;
  suffixText: string;
}

export interface TableEditorPasteResult {
  text: string;
  replaceFrom: number;
  replaceTo: number;
}

const nodeIdInlineOrFullPattern = /<!--\s*seamind:id=[\w-]{1,128}\s*-->/g;

export function isMarkdownTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = inner.split('|').map((cell) => cell.trim());
  return cells.length >= 1 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function isPipeTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('|')) return false;
  if (/^\s*(?:```|~~~)/.test(trimmed)) return false;
  if (/^\s*#{1,6}\s+[^|]/.test(trimmed)) return false;
  return trimmed.split('|').length >= 2;
}

function stripCommonLeadingIndent(lines: string[]): string[] {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  if (minIndent === 0) return lines;
  return lines.map((line) => line.slice(Math.min(minIndent, line.length)));
}

function normalizePipeRow(line: string): string {
  const trimmed = line.trim();
  const withLead = trimmed.startsWith('|') ? trimmed : `| ${trimmed}`;
  return withLead.endsWith('|') ? withLead : `${withLead} |`;
}

export function tsvToMarkdownTable(rawText: string): string | null {
  const normalized = rawText.replace(/\r\n?/g, '\n').trimEnd();
  const rawLines = normalized.split('\n');
  while (rawLines.length > 0 && !rawLines[0].trim()) rawLines.shift();
  while (rawLines.length > 0 && !rawLines[rawLines.length - 1].trim()) {
    rawLines.pop();
  }
  if (rawLines.length < 2) return null;

  // Require real internal tab separators on non-empty rows (not only leading tab indentation).
  const nonEmpty = rawLines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length < 2) return null;
  const rowsWithInternalTab = nonEmpty.filter((line) =>
    /[^\t]\t|\t[^\t]/.test(line.trim()),
  );
  if (rowsWithInternalTab.length < nonEmpty.length) return null;

  const matrix = nonEmpty.map((line) =>
    line
      .split('\t')
      .map((cell) => cell.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()),
  );
  const colCount = Math.max(...matrix.map((row) => row.length));
  if (colCount < 2) return null;

  const formatRow = (row: string[]) =>
    `| ${Array.from({ length: colCount }, (_, index) => row[index] ?? '').join(' | ')} |`;
  const separator = `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`;
  const [header, ...body] = matrix;
  return [formatRow(header), separator, ...body.map(formatRow)].join('\n');
}

export function extractMarkdownTableFromText(
  rawText: string,
): ExtractedMarkdownTable | null {
  const normalized = rawText.replace(/\r\n?/g, '\n').replace(/&#10;/gi, '\n');
  const rawLines = stripCommonLeadingIndent(normalized.split('\n'));

  let start = -1;
  for (let index = 0; index < rawLines.length - 1; index += 1) {
    if (
      isPipeTableRowLine(rawLines[index]) &&
      isMarkdownTableSeparatorLine(rawLines[index + 1])
    ) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;

  let end = start + 2;
  while (end < rawLines.length && isPipeTableRowLine(rawLines[end])) {
    end += 1;
  }

  return {
    prefixLines: rawLines.slice(0, start),
    tableLines: rawLines.slice(start, end).map(normalizePipeRow),
    suffixLines: rawLines.slice(end),
  };
}

export function parseNodeTableInput(
  rawText: string,
): ParsedNodeTableInput | null {
  const extracted = extractMarkdownTableFromText(rawText);
  if (extracted) {
    return {
      prefixText: extracted.prefixLines.join('\n').trim(),
      tableMarkdown: extracted.tableLines.join('\n'),
      suffixText: extracted.suffixLines.join('\n').trim(),
    };
  }
  const fromTsv = tsvToMarkdownTable(rawText);
  if (fromTsv) {
    return {
      prefixText: '',
      tableMarkdown: fromTsv,
      suffixText: '',
    };
  }
  return null;
}

function isInsideFencedCodeBlock(docText: string, offset: number): boolean {
  const before = docText.slice(0, offset);
  let activeFence: { char: string; length: number } | null = null;
  for (const line of before.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    const marker = match[1];
    if (!activeFence) {
      activeFence = { char: marker[0], length: marker.length };
    } else if (
      marker[0] === activeFence.char &&
      marker.length >= activeFence.length
    ) {
      activeFence = null;
    }
  }
  return activeFence !== null;
}

export function formatTablePasteForMarkdownEditor(
  docText: string,
  from: number,
  to: number,
  clipboardPlainText: string,
  htmlMarkdownText?: string,
): TableEditorPasteResult | null {
  if (isInsideFencedCodeBlock(docText, from)) return null;

  const candidateSource = htmlMarkdownText?.trim()
    ? htmlMarkdownText
    : clipboardPlainText;
  const parsed = parseNodeTableInput(candidateSource);
  if (!parsed) return null;

  const blockParts: string[] = [];
  if (parsed.prefixText) blockParts.push(parsed.prefixText);
  blockParts.push(parsed.tableMarkdown);
  if (parsed.suffixText) blockParts.push(parsed.suffixText);
  const cleanPayload = blockParts.join('\n\n');

  const lineStart = docText.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const lineEndRaw = docText.indexOf('\n', to);
  const lineEnd = lineEndRaw < 0 ? docText.length : lineEndRaw;

  const beforeOnLine = docText.slice(lineStart, from);
  const afterOnLine = docText.slice(to, lineEnd);
  const markerMatch = afterOnLine.match(
    /^\s*(<!--\s*seamind:id=[\w-]{1,128}\s*-->)\s*$/,
  );
  const isEmptyOrPlaceholderPrefix =
    !parsed.prefixText &&
    /^\s*(?:#{1,6}\s*(?:新主题)?|[-+*]\s*(?:\[[ xX]\]\s*)?(?:新主题)?|\d+[.)]\s*(?:\[[ xX]\]\s*)?(?:新主题)?)\s*$/.test(
      beforeOnLine,
    ) &&
    (afterOnLine.trim() === '' || Boolean(markerMatch));

  let replaceFrom = from;
  let replaceTo = to;
  let bodyToInsert = cleanPayload;

  if (isEmptyOrPlaceholderPrefix) {
    replaceFrom = lineStart;
    replaceTo = lineEnd;
    const preservedMarker = markerMatch?.[1];
    bodyToInsert = preservedMarker
      ? `${preservedMarker}\n${cleanPayload}`
      : cleanPayload;
  }

  const beforeText = docText.slice(0, replaceFrom);
  const afterText = docText.slice(replaceTo);

  let leading = '';
  if (beforeText.length > 0) {
    if (beforeText.endsWith('\n\n')) leading = '';
    else if (beforeText.endsWith('\n')) {
      const prevLineStart =
        beforeText.lastIndexOf('\n', beforeText.length - 2) + 1;
      const prevLine = beforeText.slice(prevLineStart, beforeText.length - 1);
      const prevClean = prevLine.replace(nodeIdInlineOrFullPattern, '').trim();
      leading = prevClean ? '\n' : '';
    } else {
      leading = '\n\n';
    }
  }

  let trailing = '';
  if (afterText.length > 0) {
    if (afterText.startsWith('\n\n')) trailing = '';
    else if (afterText.startsWith('\n')) trailing = '\n';
    else trailing = '\n\n';
  }

  return {
    text: `${leading}${bodyToInsert}${trailing}`,
    replaceFrom,
    replaceTo,
  };
}
