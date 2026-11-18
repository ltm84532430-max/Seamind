export type KnowledgeSplitMode =
  'single' | 'vertical' | 'horizontal' | 'tri' | 'quad';

export type KnowledgePaneDocViewMode = 'edit' | 'split' | 'read';

export interface KnowledgeTab {
  path: string;
  id: string;
  title: string;
  category: string;
  openedAt: number;
}

export interface KnowledgeSplitState {
  tabs: KnowledgeTab[];
  splitMode: KnowledgeSplitMode;
  panePaths: Array<string | null>;
  focusedPaneIndex: number;
  zoomedPaneIndex: number | null;
  splitRatio: number;
  showHomeOverview: boolean;
  paneViewModes: Record<number, KnowledgePaneDocViewMode>;
}

export interface KnowledgeTabMutationResult {
  state: KnowledgeSplitState;
  evictedPath: string | null;
  rejectedReason?: 'tab-limit';
}

export const MAX_KNOWLEDGE_TABS = 12;

export function normalizeKnowledgePath(path: string): string {
  return path.replace(/\\/g, '/').trim();
}

export function visibleKnowledgePaneCount(mode: KnowledgeSplitMode): number {
  switch (mode) {
    case 'vertical':
    case 'horizontal':
      return 2;
    case 'tri':
      return 3;
    case 'quad':
      return 4;
    default:
      return 1;
  }
}

export function clampKnowledgeSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.max(0.22, Math.min(0.78, ratio));
}

export function createEmptyKnowledgeSplitState(): KnowledgeSplitState {
  return {
    tabs: [],
    splitMode: 'single',
    panePaths: [null],
    focusedPaneIndex: 0,
    zoomedPaneIndex: null,
    splitRatio: 0.5,
    showHomeOverview: true,
    paneViewModes: {},
  };
}

function normalizedTabEntry(tab: KnowledgeTab): KnowledgeTab {
  return {
    ...tab,
    path: normalizeKnowledgePath(tab.path),
  };
}

function upsertTabList(
  tabs: ReadonlyArray<KnowledgeTab>,
  incoming: KnowledgeTab,
): KnowledgeTab[] {
  const nextTab = normalizedTabEntry(incoming);
  const existingIdx = tabs.findIndex((t) => t.path === nextTab.path);
  if (existingIdx >= 0) {
    return tabs.map((item, idx) =>
      idx === existingIdx
        ? {
            ...item,
            id: nextTab.id || item.id,
            title: nextTab.title || item.title,
            category: nextTab.category || item.category,
          }
        : item,
    );
  }
  return [...tabs, nextTab];
}

function visiblePathsSet(state: KnowledgeSplitState): Set<string> {
  const count = visibleKnowledgePaneCount(state.splitMode);
  const set = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const p = state.panePaths[i];
    if (p) set.add(normalizeKnowledgePath(p));
  }
  return set;
}

function tryEvictCleanHiddenTab(
  state: KnowledgeSplitState,
  tabs: KnowledgeTab[],
  isTabDirty?: (path: string) => boolean,
): { tabs: KnowledgeTab[]; evictedPath: string | null } {
  if (tabs.length < MAX_KNOWLEDGE_TABS) {
    return { tabs, evictedPath: null };
  }
  const visible = visiblePathsSet(state);
  const candidate = tabs.find(
    (tab) => !visible.has(tab.path) && !isTabDirty?.(tab.path),
  );
  if (!candidate) {
    return { tabs, evictedPath: null };
  }
  return {
    tabs: tabs.filter((tab) => tab.path !== candidate.path),
    evictedPath: candidate.path,
  };
}

export function findVisiblePaneForPath(
  state: KnowledgeSplitState,
  rawPath: string,
): number {
  const target = normalizeKnowledgePath(rawPath);
  if (!target) return -1;
  const count = visibleKnowledgePaneCount(state.splitMode);
  for (let i = 0; i < count; i += 1) {
    const slot = state.panePaths[i];
    if (slot && normalizeKnowledgePath(slot) === target) {
      return i;
    }
  }
  return -1;
}

function normalizedPaneArray(
  rawPanePaths: ReadonlyArray<string | null>,
  count: number,
  validPaths: ReadonlySet<string>,
): Array<string | null> {
  const next: Array<string | null> = [];
  for (let i = 0; i < count; i += 1) {
    const entry = rawPanePaths[i];
    const norm = entry ? normalizeKnowledgePath(entry) : null;
    next.push(norm && validPaths.has(norm) ? norm : null);
  }
  return next;
}

