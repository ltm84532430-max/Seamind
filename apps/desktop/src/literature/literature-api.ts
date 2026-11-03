import { invoke } from '@tauri-apps/api/core';
import type {
  CollectionInput,
  LiteratureOverview,
  LiteratureSearchResult,
  OpenedPaperPdf,
  PaperAnnotation,
  PaperAnnotationInput,
  PaperCollection,
  PaperFilter,
  PaperInput,
  PaperItem,
  PaperReadingProgress,
  ParsedBibEntry,
} from './types';

export const literatureApi = {
  overview: () => invoke<LiteratureOverview>('literature_overview'),

  list: (filter: PaperFilter = {}) =>
    invoke<PaperItem[]>('literature_list', { filter }),

  get: (id: string) => invoke<PaperItem | null>('literature_get', { id }),

  save: (paper: PaperInput) => invoke<PaperItem>('literature_save', { paper }),

  delete: (id: string) => invoke<void>('literature_delete', { id }),

  batchDelete: (ids: string[]) =>
    invoke<void>('literature_batch_delete', { ids }),

  updateReadStatus: (id: string, status: string) =>
    invoke<void>('literature_update_read_status', { id, status }),

  updateRating: (id: string, rating: number) =>
    invoke<void>('literature_update_rating', { id, rating }),

  updateNotes: (id: string, notes: string) =>
    invoke<void>('literature_update_notes', { id, notes }),

  attachPdf: (id: string) =>
    invoke<PaperItem | null>('literature_attach_pdf', { id }),

  openPdf: (id: string) =>
    invoke<OpenedPaperPdf>('literature_open_pdf', { id }),

  listAnnotations: (paperId: string) =>
    invoke<PaperAnnotation[]>('literature_list_annotations', { paperId }),

  saveAnnotation: (annotation: PaperAnnotationInput) =>
    invoke<PaperAnnotation>('literature_save_annotation', { annotation }),

  deleteAnnotation: (paperId: string, annotationId: string) =>
    invoke<void>('literature_delete_annotation', { paperId, annotationId }),

  getReadingProgress: (paperId: string) =>
    invoke<PaperReadingProgress | null>('literature_get_reading_progress', {
      paperId,
    }),

  saveReadingProgress: (paperId: string, pageNumber: number, scale: number) =>
    invoke<PaperReadingProgress>('literature_save_reading_progress', {
      paperId,
      pageNumber,
      scale,
    }),

  listCollections: () =>
    invoke<PaperCollection[]>('literature_list_collections'),

  saveCollection: (collection: CollectionInput) =>
    invoke<PaperCollection>('literature_save_collection', { collection }),

  deleteCollection: (id: string) =>
    invoke<void>('literature_delete_collection', { id }),

  fetchDoi: (doi: string) =>
    invoke<PaperInput>('literature_fetch_doi', { doi }),

  fetchArxiv: (arxivId: string) =>
    invoke<PaperInput>('literature_fetch_arxiv', { arxivId }),

  searchOnline: (query: string, source: 'crossref' | 'arxiv') =>
    invoke<LiteratureSearchResult[]>('literature_search', { query, source }),

  downloadArxivPdf: (id: string) =>
    invoke<PaperItem>('literature_download_arxiv_pdf', { id }),

  parseBibtexText: (content: string) =>
    invoke<ParsedBibEntry[]>('literature_parse_bibtex_text', { content }),

  importBibtexText: (content: string, collectionId?: string) =>
    invoke<number>('literature_import_bibtex_text', { content, collectionId }),

  exportBibtexText: (ids?: string[]) =>
    invoke<string>('literature_export_bibtex_text', { ids }),

  generateMindmap: (id: string) =>
    invoke<string>('literature_generate_mindmap', { id }),
};
