import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { invokeLibraryCommand } from '../library/library-api';
import type {
  DocumentOrigin,
  DocumentSourceRef,
  MapDocument,
} from '../library/library';
import type {
  ActiveDocument,
  WorkbenchEnvironment,
} from '../workbench/active-document';
import { isDirty } from '../workbench/active-document';
import { MultiDocumentPool } from '../workbench/multi-document-pool';
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
  visibleKnowledgePaneCount,
  type KnowledgePaneDocViewMode,
  type KnowledgeSplitMode,
  type KnowledgeSplitState,
  type KnowledgeTab,
} from './knowledge-split-model';

export interface OpenKnowledgeNoteOptions {
  split?: boolean;
  targetPaneIndex?: number;
  focusExistingPane?: boolean;
}

export interface CreateKnowledgeNoteOptions {
  category: string;
  title?: string;
  source?: string;
  tags?: string[];
  origin?: DocumentOrigin;
  sourceRef?: DocumentSourceRef | null;
  split?: boolean;
  targetPaneIndex?: number;
}

export function useKnowledgeSplitWorkspace(environment: WorkbenchEnvironment) {
  const latestEnvRef = useRef(environment);
  latestEnvRef.current = environment;

  const [splitState, setSplitState] = useState<KnowledgeSplitState>(() =>
    createEmptyKnowledgeSplitState(),
  );
  const splitStateRef = useRef(splitState);
  splitStateRef.current = splitState;

  const commitSplitState = useCallback(
    (
      updater:
        | KnowledgeSplitState
        | ((prev: KnowledgeSplitState) => KnowledgeSplitState),
    ) => {
      const next =
        typeof updater === 'function'
          ? updater(splitStateRef.current)
          : updater;
      splitStateRef.current = next;
      setSplitState(next);
      return next;
    },
    [],
  );

  const [pool] = useState(
    () =>
      new MultiDocumentPool({
        invoke: invokeLibraryCommand,
        environment: {
          getSnapshot: () => latestEnvRef.current.getSnapshot(),
          installSnapshot: (snapshot) =>
            latestEnvRef.current.installSnapshot(snapshot),
          refreshList: () => latestEnvRef.current.refreshList(),
          setStatus: (message) => latestEnvRef.current.setStatus(message),
          setError: (message) => latestEnvRef.current.setError(message),
          confirmDiscard: (message) =>
            latestEnvRef.current.confirmDiscard(message),
        },
        onPathRemapped: (oldPath, nextPath, doc) => {
          commitSplitState((prev) => {
            const remapped = remapKnowledgeTabPaths(prev, (p) =>
              normalizeKnowledgePath(p) === normalizeKnowledgePath(oldPath)
                ? nextPath
                : p,
            );
            const normNext = normalizeKnowledgePath(nextPath);
            return {
              ...remapped,
              tabs: remapped.tabs.map((tab) =>
                tab.path === normNext
                  ? {
                      ...tab,
                      id: doc.id,
                      title: doc.title,
                      category: doc.category,
                    }
                  : tab,
              ),
            };
          });
        },
      }),
  );

  useEffect(() => {
    pool.revive();
    return () => {
      pool.dispose();
    };
  }, [pool]);

  const subscribePool = useCallback(
    (listener: () => void) => pool.subscribe(listener),
    [pool],
  );
  const getPoolDocuments = useCallback(() => pool.getDocuments(), [pool]);

  const documentsByPath = useSyncExternalStore(subscribePool, getPoolDocuments);

  const integrateDocument = useCallback(
    (
      doc: ActiveDocument,
      options: {
        split?: boolean;
        targetPaneIndex?: number;
        focusExistingPane?: boolean;
      } = {},
    ): boolean => {
      const tabPayload: KnowledgeTab = {
        path: doc.relativePath,
        id: doc.id,
        title: doc.title,
        category: doc.category,
        openedAt: Date.now(),
      };
      const prev = splitStateRef.current;
      const useSidePane =
        options.split || options.targetPaneIndex !== undefined;
      const transition = useSidePane
        ? openTabInSidePane(prev, tabPayload, {
            targetPaneIndex: options.targetPaneIndex,
            isTabDirty: (path) => pool.isDirty(path),
          })
        : openTabInFocusedPane(prev, tabPayload, {
            focusExistingPane: options.focusExistingPane,
            isTabDirty: (path) => pool.isDirty(path),
          });

      if (transition.rejectedReason === 'tab-limit') {
        latestEnvRef.current.setError(
          `最多同时保持 ${MAX_KNOWLEDGE_TABS} 篇文档，当前所有后台文档均有未保存修改，请先关闭部分标签。`,
        );
        return false;
      }

      commitSplitState(transition.state);
      if (transition.evictedPath) {
        pool.discard(transition.evictedPath);
      }
      return true;
    },
    [commitSplitState, pool],
  );

  const openNote = useCallback(
    async (
      note: Pick<MapDocument, 'relativePath'> & Partial<MapDocument>,
      options: OpenKnowledgeNoteOptions = {},
    ): Promise<boolean> => {
      const opened = await pool.open({ relativePath: note.relativePath });
      if (!opened) return false;
      return integrateDocument(opened, options);
    },
    [integrateDocument, pool],
  );

  const createNote = useCallback(
    async (
      options: CreateKnowledgeNoteOptions,
    ): Promise<ActiveDocument | null> => {
      const created =
        options.title !== undefined || options.source !== undefined
          ? await pool.createCustomDocument({
              kind: 'doc',
              category: options.category,
              title: options.title ?? '未命名笔记',
              source: options.source ?? '',
              tags: options.tags,
              origin: options.origin,
              sourceRef: options.sourceRef,
            })
          : await pool.createDocument('doc', options.category);

      if (!created) return null;
      integrateDocument(created, {
        split: options.split,
        targetPaneIndex: options.targetPaneIndex,
      });
      return created;
    },
    [integrateDocument, pool],
  );

  const closeTab = useCallback(
    async (rawPath: string): Promise<boolean> => {
      const target = normalizeKnowledgePath(rawPath);
      const res = await pool.prepareClose(target);
      if (!res.closed) return false;
      commitSplitState((prev) => closeTabFromState(prev, target));
      return true;
    },
    [commitSplitState, pool],
  );

  const closeAll = useCallback(async (): Promise<boolean> => {
    const closed = await pool.closeAll();
    if (!closed) return false;
    commitSplitState(createEmptyKnowledgeSplitState());
    return true;
  }, [commitSplitState, pool]);

  const discardDoc = useCallback(
    (rawPath: string) => {
      const normalized = normalizeKnowledgePath(rawPath);
      pool.discard(normalized);
      commitSplitState((prev) => closeTabFromState(prev, normalized));
    },
    [commitSplitState, pool],
  );

  const discardFolder = useCallback(
    (folderPath: string) => {
      const removed = pool.discardByFolder(folderPath);
      if (removed.length > 0) {
        commitSplitState((prev) => {
          let next = prev;
          for (const path of removed) {
            next = closeTabFromState(next, path);
          }
          return next;
        });
      }
    },
    [commitSplitState, pool],
  );

  const remapPaths = useCallback(
    (remap: (path: string | null) => string | null) => {
      pool.remapPaths(remap);
      commitSplitState((prev) => remapKnowledgeTabPaths(prev, (p) => remap(p)));
    },
    [commitSplitState, pool],
  );

  const canSyncSavedMarkdown = useCallback(
    (relativePath: string) => pool.canSyncSavedMarkdown(relativePath),
    [pool],
  );

  const syncSavedMarkdown = useCallback(
    (relativePath: string, markdown: string, statusMessage?: string) => {
      return pool.syncSavedMarkdown(relativePath, markdown, statusMessage);
    },
    [pool],
  );

  const saveDoc = useCallback(
    (path: string, manual = true) => pool.save(path, { manual }),
    [pool],
  );

  const saveAll = useCallback(
    (manual = true) => pool.saveAll({ manual }),
    [pool],
  );

  const editDoc = useCallback(
    (path: string, source: string) => pool.edit(path, source),
    [pool],
  );

  const renameDoc = useCallback(
    (path: string, title: string) => pool.rename(path, title),
    [pool],
  );

  const setCategoryDoc = useCallback(
    (path: string, category: string) => pool.setCategory(path, category),
    [pool],
  );

  const setTagsDoc = useCallback(
    (path: string, tags: string[]) => pool.setTags(path, tags),
    [pool],
  );

  const convertToMindmapDoc = useCallback(
    async (path: string): Promise<MapDocument | null> => {
      const normalized = normalizeKnowledgePath(path);
      const res = await pool.convertToMindmap(normalized);
      if (res.mapDocument) {
        commitSplitState((prev) => closeTabFromState(prev, normalized));
      }
      return res.mapDocument;
    },
    [commitSplitState, pool],
  );

  const flushForMindmapPreview = useCallback(
    async (path: string): Promise<boolean> => {
      const normalized = normalizeKnowledgePath(path);
      return pool.save(normalized, { manual: true });
    },
    [pool],
  );

  const switchLayout = useCallback(
    (mode: KnowledgeSplitMode) => {
      commitSplitState((prev) => switchKnowledgeLayoutMode(prev, mode));
    },
    [commitSplitState],
  );

  const focusPane = useCallback(
    (paneIndex: number) => {
      commitSplitState((prev) => {
        const max = Math.max(0, visibleKnowledgePaneCount(prev.splitMode) - 1);
        const clamped = Math.max(0, Math.min(max, paneIndex));
        if (prev.focusedPaneIndex === clamped && !prev.showHomeOverview) {
          return prev;
        }
        return {
          ...prev,
          focusedPaneIndex: clamped,
          showHomeOverview: false,
        };
      });
    },
    [commitSplitState],
  );

  const assignTab = useCallback(
    (paneIndex: number, path: string | null) => {
      commitSplitState((prev) => assignTabToPane(prev, paneIndex, path));
    },
    [commitSplitState],
  );

  const splitOutPane = useCallback(
    (paneIndex: number, mode: 'next-or-empty' | 'mirror' = 'next-or-empty') => {
      commitSplitState((prev) => splitOutKnowledgePane(prev, paneIndex, mode));
    },
    [commitSplitState],
  );

  const closePaneSlot = useCallback(
    (paneIndex: number) => {
      commitSplitState((prev) => closeKnowledgePaneSlot(prev, paneIndex));
    },
    [commitSplitState],
  );

  const toggleZoom = useCallback(
    (paneIndex?: number) => {
      commitSplitState((prev) => toggleKnowledgePaneZoom(prev, paneIndex));
    },
    [commitSplitState],
  );

  const moveFocus = useCallback(
    (delta: 1 | -1) => {
      commitSplitState((prev) => moveKnowledgePaneFocus(prev, delta));
    },
    [commitSplitState],
  );

  const setSplitRatio = useCallback(
    (ratio: number) => {
      commitSplitState((prev) => ({
        ...prev,
        splitRatio: clampKnowledgeSplitRatio(ratio),
      }));
    },
    [commitSplitState],
  );

  const showOverview = useCallback(
    (show = true) => {
      commitSplitState((prev) => ({
        ...prev,
        showHomeOverview: show,
      }));
    },
    [commitSplitState],
  );

  const setPaneViewMode = useCallback(
    (paneIndex: number, mode: KnowledgePaneDocViewMode) => {
      commitSplitState((prev) => ({
        ...prev,
        paneViewModes: {
          ...prev.paneViewModes,
          [paneIndex]: mode,
        },
      }));
    },
    [commitSplitState],
  );

  const safeFocusedPaneIndex = useMemo(() => {
    const count = visibleKnowledgePaneCount(splitState.splitMode);
    return Math.min(Math.max(0, splitState.focusedPaneIndex), count - 1);
  }, [splitState.focusedPaneIndex, splitState.splitMode]);

  const focusedPath = useMemo(() => {
    if (splitState.showHomeOverview) return null;
    const raw = splitState.panePaths[safeFocusedPaneIndex] ?? null;
    return raw ? normalizeKnowledgePath(raw) : null;
  }, [safeFocusedPaneIndex, splitState.panePaths, splitState.showHomeOverview]);

  const focusedDocument = useMemo<ActiveDocument | null>(() => {
    if (!focusedPath) return null;
    return documentsByPath[focusedPath] ?? null;
  }, [documentsByPath, focusedPath]);

  const anyDirty = useMemo(
    () => Object.values(documentsByPath).some((doc) => isDirty(doc)),
    [documentsByPath],
  );

  return {
    splitState,
    documentsByPath,
    focusedDocument,
    focusedPath,
    safeFocusedPaneIndex,
    anyDirty,
    openNote,
    createNote,
    closeTab,
    closeAll,
    discardDoc,
    discardFolder,
    remapPaths,
    canSyncSavedMarkdown,
    syncSavedMarkdown,
    editDoc,
    saveDoc,
    saveAll,
    renameDoc,
    setCategoryDoc,
    setTagsDoc,
    convertToMindmapDoc,
    flushForMindmapPreview,
    switchLayout,
    focusPane,
    assignTab,
    splitOutPane,
    closePaneSlot,
    toggleZoom,
    moveFocus,
    setSplitRatio,
    showOverview,
    setPaneViewMode,
  };
}

export type KnowledgeSplitWorkspaceHandle = ReturnType<
  typeof useKnowledgeSplitWorkspace
>;
