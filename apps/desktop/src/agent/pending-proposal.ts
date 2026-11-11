import type { ReaderActionProposal } from './ReaderActionProposalDialog';
import type {
  FavoritesCategorizationProposal,
  LearningPathProposal,
  NodeEditProposal,
} from './types';

export type PendingCliProposal =
  | {
      kind: 'mindmap';
      requestId: string;
      proposal: NodeEditProposal;
    }
  | {
      kind: 'learning-path';
      requestId: string;
      proposal: LearningPathProposal;
    }
  | {
      kind: 'favorites';
      requestId: string;
      proposal: FavoritesCategorizationProposal;
    }
  | {
      kind: 'reader';
      requestId: string;
      proposal: ReaderActionProposal;
    };
