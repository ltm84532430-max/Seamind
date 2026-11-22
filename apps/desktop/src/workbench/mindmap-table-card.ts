import {
  buildExcelMarkdownTable,
  parseExcelFenceDescriptor,
  type StoredExcelTablePayload,
} from '../mindmap/mindmap-excel';

export interface MindmapTableStats {
  totalRowCount: number;
  bodyRowCount: number;
  colCount: number;
}

export interface TableMatrixCell {
  text: string;
  align?: 'left' | 'center' | 'right';
}

export interface TableMatrixData {
  headers: TableMatrixCell[];
  rows: TableMatrixCell[][];
}

const collapsedTableKeys = new Set<string>();

function createTableSvgIcon(paths: string, size = 12): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.45');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

const ICON_COPY =
  '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />';
const ICON_CHECK = '<polyline points="3 8.5 6.5 12 13 4.5" />';
const ICON_CHEVRON_DOWN = '<polyline points="4 6 8 10 12 6" />';
const ICON_CHEVRON_RIGHT = '<polyline points="6 4 10 8 6 12" />';

async function copyTextSafely(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback to hidden textarea selection if clipboard API is denied.
    }
  }
  if (typeof document === 'undefined' || !document.body) return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

function readCellAlignment(
  cell: HTMLTableCellElement,
): 'left' | 'center' | 'right' | undefined {
  const inlineAlign = cell.style.textAlign.trim().toLowerCase();
  const attrAlign = cell.getAttribute('align')?.trim().toLowerCase() ?? '';
  const align = inlineAlign || attrAlign;
  if (align === 'left' || align === 'center' || align === 'right') {
    return align;
  }
  return undefined;
}

function extractCellMarkdownText(cell: Element): string {
  let out = '';
  const walk = (node: Node) => {
    const nodeType = node.nodeType;
    if (nodeType === 3) {
      out += node.textContent ?? '';
      return;
    }
    if (nodeType !== 1) return;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (tag === 'br') {
      out += '\n';
      return;
    }
    if (el.classList.contains('katex')) {
      const tex = el
        .querySelector('annotation[encoding="application/x-tex"], annotation')
        ?.textContent?.trim();
      if (tex) {
        out += el.closest('.katex-display') ? `$$${tex}$$` : `$${tex}$`;
        return;
      }
    }
    if (tag === 'code' && el.parentElement?.localName.toLowerCase() !== 'pre') {
      out += `\`${el.textContent ?? ''}\``;
      return;
    }
    Array.from(el.childNodes).forEach(walk);
  };
  walk(cell);
  return out
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]*\r?\n[ \t]*/g, '<br>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCellPlainText(cell: Element): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (tag === 'br') {
      out += '\n';
      return;
    }
    if (el.classList.contains('katex-html')) return;
    Array.from(el.childNodes).forEach(walk);
  };
  walk(cell);
  return out.replace(/\u00a0/g, ' ').trim();
}

function directTableRows(table: HTMLTableElement): {
  headRows: HTMLTableRowElement[];
  bodyRows: HTMLTableRowElement[];
  allRows: HTMLTableRowElement[];
} {
  const allRows = Array.from(table.querySelectorAll('tr')).filter(
    (tr) => tr.closest('table') === table,
  );
  const headRows = allRows.filter(
    (tr) => tr.parentElement?.localName.toLowerCase() === 'thead',
  );
  const bodyRows = allRows.filter(
    (tr) => tr.parentElement?.localName.toLowerCase() !== 'thead',
  );
  return { headRows, bodyRows, allRows };
}

export function getMindmapTableStats(
  table: HTMLTableElement,
): MindmapTableStats {
  const { headRows, bodyRows, allRows } = directTableRows(table);
  let colCount = 0;
  for (const row of allRows) {
    const cells = Array.from(row.children).filter(
      (child): child is HTMLTableCellElement =>
        child instanceof HTMLTableCellElement,
    );
    const width = cells.reduce(
      (sum, cell) => sum + Math.max(1, cell.colSpan || 1),
      0,
    );
    colCount = Math.max(colCount, width);
  }
  const bodyRowCount =
    headRows.length > 0
      ? bodyRows.length
      : allRows.length > 1
        ? allRows.length - 1
        : allRows.length;
  return {
    totalRowCount: allRows.length,
    bodyRowCount,
    colCount,
  };
}

