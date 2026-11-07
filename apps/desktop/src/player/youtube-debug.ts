import type { YouTubePreviewSelection } from './YouTubePlayerDialog';
import type { NativeClient, NativePlayback } from './youtube-native';
import { isYouTubeDebugEnabled } from './youtube-proxy';

declare global {
  interface Window {
    __seamindYouTube?: {
      open(selection: YouTubePreviewSelection): void;
      resolve(
        videoId: string,
        clients?: NativeClient[],
      ): Promise<NativePlayback>;
      decipher(url: string): Promise<{ playerId: string; url: string }>;
    };
  }
}

/**
 * Lets an end-to-end check open the player for a video, resolve a stream with chosen clients, or
 * hand the player a prepared stream, without clicking through the mind map canvas. It only exists
 * while `seamind.debug.youtube` is "1" in localStorage, and it can do nothing the player dialog's
 * own buttons cannot.
 */
export function installYouTubeDebugHook(
  open: (selection: YouTubePreviewSelection) => void,
): () => void {
  if (!isYouTubeDebugEnabled()) return () => undefined;
  window.__seamindYouTube = {
    open,
    resolve: async (videoId, clients) =>
      (await import('./youtube-native')).resolveNativePlayback(videoId, {
        clients,
      }),
    decipher: async (url) =>
      (await import('./youtube-native')).decipherUrl(url),
  };
  return () => {
    delete window.__seamindYouTube;
  };
}
