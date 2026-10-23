import { useEffect, useRef, useState } from 'react';
import type { FeedRefreshState } from './use-feed-refresh';
import { formatAgo } from './format';
import { usePlayerHost } from './host';
import { RefreshIcon } from './icons';
import { playerApi } from './player-api';
import type { PlayerSettings } from './types';
import { useLoad } from './use-load';
import VideoList, { StateMessage, ViewHeader } from './VideoList';

const PAGE_SIZE = 60;

/** The newest videos of everyone the user follows. */
export default function FeedView({
  refresh,
  reloadToken,
  onRefresh,
  onCancel,
  onSettingsChange,
  onImport,
}: {
  refresh: FeedRefreshState;
  /** Counts up when new videos have been stored, so the list is read again. */
  reloadToken: number;
  onRefresh(force: boolean): void;
  onCancel(): void;
  onSettingsChange(settings: PlayerSettings): void;
  onImport(): void;
}) {
  const host = usePlayerHost();
  const hideFinished = host.settings.hideFinishedInFeed;
  const [limit, setLimit] = useState(PAGE_SIZE);
  const list = useLoad(() => playerApi.feed({ hideFinished, limit }));
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    list.reload();
  }, [reloadToken, hideFinished]);

  const items = list.data ?? [];
  const failed = refresh.report?.failed ?? [];
  const channelCount = host.channels.length;

  const lastChecked = host.channels.reduce(
    (latest, channel) => Math.max(latest, channel.lastCheckedAt ?? 0),
    0,
  );
  let subtitle = `${channelCount} 个订阅`;
  if (lastChecked > 0)
    subtitle += ` · 上次检查：${formatAgo(lastChecked, host.now)}`;
  if (refresh.running) {
    subtitle = refresh.lastChannel
      ? `正在更新 ${refresh.done}/${refresh.total} · ${refresh.lastChannel}`
      : '正在检查需要更新的频道…';
  } else if (refresh.report?.cancelled) {
    subtitle += ' · 更新已停止';
  } else if (failed.length > 0) {
    subtitle += ` · ${failed.length} 个频道更新失败`;
  }

  return (
    <section className="player-view" aria-label="动态">
      <ViewHeader
        title="动态"
        subtitle={subtitle}
        actions={
          <>
            <label className="player-check">
              <input
                type="checkbox"
                checked={hideFinished}
                onChange={(event) =>
                  onSettingsChange({
                    ...host.settings,
                    hideFinishedInFeed: event.target.checked,
                  })
                }
              />
              隐藏已看
            </label>
            <button
              type="button"
              className="player-button"
              disabled={channelCount === 0}
              onClick={() => (refresh.running ? onCancel() : onRefresh(true))}
              title={
                refresh.running ? '停止更新' : '检查所有订阅的频道是否有新视频'
              }
            >
              <RefreshIcon spinning={refresh.running} />
              {refresh.running ? '停止' : '更新'}
            </button>
          </>
        }
      />
      <div className="player-view-body">
        {failed.length > 0 && !refresh.running && (
          <details className="player-failures">
            <summary>
              {failed.length} 个频道没有更新成功
              <button
                type="button"
                className="player-text-button"
                onClick={(event) => {
                  event.preventDefault();
                  onRefresh(false);
                }}
              >
                重试
              </button>
            </summary>
            <ul>
              {failed.map((failure) => (
                <li key={failure.channelId}>
                  <button
                    type="button"
                    className="player-text-button"
                    onClick={() => host.openChannel(failure.channelId)}
                  >
                    {failure.name}
                  </button>
                  <span>{failure.message}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {list.error && (
          <StateMessage
            kind="error"
            title="无法读取动态"
            action={
              <button
                type="button"
                className="player-button"
                onClick={list.reload}
              >
                重试
              </button>
            }
          >
            {list.error}
          </StateMessage>
        )}
        {!list.error && list.data === null && (
          <StateMessage kind="loading" title="正在读取动态…" />
        )}
        {!list.error && list.data !== null && items.length === 0 && (
          <StateMessage
            kind="empty"
            title={
              channelCount === 0
                ? '还没有订阅任何频道'
                : refresh.running
                  ? '正在获取第一批视频…'
                  : hideFinished
                    ? '没有未看的新视频'
                    : '暂时没有视频'
            }
            action={
              channelCount === 0 ? (
                <button
                  type="button"
                  className="player-button is-primary"
                  onClick={onImport}
                >
                  导入订阅
                </button>
              ) : undefined
            }
          >
            {channelCount === 0
              ? '在左侧粘贴频道链接或 @名称即可订阅；也可以导入 NewPipe 或 Google Takeout 的订阅文件。'
              : undefined}
          </StateMessage>
        )}
        {items.length > 0 && (
          <>
            <VideoList items={items} queueTitle="动态" />
            {items.length >= limit && (
              <div className="player-more">
                <button
                  type="button"
                  className="player-button"
                  onClick={() => {
                    setLimit((value) => value + PAGE_SIZE);
                    list.reload();
                  }}
                  disabled={list.loading}
                >
                  {list.loading ? '正在读取…' : '加载更多'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
