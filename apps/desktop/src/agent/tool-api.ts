import type { MapDocument, OpenedDocument } from '../library/library';
import type { FeedArticle, FeedChannel } from '../feed/types';
import type {
  FavoriteCategoryColor,
  FavoritesSnapshot,
  LearningPathDetail,
  LearningPathNodeKind,
  LearningPathSummary,
  VideoInput,
} from '../player/types';
import type {
  AgentAnalysisMode,
  ActiveMindmapSnapshot,
  FavoritesCategorizationProposal,
  LearningPathProposal,
  LearningPathProposalMode,
  KnowledgeNoteProposal,
  NodeEditOperation,
  NodeEditProposal,
  ReaderChapterProposal,
} from './types';

export interface ProposeNodeEditInput {
  baseRevision: number;
  nodeId?: string;
  nodePath?: string;
  operation: Exclude<NodeEditOperation, 'add_branch'>;
  text: string;
  rationale: string;
}

export interface ProposeNodeBranchInput {
  baseRevision: number;
  nodeId?: string;
  nodePath?: string;
  analysisMode: AgentAnalysisMode;
  branchMarkdown: string;
  rationale: string;
}

export interface ProposeLearningPathRawNode {
  nodeId: string;
  parentId?: string | null;
  position?: number;
  kind?: LearningPathNodeKind;
  title: string;
  note?: string | null;
  videoUrlOrId?: string | null;
  startSeconds?: number;
  optional?: boolean;
  prerequisiteIds?: string[];
}

export interface ProposeLearningPathInput {
  mode: LearningPathProposalMode;
  pathId?: string;
  title: string;
  description?: string;
  nodes: ProposeLearningPathRawNode[];
  rationale: string;
}

export interface ProposeFavoritesCategorizationInput {
  newCategories?: Array<{
    name: string;
    color?: FavoriteCategoryColor;
  }>;
  assignments: Array<{
    videoId: string;
    categoryName: string;
    note?: string | null;
  }>;
  rationale: string;
}

export interface AgentCapabilities {
  readCurrentFeedArticle?(): Promise<FeedArticle>;
  listFeedSubscriptions?(): Promise<FeedChannel[]>;
  addFeedSubscription?(input: {
    url: string;
    category?: string;
    title?: string;
  }): Promise<FeedChannel>;
  readCurrentEpubChapter?(): Promise<{
    bookKey: string;
    bookTitle: string;
    sectionIndex: number;
    sectionHref: string;
    sectionLabel: string;
    text: string;
    selection: { cfi: string; text: string } | null;
  }>;
  proposeEpubFootnote?(input: {
    selectionCfi: string;
    text: string;
  }): Promise<{ annotationId: string }>;
  readCurrentBookKnowledgeNote?(input?: { chapterTarget?: string }): Promise<{
    bookKey: string;
    bookTitle: string;
    relativePath: string;
    category: string;
    title: string;
    exists: boolean;
    markdown: string;
    isChapterLevel?: boolean;
    chapterLabel?: string;
  }>;
  updateBookKnowledgeNote?(input: {
    content: string;
    mode: 'append' | 'overwrite';
    rationale?: string;
    chapterTarget?: string;
  }): Promise<{
    relativePath: string;
    title: string;
    category: string;
    updated: boolean;
    isChapterLevel?: boolean;
  }>;
  appendBookKnowledgeExcerpt?(input: {
    excerpt: string;
    commentary?: string;
    chapterLabel?: string;
  }): Promise<{
    relativePath: string;
    title: string;
    appended: boolean;
  }>;
  queryBookGalaxy?(): Promise<{
    bookTitle: string;
    totalChapters: number;
    notesCount: number;
    completionPercentage: number;
    currentChapter?: string;
    nodes: Array<{
      id: string;
      label: string;
      kind: string;
      chapterIndex?: string;
      hasNote: boolean;
      notePath?: string;
      isCurrent?: boolean;
    }>;
  }>;
  syncReaderChapter?(input: {
    chapterTarget: string;
    reason?: string;
  }): Promise<{
    synced: boolean;
    targetChapter: string;
    notePath?: string;
  }>;
  getCurrentMindmap(): ActiveMindmapSnapshot;
  searchLibrary(query: string, category?: string): Promise<MapDocument[]>;
  readDocument(relativePath: string): Promise<OpenedDocument>;
  proposeNodeEdit(input: ProposeNodeEditInput): NodeEditProposal;
  proposeNodeBranch(input: ProposeNodeBranchInput): NodeEditProposal;
  searchYouTubeVideos?(query: string, limit?: number): Promise<VideoInput[]>;
  listLearningPaths?(): Promise<LearningPathSummary[]>;
  getLearningPath?(pathId: string): Promise<LearningPathDetail | null>;
  proposeLearningPath?(
    input: ProposeLearningPathInput,
  ): Promise<LearningPathProposal>;
  getFavoritesBoard?(): Promise<FavoritesSnapshot>;
  proposeFavoritesCategorization?(
    input: ProposeFavoritesCategorizationInput,
  ): Promise<FavoritesCategorizationProposal>;
  runPythonSnippet?(input: { code: string }): Promise<Record<string, unknown>>;
  runCSnippet?(input: {
    source: string;
    stdin?: string;
    isCpp?: boolean;
  }): Promise<Record<string, unknown>>;
  listExams?(input?: { bookKey?: string }): Promise<Record<string, unknown>>;
  getExamDetail?(input: { examId: string }): Promise<Record<string, unknown>>;
  listLiteraturePapers?(input?: {
    query?: string;
  }): Promise<Record<string, unknown>>;
  readTerminalPane?(input?: {
    paneIndex?: number;
    maxLines?: number;
  }): Promise<Record<string, unknown>>;
  proposeTerminalCommand?(input: {
    command: string;
    paneIndex: number;
    reason?: string;
  }): Promise<{ queued: boolean; command: string; paneIndex: number }>;
  delegateCliAgent?(input: {
    engine: 'claude' | 'codex' | 'agy';
    prompt: string;
    attachMcp?: boolean;
  }): Promise<Record<string, unknown>>;
}

export interface TerminalCommandProposal {
  command: string;
  paneIndex: number;
  reason: string;
}

export interface AgentToolResult {
  version: 1;
  permission: 'read' | 'user_approval';
  name: string;
  label: string;
  summary: string;
  result: Record<string, unknown>;
  proposal?: NodeEditProposal;
  learningPathProposal?: LearningPathProposal;
  favoritesCategorizationProposal?: FavoritesCategorizationProposal;
  knowledgeNoteProposal?: KnowledgeNoteProposal;
  readerChapterProposal?: ReaderChapterProposal;
  terminalCommandProposal?: TerminalCommandProposal;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  capabilities: AgentCapabilities,
) => Promise<AgentToolResult>;
