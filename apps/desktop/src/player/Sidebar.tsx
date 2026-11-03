import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  FormEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import Avatar from './Avatar';
import SubscriptionGroupsModal from './SubscriptionGroupsModal';
import type { PlayerView } from './host';
import {
  CheckIcon,
  ClockIcon,
  CourseIcon,
  FeedIcon,
  HistoryIcon,
  PathTreeIcon,
  PlusIcon,
  SettingsIcon,
  StarIcon,
  WarningIcon,
} from './icons';
import { playerApi } from './player-api';
import { sortChannels } from './queue';
import {
  deleteSubscriptionGroup,
  groupChannels,
  loadCollapsedGroups,
  loadSubscriptionGroups,
  onSubscriptionGroupsChanged,
  saveCollapsedGroups,
  saveSubscriptionGroups,
  setChannelGroup,
} from './subscription-groups';
import type { SubscriptionGroup } from './subscription-groups';
import { FAVORITES_ID, WATCH_LATER_ID } from './types';
import type {
  LearningPathSummary,
  PlayerChannel,
  PlayerPlaylist,
} from './types';
import { SLOW_LOOKUP_TEXT, useSlowHint } from './use-slow-hint';
import './subscription-groups.css';

/** More subscriptions than this get a box to filter them by name. */
const FILTER_FROM = 10;

