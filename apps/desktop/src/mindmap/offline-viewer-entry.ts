import type { PureNode } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import type { Theme } from '../app/app-storage';
import {
  mapNodeColor,
  mapNodeLineWidth,
  mapNodeLinkAnchor,
} from './map-style-colors';
import {
  offlineDiagramSnapshotKey,
  type MindmapOfflineExportSnapshot,
} from './offline-viewer-shared';
import {
  buildMindmapExcelCard,
  getTableCardStateSnapshot,
  hydrateMindmapTables,
  restoreTableCardStateSnapshot,
} from '../workbench/mindmap-table-card';
import {
  getNoteCardStateSnapshot,
  hydrateMindmapNoteCards,
  restoreNoteCardStateSnapshot,
} from '../workbench/mindmap-note-card';
import {
  getMediaCardStateSnapshot,
  hydrateMindmapMedia,
  restoreMediaCardStateSnapshot,
} from '../workbench/mindmap-media-card';
import {
  codeLanguageBadge,
  computeCodeBlockResultKey,
  normalizeCodeBlockLanguage,
  renderCodeLinesInto,
} from '../workbench/code-syntax-utils';

interface PersistedViewerSession {
  exportedAt?: string;
  theme?: Theme;
  foldByPath?: Record<string, number>;
  collapsedTables?: string[];
  excelPages?: Record<string, number>;
  collapsedNotes?: string[];
  expandedNotes?: string[];
  collapsedCodeCards?: string[];
  collapsedCodeOutputs?: string[];
  customMediaWidths?: Record<string, number>;
}

const THEME_SEQUENCE: Theme[] = ['light', 'dark', 'navy', 'purple'];
const THEME_LABELS: Record<Theme, string> = {
  light: '浅色',
  dark: '深灰',
  navy: '深蓝',
  purple: '紫色',
};

function clonePureNodeTree(node: PureNode): PureNode {
  return {
    content: node.content,
    ...(node.payload ? { payload: { ...node.payload } } : {}),
    children: (node.children || []).map(clonePureNodeTree),
  };
}