function expandRowCells(
  row: HTMLTableRowElement,
  extractor: (cell: Element) => string,
): TableMatrixCell[] {
  const result: TableMatrixCell[] = [];
  for (const child of Array.from(row.children)) {
    if (!(child instanceof HTMLTableCellElement)) continue;
    const text = extractor(child);
    const align = readCellAlignment(child);
    const span = Math.max(1, child.colSpan || 1);
    result.push({ text, align });
    for (let index = 1; index < span; index += 1) {
      result.push({ text: '', align });
    }
  }
  return result;
}

export function tableMatrixToMarkdown(matrix: TableMatrixData): string {
  const all = [matrix.headers, ...matrix.rows];
  const colCount = Math.max(1, ...all.map((row) => row.length));
  if (matrix.headers.length === 0 && matrix.rows.length === 0) return '';

  const escapeMdCell = (value: string) => value.replace(/\|/g, '\\|');
  const formatRow = (row: TableMatrixCell[]) => {
    const cells = Array.from({ length: colCount }, (_, index) =>
      escapeMdCell(row[index]?.text ?? ''),
    );
    return `| ${cells.join(' | ')} |`;
  };
  const separator = `| ${Array.from({ length: colCount }, (_, index) => {
    const align = matrix.headers[index]?.align;
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    if (align === 'left') return ':---';
    return '---';
  }).join(' | ')} |`;

  return [
    formatRow(matrix.headers),
    separator,
    ...matrix.rows.map(formatRow),
  ].join('\n');
}