function isCurrent(view: PlayerView, other: PlayerView): boolean {
  if (view.kind !== other.kind) return false;
  if (view.kind === 'course' && other.kind === 'course')
    return view.playlistId === other.playlistId;
  if (view.kind === 'channel' && other.kind === 'channel')
    return view.channelId === other.channelId;
  if (view.kind === 'learning-path' && other.kind === 'learning-path')
    return view.pathId === other.pathId;
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
  learningPaths,
  opening,
  openError,
  onGo,
  onOpenLink,
  onImport,
  onSettings,
  onRefreshOverview,
  collapsed,
  onToggleCollapse,
}: {
  view: PlayerView;
  channels: PlayerChannel[];
  playlists: PlayerPlaylist[];
  learningPaths: LearningPathSummary[];
  /** A pasted link is being looked up. */
  opening: boolean;
  openError: string;
  onGo(view: PlayerView): void;
  /** Resolves to whether the link led somewhere, in which case the box is emptied. */
  onOpenLink(text: string): Promise<boolean>;
  onImport(): void;
  onSettings(): void;
  onRefreshOverview?: () => Promise<void> | void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [link, setLink] = useState('');
  const [filter, setFilter] = useState('');
  const slowOpen = useSlowHint(opening);

  // Subscription grouping state
  const [groups, setGroups] = useState<SubscriptionGroup[]>(() =>
    loadSubscriptionGroups(),
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    loadCollapsedGroups(),
  );
  const [groupsModalOpen, setGroupsModalOpen] = useState(false);
  const [initialModalGroupId, setInitialModalGroupId] = useState<string | null>(
    null,
  );

  // Popup menus
  const [channelMenu, setChannelMenu] = useState<{
    channelId: string;
    channelName: string;
    hasError?: boolean;
    x: number;
    y: number;
  } | null>(null);

  const [groupMenu, setGroupMenu] = useState<{
    group: SubscriptionGroup;
    x: number;
    y: number;
  } | null>(null);

  // Drag and drop state
  const [draggedChannelId, setDraggedChannelId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);

  // Subscribe to changes in other components/tabs
  useEffect(() => {
    return onSubscriptionGroupsChanged(() => {
      setGroups(loadSubscriptionGroups());
      setCollapsedGroups(loadCollapsedGroups());
    });
  }, []);

  // Close popup menus on click outside or escape
  useEffect(() => {
    if (!channelMenu && !groupMenu) return;
    const handleClick = () => {
      setChannelMenu(null);
      setGroupMenu(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setChannelMenu(null);
        setGroupMenu(null);
      }
    };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [channelMenu, groupMenu]);

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      saveCollapsedGroups(next);
      return next;
    });
  }, []);

  const sorted = useMemo(() => sortChannels(channels), [channels]);
  const courses = playlists.filter((playlist) => playlist.kind === 'course');
  const count = (id: string) =>
    playlists.find((playlist) => playlist.playlistId === id)?.itemCount;

  // Filter channels if filter query is present
  const filterQuery = filter.trim().toLowerCase();
  const filteredChannels = useMemo(() => {
    if (!filterQuery) return sorted;
    return sorted.filter(
      (c) =>
        c.name.toLowerCase().includes(filterQuery) ||
        (c.handle ?? '').toLowerCase().includes(filterQuery),
    );
  }, [sorted, filterQuery]);

  // Group channels according to user defined groups
  const groupedData = useMemo(() => {
    return groupChannels(filteredChannels, groups);
  }, [filteredChannels, groups]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!link.trim() || opening) return;
    if (await onOpenLink(link)) setLink('');
  };

  const handleChannelMenuOpen = (
    e: ReactMouseEvent,
    channel: PlayerChannel,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setGroupMenu(null);
    setChannelMenu({
      channelId: channel.channelId,
      channelName: channel.name,
      hasError: Boolean(channel.lastError),
      x: rect.right + 4,
      y: Math.min(rect.top, window.innerHeight - 240),
    });
  };

  const handleClearChannelError = async (channelId: string) => {
    try {
      await playerApi.clearChannelErrors(channelId);
      setChannelMenu(null);
      await onRefreshOverview?.();
    } catch (err) {
      console.error('Failed to clear channel error', err);
    }
  };

  const handleClearAllErrors = async () => {
    try {
      await playerApi.clearChannelErrors();
      await onRefreshOverview?.();
    } catch (err) {
      console.error('Failed to clear all errors', err);
    }
  };

  const handleGroupMenuOpen = (
    e: ReactMouseEvent,
    group: SubscriptionGroup,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setChannelMenu(null);
    setGroupMenu({
      group,
      x: rect.right + 4,
      y: Math.min(rect.top, window.innerHeight - 180),
    });
  };

  const handleAssignChannel = (
    channelId: string,
    targetGroupId: string | null,
  ) => {
    const nextGroups = setChannelGroup(groups, channelId, targetGroupId);
    setGroups(nextGroups);
    saveSubscriptionGroups(nextGroups);
    setChannelMenu(null);
  };

  const handleDeleteGroupFromMenu = (groupId: string, name: string) => {
    if (
      !window.confirm(
        `确定要删除分组「${name}」吗？组内频道将恢复为未分组，不会取消订阅。`,
      )
    ) {
      return;
    }
    const nextGroups = deleteSubscriptionGroup(groups, groupId);
    setGroups(nextGroups);
    saveSubscriptionGroups(nextGroups);
    setGroupMenu(null);
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, channelId: string) => {
    e.dataTransfer.setData('text/plain', channelId);
    e.dataTransfer.setData('application/seamind-channel-id', channelId);
    setDraggedChannelId(channelId);
  };

  const handleDragEnd = () => {
    setDraggedChannelId(null);
    setDragOverGroupId(null);
  };

  const handleDropOnGroup = (
    e: React.DragEvent,
    targetGroupId: string | null,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const channelId =
      e.dataTransfer.getData('application/seamind-channel-id') ||
      e.dataTransfer.getData('text/plain') ||
      draggedChannelId;
    handleDragEnd();
    if (channelId) {
      handleAssignChannel(channelId, targetGroupId);
    }
  };

  const renderChannelButton = (channel: PlayerChannel) => {
    const current = isCurrent(view, {
      kind: 'channel',
      channelId: channel.channelId,
    });
    const isDragging = draggedChannelId === channel.channelId;

    return (
      <button
        key={channel.channelId}
        type="button"
        draggable
        onDragStart={(e) => handleDragStart(e, channel.channelId)}
        onDragEnd={handleDragEnd}
        className={`player-nav-item is-channel${current ? ' is-current' : ''}${
          isDragging ? ' is-dragging' : ''
        }`}
        aria-current={current ? 'page' : undefined}
        title={
          channel.lastError
            ? `${channel.name}\n上次动态同步提示：${channel.lastError}\n点击右侧菜单可清除此提示`
            : channel.name
        }
        onClick={() => onGo({ kind: 'channel', channelId: channel.channelId })}
      >
        <Avatar name={channel.name} url={channel.avatarUrl} size={22} />
        <span className="player-nav-label">{channel.name}</span>
        {channel.lastError && (
          <span className="player-nav-warning" aria-label="动态同步提示">
            <WarningIcon />
          </span>
        )}
        <span
          className="player-nav-channel-menu-btn"
          title="设置分组"
          aria-label="设置分组"
          onClick={(e) => handleChannelMenuOpen(e, channel)}
        >
          ···
        </span>
      </button>
    );
  };

  return (
    <>
      <aside
        className={`player-sidebar${collapsed ? ' is-collapsed' : ''}`}
        aria-label="播放器导航"
        aria-expanded={!collapsed}
      >
        <div className="player-sidebar-header">
          {!collapsed ? (
            <form
              className="player-open"
              onSubmit={(event) => void submit(event)}
            >
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
              {onToggleCollapse && (
                <button
                  type="button"
                  className="player-sidebar-collapse-btn"
                  onClick={onToggleCollapse}
                  title="收起侧边栏 (快捷键 Ctrl+B)"
                  aria-label="收起侧边栏"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="13"
                    height="13"
                    aria-hidden="true"
                  >
                    <path
                      d="M10 3L5 8l5 5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </form>
          ) : (
            onToggleCollapse && (
              <button
                type="button"
                className="player-sidebar-collapse-btn is-collapsed"
                onClick={onToggleCollapse}
                title="展开侧边栏 (快捷键 Ctrl+B)"
                aria-label="展开侧边栏"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  aria-hidden="true"
                >
                  <path
                    d="M6 3l5 5-5 5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )
          )}
        </div>

        <div className="player-sidebar-body">
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
              badge={
                count(FAVORITES_ID) ? String(count(FAVORITES_ID)) : undefined
              }
              onGo={onGo}
            />
            <NavItem
              view={view}
              target={{ kind: 'watch-later' }}
              icon={<ClockIcon />}
              label="稍后看"
              badge={
                count(WATCH_LATER_ID)
                  ? String(count(WATCH_LATER_ID))
                  : undefined
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

            <h3 className="player-nav-heading">学习路径</h3>
            <NavItem
              view={view}
              target={{ kind: 'learning-paths-home' }}
              icon={<PathTreeIcon />}
              label="全部路径"
              badge={
                learningPaths.length ? String(learningPaths.length) : undefined
              }
              onGo={onGo}
            />
            {learningPaths.map((path) => (
              <NavItem
                key={path.pathId}
                view={view}
                target={{ kind: 'learning-path', pathId: path.pathId }}
                icon={<PathTreeIcon />}
                label={path.title}
                badge={`${path.finishedCount}/${path.videoCount}`}
                onGo={onGo}
              />
            ))}

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

            {/* ---- Subscriptions Section with Grouping ---- */}
            <div className="player-nav-heading-row">
              <h3 className="player-nav-heading">
                订阅
                {channels.length > 0 && (
                  <span className="player-nav-count">{channels.length}</span>
                )}
              </h3>
              <div className="player-sub-header-actions">
                {channels.some((c) => Boolean(c.lastError)) && (
                  <button
                    type="button"
                    className="player-sub-header-btn is-clear-errors"
                    title="部分频道上次动态同步受限，点击一键清除所有警告标记"
                    aria-label="清除所有警告"
                    onClick={handleClearAllErrors}
                  >
                    <CheckIcon size={11} />
                    <span>重置提示</span>
                  </button>
                )}
                <button
                  type="button"
                  className="player-sub-header-btn"
                  title="新建分组"
                  aria-label="新建分组"
                  onClick={() => {
                    setInitialModalGroupId(null);
                    setGroupsModalOpen(true);
                  }}
                >
                  <PlusIcon size={11} />
                  <span>分组</span>
                </button>
                <button
                  type="button"
                  className="player-sub-header-btn is-icon-only"
                  title="管理订阅分组"
                  aria-label="管理订阅分组"
                  onClick={() => {
                    setInitialModalGroupId(null);
                    setGroupsModalOpen(true);
                  }}
                >
                  <SettingsIcon />
                </button>
              </div>
            </div>

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

            {/* If groups exist, render grouped sections */}
            {groups.length > 0 ? (
              <>
                {groupedData.grouped.map(({ group, channels: groupItems }) => {
                  const isCollapsed = collapsedGroups.has(group.id);
                  const isDropActive = dragOverGroupId === group.id;

                  // If filtering and no items match in this group, hide it
                  if (filterQuery && groupItems.length === 0) return null;

                  return (
                    <div key={group.id} className="player-sub-group-section">
                      <div
                        className={`player-sub-group-head${
                          isCollapsed ? ' is-collapsed' : ''
                        }${isDropActive ? ' is-drop-active' : ''}`}
                        onClick={() => toggleGroupCollapse(group.id)}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDragOverGroupId(group.id);
                        }}
                        onDragLeave={() => {
                          if (dragOverGroupId === group.id)
                            setDragOverGroupId(null);
                        }}
                        onDrop={(e) => handleDropOnGroup(e, group.id)}
                      >
                        <span className="player-sub-group-chevron">▼</span>
                        <span
                          className="player-sub-group-dot"
                          style={{ background: group.color ?? '#df735b' }}
                        />
                        <span
                          className="player-sub-group-name"
                          title={group.name}
                        >
                          {group.name}
                        </span>
                        <span className="player-sub-group-count">
                          {groupItems.length}
                        </span>
                        <button
                          type="button"
                          className="player-sub-group-menu-btn"
                          title="分组选项"
                          aria-label="分组选项"
                          onClick={(e) => handleGroupMenuOpen(e, group)}
                        >
                          ···
                        </button>
                      </div>

                      {!isCollapsed && groupItems.map(renderChannelButton)}
                    </div>
                  );
                })}

                {/* Ungrouped Section */}
                {groupedData.ungrouped.length > 0 && (
                  <div className="player-sub-group-section">
                    <div
                      className={`player-sub-group-head${
                        collapsedGroups.has('__ungrouped__')
                          ? ' is-collapsed'
                          : ''
                      }${dragOverGroupId === '__ungrouped__' ? ' is-drop-active' : ''}`}
                      onClick={() => toggleGroupCollapse('__ungrouped__')}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverGroupId('__ungrouped__');
                      }}
                      onDragLeave={() => {
                        if (dragOverGroupId === '__ungrouped__')
                          setDragOverGroupId(null);
                      }}
                      onDrop={(e) => handleDropOnGroup(e, null)}
                    >
                      <span className="player-sub-group-chevron">▼</span>
                      <span className="player-sub-group-name">未分组</span>
                      <span className="player-sub-group-count">
                        {groupedData.ungrouped.length}
                      </span>
                    </div>

                    {!collapsedGroups.has('__ungrouped__') &&
                      groupedData.ungrouped.map(renderChannelButton)}
                  </div>
                )}
              </>
            ) : (
              /* Flat channels list when no groups configured */
              filteredChannels.map(renderChannelButton)
            )}

            {channels.length > 0 && filteredChannels.length === 0 && (
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
        </div>
      </aside>

      {/* Channel Group Assignment Popup Menu */}
      {channelMenu && (
        <div
          className="player-popup-menu"
          style={{ top: channelMenu.y, left: channelMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="player-popup-header">移动到分组</div>
          {groups.map((g) => {
            const isAssigned = g.channelIds.includes(channelMenu.channelId);
            return (
              <button
                key={g.id}
                type="button"
                className={`player-popup-item${isAssigned ? ' is-active' : ''}`}
                onClick={() =>
                  handleAssignChannel(
                    channelMenu.channelId,
                    isAssigned ? null : g.id,
                  )
                }
              >
                <span
                  className="sub-color-dot"
                  style={{ background: g.color ?? '#df735b' }}
                />
                <span style={{ flex: 1 }}>{g.name}</span>
                {isAssigned && <span>✓</span>}
              </button>
            );
          })}
          {groups.length > 0 && <div className="player-popup-divider" />}
          <button
            type="button"
            className="player-popup-item"
            onClick={() => handleAssignChannel(channelMenu.channelId, null)}
          >
            移出分组 (设为未分组)
          </button>
          <button
            type="button"
            className="player-popup-item"
            onClick={() => {
              setChannelMenu(null);
              setInitialModalGroupId(null);
              setGroupsModalOpen(true);
            }}
          >
            + 管理与新建分组…
          </button>
          {channelMenu.hasError && (
            <>
              <div className="player-popup-divider" />
              <button
                type="button"
                className="player-popup-item"
                style={{ color: 'var(--player-accent, #df735b)' }}
                onClick={() => handleClearChannelError(channelMenu.channelId)}
              >
                清除同步提示标记
              </button>
            </>
          )}
        </div>
      )}

      {/* Group Options Popup Menu */}
      {groupMenu && (
        <div
          className="player-popup-menu"
          style={{ top: groupMenu.y, left: groupMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="player-popup-header">{groupMenu.group.name}</div>
          <button
            type="button"
            className="player-popup-item"
            onClick={() => {
              const gid = groupMenu.group.id;
              setGroupMenu(null);
              setInitialModalGroupId(gid);
              setGroupsModalOpen(true);
            }}
          >
            管理频道 ({groupMenu.group.channelIds.length})
          </button>
          <button
            type="button"
            className="player-popup-item"
            onClick={() => {
              const newName = window.prompt(
                '请输入新分组名称：',
                groupMenu.group.name,
              );
              if (newName && newName.trim()) {
                const next = groups.map((g) =>
                  g.id === groupMenu.group.id
                    ? { ...g, name: newName.trim() }
                    : g,
                );
                setGroups(next);
                saveSubscriptionGroups(next);
              }
              setGroupMenu(null);
            }}
          >
            重命名分组
          </button>
          <div className="player-popup-divider" />
          <button
            type="button"
            className="player-popup-item is-danger"
            style={{ color: 'var(--player-danger, #df5042)' }}
            onClick={() =>
              handleDeleteGroupFromMenu(
                groupMenu.group.id,
                groupMenu.group.name,
              )
            }
          >
            删除此分组
          </button>
        </div>
      )}

      {/* Subscription Groups Management Modal */}
      <SubscriptionGroupsModal
        open={groupsModalOpen}
        channels={channels}
        groups={groups}
        initialGroupId={initialModalGroupId}
        onClose={() => setGroupsModalOpen(false)}
        onGroupsChange={(next) => setGroups(next)}
      />
    </>
  );
}
