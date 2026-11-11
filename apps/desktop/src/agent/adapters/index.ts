import type { AgentCapabilities } from '../tool-api';
import { createFeedCapabilities, type FeedCapabilityDeps } from './feed';
import {
  createMindmapCapabilities,
  type MindmapCapabilityDeps,
} from './mindmap';
import { createPlayerCapabilities, type PlayerCapabilityDeps } from './player';
import { createReaderCapabilities, type ReaderCapabilityDeps } from './reader';

export interface AgentCapabilityHosts {
  feed: FeedCapabilityDeps;
  reader: ReaderCapabilityDeps;
  mindmap: MindmapCapabilityDeps;
  player: PlayerCapabilityDeps;
}

export function createAgentCapabilities(
  hosts: AgentCapabilityHosts,
): AgentCapabilities {
  return {
    ...createFeedCapabilities(hosts.feed),
    ...createReaderCapabilities(hosts.reader),
    ...createMindmapCapabilities(hosts.mindmap),
    ...createPlayerCapabilities(hosts.player),
  };
}