export function tableMatrixToCsv(
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const escapeCsvField = (field: string) => {
    if (/[",\r\n]/.test(field)) {
      return `"${field.replace(/"/g, '""')}"`;
    }
    return field;
  };
  return rows
    .map((row) => row.map((cell) => escapeCsvField(cell)).join(','))
    .join('\n');
}

export function tableElementToMarkdown(table: HTMLTableElement): string {
  const { headRows, bodyRows, allRows } = directTableRows(table);
  if (allRows.length === 0) return '';
  const headerSource = headRows[0] ?? allRows[0];
  const dataSources =
    headRows.length > 0
      ? [...headRows.slice(1), ...bodyRows]
      : allRows.slice(1);
  return tableMatrixToMarkdown({
    headers: expandRowCells(headerSource, extractCellMarkdownText),
    rows: dataSources.map((row) =>
      expandRowCells(row, extractCellMarkdownText),
    ),
  });
}

export function tableElementToCsv(table: HTMLTableElement): string {
  const { allRows } = directTableRows(table);
  if (allRows.length === 0) return '';
  const matrix = allRows.map((row) =>
    expandRowCells(row, extractCellPlainText).map((cell) => cell.text),
  );
  return tableMatrixToCsv(matrix);
}

function wrapTableCells(table: HTMLTableElement): void {
  const rows = Array.from(table.querySelectorAll('tr')).filter(
    (tr) => tr.closest('table') === table,
  );
  for (const row of rows) {
    for (const child of Array.from(row.children)) {
      if (!(child instanceof HTMLTableCellElement)) continue;
      if (
        child.firstElementChild?.classList.contains('seamind-mm-cell') &&
        child.children.length === 1
      ) {
        continue;
      }
      const isHeader = child.localName.toLowerCase() === 'th';
      const wrapper = document.createElement('div');
      wrapper.className = isHeader
        ? 'seamind-mm-cell is-head'
        : 'seamind-mm-cell';
      const align = readCellAlignment(child);
      if (align) {
        wrapper.style.textAlign = align;
      }
      while (child.firstChild) {
        wrapper.appendChild(child.firstChild);
      }
      const trimmedLen = (wrapper.textContent ?? '').trim().length;
      if (isHeader && trimmedLen > 0 && trimmedLen <= 14) {
        wrapper.classList.add('is-compact');
      }
      child.appendChild(wrapper);
    }
  }
}

function buildTableCardKey(
  table: HTMLTableElement,
  stats: MindmapTableStats,
): string {
  const nodePath =
    table.closest<SVGGElement>('g.markmap-node')?.getAttribute('data-path') ??
    '';
  const lines = table.dataset.lines ?? '';
  const { allRows } = directTableRows(table);
  const firstRowPreview = allRows[0]
    ? Array.from(allRows[0].cells)
        .map((cell) => (cell.textContent ?? '').trim())
        .join('|')
        .slice(0, 80)
    : '';
  return `${nodePath}::${lines}::${stats.totalRowCount}x${stats.colCount}::${firstRowPreview}`;
}

interface TableCardShellOptions {
  badgeText: string;
  metaText: string;
  cardKey: string;
  isExcel?: boolean;
  getMarkdownText: () => string;
  getCsvText: () => string;
  dispose: (callback: () => void) => void;
  onStateChange?: () => void;
}

function createTableCardShell(options: TableCardShellOptions): {
  card: HTMLDivElement;
  meta: HTMLSpanElement;
  scrollWrap: HTMLDivElement;
} {
  const card = document.createElement('div');
  card.className = options.isExcel
    ? 'seamind-mm-table-card is-excel'
    : 'seamind-mm-table-card';
  card.setAttribute('data-seamind-code-interactive', 'true');
  if (collapsedTableKeys.has(options.cardKey)) {
    card.classList.add('is-collapsed');
  }

  const head = document.createElement('div');
  head.className = 'seamind-mm-table-head';

  const left = document.createElement('div');
  left.className = 'seamind-mm-table-head-left';

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'seamind-mm-code-icon-btn';
  const syncCollapseUi = () => {
    const collapsed = card.classList.contains('is-collapsed');
    collapseBtn.replaceChildren(
      createTableSvgIcon(
        collapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN,
        12,
      ),
    );
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    collapseBtn.title = collapsed ? '展开表格' : '收起表格';
    collapseBtn.setAttribute('aria-label', collapseBtn.title);
  };
  syncCollapseUi();
  const onCollapseClick = (event: MouseEvent) => {
    event.stopPropagation();
    const collapsed = card.classList.toggle('is-collapsed');
    if (collapsed) collapsedTableKeys.add(options.cardKey);
    else collapsedTableKeys.delete(options.cardKey);
    syncCollapseUi();
    options.onStateChange?.();
  };
  collapseBtn.addEventListener('click', onCollapseClick);
  options.dispose(() =>
    collapseBtn.removeEventListener('click', onCollapseClick),
  );

  const badge = document.createElement('span');
  badge.className = 'seamind-mm-table-badge';
  badge.textContent = options.badgeText;

  const meta = document.createElement('span');
  meta.className = 'seamind-mm-table-meta';
  meta.textContent = options.metaText;

  left.append(collapseBtn, badge, meta);

  const actions = document.createElement('div');
  actions.className = 'seamind-mm-table-actions';

  const makeCopyButton = (
    label: string,
    title: string,
    getContent: () => string,
  ) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seamind-mm-table-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);

    const renderIdle = () => {
      btn.classList.remove('is-copied');
      const span = document.createElement('span');
      span.textContent = label;
      btn.replaceChildren(createTableSvgIcon(ICON_COPY, 11), span);
    };
    renderIdle();

    let resetTimer = 0;
    const onClick = (event: MouseEvent) => {
      event.stopPropagation();
      void copyTextSafely(getContent()).then((copied) => {
        if (!copied) return;
        btn.classList.add('is-copied');
        const span = document.createElement('span');
        span.textContent = '已复制';
        btn.replaceChildren(createTableSvgIcon(ICON_CHECK, 11), span);
        window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(renderIdle, 1400);
      });
    };
    btn.addEventListener('click', onClick);
    options.dispose(() => {
      btn.removeEventListener('click', onClick);
      window.clearTimeout(resetTimer);
    });
    return btn;
  };

  actions.append(
    makeCopyButton('Markdown', '复制为 Markdown 表格', options.getMarkdownText),
    makeCopyButton('CSV', '复制为 CSV 表格', options.getCsvText),
  );
  head.append(left, actions);

  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'seamind-mm-table-scroll';
  scrollWrap.setAttribute('data-seamind-code-scroll', 'true');

  card.append(head, scrollWrap);
  return { card, meta, scrollWrap };
}

