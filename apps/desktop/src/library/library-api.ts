import { invoke } from '@tauri-apps/api/core';
import type { GeneratedHtmlAsset } from '../agent/types';
import type { ImportedDocumentMedia } from '../knowledge/document-media';
import type {
  DocumentTableAsset,
  ParsedExcelWorkbook,
} from '../mindmap/mindmap-excel';
import type {
  DocumentVersion,
  DocumentVersionSnapshot,
  EpubBookDocument,
  PdfBookDocument,
  OpenedPdfBook,
  KnowledgeHeatmapDayEntry,
  KnowledgeHeatmapSummary,
  LibrarySnapshot,
  MapDocument,
  OpenedDocument,
  OpenedTextDocument,
  PlantUmlDocument,
  SaveDocumentInput,
  TextDocument,
} from './library';

export interface ImportedHtmlAsset {
  assetId: string;
  entryPath: string;
  title: string;
}

/** The desktop library commands. UI components never build Tauri command names. */
export const libraryApi = {
  status: () => invoke<LibrarySnapshot>('library_status'),
  setRoot: (args: { path: string }) =>
    invoke<LibrarySnapshot>('set_library_root', args),
  search: (args: { query: string; category: string | null; kind?: string }) =>
    invoke<MapDocument[]>('search_library', args),
  openDocument: (args: { relativePath: string }) =>
    invoke<OpenedDocument>('open_document', args),
  saveDocument: (args: { input: SaveDocumentInput }) =>
    invoke<MapDocument>('save_document', args),
  deleteDocument: (args: { relativePath: string }) =>
    invoke<void>('delete_document', args),
  createCategory: (args: { category: string; kind: 'doc' | 'mindmap' }) =>
    invoke<LibrarySnapshot>('create_category', args),
  renameFolder: (args: { relativePath: string; newName: string }) =>
    invoke<LibrarySnapshot>('rename_library_folder', args),
  listVersions: (args: { documentId: string }) =>
    invoke<DocumentVersion[]>('list_document_versions', args),
  loadVersion: (args: { documentId: string; versionId: string }) =>
    invoke<DocumentVersionSnapshot>('load_document_version', args),
  restoreVersion: (args: {
    documentId: string;
    relativePath: string;
    versionId: string;
  }) => invoke<OpenedDocument>('restore_document_version', args),
  openEpubBook: (args: { relativePath: string }) =>
    invoke<string>('open_epub_book', args),
  importEpubBook: (args: { sourcePath: string }) =>
    invoke<EpubBookDocument>('import_epub_book', args),
  deleteEpubBook: (args: { relativePath: string }) =>
    invoke<void>('delete_epub_book', args),
  openPdfBook: (args: { relativePath: string }) =>
    invoke<OpenedPdfBook>('open_pdf_book', args),
  importPdfBook: (args: { sourcePath: string }) =>
    invoke<PdfBookDocument>('import_pdf_book', args),
  deletePdfBook: (args: { relativePath: string }) =>
    invoke<void>('delete_pdf_book', args),
  openPlantUml: (args: { relativePath: string }) =>
    invoke<string>('open_plantuml_document', args),
  savePlantUml: (args: { relativePath: string; source: string }) =>
    invoke<PlantUmlDocument>('save_plantuml_document', args),
  createPlantUml: (args: { category: string; title: string; source: string }) =>
    invoke<PlantUmlDocument>('create_plantuml_document', args),
  deletePlantUml: (args: { relativePath: string }) =>
    invoke<void>('delete_plantuml_document', args),
  deleteTextDocument: (args: { relativePath: string }) =>
    invoke<void>('delete_text_document', args),
  importHtmlAsset: (args: {
    documentRelativePath: string;
    sourcePath: string;
  }) => invoke<ImportedHtmlAsset>('import_html_asset', args),
  saveGeneratedHtmlAssets: (args: {
    documentRelativePath: string;
    assets: GeneratedHtmlAsset[];
  }) => invoke<ImportedHtmlAsset[]>('save_generated_html_assets', args),
  discardGeneratedHtmlAssets: (args: {
    documentRelativePath: string;
    assetIds: string[];
  }) => invoke<void>('discard_generated_html_assets', args),
  resolveHtmlAsset: (args: {
    documentRelativePath: string;
    assetId: string;
    entryPath: string;
  }) => invoke<string>('resolve_html_asset', args),
  importDocumentMedia: (args: {
    documentRelativePath: string;
    input: { remoteUrl?: string; bytesBase64?: string; localPath?: string };
  }) => invoke<ImportedDocumentMedia>('import_document_media', args),
  resolveDocumentMedia: (args: {
    documentRelativePath: string;
    mediaId: string;
  }) => invoke<string>('resolve_document_media', args),
  readDocumentMediaDataUrl: (args: {
    documentRelativePath: string;
    mediaId: string;
  }) => invoke<string>('read_document_media_data_url', args),
  writeExportedMindmapHtml: (args: { filePath: string; html: string }) =>
    invoke<number>('write_exported_mindmap_html', args),
  openExportedHtmlInBrowser: (args: { filePath: string }) =>
    invoke<void>('open_exported_html_in_browser', args),
  parseExcelWorkbook: (args: { filePath: string }) =>
    invoke<ParsedExcelWorkbook>('parse_excel_workbook', args),
  saveMindmapTableAsset: (args: {
    documentRelativePath: string;
    tableJson: string;
  }) => invoke<DocumentTableAsset>('save_mindmap_table_asset', args),
  readMindmapTableAsset: (args: {
    documentRelativePath: string;
    assetId: string;
  }) => invoke<string>('read_mindmap_table_asset', args),
  openTextDocument: (args: { relativePath: string }) =>
    invoke<OpenedTextDocument>('open_text_document', args),
  saveTextDocument: (args: {
    relativePath: string;
    source: string;
    title?: string;
  }) => invoke<TextDocument>('save_text_document', args),
  createTextDocument: (args: {
    kind: string;
    category: string;
    title: string;
    source: string;
  }) => invoke<OpenedTextDocument>('create_text_document', args),
  writingHeatmap: (args: {
    fromDate?: string;
    toDate?: string;
    kindFilter?: string;
    originFilter?: string;
  }) => invoke<KnowledgeHeatmapSummary>('knowledge_writing_heatmap', args),
  writingDayDetail: (args: {
    date: string;
    kindFilter?: string;
    originFilter?: string;
  }) =>
    invoke<KnowledgeHeatmapDayEntry[]>('knowledge_writing_day_detail', args),
};

/** Document session port. The workbench names the command; this object owns the transport. */
export async function invokeLibraryCommand<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  switch (command) {
    case 'open_document':
      return libraryApi.openDocument(
        args as { relativePath: string },
      ) as Promise<T>;
    case 'save_document':
      return libraryApi.saveDocument(
        args as { input: SaveDocumentInput },
      ) as Promise<T>;
    case 'open_text_document':
      return libraryApi.openTextDocument(
        args as { relativePath: string },
      ) as Promise<T>;
    case 'save_text_document':
      return libraryApi.saveTextDocument(
        args as { relativePath: string; source: string; title?: string },
      ) as Promise<T>;
    case 'create_text_document':
      return libraryApi.createTextDocument(
        args as {
          kind: string;
          category: string;
          title: string;
          source: string;
        },
      ) as Promise<T>;
    default:
      throw new Error(`未注册的文件库命令：${command}`);
  }
}
