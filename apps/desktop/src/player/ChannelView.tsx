import { useEffect, useState } from 'react';
import Avatar from './Avatar';
import { usePlayerHost } from './host';
import { playerApi, errorText } from './player-api';
import { channelUrl } from './video-links';
import type { VideoItem } from './types';
import { SLOW_LOOKUP_TEXT, useSlowHint } from './use-slow-hint';
import VideoList, { StateMessage } from './VideoList';
import {
  channelInputFromInfo,
  describeDataError,
  fetchChannel,
} from './youtube-data';
import type { ChannelInfo, ChannelListing } from './youtube-data';

/**
 * A channel's page. The videos are read from YouTube each time the page opens (and kept, so the
 * feed and the history can refer to them); a followed channel shows what is already stored while it
 * loads, and keeps showing it when YouTube cannot be reached.
 */
export default function ChannelView({ channelId }: { channelId: string }) {
  const host = usePlayerHost();
  const followed = host.channels.find(
    (channel) => channel.channelId === channelId,
  );
  const [info, setInfo] = useState<ChannelInfo | null>(null);
  const [items, setItems] = useState<VideoItem[]>([]);
  const [more, setMore] = useState<ChannelListing['more']>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const slow = useSlowHint(loading);

  useEffect(() => {
    let current = true;
    (async () => {
      const stored = await playerApi
        .feed({ channelId, limit: 60 })
        .catch(() => [] as VideoItem[]);
      if (current && stored.length > 0) setItems(stored);
      try {
        const live = await fetchChannel(channelId);
        const fresh = await playerApi.storeVideos(live.videos);
        if (!current) return;
        setInfo(live.info);
        setItems(fresh);
        setMore(() => live.more);
        setError('');
        if (followed) {
          // The pictures and handles of channels that were imported fill in by themselves.
          await playerApi.updateChannel(channelInputFromInfo(live.info));
          if (current) await host.reloadOverview();
        }
      } catch (reason) {
        if (current) setError(describeDataError(reason));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
    // The followed state is read once; subscribing from this page must not load the page again.
  }, [channelId]);

  const name = info?.name ?? followed?.name ?? channelId;
  const avatarUrl = info?.avatarUrl ?? followed?.avatarUrl ?? null;
  const handle = info?.handle ?? followed?.handle ?? null;
  const description = info?.description ?? followed?.description ?? null;

  const loadMore = async () => {
    if (!more || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await more();
      const stored = await playerApi.storeVideos(next.videos);
      setItems((previous) => {
        const known = new Set(previous.map((item) => item.videoId));
        return [
          ...previous,
          ...stored.filter((item) => !known.has(item.videoId)),
        ];
      });
      setMore(() => next.more);
    } catch (reason) {
      host.notify(describeDataError(reason), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleFollow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (followed) {
        if (
          !window.confirm(
            `取消订阅“${followed.name}”？已收藏和看过的视频会保留。`,
          )
        )
          return;
        await playerApi.unsubscribe(channelId);
        host.notify(`已取消订阅 ${followed.name}`);
      } else {
        await playerApi.subscribe(
          info
            ? channelInputFromInfo(info)
            : { channelId, name, handle, avatarUrl, description },
        );
        host.notify(`已订阅 ${name}`);
      }
      await host.reloadOverview();
    } catch (reason) {
      host.notify(errorText(reason, '操作失败'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="player-view" aria-label={`频道：${name}`}>
      <header className="player-view-header is-channel">
        <Avatar name={name} url={avatarUrl} size={48} />
        <div className="player-view-heading">
          <h2 title={name}>{name}</h2>
          <p>
            {[handle, followed ? '已订阅' : '未订阅']
              .filter(Boolean)
              .join(' · ')}
          </p>
          {description && (
            <p className="player-channel-description" title={description}>
              {description}
            </p>
          )}
        </div>
        <div className="player-view-actions">
          <a
            className="player-button"
            href={channelUrl(channelId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            在 YouTube 打开
          </a>
          <button
            type="button"
            className={`player-button${followed ? '' : ' is-primary'}`}
            disabled={busy || (!followed && !info && loading)}
            onClick={() => void toggleFollow()}
          >
            {followed ? '取消订阅' : '订阅'}
          </button>
        </div>
      </header>
      <div className="player-view-body">
        {error && (
          <StateMessage kind="error" title="无法读取频道">
            {items.length > 0 ? `${error} 下面显示的是之前保存的视频。` : error}
          </StateMessage>
        )}
        {!error && loading && items.length === 0 && (
          <StateMessage kind="loading" title="正在读取频道…">
            {slow ? SLOW_LOOKUP_TEXT : undefined}
          </StateMessage>
        )}
        {!error && loading && items.length > 0 && slow && (
          <p className="player-inline-hint" role="status">
            {SLOW_LOOKUP_TEXT}下面先显示之前保存的视频。
          </p>
        )}
        {!error && !loading && items.length === 0 && (
          <StateMessage kind="empty" title="这个频道没有公开视频" />
        )}
        {items.length > 0 && (
          <VideoList items={items} queueTitle={name} showChannel={false} />
        )}
        {more && (
          <div className="player-more">
            <button
              type="button"
              className="player-button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? '正在读取…' : '加载更多'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