export function hydrateMindmapTables(
  container: ParentNode,
  dispose: (callback: () => void) => void,
  onStateChange?: () => void,
): void {
  const tables = Array.from(
    container.querySelectorAll<HTMLTableElement>('table'),
  );
  for (const table of tables) {
    if (
      table.dataset.seamindTableHydrated === 'true' ||
      table.rows.length === 0 ||
      table.parentElement?.closest(
        'table, .seamind-mm-table-card, .seamind-code-panel, .seamind-node-note, .katex',
      )
    ) {
      continue;
    }
    const parent = table.parentElement;
    if (!parent) continue;

    table.dataset.seamindTableHydrated = 'true';
    table.classList.add('seamind-mm-table');
    const stats = getMindmapTableStats(table);
    const cardKey = buildTableCardKey(table, stats);
    wrapTableCells(table);

    const { card, scrollWrap } = createTableCardShell({
      badgeText: 'TABLE',
      metaText: `${stats.bodyRowCount} 行 × ${stats.colCount} 列`,
      cardKey,
      getMarkdownText: () => tableElementToMarkdown(table),
      getCsvText: () => tableElementToCsv(table),
      dispose,
      onStateChange,
    });

    parent.insertBefore(card, table);
    scrollWrap.appendChild(table);
  }
}

const EXCEL_CARD_PAGE_SIZE = 80;
const excelPageIndices = new Map<string, number>();

export function getTableCardStateSnapshot(): {
  collapsedTables: string[];
  excelPages: Record<string, number>;
} {
  return {
    collapsedTables: [...collapsedTableKeys],
    excelPages: Object.fromEntries(excelPageIndices),
  };
}

export function restoreTableCardStateSnapshot(state: {
  collapsedTables?: ReadonlyArray<string>;
  excelPages?: Record<string, number>;
}): void {
  collapsedTableKeys.clear();
  excelPageIndices.clear();
  state.collapsedTables?.forEach((key) => collapsedTableKeys.add(key));
  if (state.excelPages) {
    Object.entries(state.excelPages).forEach(([key, value]) => {
      if (Number.isInteger(value) && value >= 0) {
        excelPageIndices.set(key, value);
      }
    });
  }
}