export function openTabInFocusedPane(
  state: KnowledgeSplitState,
  incoming: KnowledgeTab,
  options: {
    isTabDirty?: (path: string) => boolean;
    focusExistingPane?: boolean;
  } = {},
): KnowledgeTabMutationResult {
  const nextTab = normalizedTabEntry(incoming);
  if (!nextTab.path) {
    return { state, evictedPath: null };
  }

  const visibleCount = visibleKnowledgePaneCount(state.splitMode);
  const safeFocused = Math.min(
    Math.max(0, state.focusedPaneIndex),
    visibleCount - 1,
  );
  const existingVisibleIdx =
    options.focusExistingPane === false
      ? -1
      : findVisiblePaneForPath(state, nextTab.path);

  if (existingVisibleIdx >= 0) {
    const updatedTabs = upsertTabList(state.tabs, nextTab);
    return {
      evictedPath: null,
      state: {
        ...state,
        tabs: updatedTabs,
        focusedPaneIndex: existingVisibleIdx,
        zoomedPaneIndex:
          state.zoomedPaneIndex === existingVisibleIdx
            ? existingVisibleIdx
            : null,
        showHomeOverview: false,
      },
    };
  }

  const alreadyOpen = state.tabs.some((tab) => tab.path === nextTab.path);
  let baseTabs = [...state.tabs];
  let evictedPath: string | null = null;
  if (!alreadyOpen && baseTabs.length >= MAX_KNOWLEDGE_TABS) {
    const eviction = tryEvictCleanHiddenTab(
      state,
      baseTabs,
      options.isTabDirty,
    );
    if (!eviction.evictedPath) {
      return {
        state,
        evictedPath: null,
        rejectedReason: 'tab-limit',
      };
    }
    baseTabs = eviction.tabs;
    evictedPath = eviction.evictedPath;
  }

  const updatedTabs = upsertTabList(baseTabs, nextTab);
  const validSet = new Set(updatedTabs.map((t) => t.path));
  const nextPanePaths = normalizedPaneArray(
    state.panePaths,
    visibleCount,
    validSet,
  );
  nextPanePaths[safeFocused] = nextTab.path;

  return {
    evictedPath,
    state: {
      ...state,
      tabs: updatedTabs,
      panePaths: nextPanePaths,
      focusedPaneIndex: safeFocused,
      showHomeOverview: false,
    },
  };
}

export function openTabInSidePane(
  state: KnowledgeSplitState,
  incoming: KnowledgeTab,
  options: {
    targetPaneIndex?: number;
    isTabDirty?: (path: string) => boolean;
  } = {},
): KnowledgeTabMutationResult {
  const nextTab = normalizedTabEntry(incoming);
  if (!nextTab.path) {
    return { state, evictedPath: null };
  }

  const existingVisibleIdx = findVisiblePaneForPath(state, nextTab.path);
  if (existingVisibleIdx >= 0) {
    return {
      evictedPath: null,
      state: {
        ...state,
        tabs: upsertTabList(state.tabs, nextTab),
        focusedPaneIndex: existingVisibleIdx,
        zoomedPaneIndex:
          state.zoomedPaneIndex === existingVisibleIdx
            ? existingVisibleIdx
            : null,
        showHomeOverview: false,
      },
    };
  }

  const alreadyOpen = state.tabs.some((tab) => tab.path === nextTab.path);
  let baseTabs = [...state.tabs];
  let evictedPath: string | null = null;
  if (!alreadyOpen && baseTabs.length >= MAX_KNOWLEDGE_TABS) {
    const eviction = tryEvictCleanHiddenTab(
      state,
      baseTabs,
      options.isTabDirty,
    );
    if (!eviction.evictedPath) {
      return {
        state,
        evictedPath: null,
        rejectedReason: 'tab-limit',
      };
    }
    baseTabs = eviction.tabs;
    evictedPath = eviction.evictedPath;
  }

  const updatedTabs = upsertTabList(baseTabs, nextTab);
  const validSet = new Set(updatedTabs.map((t) => t.path));

  // If currently in home overview or slot 0 is empty while single, just occupy pane 0 cleanly.
  if (
    state.splitMode === 'single' &&
    (!state.panePaths[0] || !validSet.has(state.panePaths[0]))
  ) {
    return {
      evictedPath,
      state: {
        ...state,
        tabs: updatedTabs,
        splitMode: 'single',
        panePaths: [nextTab.path],
        focusedPaneIndex: 0,
        zoomedPaneIndex: null,
        showHomeOverview: false,
      },
    };
  }

  let targetMode: KnowledgeSplitMode = state.splitMode;
  let visibleCount = visibleKnowledgePaneCount(targetMode);
  if (targetMode === 'single') {
    targetMode = 'vertical';
    visibleCount = 2;
  }

  const nextPanePaths = normalizedPaneArray(
    state.panePaths,
    visibleCount,
    validSet,
  );
  if (
    !nextPanePaths[0] &&
    state.panePaths[0] &&
    validSet.has(state.panePaths[0])
  ) {
    nextPanePaths[0] = state.panePaths[0];
  }

  let targetSlot: number;
  if (
    options.targetPaneIndex !== undefined &&
    options.targetPaneIndex >= 0 &&
    options.targetPaneIndex < visibleCount
  ) {
    targetSlot = options.targetPaneIndex;
  } else {
    const emptySlot = nextPanePaths.findIndex((p) => p === null);
    if (emptySlot >= 0) {
      targetSlot = emptySlot;
    } else {
      const safeFocused = Math.min(
        Math.max(0, state.focusedPaneIndex),
        visibleCount - 1,
      );
      targetSlot = (safeFocused + 1) % visibleCount;
    }
  }

  nextPanePaths[targetSlot] = nextTab.path;

  return {
    evictedPath,
    state: {
      ...state,
      tabs: updatedTabs,
      splitMode: targetMode,
      panePaths: nextPanePaths,
      focusedPaneIndex: targetSlot,
      zoomedPaneIndex: null,
      showHomeOverview: false,
    },
  };
}

