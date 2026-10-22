export interface MapDocument {
  id: string;
  relativePath: string;
  title: string;
  category: string;
  mapType: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface EpubBookDocument {
  relativePath: string;
  title: string;
  category: string;
  fileSize: number;
  updatedAt: number;
}

export interface PlantUmlDocument {
  relativePath: string;
  title: string;
  category: string;
  fileSize: number;
  updatedAt: number;
}

export interface LibrarySnapshot {
  rootPath: string | null;
  documents: MapDocument[];
  books: EpubBookDocument[];
  plantumlFiles: PlantUmlDocument[];
  categories: string[];
}

export interface OpenedDocument {
  document: MapDocument;
  markdown: string;
}

export interface SaveDocumentInput {
  id: string | null;
  relativePath: string | null;
  title: string;
  category: string;
  mapType: string;
  tags: string[];
  markdown: string;
  historySource?: 'autosave' | 'manual' | 'restore';
}

export type DocumentVersionSource =
  | 'baseline'
  | 'autosave'
  | 'manual'
  | 'restore';

export interface DocumentVersion {
  versionId: string;
  documentId: string;
  relativePath: string;
  title: string;
  category: string;
  mapType: string;
  tags: string[];
  source: DocumentVersionSource;
  createdAt: number;
  markdownBytes: number;
}

export interface DocumentVersionSnapshot extends DocumentVersion {
  markdown: string;
}
