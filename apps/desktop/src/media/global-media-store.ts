import {
  createContext,
  createElement,
  useContext,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type { ActiveWorkspace } from '../app/app-storage';

export type MediaSourceKind = 'video' | 'podcast';

export type MediaPlayStatus =
  'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface ActiveVideoMeta {
  kind: 'video';
  id: string;
  title: string;
  subtitle: string | null;
  artworkUrl: string | null;
  status: MediaPlayStatus;
  duration: number;
  playbackRate: number;
  muted: boolean;
  canSeek: boolean;
  isEmbedMode?: boolean;
  externalOnly?: boolean;
}

export interface ActivePodcastMeta {
  kind: 'podcast';
  id: string;
  title: string;
  subtitle: string | null;
  artworkUrl: string | null;
  status: MediaPlayStatus;
  duration: number;
  playbackRate: number;
  muted: boolean;
  canSeek: boolean;
  captionEnabled?: boolean;
}

export type ActiveMediaMeta = ActiveVideoMeta | ActivePodcastMeta;

export interface MediaProgressSnapshot {
  currentTime: number;
  duration: number;
  bufferedPercent: number;
}

export interface MediaAdapter {
  play(): void;
  pause(): void;
  seekTo(seconds: number): void;
  skipBy?(deltaSeconds: number): void;
  toggleMute(): void;
  cycleSpeed?(): void;
  /** Invoked when the user clicks × on the topbar mini-player. */
  stopAndClose(): void;
}

export interface MiniPlayerViewState {
  meta: ActiveMediaMeta;
  docked: boolean;
}

const EMPTY_PROGRESS: MediaProgressSnapshot = {
  currentTime: 0,
  duration: 0,
  bufferedPercent: 0,
};

export function isLivePlaybackStatus(status: MediaPlayStatus): boolean {
  return status === 'playing' || status === 'buffering' || status === 'loading';
}

export function originWorkspaceOf(kind: MediaSourceKind): ActiveWorkspace {
  return kind === 'video' ? 'player' : 'feed';
}

function shallowEqualMeta(
  a: ActiveMediaMeta | null,
  b: ActiveMediaMeta | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (
    a.id !== b.id ||
    a.title !== b.title ||
    a.subtitle !== b.subtitle ||
    a.artworkUrl !== b.artworkUrl ||
    a.status !== b.status ||
    a.duration !== b.duration ||
    a.playbackRate !== b.playbackRate ||
    a.muted !== b.muted ||
    a.canSeek !== b.canSeek
  ) {
    return false;
  }
  if (a.kind === 'video' && b.kind === 'video') {
    return a.isEmbedMode === b.isEmbedMode && a.externalOnly === b.externalOnly;
  }
  if (a.kind === 'podcast' && b.kind === 'podcast') {
    return a.captionEnabled === b.captionEnabled;
  }
  return false;
}

export class GlobalMediaStore {
  private activeWorkspace: ActiveWorkspace;
  private activeSource: MediaSourceKind | null = null;
  private docked = false;
  private focusEpoch = 0;

  private metaByKind: Record<MediaSourceKind, ActiveMediaMeta | null> = {
    video: null,
    podcast: null,
  };
  private progressByKind: Record<MediaSourceKind, MediaProgressSnapshot> = {
    video: EMPTY_PROGRESS,
    podcast: EMPTY_PROGRESS,
  };
  private adapters: Record<MediaSourceKind, MediaAdapter | null> = {
    video: null,
    podcast: null,
  };

  private metaListeners = new Set<() => void>();
  private progressListeners = new Set<() => void>();
  private cachedVisibleMiniPlayer: MiniPlayerViewState | null = null;
  private cachedEmbedBackground = false;
  private cachedVideoStageOffscreen = false;
  private cachedActiveSource: MediaSourceKind | null = null;

  constructor(initialWorkspace: ActiveWorkspace = 'mindmap') {
    this.activeWorkspace = initialWorkspace;
  }

  subscribeMeta = (listener: () => void): (() => void) => {
    this.metaListeners.add(listener);
    return () => {
      this.metaListeners.delete(listener);
    };
  };

  subscribeProgress = (listener: () => void): (() => void) => {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  };

