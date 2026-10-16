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

export interface LibrarySnapshot {
  rootPath: string | null;
  documents: MapDocument[];
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
}
