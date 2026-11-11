import { buildFavoritesCategorizationProposal } from '../../player/FavoritesProposalDialog';
import type {
  FavoritesSnapshot,
  LearningPathDetail,
  LearningPathSummary,
  VideoInput,
} from '../../player/types';
import { searchYouTubeVideos } from '../../player/youtube-data';
import type {
  AgentCapabilities,
  ProposeFavoritesCategorizationInput,
  ProposeLearningPathInput,
} from '../tool-api';
import type { LearningPathProposal } from '../types';

export interface PlayerCapabilityDeps {
  rememberYouTubeVideo(video: VideoInput): void;
  listLearningPaths(): Promise<LearningPathSummary[]>;
  getLearningPath(pathId: string): Promise<LearningPathDetail | null>;
  proposeLearningPath(
    input: ProposeLearningPathInput,
  ): Promise<LearningPathProposal>;
  getFavoritesBoard(): Promise<FavoritesSnapshot>;
}

export function createPlayerCapabilities(
  deps: PlayerCapabilityDeps,
): Pick<
  AgentCapabilities,
  | 'searchYouTubeVideos'
  | 'listLearningPaths'
  | 'getLearningPath'
  | 'proposeLearningPath'
  | 'getFavoritesBoard'
  | 'proposeFavoritesCategorization'
> {
  return {
    searchYouTubeVideos: async (query, limit) => {
      const videos = await searchYouTubeVideos(query, limit);
      for (const video of videos) deps.rememberYouTubeVideo(video);
      return videos;
    },
    listLearningPaths: () => deps.listLearningPaths(),
    getLearningPath: (pathId) => deps.getLearningPath(pathId),
    proposeLearningPath: (input) => deps.proposeLearningPath(input),
    getFavoritesBoard: () => deps.getFavoritesBoard(),
    proposeFavoritesCategorization: async (
      input: ProposeFavoritesCategorizationInput,
    ) => {
      const snapshot = await deps.getFavoritesBoard();
      return buildFavoritesCategorizationProposal(snapshot, input);
    },
  };
}
