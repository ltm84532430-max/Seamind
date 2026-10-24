/** The fields the knowledge page reads from a library document. */
export interface KnowledgeNoteSource {
  kind: string;
  relativePath: string;
  title: string;
  category: string;
  updatedAt: number;
}

export interface KnowledgeFolder<T extends KnowledgeNoteSource> {
  name: string;
  notes: T[];
}

/** The folder for notes that have no category, as the workbench names it. */
export const UNFILED_FOLDER = '未分类';

/**
 * Groups the Markdown notes by folder, keeping only the ones whose title, path or folder contains
 * `query` (case-insensitive). Mind maps are left out. Folders sort by name and each folder's notes
 * sort newest first.
 */
export function groupKnowledgeNotes<T extends KnowledgeNoteSource>(
  documents: readonly T[],
  query: string,
): KnowledgeFolder<T>[] {
  const needle = query.trim().toLocaleLowerCase();
  const folders = new Map<string, T[]>();
  for (const document of documents) {
    if (document.kind !== 'doc') continue;
    const name = document.category || UNFILED_FOLDER;
    if (needle) {
      const searchable = [document.title, document.relativePath, name];
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