export function switchKnowledgeLayoutMode(
  state: KnowledgeSplitState,
  mode: KnowledgeSplitMode,
): KnowledgeSplitState {
  const needed = visibleKnowledgePaneCount(mode);
  const validSet = new Set(state.tabs.map((t) => t.path));
  const currentCount = visibleKnowledgePaneCount(state.splitMode);
  const safeFocused = Math.min(
    Math.max(0, state.focusedPaneIndex),
    currentCount - 1,
  );
  const focusedPath = state.panePaths[safeFocused] ?? null;

  const nextPanePaths: Array<string | null> = [];
  for (let i = 0; i < needed; i += 1) {
    const slot = state.panePaths[i] ?? null;
    nextPanePaths.push(slot && validSet.has(slot) ? slot : null);
  }

  // When shrinking panes (e.g. split -> single), keep what the user was actively reading.
  if (
    focusedPath &&
    validSet.has(focusedPath) &&
    !nextPanePaths.includes(focusedPath)
  ) {
    const replaceIdx = Math.min(safeFocused, needed - 1);
    nextPanePaths[replaceIdx] = focusedPath;
  }

  // Fill empty newly revealed panes from unused background tabs if available.
  const used = new Set(nextPanePaths.filter((p): p is string => Boolean(p)));
  for (let i = 0; i < needed; i += 1) {
    if (nextPanePaths[i]) continue;
    const candidate = state.tabs.find((tab) => !used.has(tab.path));
    if (candidate) {
      nextPanePaths[i] = candidate.path;
      used.add(candidate.path);
    }
  }

  const focusedSlotAfter = focusedPath
    ? nextPanePaths.indexOf(focusedPath)
    : -1;

  return {
    ...state,
    splitMode: mode,
    panePaths: nextPanePaths,
    focusedPaneIndex:
      focusedSlotAfter >= 0
        ? focusedSlotAfter
        : Math.min(safeFocused, needed - 1),
    zoomedPaneIndex: null,
    showHomeOverview: state.tabs.length === 0 ? state.showHomeOverview : false,
  };
}

export function assignTabToPane(
  state: KnowledgeSplitState,
  paneIndex: number,
  rawPath: string | null,
): KnowledgeSplitState {
  const visibleCount = visibleKnowledgePaneCount(state.splitMode);
  if (paneIndex < 0 || paneIndex >= visibleCount) return state;

  const validSet = new Set(state.tabs.map((t) => t.path));
  const nextPanePaths = normalizedPaneArray(
    state.panePaths,
    visibleCount,
    validSet,
  );

  if (rawPath === null) {
    nextPanePaths[paneIndex] = null;
    return {
      ...state,
      panePaths: nextPanePaths,
      focusedPaneIndex: paneIndex,
    };
  }

  const normalized = normalizeKnowledgePath(rawPath);
  if (!validSet.has(normalized)) return state;

  nextPanePaths[paneIndex] = normalized;
  return {
    ...state,
    panePaths: nextPanePaths,
    focusedPaneIndex: paneIndex,
    showHomeOverview: false,
  };
}

