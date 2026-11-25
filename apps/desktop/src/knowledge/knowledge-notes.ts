/** The fields the knowledge page reads from a library document. */
export interface KnowledgeNoteSource {
  kind: string;
  relativePath: string;
  title: string;
  category: string;
  updatedAt: number;
  tags?: readonly string[];
}

export interface KnowledgeFolder<T extends KnowledgeNoteSource> {
  name: string;
  notes: T[];
}

/** The folder for notes that have no category, as the workbench names it. */
export const UNFILED_FOLDER = '未分类';

export function normalizeKnowledgeFolderPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
}

/** Filters out internal asset bundle directories (e.g. assets/<uuid>) from user categories. */
export function isInternalAssetCategory(category: string): boolean {
  const normalized = normalizeKnowledgeFolderPath(category).toLowerCase();
  return normalized === 'assets' || normalized.startsWith('assets/');
}

/**
 * Resolves the target category path when creating a new folder.
 * When a real folder is selected (not null and not '未分类'), creates a subfolder inside it;
 * when selection is blank (null) or '未分类', creates a top-level folder.
 */
export function resolveNewKnowledgeCategoryPath(
  inputName: string,
  selectedFolder: string | null,
): string {
  const cleanInput = normalizeKnowledgeFolderPath(inputName);
  if (!cleanInput) return '';
  const cleanParent = selectedFolder
    ? normalizeKnowledgeFolderPath(selectedFolder)
    : '';
  if (!cleanParent || cleanParent === UNFILED_FOLDER) {
    return cleanInput;
  }
  if (cleanInput === cleanParent || cleanInput.startsWith(`${cleanParent}/`)) {
    return cleanInput;
  }
  return `${cleanParent}/${cleanInput}`;
}

export interface KnowledgeFolderTreeNode<T extends KnowledgeNoteSource> {
  path: string;
  name: string;
  depth: number;
  children: KnowledgeFolderTreeNode<T>[];
  notes: T[];
  totalNotesCount: number;
}

interface MutableKnowledgeFolderTreeNode<T extends KnowledgeNoteSource> {
  path: string;
  name: string;
  depth: number;
  children: Map<string, MutableKnowledgeFolderTreeNode<T>>;
  notes: T[];
}

/**
 * Builds a multi-level folder tree from flat category groups so parent folders and nested
 * subfolders render hierarchically in the knowledge sidebar.
 */
export function buildKnowledgeFolderTree<T extends KnowledgeNoteSource>(
  folders: readonly KnowledgeFolder<T>[],
): KnowledgeFolderTreeNode<T>[] {
  const roots = new Map<string, MutableKnowledgeFolderTreeNode<T>>();

  const ensureNode = (
    rawPath: string,
  ): MutableKnowledgeFolderTreeNode<T> | null => {
    const normalized = normalizeKnowledgeFolderPath(rawPath);
    if (!normalized || isInternalAssetCategory(normalized)) return null;
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) return null;

    let currentMap = roots;
    let parentPath = '';
    let node: MutableKnowledgeFolderTreeNode<T> | undefined;

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const currentPath = parentPath ? `${parentPath}/${seg}` : seg;
      node = currentMap.get(seg);
      if (!node) {
        node = {
          path: currentPath,
          name: seg,
          depth: i,
          children: new Map(),
          notes: [],
        };
        currentMap.set(seg, node);
      }
      parentPath = currentPath;
      currentMap = node.children;
    }

    return node ?? null;
  };

  for (const folder of folders) {
    if (isInternalAssetCategory(folder.name)) continue;
    const target = ensureNode(folder.name);
    if (target) {
      target.notes.push(...folder.notes);
    }
  }

  const compareNodes = (
    left: KnowledgeFolderTreeNode<T>,
    right: KnowledgeFolderTreeNode<T>,
  ) =>
    left.name.localeCompare(right.name, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    });

  const finalize = (
    node: MutableKnowledgeFolderTreeNode<T>,
  ): KnowledgeFolderTreeNode<T> => {
    const children = [...node.children.values()]
      .map(finalize)
      .sort(compareNodes);
    const notes = [...node.notes].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    const totalNotesCount =
      notes.length +
      children.reduce((sum, child) => sum + child.totalNotesCount, 0);
    return {
      path: node.path,
      name: node.name,
      depth: node.depth,
      children,
      notes,
      totalNotesCount,
    };
  };

  return [...roots.values()].map(finalize).sort(compareNodes);
}

/**
 * Groups the Markdown notes by folder, keeping only the ones whose title, path, folder or tags
 * contain `query` (case-insensitive). Mind maps are left out. Folders sort by name and each
 * folder's notes sort newest first. When `query` is blank, `extraCategories` are also included as
 * empty folders so newly created categories appear immediately.
 */
export function groupKnowledgeNotes<T extends KnowledgeNoteSource>(
  documents: readonly T[],
  query: string,
  extraCategories: readonly string[] = [],
): KnowledgeFolder<T>[] {
  const needle = query.trim().replace(/^#/, '').toLocaleLowerCase();
  const folders = new Map<string, T[]>();

  if (!needle) {
    for (const rawCategory of extraCategories) {
      const clean = normalizeKnowledgeFolderPath(rawCategory);
      if (clean && !isInternalAssetCategory(clean) && !folders.has(clean)) {
        folders.set(clean, []);
      }
    }
  }

  for (const document of documents) {
    if (document.kind !== 'doc') continue;
    const rawCat = normalizeKnowledgeFolderPath(document.category || '');
    if (isInternalAssetCategory(rawCat)) continue;
    const name = rawCat || UNFILED_FOLDER;
    if (needle) {
      const searchable = [
        document.title,
        document.relativePath,
        name,
        ...(document.tags ?? []),
      ];
      if (!searchable.some((text) => text.toLocaleLowerCase().includes(needle)))
        continue;
    }
    const notes = folders.get(name) ?? [];
    notes.push(document);
    folders.set(name, notes);
  }

  return [...folders.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([name, notes]) => ({
      name,
      notes: notes.sort((left, right) => right.updatedAt - left.updatedAt),
    }));
}
