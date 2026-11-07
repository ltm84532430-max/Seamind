import type {
  EpubBookDocument,
  MapDocument,
  PlantUmlDocument,
  TextDocument,
} from './library';

export interface LibraryFolderNode {
  path: string;
  name: string;
  children: LibraryFolderNode[];
  documents: MapDocument[];
  books: EpubBookDocument[];
  plantumlFiles: PlantUmlDocument[];
  textDocuments: TextDocument[];
  documentCount: number;
}

interface MutableLibraryFolderNode {
  path: string;
  name: string;
  children: Map<string, MutableLibraryFolderNode>;
  documents: MapDocument[];
  books: EpubBookDocument[];
  plantumlFiles: PlantUmlDocument[];
  textDocuments: TextDocument[];
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
  books: EpubBookDocument[] = [],
  plantumlFiles: PlantUmlDocument[] = [],
  textDocuments: TextDocument[] = [],
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
        node = {
          path,
          name,
          children: new Map(),
          documents: [],
          books: [],
          plantumlFiles: [],
          textDocuments: [],
        };
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

  for (const book of books) {
    const category = normalizeFolderPath(book.category || '未分类');
    const folder = ensureFolder(category);
    folder?.books.push(book);
  }

  for (const diagram of plantumlFiles) {
    const category = normalizeFolderPath(diagram.category || '未分类');
    const folder = ensureFolder(category);
    folder?.plantumlFiles.push(diagram);
  }

  for (const diagram of textDocuments) {
    const category = normalizeFolderPath(diagram.category || '未分类');
    const folder = ensureFolder(category);
    folder?.textDocuments.push(diagram);
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
    const folderBooks = [...node.books];
    const folderPlantUmlFiles = [...node.plantumlFiles];
    const folderTextDocuments = [...node.textDocuments];

    return {
      path: node.path,
      name: node.name,
      children,
      documents: folderDocuments,
      books: folderBooks,
      plantumlFiles: folderPlantUmlFiles,
      textDocuments: folderTextDocuments,
      documentCount:
        folderDocuments.length +
        folderBooks.length +
        folderPlantUmlFiles.length +
        folderTextDocuments.length +
        children.reduce((total, child) => total + child.documentCount, 0),
    };
  };

  return [...roots.values()].map(finalize).sort(compareFolders);
}