function stepDownSplitMode(mode: KnowledgeSplitMode): KnowledgeSplitMode {
  switch (mode) {
    case 'quad':
      return 'tri';
    case 'tri':
      return 'vertical';
    case 'vertical':
    case 'horizontal':
      return 'single';
    default:
      return 'single';
  }
}

export function closeKnowledgePaneSlot(
  state: KnowledgeSplitState,
  paneIndex: number,
): KnowledgeSplitState {
  const visibleCount = visibleKnowledgePaneCount(state.splitMode);
  if (visibleCount <= 1 || paneIndex < 0 || paneIndex >= visibleCount) {
    return state;
  }

  const nextMode = stepDownSplitMode(state.splitMode);
  const nextCount = visibleKnowledgePaneCount(nextMode);
  const validSet = new Set(state.tabs.map((t) => t.path));

  const remainingSlots: Array<string | null> = [];
  for (let i = 0; i < visibleCount; i += 1) {
    if (i === paneIndex) continue;
    const entry = state.panePaths[i] ?? null;
    remainingSlots.push(entry && validSet.has(entry) ? entry : null);
  }
  while (remainingSlots.length < nextCount) {
    remainingSlots.push(null);
  }

  let nextFocus = state.focusedPaneIndex;
  if (paneIndex < nextFocus) {
    nextFocus -= 1;
  } else if (nextFocus >= nextCount) {
    nextFocus = Math.max(0, nextCount - 1);
  }

  const nextViewModes: Record<number, KnowledgePaneDocViewMode> = {};
  for (const [rawKey, modeVal] of Object.entries(state.paneViewModes)) {
    const idx = Number(rawKey);
    if (!Number.isInteger(idx) || idx === paneIndex) continue;
    const mappedIdx = idx > paneIndex ? idx - 1 : idx;
    if (mappedIdx >= 0 && mappedIdx < nextCount) {
      nextViewModes[mappedIdx] = modeVal;
    }
  }

  return {
    ...state,
    splitMode: nextMode,
    panePaths: remainingSlots.slice(0, nextCount),
    focusedPaneIndex: nextFocus,
    zoomedPaneIndex: null,
    paneViewModes: nextViewModes,
  };
}

export function splitOutKnowledgePane(
  state: KnowledgeSplitState,
  fromPaneIndex: number,
  mode: 'next-or-empty' | 'mirror' = 'next-or-empty',
): KnowledgeSplitState {
  let nextMode: KnowledgeSplitMode = state.splitMode;
  if (state.splitMode === 'single') nextMode = 'vertical';
  else if (state.splitMode === 'vertical' || state.splitMode === 'horizontal') {
    nextMode = 'tri';
  } else if (state.splitMode === 'tri') {
    nextMode = 'quad';
  }

  const nextCount = visibleKnowledgePaneCount(nextMode);
  const validSet = new Set(state.tabs.map((t) => t.path));
  const nextPanePaths = normalizedPaneArray(
    state.panePaths,
    nextCount,
    validSet,
  );

  const sourcePath = state.panePaths[fromPaneIndex] ?? null;
  const newSlotIdx = nextCount - 1;
  const emptyIdx = nextPanePaths.findIndex(
    (p, idx) => idx < nextCount && p === null,
  );
  const targetIdx =
    nextMode === state.splitMode && emptyIdx < 0
      ? (fromPaneIndex + 1) % nextCount
      : emptyIdx >= 0
        ? emptyIdx
        : newSlotIdx;

  if (mode === 'mirror' && sourcePath && validSet.has(sourcePath)) {
    nextPanePaths[targetIdx] = sourcePath;
  } else {
    const visible = new Set(
      nextPanePaths.filter((p): p is string => Boolean(p)),
    );
    const unused = state.tabs.find((t) => !visible.has(t.path));
    nextPanePaths[targetIdx] = unused ? unused.path : null;
  }

  return {
    ...state,
    splitMode: nextMode,
    panePaths: nextPanePaths,
    focusedPaneIndex: targetIdx,
    zoomedPaneIndex: null,
    showHomeOverview: false,
  };
}

