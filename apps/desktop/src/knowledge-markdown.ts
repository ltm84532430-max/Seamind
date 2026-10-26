import type { MapDocument } from './library';

export interface KnowledgeNoteTemplate {
  id: string;
  label: string;
  description: string;
  titlePrefix: string;
  tags: string[];
  source: string;
}

export const KNOWLEDGE_NOTE_TEMPLATES: readonly KnowledgeNoteTemplate[] = [
  {
    id: 'blank',
    label: '空白笔记',
    description: '干净标题起笔，适合随手记录',
    titlePrefix: '未命名笔记',
    tags: [],
    source: '# 未命名笔记\n\n',
  },
  {
    id: 'concept',
    label: '概念与公式推导',
    description: '含核心定义、KaTeX 推导与关联双链',
    titlePrefix: '概念笔记',
    tags: ['笔记'],
    source: [
      '# 概念名称',
      '',
      '> [!NOTE]',
      '> 一句话概括核心直觉与适用边界。',
      '',
      '## 核心定义',
      '',
      '设输入空间为 $X$，映射关系满足：',
      '',
      '$$',
      'f(x) = \\sum_{i=1}^{n} w_i \\phi_i(x)',
      '$$',
      '',
      '## 关键性质与推导',
      '',
      '1. **性质一**：说明推导前提与结论',
      '2. **性质二**：边界条件与复杂度分析',
      '',
      '## 关联笔记',
      '',
      '- 前置概念：[[在这里输入关联笔记]]',
      '',
    ].join('\n'),
  },
  {
    id: 'reading',
    label: '文献与读书札记',
    description: '核心论点、原文摘录与个人批注结构',
    titlePrefix: '阅读札记',
    tags: ['阅读'],
    source: [
      '# 阅读札记',
      '',
      '## 核心问题与结论',
      '',
      '- **作者试图解决什么问题**：',
      '- **最关键的三个论点**：',
      '',
      '## 关键摘录',
      '',
      '> 记录关键段落或核心数据结论。',
      '',
      '## 思考与启发',
      '',
      '- 可迁移到当前项目的思路：',
      '- 待进一步求证的问题：',
      '',
    ].join('\n'),
  },
  {
    id: 'review',
    label: '项目复盘与待办',
    description: '背景目标、方案对比与行动清单',
    titlePrefix: '项目记录',
    tags: ['复盘'],
    source: [
      '# 项目记录',
      '',
      '## 背景与目标',
      '',
      '简述当前阶段要达成的明确结果。',
      '',
      '## 方案决策',
      '',
      '| 维度 | 方案 A | 方案 B |',
      '| :--- | :--- | :--- |',
      '| 优势 | 实现简洁 | 扩展性强 |',
      '| 代价 | 需后续演进 | 前期投入较高 |',
      '',
      '## 行动项',
      '',
      '- [ ] 完成核心模块验证',
      '- [ ] 补充边界用例与文档归档',
      '',
    ].join('\n'),
  },
];

const CALLOUT_LABELS: Record<string, { label: string; kind: string }> = {
  NOTE: { label: '说明', kind: 'note' },
  TIP: { label: '技巧', kind: 'tip' },
  IMPORTANT: { label: '重要', kind: 'important' },
  WARNING: { label: '注意', kind: 'warning' },
  CAUTION: { label: '警示', kind: 'caution' },
};

function normalizeLookupKey(raw: string): string {
  return raw.trim().replace(/\.md$/i, '').toLowerCase();
}

/**
 * Resolves a `[[target]]` reference against library documents by title or relative path stem.
 */
export function findWikilinkTarget(
  target: string,
  documents: readonly MapDocument[],
): MapDocument | undefined {
  const clean = normalizeLookupKey(target);
  if (!clean) return undefined;

  const exactDoc = documents.find(
    (doc) => doc.kind === 'doc' && doc.title.trim().toLowerCase() === clean,
  );
  if (exactDoc) return exactDoc;

  const exactAny = documents.find(
    (doc) => doc.title.trim().toLowerCase() === clean,
  );
  if (exactAny) return exactAny;

  return documents.find((doc) => {
    const normalizedPath = normalizeLookupKey(doc.relativePath);
    const stem = normalizedPath.split('/').pop() ?? '';
    return normalizedPath === clean || stem === clean;
  });
}