export function buildMindmapExcelCard(options: {
  source: string;
  nodePath?: string;
  loadDataset?: (assetId: string) => Promise<StoredExcelTablePayload | null>;
  signal: AbortSignal;
  dispose: (callback: () => void) => void;
  onStateChange?: () => void;
}): HTMLElement | null {
  const descriptor = parseExcelFenceDescriptor(options.source);
  if (!descriptor) return null;

  const cardKey = `excel::${options.nodePath ?? ''}::${descriptor.assetId || descriptor.title}`;
  let activeHeaders = descriptor.headers;
  let activeRows = descriptor.previewRows;
  let pageIndex = excelPageIndices.get(cardKey) ?? 0;
  let statusNote =
    options.loadDataset && descriptor.assetId ? '正在加载完整工作表…' : '';
  const tableEl = document.createElement('table');
  tableEl.className = 'seamind-mm-table';

  const { card, meta, scrollWrap } = createTableCardShell({
    badgeText: 'EXCEL',
    metaText: `${descriptor.sheetName} · ${descriptor.rowCount} 行 × ${descriptor.colCount} 列`,
    cardKey,
    isExcel: true,
    getMarkdownText: () => buildExcelMarkdownTable(activeHeaders, activeRows),
    getCsvText: () => tableMatrixToCsv([activeHeaders, ...activeRows]),
    dispose: options.dispose,
    onStateChange: options.onStateChange,
  });

  const pager = document.createElement('div');
  pager.className = 'seamind-mm-excel-pager';
  scrollWrap.appendChild(tableEl);
  card.appendChild(pager);

  const renderPage = () => {
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    activeHeaders.forEach((header) => {
      const th = document.createElement('th');
      const cell = document.createElement('div');
      cell.className = 'seamind-mm-cell is-head';
      if (header.trim().length <= 14) cell.classList.add('is-compact');
      cell.textContent = header;
      th.appendChild(cell);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    const totalPages = Math.max(
      1,
      Math.ceil(activeRows.length / EXCEL_CARD_PAGE_SIZE),
    );
    pageIndex = Math.max(0, Math.min(pageIndex, totalPages - 1));
    const start = pageIndex * EXCEL_CARD_PAGE_SIZE;
    const slice = activeRows.slice(start, start + EXCEL_CARD_PAGE_SIZE);

    const tbody = document.createElement('tbody');
    slice.forEach((row) => {
      const tr = document.createElement('tr');
      activeHeaders.forEach((_, colIdx) => {
        const td = document.createElement('td');
        const cell = document.createElement('div');
        cell.className = 'seamind-mm-cell';
        cell.textContent = row[colIdx] ?? '';
        td.appendChild(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    tableEl.replaceChildren(thead, tbody);

    const showCountText =
      activeRows.length > 0
        ? `显示第 ${start + 1}-${start + slice.length} / ${activeRows.length} 行`
        : '0 行';
    meta.textContent = statusNote
      ? `${descriptor.sheetName} · ${descriptor.rowCount}×${descriptor.colCount} · ${statusNote}`
      : `${descriptor.sheetName} · ${descriptor.rowCount} 行 × ${descriptor.colCount} 列`;

    pager.replaceChildren();
    if (totalPages <= 1 && !statusNote) {
      pager.style.display = 'none';
      return;
    }
    pager.style.display = 'flex';
    const info = document.createElement('span');
    info.textContent = statusNote || showCountText;
    pager.appendChild(info);

    if (totalPages > 1) {
      const nav = document.createElement('div');
      nav.className = 'seamind-mm-excel-pager-nav';
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'seamind-mm-table-btn';
      prevBtn.textContent = '上一页';
      prevBtn.disabled = pageIndex === 0;
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'seamind-mm-table-btn';
      nextBtn.textContent = '下一页';
      nextBtn.disabled = pageIndex >= totalPages - 1;
      const pageLabel = document.createElement('span');
      pageLabel.textContent = `${pageIndex + 1} / ${totalPages}`;

      const onPrev = (e: MouseEvent) => {
        e.stopPropagation();
        pageIndex = Math.max(0, pageIndex - 1);
        excelPageIndices.set(cardKey, pageIndex);
        scrollWrap.scrollTop = 0;
        renderPage();
        options.onStateChange?.();
      };
      const onNext = (e: MouseEvent) => {
        e.stopPropagation();
        pageIndex = Math.min(totalPages - 1, pageIndex + 1);
        excelPageIndices.set(cardKey, pageIndex);
        scrollWrap.scrollTop = 0;
        renderPage();
        options.onStateChange?.();
      };
      prevBtn.addEventListener('click', onPrev);
      nextBtn.addEventListener('click', onNext);
      options.dispose(() => {
        prevBtn.removeEventListener('click', onPrev);
        nextBtn.removeEventListener('click', onNext);
      });
      nav.append(prevBtn, pageLabel, nextBtn);
      pager.appendChild(nav);
    }
  };

  renderPage();

  if (options.loadDataset && descriptor.assetId) {
    void options
      .loadDataset(descriptor.assetId)
      .then((payload) => {
        if (options.signal.aborted) return;
        if (payload) {
          if (Array.isArray(payload.headers) && payload.headers.length > 0) {
            activeHeaders = payload.headers;
          }
          if (Array.isArray(payload.rows)) {
            activeRows = payload.rows;
          }
          statusNote = '';
        } else {
          statusNote = '仅显示前 5 行预览（未读取到全量表数据）';
        }
        renderPage();
      })
      .catch(() => {
        if (options.signal.aborted) return;
        statusNote = '仅显示前 5 行预览（未读取到本地全量表文件）';
        renderPage();
      });
  }

  return card;
}
