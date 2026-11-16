import { describe, expect, it, vi } from 'vitest';
import {
  GlobalMediaStore,
  type ActivePodcastMeta,
  type ActiveVideoMeta,
  type MediaAdapter,
} from '../src/media/global-media-store';

function videoMeta(
  id: string,
  overrides: Partial<ActiveVideoMeta> = {},
): ActiveVideoMeta {
  return {
    kind: 'video',
    id,
    title: `Video ${id}`,
    subtitle: 'Channel',
    artworkUrl: null,
    status: 'playing',
    duration: 300,
    playbackRate: 1,
    muted: false,
    canSeek: true,
    ...overrides,
  };
}

function podcastMeta(
  id: string,
  overrides: Partial<ActivePodcastMeta> = {},
): ActivePodcastMeta {
  return {
    kind: 'podcast',
    id,
    title: `Podcast ${id}`,
    subtitle: 'Feed Show',
    artworkUrl: null,
    status: 'playing',
    duration: 1800,
    playbackRate: 1,
    muted: false,
    canSeek: true,
    ...overrides,
  };
}

function createMockAdapter(): MediaAdapter & {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  seekTo: ReturnType<typeof vi.fn>;
  toggleMute: ReturnType<typeof vi.fn>;
  stopAndClose: ReturnType<typeof vi.fn>;
} {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    seekTo: vi.fn(),
    toggleMute: vi.fn(),
    stopAndClose: vi.fn(),
  };
}

