/** One TOC row. `label` stays unknown because foliate sometimes sends a locale map. */
export interface ReaderTocEntry {
  label?: unknown;
  href?: string;
  subitems?: readonly ReaderTocEntry[];
}

/** Walks every nested `subitems` level, parents before children. */
export function flattenReaderToc<
  T extends { subitems?: readonly T[] | undefined },
>(items: readonly T[]): T[] {
  const flat: T[] = [];
  const visit = (nodes: readonly T[]) => {
    for (const item of nodes) {
      flat.push(item);
      if (item.subitems?.length) visit(item.subitems);
    }
  };
  visit(items);
  return flat;
}

function isTokenBoundary(char: string | undefined): boolean {
  if (char === undefined) return true;
  return !/[a-z0-9]/i.test(char);
}

function startsOnBoundary(haystack: string, needle: string): boolean {
  const next = haystack[needle.length];
  return haystack.startsWith(needle) && (next === undefined || /\s/.test(next));
}

function containsOnBoundary(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? undefined : haystack[index - 1];
    const after = haystack[index + needle.length];
    if (isTokenBoundary(before) && isTokenBoundary(after)) return true;
    from = index + 1;
  }
  return false;
}

function rankTocFields(label: string, href: string, needle: string): number {
  if (label && label === needle) return 6;
  if (href && href === needle) return 5;
  if (label && startsOnBoundary(label, needle)) return 4;
  if (href && startsOnBoundary(href, needle)) return 3;
  if (label && containsOnBoundary(label, needle)) return 2;
  if (href && containsOnBoundary(href, needle)) return 1;
  return 0;
}

/**
 * Picks a TOC row for a reader jump.
 * Exact label, exact href, bounded prefix, then a match that does not sit
 * inside a longer Latin letter or digit run. "1" therefore matches "第1章"
 * and misses "第10章". Equal ranks keep the earlier row.
 */
export function matchReaderTocEntry<
  T extends { label?: unknown; href?: string },
>(items: readonly T[], query: string): T | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  let best: { item: T; rank: number } | undefined;
  for (const item of items) {
    const label =
      typeof item.label === 'string' ? item.label.trim().toLowerCase() : '';
    const href =
      typeof item.href === 'string' ? item.href.trim().toLowerCase() : '';
    const rank = rankTocFields(label, href, needle);
    if (rank === 0) continue;
    if (!best || rank > best.rank) best = { item, rank };
  }
  return best?.item;
}
