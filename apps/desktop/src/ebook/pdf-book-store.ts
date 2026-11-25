import type {
  PaperAnnotation,
  PaperAnnotationInput,
  PaperReadingProgress,
} from '../literature/types';
import { bookmarkKey, preferenceKey } from '../literature/paper-reader-keys.ts';

interface PdfBookRecord {
  sha256: string;
  annotations: PaperAnnotation[];
  progress: PdfBookProgress | null;
}

export interface PdfBookProgress extends PaperReadingProgress {
  offsetRatio: number;
}

const keyFor = (rootPath: string, relativePath: string) =>
  `seamind_pdf_book_v1:${encodeURIComponent(rootPath)}:${encodeURIComponent(relativePath)}`;

function readRecord(
  rootPath: string,
  relativePath: string,
  sha256: string,
): PdfBookRecord {
  try {
    const raw = localStorage.getItem(keyFor(rootPath, relativePath));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PdfBookRecord>;
      if (parsed.sha256 === sha256) {
        return {
          sha256,
          annotations: Array.isArray(parsed.annotations)
            ? parsed.annotations.filter(
                (item): item is PaperAnnotation =>
                  Boolean(item) &&
                  typeof item.id === 'string' &&
                  typeof item.pageNumber === 'number' &&
                  Array.isArray(item.rects),
              )
            : [],
          progress:
            parsed.progress &&
            Number.isFinite(parsed.progress.pageNumber) &&
            Number.isFinite(parsed.progress.scale)
              ? {
                  ...parsed.progress,
                  offsetRatio: Number.isFinite(parsed.progress.offsetRatio)
                    ? Math.max(0, Math.min(1, parsed.progress.offsetRatio!))
                    : 0,
                }
              : null,
        };
      }
    }
  } catch {
    // A corrupt or unavailable cache must not prevent opening the PDF.
  }
  return { sha256, annotations: [], progress: null };
}

function writeRecord(
  rootPath: string,
  relativePath: string,
  record: PdfBookRecord,
) {
  localStorage.setItem(keyFor(rootPath, relativePath), JSON.stringify(record));
}

export function listPdfBookAnnotations(
  rootPath: string,
  relativePath: string,
  sha256: string,
): PaperAnnotation[] {
  return readRecord(rootPath, relativePath, sha256).annotations;
}

export function getPdfBookProgress(
  rootPath: string,
  relativePath: string,
  sha256: string,
): PdfBookProgress | null {
  return readRecord(rootPath, relativePath, sha256).progress;
}

export function getPdfBookSummary(rootPath: string, relativePath: string) {
  try {
    const raw = localStorage.getItem(keyFor(rootPath, relativePath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PdfBookRecord>;
    const progress = parsed.progress;
    if (
      progress &&
      Number.isFinite(progress.pageNumber) &&
      Number.isFinite(progress.updatedAt)
    ) {
      return progress;
    }
  } catch {
    // A missing or corrupt summary simply falls back to the import date.
  }
  return null;
}

export function savePdfBookProgress(
  rootPath: string,
  relativePath: string,
  sha256: string,
  pageNumber: number,
  scale: number,
  offsetRatio?: number,
): PdfBookProgress {
  const record = readRecord(rootPath, relativePath, sha256);
  const progress = {
    paperId: relativePath,
    pageNumber,
    scale,
    offsetRatio:
      offsetRatio === undefined
        ? record.progress?.pageNumber === pageNumber
          ? record.progress.offsetRatio
          : 0
        : Math.max(0, Math.min(1, offsetRatio)),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  writeRecord(rootPath, relativePath, { ...record, progress });
  return progress;
}

export function savePdfBookAnnotation(
  rootPath: string,
  relativePath: string,
  sha256: string,
  input: PaperAnnotationInput,
): PaperAnnotation {
  const record = readRecord(rootPath, relativePath, sha256);
  const existing = input.id
    ? record.annotations.find((annotation) => annotation.id === input.id)
    : undefined;
  const now = Math.floor(Date.now() / 1000);
  const annotation: PaperAnnotation = {
    id: input.id || crypto.randomUUID(),
    paperId: relativePath,
    pageNumber: input.pageNumber,
    selectedText: input.selectedText,
    comment: input.comment ?? null,
    color: input.color ?? null,
    rects: input.rects,
    contextBefore: input.contextBefore ?? null,
    contextAfter: input.contextAfter ?? null,
    pdfSha256: sha256,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeRecord(rootPath, relativePath, {
    ...record,
    annotations: existing
      ? record.annotations.map((item) =>
          item.id === annotation.id ? annotation : item,
        )
      : [...record.annotations, annotation],
  });
  return annotation;
}

export function deletePdfBookAnnotation(
  rootPath: string,
  relativePath: string,
  sha256: string,
  annotationId: string,
) {
  const record = readRecord(rootPath, relativePath, sha256);
  writeRecord(rootPath, relativePath, {
    ...record,
    annotations: record.annotations.filter((item) => item.id !== annotationId),
  });
}

export function clearPdfBookData(rootPath: string, relativePath: string) {
  try {
    const key = keyFor(rootPath, relativePath);
    const readerId = `book:${rootPath}:${relativePath}`;
    const prefixes = [bookmarkKey(readerId, ''), preferenceKey(readerId, '')];
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const storedKey = localStorage.key(index);
      if (
        storedKey &&
        prefixes.some((prefix) => storedKey.startsWith(prefix))
      ) {
        localStorage.removeItem(storedKey);
      }
    }
    localStorage.removeItem(key);
  } catch {
    // The PDF has already been removed even when browser storage is unavailable.
  }
}
