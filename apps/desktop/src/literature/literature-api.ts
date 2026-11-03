import { invoke } from '@tauri-apps/api/core';
import type {
  CollectionInput,
  LiteratureOverview,
  PaperCollection,
  PaperFilter,
  PaperInput,
  PaperItem,
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

  parseBibtexText: (content: string) =>
    invoke<ParsedBibEntry[]>('literature_parse_bibtex_text', { content }),

  importBibtexText: (content: string, collectionId?: string) =>
    invoke<number>('literature_import_bibtex_text', { content, collectionId }),

  exportBibtexText: (ids?: string[]) =>
    invoke<string>('literature_export_bibtex_text', { ids }),

  generateMindmap: (id: string) =>
    invoke<string>('literature_generate_mindmap', { id }),
};
