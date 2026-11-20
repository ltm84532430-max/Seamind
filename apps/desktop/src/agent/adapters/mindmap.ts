import type { MapDocument, OpenedDocument } from '../../library/library';
import type {
  AgentCapabilities,
  ProposeCodeBlockInput,
  ProposeNodeBranchInput,
  ProposeNodeEditInput,
  RunMindmapCodeBlockInput,
} from '../tool-api';
import type { ActiveMindmapSnapshot, NodeEditProposal } from '../types';

export interface MindmapCapabilityDeps {
  getCurrentMindmap(): ActiveMindmapSnapshot;
  searchLibrary(query: string, category?: string): Promise<MapDocument[]>;
  readDocument(relativePath: string): Promise<OpenedDocument>;
  proposeNodeEdit(input: ProposeNodeEditInput): NodeEditProposal;
  proposeNodeBranch(input: ProposeNodeBranchInput): NodeEditProposal;
  proposeCodeBlock?(input: ProposeCodeBlockInput): NodeEditProposal;
  runMindmapCodeBlock?(
    input: RunMindmapCodeBlockInput,
  ): Promise<Record<string, unknown>>;
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
  | 'proposeCodeBlock'
  | 'runMindmapCodeBlock'
> {
  return {
    getCurrentMindmap: () => deps.getCurrentMindmap(),
    searchLibrary: (query, category) => deps.searchLibrary(query, category),
    readDocument: (relativePath) => deps.readDocument(relativePath),
    proposeNodeEdit: (input) => deps.proposeNodeEdit(input),
    proposeNodeBranch: (input) => deps.proposeNodeBranch(input),
    ...(deps.proposeCodeBlock
      ? { proposeCodeBlock: (input) => deps.proposeCodeBlock!(input) }
      : {}),
    ...(deps.runMindmapCodeBlock
      ? { runMindmapCodeBlock: (input) => deps.runMindmapCodeBlock!(input) }
      : {}),
  };
}
