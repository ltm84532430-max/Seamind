import { extractEpubSectionPlainText } from './epub-exams';

export interface ExamTocItem {
  href: string;
  label: string | Record<string, string>;
  subitems?: ExamTocItem[];
  id?: number;
}

export interface ExamSourceSegment {
  href: string;
  label: string;
  text: string;
  sectionIndex: number;
}

export interface ExamSourcePlan {
  label: string;
  href: string;
  items: Array<{ href: string; label: string; sectionIndex: number }>;
  start: number;
  end: number;
}

interface TocNode {
  item: ExamTocItem;
  depth: number;
  root: number;
  label: string;
  sectionIndex: number;
}

type Resolver = (href: string) => { index: number } | null;

function displayLabel(value: ExamTocItem['label']): string {
  return typeof value === 'string' ? value : (Object.values(value)[0] ?? '');
}

function normalizedHref(href: string): string {
  try {
    return decodeURIComponent(href).replaceAll('\\', '/');
  } catch {
    return href.replaceAll('\\', '/');
  }
}

function flatten(
  items: ExamTocItem[],
  resolve: Resolver,
  depth = 0,
  root = -1,
): TocNode[] {
  return items.flatMap((item, index) => {
    const nextRoot = depth === 0 ? index : root;
    const resolved = item.href ? resolve(item.href) : null;
    const node: TocNode = {
      item,
      depth,
      root: nextRoot,
      label: displayLabel(item.label),
      sectionIndex: resolved?.index ?? -1,
    };
    return [
      node,
      ...flatten(item.subitems ?? [], resolve, depth + 1, nextRoot),
    ];
  });
}

export function resolveExamSourcePlan(
  toc: ExamTocItem[],
  activeHref: string,
  activeId: number | null,
  currentSectionIndex: number,
  resolve: Resolver,
  scope: 'section' | 'chapter',
): ExamSourcePlan | null {
  const nodes = flatten(toc, resolve);
  const href = normalizedHref(activeHref);
  let current = nodes.findIndex(
    (node) => activeId !== null && node.item.id === activeId,
  );
  if (current < 0)
    current = nodes.findIndex(
      (node) => normalizedHref(node.item.href) === href,
    );
  if (current < 0)
    current = nodes.findIndex(
      (node) => node.sectionIndex === currentSectionIndex,
    );
  if (current < 0) return null;
  const start =
    scope === 'chapter'
      ? nodes.findIndex(
          (node) => node.depth === 0 && node.root === nodes[current].root,
        )
      : current;
  if (start < 0) return null;
  const depth = nodes[start].depth;
  let end = nodes.findIndex(
    (node, index) => index > start && node.depth <= depth,
  );
  if (end < 0) end = nodes.length;
  if (scope === 'chapter' && end === nodes.length) return null;
  if (
    scope === 'chapter' &&
    (nodes[start].sectionIndex < 0 || nodes[end].sectionIndex < 0)
  )
    return null;
  if (
    scope === 'chapter' &&
    nodes.slice(start, end).some((node) => node.sectionIndex < 0)
  )
    return null;
  const selected = nodes
    .slice(start, end)
    .filter((node) => node.sectionIndex >= 0);
  if (!selected.length) return null;
  const startNode = selected[0];
  if (
    scope === 'chapter' &&
    (nodes[start].depth !== 0 ||
      !/^(?:第\s*[\d一二三四五六七八九十百零]+\s*章|chapter\s+\d+)/iu.test(
        nodes[start].label,
      ))
  )
    return null;
  return {
    label: nodes[start].label,
    href: startNode.item.href,
    items: selected.map((node) => ({
      href: node.item.href,
      label: node.label,
      sectionIndex: node.sectionIndex,
    })),
    start,
    end,
  };
}

function anchor(doc: Document, href: string): Element | null {
  const fragment = href.split('#').slice(1).join('#');
  if (!fragment) return doc.body;
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    /* retain literal fragment */
  }
  return (
    doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`)
  );
}

function extractBetween(
  doc: Document,
  startHref: string,
  endHref?: string,
): string {
  const start = anchor(doc, startHref);
  if (!start) throw new Error(`目录锚点不存在：${startHref}`);
  const end = endHref ? anchor(doc, endHref) : null;
  if (endHref && !end) throw new Error(`目录边界不存在：${endHref}`);
  if (start === end) return '';
  const range = doc.createRange();
  range.setStartBefore(start);
  if (end) range.setEndBefore(end);
  else range.setEndAfter(doc.body.lastChild ?? doc.body);
  const fragment = range.cloneContents();
  const wrapper = doc.createElement('div');
  wrapper.append(fragment);
  if (!wrapper.textContent?.trim()) return '';
  return extractEpubSectionPlainText(wrapper.innerHTML);
}

export async function loadExamSourceSegments(
  plan: ExamSourcePlan,
  toc: ExamTocItem[],
  sections: Array<{ loadText?: () => Promise<string | null | undefined> }>,
  resolve: Resolver,
): Promise<ExamSourceSegment[]> {
  const nodes = flatten(toc, resolve);
  const cache = new Map<number, Document>();
  const getDocument = async (index: number) => {
    if (cache.has(index)) return cache.get(index)!;
    const source = await sections[index]?.loadText?.();
    if (!source) throw new Error(`无法读取 EPUB 第 ${index + 1} 个正文文件。`);
    const doc = new DOMParser().parseFromString(source, 'text/html');
    doc
      .querySelectorAll('script,style,noscript,nav')
      .forEach((element) => element.remove());
    cache.set(index, doc);
    return doc;
  };
  const selected = nodes
    .slice(plan.start, plan.end)
    .filter((node) => node.sectionIndex >= 0);
  const boundary = nodes.slice(plan.end).find((node) => node.sectionIndex >= 0);
  const segments: ExamSourceSegment[] = [];
  for (let i = 0; i < selected.length; i++) {
    const node = selected[i];
    const next = selected[i + 1] ?? boundary;
    const endIndex = next?.sectionIndex ?? node.sectionIndex;
    if (endIndex < node.sectionIndex)
      throw new Error('目录顺序与 EPUB 正文顺序不一致，无法准确提取范围。');
    let text = '';
    for (
      let sectionIndex = node.sectionIndex;
      sectionIndex <= Math.min(endIndex, sections.length - 1);
      sectionIndex++
    ) {
      const doc = await getDocument(sectionIndex);
      const startHref =
        sectionIndex === node.sectionIndex ? node.item.href : '';
      const endHref = sectionIndex === endIndex ? next?.item.href : undefined;
      const part = extractBetween(doc, startHref, endHref);
      if (part) text += `${part}\n`;
    }
    if (text.trim())
      segments.push({
        href: node.item.href,
        label: node.label,
        text: text.trim(),
        sectionIndex: node.sectionIndex,
      });
  }
  if (!segments.length) throw new Error('所选章节没有可用于出题的正文。');
  return segments;
}
