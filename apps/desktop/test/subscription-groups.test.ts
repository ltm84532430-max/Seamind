import { describe, expect, it } from 'vitest';
import {
  createSubscriptionGroup,
  deleteSubscriptionGroup,
  getChannelGroupId,
  groupChannels,
  renameSubscriptionGroup,
  reorderSubscriptionGroups,
  setChannelGroup,
  setChannelsInGroup,
  updateSubscriptionGroupColor,
} from '../src/player/subscription-groups';
import type { SubscriptionGroup } from '../src/player/subscription-groups';
import type { PlayerChannel } from '../src/player/types';

const mockChannels: PlayerChannel[] = [
  {
    channelId: 'ch_econ',
    name: 'Economics Explained',
    handle: '@EconomicsExplained',
    avatarUrl: null,
    description: null,
    subscribedAt: 1000,
    lastCheckedAt: 2000,
    lastError: null,
  },
  {
    channelId: 'ch_fcc',
    name: 'freeCodeCamp.org',
    handle: '@freecodecamp',
    avatarUrl: null,
    description: null,
    subscribedAt: 1100,
    lastCheckedAt: 2000,
    lastError: null,
  },
  {
    channelId: 'ch_history',
    name: 'HISTORY',
    handle: '@history',
    avatarUrl: null,
    description: null,
    subscribedAt: 1200,
    lastCheckedAt: 2000,
    lastError: null,
  },
];

describe('Subscription Groups Logic', () => {
  it('creates subscription group and assigns channels', () => {
    const initial: SubscriptionGroup[] = [];
    const { groups, newGroup } = createSubscriptionGroup(initial, '经济金融', [
      'ch_econ',
    ]);
    expect(groups).toHaveLength(1);
    expect(newGroup.name).toBe('经济金融');
    expect(newGroup.channelIds).toEqual(['ch_econ']);
  });

  it('renames a subscription group', () => {
    const { groups, newGroup } = createSubscriptionGroup([], '旧名称');
    const updated = renameSubscriptionGroup(groups, newGroup.id, '新名称');
    expect(updated[0].name).toBe('新名称');
  });

  it('deletes a subscription group', () => {
    const { groups, newGroup } = createSubscriptionGroup([], '待删除');
    const updated = deleteSubscriptionGroup(groups, newGroup.id);
    expect(updated).toHaveLength(0);
  });

  it('updates color', () => {
    const { groups, newGroup } = createSubscriptionGroup([], '测试颜色');
    const updated = updateSubscriptionGroupColor(
      groups,
      newGroup.id,
      '#4a90e2',
    );
    expect(updated[0].color).toBe('#4a90e2');
  });

  it('moves channel between groups cleanly', () => {
    const g1 = createSubscriptionGroup([], '组1', ['ch_econ']);
    const g2 = createSubscriptionGroup(g1.groups, '组2', ['ch_fcc']);
    let current = g2.groups;

    expect(getChannelGroupId(current, 'ch_econ')).toBe(current[0].id);

    // Move ch_econ to group 2
    current = setChannelGroup(current, 'ch_econ', current[1].id);
    expect(getChannelGroupId(current, 'ch_econ')).toBe(current[1].id);
    expect(current[0].channelIds).toEqual([]);
    expect(current[1].channelIds).toContain('ch_econ');

    // Remove ch_econ from all groups (ungrouped)
    current = setChannelGroup(current, 'ch_econ', null);
    expect(getChannelGroupId(current, 'ch_econ')).toBeNull();
    expect(current[1].channelIds).not.toContain('ch_econ');
  });

  it('batch assigns channels to group with setChannelsInGroup', () => {
    const g1 = createSubscriptionGroup([], '组1', ['ch_econ']);
    const g2 = createSubscriptionGroup(g1.groups, '组2', ['ch_fcc']);
    let current = g2.groups;

    current = setChannelsInGroup(current, current[0].id, ['ch_econ', 'ch_fcc']);
    expect(current[0].channelIds).toEqual(['ch_econ', 'ch_fcc']);
    // ch_fcc should be removed from group 2
    expect(current[1].channelIds).toEqual([]);
  });

  it('reorders subscription groups', () => {
    const g1 = createSubscriptionGroup([], 'A');
    const g2 = createSubscriptionGroup(g1.groups, 'B');
    const g3 = createSubscriptionGroup(g2.groups, 'C');

    const reordered = reorderSubscriptionGroups(g3.groups, 0, 2);
    expect(reordered.map((g) => g.name)).toEqual(['B', 'C', 'A']);
  });

  it('correctly partitions channels into grouped and ungrouped buckets', () => {
    const { groups } = createSubscriptionGroup([], '技术', ['ch_fcc']);
    const result = groupChannels(mockChannels, groups);

    expect(result.grouped).toHaveLength(1);
    expect(result.grouped[0].group.name).toBe('技术');
    expect(result.grouped[0].channels).toHaveLength(1);
    expect(result.grouped[0].channels[0].channelId).toBe('ch_fcc');

    expect(result.ungrouped).toHaveLength(2);
    expect(result.ungrouped.map((c) => c.channelId)).toEqual([
      'ch_econ',
      'ch_history',
    ]);
    expect(result.totalChannels).toBe(3);
  });
});
