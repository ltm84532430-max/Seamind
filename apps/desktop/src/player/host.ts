import { createContext, useContext } from 'react';
import type { Overlay, QueueSource } from './queue';
import type {
  LearningPathSummary,
  PlayerChannel,
  PlayerPlaylist,
  PlayerSettings,
  VideoItem,
} from './types';

/** Which list the main area shows when no video is playing. */
export type PlayerView =
  | { kind: 'feed' }
  | { kind: 'favorites' }
  | { kind: 'watch-later' }
  | { kind: 'history' }
  | { kind: 'course'; playlistId: string }
  | { kind: 'channel'; channelId: string }
  | { kind: 'remote-playlist'; listId: string }
  | { kind: 'learning-paths-home' }
  | { kind: 'learning-path'; pathId: string };

/** What the views of the player page ask of the page that holds them. */
export interface PlayerHost {
  /** Unix seconds, renewed every minute, for "3 days ago". */
  now: number;
  overlay: Overlay;
  settings: PlayerSettings;
  channels: PlayerChannel[];
  playlists: PlayerPlaylist[];
  learningPaths: LearningPathSummary[];
  openVideo(item: VideoItem, queue: QueueSource, startOverride?: number): void;
  openChannel(channelId: string): void;
  go(view: PlayerView): void;
  toggleFavorite(item: VideoItem): void;
  toggleWatchLater(item: VideoItem): void;
  toggleWatched(item: VideoItem): Promise<void>;
  notify(text: string, kind?: 'info' | 'error'): void;
  reloadOverview(): Promise<void>;
}

export const PlayerHostContext = createContext<PlayerHost | null>(null);

export function usePlayerHost(): PlayerHost {
  const host = useContext(PlayerHostContext);
  if (!host) throw new Error('The player page is missing its host.');
  return host;
}

/** A stable identity for a view, used as the React key so each view starts with a clean state. */
export function viewKey(view: PlayerView): string {
  switch (view.kind) {
    case 'course':
      return `course:${view.playlistId}`;
    case 'channel':
      return `channel:${view.channelId}`;
    case 'remote-playlist':
      return `remote:${view.listId}`;
    case 'learning-path':
      return `learning-path:${view.pathId}`;
    default:
      return view.kind;
  }
}
