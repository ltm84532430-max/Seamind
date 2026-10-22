export interface MarkdownHeading {
  /** 1 for `#` and 6 for `######`. */
  depth: number;
  /** The heading as plain text. */
  text: string;
  /** Zero-based line of the heading in the source. For a setext heading, its first line. */
  lineIndex: number;
}

const fenceOpening = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const atxHeading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const setextUnderline = /^ {0,3}(=+|-+)[ \t]*$/;
const blockStart =
  /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|<)/;

/** Drops the inline markup a heading shows as formatting, so the outline reads as plain text. */
function plainHeadingText(raw: string): string {
  return raw
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>\n]*>/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*{1,3})(?=\S)([^*]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])(_{1,3})(?=\S)([^_]*?\S)\2(?=$|[\s).,;:!?])/g, '$1$3')
    .replace(/~~(?=\S)(.*?\S)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lists the headings of a Markdown document in source order. Headings inside code fences, HTML
 * comments and a leading YAML front matter are not headings, and the rendered preview has exactly
 * one heading element for each entry, in the same order.
 */
export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const lines = markdown.split(/\r?\n/);
  const headings: MarkdownHeading[] = [];
  let index = 0;

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex(
      (line, position) =>
        position > 0 && (line.trim() === '---' || line.trim() === '...'),
    );
    if (end > 0) index = end + 1;
  }

  let fence: { marker: string; length: number } | null = null;
  let inComment = false;
  // Whether the previous line was a paragraph line, so this one only continues that paragraph.
  let inParagraph = false;

  for (; index < lines.length; index += 1) {
    const line = lines[index];

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }

    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (
        closing &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length
      )
        fence = null;
      continue;
    }

    if (!line.trim()) {
      inParagraph = false;
      continue;
    }

    const opening = line.match(fenceOpening);
    // A backtick fence's info string cannot contain a backtick, which is how inline code that
    // starts a line (```x```) is told apart from a fence.
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { marker: opening[1][0], length: opening[1].length };
      inParagraph = false;
      continue;
    }

    if (line.trimStart().startsWith('<!--') && !line.includes('-->')) {
      inComment = true;
      inParagraph = false;
      continue;
    }

    const atx = line.match(atxHeading);
    if (atx) {
      const text = plainHeadingText(atx[2] ?? '');
      if (text) headings.push({ depth: atx[1].length, text, lineIndex: index });
      inParagraph = false;
      continue;
    }

    if (inParagraph) continue;
    if (/^( {4}|\t)/.test(line) || blockStart.test(line)) continue;

    // A paragraph underlined with === or --- is a setext heading.
    let last = index;
    while (
      last + 1 < lines.length &&
      lines[last + 1].trim() &&
      !setextUnderline.test(lines[last + 1]) &&
      !blockStart.test(lines[last + 1])
    )
      last += 1;
    const underline = lines[last + 1]?.match(setextUnderline);
    if (underline) {
      const text = plainHeadingText(lines.slice(index, last + 1).join(' '));
      if (text)
        headings.push({
          depth: underline[1][0] === '=' ? 1 : 2,
          text,
          lineIndex: index,
        });
      index = last + 1;
      inParagraph = false;
    } else {
      inParagraph = true;
    }
  }

  return headings;
}
