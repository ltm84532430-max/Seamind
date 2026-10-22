import type { EpubBookDocument, LibrarySnapshot, MapDocument } from './library';

const normalizePath = (path: string) =>
  path.replaceAll('\\', '/').toLowerCase();

const stablePathHash = (value: string) => {
  let hash = 0x811c9dc5;
  for (const character of normalizePath(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

// Keep this in step with library.rs safe_file_stem and its 120-character title limit.
export const bookMindmapTitle = (value: string) => {
  const title = Array.from(value.trim()).slice(0, 120).join('') || '电子书';
  const stem = title
    // Windows file names cannot contain control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
    ? `电子书-${title}`
    : title;
};

export const bookMindmapPath = (title: string) => {
  const stem = bookMindmapTitle(title)
    // Windows file names cannot contain control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return `books/${stem}.md`;
};

export function resolveBookMindmapTarget(
  snapshot: LibrarySnapshot,
  book: Pick<EpubBookDocument, 'relativePath' | 'title'>,
  readSavedPath: (epubRelativePath: string) => string | null,
): { relativePath: string; document: MapDocument | null; title: string } {
  const findDocument = (path: string) =>
    snapshot.documents.find(
      (document) =>
        normalizePath(document.relativePath) === normalizePath(path),
    ) ?? null;
  const savedPath = readSavedPath(book.relativePath);
  const savedDocument = savedPath ? findDocument(savedPath) : null;
  if (savedDocument) {
    return {
      relativePath: savedDocument.relativePath,
      document: savedDocument,
      title: savedDocument.title,
    };
  }

  // An older build stored the proposed path even when Rust saved a different one.
  const preferredPath = bookMindmapPath(book.title);
  const claimedByAnotherBook = snapshot.books.some(
    (candidate) =>
      normalizePath(candidate.relativePath) !==
        normalizePath(book.relativePath) &&
      normalizePath(readSavedPath(candidate.relativePath) ?? '') ===
        normalizePath(preferredPath),
  );
  const title = claimedByAnotherBook
    ? `${Array.from(bookMindmapTitle(book.title)).slice(0, 111).join('')}-${stablePathHash(book.relativePath)}`
    : bookMindmapTitle(book.title);
  const relativePath = claimedByAnotherBook
    ? bookMindmapPath(title)
    : preferredPath;
  const document = findDocument(relativePath);
  return {
    relativePath: document?.relativePath ?? relativePath,
    document,
    title,
  };
}