export function closeTabFromState(
  state: KnowledgeSplitState,
  rawPath: string,
): KnowledgeSplitState {
  const target = normalizeKnowledgePath(rawPath);
  const nextTabs = state.tabs.filter((tab) => tab.path !== target);
  if (nextTabs.length === state.tabs.length) {
    return state;
  }

  if (nextTabs.length === 0) {
    return {
      ...state,
      tabs: [],
      splitMode: 'single',
      panePaths: [null],
      focusedPaneIndex: 0,
      zoomedPaneIndex: null,
      showHomeOverview: true,
      paneViewModes: {},
    };
  }

  const validSet = new Set(nextTabs.map((t) => t.path));
  const nextMode = state.splitMode;
  let visibleCount = visibleKnowledgePaneCount(nextMode);
  const replaced: Array<string | null> = [];
  const used = new Set<string>();

  for (let i = 0; i < visibleCount; i += 1) {
    const entry = state.panePaths[i] ?? null;
    if (entry && entry !== target && validSet.has(entry)) {
      replaced.push(entry);
      used.add(entry);
    } else {
      replaced.push(null);
    }
  }

  // Fill any vacated slot with an unused background tab first.
  for (let i = 0; i < replaced.length; i += 1) {
    if (replaced[i] !== null) continue;
    const spare = nextTabs.find((tab) => !used.has(tab.path));
    if (spare) {
      replaced[i] = spare.path;
      used.add(spare.path);
    }
  }

  // Collapse completely empty vacated split slots when closing tabs leaves fewer assigned docs.
  let safeState: KnowledgeSplitState = {
    ...state,
    tabs: nextTabs,
    splitMode: nextMode,
    panePaths: replaced,
  };

  while (visibleKnowledgePaneCount(safeState.splitMode) > 1) {
    const count = visibleKnowledgePaneCount(safeState.splitMode);
    const emptyIdx = safeState.panePaths
      .slice(0, count)
      .findIndex((p) => p === null);
    if (emptyIdx < 0) break;
    safeState = closeKnowledgePaneSlot(safeState, emptyIdx);
  }

  visibleCount = visibleKnowledgePaneCount(safeState.splitMode);
  if (!safeState.panePaths[0] && nextTabs[0]) {
    safeState = {
      ...safeState,
      panePaths: [nextTabs[0].path, ...safeState.panePaths.slice(1)],
    };
  }

  return {
    ...safeState,
    focusedPaneIndex: Math.min(
      Math.max(0, safeState.focusedPaneIndex),
      Math.max(0, visibleCount - 1),
    ),
    zoomedPaneIndex:
      safeState.zoomedPaneIndex !== null &&
      safeState.zoomedPaneIndex < visibleCount
        ? safeState.zoomedPaneIndex
        : null,
  };
}

export function remapKnowledgeTabPaths(
  state: KnowledgeSplitState,
  remap: (path: string) => string | null,
): KnowledgeSplitState {
  let changed = false;
  const dedupedTabs: KnowledgeTab[] = [];
  const seen = new Set<string>();

  for (const tab of state.tabs) {
    const remapped = remap(tab.path);
    const nextPath = remapped ? normalizeKnowledgePath(remapped) : tab.path;
    if (nextPath !== tab.path) changed = true;
    if (seen.has(nextPath)) {
      changed = true;
      continue;
    }
    seen.add(nextPath);
    dedupedTabs.push(nextPath === tab.path ? tab : { ...tab, path: nextPath });
  }

  const nextPanePaths = state.panePaths.map((slot) => {
    if (!slot) return null;
    const remapped = remap(slot);
    const nextPath = remapped ? normalizeKnowledgePath(remapped) : slot;
    if (nextPath !== slot) changed = true;
    return seen.has(nextPath) ? nextPath : null;
  });

  if (!changed) return state;

  return {
    ...state,
    tabs: dedupedTabs,
    panePaths: nextPanePaths,
  };
}

export function moveKnowledgePaneFocus(
  state: KnowledgeSplitState,
  delta: 1 | -1,
): KnowledgeSplitState {
  const count = visibleKnowledgePaneCount(state.splitMode);
  if (count <= 1) return state;
  const next = (state.focusedPaneIndex + delta + count) % count;
  return {
    ...state,
    focusedPaneIndex: next,
  };
}

export function toggleKnowledgePaneZoom(
  state: KnowledgeSplitState,
  paneIndex?: number,
): KnowledgeSplitState {
  const count = visibleKnowledgePaneCount(state.splitMode);
  if (count <= 1) {
    return state.zoomedPaneIndex === null
      ? state
      : { ...state, zoomedPaneIndex: null };
  }
  const target =
    paneIndex !== undefined && paneIndex >= 0 && paneIndex < count
      ? paneIndex
      : Math.min(Math.max(0, state.focusedPaneIndex), count - 1);
  return {
    ...state,
    zoomedPaneIndex: state.zoomedPaneIndex === null ? target : null,
    focusedPaneIndex:
      state.zoomedPaneIndex === null ? target : state.focusedPaneIndex,
  };
}
