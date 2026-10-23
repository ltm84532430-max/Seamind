import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import ChannelView from './ChannelView';
import CollectionView from './CollectionView';
import FeedView from './FeedView';
import { PlayerHostContext, viewKey } from './host';
import type { PlayerHost, PlayerView } from './host';
import { ImportDialog, SettingsDialog } from './PlayerDialogs';
import { errorText, playerApi } from './player-api';
import { inputFromItem, patchOverlay } from './queue';
import type { Overlay, QueueSource, VideoPatch } from './queue';
import RemotePlaylistView from './RemotePlaylistView';
import Sidebar from './Sidebar';
import { FAVORITES_ID, WATCH_LATER_ID, defaultPlayerSettings } from './types';
import type {
  ImportSummary,
  PlayerOverview,
  PlayerSettings,
  VideoItem,
  WatchState,
} from './types';
import { useFeedRefresh } from './use-feed-refresh';
import { parseYouTubeTarget } from './video-links';
import { startSecondsFor } from './watch-state';
import { StateMessage } from './VideoList';
import WatchView from './WatchView';
import type { Watching } from './WatchView';
import { describeDataError, resolveChannelId } from './youtube-data';

interface Notice {
  text: string;
  kind: 'info' | 'error';
}

function viewLabel(view: PlayerView, overview: PlayerOverview | null): string {
  switch (view.kind) {
    case 'feed':
      return '动态';
    case 'favorites':
      return '收藏';
    case 'watch-later':
      return '稍后看';
    case 'history':
      return '历史';
    case 'course':
      return (
        overview?.playlists.find(
          (entry) => entry.playlistId === view.playlistId,
        )?.name ?? '课程'
      );
    case 'channel':
      return (
        overview?.channels.find((entry) => entry.channelId === view.channelId)
          ?.name ?? '频道'
      );
    case 'remote-playlist':
      return '播放列表';
  }
}

/**
 * The player page: the channels the user follows and their new videos, favorites, courses and the
 * history on the left and in the middle, and the player itself once a video is chosen.
 */
