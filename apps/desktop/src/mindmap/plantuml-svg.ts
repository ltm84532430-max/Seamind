/**
 * PlantUML writes one complete <svg> document per diagram, back to back, so a source with several
 * @startuml blocks (or a newpage) comes back as several documents in a single string. Parsing that
 * string as one XML document fails with "Extra content at the end of the document".
 *
 * Returns the complete top-level documents in order. When no document is complete the output is
 * returned as is (unless it is blank), so the caller still reports why it cannot be shown.
 */
export function splitSvgDocuments(output: string): string[] {
  const documents: string[] = [];
  let depth = 0;
  let start = -1;
  for (const match of output.matchAll(/<svg\b|<\/svg\s*>/gi)) {
    if (match[0].charAt(1) !== '/') {
      if (depth === 0) start = match.index;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) {
        documents.push(output.slice(start, match.index + match[0].length));
        start = -1;
      }
    }
  }
  if (documents.length > 0) return documents;
  return output.trim() ? [output] : [];
}

/** The name after each `@start…` line of a PlantUML source, in order ("" when a block has none). */
export function plantUmlDiagramNames(source: string): string[] {
  return source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*@start[a-z0-9_-]*\b[ \t]*(.*)$/i);
    return match ? [match[1].trim().split(/\s+/)[0] ?? ''] : [];
  });
}
