import type {
  LibrarySnapshot,
  MapDocument,
  OpenedDocument,
  OpenedTextDocument,
  SaveDocumentInput,
  TextDocument,
} from '../library';
import { NEW_FILE_TEMPLATES } from './templates';

/** The file kinds the document workbench edits: Markdown documents and Mermaid diagrams. */
export type WorkbenchKind = 'doc' | 'mermaid';

export interface ActiveDocument {
  kind: WorkbenchKind;
  /** Changes whenever another document is opened, and not when this one is renamed or moved. */
  session: number;
  id: string;
  relativePath: string;
  title: string;
  category: string;
  /** The mind-map metadata a Markdown document carries, kept so saving does not drop it. */
  mapType: string;
  tags: string[];
  source: string;
  /** Counts edits. A save covers the revision it started with, and later edits stay unsaved. */
  revision: number;
  savedRevision: number;
}

export type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** What the controller needs from the app around it. */
export interface WorkbenchEnvironment {
  getSnapshot(): LibrarySnapshot | null;
  installSnapshot(snapshot: LibrarySnapshot): void;
  /** Runs the library search again, so the list follows the query and folder filter. */
  refreshList(): void;
  setStatus(message: string): void;
  setError(message: string): void;
  /**
   * Asked when unsaved edits cannot be saved and something else wants the workbench: true gives
   * them up. Without it, a document the backend refuses (say, one emptied out) could never be left.
   */
  confirmDiscard(message: string): boolean;
}

export function isDirty(document: ActiveDocument | null): boolean {
  return document !== null && document.revision !== document.savedRevision;
}

function failureMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** The folder `category` and each folder above it, added to the library's folder list. */
function withCategories(snapshot: LibrarySnapshot, category: string): string[] {
  const categories = new Set(snapshot.categories);
  const parts = category.split('/').filter(Boolean);
  for (let index = 1; index <= parts.length; index += 1)
    categories.add(parts.slice(0, index).join('/'));
  return [...categories].sort();
}

const MAX_SAVE_ROUNDS = 5;
/** Documents created in the workbench say so in their mind-map type column. */
const DOCUMENT_MAP_TYPE = '文档';

/**
 * The document open in the workbench, with its saving rules. It is a plain class so React only
 * has to subscribe to it, and so the rules can be tested without a window.
 */
export class ActiveDocumentController {
  private state: ActiveDocument | null = null;
  private readonly listeners = new Set<() => void>();
  private saving: Promise<boolean> | null = null;
  // Bumped when the open document is replaced or closed, so a save that was already running does
  // not write its result onto a different document.
  private generation = 0;
  private opening = 0;
  private sessions = 0;
  // Why the last save failed, for the question asked before edits are given up.
  private lastFailure = '';

  constructor(
    private readonly invoke: Invoke,
    private readonly environment: WorkbenchEnvironment,
  ) {}

