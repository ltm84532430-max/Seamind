import { invoke } from '@tauri-apps/api/core';
import type { EpubBookDocument } from '../library/library';

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
  name?: string | null;
  downloadsToday?: number | null;
  downloadsLimit?: number | null;
  dailyRemaining?: number | null;
  dailyAllowed?: number | null;
  activeDomain?: string | null;
  isLoggedIn: boolean;
}

export interface ZlibDoctorResult {
  healthyDomains: string[];
  activeDomain?: string | null;
}

export interface ZlibSwitchDomainResult {
  activeDomain: string;
  healthyDomains: string[];
  profile?: ZlibProfile | null;
  warning?: string | null;
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

  doctor(customPath?: string): Promise<ZlibDoctorResult> {
    return invoke<ZlibDoctorResult>('zlib_doctor', {
      customPath: customPath || null,
    });
  },

  switchDomain(
    domain?: string,
    customPath?: string,
  ): Promise<ZlibSwitchDomainResult> {
    return invoke<ZlibSwitchDomainResult>('zlib_switch_domain', {
      domain: domain || null,
      customPath: customPath || null,
    });
  },

  login(
    email: string,
    password: string,
    customPath?: string,
  ): Promise<ZlibProfile> {
    return invoke<ZlibProfile>('zlib_login', {
      email,
      password,
      customPath: customPath || null,
    });
  },

  logout(): Promise<void> {
    return invoke<void>('zlib_logout');
  },

  search(
    query: string,
    ext = 'epub',
    count = 20,
    customPath?: string,
  ): Promise<ZlibSearchResult> {
    const normalizedExt = ext.trim();
    return invoke<ZlibSearchResult>('zlib_search', {
      query,
      ext: normalizedExt ? normalizedExt : null,
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
