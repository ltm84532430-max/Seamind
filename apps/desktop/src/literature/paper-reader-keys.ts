export const preferenceKey = (paperId: string, sha256: string) =>
  `seamind:paper-reader:v1:${encodeURIComponent(paperId)}:${sha256}`;

export const bookmarkKey = (paperId: string, sha256: string) =>
  `seamind:paper-bookmarks:v1:${encodeURIComponent(paperId)}:${sha256}`;
