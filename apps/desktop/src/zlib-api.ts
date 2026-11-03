import { invoke } from '@tauri-apps/api/core';
import type { EpubBookDocument } from './library';

export interface ZlibBook {
  id: string;
  hash: string;
  title: string;
  author?: string | null;
  publisher?: string | null;
  year?: string | null;
  language?: string | null;
  extension?: string | null;
  filesize?: string | null;
  cover?: string | null;
  rating?: string | null;
  pages?: string | null;
}

export interface ZlibEnvironment {
  installed: boolean;
  path?: string | null;
  version?: string | null;
  hasLogin: boolean;
  activeDomain?: string | null;
}

export interface ZlibProfile {
  email?: string | null;
  downloadsToday?: number | null;
  downloadsLimit?: number | null;
  isLoggedIn: boolean;
}

export interface ZlibSearchResult {
  books: ZlibBook[];
  total: number;
  query: string;
  source: string; // "cli" or "eapi"
}

export const zlibApi = {
  checkEnvironment(customPath?: string): Promise<ZlibEnvironment> {
    return invoke<ZlibEnvironment>('zlib_check_environment', {
      customPath: customPath || null,
    });
  },

  getProfile(customPath?: string): Promise<ZlibProfile> {
    return invoke<ZlibProfile>('zlib_get_profile', {
      customPath: customPath || null,
    });
  },

  search(
    query: string,
    ext = 'epub',
    count = 20,
    customPath?: string,
  ): Promise<ZlibSearchResult> {
    return invoke<ZlibSearchResult>('zlib_search', {
      query,
      ext: ext || 'epub',
      count,
      customPath: customPath || null,
    });
  },

  downloadBook(
    idHash: string,
    title?: string,
    customPath?: string,
  ): Promise<EpubBookDocument> {
    return invoke<EpubBookDocument>('zlib_download_book', {
      idHash,
      title: title || null,
      customPath: customPath || null,
    });
  },
};
