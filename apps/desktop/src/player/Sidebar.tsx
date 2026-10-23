import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import Avatar from './Avatar';
import type { PlayerView } from './host';
import {
  ClockIcon,
  CourseIcon,
  FeedIcon,
  HistoryIcon,
  PlusIcon,
  SettingsIcon,
  StarIcon,
  WarningIcon,
} from './icons';
import { sortChannels } from './queue';
import { FAVORITES_ID, WATCH_LATER_ID } from './types';
import type { PlayerChannel, PlayerPlaylist } from './types';
import { SLOW_LOOKUP_TEXT, useSlowHint } from './use-slow-hint';

/** More subscriptions than this get a box to filter them by name. */
const FILTER_FROM = 10;

function isCurrent(view: PlayerView, other: PlayerView): boolean {
  if (view.kind !== other.kind) return false;
  if (view.kind === 'course' && other.kind === 'course')
    return view.playlistId === other.playlistId;
  if (view.kind === 'channel' && other.kind === 'channel')
    return view.channelId === other.channelId;
  return true;
}

function NavItem({
  view,
  target,
  icon,
  label,
  badge,
  onGo,
}: {
  view: PlayerView;
  target: PlayerView;
  icon: ReactNode;
  label: string;
  badge?: string;
  onGo(view: PlayerView): void;
}) {
  const current = isCurrent(view, target);
  return (
    <button
      type="button"
      className={`player-nav-item${current ? ' is-current' : ''}`}
      aria-current={current ? 'page' : undefined}
      onClick={() => onGo(target)}
    >
      <span className="player-nav-icon">{icon}</span>
      <span className="player-nav-label">{label}</span>
      {badge && <span className="player-nav-badge">{badge}</span>}
    </button>
  );
}

/** Where to go in the player page, the box that takes a pasted link, and the people followed. */
export default function Sidebar({
  view,
  channels,
  playlists,
  opening,
  openError,
  onGo,
  onOpenLink,
  onImport,
  onSettings,
}: {
  view: PlayerView;
  channels: PlayerChannel[];
  playlists: PlayerPlaylist[];
  /** A pasted link is being looked up. */
  opening: boolean;
  openError: string;
  onGo(view: PlayerView): void;
  /** Resolves to whether the link led somewhere, in which case the box is emptied. */
  onOpenLink(text: string): Promise<boolean>;
  onImport(): void;
  onSettings(): void;
}) {
  const [link, setLink] = useState('');
  const [filter, setFilter] = useState('');
  const slowOpen = useSlowHint(opening);
  const sorted = useMemo(() => sortChannels(channels), [channels]);
  const shown = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query
      ? sorted.filter(
          (channel) =>
            channel.name.toLowerCase().includes(query) ||
            (channel.handle ?? '').toLowerCase().includes(query),
        )
      : sorted;
  }, [sorted, filter]);
  const courses = playlists.filter((playlist) => playlist.kind === 'course');
  const count = (id: string) =>
    playlists.find((playlist) => playlist.playlistId === id)?.itemCount;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!link.trim() || opening) return;
    if (await onOpenLink(link)) setLink('');
  };

  return (
    <aside className="player-sidebar" aria-label="播放器导航">
      <form className="player-open" onSubmit={(event) => void submit(event)}>
        <input
          type="text"
          value={link}
          placeholder="粘贴 YouTube 链接或 @名称"
          title="可以粘贴视频、播放列表或频道的链接，也可以输入 @名称 或频道 ID，按回车打开"
          aria-label="粘贴 YouTube 链接"
          spellCheck={false}
          onChange={(event) => setLink(event.target.value)}
        />
        <button
          type="submit"
          className="player-open-button"
          disabled={!link.trim() || opening}
          title="打开"
          aria-label="打开"
        >
          {opening ? '…' : '打开'}
        </button>
      </form>
      {opening && slowOpen && (
        <p className="player-open-hint" role="status">
          {SLOW_LOOKUP_TEXT}
        </p>
      )}
      {openError && (
        <p className="player-open-error" role="alert">
          <WarningIcon />
          {openError}
        </p>
      )}

      <nav className="player-nav" aria-label="播放器">
        <NavItem
          view={view}
          target={{ kind: 'feed' }}
          icon={<FeedIcon />}
          label="动态"
          onGo={onGo}
        />
        <NavItem
          view={view}
          target={{ kind: 'favorites' }}
          icon={<StarIcon />}
          label="收藏"
          badge={count(FAVORITES_ID) ? String(count(FAVORITES_ID)) : undefined}
          onGo={onGo}
        />
        <NavItem
          view={view}
          target={{ kind: 'watch-later' }}
          icon={<ClockIcon />}
          label="稍后看"
          badge={
            count(WATCH_LATER_ID) ? String(count(WATCH_LATER_ID)) : undefined
          }
          onGo={onGo}
        />
        <NavItem
          view={view}
          target={{ kind: 'history' }}
          icon={<HistoryIcon />}
          label="历史"
          onGo={onGo}
        />

        {courses.length > 0 && (
          <>
            <h3 className="player-nav-heading">课程</h3>
            {courses.map((course) => (
              <NavItem
                key={course.playlistId}
                view={view}
                target={{ kind: 'course', playlistId: course.playlistId }}
                icon={<CourseIcon />}
                label={course.name}
                badge={`${course.finishedCount}/${course.itemCount}`}
                onGo={onGo}
              />
            ))}
          </>
        )}

        <h3 className="player-nav-heading">
          订阅
          {channels.length > 0 && (
            <span className="player-nav-count">{channels.length}</span>
          )}
        </h3>
        {channels.length >= FILTER_FROM && (
          <input
            type="search"
            className="player-filter"
            value={filter}
            placeholder="筛选订阅"
            aria-label="筛选订阅"
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        {channels.length === 0 && (
          <p className="player-nav-empty">
            还没有订阅。粘贴频道链接，或导入订阅文件。
          </p>
        )}
        {shown.map((channel) => {
          const current = isCurrent(view, {
            kind: 'channel',
            channelId: channel.channelId,
          });
          return (
            <button
              key={channel.channelId}
              type="button"
              className={`player-nav-item is-channel${current ? ' is-current' : ''}`}
              aria-current={current ? 'page' : undefined}
              title={
                channel.lastError
                  ? `${channel.name}\n上次更新失败：${channel.lastError}`
                  : channel.name
              }
              onClick={() =>
                onGo({ kind: 'channel', channelId: channel.channelId })
              }
            >
              <Avatar name={channel.name} url={channel.avatarUrl} size={22} />
              <span className="player-nav-label">{channel.name}</span>
              {channel.lastError && (
                <span className="player-nav-warning" aria-label="更新失败">
                  <WarningIcon />
                </span>
              )}
            </button>
          );
        })}
        {channels.length > 0 && shown.length === 0 && (
          <p className="player-nav-empty">没有匹配的订阅。</p>
        )}
      </nav>

      <div className="player-sidebar-footer">
        <button
          type="button"
          className="player-footer-button"
          onClick={onImport}
          title="从 NewPipe、Google Takeout 或 OPML 文件导入订阅"
        >
          <PlusIcon />
          导入订阅
        </button>
        <button
          type="button"
          className="player-footer-button"
          onClick={onSettings}
        >
          <SettingsIcon />
          设置
        </button>
      </div>
    </aside>
  );
}
