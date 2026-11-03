import { useMemo, useState } from 'react';
import Avatar from './Avatar';
import { CloseIcon, PlusIcon } from './icons';
import {
  SUBSCRIPTION_GROUP_COLORS,
  createSubscriptionGroup,
  deleteSubscriptionGroup,
  renameSubscriptionGroup,
  saveSubscriptionGroups,
  setChannelsInGroup,
  updateSubscriptionGroupColor,
} from './subscription-groups';
import type { SubscriptionGroup } from './subscription-groups';
import type { PlayerChannel } from './types';
import './subscription-groups.css';

export default function SubscriptionGroupsModal({
  open,
  channels,
  groups,
  initialGroupId,
  onClose,
  onGroupsChange,
}: {
  open: boolean;
  channels: PlayerChannel[];
  groups: SubscriptionGroup[];
  initialGroupId?: string | null;
  onClose(): void;
  onGroupsChange(next: SubscriptionGroup[]): void;
}) {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(() => {
    if (initialGroupId && groups.some((g) => g.id === initialGroupId)) {
      return initialGroupId;
    }
    return groups[0]?.id ?? null;
  });

  const [newGroupName, setNewGroupName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [channelSearch, setChannelSearch] = useState('');

  // Active group
  const activeGroup = useMemo(() => {
    return groups.find((g) => g.id === selectedGroupId) ?? groups[0] ?? null;
  }, [groups, selectedGroupId]);

  const assignedSet = useMemo(() => {
    return new Set(activeGroup?.channelIds ?? []);
  }, [activeGroup]);

  // Filtered channels in search
  const filteredChannels = useMemo(() => {
    const q = channelSearch.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.handle ?? '').toLowerCase().includes(q),
    );
  }, [channels, channelSearch]);

  if (!open) return null;

  const handleCreateGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const { groups: updated, newGroup } = createSubscriptionGroup(groups, name);
    saveSubscriptionGroups(updated);
    onGroupsChange(updated);
    setSelectedGroupId(newGroup.id);
    setNewGroupName('');
    setIsCreating(false);
  };

  const handleRenameGroup = (groupId: string) => {
    const name = editingName.trim();
    if (!name) {
      setEditingGroupId(null);
      return;
    }
    const updated = renameSubscriptionGroup(groups, groupId, name);
    saveSubscriptionGroups(updated);
    onGroupsChange(updated);
    setEditingGroupId(null);
  };

  const handleDeleteGroup = (groupId: string, groupName: string) => {
    if (
      !window.confirm(
        `确定要删除分组「${groupName}」吗？组内频道将恢复为未分组，不会取消订阅。`,
      )
    ) {
      return;
    }
    const updated = deleteSubscriptionGroup(groups, groupId);
    saveSubscriptionGroups(updated);
    onGroupsChange(updated);
    if (selectedGroupId === groupId) {
      setSelectedGroupId(updated[0]?.id ?? null);
    }
  };

  const handleToggleChannel = (channelId: string) => {
    if (!activeGroup) return;
    const next = new Set(assignedSet);
    if (next.has(channelId)) {
      next.delete(channelId);
    } else {
      next.add(channelId);
    }
    const updated = setChannelsInGroup(
      groups,
      activeGroup.id,
      Array.from(next),
    );
    saveSubscriptionGroups(updated);
    onGroupsChange(updated);
  };

  const handleSelectAll = () => {
    if (!activeGroup) return;
    const allIds = channels.map((c) => c.channelId);
    const updated = setChannelsInGroup(groups, activeGroup.id, allIds);
    saveSubscriptionGroups(updated);
    onGroupsChange(updated);
  };

  const handleClearAll = () => {
    if (!activeGroup) return;
    const updated = setChannelsInGroup(groups, activeGroup.id, []);
    saveSubscriptionGroups(updated);
    onGroupsChange(updated);
  };

  const handleColorChange = (groupId: string, color: string) => {
    const updated = updateSubscriptionGroupColor(groups, groupId, color);
    saveSubscriptionGroups(updated);
    onGroupsChange(updated);
  };

  return (
    <div className="sub-modal-backdrop" onClick={onClose}>
      <div
        className="sub-modal"
        role="dialog"
        aria-labelledby="sub-modal-title"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sub-modal-head">
          <div className="sub-modal-title-wrap">
            <h3 id="sub-modal-title">管理订阅分组</h3>
            <span className="sub-modal-count">
              共 {groups.length} 个分组 · {channels.length} 个订阅
            </span>
          </div>
          <button
            type="button"
            className="sub-modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="sub-modal-body">
          {/* Left panel: groups list */}
          <aside className="sub-modal-sidebar">
            <div className="sub-modal-side-head">
              <span className="sub-modal-label">分组列表</span>
              {!isCreating && (
                <button
                  type="button"
                  className="sub-mini-btn"
                  onClick={() => setIsCreating(true)}
                >
                  <PlusIcon size={12} />
                  新建
                </button>
              )}
            </div>

            {isCreating && (
              <div className="sub-create-row">
                <input
                  type="text"
                  autoFocus
                  className="sub-input"
                  placeholder="分组名称，如：经济金融"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateGroup();
                    if (e.key === 'Escape') setIsCreating(false);
                  }}
                />
                <div className="sub-create-actions">
                  <button
                    type="button"
                    className="sub-btn is-subtle"
                    onClick={() => setIsCreating(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="sub-btn is-subtle is-primary"
                    disabled={!newGroupName.trim()}
                    onClick={handleCreateGroup}
                  >
                    确定
                  </button>
                </div>
              </div>
            )}

            <div className="sub-groups-nav">
              {groups.length === 0 && !isCreating && (
                <p className="sub-empty-hint">暂无分组，点击上方新建分组</p>
              )}
              {groups.map((group) => {
                const isSelected = activeGroup?.id === group.id;
                const isEditing = editingGroupId === group.id;

                return (
                  <div
                    key={group.id}
                    className={`sub-group-row${isSelected ? ' is-selected' : ''}`}
                    onClick={() => {
                      setSelectedGroupId(group.id);
                      setEditingGroupId(null);
                    }}
                  >
                    <span
                      className="sub-color-dot"
                      style={{ background: group.color ?? '#df735b' }}
                      title="点击更换颜色"
                      onClick={(e) => {
                        e.stopPropagation();
                        const nextColorIdx =
                          (SUBSCRIPTION_GROUP_COLORS.indexOf(
                            group.color ?? '#df735b',
                          ) +
                            1) %
                          SUBSCRIPTION_GROUP_COLORS.length;
                        handleColorChange(
                          group.id,
                          SUBSCRIPTION_GROUP_COLORS[nextColorIdx],
                        );
                      }}
                    />

                    {isEditing ? (
                      <input
                        type="text"
                        autoFocus
                        className="sub-edit-input"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => handleRenameGroup(group.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameGroup(group.id);
                          if (e.key === 'Escape') setEditingGroupId(null);
                        }}
                      />
                    ) : (
                      <span className="sub-group-name" title={group.name}>
                        {group.name}
                      </span>
                    )}

                    <span className="sub-group-badge">
                      {group.channelIds.length}
                    </span>

                    <div
                      className="sub-group-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {!isEditing && (
                        <button
                          type="button"
                          className="sub-icon-action"
                          title="重命名"
                          onClick={() => {
                            setEditingGroupId(group.id);
                            setEditingName(group.name);
                          }}
                        >
                          ✎
                        </button>
                      )}
                      <button
                        type="button"
                        className="sub-icon-action is-danger"
                        title="删除分组"
                        onClick={() => handleDeleteGroup(group.id, group.name)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>

          {/* Right panel: channel multi-select assignment */}
          <main className="sub-modal-content">
            {activeGroup ? (
              <>
                <div className="sub-content-head">
                  <div className="sub-content-title">
                    <span
                      className="sub-color-dot"
                      style={{ background: activeGroup.color ?? '#df735b' }}
                    />
                    <h4>{activeGroup.name}</h4>
                    <span className="sub-badge-pill">
                      已包含 {assignedSet.size} 个频道
                    </span>
                  </div>

                  <div className="sub-content-tools">
                    <input
                      type="search"
                      className="sub-filter-input"
                      placeholder="搜索频道..."
                      value={channelSearch}
                      onChange={(e) => setChannelSearch(e.target.value)}
                    />
                    <button
                      type="button"
                      className="sub-btn is-subtle"
                      onClick={handleSelectAll}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="sub-btn is-subtle"
                      onClick={handleClearAll}
                    >
                      清空
                    </button>
                  </div>
                </div>

                <div className="sub-channels-list">
                  {filteredChannels.length === 0 && (
                    <p className="sub-empty-hint">没有匹配的频道</p>
                  )}
                  {filteredChannels.map((channel) => {
                    const isChecked = assignedSet.has(channel.channelId);
                    return (
                      <label
                        key={channel.channelId}
                        className={`sub-channel-item${
                          isChecked ? ' is-checked' : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() =>
                            handleToggleChannel(channel.channelId)
                          }
                        />
                        <Avatar
                          name={channel.name}
                          url={channel.avatarUrl}
                          size={24}
                        />
                        <div className="sub-channel-meta">
                          <span className="sub-channel-title">
                            {channel.name}
                          </span>
                          {channel.handle && (
                            <span className="sub-channel-handle">
                              {channel.handle}
                            </span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="sub-no-group-selected">
                <p>请在左侧选择或新建一个分组进行设置</p>
              </div>
            )}
          </main>
        </div>

        <footer className="sub-modal-foot">
          <button
            type="button"
            className="sub-btn is-primary"
            onClick={onClose}
          >
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}
