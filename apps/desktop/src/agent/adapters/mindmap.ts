import type { MapDocument, OpenedDocument } from '../../library/library';
import type {
  AgentCapabilities,
  ProposeNodeBranchInput,
  ProposeNodeEditInput,
} from '../tool-api';
import type { ActiveMindmapSnapshot, NodeEditProposal } from '../types';

export interface MindmapCapabilityDeps {
  getCurrentMindmap(): ActiveMindmapSnapshot;
  searchLibrary(query: string, category?: string): Promise<MapDocument[]>;
  readDocument(relativePath: string): Promise<OpenedDocument>;
  proposeNodeEdit(input: ProposeNodeEditInput): NodeEditProposal;
  proposeNodeBranch(input: ProposeNodeBranchInput): NodeEditProposal;
}

export function createMindmapCapabilities(
  deps: MindmapCapabilityDeps,
): Pick<
  AgentCapabilities,
  | 'getCurrentMindmap'
  | 'searchLibrary'
  | 'readDocument'
  | 'proposeNodeEdit'
  | 'proposeNodeBranch'
> {
  return {
    getCurrentMindmap: () => deps.getCurrentMindmap(),
    searchLibrary: (query, category) => deps.searchLibrary(query, category),
    readDocument: (relativePath) => deps.readDocument(relativePath),
    proposeNodeEdit: (input) => deps.proposeNodeEdit(input),
    proposeNodeBranch: (input) => deps.proposeNodeBranch(input),
  };
}
