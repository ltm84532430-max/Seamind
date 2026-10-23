import { useEffect, useState } from 'react';
import { usePlayerHost } from './host';
import { playerApi, errorText } from './player-api';
import type { VideoItem } from './types';
import { SLOW_LOOKUP_TEXT, useSlowHint } from './use-slow-hint';
import VideoList, { StateMessage, ViewHeader } from './VideoList';
import { describeDataError, fetchPlaylist } from './youtube-data';
import type { PlaylistListing } from './youtube-data';

/** A YouTube playlist that was pasted in: its videos, and the way to keep it as a course. */
export default function RemotePlaylistView({ listId }: { listId: string }) {
  const host = usePlayerHost();
  const [listing, setListing] = useState<PlaylistListing | null>(null);
  const [items, setItems] = useState<VideoItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const slow = useSlowHint(!listing && !error);
  const course = host.playlists.find(
    (playlist) => playlist.kind === 'course' && playlist.remoteId === listId,
  );

  const load = async (isCurrent: () => boolean) => {
    setError('');
    try {
      const loaded = await fetchPlaylist(listId);
      const stored = await playerApi.storeVideos(loaded.videos);
      if (!isCurrent()) return;
      setListing(loaded);
      setItems(stored);
    } catch (reason) {
      if (isCurrent()) setError(describeDataError(reason));
    }
  };

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [listId]);

  const title = listing?.title ?? '播放列表';

  const saveAsCourse = async () => {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const saved = await playerApi.saveCourse(
        listId,
        listing.title,
        listing.channelName,
        listing.videos,
      );
      await host.reloadOverview();
      host.notify(`已保存为课程“${saved.name}”`);
      host.go({ kind: 'course', playlistId: saved.playlistId });
    } catch (reason) {
      host.notify(errorText(reason, '无法保存课程'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const subtitle = listing
    ? [
        listing.channelName,
        `${items.length} 个视频${listing.truncated ? '（列表很长，只读取了前面一部分）' : ''}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  return (
    <section className="player-view" aria-label={`播放列表：${title}`}>
      <ViewHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {items.length > 0 && (
              <button
                type="button"
                className="player-button"
                onClick={() => host.openVideo(items[0], { title, items })}
              >
                从头播放
              </button>
            )}
            {course ? (
              <button
                type="button"
                className="player-button is-primary"
                onClick={() =>
                  host.go({ kind: 'course', playlistId: course.playlistId })
                }
              >
                打开课程
              </button>
            ) : (
              <button
                type="button"
                className="player-button is-primary"
                disabled={!listing || busy}
                onClick={() => void saveAsCourse()}
                title="保存后可以记录学习进度，并在左侧的“课程”里找到它"
              >
                {busy ? '正在保存…' : '保存为课程'}
              </button>
            )}
          </>
        }
      />
      <div className="player-view-body">
        {error && (
          <StateMessage
            kind="error"
            title="无法读取播放列表"
            action={
              <button
                type="button"
                className="player-button"
                onClick={() => void load(() => true)}
              >
                重试
              </button>
            }
          >
            {error}
          </StateMessage>
        )}
        {!error && !listing && (
          <StateMessage kind="loading" title="正在读取播放列表…">
            {slow ? SLOW_LOOKUP_TEXT : undefined}
          </StateMessage>
        )}
        {listing && items.length === 0 && (
          <StateMessage kind="empty" title="这个播放列表里没有可播放的视频" />
        )}
        {items.length > 0 && <VideoList items={items} queueTitle={title} />}
      </div>
    </section>
  );
}