  readonly getState = (): ActiveDocument | null => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: ActiveDocument | null): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  edit(source: string): void {
    const current = this.state;
    if (!current || current.source === source) return;
    this.set({ ...current, source, revision: current.revision + 1 });
  }

  /** Saves unsaved edits, waiting for a save that is already running. */
  async save(options: { manual?: boolean } = {}): Promise<boolean> {
    for (let round = 0; round < MAX_SAVE_ROUNDS; round += 1) {
      if (this.saving) {
        if (!(await this.saving)) return false;
        continue;
      }
      const snapshot = this.state;
      if (!snapshot || !isDirty(snapshot)) return true;
      const task = this.write(snapshot, options.manual ?? false);
      this.saving = task;
      let saved = false;
      try {
        saved = await task;
      } finally {
        if (this.saving === task) this.saving = null;
      }
      if (!saved) return false;
    }
    // Typing kept outrunning the saves; the edits made since are still on screen and unsaved.
    return !isDirty(this.state);
  }

  private async write(
    saved: ActiveDocument,
    manual: boolean,
  ): Promise<boolean> {
    const generation = this.generation;
    this.environment.setStatus('正在保存…');
    try {
      if (saved.kind === 'mermaid') {
        const document = await this.invoke<TextDocument>('save_text_document', {
          relativePath: saved.relativePath,
          source: saved.source,
        });
        this.afterSave(generation, saved, document);
        this.upsertTextDocument(document, saved.relativePath);
      } else {
        const input: SaveDocumentInput = {
          id: saved.id,
          relativePath: saved.relativePath,
          title: saved.title.trim(),
          category: saved.category,
          mapType: saved.mapType,
          tags: saved.tags,
          markdown: saved.source,
          historySource: manual ? 'manual' : 'autosave',
          kind: 'doc',
        };
        const document = await this.invoke<MapDocument>('save_document', {
          input,
        });
        this.afterSave(generation, saved, document);
        this.upsertDocument(document);
      }
      this.environment.setStatus(
        generation === this.generation && isDirty(this.state)
          ? '正在保存后续修改…'
          : '已保存到本机',
      );
      this.environment.setError('');
      this.lastFailure = '';
      return true;
    } catch (error) {
      this.lastFailure = failureMessage(error, '保存失败');
      this.environment.setStatus(this.lastFailure);
      return false;
    }
  }

  /**
   * Saves what is open so that something else can take its place. When that fails, the edits
   * stay unless the user agrees to give them up.
   */
  private async flush(): Promise<boolean> {
    if (await this.save()) return true;
    return this.environment.confirmDiscard(
      `${this.lastFailure || '保存失败'}\n\n仍要放弃这份文档里未保存的修改吗？`,
    );
  }

  private afterSave(
    generation: number,
    saved: ActiveDocument,
    document: Pick<MapDocument, 'id' | 'relativePath' | 'title' | 'category'>,
  ): void {
    const current = this.state;
    if (generation !== this.generation || !current) return;
    this.set({
      ...current,
      id: document.id,
      relativePath: document.relativePath,
      category: document.category,
      title:
        current.revision === saved.revision ? document.title : current.title,
      savedRevision: saved.revision,
    });
  }

  private upsertDocument(saved: MapDocument): void {
    const snapshot = this.environment.getSnapshot();
    if (!snapshot) return;
    this.environment.installSnapshot({
      ...snapshot,
      categories: withCategories(snapshot, saved.category),
      documents: [
        saved,
        ...snapshot.documents.filter(
          (candidate) =>
            candidate.relativePath !== saved.relativePath &&
            candidate.id !== saved.id,
        ),
      ],
    });
    this.environment.refreshList();
  }

  private upsertTextDocument(saved: TextDocument, replacedPath?: string): void {
    const snapshot = this.environment.getSnapshot();
    if (!snapshot) return;
    this.environment.installSnapshot({
      ...snapshot,
      categories: withCategories(snapshot, saved.category),
      textDocuments: [
        saved,
        ...(snapshot.textDocuments ?? []).filter(
          (candidate) =>
            candidate.relativePath !== saved.relativePath &&
            candidate.relativePath !== replacedPath &&
            candidate.id !== saved.id,
        ),
      ],
    });
  }

  /** Saves what is open, then swaps in the document `load` produces. */
  private async replaceWith(
    failure: string,
    load: () => Promise<ActiveDocument>,
  ): Promise<boolean> {
    if (!(await this.flush())) return false;
    const ticket = ++this.opening;
    let next: ActiveDocument;
    try {
      next = await load();
    } catch (error) {
      this.environment.setError(failureMessage(error, failure));
      this.environment.setStatus(failure);
      return false;
    }
    // Another open started while this one was loading; the newer one wins.
    if (ticket !== this.opening) return false;
    // Edits typed while the file loaded still belong to the document being replaced.
    if (!(await this.flush())) return false;
    this.generation += 1;
    this.set(next);
    this.environment.setError('');
    this.environment.setStatus('已打开');
    return true;
  }

  openMarkdown(document: Pick<MapDocument, 'relativePath'>): Promise<boolean> {
    if (this.isOpen('doc', document.relativePath)) return Promise.resolve(true);
    return this.replaceWith('打开文档失败', async () => {
      const opened = await this.invoke<OpenedDocument>('open_document', {
        relativePath: document.relativePath,
      });
      return {
        kind: 'doc',
        session: ++this.sessions,
        id: opened.document.id,
        relativePath: opened.document.relativePath,
        title: opened.document.title,
        category: opened.document.category || '未分类',
        mapType: opened.document.mapType || DOCUMENT_MAP_TYPE,
        tags: opened.document.tags,
        source: opened.markdown,
        revision: 0,
        savedRevision: 0,
      };
    });
  }

  openDiagram(file: TextDocument): Promise<boolean> {
    if (this.isOpen('mermaid', file.relativePath)) return Promise.resolve(true);
    return this.replaceWith('打开图表失败', async () => {
      const opened = await this.invoke<OpenedTextDocument>(
        'open_text_document',
        { relativePath: file.relativePath },
      );
      return this.fromTextDocument(opened);
    });
  }

  /** Whether this file is already the open document, so opening it again changes nothing. */
  private isOpen(kind: WorkbenchKind, relativePath: string): boolean {
    return (
      this.state?.kind === kind && this.state.relativePath === relativePath
    );
  }

  private fromTextDocument(opened: OpenedTextDocument): ActiveDocument {
    return {
      kind: 'mermaid',
      session: ++this.sessions,
      id: opened.document.id,
      relativePath: opened.document.relativePath,
      title: opened.document.title,
      category: opened.document.category || '未分类',
      mapType: '',
      tags: [],
      source: opened.source,
      revision: 0,
      savedRevision: 0,
    };
  }

  /** Creates a file of `kind` in `category` from its template and opens it. */
  createDocument(kind: WorkbenchKind, category: string): Promise<boolean> {
    const template = NEW_FILE_TEMPLATES[kind];
    return this.createCustomDocument({
      kind,
      category,
      title: template.title,
      source: template.source,
    });
  }

  /** Creates a file with custom title, source, and optional tags in `category` and opens it. */
  createCustomDocument(options: {
    kind?: WorkbenchKind;
    category: string;
    title: string;
    source: string;
    tags?: string[];
  }): Promise<boolean> {
    const kind = options.kind ?? 'doc';
    const category = options.category.trim() || '未分类';
    const title = options.title.trim() || NEW_FILE_TEMPLATES[kind].title;
    const source = options.source;
    const tags = options.tags ?? [];

    return this.replaceWith('新建失败', async () => {
      if (kind === 'mermaid') {
        const created = await this.invoke<OpenedTextDocument>(
          'create_text_document',
          {
            kind: 'mermaid',
            category,
            title,
            source,
          },
        );
        this.upsertTextDocument(created.document);
        return this.fromTextDocument(created);
      }
      const input: SaveDocumentInput = {
        id: null,
        relativePath: null,
        title,
        category,
        mapType: DOCUMENT_MAP_TYPE,
        tags,
        markdown: source,
        historySource: 'manual',
        kind: 'doc',
      };
      const created = await this.invoke<MapDocument>('save_document', {
        input,
      });
      this.upsertDocument(created);
      return {
        kind: 'doc',
        session: ++this.sessions,
        id: created.id,
        relativePath: created.relativePath,
        title: created.title,
        category: created.category || '未分类',
        mapType: created.mapType || DOCUMENT_MAP_TYPE,
        tags: created.tags,
        source,
        revision: 0,
        savedRevision: 0,
      };
    });
  }

  /** Moves the open Markdown document to another category folder and saves immediately. */
  async setCategory(category: string): Promise<boolean> {
    const current = this.state;
    const next = category.trim() || '未分类';
    if (!current || current.kind !== 'doc' || next === current.category) {
      return true;
    }
    const previousCategory = current.category;
    this.set({ ...current, category: next, revision: current.revision + 1 });
    const saved = await this.save({ manual: true });
    if (!saved && this.state?.category === next) {
      this.set({ ...this.state, category: previousCategory });
    }
    return saved;
  }

  /** Updates the open Markdown document's tags and saves immediately. */
  async setTags(tags: string[]): Promise<boolean> {
    const current = this.state;
    if (!current || current.kind !== 'doc') return true;
    const normalized = [
      ...new Set(
        tags.map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean),
      ),
    ].slice(0, 20);
    if (
      normalized.length === current.tags.length &&
      normalized.every((tag, idx) => tag === current.tags[idx])
    ) {
      return true;
    }
    this.set({ ...current, tags: normalized, revision: current.revision + 1 });
    return this.save({ manual: true });
  }

  /**
   * Gives the open document a new title, which moves its file to the name the title makes. The
   * edits made so far are saved with it.
   */
  async rename(title: string): Promise<boolean> {
    const current = this.state;
    const next = title.trim();
    if (!current || !next || next === current.title) return true;

    if (current.kind === 'doc') {
      this.set({ ...current, title: next, revision: current.revision + 1 });
      const saved = await this.save({ manual: true });
      // A title that could not be saved (the name is taken) is dropped, the edits stay.
      if (!saved && this.state?.title === next)
        this.set({ ...this.state, title: current.title });
      return saved;
    }

    if (!(await this.save())) return false;
    const latest = this.state;
    if (!latest || latest.session !== current.session) return false;
    const generation = this.generation;
    this.environment.setStatus('正在重命名…');
    try {
      const document = await this.invoke<TextDocument>('save_text_document', {
        relativePath: latest.relativePath,
        source: latest.source,
        title: next,
      });
      this.afterSave(generation, latest, { ...document, title: next });
      this.upsertTextDocument(document, latest.relativePath);
      this.environment.setStatus('已重命名');
      this.environment.setError('');
      return true;
    } catch (error) {
      this.environment.setStatus(failureMessage(error, '重命名失败'));
      return false;
    }
  }

  /** Saves the open Markdown document as a mind map. Returns it, and closes the workbench. */
  async convertToMindmap(): Promise<MapDocument | null> {
    if (this.state?.kind !== 'doc') return null;
    // A running save finishes first, so the one below is the last write.
    if (this.saving) await this.saving.catch(() => false);
    const current = this.state;
    if (current?.kind !== 'doc') return null;
    const input: SaveDocumentInput = {
      id: current.id,
      relativePath: current.relativePath,
      title: current.title.trim(),
      category: current.category,
      mapType: current.mapType === DOCUMENT_MAP_TYPE ? '通用' : current.mapType,
      tags: current.tags,
      markdown: current.source,
      historySource: 'manual',
      kind: 'mindmap',
    };
    this.environment.setStatus('正在转为思维导图…');
    try {
      const saved = await this.invoke<MapDocument>('save_document', { input });
      this.upsertDocument(saved);
      this.close();
      return saved;
    } catch (error) {
      this.environment.setStatus(failureMessage(error, '转为思维导图失败'));
      return null;
    }
  }

  /** The folder the open document is in was renamed; follow it. */
  remapPaths(remap: (path: string | null) => string | null): void {
    const current = this.state;
    if (!current) return;
    const relativePath = remap(current.relativePath) ?? current.relativePath;
    const category = remap(current.category) ?? current.category;
    if (relativePath === current.relativePath && category === current.category)
      return;
    this.set({ ...current, relativePath, category });
  }

  /** Saves, then closes. False when it could not be saved and the user did not give it up. */
  async leave(): Promise<boolean> {
    if (!(await this.flush())) return false;
    this.close();
    return true;
  }

  /** Closes without saving, after a save that is already running has finished. */
  async discard(): Promise<void> {
    if (this.saving) await this.saving.catch(() => false);
    this.close();
  }

  close(): void {
    this.generation += 1;
    this.opening += 1;
    if (this.state) this.set(null);
  }
}
