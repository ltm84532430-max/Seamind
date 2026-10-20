import type { MapDocument } from './library';

export interface LibraryFolderNode {
  path: string;
  name: string;
  children: LibraryFolderNode[];
  documents: MapDocument[];
  documentCount: number;
}

interface MutableLibraryFolderNode {
  path: string;
  name: string;
  children: Map<string, MutableLibraryFolderNode>;
  documents: MapDocument[];
}

function normalizeFolderPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
}

export function buildLibraryFolderTree(
  categories: string[],
  documents: MapDocument[],
): LibraryFolderNode[] {
  const roots = new Map<string, MutableLibraryFolderNode>();

  const ensureFolder = (value: string): MutableLibraryFolderNode | null => {
    const segments = normalizeFolderPath(value).split('/').filter(Boolean);
    if (segments.length === 0) return null;

    let children = roots;
    let parentPath = '';
    let node: MutableLibraryFolderNode | undefined;

    for (const name of segments) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      node = children.get(name);
      if (!node) {
        node = { path, name, children: new Map(), documents: [] };
        children.set(name, node);
      }
      parentPath = path;
      children = node.children;
    }

    return node ?? null;
  };

  for (const category of categories) ensureFolder(category);

  for (const document of documents) {
    const category = normalizeFolderPath(document.category || '未分类');
    const folder = ensureFolder(category);
    folder?.documents.push(document);
  }

  const compareFolders = (left: LibraryFolderNode, right: LibraryFolderNode) =>
    left.name.localeCompare(right.name, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    });

  const finalize = (node: MutableLibraryFolderNode): LibraryFolderNode => {
    const children = [...node.children.values()]
      .map(finalize)
      .sort(compareFolders);
    const folderDocuments = [...node.documents];

    return {
      path: node.path,
      name: node.name,
      children,
      documents: folderDocuments,
      documentCount:
        folderDocuments.length +
        children.reduce((total, child) => total + child.documentCount, 0),
    };
  };

  return [...roots.values()].map(finalize).sort(compareFolders);
}