function stripHtmlText(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for file:// origin when Clipboard API is restricted.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
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

function applyFoldOverridesToPureTree(
  node: PureNode,
  foldByPath: Record<string, number>,
  depth = 1,
  indexRef = { count: 0 },
  parentPath = '',
): void {
  indexRef.count += 1;
  const fallbackPath = parentPath
    ? `${parentPath}.${indexRef.count}`
    : `${indexRef.count}`;
  const path =
    typeof node.payload?.seamindSourcePath === 'string' &&
    node.payload.seamindSourcePath
      ? node.payload.seamindSourcePath
      : fallbackPath;
  if (Object.prototype.hasOwnProperty.call(foldByPath, path)) {
    node.payload = { ...(node.payload || {}), fold: foldByPath[path] };
  }
  (node.children || []).forEach((child) =>
    applyFoldOverridesToPureTree(child, foldByPath, depth + 1, indexRef, path),
  );
}

function collectRuntimeFoldMap(root: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  const walk = (node: any) => {
    if (!node) return;
    const path = node.state?.path;
    if (typeof path === 'string' && path && node.payload?.fold) {
      result[path] = Number(node.payload.fold) || 1;
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };
  walk(root);
  return result;
}

function setAllFoldState(node: any, fold: number, minDepth = 1): void {
  const walk = (item: any, depth = 0) => {
    if (!item) return;
    if (
      depth >= minDepth &&
      Array.isArray(item.children) &&
      item.children.length > 0
    ) {
      item.payload = { ...(item.payload || {}), fold };
    } else if (depth < minDepth && item.payload?.fold) {
      item.payload = { ...item.payload, fold: 0 };
    }
    if (Array.isArray(item.children)) {
      item.children.forEach((child: any) => walk(child, depth + 1));
    }
  };
  walk(node, 0);
}

function mountOfflineViewer(): void {
  const rawEl = document.getElementById('seamind-snapshot');
  const rootEl = document.getElementById('seamind-offline-app');
  if (!rawEl || !rootEl) return;

  let snapshot: MindmapOfflineExportSnapshot;
  try {
    snapshot = JSON.parse(
      rawEl.textContent || '',
    ) as MindmapOfflineExportSnapshot;
  } catch {
    rootEl.textContent = '无法解析离线思维导图快照数据。';
    return;
  }

  const storageKey = `seamind-offline:v1:${snapshot.exportId}`;
  const loadSession = (): PersistedViewerSession | null => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedViewerSession;
      // Only restore cached session when it belongs to the exact same export
      // snapshot; re-exporting with a new theme/layout starts cleanly from the
      // newly exported snapshot.
      if (!parsed || parsed.exportedAt !== snapshot.exportedAt) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  let savedSession = loadSession();
  let activeTheme: Theme = savedSession?.theme ?? snapshot.theme ?? 'light';

  const collapsedCodeCards = new Set<string>(
    savedSession?.collapsedCodeCards ??
      snapshot.cardStates.collapsedCodeCards ??
      [],
  );
  const collapsedCodeOutputs = new Set<string>(
    savedSession?.collapsedCodeOutputs ??
      snapshot.cardStates.collapsedCodeOutputs ??
      [],
  );

  restoreTableCardStateSnapshot({
    collapsedTables:
      savedSession?.collapsedTables ?? snapshot.cardStates.collapsedTables,
    excelPages: savedSession?.excelPages ?? snapshot.cardStates.excelPages,
  });
  restoreNoteCardStateSnapshot({
    collapsedNotes:
      savedSession?.collapsedNotes ?? snapshot.cardStates.collapsedNotes,
    expandedNotes:
      savedSession?.expandedNotes ?? snapshot.cardStates.expandedNotes,
  });
  restoreMediaCardStateSnapshot(
    savedSession?.customMediaWidths ?? snapshot.cardStates.customMediaWidths,
  );

  const syncShellAttributes = () => {
    rootEl.setAttribute('data-theme', activeTheme);
    rootEl.setAttribute('data-map-style', snapshot.style);
    rootEl.style.setProperty(
      '--seamind-media-min-w',
      `${snapshot.mediaBounds?.minWidth ?? 160}px`,
    );
    rootEl.style.setProperty(
      '--seamind-media-max-w',
      `${snapshot.mediaBounds?.maxWidth ?? 420}px`,
    );
    rootEl.style.setProperty(
      '--seamind-media-max-h',
      `${snapshot.mediaBounds?.maxHeight ?? 320}px`,
    );
  };
  syncShellAttributes();

  const stage = document.createElement('div');
  stage.className = 'canvas-wrap mm-offline-stage';
  Object.assign(stage.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
  });

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mindmap-canvas markmap mm-offline-svg');
  stage.appendChild(svg);

  // Build floating top toolbar
  const bar = document.createElement('header');
  bar.className = 'mm-offline-bar';

  const brand = document.createElement('div');
  brand.className = 'mm-offline-brand';
  const titleEl = document.createElement('h1');
  titleEl.className = 'mm-offline-title';
  titleEl.textContent = snapshot.title || 'Seamind 思维导图';
  titleEl.title = snapshot.title || '';
  const badge = document.createElement('span');
  badge.className = 'mm-offline-badge';
  badge.textContent = '离线分享版';
  brand.append(titleEl, badge);

  const controls = document.createElement('div');
  controls.className = 'mm-offline-controls';

  // Search box
  const searchBox = document.createElement('div');
  searchBox.className = 'mm-offline-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = '搜索节点…';
  searchInput.setAttribute('aria-label', '搜索思维导图节点');
  const searchCount = document.createElement('span');
  searchCount.className = 'mm-offline-search-count';
  const prevMatchBtn = document.createElement('button');
  prevMatchBtn.type = 'button';
  prevMatchBtn.className = 'mm-offline-btn is-icon';
  prevMatchBtn.textContent = '↑';
  prevMatchBtn.title = '上一个匹配项';
  const nextMatchBtn = document.createElement('button');
  nextMatchBtn.type = 'button';
  nextMatchBtn.className = 'mm-offline-btn is-icon';
  nextMatchBtn.textContent = '↓';
  nextMatchBtn.title = '下一个匹配项';
  searchBox.append(searchInput, searchCount, prevMatchBtn, nextMatchBtn);

  const makeButton = (
    text: string,
    title: string,
    onClick: () => void,
    extraClass = '',
  ) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = extraClass
      ? `mm-offline-btn ${extraClass}`
      : 'mm-offline-btn';
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  };

  const zoomOutBtn = makeButton(
    '－',
    '缩小',
    () => {
      void mm.rescale(0.82).then(syncZoomPill);
    },
    'is-icon',
  );
  const zoomPill = document.createElement('span');
  zoomPill.className = 'mm-offline-zoom-pill';
  zoomPill.textContent = '100%';
  const zoomInBtn = makeButton(
    '＋',
    '放大',
    () => {
      void mm.rescale(1.22).then(syncZoomPill);
    },
    'is-icon',
  );
  const fitBtn = makeButton('适应画布', '自适应显示全部节点', () => {
    void fitWithToolbarPadding();
  });
  const restoreViewBtn = makeButton(
    '导出视角',
    '回到分享时保存的缩放与视角位置',
    () => restoreCreatorTransform(false),
  );
  if (!snapshot.transform) restoreViewBtn.style.display = 'none';

  const expandAllBtn = makeButton('全展', '展开全部节点', () => {
    if (!mm.state?.data) return;
    setAllFoldState(mm.state.data, 0, 0);
    void mm.renderData().then(async () => {
      scheduleHydration();
      await fitWithToolbarPadding();
      persistSessionState();
    });
  });
  const collapseBtn = makeButton('收起子级', '仅保留一级主分支', () => {
    if (!mm.state?.data) return;
    setAllFoldState(mm.state.data, 1, 1);
    void mm.renderData().then(async () => {
      scheduleHydration();
      await fitWithToolbarPadding();
      persistSessionState();
    });
  });

  const themeBtn = makeButton(
    `主题·${THEME_LABELS[activeTheme]}`,
    '切换配色主题',
    () => {
      const idx = THEME_SEQUENCE.indexOf(activeTheme);
      activeTheme = THEME_SEQUENCE[(idx + 1) % THEME_SEQUENCE.length];
      themeBtn.textContent = `主题·${THEME_LABELS[activeTheme]}`;
      syncShellAttributes();
      persistSessionState();
      void mm.setData(undefined).then(scheduleHydration);
    },
  );

  const resetBtn = makeButton('重置', '恢复为分享者导出时的初始状态', () => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // ignore storage errors
    }
    savedSession = null;
    activeTheme = snapshot.theme ?? 'light';
    themeBtn.textContent = `主题·${THEME_LABELS[activeTheme]}`;
    syncShellAttributes();

    collapsedCodeCards.clear();
    snapshot.cardStates.collapsedCodeCards?.forEach((k) =>
      collapsedCodeCards.add(k),
    );
    collapsedCodeOutputs.clear();
    snapshot.cardStates.collapsedCodeOutputs?.forEach((k) =>
      collapsedCodeOutputs.add(k),
    );
    restoreTableCardStateSnapshot(snapshot.cardStates);
    restoreNoteCardStateSnapshot(snapshot.cardStates);
    restoreMediaCardStateSnapshot(snapshot.cardStates.customMediaWidths);

    const freshTree = clonePureNodeTree(snapshot.root);
    applyFoldOverridesToPureTree(freshTree, snapshot.foldByPath || {});
    void mm.setData(freshTree).then(async () => {
      runHydration();
      await waitForEmbeddedImages();
      try {
        await mm.renderData();
        runHydration();
      } catch {
        // ignore
      }
      window.requestAnimationFrame(() => {
        if (snapshot.transform) restoreCreatorTransform(true);
        else void fitWithToolbarPadding();
        syncZoomPill();
      });
    });
    showToast('已恢复分享初始状态');
  });

  const restorePill = document.createElement('button');
  restorePill.type = 'button';
  restorePill.className = 'mm-offline-restore-pill';
  restorePill.textContent = '显示工具栏';
  restorePill.style.display = 'none';

  const hideBarBtn = makeButton(
    '隐藏',
    '收起顶部工具栏以便演示或专注阅读',
    () => {
      bar.classList.add('is-hidden');
      restorePill.style.display = 'inline-flex';
    },
  );
  restorePill.addEventListener('click', () => {
    bar.classList.remove('is-hidden');
    restorePill.style.display = 'none';
  });

  controls.append(
    searchBox,
    zoomOutBtn,
    zoomPill,
    zoomInBtn,
    fitBtn,
    restoreViewBtn,
    expandAllBtn,
    collapseBtn,
    themeBtn,
    resetBtn,
    hideBarBtn,
  );
  bar.append(brand, controls);

  const toastEl = document.createElement('div');
  toastEl.className = 'mm-offline-hint-toast';
  let toastTimer = 0;
  const showToast = (msg: string) => {
    toastEl.textContent = msg;
    toastEl.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove('is-visible');
    }, 2000);
  };

  // Image / diagram lightbox
  const lightbox = document.createElement('div');
  lightbox.className = 'mm-code-lightbox';
  lightbox.style.display = 'none';
  const lightboxImg = document.createElement('img');
  lightboxImg.alt = '放大预览';
  lightbox.appendChild(lightboxImg);
  const openLightbox = (src: string) => {
    lightboxImg.src = src;
    lightbox.style.display = 'flex';
  };
  lightbox.addEventListener('click', () => {
    lightbox.style.display = 'none';
    lightboxImg.removeAttribute('src');
  });

  rootEl.append(stage, bar, restorePill, toastEl, lightbox);

  const persistSessionState = () => {
    const tableState = getTableCardStateSnapshot();
    const noteState = getNoteCardStateSnapshot();
    const mediaWidths = getMediaCardStateSnapshot();
    const payload: PersistedViewerSession = {
      exportedAt: snapshot.exportedAt,
      theme: activeTheme,
      foldByPath: mm?.state?.data
        ? collectRuntimeFoldMap(mm.state.data)
        : snapshot.foldByPath,
      collapsedTables: tableState.collapsedTables,
      excelPages: tableState.excelPages,
      collapsedNotes: noteState.collapsedNotes,
      expandedNotes: noteState.expandedNotes,
      collapsedCodeCards: [...collapsedCodeCards],
      collapsedCodeOutputs: [...collapsedCodeOutputs],
      customMediaWidths: mediaWidths,
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch {
      // Ignore quota / privacy mode errors
    }
  };

  const mm = Markmap.create(svg, {
    autoFit: false,
    duration: 220,
    direction: snapshot.direction || 'both',
    linkShape: 'orthogonal',
    linkRadius: 0,
    spacingHorizontal: snapshot.spacing?.horizontal ?? 56,
    spacingVertical: snapshot.spacing?.vertical ?? 14,
    maxWidth: 380,
    fitRatio: 0.9,
    pan: true,
    zoom: true,
    linkAnchor: (node: any) =>
      mapNodeLinkAnchor(snapshot.style, node.state?.depth ?? 0),
    lineWidth: (node: any) => mapNodeLineWidth(node.state?.depth ?? 0),
    color: (node: any) =>
      mapNodeColor(
        snapshot.style,
        node.state?.depth ?? 0,
        node.state?.path || '',
        activeTheme,
      ),
  });

  const syncZoomPill = () => {
    try {
      const t = mm.getTransform();
      if (Number.isFinite(t?.k) && t.k > 0) {
        zoomPill.textContent = `${Math.round(t.k * 100)}%`;
      }
    } catch {
      // ignore before zoom initialization
    }
  };

  const fitWithToolbarPadding = async (): Promise<void> => {
    const svgRect = svg.getBoundingClientRect();
    const stateRect = (
      mm.state as { rect?: { x1: number; y1: number; x2: number; y2: number } }
    )?.rect;
    if (
      !stateRect ||
      svgRect.width < 120 ||
      svgRect.height < 120 ||
      stateRect.x2 <= stateRect.x1 ||
      stateRect.y2 <= stateRect.y1
    ) {
      await mm.fit();
      syncZoomPill();
      return;
    }
    const barHeight = bar.classList.contains('is-hidden')
      ? 16
      : Math.max(56, Math.round(bar.getBoundingClientRect().height) + 24);
    const padX = 32;
    const padBottom = 24;
    const availW = Math.max(200, svgRect.width - padX * 2);
    const availH = Math.max(160, svgRect.height - barHeight - padBottom);
    const naturalW = stateRect.x2 - stateRect.x1;
    const naturalH = stateRect.y2 - stateRect.y1;
    const scale = Math.min(availW / naturalW, availH / naturalH, 1.35);
    const k = Math.max(0.01, scale);
    const x = padX + (availW - naturalW * k) / 2 - stateRect.x1 * k;
    const y = barHeight + (availH - naturalH * k) / 2 - stateRect.y1 * k;
    mm.setTransform(k, x, y);
    syncZoomPill();
  };

  const restoreCreatorTransform = (allowFallbackToFit = true) => {
    const t = snapshot.transform;
    if (!t || !Number.isFinite(t.k) || t.k <= 0 || t.k > 8) {
      void fitWithToolbarPadding();
      return;
    }
    try {
      const svgRect = svg.getBoundingClientRect();
      let nextX = t.x;
      let nextY = t.y;
      if (
        snapshot.viewport &&
        snapshot.viewport.width > 64 &&
        snapshot.viewport.height > 64 &&
        svgRect.width > 64 &&
        svgRect.height > 64
      ) {
        nextX += (svgRect.width - snapshot.viewport.width) / 2;
        nextY += (svgRect.height - snapshot.viewport.height) / 2;
      }
      if (allowFallbackToFit) {
        const stateRect = (
          mm.state as {
            rect?: { x1: number; y1: number; x2: number; y2: number };
          }
        )?.rect;
        if (stateRect && svgRect.width > 120 && svgRect.height > 120) {
          const left = stateRect.x1 * t.k + nextX;
          const right = stateRect.x2 * t.k + nextX;
          const top = stateRect.y1 * t.k + nextY;
          const bottom = stateRect.y2 * t.k + nextY;
          const barClearance = bar.classList.contains('is-hidden') ? 0 : 56;
          const overlapW = Math.min(right, svgRect.width) - Math.max(left, 0);
          const overlapH =
            Math.min(bottom, svgRect.height) - Math.max(top, barClearance);
          if (overlapW < 120 || overlapH < 80) {
            void fitWithToolbarPadding();
            return;
          }
        }
      }
      mm.setTransform(t.k, nextX, nextY);
      syncZoomPill();
    } catch {
      void fitWithToolbarPadding();
    }
  };

  const hydrationAbort = new AbortController();

  const hydrateOfflineCodeAndDiagrams = (
    container: ParentNode,
    dispose: (cb: () => void) => void,
  ) => {
    const pres = Array.from(
      container.querySelectorAll<HTMLElement>('pre > code'),
    );
    for (const codeEl of pres) {
      const pre = codeEl.parentElement;
      if (
        !(pre instanceof HTMLElement) ||
        pre.dataset.seamindHydrated ||
        pre.closest('.seamind-code-panel, .seamind-node-note')
      ) {
        continue;
      }
      const rawLang =
        Array.from(codeEl.classList)
          .find((n) => n.startsWith('language-'))
          ?.slice('language-'.length)
          .toLowerCase() ?? '';
      const source = codeEl.textContent ?? '';
      const nodePath =
        pre.closest<SVGGElement>('g.markmap-node')?.getAttribute('data-path') ??
        '';

      if (rawLang === 'seamind-excel') {
        const excelCard = buildMindmapExcelCard({
          source,
          nodePath,
          loadDataset: async (assetId) =>
            snapshot.excelDatasets?.[assetId] ?? null,
          signal: hydrationAbort.signal,
          dispose,
          onStateChange: persistSessionState,
        });
        if (excelCard) {
          pre.dataset.seamindHydrated = 'true';
          pre.replaceWith(excelCard);
          dispose(() => {
            delete pre.dataset.seamindHydrated;
            if (excelCard.isConnected) excelCard.replaceWith(pre);
          });
          continue;
        }
      }

      const normLang = normalizeCodeBlockLanguage(rawLang);
      const contentKey = computeCodeBlockResultKey(rawLang || normLang, source);
      const anyRangeKey = computeCodeBlockResultKey(
        rawLang || normLang,
        source,
      );
      const diagramSnap =
        snapshot.diagramSnapshots?.[
          offlineDiagramSnapshotKey(rawLang, source)
        ] ??
        snapshot.diagramSnapshots?.[
          offlineDiagramSnapshotKey(normLang, source)
        ] ??
        snapshot.diagramSnapshots?.[contentKey];
      const execResult =
        snapshot.codeResults?.[contentKey] ??
        snapshot.codeResults?.[anyRangeKey] ??
        Object.entries(snapshot.codeResults ?? {}).find(([k]) =>
          k.endsWith(`:${contentKey.split(':').at(-1)}`),
        )?.[1];

      const cardKey = `offline-code:${nodePath}:${contentKey}`;
      const panel = document.createElement('div');
      panel.className = 'seamind-mm-code-card seamind-code-panel';
      panel.setAttribute('data-seamind-code-interactive', 'true');
      if (collapsedCodeCards.has(cardKey)) {
        panel.classList.add('is-collapsed');
      }

      const head = document.createElement('div');
      head.className = 'seamind-mm-code-head';
      const headLeft = document.createElement('div');
      headLeft.className = 'seamind-mm-code-head-left';

      const collapseBtn = document.createElement('button');
      collapseBtn.type = 'button';
      collapseBtn.className = 'seamind-mm-code-icon-btn';
      const syncCollapseBtn = () => {
        const collapsed = panel.classList.contains('is-collapsed');
        collapseBtn.textContent = collapsed ? '▸' : '▾';
        collapseBtn.title = collapsed ? '展开代码/图表' : '收起代码/图表';
      };
      syncCollapseBtn();
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = panel.classList.toggle('is-collapsed');
        if (collapsed) collapsedCodeCards.add(cardKey);
        else collapsedCodeCards.delete(cardKey);
        syncCollapseBtn();
        persistSessionState();
      });

      const badgeEl = document.createElement('span');
      badgeEl.className = 'seamind-mm-code-badge';
      badgeEl.textContent = codeLanguageBadge(rawLang || normLang);

      const lineCountEl = document.createElement('span');
      lineCountEl.className = 'seamind-mm-code-lines';
      lineCountEl.textContent = `${source.replace(/\n+$/, '').split('\n').length} 行`;

      headLeft.append(collapseBtn, badgeEl, lineCountEl);

      const headRight = document.createElement('div');
      headRight.className = 'seamind-mm-code-actions';

      let showingDiagramSource = false;
      const bodyWrap = document.createElement('div');
      bodyWrap.className = 'seamind-mm-code-body';

      const buildCodeViewport = () => {
        const viewport = document.createElement('div');
        viewport.className = 'seamind-mm-code-viewport';
        viewport.setAttribute('data-seamind-code-scroll', 'true');
        const grid = document.createElement('div');
        grid.className = 'seamind-mm-code-grid';
        const gutter = document.createElement('div');
        gutter.className = 'seamind-mm-code-gutter';
        gutter.setAttribute('aria-hidden', 'true');
        const codePre = document.createElement('pre');
        codePre.className = 'seamind-mm-code-pre';
        renderCodeLinesInto(codePre, gutter, source, normLang);
        grid.append(gutter, codePre);
        viewport.appendChild(grid);
        viewport.addEventListener(
          'wheel',
          (e) => {
            if (e.ctrlKey || e.metaKey) return;
            if (
              viewport.scrollHeight > viewport.clientHeight + 1 ||
              viewport.scrollWidth > viewport.clientWidth + 1
            ) {
              e.stopPropagation();
            }
          },
          { passive: true },
        );
        return viewport;
      };

      const renderDiagramStage = () => {
        const diagDiv = document.createElement('div');
        diagDiv.className = 'mm-offline-diagram-stage';
        diagDiv.setAttribute('data-seamind-code-scroll', 'true');
        if (diagramSnap?.kind === 'svg') {
          diagDiv.innerHTML = diagramSnap.markupOrUrl;
        } else if (diagramSnap?.kind === 'image') {
          const img = document.createElement('img');
          img.src = diagramSnap.markupOrUrl;
          img.alt = `${rawLang} 图表`;
          img.addEventListener('click', (e) => {
            e.stopPropagation();
            openLightbox(diagramSnap.markupOrUrl);
          });
          diagDiv.appendChild(img);
        }
        return diagDiv;
      };

      const renderBody = () => {
        bodyWrap.replaceChildren();
        if (diagramSnap && !showingDiagramSource) {
          bodyWrap.appendChild(renderDiagramStage());
        } else {
          bodyWrap.appendChild(buildCodeViewport());
        }
      };
      renderBody();

      if (diagramSnap) {
        const toggleSourceBtn = document.createElement('button');
        toggleSourceBtn.type = 'button';
        toggleSourceBtn.className = 'seamind-mm-code-btn';
        toggleSourceBtn.textContent = '源码';
        toggleSourceBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showingDiagramSource = !showingDiagramSource;
          toggleSourceBtn.textContent = showingDiagramSource ? '图表' : '源码';
          renderBody();
        });
        headRight.appendChild(toggleSourceBtn);
      }

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'seamind-mm-code-btn';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void copyText(source).then((ok) => {
          if (!ok) return;
          copyBtn.textContent = '已复制';
          window.setTimeout(() => {
            copyBtn.textContent = '复制';
          }, 1400);
        });
      });
      headRight.appendChild(copyBtn);
      head.append(headLeft, headRight);
      panel.append(head, bodyWrap);

      if (execResult && (execResult.outputs?.length || execResult.errorText)) {
        const outKey = `out:${cardKey}`;
        const outWrap = document.createElement('div');
        outWrap.className = 'mm-offline-output-box';
        outWrap.setAttribute('data-seamind-code-scroll', 'true');
        if (collapsedCodeOutputs.has(outKey)) {
          outWrap.style.display = 'none';
        }
        execResult.outputs?.forEach((item: any) => {
          if (item.kind === 'image/png' && item.dataUrl) {
            const figWrap = document.createElement('div');
            figWrap.className = 'seamind-code-note-figure';
            const img = document.createElement('img');
            img.src = item.dataUrl;
            img.alt = '运行结果图表输出';
            img.addEventListener('click', (e) => {
              e.stopPropagation();
              openLightbox(item.dataUrl);
            });
            figWrap.appendChild(img);
            outWrap.appendChild(figWrap);
          } else if (item.kind === 'image/svg+xml' && item.svg) {
            const figWrap = document.createElement('div');
            figWrap.className = 'seamind-code-note-figure';
            figWrap.innerHTML = String(item.svg);
            outWrap.appendChild(figWrap);
          } else if (item.kind === 'text/html' && item.html) {
            const frame = document.createElement('iframe');
            frame.className = 'seamind-code-note-html-frame';
            frame.setAttribute('sandbox', '');
            frame.setAttribute('title', '表格输出');
            frame.srcdoc = String(item.html);
            outWrap.appendChild(frame);
          } else if (item.kind === 'text/latex' && item.latex) {
            const preTex = document.createElement('pre');
            preTex.textContent = String(item.latex);
            outWrap.appendChild(preTex);
          } else if (item.kind === 'error' && item.message) {
            const errItemPre = document.createElement('pre');
            errItemPre.style.color = '#c93b2b';
            errItemPre.textContent = String(item.message);
            outWrap.appendChild(errItemPre);
          } else if (item.text) {
            const wrap = document.createElement('div');
            wrap.className =
              item.kind === 'stream' && item.name === 'stderr'
                ? 'seamind-code-note-stream is-stderr'
                : 'seamind-code-note-stream';
            const preOut = document.createElement('pre');
            preOut.textContent = String(item.text);
            wrap.appendChild(preOut);
            outWrap.appendChild(wrap);
          }
        });
        if (execResult.errorText) {
          const errPre = document.createElement('pre');
          errPre.style.color = '#c93b2b';
          errPre.textContent = execResult.errorText;
          outWrap.appendChild(errPre);
        }
        const outToggleBtn = document.createElement('button');
        outToggleBtn.type = 'button';
        outToggleBtn.className = 'seamind-mm-code-btn';
        outToggleBtn.textContent = collapsedCodeOutputs.has(outKey)
          ? '显示输出'
          : '收起输出';
        outToggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const hidden = outWrap.style.display === 'none';
          outWrap.style.display = hidden ? '' : 'none';
          if (hidden) collapsedCodeOutputs.delete(outKey);
          else collapsedCodeOutputs.add(outKey);
          outToggleBtn.textContent = hidden ? '收起输出' : '显示输出';
          persistSessionState();
        });
        headRight.prepend(outToggleBtn);
        panel.appendChild(outWrap);
      }

      panel.addEventListener('mousedown', (e) => e.stopPropagation());
      panel.addEventListener('pointerdown', (e) => e.stopPropagation());

      pre.dataset.seamindHydrated = 'true';
      pre.replaceWith(panel);
      dispose(() => {
        delete pre.dataset.seamindHydrated;
        if (panel.isConnected) panel.replaceWith(pre);
      });
    }
  };

  const hasUnhydratedMindmapContent = () =>
    Boolean(
      svg.querySelector(
        'pre:not([data-seamind-hydrated]) > code, table:not([data-seamind-table-hydrated]), .seamind-node-note:not([data-seamind-note-hydrated])',
      ),
    );

  let hydrationTimer = 0;
  function scheduleHydration(): void {
    window.clearTimeout(hydrationTimer);
    hydrationTimer = window.setTimeout(() => runHydration(), 30);
  }

  // Zoom updates the transform attribute continuously. Rehydrate only when
  // Markmap inserts a new node, otherwise the layout pass tears the charts down.
  const svgObserver = new MutationObserver((mutations) => {
    syncZoomPill();
    const structural = mutations.some((mutation) => {
      if (mutation.type !== 'childList') return false;
      const target = mutation.target;
      if (
        target instanceof Element &&
        target.closest(
          '.seamind-code-panel, .seamind-mm-media-card, .seamind-mm-table-card, .seamind-node-note, .mm-offline-bar, .mm-offline-diagram-stage',
        )
      ) {
        return false;
      }
      return true;
    });
    if (structural && hasUnhydratedMindmapContent()) scheduleHydration();
  });

  function runHydration(): void {
    const dispose = (cb: () => void) => {
      hydrationAbort.signal.addEventListener('abort', cb, { once: true });
    };
    svgObserver.disconnect();
    try {
      hydrateMindmapTables(svg, dispose, persistSessionState);
      hydrateMindmapNoteCards(svg, {
        onStateChange: persistSessionState,
        dispose,
      });
      hydrateOfflineCodeAndDiagrams(svg, dispose);
      hydrateMindmapMedia(svg, dispose, {
        signal: hydrationAbort.signal,
        onZoomImage: openLightbox,
        onStateChange: persistSessionState,
      });

      // Guard scrollable table wheel events from zooming canvas
      svg
        .querySelectorAll<HTMLElement>('.seamind-mm-table-scroll')
        .forEach((sc) => {
          if (sc.dataset.seamindWheelGuard === 'true') return;
          sc.dataset.seamindWheelGuard = 'true';
          const onWheel = (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) return;
            if (
              sc.scrollHeight > sc.clientHeight + 1 ||
              sc.scrollWidth > sc.clientWidth + 1
            ) {
              e.stopPropagation();
            }
          };
          sc.addEventListener('wheel', onWheel, { passive: true });
          dispose(() => sc.removeEventListener('wheel', onWheel));
        });
    } finally {
      svgObserver.observe(svg, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['transform'],
      });
    }
  }

  const waitForEmbeddedImages = async (timeoutMs = 1500): Promise<void> => {
    const imgs = Array.from(svg.querySelectorAll<HTMLImageElement>('img'));
    const pending = imgs.filter(
      (img) => !img.complete || img.naturalWidth === 0,
    );
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise<void>((resolve) => {
              const done = () => resolve();
              img.addEventListener('load', done, { once: true });
              img.addEventListener('error', done, { once: true });
              if (typeof img.decode === 'function') {
                void img.decode().then(done, done);
              }
            }),
        ),
      ),
      new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
    ]);
  };

  // Initial render. Observe only after the first hydration so layout
  // mutations cannot rebuild the cards before they exist.
  const initialTree = clonePureNodeTree(snapshot.root);
  const initialFolds = savedSession?.foldByPath ?? snapshot.foldByPath ?? {};
  applyFoldOverridesToPureTree(initialTree, initialFolds);

  void mm.setData(initialTree).then(async () => {
    runHydration();
    await waitForEmbeddedImages();
    try {
      await mm.renderData();
      runHydration();
    } catch {
      // ignore if unmounted
    }
    window.requestAnimationFrame(() => {
      if (!savedSession && snapshot.transform) {
        restoreCreatorTransform(true);
      } else {
        void fitWithToolbarPadding();
      }
      syncZoomPill();
    });
  });

  svg.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (target?.closest('g.markmap-node > circle')) {
      window.setTimeout(persistSessionState, 60);
    }
  });

  // Node Search + Auto-Unfold
  let matchedPaths: string[] = [];
  let matchCursor = -1;

  const findMatchesInTree = (
    node: any,
    query: string,
    ancestors: any[] = [],
  ) => {
    if (!node) return;
    const text = stripHtmlText(node.content || '').toLowerCase();
    if (text.includes(query)) {
      matchedPaths.push(String(node.state?.path || ''));
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child: any) =>
        findMatchesInTree(child, query, [...ancestors, node]),
      );
    }
  };

  const focusMatch = (idx: number) => {
    svg
      .querySelectorAll('.markmap-node.is-search-match')
      .forEach((el) => el.classList.remove('is-search-match'));
    if (matchedPaths.length === 0) {
      searchCount.textContent = searchInput.value.trim() ? '0/0' : '';
      return;
    }
    matchCursor = (idx + matchedPaths.length) % matchedPaths.length;
    searchCount.textContent = `${matchCursor + 1}/${matchedPaths.length}`;
    const targetPath = matchedPaths[matchCursor];

    // Unfold any collapsed ancestors to reveal target
    let unfolded = false;
    const ensureUnfolded = (node: any): boolean => {
      if (!node) return false;
      if (String(node.state?.path || '') === targetPath) return true;
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          if (ensureUnfolded(child)) {
            if (node.payload?.fold) {
              node.payload = { ...node.payload, fold: 0 };
              unfolded = true;
            }
            return true;
          }
        }
      }
      return false;
    };
    if (mm.state?.data) {
      ensureUnfolded(mm.state.data);
    }
    const highlightTarget = () => {
      const targetGroup = Array.from(
        svg.querySelectorAll<SVGGElement>('g.markmap-node[data-path]'),
      ).find((g) => g.getAttribute('data-path') === targetPath);
      if (targetGroup) {
        targetGroup.classList.add('is-search-match');
        const datum = (targetGroup as SVGGElement & { __data__?: unknown })
          .__data__;
        if (datum) void mm.centerNode(datum);
      }
    };
    if (unfolded) {
      void mm.renderData().then(() => {
        runHydration();
        window.setTimeout(highlightTarget, 60);
      });
    } else {
      highlightTarget();
    }
  };

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    matchedPaths = [];
    matchCursor = -1;
    if (q && mm.state?.data) {
      findMatchesInTree(mm.state.data, q);
    }
    if (matchedPaths.length > 0) focusMatch(0);
    else focusMatch(-1);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (matchedPaths.length > 0) {
        focusMatch(matchCursor + (e.shiftKey ? -1 : 1));
      }
    }
  });
  prevMatchBtn.addEventListener('click', () => {
    if (matchedPaths.length > 0) focusMatch(matchCursor - 1);
  });
  nextMatchBtn.addEventListener('click', () => {
    if (matchedPaths.length > 0) focusMatch(matchCursor + 1);
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountOfflineViewer);
  } else {
    mountOfflineViewer();
  }
}