  private recomputeCachedSnapshots() {
    const source = this.activeSource;
    this.cachedActiveSource = source;

    let nextVisible: MiniPlayerViewState | null = null;
    if (
      source &&
      this.docked &&
      this.activeWorkspace !== originWorkspaceOf(source)
    ) {
      const meta = this.metaByKind[source];
      if (meta && !(meta.kind === 'video' && meta.externalOnly)) {
        nextVisible = { meta, docked: true };
      }
    }
    if (
      !nextVisible ||
      !this.cachedVisibleMiniPlayer ||
      !shallowEqualMeta(nextVisible.meta, this.cachedVisibleMiniPlayer.meta) ||
      nextVisible.docked !== this.cachedVisibleMiniPlayer.docked
    ) {
      this.cachedVisibleMiniPlayer = nextVisible;
    }

    const videoMeta = this.metaByKind.video;
    const isDockedVideoBackground = Boolean(
      this.activeWorkspace !== 'player' &&
      source === 'video' &&
      this.docked &&
      videoMeta?.kind === 'video' &&
      !videoMeta.externalOnly,
    );
    this.cachedVideoStageOffscreen = isDockedVideoBackground;
    this.cachedEmbedBackground = Boolean(
      isDockedVideoBackground &&
      videoMeta?.kind === 'video' &&
      videoMeta.isEmbedMode &&
      isLivePlaybackStatus(videoMeta.status),
    );
  }

  private emitMeta() {
    this.recomputeCachedSnapshots();
    for (const listener of this.metaListeners) listener();
  }

  private emitProgress() {
    for (const listener of this.progressListeners) listener();
  }

  getVisibleMiniPlayer = (): MiniPlayerViewState | null => {
    return this.cachedVisibleMiniPlayer;
  };

  getIsEmbedBackground = (): boolean => {
    return this.cachedEmbedBackground;
  };

  getIsVideoStageOffscreen = (): boolean => {
    return this.cachedVideoStageOffscreen;
  };

  getActiveSource = (): MediaSourceKind | null => {
    return this.cachedActiveSource;
  };

  getActiveProgress = (): MediaProgressSnapshot => {
    if (!this.activeSource) return EMPTY_PROGRESS;
    return this.progressByKind[this.activeSource];
  };

  getProgressOf = (kind: MediaSourceKind): MediaProgressSnapshot => {
    return this.progressByKind[kind];
  };

  getMetaOf(kind: MediaSourceKind): ActiveMediaMeta | null {
    return this.metaByKind[kind];
  }

  getFocusEpoch(): number {
    return this.focusEpoch;
  }

  getActiveWorkspace(): ActiveWorkspace {
    return this.activeWorkspace;
  }

  isDocked(): boolean {
    return this.docked;
  }

  setWorkspace(next: ActiveWorkspace) {
    const prev = this.activeWorkspace;
    if (prev === next) return;
    this.activeWorkspace = next;

    if (this.activeSource) {
      const origin = originWorkspaceOf(this.activeSource);
      if (next === origin) {
        // Inside origin workspace: topbar mini-player hides and resets docking for next exit.
        this.docked = false;
      } else if (prev === origin) {
        // Leaving origin workspace: keep playing & dock only if currently playing/buffering/loading.
        const meta = this.metaByKind[this.activeSource];
        const canDock =
          Boolean(meta) &&
          !(meta?.kind === 'video' && meta.externalOnly) &&
          isLivePlaybackStatus(meta!.status);
        this.docked = canDock;
        if (!canDock) {
          this.activeSource = null;
        }
      }
    }

    this.emitMeta();
  }

  registerAdapter(kind: MediaSourceKind, adapter: MediaAdapter | null) {
    this.adapters[kind] = adapter;
  }

  claimFocus(meta: ActiveMediaMeta) {
    this.focusEpoch += 1;
    const other: MediaSourceKind = meta.kind === 'video' ? 'podcast' : 'video';

    if (this.activeSource === other) {
      this.adapters[other]?.pause();
      const otherMeta = this.metaByKind[other];
      if (otherMeta && isLivePlaybackStatus(otherMeta.status)) {
        this.metaByKind[other] = { ...otherMeta, status: 'paused' };
      }
      this.docked = false;
    } else if (this.activeSource !== meta.kind) {
      this.docked = false;
    }

    this.activeSource = meta.kind;
    this.metaByKind[meta.kind] = meta;
    this.emitMeta();
    this.emitProgress();
  }

  updateMeta(kind: MediaSourceKind, patch: Partial<ActiveMediaMeta>) {
    const current = this.metaByKind[kind];
    if (!current) return;
    const next = { ...current, ...patch, kind } as ActiveMediaMeta;
    if (shallowEqualMeta(current, next)) return;
    this.metaByKind[kind] = next;
    this.emitMeta();
  }

  setProgress(kind: MediaSourceKind, progress: MediaProgressSnapshot) {
    const current = this.progressByKind[kind];
    const safeTime = Number.isFinite(progress.currentTime)
      ? Math.max(0, progress.currentTime)
      : 0;
    const safeDuration = Number.isFinite(progress.duration)
      ? Math.max(0, progress.duration)
      : 0;
    const safeBuffered = Number.isFinite(progress.bufferedPercent)
      ? Math.max(0, Math.min(100, progress.bufferedPercent))
      : 0;

    if (
      Math.abs(current.currentTime - safeTime) < 0.15 &&
      Math.abs(current.duration - safeDuration) < 0.25 &&
      Math.abs(current.bufferedPercent - safeBuffered) < 1
    ) {
      return;
    }
    this.progressByKind[kind] = {
      currentTime: safeTime,
      duration: safeDuration,
      bufferedPercent: safeBuffered,
    };
    if (this.activeSource === kind || kind === 'podcast') {
      this.emitProgress();
    }
  }

