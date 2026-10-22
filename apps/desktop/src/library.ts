export interface MapDocument {
  id: string;
  relativePath: string;
  title: string;
  category: string;
  mapType: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** "mindmap" opens on the mind map canvas, "doc" as a Markdown document. */
  kind: DocumentKind;
}

export type DocumentKind = 'mindmap' | 'doc';

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

/** A plain-text document that is not Markdown (today: Mermaid/Pele diagrams, `.mmd`). */
export interface TextDocument {
  id: string;
  relativePath: string;
  title: string;
  category: string;
  kind: TextDocumentKind;
  fileSize: number;
  updatedAt: number;
}

export type TextDocumentKind = 'mermaid';

export interface OpenedTextDocument {
  document: TextDocument;
  source: string;
}

export interface LibrarySnapshot {
  rootPath: string | null;
  documents: MapDocument[];
  books: EpubBookDocument[];
  plantumlFiles: PlantUmlDocument[];
  textDocuments: TextDocument[];
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
  /** Left out, an existing file keeps its kind and a new one is a mind map. */
  kind?: DocumentKind;
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
