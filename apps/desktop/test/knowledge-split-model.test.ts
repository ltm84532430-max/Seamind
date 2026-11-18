import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignTabToPane,
  clampKnowledgeSplitRatio,
  closeKnowledgePaneSlot,
  closeTabFromState,
  createEmptyKnowledgeSplitState,
  MAX_KNOWLEDGE_TABS,
  moveKnowledgePaneFocus,
  normalizeKnowledgePath,
  openTabInFocusedPane,
  openTabInSidePane,
  remapKnowledgeTabPaths,
  splitOutKnowledgePane,
  switchKnowledgeLayoutMode,
  toggleKnowledgePaneZoom,
  type KnowledgeTab,
} from '../src/knowledge/knowledge-split-model';
import {
  isDirty,
  type Invoke,
  type WorkbenchEnvironment,
} from '../src/workbench/active-document';
import type {
  LibrarySnapshot,
  MapDocument,
  SaveDocumentInput,
} from '../src/library/library';
import { MultiDocumentPool } from '../src/workbench/multi-document-pool';

function tab(name: string, category = '笔记'): KnowledgeTab {
  return {
    path: `${category}/${name}.md`,
    id: `id-${name}`,
    title: name,
    category,
    openedAt: 1,
  };
}

function makeDoc(overrides: Partial<MapDocument> = {}): MapDocument {
  return {
    id: 'doc-a',
    relativePath: '笔记/A.md',
    title: 'A',
    category: '笔记',
    mapType: '文档',
    tags: [],
    kind: 'doc',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function createPoolHarness(
  handlers: Record<string, (args: Record<string, unknown>) => unknown> = {},
) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let discardAnswer = false;
  const remaps: Array<{ oldPath: string; nextPath: string }> = [];
  let snapshot: LibrarySnapshot | null = {
    rootPath: '/library',
    documents: [],
    books: [],
    plantumlFiles: [],
    textDocuments: [],
    categories: [],
  };

  const invoke: Invoke = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    calls.push({ command, args });
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected command: ${command}`);
    return (await handler(args)) as T;
  };

  const environment: WorkbenchEnvironment = {
    getSnapshot: () => snapshot,
    installSnapshot: (next) => {
      snapshot = next;
    },
    refreshList: () => undefined,
    setStatus: () => undefined,
    setError: () => undefined,
    confirmDiscard: () => discardAnswer,
  };

  const pool = new MultiDocumentPool({
    invoke,
    environment,
    autosaveDelayMs: 1200,
    onPathRemapped: (oldPath, nextPath) => {
      remaps.push({ oldPath, nextPath });
    },
  });

  return {
    pool,
    calls,
    remaps,
    setDiscardAnswer: (value: boolean) => {
      discardAnswer = value;
    },
  };
}

describe('knowledge-split-model', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens documents in focused pane and deduplicates visible panes', () => {
    let state = createEmptyKnowledgeSplitState();
    state = openTabInFocusedPane(state, tab('A')).state;
    expect(state.showHomeOverview).toBe(false);
    expect(state.panePaths).toEqual(['笔记/A.md']);

    // Side split upgrades single -> vertical and opens B on the right
    state = openTabInSidePane(state, tab('B')).state;
    expect(state.splitMode).toBe('vertical');
    expect(state.panePaths).toEqual(['笔记/A.md', '笔记/B.md']);
    expect(state.focusedPaneIndex).toBe(1);

    // Normal-clicking A again focuses pane 0 instead of replacing pane 1
    state = openTabInFocusedPane(state, tab('A')).state;
    expect(state.panePaths).toEqual(['笔记/A.md', '笔记/B.md']);
    expect(state.focusedPaneIndex).toBe(0);

    // Opening C replaces focused pane 0 (A stays in tab bar)
    state = openTabInFocusedPane(state, tab('C')).state;
    expect(state.panePaths).toEqual(['笔记/C.md', '笔记/B.md']);
    expect(state.tabs.map((t) => t.title)).toEqual(['A', 'B', 'C']);
  });

  it('fills empty side slots before overwriting occupied panes and allows intentional same-doc compare', () => {
    let state = createEmptyKnowledgeSplitState();
    state = openTabInFocusedPane(state, tab('A')).state;
    state = switchKnowledgeLayoutMode(state, 'tri');
    expect(state.splitMode).toBe('tri');
    expect(state.panePaths).toEqual(['笔记/A.md', null, null]);

    // Opening B in side pane picks empty slot 1 first
    state = openTabInSidePane(state, tab('B')).state;
    expect(state.panePaths).toEqual(['笔记/A.md', '笔记/B.md', null]);
    expect(state.focusedPaneIndex).toBe(1);

    // Assigning A to pane 2 allows reading/editing the same doc side by side
    state = assignTabToPane(state, 2, '笔记/A.md');
    expect(state.panePaths).toEqual(['笔记/A.md', '笔记/B.md', '笔记/A.md']);
    expect(state.focusedPaneIndex).toBe(2);

    // Collapsing back to single keeps focused pane document
    state = switchKnowledgeLayoutMode(state, 'single');
    expect(state.splitMode).toBe('single');
    expect(state.panePaths).toEqual(['笔记/A.md']);
  });

  it('safely evicts only clean background tabs at limit and rejects if all hidden tabs are dirty', () => {
    let state = createEmptyKnowledgeSplitState();
    for (let i = 1; i <= MAX_KNOWLEDGE_TABS; i += 1) {
      state = openTabInFocusedPane(state, tab(`D${i}`)).state;
    }
    expect(state.tabs).toHaveLength(MAX_KNOWLEDGE_TABS);

    // If every hidden tab is dirty, reject opening a 13th tab rather than dropping unsaved work
    const rejected = openTabInFocusedPane(state, tab('D13'), {
      isTabDirty: () => true,
    });
    expect(rejected.rejectedReason).toBe('tab-limit');
    expect(rejected.state.tabs).toHaveLength(MAX_KNOWLEDGE_TABS);

    // If hidden tab D1 is clean, evict D1 cleanly
    const accepted = openTabInFocusedPane(state, tab('D13'), {
      isTabDirty: (path) => path !== '笔记/D1.md',
    });
    expect(accepted.rejectedReason).toBeUndefined();
    expect(accepted.evictedPath).toBe('笔记/D1.md');
    expect(accepted.state.tabs.some((t) => t.path === '笔记/D13.md')).toBe(
      true,
    );
    expect(accepted.state.tabs.some((t) => t.path === '笔记/D1.md')).toBe(
      false,
    );
  });

  it('closes pane slots without closing tabs, supports mirror split, and collapses on tab close', () => {
    let state = createEmptyKnowledgeSplitState();
    state = openTabInFocusedPane(state, tab('A')).state;
    state = splitOutKnowledgePane(state, 0, 'mirror');
    expect(state.splitMode).toBe('vertical');
    expect(state.panePaths).toEqual(['笔记/A.md', '笔记/A.md']);

    // Closing pane 1 leaves tab A open in single pane
    state = {
      ...state,
      paneViewModes: { 0: 'edit', 1: 'read' },
    };
    state = closeKnowledgePaneSlot(state, 1);
    expect(state.splitMode).toBe('single');
    expect(state.panePaths).toEqual(['笔记/A.md']);
    expect(state.paneViewModes).toEqual({ 0: 'edit' });

    // Open B in split and close A -> collapses cleanly to single B
    state = openTabInSidePane(state, tab('B')).state;
    expect(state.panePaths).toEqual(['笔记/A.md', '笔记/B.md']);
    state = closeTabFromState(state, '笔记/A.md');
    expect(state.splitMode).toBe('single');
    expect(state.panePaths).toEqual(['笔记/B.md']);

    // Closing last tab B returns to overview home
    state = closeTabFromState(state, '笔记/B.md');
    expect(state.tabs).toHaveLength(0);
    expect(state.showHomeOverview).toBe(true);
  });

  it('normalizes Windows paths, supports zoom/focus cycling, and remaps renamed paths', () => {
    let state = createEmptyKnowledgeSplitState();
    state = openTabInFocusedPane(state, {
      ...tab('A', '目录\\子目录'),
      path: '目录\\子目录\\A.md',
    }).state;
    state = openTabInSidePane(state, tab('B', '目录\\子目录')).state;

    expect(normalizeKnowledgePath(' 目录\\子目录\\A.md ')).toBe(
      '目录/子目录/A.md',
    );
    state = toggleKnowledgePaneZoom(state, 1);
    expect(state.zoomedPaneIndex).toBe(1);
    state = toggleKnowledgePaneZoom(state);
    expect(state.zoomedPaneIndex).toBeNull();

    state = moveKnowledgePaneFocus(state, -1);
    expect(state.focusedPaneIndex).toBe(0);

    state = remapKnowledgeTabPaths(state, (p) =>
      p.startsWith('目录/') ? `新目录/${p.slice('目录/'.length)}` : p,
    );
    expect(state.panePaths).toEqual([
      '新目录/子目录/A.md',
      '新目录/子目录/B.md',
    ]);
  });

  it('clamps split ratio safely', () => {
    expect(clampKnowledgeSplitRatio(Number.NaN)).toBe(0.5);
    expect(clampKnowledgeSplitRatio(0.05)).toBe(0.22);
    expect(clampKnowledgeSplitRatio(0.99)).toBe(0.78);
    expect(clampKnowledgeSplitRatio(0.6)).toBe(0.6);
  });
});

describe('MultiDocumentPool', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isolates multiple document buffers, deduplicates opens, and autosaves independently', async () => {
    vi.useFakeTimers();
    const docA = makeDoc({ id: 'a', relativePath: '笔记/A.md', title: 'A' });
    const docB = makeDoc({ id: 'b', relativePath: '笔记/B.md', title: 'B' });
    const savedPayloads: SaveDocumentInput[] = [];

    const { pool, calls } = createPoolHarness({
      open_document: ({ relativePath }) => ({
        document: relativePath === '笔记/A.md' ? docA : docB,
        markdown: relativePath === '笔记/A.md' ? '# A\n' : '# B\n',
      }),
      save_document: ({ input }) => {
        const parsed = input as SaveDocumentInput;
        savedPayloads.push(parsed);
        return makeDoc({
          id: parsed.id ?? 'new',
          relativePath: parsed.relativePath ?? '笔记/A.md',
          title: parsed.title,
        });
      },
    });

    // Concurrent open on same path issues only one IPC open_document call
    const [r1, r2] = await Promise.all([
      pool.open({ relativePath: '笔记/A.md' }),
      pool.open({ relativePath: '笔记\\A.md' }),
    ]);
    expect(r1?.title).toBe('A');
    expect(r2?.title).toBe('A');
    expect(calls.filter((c) => c.command === 'open_document')).toHaveLength(1);

    await pool.open({ relativePath: '笔记/B.md' });

    // Editing A does not dirty B or clobber A if re-opened while dirty
    pool.edit('笔记/A.md', '# A\n\n已编辑');
    expect(pool.isDirty('笔记/A.md')).toBe(true);
    expect(pool.isDirty('笔记/B.md')).toBe(false);
    expect(pool.hasAnyDirty()).toBe(true);

    const reopenedWhileDirty = await pool.open({ relativePath: '笔记/A.md' });
    expect(reopenedWhileDirty?.source).toBe('# A\n\n已编辑');
    expect(calls.filter((c) => c.command === 'open_document')).toHaveLength(2);

    // Autosave flushes A after 1200ms without saving clean B
    await vi.advanceTimersByTimeAsync(1200);
    expect(savedPayloads).toHaveLength(1);
    expect(savedPayloads[0].title).toBe('A');
    expect(pool.isDirty('笔记/A.md')).toBe(false);
    expect(isDirty(pool.getDocument('笔记/A.md'))).toBe(false);
  });

  it('refuses closing an unsaved tab when save fails and user cancels discard', async () => {
    const docA = makeDoc();
    const { pool, setDiscardAnswer } = createPoolHarness({
      open_document: () => ({ document: docA, markdown: '# A\n' }),
      save_document: () => {
        throw new Error('磁盘只读');
      },
    });

    await pool.open({ relativePath: '笔记/A.md' });
    pool.edit('笔记/A.md', '# A\n\n未保存改动');

    setDiscardAnswer(false);
    const firstTry = await pool.prepareClose('笔记/A.md');
    expect(firstTry.closed).toBe(false);
    expect(pool.getDocument('笔记/A.md')?.source).toBe('# A\n\n未保存改动');

    setDiscardAnswer(true);
    const secondTry = await pool.prepareClose('笔记/A.md');
    expect(secondTry.closed).toBe(true);
    expect(pool.getDocument('笔记/A.md')).toBeNull();
  });

  it('re-keys entries and emits remap events when renaming moves the relativePath', async () => {
    const docA = makeDoc();
    const { pool, remaps } = createPoolHarness({
      open_document: () => ({ document: docA, markdown: '# A\n' }),
      save_document: ({ input }) => {
        const parsed = input as SaveDocumentInput;
        return makeDoc({
          id: docA.id,
          title: parsed.title,
          relativePath: `笔记/${parsed.title}.md`,
        });
      },
    });

    await pool.open({ relativePath: '笔记/A.md' });
    const ok = await pool.rename('笔记/A.md', 'A2');
    expect(ok).toBe(true);
    expect(remaps).toEqual([{ oldPath: '笔记/A.md', nextPath: '笔记/A2.md' }]);
    expect(pool.getDocument('笔记/A.md')).toBeNull();
    expect(pool.getDocument('笔记/A2.md')?.title).toBe('A2');
  });

  it('recovers cleanly across React StrictMode dispose and revive without dropping subscribers', async () => {
    const docA = makeDoc();
    let notifications = 0;
    const { pool } = createPoolHarness({
      open_document: () => ({ document: docA, markdown: '# A\n' }),
    });

    const unsubscribe = pool.subscribe(() => {
      notifications += 1;
    });

    // Simulate StrictMode unmount cleanup followed by remount revive
    pool.dispose();
    pool.revive();

    const opened = await pool.open({ relativePath: '笔记/A.md' });
    expect(opened?.title).toBe('A');
    expect(notifications).toBeGreaterThan(0);
    expect(pool.getDocument('笔记/A.md')?.source).toBe('# A\n');
    unsubscribe();
  });
});