  clearSource(kind: MediaSourceKind) {
    this.metaByKind[kind] = null;
    this.progressByKind[kind] = EMPTY_PROGRESS;
    if (this.activeSource === kind) {
      this.activeSource = null;
      this.docked = false;
    }
    this.emitMeta();
    this.emitProgress();
  }

  pauseActiveMedia(exceptKind?: MediaSourceKind) {
    const source = this.activeSource;
    if (!source || source === exceptKind) return;
    this.adapters[source]?.pause();
    const meta = this.metaByKind[source];
    if (meta && isLivePlaybackStatus(meta.status)) {
      this.metaByKind[source] = { ...meta, status: 'paused' };
      this.emitMeta();
    }
  }

  togglePlayActive() {
    const source = this.activeSource;
    if (!source) return;
    const meta = this.metaByKind[source];
    const adapter = this.adapters[source];
    if (!meta || !adapter) return;
    if (isLivePlaybackStatus(meta.status)) {
      adapter.pause();
    } else {
      adapter.play();
    }
  }

  seekActive(seconds: number) {
    const source = this.activeSource;
    if (!source) return;
    const adapter = this.adapters[source];
    if (!adapter) return;
    const target = Math.max(0, seconds);
    adapter.seekTo(target);
    const current = this.progressByKind[source];
    this.progressByKind[source] = { ...current, currentTime: target };
    this.emitProgress();
  }

  skipActive(deltaSeconds: number) {
    const source = this.activeSource;
    if (!source) return;
    const adapter = this.adapters[source];
    if (!adapter) return;
    if (adapter.skipBy) {
      adapter.skipBy(deltaSeconds);
      return;
    }
    const current = this.progressByKind[source];
    const upper =
      current.duration > 0 ? current.duration : Number.MAX_SAFE_INTEGER;
    const target = Math.max(
      0,
      Math.min(upper, current.currentTime + deltaSeconds),
    );
    this.seekActive(target);
  }

  toggleMuteActive() {
    const source = this.activeSource;
    if (!source) return;
    this.adapters[source]?.toggleMute();
  }

  dismissMiniPlayer() {
    const source = this.activeSource;
    if (!source) return;
    const adapter = this.adapters[source];
    this.docked = false;
    this.activeSource = null;
    adapter?.stopAndClose();
    if (
      this.metaByKind[source] &&
      isLivePlaybackStatus(this.metaByKind[source]!.status)
    ) {
      this.metaByKind[source] = {
        ...this.metaByKind[source]!,
        status: 'paused',
      };
    }
    this.emitMeta();
  }
}

const GlobalMediaContext = createContext<GlobalMediaStore | null>(null);

export function GlobalMediaProvider({
  initialWorkspace = 'mindmap',
  children,
}: {
  initialWorkspace?: ActiveWorkspace;
  children: ReactNode;
}) {
  const storeRef = useRef<GlobalMediaStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new GlobalMediaStore(initialWorkspace);
  }
  return createElement(
    GlobalMediaContext.Provider,
    { value: storeRef.current },
    children,
  );
}

export function useGlobalMediaOptional(): GlobalMediaStore | null {
  return useContext(GlobalMediaContext);
}

export function useGlobalMedia(): GlobalMediaStore {
  const store = useContext(GlobalMediaContext);
  if (!store) {
    throw new Error('useGlobalMedia must be used within GlobalMediaProvider');
  }
  return store;
}

export function useMiniPlayerState(): MiniPlayerViewState | null {
  const store = useGlobalMedia();
  return useSyncExternalStore(
    store.subscribeMeta,
    store.getVisibleMiniPlayer,
    store.getVisibleMiniPlayer,
  );
}

export function useActiveMediaProgress(): MediaProgressSnapshot {
  const store = useGlobalMedia();
  return useSyncExternalStore(
    store.subscribeProgress,
    store.getActiveProgress,
    store.getActiveProgress,
  );
}

export function useIsEmbedBackgroundActive(): boolean {
  const store = useGlobalMedia();
  return useSyncExternalStore(
    store.subscribeMeta,
    store.getIsEmbedBackground,
    store.getIsEmbedBackground,
  );
}

export function useIsVideoStageOffscreen(): boolean {
  const store = useGlobalMedia();
  return useSyncExternalStore(
    store.subscribeMeta,
    store.getIsVideoStageOffscreen,
    store.getIsVideoStageOffscreen,
  );
}