function upgradeCallouts(root: HTMLElement, doc: Document): void {
  const blockquotes = Array.from(root.querySelectorAll('blockquote'));
  for (const blockquote of blockquotes) {
    if (blockquote.parentElement?.closest('pre, code')) continue;
    const firstParagraph = blockquote.firstElementChild;
    if (!firstParagraph || firstParagraph.tagName.toLowerCase() !== 'p') {
      continue;
    }
    const rawHtml = firstParagraph.innerHTML;
    const match = rawHtml.match(
      /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*([^\n<]*))?(?:\r?\n|<br\s*\/?>)?/i,
    );
    if (!match) continue;

    const rawType = match[1].toUpperCase();
    const meta = CALLOUT_LABELS[rawType] ?? CALLOUT_LABELS.NOTE;
    const customTitle = (match[2] ?? '').trim();
    const remainderHtml = rawHtml.slice(match[0].length).trim();

    const wrapper = doc.createElement('div');
    wrapper.className = `seamind-callout is-${meta.kind}`;
    wrapper.setAttribute('data-callout', meta.kind);

    const header = doc.createElement('div');
    header.className = 'seamind-callout-header';
    const badge = doc.createElement('span');
    badge.className = 'seamind-callout-badge';
    badge.textContent = rawType;
    const title = doc.createElement('strong');
    title.className = 'seamind-callout-title';
    title.textContent = customTitle || meta.label;
    header.append(badge, title);
    wrapper.appendChild(header);

    const body = doc.createElement('div');
    body.className = 'seamind-callout-body';
    if (remainderHtml) {
      firstParagraph.innerHTML = remainderHtml;
    } else {
      firstParagraph.remove();
    }
    while (blockquote.firstChild) {
      body.appendChild(blockquote.firstChild);
    }
    if (body.childNodes.length > 0) {
      wrapper.appendChild(body);
    }
    blockquote.replaceWith(wrapper);
  }
}

const TOKEN_PATTERN =
  /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]|(^|[\s(（])#([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5\-_/]{0,38})/g;

function enhanceTextNodes(
  root: HTMLElement,
  doc: Document,
  documents: readonly MapDocument[],
): void {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const parent = current.parentElement;
    if (
      parent &&
      !parent.closest(
        'pre, code, a, button, script, style, .katex, .seamind-callout-header',
      )
    ) {
      textNodes.push(current as Text);
    }
    current = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? '';
    if (!value.includes('[[') && !value.includes('#')) continue;

    const insideHeading = Boolean(
      textNode.parentElement?.closest('h1, h2, h3, h4, h5, h6'),
    );
    TOKEN_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let changed = false;
    const fragment = doc.createDocumentFragment();
    let match = TOKEN_PATTERN.exec(value);

    while (match) {
      const [fullMatch, wikiTarget, wikiAlias, tagLead, tagName] = match;
      const matchStart = match.index;

      if (wikiTarget !== undefined) {
        if (matchStart > lastIndex) {
          fragment.appendChild(
            doc.createTextNode(value.slice(lastIndex, matchStart)),
          );
        }
        const cleanTarget = wikiTarget.trim();
        const displayLabel = (wikiAlias ?? cleanTarget).trim();
        const resolved = findWikilinkTarget(cleanTarget, documents);

        const link = doc.createElement('a');
        link.href = '#seamind-wikilink';
        link.className = `seamind-wikilink${resolved ? '' : ' is-missing'}`;
        link.setAttribute('data-wikilink', cleanTarget);
        link.title = resolved
          ? `打开笔记：${resolved.title} (${resolved.relativePath})`
          : `尚未创建「${cleanTarget}」，点击立即新建`;
        link.textContent = displayLabel;
        fragment.appendChild(link);

        lastIndex = matchStart + fullMatch.length;
        changed = true;
      } else if (tagName !== undefined && !insideHeading) {
        const prefixLen = (tagLead ?? '').length;
        const hashStart = matchStart + prefixLen;
        if (hashStart > lastIndex) {
          fragment.appendChild(
            doc.createTextNode(value.slice(lastIndex, hashStart)),
          );
        }
        const pill = doc.createElement('span');
        pill.className = 'seamind-inline-tag';
        pill.textContent = `#${tagName}`;
        fragment.appendChild(pill);

        lastIndex = matchStart + fullMatch.length;
        changed = true;
      }

      match = TOKEN_PATTERN.exec(value);
    }

    if (changed) {
      if (lastIndex < value.length) {
        fragment.appendChild(doc.createTextNode(value.slice(lastIndex)));
      }
      textNode.replaceWith(fragment);
    }
  }
}

/**
 * Post-processes sanitized Markdown preview HTML to render GitHub-style callouts (`> [!NOTE]`),
 * clickable `[[wikilinks]]`, and subtle inline `#tags`.
 */
export function enhanceKnowledgePreviewHtml(
  sanitizedHtml: string,
  documents: readonly MapDocument[],
): string {
  if (!sanitizedHtml || typeof DOMParser === 'undefined') return sanitizedHtml;
  const hasCallout = sanitizedHtml.includes('[!');
  const hasWikilink = sanitizedHtml.includes('[[');
  const hasHash = sanitizedHtml.includes('#');
  if (!hasCallout && !hasWikilink && !hasHash) return sanitizedHtml;

  const parsed = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
  if (hasCallout) upgradeCallouts(parsed.body, parsed);
  if (hasWikilink || hasHash) {
    enhanceTextNodes(parsed.body, parsed, documents);
  }
  return parsed.body.innerHTML;
}