describe('GlobalMediaStore', () => {
  it('hides mini-player inside origin workspace and docks only when leaving while live', () => {
    const store = new GlobalMediaStore('player');
    const videoAdapter = createMockAdapter();
    store.registerAdapter('video', videoAdapter);

    store.claimFocus(videoMeta('v1', { status: 'playing' }));
    expect(store.getVisibleMiniPlayer()).toBeNull();

    // Leaving player while playing docks the video in the topbar.
    store.setWorkspace('knowledge');
    expect(store.getVisibleMiniPlayer()?.meta.id).toBe('v1');
    expect(store.getVisibleMiniPlayer()?.meta.status).toBe('playing');

    // Switching between other non-origin pages keeps the mini-player visible.
    store.setWorkspace('tasks');
    expect(store.getVisibleMiniPlayer()?.meta.id).toBe('v1');

    // Returning to player hides the topbar mini-player.
    store.setWorkspace('player');
    expect(store.getVisibleMiniPlayer()).toBeNull();

    // Pausing inside player and then leaving keeps topbar empty.
    store.updateMeta('video', { status: 'paused' });
    store.setWorkspace('mindmap');
    expect(store.getVisibleMiniPlayer()).toBeNull();
  });

  it('keeps mini-player visible when paused from topbar, and clears permanently on dismiss', () => {
    const store = new GlobalMediaStore('player');
    const videoAdapter = createMockAdapter();
    store.registerAdapter('video', videoAdapter);

    store.claimFocus(videoMeta('v1', { status: 'playing' }));
    store.setWorkspace('reader');
    expect(store.getVisibleMiniPlayer()?.meta.status).toBe('playing');

    // Pause via topbar: adapter pauses, mini-player stays visible as paused.
    store.togglePlayActive();
    expect(videoAdapter.pause).toHaveBeenCalledTimes(1);
    store.updateMeta('video', { status: 'paused' });
    expect(store.getVisibleMiniPlayer()?.meta.status).toBe('paused');

    // Resume via topbar.
    store.togglePlayActive();
    expect(videoAdapter.play).toHaveBeenCalledTimes(1);
    store.updateMeta('video', { status: 'playing' });
    expect(store.getVisibleMiniPlayer()?.meta.status).toBe('playing');

    // Dismiss (×): stops playback and clears across subsequent workspace switches.
    store.dismissMiniPlayer();
    expect(videoAdapter.stopAndClose).toHaveBeenCalledTimes(1);
    expect(store.getVisibleMiniPlayer()).toBeNull();

    store.setWorkspace('mindmap');
    expect(store.getVisibleMiniPlayer()).toBeNull();
    store.setWorkspace('player');
    store.setWorkspace('knowledge');
    expect(store.getVisibleMiniPlayer()).toBeNull();
  });

  it('arbitrates audio focus cleanly when switching to feed and starting a podcast', () => {
    const store = new GlobalMediaStore('player');
    const videoAdapter = createMockAdapter();
    const podcastAdapter = createMockAdapter();
    store.registerAdapter('video', videoAdapter);
    store.registerAdapter('podcast', podcastAdapter);

    store.claimFocus(videoMeta('v1', { status: 'playing' }));
    store.setWorkspace('knowledge');
    expect(store.getVisibleMiniPlayer()?.meta.kind).toBe('video');

    // Just browsing feed keeps background video playing in the topbar.
    store.setWorkspace('feed');
    expect(store.getVisibleMiniPlayer()?.meta.kind).toBe('video');
    expect(videoAdapter.pause).not.toHaveBeenCalled();

    // Starting a podcast pauses the video and switches focus to podcast (hidden inside feed).
    store.claimFocus(podcastMeta('p1', { status: 'playing' }));
    expect(videoAdapter.pause).toHaveBeenCalledTimes(1);
    expect(store.getActiveSource()).toBe('podcast');
    expect(store.getVisibleMiniPlayer()).toBeNull();

    // Leaving feed updates topbar with the new podcast source.
    store.setWorkspace('mindmap');
    expect(store.getVisibleMiniPlayer()?.meta.kind).toBe('podcast');
    expect(store.getVisibleMiniPlayer()?.meta.id).toBe('p1');

    // Dismissing podcast clears everything for future switches.
    store.dismissMiniPlayer();
    expect(podcastAdapter.stopAndClose).toHaveBeenCalledTimes(1);
    expect(store.getVisibleMiniPlayer()).toBeNull();
    store.setWorkspace('tasks');
    expect(store.getVisibleMiniPlayer()).toBeNull();
  });

  it('tracks background YouTube embed state and throttles trivial progress ticks', () => {
    const store = new GlobalMediaStore('player');
    const progressListener = vi.fn();
    store.subscribeProgress(progressListener);

    store.claimFocus(videoMeta('v1', { status: 'playing', isEmbedMode: true }));
    expect(store.getIsEmbedBackground()).toBe(false);
    expect(progressListener).toHaveBeenCalledTimes(1);
    progressListener.mockClear();

    store.setWorkspace('mindmap');
    expect(store.getIsEmbedBackground()).toBe(true);

    store.setProgress('video', {
      currentTime: 10,
      duration: 200,
      bufferedPercent: 20,
    });
    expect(progressListener).toHaveBeenCalledTimes(1);

    // Sub-threshold delta (< 0.15s) does not notify listeners.
    store.setProgress('video', {
      currentTime: 10.05,
      duration: 200,
      bufferedPercent: 20,
    });
    expect(progressListener).toHaveBeenCalledTimes(1);

    store.updateMeta('video', { status: 'paused' });
    expect(store.getIsEmbedBackground()).toBe(false);
    // Still docked while paused in topbar: keep stage offscreen so playVideo() never hits display:none.
    expect(store.getIsVideoStageOffscreen()).toBe(true);

    store.dismissMiniPlayer();
    expect(store.getIsVideoStageOffscreen()).toBe(false);
  });

  it('toggles live loading/playing/paused states consistently from topbar', () => {
    const store = new GlobalMediaStore('mindmap');
    const adapter = {
      play: vi.fn(),
      pause: vi.fn(),
      seekTo: vi.fn(),
      toggleMute: vi.fn(),
      stopAndClose: vi.fn(),
    };
    store.registerAdapter('video', adapter);
    store.setWorkspace('player');
    store.claimFocus(videoMeta('v1', { status: 'loading' }));
    store.setWorkspace('tasks');

    expect(store.getVisibleMiniPlayer()?.meta.status).toBe('loading');
    store.togglePlayActive();
    expect(adapter.pause).toHaveBeenCalledTimes(1);

    store.updateMeta('video', { status: 'paused' });
    store.togglePlayActive();
    expect(adapter.play).toHaveBeenCalledTimes(1);
  });
});
