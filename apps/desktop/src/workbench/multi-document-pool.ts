import {
  ActiveDocumentController,
  isDirty,
  type ActiveDocument,
  type Invoke,
  type WorkbenchEnvironment,
  type WorkbenchKind,
} from './active-document';
import type {
  DocumentOrigin,
  DocumentSourceRef,
  MapDocument,
} from '../library/library';
import { normalizeKnowledgePath } from '../knowledge/knowledge-split-model';

const DEFAULT_AUTOSAVE_DELAY_MS = 1200;

interface PoolEntry {
  key: string;
  controller: ActiveDocumentController;
  autosaveTimer: ReturnType<typeof setTimeout> | null;
  lastScheduledRevision: number;
  unsubscribe: () => void;
}

export interface MultiDocumentPoolOptions {
  invoke: Invoke;
  environment: WorkbenchEnvironment;
  autosaveDelayMs?: number;
  onPathRemapped?: (
    oldPath: string,
    nextPath: string,
    document: ActiveDocument,
  ) => void;
}

export interface PoolCloseResult {
  closed: boolean;
}

export interface PoolConvertResult {
  mapDocument: MapDocument | null;
  nextState: ActiveDocument | null;
}

export class MultiDocumentPool {
  private readonly invoke: Invoke;
  private readonly environment: WorkbenchEnvironment;
  private readonly autosaveDelayMs: number;
  private readonly onPathRemapped?: MultiDocumentPoolOptions['onPathRemapped'];
  private readonly entries = new Map<string, PoolEntry>();
  private readonly inFlightOpens = new Map<
    string,
    Promise<ActiveDocument | null>
  >();
  private readonly inFlightCloses = new Map<string, Promise<boolean>>();
  private readonly listeners = new Set<() => void>();
  private documentsSnapshot: Record<string, ActiveDocument> = {};
  private disposed = false;
  private lifecycleEpoch = 0;

