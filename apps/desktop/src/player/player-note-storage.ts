export const PLAYER_DOCUMENT_UPDATED_EVENT = 'seamind:player-document-updated';

export interface PlayerDocumentUpdatedDetail {
  videoId: string;
  markdown: string;
}

export function playerDocumentStorageKey(videoId: string): string {
  return `seamind:player-document:v1:${videoId}`;
}

export function playerLegacyNoteStorageKey(videoId: string): string {
  return `seamind:player-note:v1:${videoId}`;
}

export function readPlayerDocumentMarkdown(videoId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const markdown =
      window.localStorage.getItem(playerDocumentStorageKey(videoId)) ??
      window.localStorage.getItem(playerLegacyNoteStorageKey(videoId));
    return markdown?.trim() ? markdown : null;
  } catch {
    return null;
  }
}

// 同一 WebView 内的 localStorage 写入不会触发 storage 事件，用自定义事件通知星图。
export function notifyPlayerDocumentUpdated(
  videoId: string,
  markdown: string,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<PlayerDocumentUpdatedDetail>(
      PLAYER_DOCUMENT_UPDATED_EVENT,
      { detail: { videoId, markdown } },
    ),
  );
}
