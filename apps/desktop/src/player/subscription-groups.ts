import type { PlayerChannel } from './types';

export interface SubscriptionGroup {
  id: string;
  name: string;
  channelIds: string[];
  color?: string;
  createdAt: number;
}

export const STORAGE_SUBSCRIPTION_GROUPS_KEY =
  'seamind_player_subscription_groups:v1';
export const STORAGE_SUBSCRIPTION_COLLAPSED_KEY =
  'seamind_player_subscription_groups_collapsed:v1';

export const SUBSCRIPTION_GROUP_COLORS = [
  '#df735b', // Terracotta (Accent default)
  '#4a90e2', // Blue
  '#2ecc71', // Green
  '#9b59b6', // Purple
  '#f39c12', // Orange
  '#1abc9c', // Teal
  '#e74c3c', // Crimson
  '#7f8c8d', // Slate
];

const CHANGE_EVENT_NAME = 'seamind:subscription-groups-changed';

export function dispatchSubscriptionGroupsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT_NAME));
  }
}

export function onSubscriptionGroupsChanged(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => callback();
  window.addEventListener(CHANGE_EVENT_NAME, handler);
  window.addEventListener('storage', (e) => {
    if (
      e.key === STORAGE_SUBSCRIPTION_GROUPS_KEY ||
      e.key === STORAGE_SUBSCRIPTION_COLLAPSED_KEY
    ) {
      callback();
    }
  });
  return () => {
    window.removeEventListener(CHANGE_EVENT_NAME, handler);
  };
}

export function loadSubscriptionGroups(): SubscriptionGroup[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_SUBSCRIPTION_GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SubscriptionGroup => {
        return (
          item &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          Array.isArray(item.channelIds)
        );
      })
      .map((item, idx) => ({
        id: item.id,
        name: item.name.trim() || `分组 ${idx + 1}`,
        channelIds: Array.from(new Set(item.channelIds.filter(Boolean))),
        color:
          item.color ||
          SUBSCRIPTION_GROUP_COLORS[idx % SUBSCRIPTION_GROUP_COLORS.length],
        createdAt:
          typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

export function saveSubscriptionGroups(groups: SubscriptionGroup[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      STORAGE_SUBSCRIPTION_GROUPS_KEY,
      JSON.stringify(groups),
    );
    dispatchSubscriptionGroupsChanged();
  } catch {
    // Ignore storage errors
  }
}

export function loadCollapsedGroups(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_SUBSCRIPTION_COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      return new Set(parsed.filter((k): k is string => typeof k === 'string'));
  } catch {
    // Ignore
  }
  return new Set();
}

export function saveCollapsedGroups(collapsed: Set<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      STORAGE_SUBSCRIPTION_COLLAPSED_KEY,
      JSON.stringify(Array.from(collapsed)),
    );
  } catch {
    // Ignore
  }
}

export function createSubscriptionGroup(
  groups: SubscriptionGroup[],
  name: string,
  channelIds: string[] = [],
  color?: string,
): { groups: SubscriptionGroup[]; newGroup: SubscriptionGroup } {
  const trimmed = name.trim();
  const id = `subgroup_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const chosenColor =
    color ||
    SUBSCRIPTION_GROUP_COLORS[groups.length % SUBSCRIPTION_GROUP_COLORS.length];
  const newGroup: SubscriptionGroup = {
    id,
    name: trimmed || `分组 ${groups.length + 1}`,
    channelIds: Array.from(new Set(channelIds)),
    color: chosenColor,
    createdAt: Date.now(),
  };

  // If newly assigned channelIds already exist in other groups, remove them from previous groups
  const nextGroups = groups.map((g) => ({
    ...g,
    channelIds: g.channelIds.filter(
      (cid) => !newGroup.channelIds.includes(cid),
    ),
  }));

  const result = [...nextGroups, newGroup];
  return { groups: result, newGroup };
}

export function renameSubscriptionGroup(
  groups: SubscriptionGroup[],
  groupId: string,
  newName: string,
): SubscriptionGroup[] {
  const trimmed = newName.trim();
  if (!trimmed) return groups;
  return groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g));
}

export function updateSubscriptionGroupColor(
  groups: SubscriptionGroup[],
  groupId: string,
  color: string,
): SubscriptionGroup[] {
  return groups.map((g) => (g.id === groupId ? { ...g, color } : g));
}

export function deleteSubscriptionGroup(
  groups: SubscriptionGroup[],
  groupId: string,
): SubscriptionGroup[] {
  return groups.filter((g) => g.id !== groupId);
}

export function reorderSubscriptionGroups(
  groups: SubscriptionGroup[],
  fromIndex: number,
  toIndex: number,
): SubscriptionGroup[] {
  if (
    fromIndex < 0 ||
    fromIndex >= groups.length ||
    toIndex < 0 ||
    toIndex >= groups.length ||
    fromIndex === toIndex
  ) {
    return groups;
  }
  const next = [...groups];
  const [removed] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed);
  return next;
}

export function setChannelGroup(
  groups: SubscriptionGroup[],
  channelId: string,
  targetGroupId: string | null,
): SubscriptionGroup[] {
  if (!channelId) return groups;

  return groups.map((g) => {
    const isTarget = targetGroupId && g.id === targetGroupId;
    const hasChannel = g.channelIds.includes(channelId);

    if (isTarget && !hasChannel) {
      return { ...g, channelIds: [...g.channelIds, channelId] };
    }
    if (!isTarget && hasChannel) {
      return {
        ...g,
        channelIds: g.channelIds.filter((id) => id !== channelId),
      };
    }
    return g;
  });
}

export function setChannelsInGroup(
  groups: SubscriptionGroup[],
  groupId: string,
  channelIds: string[],
): SubscriptionGroup[] {
  const assigned = new Set(channelIds);
  return groups.map((g) => {
    if (g.id === groupId) {
      return { ...g, channelIds: Array.from(assigned) };
    }
    // Remove these channels from other groups to keep 1:1 clean assignment
    return {
      ...g,
      channelIds: g.channelIds.filter((cid) => !assigned.has(cid)),
    };
  });
}

export function getChannelGroupId(
  groups: SubscriptionGroup[],
  channelId: string,
): string | null {
  for (const g of groups) {
    if (g.channelIds.includes(channelId)) return g.id;
  }
  return null;
}

export interface GroupedChannelsResult {
  grouped: {
    group: SubscriptionGroup;
    channels: PlayerChannel[];
  }[];
  ungrouped: PlayerChannel[];
  totalChannels: number;
}

export function groupChannels(
  channels: PlayerChannel[],
  groups: SubscriptionGroup[],
): GroupedChannelsResult {
  const channelMap = new Map<string, PlayerChannel>();
  for (const c of channels) {
    channelMap.set(c.channelId, c);
  }

  const assignedChannelIds = new Set<string>();

  const grouped = groups.map((group) => {
    const groupChannelsList: PlayerChannel[] = [];
    for (const cid of group.channelIds) {
      const channel = channelMap.get(cid);
      if (channel) {
        groupChannelsList.push(channel);
        assignedChannelIds.add(cid);
      }
    }
    return {
      group,
      channels: groupChannelsList,
    };
  });

  const ungrouped = channels.filter(
    (c) => !assignedChannelIds.has(c.channelId),
  );

  return {
    grouped,
    ungrouped,
    totalChannels: channels.length,
  };
}