  constructor(options: MultiDocumentPoolOptions) {
    this.invoke = options.invoke;
    this.environment = options.environment;
    this.autosaveDelayMs = options.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS;
    this.onPathRemapped = options.onPathRemapped;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getDocuments(): Record<string, ActiveDocument> {
    return this.documentsSnapshot;
  }

  getDocument(rawPath: string | null | undefined): ActiveDocument | null {
    if (!rawPath) return null;
    const key = normalizeKnowledgePath(rawPath);
    return this.documentsSnapshot[key] ?? null;
  }

  isDirty(rawPath: string | null | undefined): boolean {
    return isDirty(this.getDocument(rawPath));
  }

  hasAnyDirty(): boolean {
    for (const doc of Object.values(this.documentsSnapshot)) {
      if (isDirty(doc)) return true;
    }
    return false;
  }

  getDirtyPaths(): string[] {
    const dirty: string[] = [];
    for (const [key, doc] of Object.entries(this.documentsSnapshot)) {
      if (isDirty(doc)) dirty.push(key);
    }
    return dirty;
  }

  private rebuildSnapshot(): void {
    const next: Record<string, ActiveDocument> = {};
    for (const [key, entry] of this.entries.entries()) {
      const state = entry.controller.getState();
      if (state && state.kind === 'doc') {
        next[key] = state;
      }
    }
    this.documentsSnapshot = next;
  }

  private emit(): void {
    this.rebuildSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }

  private clearEntryTimer(entry: PoolEntry): void {
    if (entry.autosaveTimer !== null) {
      clearTimeout(entry.autosaveTimer);
      entry.autosaveTimer = null;
    }
  }

  private scheduleEntryAutosave(entry: PoolEntry, state: ActiveDocument): void {
    if (this.disposed || !isDirty(state)) {
      this.clearEntryTimer(entry);
      entry.lastScheduledRevision = state.savedRevision;
      return;
    }
    if (state.revision === entry.lastScheduledRevision) {
      return;
    }
    this.clearEntryTimer(entry);
    entry.lastScheduledRevision = state.revision;
    entry.autosaveTimer = setTimeout(() => {
      entry.autosaveTimer = null;
      if (this.disposed || this.entries.get(entry.key) !== entry) return;
      void entry.controller.save();
    }, this.autosaveDelayMs);
  }

  private registerController(
    initialKey: string,
    controller: ActiveDocumentController,
  ): PoolEntry {
    const existing = this.entries.get(initialKey);
    if (existing) {
      this.clearEntryTimer(existing);
      existing.unsubscribe();
      existing.controller.close();
      this.entries.delete(initialKey);
    }

    const initialState = controller.getState();
    const entry: PoolEntry = {
      key: initialKey,
      controller,
      autosaveTimer: null,
      lastScheduledRevision: initialState?.savedRevision ?? 0,
      unsubscribe: () => undefined,
    };

    entry.unsubscribe = controller.subscribe(() => {
      if (this.disposed) return;
      const nextState = controller.getState();
      if (!nextState) {
        this.clearEntryTimer(entry);
        this.emit();
        return;
      }
      if (nextState.kind === 'doc' && nextState.relativePath) {
        const nextKey = normalizeKnowledgePath(nextState.relativePath);
        if (nextKey && nextKey !== entry.key) {
          const previousKey = entry.key;
          if (this.entries.get(previousKey) === entry) {
            this.entries.delete(previousKey);
            entry.key = nextKey;
            this.entries.set(nextKey, entry);
            this.onPathRemapped?.(previousKey, nextKey, nextState);
          }
        }
      }
      this.scheduleEntryAutosave(entry, nextState);
      this.emit();
    });

    this.entries.set(initialKey, entry);
    this.emit();
    return entry;
  }

  async open(
    target: Pick<MapDocument, 'relativePath'>,
  ): Promise<ActiveDocument | null> {
    if (this.disposed) return null;
    const requestedKey = normalizeKnowledgePath(target.relativePath);
    if (!requestedKey) return null;

    const existing = this.entries.get(requestedKey);
    if (existing) {
      const state = existing.controller.getState();
      if (state && state.kind === 'doc') {
        return state;
      }
    }

    const pending = this.inFlightOpens.get(requestedKey);
    if (pending) {
      return pending;
    }

    const runEpoch = this.lifecycleEpoch;
    const run = (async (): Promise<ActiveDocument | null> => {
      const controller = new ActiveDocumentController(
        this.invoke,
        this.environment,
      );
      const ok = await controller.openMarkdown(target);
      if (this.disposed || runEpoch !== this.lifecycleEpoch || !ok) {
        controller.close();
        return null;
      }
      const opened = controller.getState();
      if (!opened || opened.kind !== 'doc' || !opened.relativePath) {
        controller.close();
        return null;
      }
      const canonicalKey = normalizeKnowledgePath(opened.relativePath);
      this.registerController(canonicalKey, controller);
      return controller.getState();
    })();

    this.inFlightOpens.set(requestedKey, run);
    try {
      return await run;
    } finally {
      this.inFlightOpens.delete(requestedKey);
    }
  }

  async createDocument(
    kind: Extract<WorkbenchKind, 'doc'>,
    category: string,
  ): Promise<ActiveDocument | null> {
    if (this.disposed) return null;
    const controller = new ActiveDocumentController(
      this.invoke,
      this.environment,
    );
    const ok = await controller.createDocument(kind, category);
    if (this.disposed || !ok) {
      controller.close();
      return null;
    }
    const created = controller.getState();
    if (!created || created.kind !== 'doc' || !created.relativePath) {
      controller.close();
      return null;
    }
    const canonicalKey = normalizeKnowledgePath(created.relativePath);
    this.registerController(canonicalKey, controller);
    return controller.getState();
  }

  async createCustomDocument(options: {
    kind?: Extract<WorkbenchKind, 'doc'>;
    category: string;
    title: string;
    source: string;
    tags?: string[];
    origin?: DocumentOrigin;
    sourceRef?: DocumentSourceRef | null;
  }): Promise<ActiveDocument | null> {
    if (this.disposed) return null;
    const controller = new ActiveDocumentController(
      this.invoke,
      this.environment,
    );
    const ok = await controller.createCustomDocument({
      ...options,
      kind: options.kind ?? 'doc',
    });
    if (this.disposed || !ok) {
      controller.close();
      return null;
    }
    const created = controller.getState();
    if (!created || created.kind !== 'doc' || !created.relativePath) {
      controller.close();
      return null;
    }
    const canonicalKey = normalizeKnowledgePath(created.relativePath);
    this.registerController(canonicalKey, controller);
    return controller.getState();
  }

  edit(rawPath: string, source: string): void {
    const key = normalizeKnowledgePath(rawPath);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.controller.edit(source);
  }

  async save(
    rawPath: string,
    options: { manual?: boolean } = {},
  ): Promise<boolean> {
    const key = normalizeKnowledgePath(rawPath);
    const entry = this.entries.get(key);
    if (!entry) return true;
    this.clearEntryTimer(entry);
    return entry.controller.save(options);
  }

  async saveAll(options: { manual?: boolean } = {}): Promise<boolean> {
    const targets = [...this.entries.values()].filter((entry) =>
      isDirty(entry.controller.getState()),
    );
    if (targets.length === 0) return true;
    const results = await Promise.all(
      targets.map((entry) => {
        this.clearEntryTimer(entry);
        return entry.controller.save(options);
      }),
    );
    return results.every(Boolean);
  }

  async rename(rawPath: string, title: string): Promise<boolean> {
    const key = normalizeKnowledgePath(rawPath);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.clearEntryTimer(entry);
    return entry.controller.rename(title);
  }

  async setCategory(rawPath: string, category: string): Promise<boolean> {
    const key = normalizeKnowledgePath(rawPath);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.clearEntryTimer(entry);
    return entry.controller.setCategory(category);
  }

  async setTags(rawPath: string, tags: string[]): Promise<boolean> {
    const key = normalizeKnowledgePath(rawPath);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.clearEntryTimer(entry);
    return entry.controller.setTags(tags);
  }

  async convertToMindmap(rawPath: string): Promise<PoolConvertResult> {
    const key = normalizeKnowledgePath(rawPath);
    const entry = this.entries.get(key);
    if (!entry) {
      return { mapDocument: null, nextState: null };
    }
    this.clearEntryTimer(entry);
    const converted = await entry.controller.convertToMindmap();
    const nextState = entry.controller.getState();
    if (converted) {
      entry.unsubscribe();
      entry.controller.close();
      this.entries.delete(entry.key);
      this.emit();
    }
    return { mapDocument: converted, nextState };
  }

  async prepareClose(rawPath: string): Promise<PoolCloseResult> {
    const key = normalizeKnowledgePath(rawPath);
    const existingClose = this.inFlightCloses.get(key);
    if (existingClose) {
      return { closed: await existingClose };
    }

    const entry = this.entries.get(key);
    if (!entry) {
      return { closed: true };
    }

    const run = (async (): Promise<boolean> => {
      this.clearEntryTimer(entry);
      const canLeave = await entry.controller.leave();
      if (!canLeave) {
        return false;
      }
      if (this.entries.get(entry.key) === entry) {
        entry.unsubscribe();
        this.entries.delete(entry.key);
        this.emit();
      }
      return true;
    })();

    this.inFlightCloses.set(key, run);
    try {
      return { closed: await run };
    } finally {
      this.inFlightCloses.delete(key);
    }
  }

  async closeAll(): Promise<boolean> {
    const keys = [...this.entries.keys()];
    for (const key of keys) {
      const result = await this.prepareClose(key);
      if (!result.closed) {
        return false;
      }
    }
    return true;
  }

  discard(rawPath: string): void {
    const key = normalizeKnowledgePath(rawPath);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.clearEntryTimer(entry);
    entry.unsubscribe();
    void entry.controller.discard();
    this.entries.delete(key);
    this.emit();
  }

  discardByFolder(folderPath: string): string[] {
    const folder = normalizeKnowledgePath(folderPath).replace(/^\/+|\/+$/g, '');
    if (!folder) return [];
    const removed: string[] = [];
    for (const [key, entry] of [...this.entries.entries()]) {
      const docCategory = normalizeKnowledgePath(
        entry.controller.getState()?.category ?? '',
      );
      if (
        key.startsWith(`${folder}/`) ||
        docCategory === folder ||
        docCategory.startsWith(`${folder}/`)
      ) {
        this.clearEntryTimer(entry);
        entry.unsubscribe();
        void entry.controller.discard();
        this.entries.delete(key);
        removed.push(key);
      }
    }
    if (removed.length > 0) {
      this.emit();
    }
    return removed;
  }

  remapPaths(remap: (path: string | null) => string | null): void {
    let changed = false;
    const snapshot = [...this.entries.entries()];
    this.entries.clear();
    for (const [oldKey, entry] of snapshot) {
      entry.controller.remapPaths(remap);
      const mappedRaw = remap(oldKey);
      const nextKey = mappedRaw ? normalizeKnowledgePath(mappedRaw) : oldKey;
      if (nextKey !== oldKey) changed = true;
      entry.key = nextKey;
      this.entries.set(nextKey, entry);
    }
    if (changed) {
      this.emit();
    } else {
      this.rebuildSnapshot();
    }
  }

  canSyncSavedMarkdown(relativePath: string): boolean {
    const key = normalizeKnowledgePath(relativePath);
    const entry = this.entries.get(key);
    if (!entry) return true;
    return entry.controller.canSyncSavedMarkdown(relativePath);
  }

  syncSavedMarkdown(
    relativePath: string,
    markdown: string,
    statusMessage?: string,
  ): boolean {
    const key = normalizeKnowledgePath(relativePath);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.clearEntryTimer(entry);
    return entry.controller.syncSavedMarkdown(
      relativePath,
      markdown,
      statusMessage,
    );
  }

  revive(): void {
    this.disposed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleEpoch += 1;
    for (const entry of this.entries.values()) {
      this.clearEntryTimer(entry);
      entry.unsubscribe();
      entry.controller.close();
    }
    this.entries.clear();
    this.inFlightOpens.clear();
    this.inFlightCloses.clear();
    this.documentsSnapshot = {};
    // Preserve store listeners so React StrictMode double-mount keeps subscriptions wired.
  }
}
