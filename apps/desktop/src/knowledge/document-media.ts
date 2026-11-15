import { convertFileSrc } from '@tauri-apps/api/core';
import { libraryApi } from '../library/library-api';
import type { PasteMediaCandidate } from './knowledge-paste';

export interface ImportedDocumentMedia {
  mediaId: string;
  mimeType: string;
  byteLength: number;
  reused: boolean;
}

async function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取剪贴板图片。'));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) reject(new Error('剪贴板图片数据无效。'));
      else resolve(dataUrl.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function importDocumentMedia(
  documentRelativePath: string,
  candidate: PasteMediaCandidate,
): Promise<ImportedDocumentMedia> {
  const input =
    candidate.kind === 'remote'
      ? { remoteUrl: candidate.value as string }
      : candidate.kind === 'data'
        ? { bytesBase64: String(candidate.value).split(',', 2)[1] ?? '' }
        : { bytesBase64: await fileBase64(candidate.value as File) };
  return libraryApi.importDocumentMedia({ documentRelativePath, input });
}

export async function resolveDocumentMedia(
  documentRelativePath: string,
  mediaId: string,
): Promise<string> {
  const path = await libraryApi.resolveDocumentMedia({
    documentRelativePath,
    mediaId,
  });
  return convertFileSrc(path);
}
