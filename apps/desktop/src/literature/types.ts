export interface PaperItem {
  id: string;
  citeKey: string;
  entryType: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  volume: string | null;
  number: string | null;
  pages: string | null;
  publisher: string | null;
  doi: string | null;
  url: string | null;
  arxivId: string | null;
  abstractText: string | null;
  keywords: string[];
  pdfPath: string | null;
  pdfSha256: string | null;
  readStatus: 'unread' | 'reading' | 'completed';
  rating: number;
  notes: string | null;
  bibtex: string | null;
  collectionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PaperInput {
  id?: string;
  citeKey?: string;
  entryType?: string;
  title: string;
  authors: string[];
  year?: number | null;
  venue?: string | null;
  volume?: string | null;
  number?: string | null;
  pages?: string | null;
  publisher?: string | null;
  doi?: string | null;
  url?: string | null;
  arxivId?: string | null;
  abstractText?: string | null;
  keywords?: string[];
  pdfPath?: string | null;
  readStatus?: 'unread' | 'reading' | 'completed';
  rating?: number;
  notes?: string | null;
  bibtex?: string | null;
  collectionIds?: string[];
}

export interface LiteratureSearchResult {
  paper: PaperInput;
  source: 'Crossref' | 'arXiv';
  pdfUrl: string | null;
  existingPaperId: string | null;
}

export interface PaperAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaperAnnotation {
  id: string;
  paperId: string;
  pageNumber: number;
  selectedText: string;
  comment: string | null;
  color: string | null;
  rects: PaperAnnotationRect[];
  contextBefore: string | null;
  contextAfter: string | null;
  pdfSha256: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PaperAnnotationInput {
  id?: string;
  paperId: string;
  pageNumber: number;
  selectedText: string;
  comment?: string | null;
  color?: string | null;
  rects: PaperAnnotationRect[];
  contextBefore?: string | null;
  contextAfter?: string | null;
}

export interface PaperReadingProgress {
  paperId: string;
  pageNumber: number;
  scale: number;
  updatedAt: number;
}

export interface OpenedPaperPdf {
  path: string;
  sha256: string;
}

export interface PaperCollection {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  paperCount: number;
  createdAt: number;
}

export interface CollectionInput {
  id?: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface LiteratureOverview {
  totalPapers: number;
  unreadCount: number;
  readingCount: number;
  completedCount: number;
  starredCount: number;
  collections: PaperCollection[];
  allTags: TagCount[];
}

export interface PaperFilter {
  query?: string;
  collectionId?: string;
  tag?: string;
  readStatus?: 'all' | 'unread' | 'reading' | 'completed' | 'starred';
  sortBy?: 'updatedAt' | 'year' | 'title' | 'rating' | 'citeKey';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ParsedBibEntry {
  citeKey: string;
  entryType: string;
  title: string;
  authors: string[];
  year?: number | null;
  venue?: string | null;
  volume?: string | null;
  number?: string | null;
  pages?: string | null;
  publisher?: string | null;
  doi?: string | null;
  url?: string | null;
  eprint?: string | null;
  abstractText?: string | null;
  keywords: string[];
  rawFields: Record<string, string>;
}