export default function PlayerWorkspace({ active }: { active: boolean }) {
  const [overview, setOverview] = useState<PlayerOverview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<PlayerView>({ kind: 'feed' });
  const [watching, setWatching] = useState<Watching | null>(null);
  const [overlay, setOverlay] = useState<Overlay>({});
  const [dialog, setDialog] = useState<'import' | 'settings' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [feedToken, setFeedToken] = useState(0);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');

  const mainRef = useRef<HTMLElement | null>(null);
  const savedScrollRef = useRef(0);
  const watchingRef = useRef<Watching | null>(null);
  const viewRef = useRef(view);
  const tokenRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);
  const autoRefreshedRef = useRef(false);
  useEffect(() => {
    watchingRef.current = watching;
    viewRef.current = view;
  });

  const reloadOverview = useCallback(async () => {
    try {
      setOverview(await playerApi.overview());
      setLoadError('');
    } catch (error) {
      setLoadError(errorText(error, '无法读取播放器数据'));
    }
  }, []);
  useEffect(() => {
    void reloadOverview();
  }, [reloadOverview]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const notify = useCallback(
    (text: string, kind: 'info' | 'error' = 'info') => {
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
      setNotice({ text, kind });
      noticeTimerRef.current = window.setTimeout(
        () => setNotice(null),
        kind === 'error' ? 9000 : 4500,
      );
    },
    [],
  );

  const refresh = useFeedRefresh({
    channels: overview?.channels ?? [],
    thresholdSeconds: overview?.settings.feedUpdateThresholdSeconds ?? 3600,
    onNewVideos: () => setFeedToken((value) => value + 1),
    onFinished: () => {
      setFeedToken((value) => value + 1);
      void reloadOverview();
    },
  });

  // Opening the feed brings it up to date: channels never checked, whose last check failed or that
  // are older than the interval. Once per visit to the page and per trip to the feed.
  useEffect(() => {
    if (!active) {
      autoRefreshedRef.current = false;
      return;
    }
    if (
      !overview ||
      autoRefreshedRef.current ||
      view.kind !== 'feed' ||
      watching ||
      overview.channels.length === 0
    )
      return;
    autoRefreshedRef.current = true;
    void refresh.start(false);
  }, [active, overview, view.kind, watching]);

  // The list the user came from is where they find themselves after a video.
  useLayoutEffect(() => {
    if (!watching && mainRef.current)
      mainRef.current.scrollTop = savedScrollRef.current;
  }, [watching === null]);

  const patch = useCallback(
    (videoId: string, change: VideoPatch) =>
      setOverlay((current) => patchOverlay(current, videoId, change)),
    [],
  );

  const go = useCallback((next: PlayerView) => {
    savedScrollRef.current = 0;
    // Going to the feed from somewhere else brings it up to date again, if anything is due.
    if (next.kind === 'feed' && viewRef.current.kind !== 'feed')
      autoRefreshedRef.current = false;
    setWatching(null);
    setView(next);
  }, []);

  const openVideo = useCallback(
    async (item: VideoItem, queue: QueueSource, startOverride?: number) => {
      if (!watchingRef.current)
        savedScrollRef.current = mainRef.current?.scrollTop ?? 0;
      let start = startOverride ?? 0;
      if (startOverride === undefined) {
        const state = await playerApi
          .watchState(item.videoId)
          .catch(() => null);
        start = startSecondsFor(state);
      }
      tokenRef.current += 1;
      setWatching({
        item,
        queue,
        startSeconds: start,
        token: tokenRef.current,
      });
      // A video the database has forgotten is saved again before it goes into the history.
      playerApi
        .markPlayed(item.videoId)
        .catch(() =>
          playerApi
            .storeVideos([inputFromItem(item)])
            .then(() => playerApi.markPlayed(item.videoId)),
        )
        .catch(() => undefined);
    },
    [],
  );

  const openChannel = useCallback(
    (channelId: string) => go({ kind: 'channel', channelId }),
    [go],
  );

  const toggleInList = useCallback(
    async (
      item: VideoItem,
      playlistId: string,
      key: 'favorite' | 'watchLater',
    ) => {
      const wasOn = item[key];
      patch(item.videoId, { [key]: !wasOn });
      try {
        if (!wasOn) await playerApi.storeVideos([inputFromItem(item)]);
        const present = await playerApi.togglePlaylist(
          playlistId,
          item.videoId,
        );
        patch(item.videoId, { [key]: present });
        void reloadOverview();
      } catch (error) {
        patch(item.videoId, { [key]: wasOn });
        notify(errorText(error, '操作失败'), 'error');
      }
    },
    [patch, notify, reloadOverview],
  );

  const toggleWatched = useCallback(
    async (item: VideoItem) => {
      const watched = !item.finished;
      const before: VideoPatch = {
        finished: item.finished,
        progressSeconds: item.progressSeconds,
      };
      patch(
        item.videoId,
        watched
          ? { finished: true }
          : { finished: false, progressSeconds: null },
      );
      try {
        if (watched) await playerApi.storeVideos([inputFromItem(item)]);
        await playerApi.setWatched(item.videoId, watched);
        void reloadOverview();
      } catch (error) {
        patch(item.videoId, before);
        notify(errorText(error, '操作失败'), 'error');
      }
    },
    [patch, notify, reloadOverview],
  );

  const onProgressSaved = useCallback(
    (videoId: string, state: WatchState) => {
      patch(videoId, {
        progressSeconds: state.progressSeconds,
        finished: state.finished,
      });
      // A lesson that has just been finished moves the counts beside the course.
      if (state.finished) void reloadOverview();
    },
    [patch, reloadOverview],
  );

  const saveSettings = useCallback(
    async (next: PlayerSettings) => {
      setOverview((current) => current && { ...current, settings: next });
      try {
        const saved = await playerApi.saveSettings(next);
        setOverview((current) => current && { ...current, settings: saved });
      } catch (error) {
        notify(errorText(error, '无法保存设置'), 'error');
        void reloadOverview();
      }
    },
    [notify, reloadOverview],
  );

  const openLink = useCallback(
    async (text: string): Promise<boolean> => {
      setOpenError('');
      const target = parseYouTubeTarget(text);
      if (!target) {
        setOpenError(
          '无法识别这个链接。可以粘贴视频、播放列表或频道的链接，也可以输入 @名称 或频道 ID。',
        );
        return false;
      }
      setOpening(true);
      try {
        switch (target.kind) {
          case 'video': {
            const start =
              target.startSeconds > 0 ? target.startSeconds : undefined;
            let [video] = await playerApi.videoItems([target.videoId]);
            if (!video) {
              let title = `视频 ${target.videoId}`;
              let channelName: string | null = null;
              try {
                const basics = await playerApi.fetchVideoInfo(target.videoId);
                title = basics.title || title;
                channelName = basics.channelName;
              } catch {
                // It can still be played; only its title is missing.
              }
              [video] = await playerApi.storeVideos([
                { videoId: target.videoId, title, channelName },
              ]);
            }
            if (!video) throw new Error('无法保存这个视频。');
            await openVideo(
              video,
              { title: '单个视频', items: [video] },
              start,
            );
            break;
          }
          case 'playlist':
            go({ kind: 'remote-playlist', listId: target.listId });
            break;
          case 'channel':
            go({ kind: 'channel', channelId: target.channelId });
            break;
          case 'handle':
          case 'lookup':
            go({ kind: 'channel', channelId: await resolveChannelId(target) });
            break;
        }
        return true;
      } catch (error) {
        setOpenError(describeDataError(error));
        return false;
      } finally {
        setOpening(false);
      }
    },
    [go, openVideo],
  );

  const refetchAll = useCallback(() => {
    autoRefreshedRef.current = false;
    setFeedToken((value) => value + 1);
    void reloadOverview();
  }, [reloadOverview]);

  const handleImported = (summary: ImportSummary) => {
    setDialog(null);
    go({ kind: 'feed' });
    refetchAll();
    const parts = [`已添加 ${summary.added} 个频道`];
    if (summary.existing > 0) parts.push(`${summary.existing} 个已在订阅里`);
    if (summary.invalid > 0) parts.push(`${summary.invalid} 个无法使用`);
    notify(
      `${parts.join('，')}。${summary.added > 0 ? '正在获取它们的视频…' : ''}`,
    );
  };

  const host = useMemo<PlayerHost>(
    () => ({
      now,
      overlay,
      settings: overview?.settings ?? defaultPlayerSettings,
      channels: overview?.channels ?? [],
      playlists: overview?.playlists ?? [],
      openVideo: (item, queue) => void openVideo(item, queue),
      openChannel,
      go,
      toggleFavorite: (item) =>
        void toggleInList(item, FAVORITES_ID, 'favorite'),
      toggleWatchLater: (item) =>
        void toggleInList(item, WATCH_LATER_ID, 'watchLater'),
      toggleWatched: (item) => void toggleWatched(item),
      notify,
      reloadOverview,
    }),
    [
      now,
      overlay,
      overview,
      openVideo,
      openChannel,
      go,
      toggleInList,
      toggleWatched,
      notify,
      reloadOverview,
    ],
  );

  let listView: ReactNode = null;
  if (overview) {
    switch (view.kind) {
      case 'feed':
        listView = (
          <FeedView
            key="feed"
            refresh={refresh.state}
            reloadToken={feedToken}
            onRefresh={(force) => void refresh.start(force)}
            onCancel={refresh.cancel}
            onSettingsChange={(next) => void saveSettings(next)}
            onImport={() => setDialog('import')}
          />
        );
        break;
      case 'channel':
        listView = (
          <ChannelView key={viewKey(view)} channelId={view.channelId} />
        );
        break;
      case 'remote-playlist':
        listView = (
          <RemotePlaylistView key={viewKey(view)} listId={view.listId} />
        );
        break;
      default:
        listView = <CollectionView key={viewKey(view)} collection={view} />;
    }
  }

  return (
    <PlayerHostContext.Provider value={host}>
      <div className="player-page">
        <Sidebar
          view={view}
          channels={host.channels}
          playlists={host.playlists}
          opening={opening}
          openError={openError}
          onGo={go}
          onOpenLink={openLink}
          onImport={() => setDialog('import')}
          onSettings={() => setDialog('settings')}
        />
        <main
          ref={mainRef}
          className={`player-main${watching ? ' is-watching' : ''}`}
        >
          {loadError && !overview && (
            <StateMessage
              kind="error"
              title="无法打开播放器"
              action={
                <button
                  type="button"
                  className="player-button"
                  onClick={() => void reloadOverview()}
                >
                  重试
                </button>
              }
            >
              {loadError}
            </StateMessage>
          )}
          {!loadError && !overview && (
            <StateMessage kind="loading" title="正在打开播放器…" />
          )}
          <div className="player-list-slot" hidden={Boolean(watching)}>
            {listView}
          </div>
          {watching && (
            <WatchView
              key={watching.token}
              watching={watching}
              active={active}
              backLabel={`返回${viewLabel(view, overview)}`}
              onBack={() => setWatching(null)}
              onSaved={onProgressSaved}
            />
          )}
        </main>
        {notice && (
          <div
            className={`player-toast is-${notice.kind}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            <span>{notice.text}</span>
            <button
              type="button"
              className="player-icon-button"
              aria-label="关闭提示"
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
        )}
        {dialog === 'import' && (
          <ImportDialog
            onClose={() => setDialog(null)}
            onImported={handleImported}
          />
        )}
        {dialog === 'settings' && (
          <SettingsDialog
            onClose={() => setDialog(null)}
            onChange={(next) => void saveSettings(next)}
            onRestored={refetchAll}
          />
        )}
      </div>
    </PlayerHostContext.Provider>
  );
}
