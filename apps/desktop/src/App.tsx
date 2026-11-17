import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import InstallerComponentSetup from './system/InstallerComponentSetup';
import UpdateManager from './system/UpdateManager';
import katex from 'katex';
import markdownItKatex from '@vscode/markdown-it-katex';
import { Transformer } from 'markmap-lib';
import { pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import type { PureNode } from 'markmap-lib';
import { Markmap } from 'markmap-view';
import type { Markmap as MarkmapInstance } from 'markmap-view';
import {
  hydrateCodeBlocks,
  updateMarkdownCodeFence,
  updateMarkdownCodeFenceAtRange,
} from './workbench/code-blocks';
import type { CodeBlockSourceRange } from './workbench/code-blocks';
import MarkdownEditor from './workbench/MarkdownEditor';
import type {
  MarkdownEditorHandle,
  MarkdownSelection,
} from './workbench/MarkdownEditor';
import MarkdownPreview from './workbench/MarkdownPreview';
import type { PreviewFootnoteJumpRequest } from './workbench/MarkdownPreview';
import {
  appendEpubFootnoteToMarkdown,
  enhanceMarkdownFootnotesHtml,
  parseMarkdownFootnotes,
} from './workbench/markdown-footnotes';
import KnowledgeWorkspace, {
  readKnowledgeSidebarCollapsed,
  readKnowledgeSidebarWidth,
} from './knowledge/KnowledgeWorkspace';
import {
  findWikilinkTarget,
  type KnowledgeNoteTemplate,
} from './knowledge/knowledge-markdown';
import PlantUmlWorkspace, {
  openPlantUmlWorkspace,
  plantUmlWorkspaceEventName,
} from './mindmap/PlantUmlWorkspace';
import type { PlantUmlEditorRequest } from './mindmap/PlantUmlWorkspace';
import DocumentWorkbench from './workbench/DocumentWorkbench';
import { useActiveDocument } from './workbench/use-active-document';
import { NEW_FILE_TEMPLATES } from './workbench/templates';
import type { NewFileKind } from './workbench/templates';
import {
  buildYouTubeEmbedUrl,
  nextYouTubeThumbnail,
  parseYouTubeEmbedInput,
  prepareYouTubeCards,
} from './player/youtube';
import YouTubePlayerDialog from './player/YouTubePlayerDialog';
import type { YouTubePreviewSelection } from './player/YouTubePlayerDialog';
import { installYouTubeDebugHook } from './player/youtube-debug';
import 'katex/dist/katex.min.css';
import LibraryPanel from './library/LibraryPanel';
import { libraryApi } from './library/library-api';
import { epubApi } from './ebook/epub-api';
import { terminalApi } from './terminal/terminal-api';
import { openStandaloneTerminalWindow } from './terminal/terminal-window';
import ExamCenterWorkspace from './exams/ExamCenterWorkspace';
import MindmapMiniTree from './mindmap/MindmapMiniTree';
import type { MindmapMiniTreeNode } from './mindmap/MindmapMiniTree';
import './ebook/ebook-workspace.css';
import './player/player-workspace.css';
import './player/learning-path.css';
import type { PendingTerminalRawInput } from './system/TerminalPanel';
import type {
  EpubChapterChangeInfo,
  EpubChapterNavigationRequest,
  EpubReaderAgentBridge,
  EpubReaderSelection,
} from './ebook/EpubReader';
import {
  epubBookIdentity,
  epubProgressKey,
  findLibraryEpubForTask,
  findStoredCoverByBookKey,
  loadEpubAnnotations,
  loadEpubBookMetadata,
  sameEpubProgressFile,
  type EpubAnnotation,
} from './ebook/ebook-storage';
import AgentPanel from './agent/AgentPanel';
import { agentApi } from './agent/agent-api';
import { createAgentCapabilities } from './agent/adapters';
import {
  agentToolCatalogForWorkspace,
  executeAgentTool,
  mcpToolSpecs,
} from './agent/capabilities';
import type { PendingCliProposal } from './agent/pending-proposal';
import type {
  AgentCapabilities,
  ProposeLearningPathInput,
  ProposeNodeEditInput,
} from './agent/capabilities';
import type {
  ActiveMindmapSnapshot,
  AgentAnalysisMode,
  NodeEditProposal,
  LearningPathProposal,
} from './agent/types';
import {
  buildAgentNodeBranchProposal,
  buildAgentNodeEditProposal,
  buildLearningPathProposal,
  readAgentMindmap,
} from './agent/proposals';
import ReaderActionProposalDialog from './agent/ReaderActionProposalDialog';
import FavoritesProposalDialog, {
  applyFavoritesCategorizationProposal,
} from './player/FavoritesProposalDialog';
import LearningPathProposalDialog from './player/LearningPathProposalDialog';
import { playerApi } from './player/player-api';
import type { VideoInput } from './player/types';
import type { PlayerExportedDocument } from './player/PlayerNotePanel';
import {
  sanitizeTranscriptNoteTitle,
  type TranscriptKnowledgeExportPayload,
  type TranscriptKnowledgeExportResult,
} from './player/transcript/export';

import {
  applyMarkdownNodeCommand,
  buildMarkdownNodeSourceMap,
  findSourcePathForLine,
  getMarkdownNodeNote,
  MAX_MARKDOWN_NODE_NOTE_CHARS,
  markdownBody,
  markdownForMindmap,
  normalizeMindmapText,
  type MarkdownNodeSource,
} from './mindmap/commands';
const TerminalPanel = lazy(() => import('./system/TerminalPanel'));
const EpubReader = lazy(() => import('./ebook/EpubReader'));
const EbookWorkspace = lazy(() => import('./ebook/EbookWorkspace'));
const PlayerWorkspace = lazy(() => import('./player/PlayerWorkspace'));
const TaskWorkspace = lazy(() => import('./tasks/TaskWorkspace'));
import type { TaskCreateRequest } from './tasks/TaskWorkspace';
import type { TaskResource } from './tasks/types';
import { formatBadgeCount } from './tasks/habit-list-model';
import { usePendingHabitCount } from './tasks/usePendingHabitCount';
const LiteratureWorkspace = lazy(
  () => import('./literature/LiteratureWorkspace'),
);
const FeedWorkspace = lazy(() => import('./feed/FeedWorkspace'));
import { FeedAudioProvider, useFeedAudio } from './feed/FeedAudioEngine';
import type { FeedArticle } from './feed/types';
import {
  GlobalMediaProvider,
  useGlobalMedia,
  useIsVideoStageOffscreen,
} from './media/global-media-store';
import { TopbarMiniPlayer } from './media/TopbarMiniPlayer';
const TerminalWorkspace = lazy(() => import('./terminal/TerminalWorkspace'));
import type {
  DocumentVersion,
  DocumentVersionSnapshot,
  EpubBookDocument,
  LibrarySnapshot,
  MapDocument,
  PlantUmlDocument,
  SaveDocumentInput,
  TextDocument,
} from './library/library';

import {
  ACTIVE_WORKSPACE_KEY,
  LAST_READER_BOOK_KEY,
  RECOVERABLE_DRAFT_KEY,
  TERMINAL_HEIGHT_KEY,
  settingsStorageKey,
  themeStorageKey,
  mindmapStyleStorageKey,
  nodeSpacingStorageKey,
  aiCollapsedStorageKey,
  defaultNodeSpacing,
  DEFAULT_READER_SPLIT_LAYOUT,
  mindmapStyles,
  readTerminalHeight,
  readActiveWorkspace,
  readerSplitLayoutKey,
  readReaderSplitLayout,
  readRecoverableDraft,
  readProviderSettings,
  readTheme,
  readMindmapStyle,
  readNodeSpacing,
  readAiCollapsed,
  isEpubPath,
  normalizeLibraryPath,
  saveEpubMindmapPath,
  resolveBookMindmapTarget,
  saveEpubKnowledgePath,
  resolveBookKnowledgeTarget,
  createDraft,
  type ActiveWorkspace,
  type EditorDraft,
  type MindmapStyle,
  type NodeSpacing,
  type ProviderSettings,
  type ReaderSplitLayout,
  type RecoverableDraft,
  type Theme,
} from './app/app-storage';
import {
  clonePureNode,
  findNavigationPath,
  findPureNodeBySourcePath,
  prepareMindmapTree,
} from './library/app-tree-utils';
import {
  createBookKnowledgeStarter,
  createChapterKnowledgeStarter,
  resolveBookChapterKnowledgeTarget,
} from './ebook/book-knowledge-target';
import { bookMindmapTitle } from './ebook/book-mindmap-target';
import { BookGalaxyGraphView } from './ebook/BookGalaxyGraphView';
import {
  buildBookGalaxyGraph,
  type GalaxyNode,
} from './ebook/book-galaxy-model';
import {
  addMarkdownNodeNoteCards,
  escapeHtmlText,
  htmlCardParserOptions,
  mapNodeColor,
  mapNodeLinkAnchor,
  mapNodeLineWidth,
  parseHtmlCardDefinition,
  prepareHtmlCardNodes,
  renderMarkdownToHtml,
  sanitizeNode,
  sanitizeSvgMarkup,
  type HtmlCanvasEmbedding,
  type HtmlCardDefinition,
  type HtmlPreviewSelection,
} from './app/app-style-utils';
import {
  addFallbackMindmapTitle,
  countKatexRenderErrors,
  errorMessage,
  findMathInNodeLabelLines,
  formatHistoryBytes,
  formatHistoryTimestamp,
  historySourceLabel,
  markdownTitle,
  markdownTitleLineIndex,
  normalizeKatexDelimiters,
  providerLabel,
} from './mindmap/app-mindmap-utils';
import { Icon } from './components/AppIcon';

const THEME_OPTIONS: Record<
  Theme,
  {
    next: Theme;
    name: string;
    title: string;
    icon: 'moon' | 'sun' | 'compass' | 'sparkle';
  }
> = {
  dark: {
    next: 'navy',
    name: '暗色',
    title: '当前主题：暗色（点击切换为深蓝）',
    icon: 'moon',
  },
  navy: {
    next: 'purple',
    name: '深蓝',
    title: '当前主题：深蓝（点击切换为紫色）',
    icon: 'compass',
  },
  purple: {
    next: 'light',
    name: '紫色',
    title: '当前主题：紫色（点击切换为浅色）',
    icon: 'sparkle',
  },
  light: {
    next: 'dark',
    name: '浅色',
    title: '当前主题：浅色（点击切换为暗色）',
    icon: 'sun',
  },
};

interface MapColorNode {
  state: { depth: number; path?: string };
}
type StylableMarkmap = Omit<MarkmapInstance, 'setData'> & {
  options: {
    color: (node: MapColorNode) => string;
    lineWidth: (node: MapColorNode) => number;
    linkAnchor: (node: MapColorNode) => 'bottom' | 'center';
    direction?: 'right' | 'both' | 'down';
    linkShape?: 'curve' | 'orthogonal' | 'rounded-orthogonal';
    linkRadius?: number;
  };
  setData(
    data?: PureNode | null,
    options?: {
      color: (node: MapColorNode) => string;
      lineWidth: (node: MapColorNode) => number;
      linkAnchor: (node: MapColorNode) => 'bottom' | 'center';
      direction?: 'right' | 'both' | 'down';
      linkShape?: 'curve' | 'orthogonal' | 'rounded-orthogonal';
      linkRadius?: number;
    },
  ): Promise<void>;
};
type CenterableMarkmap = MarkmapInstance & {
  centerNode(node: unknown): Promise<void>;
};

interface PlantUmlCanvasSession {
  request: PlantUmlEditorRequest;
  source: string;
  savedSource: string;
}

interface CliAgentToolRequest {
  requestId: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface TerminalCommandRequest {
  id: string;
  language: string;
  source: string;
}

const promptSuggestions = [
  '机器学习核心知识体系',
  'Web 全栈架构全景图',
  '微积分核心概念推导脉络',
  '敏捷项目研发与交付流程',
  '用户增长模型与生命周期',
];

export default function App() {
  return (
    <GlobalMediaProvider initialWorkspace={readActiveWorkspace()}>
      <FeedAudioProvider>
        <AppContent />
      </FeedAudioProvider>
    </GlobalMediaProvider>
  );
}

function AppContent() {
  const media = useGlobalMedia();
  const isVideoStageOffscreen = useIsVideoStageOffscreen();
  const { article: activePodcastArticle } = useFeedAudio();
  const [editorDraft, setEditorDraft] = useState<EditorDraft>(() =>
    createDraft(),
  );
  const [activeWorkspace, setActiveWorkspace] =
    useState<ActiveWorkspace>(readActiveWorkspace);
  const lastKnowledgePageRef = useRef<'knowledge' | 'mindmap'>(
    activeWorkspace === 'mindmap' ? 'mindmap' : 'knowledge',
  );
  const [examBookFilter, setExamBookFilter] = useState('');
  const [dueExamCount, setDueExamCount] = useState(0);
  const pendingHabitCount = usePendingHabitCount();
  // The player page is built the first time it is opened and then kept, so a video can go on
  // playing in the background and the lists keep their place.
  const [playerOpened, setPlayerOpened] = useState(
    () => activeWorkspace === 'player',
  );
  const [feedOpened, setFeedOpened] = useState(
    () => activeWorkspace === 'feed',
  );
  const [feedFocusArticleRequest, setFeedFocusArticleRequest] = useState<{
    id: number;
    article: FeedArticle;
  } | null>(null);
  const feedFocusRequestIdRef = useRef(0);
  const [readerOpened, setReaderOpened] = useState(
    () => activeWorkspace === 'reader',
  );
  // 终端页首次打开后保持挂载，切换工作区时保留 PTY 会话与屏幕缓冲。
  const [terminalWorkspaceOpened, setTerminalWorkspaceOpened] = useState(
    () => activeWorkspace === 'terminal',
  );
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [mindmapStyle, setMindmapStyle] =
    useState<MindmapStyle>(readMindmapStyle);
  const [nodeSpacing, setNodeSpacing] = useState<NodeSpacing>(readNodeSpacing);
  const activeNodeSpacing =
    nodeSpacing && typeof nodeSpacing === 'object'
      ? nodeSpacing
      : readNodeSpacing();
  const [mindmapStyleMenuOpen, setMindmapStyleMenuOpen] = useState(false);
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
  const [markdownPaneMode, setMarkdownPaneMode] = useState<'edit' | 'preview'>(
    'edit',
  );
  const [markdownFullscreen, setMarkdownFullscreen] = useState(false);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [knowledgeSidebarWidth, setKnowledgeSidebarWidth] = useState(
    readKnowledgeSidebarWidth,
  );
  const [knowledgeSidebarCollapsed, setKnowledgeSidebarCollapsed] = useState(
    readKnowledgeSidebarCollapsed,
  );
  const onKnowledgeSidebarLayoutChange = useCallback(
    (width: number, collapsed: boolean) => {
      setKnowledgeSidebarWidth(width);
      setKnowledgeSidebarCollapsed(collapsed);
    },
    [],
  );
  const [terminalOpen, setTerminalOpen] = useState(false);
  const feedSelectedArticleIdRef = useRef<string | null>(null);
  const [feedExternalRevision, setFeedExternalRevision] = useState(0);
  const [terminalFeedArticleTitle, setTerminalFeedArticleTitle] = useState('');
  const [terminalHeight, setTerminalHeight] = useState(readTerminalHeight);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [terminalDock, setTerminalDock] = useState<'bottom' | 'right'>(() => {
    try {
      return localStorage.getItem('seamind:terminal-dock:v1') === 'right'
        ? 'right'
        : 'bottom';
    } catch {
      return 'bottom';
    }
  });
  useEffect(() => {
    // 订阅页默认把终端停靠到阅读区右侧；用户仍可在终端中手动移回底部。
    if (activeWorkspace === 'feed') setTerminalDock('right');
  }, [activeWorkspace]);
  const [terminalWidth, setTerminalWidth] = useState(() => {
    try {
      return Math.max(
        320,
        Math.min(
          720,
          Number(localStorage.getItem('seamind:terminal-width:v1')) || 440,
        ),
      );
    } catch {
      return 440;
    }
  });
  const terminalWidthDragRef = useRef<{
    pointerId: number;
    x: number;
    width: number;
  } | null>(null);
  const [terminalCommandConfirmation, setTerminalCommandConfirmation] =
    useState<TerminalCommandRequest | null>(null);
  const [pendingTerminalCommand, setPendingTerminalCommand] =
    useState<TerminalCommandRequest | null>(null);
  const [pendingTerminalRawInput, setPendingTerminalRawInput] =
    useState<PendingTerminalRawInput | null>(null);
  const [runnerTerminalOpen, setRunnerTerminalOpen] = useState(false);
  const [pendingRunnerCommand, setPendingRunnerCommand] =
    useState<TerminalCommandRequest | null>(null);
  const [pendingRunnerRawInput, setPendingRunnerRawInput] =
    useState<PendingTerminalRawInput | null>(null);
  const [terminalSplitRatio, setTerminalSplitRatio] = useState(0.5);
  const terminalCommandResultsRef = useRef(
    new Map<string, (output: string) => void>(),
  );
  const terminalResizeRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const [aiCollapsed, setAiCollapsed] = useState<boolean>(readAiCollapsed);
  const [librarySnapshot, setLibrarySnapshot] =
    useState<LibrarySnapshot | null>(null);
  const [mindmapDocuments, setMindmapDocuments] = useState<MapDocument[]>([]);
  const [previewDocumentPath, setPreviewDocumentPath] = useState<string | null>(
    null,
  );
  const [libraryQuery, setLibraryQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [summarizeEpubOnImport, setSummarizeEpubOnImport] = useState(false);
  const [pendingEpubImport, setPendingEpubImport] = useState(false);
  const [epubReader, setEpubReader] = useState<EpubReaderSelection | null>(
    null,
  );
  const readerAgentBridgeRef = useRef<EpubReaderAgentBridge | null>(null);
  const [readerSplitOpen, setReaderSplitOpen] = useState(false);
  const [readerKnowledgeOpen, setReaderKnowledgeOpen] = useState(false);
  const [readerSplitLayout, setReaderSplitLayout] = useState<ReaderSplitLayout>(
    DEFAULT_READER_SPLIT_LAYOUT,
  );
  const [readerSplitLayoutLoadedFor, setReaderSplitLayoutLoadedFor] =
    useState('');
  const [epubChapterNavigation, setEpubChapterNavigation] =
    useState<EpubChapterNavigationRequest | null>(null);
  const [currentEpubChapter, setCurrentEpubChapter] =
    useState<EpubChapterChangeInfo | null>(null);
  const [galaxyViewActive, setGalaxyViewActive] = useState(false);
  const [epubAnnotations, setEpubAnnotations] = useState<EpubAnnotation[]>([]);
  const [bookNoteMarkdownCache, setBookNoteMarkdownCache] = useState<
    Record<string, string>
  >({});
  const [docFootnoteJump, setDocFootnoteJump] = useState<
    (PreviewFootnoteJumpRequest & { relativePath: string }) | null
  >(null);
  const [focusedMapPath, setFocusedMapPath] = useState<string | null>(null);
  const [canvasNodeContextMenu, setCanvasNodeContextMenu] = useState<{
    path: string;
    left: number;
    top: number;
  } | null>(null);
  const [mindmapNavigationTree, setMindmapNavigationTree] =
    useState<MindmapMiniTreeNode | null>(null);
  const [bookMindmapBusy, setBookMindmapBusy] = useState(false);
  const [bookKnowledgeBusy, setBookKnowledgeBusy] = useState(false);
  const readerSplitActive =
    activeWorkspace === 'reader' && readerSplitOpen && Boolean(epubReader);
  const readerKnowledgeActive =
    activeWorkspace === 'reader' && readerKnowledgeOpen && Boolean(epubReader);
  const canDockTerminalRight =
    (activeWorkspace === 'reader' && viewportWidth >= 1250) ||
    ((activeWorkspace === 'feed' || activeWorkspace === 'player') &&
      viewportWidth >= 1400);
  const isTerminalDrawerOpen = terminalOpen || runnerTerminalOpen;
  const terminalRightActive =
    isTerminalDrawerOpen && terminalDock === 'right' && canDockTerminalRight;
  const terminalSideWidth =
    readerSplitActive || readerKnowledgeActive
      ? Math.min(terminalWidth, Math.max(300, viewportWidth - 880))
      : terminalWidth;
  const readerSplitActiveRef = useRef(readerSplitActive);
  readerSplitActiveRef.current = readerSplitActive;
  const epubReaderRef = useRef(epubReader);
  epubReaderRef.current = epubReader;
  const epubChapterNavigationIdRef = useRef(0);
  const fullMindmapRootRef = useRef<PureNode | null>(null);
  const pendingMindmapCenterPathRef = useRef<string | null>(null);
  const splitLayoutDragRef = useRef<'wide' | 'narrow' | null>(null);
  const appShellRef = useRef<HTMLDivElement>(null);
  const epubRestoreAttemptedRef = useRef(false);
  const [epubDropActive, setEpubDropActive] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [saveMessage, setSaveMessage] = useState('正在初始化文件库…');
  const [recoverableDraft, setRecoverableDraft] =
    useState<RecoverableDraft | null>(readRecoverableDraft);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<DocumentVersion[]>([]);
  const [historyPreview, setHistoryPreview] =
    useState<DocumentVersionSnapshot | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [htmlImportBusy, setHtmlImportBusy] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState<HtmlPreviewSelection | null>(
    null,
  );
  const [htmlPreviewSrc, setHtmlPreviewSrc] = useState('');
  const [htmlPreviewError, setHtmlPreviewError] = useState('');
  const [youtubePreview, setYoutubePreview] =
    useState<YouTubePreviewSelection | null>(null);
  const [htmlCanvasEmbed, setHtmlCanvasEmbed] =
    useState<HtmlCanvasEmbedding | null>(null);
  const [plantUmlSession, setPlantUmlSession] =
    useState<PlantUmlCanvasSession | null>(null);
  const plantUmlSessionRef = useRef<PlantUmlCanvasSession | null>(null);
  const isStandalonePlantUml = plantUmlSession?.request.saveTarget === 'file';
  // The library file open in the PlantUML canvas; its cache key is "file:<relative path>".
  const openPlantUmlPath =
    isStandalonePlantUml &&
    plantUmlSession?.request.cacheKey?.startsWith('file:')
      ? plantUmlSession.request.cacheKey.slice('file:'.length)
      : null;
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [providerSettings, setProviderSettings] =
    useState<ProviderSettings>(readProviderSettings);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [providerModelsLoading, setProviderModelsLoading] = useState(false);
  const [providerModelsError, setProviderModelsError] = useState('');
  const [providerModelQuery, setProviderModelQuery] = useState('');
  const [manualProviderModel, setManualProviderModel] = useState('');
  const [aiMode, setAiMode] = useState<AgentAnalysisMode>('drilldown');
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [pendingCliProposal, setPendingCliProposal] =
    useState<PendingCliProposal | null>(null);
  const [pendingCliBusy, setPendingCliBusy] = useState(false);
  const [pendingCliError, setPendingCliError] = useState('');
  const [agentBridgeError, setAgentBridgeError] = useState('');
  const [playerOpenLearningPathRequest, setPlayerOpenLearningPathRequest] =
    useState<{ id: number; pathId: string } | null>(null);
  const [taskCreateRequest, setTaskCreateRequest] =
    useState<TaskCreateRequest | null>(null);
  const [taskOpenId, setTaskOpenId] = useState<string | null>(null);
  const [playerOpenTaskVideoRequest, setPlayerOpenTaskVideoRequest] = useState<{
    id: number;
    videoId: string;
    title: string;
    startSeconds: number;
  } | null>(null);
  const taskRequestIdRef = useRef(0);
  const [playerOpenFavoritesRequestId, setPlayerOpenFavoritesRequestId] =
    useState<number | null>(null);
  const [activeMapPath, setActiveMapPath] = useState<string | null>(null);
  const [nodeNoteDialog, setNodeNoteDialog] = useState<{
    nodeId: string | null;
    nodePath: string;
    label: string;
    markdown: string;
    error: string;
  } | null>(null);
  const [videoEmbedDialog, setVideoEmbedDialog] = useState<{
    nodePath: string;
    nodeLabel: string;
    input: string;
    title: string;
    error: string;
  } | null>(null);
  const [sourceMapVersion, setSourceMapVersion] = useState(0);
  const [markdownEditorSession, setMarkdownEditorSession] = useState(0);
  const pendingCliProposalRef = useRef<PendingCliProposal | null>(null);
  const agentHostRef = useRef<{
    loadLibrary: (openRecent: boolean) => Promise<unknown>;
    openKnowledgeNote: (note: MapDocument) => Promise<unknown>;
  }>({
    loadLibrary: async () => undefined,
    openKnowledgeNote: async () => undefined,
  });
  const mcpToolChain = useRef(Promise.resolve());
  const playerOpenLearningPathRequestIdRef = useRef(0);
  const playerOpenFavoritesRequestIdRef = useRef(0);
  const youtubeSearchResultsRef = useRef(new Map<string, VideoInput>());
  const svgRef = useRef<SVGSVGElement>(null);
  const markdownEditorRef = useRef<MarkdownEditorHandle | null>(null);
  const markdownPaneModeRef = useRef(markdownPaneMode);
  markdownPaneModeRef.current = markdownPaneMode;
  const pendingMarkdownTitleRef = useRef<string | null>(null);
  const codeBlocksAbortRef = useRef<AbortController | null>(null);
  const codeBlocksCleanupRef = useRef<(() => void) | null>(null);
  const mindmapStylePickerRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const markmapRef = useRef<MarkmapInstance | null>(null);
  // Fit only after a new document is rendered; ordinary edits keep the viewport.
  const pendingInitialFitRef = useRef(true);
  const markdownNodeSourcesRef = useRef<Map<string, MarkdownNodeSource>>(
    new Map(),
  );
  const draftRef = useRef(editorDraft);
  const agentCapabilitiesRef = useRef<AgentCapabilities | null>(null);
  const librarySnapshotRef = useRef<LibrarySnapshot | null>(null);
  const historyLoadRequestRef = useRef(0);
  const libraryQueryRef = useRef('');
  const categoryFilterRef = useRef('');
  const activeSaveRef = useRef<Promise<boolean> | null>(null);
  const lastSaveErrorRef = useRef('');
  const codeBlockEditHandlerRef = useRef<
    (
      language: string,
      previous: string,
      next: string,
      sourceRange?: CodeBlockSourceRange,
    ) => boolean
  >(() => false);
  const epubImportInFlightRef = useRef(false);
  const epubDropHandlerRef = useRef<(paths: string[]) => void>(() => {});
  const searchRequestRef = useRef(0);
  const markdownNodeSourcesMarkdownRef = useRef(editorDraft.markdown);
  // The document open in the workbench, if any: a Markdown document or a diagram. While one is
  // open it takes the mind map's place on screen; the mind map itself stays where it was.
  const workbench = useActiveDocument({
    getSnapshot: () => librarySnapshotRef.current,
    installSnapshot: (snapshot) => installLibrarySnapshot(snapshot),
    refreshList: () => {
      void searchLibrary().catch((error) =>
        setLibraryError(errorMessage(error, '更新搜索索引失败')),
      );
    },
    setStatus: (message) => setSaveMessage(message),
    setError: (message) => setLibraryError(message),
    confirmDiscard: (message) => window.confirm(message),
  });
  const activeDocument = workbench.active;
  const catalogDocuments = librarySnapshot?.documents ?? [];

  useEffect(() => {
    setBookNoteMarkdownCache({});
    setDocFootnoteJump(null);
    if (!epubReader?.progressKey) {
      setEpubAnnotations([]);
      return;
    }
    setEpubAnnotations(loadEpubAnnotations(epubReader.progressKey));
  }, [epubReader?.progressKey]);

  useEffect(() => {
    if (!galaxyViewActive || !epubReader || !librarySnapshot) return;
    const cleanBook = bookMindmapTitle(epubReader.title);
    const normalizedBookCategory = `读书笔记/${cleanBook}`
      .replaceAll('\\', '/')
      .toLowerCase();
    const bookDocs = librarySnapshot.documents.filter((doc) => {
      if (doc.kind !== 'doc') return false;
      const cat = doc.category.replaceAll('\\', '/').toLowerCase();
      return (
        cat === normalizedBookCategory ||
        cat.startsWith(`${normalizedBookCategory}/`)
      );
    });
    if (bookDocs.length === 0) return;

    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        bookDocs.map(async (doc) => {
          try {
            const opened = await libraryApi.openDocument({
              relativePath: doc.relativePath,
            });
            return [doc.relativePath, opened.markdown] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      setBookNoteMarkdownCache((prev) => {
        const next = { ...prev };
        for (const item of entries) {
          if (item) {
            next[item[0]] = item[1];
          }
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [galaxyViewActive, epubReader, librarySnapshot]);

  const galaxyChapterMarkdownByPath = useMemo(() => {
    if (
      !activeDocument ||
      activeDocument.kind !== 'doc' ||
      !activeDocument.relativePath
    ) {
      return bookNoteMarkdownCache;
    }
    return {
      ...bookNoteMarkdownCache,
      [activeDocument.relativePath]: activeDocument.source,
    };
  }, [bookNoteMarkdownCache, activeDocument]);

  const bookGalaxyGraph = useMemo(() => {
    if (!galaxyViewActive || !epubReader || !librarySnapshot) return null;
    return buildBookGalaxyGraph(
      epubReader.title,
      epubReader.progressKey,
      currentEpubChapter?.toc ?? [],
      librarySnapshot,
      currentEpubChapter?.chapterHref,
      loadEpubBookMetadata(epubReader.progressKey)?.coverDataUrl ||
        findStoredCoverByBookKey(epubReader.progressKey) ||
        undefined,
      {
        annotations: epubAnnotations,
        chapterMarkdownByPath: galaxyChapterMarkdownByPath,
        tocSectionByHref: currentEpubChapter?.tocSectionByHref,
      },
    );
  }, [
    galaxyViewActive,
    epubReader,
    librarySnapshot,
    currentEpubChapter?.toc,
    currentEpubChapter?.chapterHref,
    currentEpubChapter?.tocSectionByHref,
    epubAnnotations,
    galaxyChapterMarkdownByPath,
  ]);

  useEffect(() => {
    media.setWorkspace(activeWorkspace);
    if (activeWorkspace === 'knowledge' || activeWorkspace === 'mindmap')
      lastKnowledgePageRef.current = activeWorkspace;
    try {
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspace);
    } catch {
      // The active workspace remains available for this session.
    }
    if (activeWorkspace === 'player') setPlayerOpened(true);
    if (activeWorkspace === 'feed') setFeedOpened(true);
    if (activeWorkspace === 'reader') setReaderOpened(true);
    if (activeWorkspace === 'terminal') setTerminalWorkspaceOpened(true);
  }, [media, activeWorkspace]);

  useEffect(() => {
    if (!epubReader?.progressKey) {
      setReaderSplitLayoutLoadedFor('');
      return;
    }
    setReaderSplitLayout(readReaderSplitLayout(epubReader.progressKey));
    setReaderSplitLayoutLoadedFor(epubReader.progressKey);
  }, [epubReader?.progressKey]);

  useEffect(() => {
    const progressKey = epubReader?.progressKey;
    if (!progressKey || readerSplitLayoutLoadedFor !== progressKey) return;
    try {
      localStorage.setItem(
        readerSplitLayoutKey(progressKey),
        JSON.stringify(readerSplitLayout),
      );
    } catch {
      // The adjustable split remains available for this session.
    }
  }, [epubReader?.progressKey, readerSplitLayout, readerSplitLayoutLoadedFor]);

  useEffect(() => {
    if (!canvasNodeContextMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.canvas-node-context-menu')
      )
        return;
      setCanvasNodeContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCanvasNodeContextMenu(null);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [canvasNodeContextMenu]);

  useEffect(() => {
    const openPlantUml = (event: Event) => {
      const request = (event as CustomEvent<PlantUmlEditorRequest>).detail;
      if (!request) return;
      const current = plantUmlSessionRef.current;
      if (
        current &&
        current.source !== current.savedSource &&
        !window.confirm(
          current.request.saveTarget === 'file'
            ? '当前 PUML 文件还有未保存的修改，仍要切换到另一个图表吗？'
            : '当前 PUML 修改还未同步到 Markdown，仍要切换到另一个图表吗？',
        )
      )
        return;
      const nextSession = {
        request,
        source: request.source,
        savedSource: request.source,
      };
      plantUmlSessionRef.current = nextSession;
      setPlantUmlSession(nextSession);
      setSourceCollapsed(false);
      setActiveWorkspace('mindmap');
    };
    const eventName = plantUmlWorkspaceEventName();
    window.addEventListener(eventName, openPlantUml);
    return () => window.removeEventListener(eventName, openPlantUml);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
      if (
        !plantUmlSession &&
        !activeDocument &&
        (activeWorkspace === 'mindmap' || readerSplitActive)
      ) {
        void markmapRef.current?.fit();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeWorkspace,
    readerSplitActive,
    Boolean(plantUmlSession),
    Boolean(activeDocument),
  ]);

  useEffect(() => {
    if (
      activeWorkspace !== 'reader' ||
      !librarySnapshot ||
      !librarySnapshot.rootPath ||
      epubRestoreAttemptedRef.current
    ) {
      return;
    }

    epubRestoreAttemptedRef.current = true;
    let lastRelativePath = '';
    try {
      lastRelativePath = localStorage.getItem(LAST_READER_BOOK_KEY) ?? '';
    } catch {
      return;
    }
    if (!lastRelativePath) return;

    const book = librarySnapshot.books.find(
      (candidate) => candidate.relativePath === lastRelativePath,
    );
    if (!book) {
      setLibraryError('上次阅读的 EPUB 已不在当前文件库中，请从书架重新导入。');
      return;
    }

    void libraryApi
      .openEpubBook({
        relativePath: book.relativePath,
      })
      .then((path) => {
        setEpubReader({
          source: convertFileSrc(path),
          progressKey: epubProgressKey(book),
          bookId: epubBookIdentity(book.relativePath),
          relativePath: book.relativePath,
          title: book.title,
        });
      })
      .catch((error) => {
        setLibraryError(errorMessage(error, '无法恢复上次阅读的电子书'));
      });
  }, [activeWorkspace, librarySnapshot]);

  const transformer = useMemo(() => {
    const instance = new Transformer([pluginFrontmatter, pluginSourceLines]);
    instance.md.set({ html: false });
    instance.md.use(markdownItKatex, { katex, throwOnError: false });
    const defaultFenceRenderer = instance.md.renderer.rules.fence;
    instance.md.renderer.rules.fence = (
      tokens,
      index,
      options,
      env,
      renderer,
    ) => {
      const token = tokens[index];
      const language = token.info.trim().split(/\s+/, 1)[0]?.toLowerCase();
      if (language === 'svg') {
        const svg = sanitizeSvgMarkup(token.content);
        return svg
          ? `${svg}\n`
          : `<pre><code class="language-svg">${escapeHtmlText(token.content)}</code></pre>\n`;
      }
      if (language === 'seamind-html-card') {
        const card = parseHtmlCardDefinition(token.content);
        if (!card)
          return '<pre><code>HTML 卡片声明无效，请重新导入 HTML 文件。</code></pre>\n';
        return `<h6 data-seamind-card="html" data-seamind-asset-id="${escapeHtmlText(card.assetId)}" data-seamind-entry-path="${escapeHtmlText(card.entryPath)}" data-seamind-title="${escapeHtmlText(card.title)}" data-seamind-width="${card.width}" data-seamind-height="${card.height}">${escapeHtmlText(card.title)}</h6>\n`;
      }
      return defaultFenceRenderer
        ? defaultFenceRenderer(tokens, index, options, env, renderer)
        : renderer.renderToken(tokens, index, options);
    };
    return instance;
  }, []);
  const ensureAiMathRenderable = (
    markdown: string,
    source: string,
    checkNodeLabels = true,
  ) => {
    const crowdedMathLines = checkNodeLabels
      ? findMathInNodeLabelLines(markdown)
      : [];
    if (crowdedMathLines.length > 0) {
      const lines = crowdedMathLines.slice(0, 5).join('、');
      const remaining = crowdedMathLines.length - 5;
      throw new Error(
        `${source}把数学公式放进了标题或列表节点（第 ${lines}${remaining > 0 ? ` 等 ${crowdedMathLines.length} 处` : ''} 行）。请将公式移到独立数学段落后再应用。`,
      );
    }
    const { root } = transformer.transform(
      normalizeKatexDelimiters(markdownForMindmap(markdown)),
      htmlCardParserOptions,
    );
    const errorCount = countKatexRenderErrors(root);
    if (errorCount > 0) {
      throw new Error(
        `${source}中有 ${errorCount} 处数学公式无法由 KaTeX 渲染；请让模型修正公式后再应用。`,
      );
    }
  };
  const nodeNotePreviewHtml = useMemo(() => {
    if (!nodeNoteDialog?.markdown.trim()) return '';
    const rendered = renderMarkdownToHtml(
      transformer.md,
      `\n${nodeNoteDialog.markdown}`,
    );
    return sanitizeNode({ content: rendered, children: [] }).content;
  }, [nodeNoteDialog?.markdown, transformer]);
  const markdownPreviewSource = useMemo(
    () => normalizeKatexDelimiters(markdownBody(editorDraft.markdown)),
    [editorDraft.markdown],
  );
  const markdownPreviewHtml = useMemo(() => {
    const source = markdownPreviewSource;
    if (!source.trim()) return '<p>暂无 Markdown 内容</p>';
    const rendered = renderMarkdownToHtml(transformer.md, source);
    return sanitizeNode(
      { content: rendered, children: [] },
      { allowMarkdownImages: true },
    ).content;
  }, [markdownPreviewSource, transformer]);
  const renderDocumentPreview = useMemo(
    () => (markdown: string) => {
      const source = normalizeKatexDelimiters(markdownBody(markdown));
      const { footnotes, bodyWithoutDefinitions } =
        parseMarkdownFootnotes(source);
      if (!bodyWithoutDefinitions.trim() && footnotes.length === 0) {
        return { html: '<p>暂无 Markdown 内容</p>', source };
      }
      const renderedBody = bodyWithoutDefinitions.trim()
        ? renderMarkdownToHtml(transformer.md, bodyWithoutDefinitions)
        : '';
      const sanitizedBody = sanitizeNode(
        { content: renderedBody, children: [] },
        { allowMarkdownImages: true },
      ).content;
      const html = enhanceMarkdownFootnotesHtml(
        sanitizedBody,
        footnotes,
        (footnoteMarkdown) =>
          sanitizeNode(
            {
              content: renderMarkdownToHtml(
                transformer.md,
                normalizeKatexDelimiters(footnoteMarkdown),
              ),
              children: [],
            },
            { allowMarkdownImages: true },
          ).content,
      );
      return { html, source };
    },
    [transformer],
  );
  const historyPreviewHtml = useMemo(() => {
    if (!historyPreview?.markdown.trim())
      return '<p>此版本没有 Markdown 内容。</p>';
    const rendered = renderMarkdownToHtml(
      transformer.md,
      normalizeKatexDelimiters(markdownBody(historyPreview.markdown)),
    );
    return sanitizeNode(
      { content: rendered, children: [] },
      { allowMarkdownImages: true },
    ).content;
  }, [historyPreview?.markdown, transformer]);

  useEffect(() => {
    if (!markdownFullscreen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMarkdownFullscreen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [markdownFullscreen]);

  const installDraft = (next: EditorDraft) => {
    const current = draftRef.current;
    if (
      current.relativePath !== next.relativePath ||
      current.title !== next.title
    ) {
      setFocusedMapPath(null);
      setCanvasNodeContextMenu(null);
      setMindmapNavigationTree(null);
    }
    pendingInitialFitRef.current = true;
    markmapRef.current?.setViewAnchorPath(undefined);
    draftRef.current = next;
    setEditorDraft(next);
    setMarkdownEditorSession((session) => session + 1);
    setActiveMapPath(null);
    setNodeNoteDialog(null);
  };

  const patchDraft = (patch: Partial<EditorDraft>) => {
    if (
      previewDocumentPath !== null &&
      previewDocumentPath === draftRef.current.relativePath
    )
      return;
    const next = {
      ...draftRef.current,
      ...patch,
      dirty: true,
      revision: draftRef.current.revision + 1,
    };
    draftRef.current = next;
    setEditorDraft(next);
    setPendingEpubImport(false);
    setSaveMessage('有未保存修改');
  };

  const handleMarkdownEditorChange = (markdown: string) => {
    const current = draftRef.current;
    const title =
      pendingMarkdownTitleRef.current ||
      (current.title === markdownTitle(current.markdown)
        ? markdownTitle(markdown)
        : null);
    pendingMarkdownTitleRef.current = null;
    patchDraft({ markdown, ...(title ? { title } : {}) });
  };

  const applyMarkdownFromCanvas = (
    markdown: string,
    options: {
      lineIndex?: number;
      endLineIndex?: number;
      focus?: boolean;
      title?: string;
    } = {},
  ) => {
    if (markdown === draftRef.current.markdown) return;
    pendingMarkdownTitleRef.current = options.title || null;
    if (markdownEditorRef.current) {
      markdownEditorRef.current.applyDocument(markdown, options);
    } else {
      pendingMarkdownTitleRef.current = null;
      patchDraft({
        markdown,
        ...(options.title ? { title: options.title } : {}),
      });
    }
  };

  const handleMarkdownSelectionChange = (selection: MarkdownSelection) => {
    setActiveMapPath(
      findSourcePathForLine(
        selection.lineIndex,
        markdownNodeSourcesRef.current,
      ),
    );
  };

  const applySelectedNodeOperation = (
    operation: 'child' | 'sibling' | 'delete',
  ) => {
    if (!activeMapPath) return;
    if (markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown)
      return;
    const source = markdownNodeSourcesRef.current.get(activeMapPath);
    if (!source || (source.kind === 'block' && operation !== 'delete')) return;
    const markdown = draftRef.current.markdown;
    try {
      const command = applyMarkdownNodeCommand(
        markdown,
        source,
        operation === 'child'
          ? 'add_child'
          : operation === 'sibling'
            ? 'add_sibling'
            : 'delete',
        '新主题',
      );
      if (command.markdown === markdown) return;
      if (operation === 'delete') setActiveMapPath(null);
      applyMarkdownFromCanvas(command.markdown, {
        lineIndex: command.lineIndex,
        focus: true,
        ...(source.lineIndex === markdownTitleLineIndex(markdown)
          ? { title: markdownTitle(command.markdown) }
          : {}),
      });
    } catch (error) {
      setLibraryError(errorMessage(error, '无法修改所选节点。'));
    }
  };

  const openVideoEmbedDialog = () => {
    if (
      !activeMapPath ||
      markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown
    )
      return;
    const source = markdownNodeSourcesRef.current.get(activeMapPath);
    if (!source || source.kind === 'block') return;
    setVideoEmbedDialog({
      nodePath: activeMapPath,
      nodeLabel: source.label,
      input: '',
      title: '',
      error: '',
    });
  };

  const insertVideoEmbedChild = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const dialog = videoEmbedDialog;
    if (!dialog) return;
    if (markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown) {
      setVideoEmbedDialog((current) =>
        current
          ? {
              ...current,
              error: '文档刚刚发生变化，请关闭后重新选择目标节点。',
            }
          : current,
      );
      return;
    }
    const source = markdownNodeSourcesRef.current.get(dialog.nodePath);
    if (!source || source.kind === 'block') {
      setVideoEmbedDialog((current) =>
        current
          ? { ...current, error: '找不到原来的目标节点，请重新选择节点。' }
          : current,
      );
      return;
    }
    const video = parseYouTubeEmbedInput(dialog.input);
    if (!video) {
      setVideoEmbedDialog((current) =>
        current
          ? {
              ...current,
              error:
                '无法识别视频。请粘贴 YouTube 链接，或包含 YouTube embed 地址的 iframe。',
            }
          : current,
      );
      return;
    }

    const title =
      dialog.title
        .trim()
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 120) || 'YouTube 视频';
    const safeTitle = title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
    const startParameter =
      video.startSeconds > 0 ? `&t=${video.startSeconds}s` : '';
    const childText = `[${safeTitle}](https://www.youtube.com/watch?v=${video.id}${startParameter})`;
    try {
      const command = applyMarkdownNodeCommand(
        draftRef.current.markdown,
        source,
        'add_child',
        childText,
      );
      applyMarkdownFromCanvas(command.markdown, {
        lineIndex: command.lineIndex,
        focus: true,
      });
      setActiveMapPath(dialog.nodePath);
      setVideoEmbedDialog(null);
    } catch (error) {
      setVideoEmbedDialog((current) =>
        current
          ? {
              ...current,
              error: errorMessage(error, '无法将视频添加到所选节点。'),
            }
          : current,
      );
    }
  };

  const openSelectedNodeNote = () => {
    if (!activeMapPath) return;
    if (markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown)
      return;
    const source = markdownNodeSourcesRef.current.get(activeMapPath);
    if (!source) return;
    const current = draftRef.current.markdown;
    setNodeNoteDialog({
      nodeId: source.id || null,
      nodePath: activeMapPath,
      label: source.label,
      markdown: source.id ? getMarkdownNodeNote(current, source.id) : '',
      error: '',
    });
  };

  const saveSelectedNodeNote = () => {
    if (!nodeNoteDialog) return;
    if (!nodeNoteDialog.nodeId && !nodeNoteDialog.markdown.trim()) {
      setNodeNoteDialog(null);
      return;
    }
    const current = draftRef.current.markdown;
    const root = transformer.transform(markdownForMindmap(current)).root;
    const sources = buildMarkdownNodeSourceMap(current, root);
    const source = nodeNoteDialog.nodeId
      ? [...sources.values()].find(
          (candidate) => candidate.id === nodeNoteDialog.nodeId,
        )
      : sources.get(nodeNoteDialog.nodePath);
    if (!source) {
      setNodeNoteDialog((dialog) =>
        dialog
          ? { ...dialog, error: '节点已变化，请关闭后重新打开备注。' }
          : dialog,
      );
      return;
    }
    try {
      const command = applyMarkdownNodeCommand(
        current,
        source,
        'set_note',
        nodeNoteDialog.markdown,
      );
      if (command.markdown !== current)
        applyMarkdownFromCanvas(command.markdown);
      setNodeNoteDialog(null);
    } catch (error) {
      setNodeNoteDialog((dialog) =>
        dialog
          ? { ...dialog, error: errorMessage(error, '节点备注无法保存。') }
          : dialog,
      );
    }
  };

  const getAgentMindmap = (): ActiveMindmapSnapshot =>
    readAgentMindmap(draftRef.current, transformer);

  const proposeAgentNodeEdit = (
    input: ProposeNodeEditInput,
  ): NodeEditProposal =>
    buildAgentNodeEditProposal({
      draft: draftRef.current,
      transformer,
      input,
      ensureAiMathRenderable,
    });

  const proposeAgentNodeBranch = (input: {
    baseRevision: number;
    nodeId?: string;
    nodePath?: string;
    analysisMode: AgentAnalysisMode;
    branchMarkdown: string;
    rationale: string;
  }): NodeEditProposal =>
    buildAgentNodeBranchProposal({
      draft: draftRef.current,
      transformer,
      input,
      ensureAiMathRenderable,
    });

  const proposeLearningPath = (
    input: ProposeLearningPathInput,
  ): Promise<LearningPathProposal> =>
    buildLearningPathProposal({
      input,
      cachedVideo: (videoId) => youtubeSearchResultsRef.current.get(videoId),
    });

  const mindmapTurnBrief = useMemo(() => {
    const snapshot = getAgentMindmap();
    return {
      title: snapshot.title,
      revision: snapshot.revision,
      relativePath: snapshot.relativePath,
      nodeCount: snapshot.nodeCount,
      truncated: snapshot.truncated,
    };
  }, [
    editorDraft.markdown,
    editorDraft.revision,
    editorDraft.title,
    editorDraft.relativePath,
    transformer,
  ]);

  const agentCapabilities: AgentCapabilities = createAgentCapabilities({
    feed: {
      getWorkspace: () => activeWorkspace,
      getSelectedArticleId: () => feedSelectedArticleIdRef.current,
      notifySubscriptionsChanged: () =>
        setFeedExternalRevision((revision) => revision + 1),
    },
    reader: {
      getWorkspace: () => activeWorkspace,
      getReader: () => epubReader,
      getReaderBridge: () => readerAgentBridgeRef.current,
      getLibrarySnapshot: () => librarySnapshotRef.current,
      getCurrentChapter: () => currentEpubChapter,
      getOpenDocument: () => workbench.controller.getState(),
      editOpenDocument: (markdown) => workbench.controller.edit(markdown),
      saveOpenDocument: () => workbench.controller.save({ manual: true }),
      createKnowledgeDocument: (options) =>
        workbench.controller.createCustomDocument(options),
      reloadLibrary: () =>
        agentHostRef.current.loadLibrary(false).then(() => undefined),
      openKnowledgeNote: (note) =>
        agentHostRef.current.openKnowledgeNote(note).then(() => undefined),
      navigateToChapter: ({ progressKey, href, label }) => {
        setEpubChapterNavigation({
          id: ++epubChapterNavigationIdRef.current,
          progressKey,
          href,
          label,
        });
      },
      notify: (message) => setSaveMessage(message),
    },
    mindmap: {
      getCurrentMindmap: getAgentMindmap,
      searchLibrary: (query, category) =>
        libraryApi.search({
          query,
          category: category || null,
        }),
      readDocument: (relativePath) => libraryApi.openDocument({ relativePath }),
      proposeNodeEdit: proposeAgentNodeEdit,
      proposeNodeBranch: proposeAgentNodeBranch,
    },
    player: {
      rememberYouTubeVideo: (video) => {
        youtubeSearchResultsRef.current.set(video.videoId, video);
      },
      listLearningPaths: async () => (await playerApi.overview()).learningPaths,
      getLearningPath: (pathId) => playerApi.learningPathGet(pathId),
      proposeLearningPath,
      getFavoritesBoard: () => playerApi.favoritesSnapshot(),
    },
  });
  agentCapabilitiesRef.current = agentCapabilities;

  useEffect(() => {
    const tools = agentToolCatalogForWorkspace(activeWorkspace);
    if (!tools) return;
    let cancelled = false;
    const specs = mcpToolSpecs(tools);
    mcpToolChain.current = mcpToolChain.current
      .catch(() => undefined)
      .then(() => agentApi.setBridgeTools({ tools: specs }))
      .then(() => {
        if (!cancelled) setAgentBridgeError('');
      })
      .catch((error: unknown) => {
        console.error('Unable to register Seamind MCP tools', error);
        if (!cancelled) {
          setAgentBridgeError(
            errorMessage(
              error,
              'Seamind 工具注册失败，终端里的 Agent 暂时用不了这些工具。',
            ),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<CliAgentToolRequest>(
      'seamind-cli-tool-request',
      async (event) => {
        const { requestId, name, arguments: input } = event.payload;
        const capabilities = agentCapabilitiesRef.current;
        if (!capabilities) {
          await agentApi
            .resolveBridge({
              requestId,
              result: {},
              error: 'Seamind 能力尚未初始化。',
            })
            .catch(() => undefined);
          return;
        }
        try {
          const execution = await executeAgentTool(
            name,
            JSON.stringify(input ?? {}),
            capabilities,
          );
          const blocked = (message: string) =>
            agentApi
              .resolveBridge({
                requestId,
                result: {},
                error: message,
              })
              .catch(() => undefined);
          if (pendingCliProposalRef.current) {
            const waitingOnMindmap = Boolean(execution.proposal);
            if (
              execution.favoritesCategorizationProposal ||
              execution.learningPathProposal ||
              execution.proposal ||
              execution.knowledgeNoteProposal ||
              execution.readerChapterProposal
            ) {
              await blocked(
                waitingOnMindmap
                  ? 'Seamind 正在等待你确认另一条导图修改提案。'
                  : 'Seamind 正在等待你确认另一条提案。',
              );
              return;
            }
          }
          if (execution.favoritesCategorizationProposal) {
            const pending: PendingCliProposal = {
              kind: 'favorites',
              requestId,
              proposal: execution.favoritesCategorizationProposal,
            };
            pendingCliProposalRef.current = pending;
            setPendingCliProposal(pending);
            setPendingCliError('');
            setActiveWorkspace('player');
            setPlayerOpened(true);
            return;
          }
          if (execution.learningPathProposal) {
            const pending: PendingCliProposal = {
              kind: 'learning-path',
              requestId,
              proposal: execution.learningPathProposal,
            };
            pendingCliProposalRef.current = pending;
            setPendingCliProposal(pending);
            setPendingCliError('');
            setActiveWorkspace('player');
            setPlayerOpened(true);
            return;
          }
          if (execution.proposal) {
            const pending: PendingCliProposal = {
              kind: 'mindmap',
              requestId,
              proposal: execution.proposal,
            };
            pendingCliProposalRef.current = pending;
            setPendingCliProposal(pending);
            setPendingCliError('');
            return;
          }
          const readerProposal =
            execution.knowledgeNoteProposal ?? execution.readerChapterProposal;
          if (readerProposal) {
            const pending: PendingCliProposal = {
              kind: 'reader',
              requestId,
              proposal: readerProposal,
            };
            pendingCliProposalRef.current = pending;
            setPendingCliProposal(pending);
            setPendingCliError('');
            setActiveWorkspace('reader');
            return;
          }
          const structuredContent = {
            version: execution.version,
            permission: execution.permission,
            ...execution.result,
          };
          await agentApi.resolveBridge({
            requestId,
            result: {
              content: [
                { type: 'text', text: JSON.stringify(structuredContent) },
              ],
              structuredContent,
            },
            error: null,
          });
        } catch (caught) {
          await agentApi
            .resolveBridge({
              requestId,
              result: {},
              error:
                caught instanceof Error ? caught.message : '工具执行失败。',
            })
            .catch(() => undefined);
        }
      },
    )
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch((error: unknown) => {
        console.error('Unable to listen for Seamind MCP requests', error);
      });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const applyAgentProposal = async (
    proposal: NodeEditProposal,
  ): Promise<number | null> => {
    const current = draftRef.current;
    if (
      current.revision !== proposal.baseRevision ||
      current.relativePath !== proposal.baseRelativePath ||
      current.markdown !== proposal.baseMarkdown
    ) {
      return null;
    }
    if (proposal.htmlAssets?.length) {
      if (!current.relativePath) {
        throw new Error('请先保存当前思维导图，再插入生成的 HTML 资源。');
      }
      const assetIds = proposal.htmlAssets.map((asset) => asset.assetId);
      await libraryApi.saveGeneratedHtmlAssets({
        documentRelativePath: current.relativePath,
        assets: proposal.htmlAssets,
      });
      const latest = draftRef.current;
      if (
        latest.revision !== proposal.baseRevision ||
        latest.relativePath !== proposal.baseRelativePath ||
        latest.markdown !== proposal.baseMarkdown
      ) {
        await libraryApi
          .discardGeneratedHtmlAssets({
            documentRelativePath: current.relativePath,
            assetIds,
          })
          .catch(() => undefined);
        return null;
      }
    }
    applyMarkdownFromCanvas(proposal.markdown, { title: proposal.title });
    return draftRef.current.revision;
  };

  const resolvePendingCliProposal = async (apply: boolean) => {
    const pending = pendingCliProposalRef.current;
    if (!pending) return;
    if (pending.kind !== 'mindmap' && pendingCliBusy) return;
    if (!apply) {
      const error =
        pending.kind === 'mindmap'
          ? '用户在 Seamind 中拒绝了导图修改提案；导图没有变化。'
          : pending.kind === 'learning-path'
            ? '用户拒绝了学习路径提案；数据库没有变化。'
            : pending.kind === 'favorites'
              ? '用户取消了收藏视频智能归类提案；未做任何改动。'
              : pending.proposal.kind === 'chapter'
                ? '用户取消了章节跳转；阅读位置没有变化。'
                : '用户取消了读书笔记修改；笔记没有变化。';
      pendingCliProposalRef.current = null;
      setPendingCliProposal(null);
      setPendingCliError('');
      await agentApi
        .resolveBridge({
          requestId: pending.requestId,
          result: {},
          error,
        })
        .catch(() => undefined);
      return;
    }

    if (pending.kind === 'mindmap') {
      pendingCliProposalRef.current = null;
      setPendingCliProposal(null);
      let appliedRevision: number | null;
      try {
        appliedRevision = await applyAgentProposal(pending.proposal);
      } catch (error) {
        await agentApi
          .resolveBridge({
            requestId: pending.requestId,
            result: {},
            error: errorMessage(error, '无法保存下探分支资源。'),
          })
          .catch(() => undefined);
        return;
      }
      if (appliedRevision === null) {
        await agentApi
          .resolveBridge({
            requestId: pending.requestId,
            result: {},
            error:
              '当前导图在提案生成后发生了变化。请重新读取导图并提出新提案。',
          })
          .catch(() => undefined);
        return;
      }
      await agentApi
        .resolveBridge({
          requestId: pending.requestId,
          result: {
            content: [
              { type: 'text', text: '用户已在 Seamind 中确认并应用修改。' },
            ],
            structuredContent: {
              status: 'applied',
              title: pending.proposal.title,
              relativePath: pending.proposal.baseRelativePath,
              revision: appliedRevision,
            },
          },
          error: null,
        })
        .catch(() => undefined);
      return;
    }

    if (pending.kind === 'reader' && !agentCapabilitiesRef.current) {
      setPendingCliError('Seamind 能力尚未初始化。');
      return;
    }

    setPendingCliBusy(true);
    setPendingCliError('');
    try {
      if (pending.kind === 'learning-path') {
        const saved = await playerApi.learningPathSave(pending.proposal.input);
        pendingCliProposalRef.current = null;
        setPendingCliProposal(null);
        setPlayerOpened(true);
        setActiveWorkspace('player');
        playerOpenLearningPathRequestIdRef.current += 1;
        setPlayerOpenLearningPathRequest({
          id: playerOpenLearningPathRequestIdRef.current,
          pathId: saved.summary.pathId,
        });
        await agentApi
          .resolveBridge({
            requestId: pending.requestId,
            result: {
              content: [
                {
                  type: 'text',
                  text: `用户已确认并保存学习路径「${saved.summary.title}」。`,
                },
              ],
              structuredContent: {
                status: 'applied',
                permission: 'user_approval',
                name: 'learning_path_propose',
                pathId: saved.summary.pathId,
                title: saved.summary.title,
                nodeCount: saved.summary.nodeCount,
                videoCount: saved.summary.videoCount,
              },
            },
            error: null,
          })
          .catch(() => undefined);
        return;
      }
      if (pending.kind === 'favorites') {
        const result = await applyFavoritesCategorizationProposal(
          pending.proposal,
        );
        pendingCliProposalRef.current = null;
        setPendingCliProposal(null);
        setPlayerOpened(true);
        setActiveWorkspace('player');
        playerOpenFavoritesRequestIdRef.current += 1;
        setPlayerOpenFavoritesRequestId(
          playerOpenFavoritesRequestIdRef.current,
        );
        await agentApi
          .resolveBridge({
            requestId: pending.requestId,
            result: {
              content: [
                {
                  type: 'text',
                  text: `用户已确认并应用收藏视频智能归类：新建 ${result.createdCategories} 个分类、归类 ${result.assignedVideos} 个视频。`,
                },
              ],
              structuredContent: {
                status: 'applied',
                permission: 'user_approval',
                name: 'favorites_propose_categorization',
                createdCategories: result.createdCategories,
                assignedVideos: result.assignedVideos,
              },
            },
            error: null,
          })
          .catch(() => undefined);
        return;
      }

      const capabilities = agentCapabilitiesRef.current;
      if (!capabilities) throw new Error('Seamind 能力尚未初始化。');
      const proposal = pending.proposal;
      let text = '用户已确认。';
      let structuredContent: Record<string, unknown> = {
        status: 'applied',
        permission: 'user_approval',
      };
      if (proposal.kind === 'chapter') {
        if (!capabilities.syncReaderChapter) {
          throw new Error('请先在电子书阅读器中打开一本书。');
        }
        const synced = await capabilities.syncReaderChapter({
          chapterTarget: proposal.chapterTarget,
          reason: proposal.reason,
        });
        text = `用户已确认并跳转到「${synced.targetChapter}」。`;
        structuredContent = {
          ...structuredContent,
          name: 'knowledge_sync_reader_chapter',
          ...synced,
        };
      } else if (proposal.kind === 'update') {
        if (!capabilities.updateBookKnowledgeNote) {
          throw new Error('请先在电子书阅读器中打开一本书。');
        }
        const saved = await capabilities.updateBookKnowledgeNote({
          content: proposal.content,
          mode: proposal.mode,
          rationale: proposal.rationale,
          chapterTarget: proposal.chapterTarget,
        });
        text = `用户已确认并${proposal.mode === 'append' ? '追加' : '更新'}读书笔记「${saved.title}」。`;
        structuredContent = {
          ...structuredContent,
          name: 'knowledge_update_book_note',
          ...saved,
        };
      } else {
        if (!capabilities.appendBookKnowledgeExcerpt) {
          throw new Error('请先在电子书阅读器中打开一本书。');
        }
        const saved = await capabilities.appendBookKnowledgeExcerpt({
          excerpt: proposal.excerpt,
          commentary: proposal.commentary,
          chapterLabel: proposal.chapterLabel,
        });
        text = `用户已确认并把摘录写入「${saved.title}」。`;
        structuredContent = {
          ...structuredContent,
          name: 'knowledge_append_excerpt',
          ...saved,
        };
      }
      pendingCliProposalRef.current = null;
      setPendingCliProposal(null);
      await agentApi
        .resolveBridge({
          requestId: pending.requestId,
          result: {
            content: [{ type: 'text', text }],
            structuredContent,
          },
          error: null,
        })
        .catch(() => undefined);
    } catch (error) {
      const fallback =
        pending.kind === 'learning-path'
          ? '保存学习路径失败。'
          : pending.kind === 'favorites'
            ? '应用收藏视频分类提案失败。'
            : '应用阅读操作失败。';
      setPendingCliError(errorMessage(error, fallback));
    } finally {
      setPendingCliBusy(false);
    }
  };

  const undoAgentProposal = async (
    proposal: NodeEditProposal,
    appliedRevision: number,
  ): Promise<boolean> => {
    const current = draftRef.current;
    if (
      current.revision !== appliedRevision ||
      (proposal.baseRelativePath !== null &&
        current.relativePath !== proposal.baseRelativePath) ||
      current.markdown !== proposal.markdown
    ) {
      return false;
    }
    applyMarkdownFromCanvas(proposal.baseMarkdown, {
      title: proposal.baseTitle,
    });
    if (proposal.htmlAssets?.length && proposal.baseRelativePath) {
      await libraryApi
        .discardGeneratedHtmlAssets({
          documentRelativePath: proposal.baseRelativePath,
          assetIds: proposal.htmlAssets.map((asset) => asset.assetId),
        })
        .catch(() => undefined);
    }
    return true;
  };

  codeBlockEditHandlerRef.current = (
    language: string,
    previous: string,
    next: string,
    sourceRange?: CodeBlockSourceRange,
  ): boolean => {
    const activeDraft = draftRef.current;
    const markdown = sourceRange
      ? updateMarkdownCodeFenceAtRange(
          activeDraft.markdown,
          language,
          sourceRange.lineIndex,
          sourceRange.endLineIndex,
          previous,
          next,
        )
      : updateMarkdownCodeFence(activeDraft.markdown, language, previous, next);
    if (markdown === activeDraft.markdown) return false;
    applyMarkdownFromCanvas(markdown);
    return true;
  };

  const handleMathVisualizationChange = (
    language: string,
    previous: string,
    next: string,
    nodePath: string | null,
  ) => {
    if (
      !nodePath ||
      markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown
    )
      return;
    const source = markdownNodeSourcesRef.current.get(nodePath);
    if (!source || source.kind !== 'block') return;
    const current = draftRef.current.markdown;
    const markdown = updateMarkdownCodeFenceAtRange(
      current,
      language,
      source.lineIndex,
      source.endLineIndex,
      previous,
      next,
    );
    if (markdown === current) {
      setLibraryError('无法定位该数学可视化代码块，请先从源文本重新渲染。');
      return;
    }
    setLibraryError('');
    applyMarkdownFromCanvas(markdown, {
      lineIndex: source.lineIndex,
      endLineIndex: source.endLineIndex,
      focus: true,
    });
  };

  const handleRunCodeInTerminal = useCallback(
    async (language: string, source: string, title?: string) => {
      try {
        const isCpp =
          language === 'cpp' || language === 'c++' || language === 'cxx';
        const stageResult = await terminalApi.stageCSource({
          source,
          suggestedName: title ?? null,
          workspaceRoot: librarySnapshot?.rootPath ?? null,
          isCpp,
        });

        setRunnerTerminalOpen(true);
        setPendingRunnerRawInput({
          id: `run-c-${Date.now()}`,
          text: stageResult.command,
          execute: true,
        });
      } catch (error) {
        setSaveMessage(
          `启动 C 终端运行失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [librarySnapshot?.rootPath],
  );

  const onSplitDividerPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const panelEl = document.getElementById('seamind-terminal-panel');
      if (!panelEl) return;
      const rect = panelEl.getBoundingClientRect();
      const startY = event.clientY;
      const initialRatio = terminalSplitRatio;

      const onPointerMove = (e: PointerEvent) => {
        const deltaY = e.clientY - startY;
        const newRatio = Math.max(
          0.15,
          Math.min(0.85, initialRatio + deltaY / rect.height),
        );
        setTerminalSplitRatio(newRatio);
      };

      const onPointerUp = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    },
    [terminalSplitRatio],
  );

  const installLibrarySnapshot = (snapshot: LibrarySnapshot) => {
    const rootChanged =
      librarySnapshotRef.current?.rootPath !== snapshot.rootPath;
    librarySnapshotRef.current = snapshot;
    setLibrarySnapshot(snapshot);
    if (
      rootChanged ||
      (!libraryQueryRef.current && !categoryFilterRef.current)
    ) {
      setMindmapDocuments(
        snapshot.documents.filter((document) => document.kind === 'mindmap'),
      );
    }
  };

  const searchLibrary = async (
    query = libraryQuery,
    category = categoryFilter,
  ) => {
    const sequence = ++searchRequestRef.current;
    const documents = await libraryApi.search({
      query,
      category: category || null,
      kind: 'mindmap',
    });
    if (sequence === searchRequestRef.current) setMindmapDocuments(documents);
  };

  const loadHistoryVersion = async (versionId: string) => {
    const documentId = draftRef.current.id;
    if (!documentId) return;
    const request = ++historyLoadRequestRef.current;
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const snapshot = await libraryApi.loadVersion({ documentId, versionId });
      if (
        request === historyLoadRequestRef.current &&
        draftRef.current.id === documentId
      ) {
        setHistoryPreview(snapshot);
      }
    } catch (error) {
      if (request === historyLoadRequestRef.current)
        setHistoryError(errorMessage(error, '无法读取历史版本内容。'));
    } finally {
      if (request === historyLoadRequestRef.current) setHistoryLoading(false);
    }
  };

  const closeDocumentHistory = () => {
    historyLoadRequestRef.current += 1;
    setHistoryOpen(false);
  };

  const openDocumentHistory = async () => {
    const current = draftRef.current;
    if (!current.id || !current.relativePath) return;
    const request = ++historyLoadRequestRef.current;
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError('');
    setHistoryPreview(null);
    setHistoryVersions([]);
    if (current.dirty && !(await saveDraft())) {
      if (request === historyLoadRequestRef.current) {
        setHistoryError('当前修改尚未保存，历史记录未能加载。');
        setHistoryLoading(false);
      }
      return;
    }
    if (request !== historyLoadRequestRef.current) return;
    const target = draftRef.current;
    if (!target.id || target.id !== current.id) {
      setHistoryError('当前思维导图已变化，请重新打开历史记录。');
      setHistoryLoading(false);
      return;
    }
    try {
      const versions = await libraryApi.listVersions({ documentId: target.id });
      if (
        request !== historyLoadRequestRef.current ||
        draftRef.current.id !== target.id
      ) {
        return;
      }
      setHistoryVersions(versions);
      if (versions[0]) await loadHistoryVersion(versions[0].versionId);
    } catch (error) {
      if (request === historyLoadRequestRef.current)
        setHistoryError(errorMessage(error, '无法读取历史版本列表。'));
    } finally {
      if (request === historyLoadRequestRef.current) setHistoryLoading(false);
    }
  };

  const restoreHistoryVersion = async () => {
    const selected = historyPreview;
    const current = draftRef.current;
    if (
      !selected ||
      !current.id ||
      !current.relativePath ||
      current.id !== selected.documentId
    ) {
      setHistoryError('当前思维导图已变化，请重新打开历史记录。');
      return;
    }
    setHistoryBusy(true);
    setHistoryError('');
    try {
      if (current.dirty && !(await saveDraft())) return;
      const latest = draftRef.current;
      if (latest.id !== selected.documentId || !latest.relativePath) {
        setHistoryError('当前思维导图已变化，未执行恢复。');
        return;
      }
      const restored = await libraryApi.restoreVersion({
        documentId: selected.documentId,
        relativePath: latest.relativePath,
        versionId: selected.versionId,
      });
      installDraft(
        createDraft({
          id: restored.document.id,
          relativePath: restored.document.relativePath,
          title: restored.document.title,
          category: restored.document.category || '未分类',
          mapType: restored.document.mapType || '通用',
          tags: restored.document.tags.join(', '),
          markdown: restored.markdown,
          revision: latest.revision + 1,
        }),
      );
      const updatedLibrary = librarySnapshotRef.current;
      if (updatedLibrary) {
        const parts = restored.document.category.split('/').filter(Boolean);
        const categories = new Set(updatedLibrary.categories);
        for (let index = 1; index <= parts.length; index += 1)
          categories.add(parts.slice(0, index).join('/'));
        const nextLibrary = {
          ...updatedLibrary,
          categories: [...categories].sort(),
          documents: [
            restored.document,
            ...updatedLibrary.documents.filter(
              (document) => document.id !== restored.document.id,
            ),
          ],
        };
        installLibrarySnapshot(nextLibrary);
      }
      void searchLibrary().catch((error) =>
        setLibraryError(errorMessage(error, '更新搜索索引失败')),
      );
      closeDocumentHistory();
      setHistoryPreview(null);
      setSaveMessage('已恢复到所选版本');
      setLibraryError('');
    } catch (error) {
      setHistoryError(errorMessage(error, '恢复历史版本失败。'));
    } finally {
      setHistoryBusy(false);
    }
  };

  const saveDraft = async (force = false): Promise<boolean> => {
    if (
      previewDocumentPath !== null &&
      previewDocumentPath === draftRef.current.relativePath
    )
      return true;
    const activeSave = activeSaveRef.current;
    if (activeSave) {
      const saved = await activeSave;
      if (!saved) return false;
      if (draftRef.current.dirty) return saveDraft(force);
      return true;
    }

    const snapshot = draftRef.current;
    if (!force && !snapshot.dirty && snapshot.relativePath) return true;
    if (!librarySnapshotRef.current?.rootPath) {
      setSaveMessage('请先选择文件库目录');
      return false;
    }

    const input: SaveDocumentInput = {
      id: snapshot.id,
      relativePath: snapshot.relativePath,
      title: snapshot.title.trim() || markdownTitle(snapshot.markdown),
      category: snapshot.category,
      mapType: snapshot.mapType,
      tags: snapshot.tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
      markdown: snapshot.markdown,
      historySource: force ? 'manual' : 'autosave',
    };
    setSaveMessage('正在保存…');
    const task = (async () => {
      try {
        const savedDocument = await libraryApi.saveDocument({
          input,
        });
        const latest = draftRef.current;
        const unchanged = latest.revision === snapshot.revision;
        const next: EditorDraft = {
          ...latest,
          id: savedDocument.id,
          relativePath: savedDocument.relativePath,
          ...(unchanged
            ? {
                title: savedDocument.title,
                category: savedDocument.category,
                mapType: savedDocument.mapType,
                tags: savedDocument.tags.join(', '),
              }
            : {}),
          dirty: !unchanged,
        };
        draftRef.current = next;
        setEditorDraft(next);
        setPendingEpubImport(false);
        setSaveMessage(unchanged ? '已保存到本机' : '正在保存后续修改…');
        lastSaveErrorRef.current = '';
        setLibraryError('');

        const currentLibrary = librarySnapshotRef.current;
        if (currentLibrary) {
          const categories = new Set(currentLibrary.categories);
          const parts = savedDocument.category.split('/').filter(Boolean);
          for (let index = 1; index <= parts.length; index += 1)
            categories.add(parts.slice(0, index).join('/'));
          const documents = [
            savedDocument,
            ...currentLibrary.documents.filter(
              (document) =>
                document.relativePath !== savedDocument.relativePath &&
                document.id !== savedDocument.id,
            ),
          ];
          const updatedLibrary = {
            ...currentLibrary,
            categories: [...categories].sort(),
            documents,
          };
          librarySnapshotRef.current = updatedLibrary;
          setLibrarySnapshot(updatedLibrary);
        }
        void searchLibrary().catch((error) =>
          setLibraryError(errorMessage(error, '更新搜索索引失败')),
        );
        return true;
      } catch (error) {
        lastSaveErrorRef.current = errorMessage(error, '保存失败');
        setSaveMessage(lastSaveErrorRef.current);
        return false;
      }
    })();
    activeSaveRef.current = task;
    const saved = await task;
    if (activeSaveRef.current === task) activeSaveRef.current = null;
    if (
      saved &&
      draftRef.current.dirty &&
      draftRef.current.revision !== snapshot.revision
    ) {
      return saveDraft(true);
    }
    return saved;
  };

  const leavePlantUmlSession = () => {
    const current = plantUmlSessionRef.current;
    if (!current) return true;
    if (
      current.source !== current.savedSource &&
      !window.confirm(
        current.request.saveTarget === 'file'
          ? '当前 PUML 文件有未保存的修改，仍要切换到其他文件吗？'
          : '当前 PUML 修改尚未同步到 Markdown，仍要切换到其他文件吗？',
      )
    ) {
      return false;
    }
    plantUmlSessionRef.current = null;
    setPlantUmlSession(null);
    return true;
  };

  const parkUnsavedDraft = () => {
    const rootPath = librarySnapshotRef.current?.rootPath ?? '';
    if (
      recoverableDraft &&
      (recoverableDraft.rootPath !== rootPath ||
        recoverableDraft.draft.revision !== draftRef.current.revision ||
        recoverableDraft.draft.relativePath !== draftRef.current.relativePath)
    ) {
      setLibraryError(
        '已有一份未保存草稿，请先恢复并处理，再切换另一份保存失败的导图。',
      );
      return false;
    }
    if (
      !window.confirm(
        `${lastSaveErrorRef.current || '保存失败'}\n\n当前导图未能保存。继续切换会暂存这份草稿，之后可在底部点击“恢复草稿”返回。是否继续？`,
      )
    )
      return false;
    const recovery = { rootPath, draft: draftRef.current };
    setRecoverableDraft(recovery);
    try {
      localStorage.setItem(RECOVERABLE_DRAFT_KEY, JSON.stringify(recovery));
    } catch {
      // Keep the draft in memory for this app session.
    }
    const parked = { ...draftRef.current, dirty: false };
    draftRef.current = parked;
    setEditorDraft(parked);
    setSaveMessage('未保存草稿已暂存');
    return true;
  };

  const canLeaveMindmapDraft = async () =>
    !draftRef.current.dirty || (await saveDraft()) || parkUnsavedDraft();

  const restoreRecoverableDraft = async () => {
    const recovery = recoverableDraft;
    if (!recovery) return;
    if (recovery.rootPath !== librarySnapshotRef.current?.rootPath) {
      setLibraryError('这份草稿属于另一个文件库，请先切回原文件库。');
      return;
    }
    if (draftRef.current.dirty && !(await saveDraft())) {
      setLibraryError('当前导图尚未保存，请先处理后再恢复草稿。');
      return;
    }
    if (!leavePlantUmlSession() || !(await workbench.controller.leave()))
      return;
    installDraft({ ...recovery.draft, dirty: true });
    setActiveWorkspace('mindmap');
    setRecoverableDraft(null);
    try {
      localStorage.removeItem(RECOVERABLE_DRAFT_KEY);
    } catch {
      // The restored draft is already open.
    }
    setSaveMessage('已恢复未保存草稿，请修改标题或分类后保存');
  };

  const openMap = async (
    document: Pick<MapDocument, 'relativePath' | 'kind'>,
    options: { asMindmap?: boolean } = {},
  ) => {
    if (!leavePlantUmlSession()) return false;
    if (document.kind === 'doc' && !options.asMindmap) {
      if (!(await canLeaveMindmapDraft())) return false;
      if (await workbench.controller.openMarkdown(document)) {
        setPreviewDocumentPath(null);
        setActiveWorkspace('knowledge');
        return true;
      }
      return false;
    }
    if (!(await workbench.controller.leave())) return false;
    if (!(await canLeaveMindmapDraft())) return false;
    setSaveMessage('正在打开思维导图…');
    try {
      const opened = await libraryApi.openDocument({
        relativePath: document.relativePath,
      });
      const next = createDraft({
        id: opened.document.id,
        relativePath: opened.document.relativePath,
        title: opened.document.title,
        category: opened.document.category || '未分类',
        mapType: opened.document.mapType || '通用',
        tags: opened.document.tags.join(', '),
        markdown: opened.markdown,
      });
      installDraft(next);
      setPreviewDocumentPath(
        options.asMindmap && opened.document.kind === 'doc'
          ? opened.document.relativePath
          : null,
      );
      setSaveMessage(options.asMindmap ? '文档导图预览 · 只读' : '已打开');
      setLibraryError('');
      return true;
    } catch (error) {
      setLibraryError(errorMessage(error, '打开思维导图失败'));
      setSaveMessage('打开失败');
      return false;
    }
  };

  const showKnowledgeDocuments = async () => {
    if (activeWorkspace === 'knowledge') return;
    if (workbench.controller.getState()?.kind === 'doc') {
      setActiveWorkspace('knowledge');
      return;
    }
    const recent = librarySnapshotRef.current?.documents
      .filter((document) => document.kind === 'doc')
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (recent) {
      await openMap(recent);
    } else {
      setActiveWorkspace('knowledge');
    }
  };

  const loadLibrary = async (openRecent: boolean) => {
    setLibraryBusy(true);
    try {
      const snapshot = await libraryApi.status();
      installLibrarySnapshot(snapshot);
      setLibraryError('');
      setSaveMessage(snapshot.rootPath ? '文件库已就绪' : '请选择文件库目录');
      if (openRecent) {
        const recent = snapshot.documents.find(
          (document) =>
            document.kind ===
            (activeWorkspace === 'knowledge' ? 'doc' : 'mindmap'),
        );
        if (recent) await openMap(recent);
      }
    } catch (error) {
      setLibraryError(errorMessage(error, '无法读取文件库'));
      setSaveMessage('文件库不可用');
    } finally {
      setLibraryBusy(false);
    }
  };

  const chooseLibraryRoot = async () => {
    if (draftRef.current.dirty && !(await saveDraft())) return;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: '选择 Seamind 知识库目录',
      });
      if (typeof selected !== 'string') return;
      if (!leavePlantUmlSession()) return;
      if (!(await workbench.controller.leave())) return;
      const keepKnowledgeWorkspace = activeWorkspace === 'knowledge';
      setLibraryBusy(true);
      const snapshot = await libraryApi.setRoot({
        path: selected,
      });
      installLibrarySnapshot(snapshot);
      setLibraryError('');
      setCategoryFilter('');
      setLibraryQuery('');
      if (keepKnowledgeWorkspace) {
        const firstNote = snapshot.documents.find((doc) => doc.kind === 'doc');
        if (firstNote) await workbench.controller.openMarkdown(firstNote);
        setSaveMessage('文件库已设置');
      } else if (snapshot.documents.some((doc) => doc.kind === 'mindmap')) {
        const firstMindmap = snapshot.documents.find(
          (doc) => doc.kind === 'mindmap',
        );
        if (firstMindmap) await openMap(firstMindmap);
      } else {
        installDraft(
          createDraft({
            title: '新建思维导图',
            category: '未分类',
            markdown: '# 新建思维导图\n\n## 主题\n',
          }),
        );
        setSaveMessage('文件库已设置');
      }
    } catch (error) {
      setLibraryError(errorMessage(error, '设置文件库失败'));
    } finally {
      setLibraryBusy(false);
    }
  };

  const createNewDocument = async () => {
    if (!leavePlantUmlSession()) return;
    if (!(await workbench.controller.leave())) return;
    if (draftRef.current.dirty && !(await saveDraft())) return;
    const revision = draftRef.current.revision + 1;
    const category = categoryFilter || '未分类';
    installDraft(
      createDraft({
        title: '新建思维导图',
        category,
        mapType: category.split('/').at(-1) || '通用',
        markdown: '# 新建思维导图\n\n## 主题\n',
        dirty: true,
        revision,
      }),
    );
    setSaveMessage('正在创建…');
  };

  const prepareForEpubImport = async () => {
    if (pendingEpubImport) {
      if (
        !window.confirm(
          '当前 EPUB 目录草稿还没有保存。继续导入会替换这份草稿，是否继续？',
        )
      )
        return false;
    } else if (draftRef.current.dirty && !(await saveDraft())) {
      return false;
    }
    return leavePlantUmlSession() && (await workbench.controller.leave());
  };

  const importEpubPath = async (
    path: string,
    droppedEpubCount = 1,
    includeAiSummary = false,
  ) => {
    if (epubImportInFlightRef.current) return;
    epubImportInFlightRef.current = true;
    setLibraryBusy(true);
    setSaveMessage('正在读取 EPUB 目录…');
    setLibraryError('');
    try {
      const outline = await epubApi.importToc({ path });
      const currentDraft = draftRef.current;
      const importedDraft = createDraft({
        title: outline.title,
        category: categoryFilter || '未分类',
        mapType: 'EPUB 目录',
        tags: 'EPUB, 目录',
        markdown: outline.markdown,
        dirty: true,
        revision: currentDraft.revision + 1,
      });
      installDraft(importedDraft);
      setPendingEpubImport(true);
      const droppedNotice =
        droppedEpubCount > 1
          ? `（检测到 ${droppedEpubCount} 本 EPUB，本次先导入第一本）`
          : '';
      const sectionNotice =
        outline.sectionCount > 0
          ? `提取正文小节 ${outline.sectionCount} 个，覆盖 ${outline.enrichedChapterCount} 个目录项`
          : '正文未检测到小节标题';
      const skippedNotice =
        outline.skippedChapterCount > 0
          ? `；${outline.skippedChapterCount} 个目录项的小节未能解析`
          : '';
      const warningNotice = outline.warnings[0]
        ? `；提示：${outline.warnings[0]}`
        : '';
      const importNotice = `已从 ${outline.sourceFile} 导入 ${outline.chapterCount} 个目录条目；${sectionNotice}${skippedNotice}${warningNotice}，请检查后保存${droppedNotice}`;
      let aiSummaryNotice = '';
      if (includeAiSummary) {
        setSaveMessage('目录已导入，正在将章节正文发送到当前 AI 模型生成摘要…');
        try {
          const result = await epubApi.summarizeChapters({
            path,
            baseUrl: providerSettings.baseUrl,
            model: providerSettings.model,
            markdown: outline.markdown,
          });
          if (draftRef.current === importedDraft) {
            installDraft({
              ...importedDraft,
              markdown: result.markdown,
              dirty: true,
              revision: importedDraft.revision + 1,
            });
            aiSummaryNotice = `；AI 已生成 ${result.summarizedChapterCount} 章摘要`;
            if (result.truncatedChapterCount > 0) {
              aiSummaryNotice += `（${result.truncatedChapterCount} 章仅使用前约 4000 字）`;
            }
            if (result.unavailableChapterCount > 0) {
              aiSummaryNotice += `；${result.unavailableChapterCount} 章正文未能提取`;
            }
            if (result.notSummarizedChapterCount > 0) {
              aiSummaryNotice += `；${result.notSummarizedChapterCount} 章未获得摘要`;
            }
            if (result.omittedChapterCount > 0) {
              aiSummaryNotice += `；为控制请求范围，跳过 ${result.omittedChapterCount} 章`;
            }
          } else {
            aiSummaryNotice =
              '；AI 摘要已返回，但导入后草稿发生了编辑，未覆盖你的修改';
          }
        } catch (error) {
          aiSummaryNotice = `；AI 摘要失败，仍保留本地目录：${errorMessage(error, '摘要请求失败')}`;
        }
      }
      setSaveMessage(`${importNotice}${aiSummaryNotice}`);
    } catch (error) {
      setLibraryError(errorMessage(error, '导入 EPUB 目录失败'));
      setSaveMessage('EPUB 导入失败');
    } finally {
      epubImportInFlightRef.current = false;
      setLibraryBusy(false);
      setSummarizeEpubOnImport(false);
    }
  };

  const importDroppedEpubs = async (paths: string[]) => {
    const includeAiSummary = summarizeEpubOnImport;
    setSummarizeEpubOnImport(false);
    const epubPaths = paths.filter(isEpubPath);
    if (epubPaths.length === 0) {
      setLibraryError('请拖入 .epub 电子书文件以导入目录。');
      return;
    }
    if (libraryBusy || epubImportInFlightRef.current) {
      setLibraryError('文件库正在处理其他操作，请稍后再导入 EPUB。');
      return;
    }
    if (!(await prepareForEpubImport())) return;
    await importEpubPath(epubPaths[0], epubPaths.length, includeAiSummary);
  };

  epubDropHandlerRef.current = (paths) => {
    void importDroppedEpubs(paths);
  };

  const importEpub = async () => {
    const includeAiSummary = summarizeEpubOnImport;
    setSummarizeEpubOnImport(false);
    if (!(await prepareForEpubImport())) return;
    try {
      const selected = await openDialog({
        multiple: false,
        title: '导入 EPUB 目录',
        filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      });
      if (typeof selected !== 'string') return;
      await importEpubPath(selected, 1, includeAiSummary);
    } catch (error) {
      setLibraryError(errorMessage(error, '导入 EPUB 目录失败'));
      setSaveMessage('EPUB 导入失败');
    }
  };

  const openLibraryEpub = async (book: EpubBookDocument) => {
    if (!leavePlantUmlSession()) return false;
    try {
      const path = await libraryApi.openEpubBook({
        relativePath: book.relativePath,
      });
      epubRestoreAttemptedRef.current = true;
      try {
        localStorage.setItem(LAST_READER_BOOK_KEY, book.relativePath);
      } catch {
        // The current book remains open when browser storage is unavailable.
      }
      setEpubReader({
        source: convertFileSrc(path),
        progressKey: epubProgressKey(book),
        bookId: epubBookIdentity(book.relativePath),
        relativePath: book.relativePath,
        title: book.title,
      });
      setEpubChapterNavigation(null);
      setActiveWorkspace('reader');
      setLibraryError('');
      return true;
    } catch (error) {
      setLibraryError(errorMessage(error, '打开 EPUB 电子书失败'));
      return false;
    }
  };

  const createResourceTask = (resource: TaskResource, title?: string) => {
    taskRequestIdRef.current += 1;
    setTaskCreateRequest({ id: taskRequestIdRef.current, resource, title });
    setActiveWorkspace('tasks');
  };

  const openLinkedTask = (id: string) => {
    setTaskOpenId(id);
    setActiveWorkspace('tasks');
  };

  const createBookTask = (
    book: EpubBookDocument,
    chapter?: { href: string; label: string },
  ) => {
    const rootPath = librarySnapshot?.rootPath;
    if (!rootPath) {
      setLibraryError('请先选择电子书所在的文件库。');
      return;
    }
    createResourceTask(
      {
        kind: 'ebook',
        resourceId: crypto.randomUUID(),
        title: book.title,
        rootPath,
        relativePath: book.relativePath,
        progressKey: epubProgressKey(book),
        bookId: epubBookIdentity(book.relativePath),
        href: chapter?.href || null,
      },
      chapter?.label ? `阅读 ${book.title} · ${chapter.label}` : undefined,
    );
  };

  const openTaskResource = async (resource: TaskResource): Promise<boolean> => {
    if (resource.kind === 'ebook') {
      if (
        !librarySnapshot?.rootPath ||
        librarySnapshot.rootPath !== resource.rootPath
      ) {
        throw new Error('请先切换到这项任务对应的电子书文件库。');
      }
      const book = findLibraryEpubForTask(librarySnapshot.books, resource);
      if (!book) throw new Error('找不到关联电子书，请编辑任务并重新选择。');
      if (
        resource.progressKey &&
        !sameEpubProgressFile(epubProgressKey(book), resource.progressKey)
      ) {
        throw new Error('电子书文件已变化，请编辑任务并确认重新关联。');
      }
      const opened = await openLibraryEpub(book);
      if (opened && resource.href) {
        taskRequestIdRef.current += 1;
        setEpubChapterNavigation({
          id: taskRequestIdRef.current,
          progressKey: epubProgressKey(book),
          href: resource.href,
          label: resource.title,
        });
      }
      return opened;
    }
    taskRequestIdRef.current += 1;
    setPlayerOpenTaskVideoRequest({
      id: taskRequestIdRef.current,
      videoId: resource.resourceId,
      title: resource.title,
      startSeconds: resource.startSeconds ?? 0,
    });
    setPlayerOpened(true);
    setActiveWorkspace('player');
    return true;
  };

  const openYouTubeVideoInPlayer = (
    videoId: string,
    startSeconds: number,
    fallbackTitle?: string,
  ) => {
    taskRequestIdRef.current += 1;
    setPlayerOpenTaskVideoRequest({
      id: taskRequestIdRef.current,
      videoId,
      title: fallbackTitle?.trim() || 'YouTube 视频',
      startSeconds: Math.max(0, Math.floor(startSeconds)),
    });
    setPlayerOpened(true);
    setActiveWorkspace('player');
  };

  const openLibraryPlantUml = async (file: PlantUmlDocument) => {
    if (!(await workbench.controller.leave())) return;
    try {
      const source = await libraryApi.openPlantUml({
        relativePath: file.relativePath,
      });
      openPlantUmlWorkspace({
        source,
        language: 'puml',
        saveTarget: 'file',
        cacheKey: `file:${file.relativePath}`,
        documentTitle: file.title,
        onSave: async (nextSource) => {
          const saved = await libraryApi.savePlantUml({
            relativePath: file.relativePath,
            source: nextSource,
          });
          const snapshot = librarySnapshotRef.current;
          if (snapshot) {
            installLibrarySnapshot({
              ...snapshot,
              plantumlFiles: snapshot.plantumlFiles.map((candidate) =>
                candidate.relativePath === saved.relativePath
                  ? saved
                  : candidate,
              ),
            });
          }
          setLibraryError('');
          setSaveMessage('PUML 文件已保存');
        },
      });
      setLibraryError('');
    } catch (error) {
      setLibraryError(errorMessage(error, '打开 PUML 文件失败'));
    }
  };

  const deleteLibraryPlantUmlFile = async (file: PlantUmlDocument) => {
    try {
      await libraryApi.deletePlantUml({
        relativePath: file.relativePath,
      });
      const snapshot = librarySnapshotRef.current;
      if (snapshot) {
        installLibrarySnapshot({
          ...snapshot,
          plantumlFiles: snapshot.plantumlFiles.filter(
            (candidate) => candidate.relativePath !== file.relativePath,
          ),
        });
      }
      setLibraryError('');
      setSaveMessage('PUML 文件已删除');
    } catch (error) {
      setLibraryError(errorMessage(error, '删除 PUML 文件失败'));
    }
  };

  const openLibraryTextDocument = async (file: TextDocument) => {
    if (!leavePlantUmlSession()) return;
    if (!(await canLeaveMindmapDraft())) return;
    if (await workbench.controller.openDiagram(file))
      setActiveWorkspace('mindmap');
  };

  // The knowledge page has its own layout, so opening or creating a note there stays on that page.
  const openKnowledgeNote = async (note: MapDocument) => {
    if (!leavePlantUmlSession()) return;
    if (!(await canLeaveMindmapDraft())) return;
    await workbench.controller.openMarkdown(note);
  };
  agentHostRef.current.loadLibrary = loadLibrary;
  agentHostRef.current.openKnowledgeNote = openKnowledgeNote;

  const createKnowledgeNote = async (
    folder: string,
    template?: KnowledgeNoteTemplate,
  ) => {
    if (!librarySnapshotRef.current?.rootPath) {
      setLibraryError('请先选择文件库目录，再新建笔记。');
      return;
    }
    if (!leavePlantUmlSession()) return;
    if (draftRef.current.dirty && !(await saveDraft())) return;
    if (template) {
      await workbench.controller.createCustomDocument({
        kind: 'doc',
        category: folder,
        title: template.titlePrefix,
        source: template.source,
        tags: template.tags,
      });
      return;
    }
    await workbench.controller.createDocument('doc', folder);
  };

  const upsertSavedInLibrary = (doc: MapDocument) => {
    const latestSnapshot = librarySnapshotRef.current;
    if (!latestSnapshot) return;
    const categories = new Set(latestSnapshot.categories);
    const parts = doc.category.split('/').filter(Boolean);
    for (let idx = 1; idx <= parts.length; idx += 1) {
      categories.add(parts.slice(0, idx).join('/'));
    }
    installLibrarySnapshot({
      ...latestSnapshot,
      categories: [...categories].sort(),
      documents: [
        doc,
        ...latestSnapshot.documents.filter(
          (candidate) =>
            candidate.relativePath !== doc.relativePath &&
            candidate.id !== doc.id,
        ),
      ],
    });
  };

  const exportTranscriptToKnowledge = async (
    payload: TranscriptKnowledgeExportPayload,
  ): Promise<TranscriptKnowledgeExportResult> => {
    if (!librarySnapshotRef.current?.rootPath) {
      throw new Error('请先在顶部或知识库中选择文件库目录，再导出字幕文档。');
    }

    // 智能去重：检查知识库是否已存在同视频的字幕或笔记文档，避免盲目派生同名副本
    const existingDoc = librarySnapshotRef.current?.documents.find(
      (candidate) =>
        candidate.kind === 'doc' &&
        candidate.sourceRef?.videoId === payload.videoId &&
        (candidate.mapType === '视频字幕' || candidate.origin === 'player'),
    );

    const input: SaveDocumentInput = {
      id: existingDoc ? existingDoc.id : null,
      relativePath: existingDoc ? existingDoc.relativePath : null,
      title: existingDoc ? existingDoc.title : payload.title,
      category: existingDoc?.category || payload.category,
      mapType: '视频字幕',
      tags: payload.tags,
      markdown: payload.markdown,
      historySource: 'manual',
      kind: 'doc',
      origin: 'player',
      sourceRef: {
        videoId: payload.videoId,
        videoUrl: `https://www.youtube.com/watch?v=${payload.videoId}`,
        channelName: payload.channelName,
      },
    };
    let currentDoc = await libraryApi.saveDocument({ input });
    upsertSavedInLibrary(currentDoc);
    void searchLibrary().catch(() => undefined);
    setLibraryError('');
    setSaveMessage(
      existingDoc
        ? `已更新视频字幕笔记「${currentDoc.title}」`
        : `已导出视频字幕至知识库「${currentDoc.title}」`,
    );

    return {
      id: currentDoc.id,
      title: currentDoc.title,
      category: currentDoc.category || payload.category,
      relativePath: currentDoc.relativePath,
      open: () => {
        void (async () => {
          await openKnowledgeNote(currentDoc);
          setActiveWorkspace('knowledge');
        })();
      },
      updateMarkdown: async (nextMarkdown: string, statusLabel?: string) => {
        if (
          !workbench.controller.canSyncSavedMarkdown(currentDoc.relativePath)
        ) {
          throw new Error(
            '知识库文档有未保存的编辑，已停止后续阶段精修以保护你的修改。',
          );
        }
        const isPlayerManualEdit = statusLabel === '播放器手动编辑';
        const transcriptTags = isPlayerManualEdit
          ? currentDoc.tags
          : Array.from(new Set([...currentDoc.tags, 'AI精修']));
        const updateInput: SaveDocumentInput = {
          id: currentDoc.id,
          relativePath: currentDoc.relativePath,
          title: currentDoc.title,
          category: currentDoc.category || payload.category,
          mapType: '视频字幕',
          tags: transcriptTags.length > 0 ? transcriptTags : payload.tags,
          markdown: nextMarkdown,
          historySource: isPlayerManualEdit ? 'manual' : 'ai',
          kind: 'doc',
        };
        currentDoc = await libraryApi.saveDocument({
          input: updateInput,
        });
        upsertSavedInLibrary(currentDoc);
        workbench.controller.syncSavedMarkdown(
          currentDoc.relativePath,
          nextMarkdown,
          statusLabel,
        );
        if (statusLabel) {
          setSaveMessage(statusLabel);
        }
      },
    };
  };

  const saveVideoNoteToKnowledge = async (payload: {
    videoId: string;
    videoTitle: string;
    channelName?: string;
    markdown: string;
  }): Promise<TranscriptKnowledgeExportResult> => {
    if (!librarySnapshotRef.current?.rootPath) {
      throw new Error('请先在顶部或知识库中选择文件库目录，再保存文稿笔记。');
    }
    const cleanVideoId = payload.videoId.trim();
    const existingDoc = librarySnapshotRef.current?.documents.find(
      (candidate) =>
        candidate.kind === 'doc' &&
        candidate.sourceRef?.videoId === cleanVideoId,
    );
    const safeTitle = sanitizeTranscriptNoteTitle(
      payload.videoTitle,
      cleanVideoId,
    );
    const cleanChannel = payload.channelName?.trim() || '';
    const category =
      existingDoc?.category ||
      (cleanChannel ? `视频笔记/${cleanChannel}` : '视频笔记');
    const tags = Array.from(
      new Set(
        [
          'YouTube',
          '观看笔记',
          cleanChannel,
          ...(existingDoc?.tags ?? []),
        ].filter(Boolean),
      ),
    );

    const input: SaveDocumentInput = {
      id: existingDoc ? existingDoc.id : null,
      relativePath: existingDoc ? existingDoc.relativePath : null,
      title: existingDoc ? existingDoc.title : safeTitle,
      category,
      mapType: existingDoc?.mapType || '观看笔记',
      tags,
      markdown: payload.markdown,
      historySource: 'manual',
      kind: 'doc',
      origin: 'player',
      sourceRef: {
        videoId: cleanVideoId,
        videoUrl: `https://www.youtube.com/watch?v=${cleanVideoId}`,
        channelName: cleanChannel,
      },
    };
    let currentDoc = await libraryApi.saveDocument({ input });
    upsertSavedInLibrary(currentDoc);
    void searchLibrary().catch(() => undefined);
    setLibraryError('');
    setSaveMessage(
      existingDoc
        ? `已同步文稿笔记至知识库「${currentDoc.title}」`
        : `已将文稿笔记沉淀至知识库「${currentDoc.title}」`,
    );

    return {
      id: currentDoc.id,
      title: currentDoc.title,
      category: currentDoc.category || category,
      relativePath: currentDoc.relativePath,
      open: () => {
        void (async () => {
          await openKnowledgeNote(currentDoc);
          setActiveWorkspace('knowledge');
        })();
      },
      updateMarkdown: async (nextMarkdown: string, statusLabel?: string) => {
        if (
          !workbench.controller.canSyncSavedMarkdown(currentDoc.relativePath)
        ) {
          throw new Error(
            '知识库文档有未保存的编辑，已暂停自动同步以保护你的修改。',
          );
        }
        const updateInput: SaveDocumentInput = {
          id: currentDoc.id,
          relativePath: currentDoc.relativePath,
          title: currentDoc.title,
          category: currentDoc.category || category,
          mapType: currentDoc.mapType || '观看笔记',
          tags: currentDoc.tags.length > 0 ? currentDoc.tags : tags,
          markdown: nextMarkdown,
          historySource: 'manual',
          kind: 'doc',
          origin: 'player',
          sourceRef: currentDoc.sourceRef,
        };
        currentDoc = await libraryApi.saveDocument({
          input: updateInput,
        });
        upsertSavedInLibrary(currentDoc);
        workbench.controller.syncSavedMarkdown(
          currentDoc.relativePath,
          nextMarkdown,
          statusLabel,
        );
        if (statusLabel) {
          setSaveMessage(statusLabel);
        }
      },
    };
  };

  const findVideoKnowledgeDocument = useCallback(
    async (videoId: string): Promise<PlayerExportedDocument | null> => {
      const cleanVideoId = videoId.trim();
      if (!cleanVideoId) return null;
      const doc = librarySnapshotRef.current?.documents.find(
        (candidate) =>
          candidate.kind === 'doc' &&
          candidate.sourceRef?.videoId === cleanVideoId,
      );
      if (!doc) return null;
      try {
        const opened = await libraryApi.openDocument({
          relativePath: doc.relativePath,
        });
        let currentDoc = doc;
        return {
          id: currentDoc.id,
          title: currentDoc.title,
          category: currentDoc.category,
          markdown: opened.markdown,
          openKnowledge: () => {
            void (async () => {
              await openKnowledgeNote(currentDoc);
              setActiveWorkspace('knowledge');
            })();
          },
          updateMarkdown: async (
            nextMarkdown: string,
            statusLabel?: string,
          ) => {
            if (
              !workbench.controller.canSyncSavedMarkdown(
                currentDoc.relativePath,
              )
            ) {
              throw new Error(
                '知识库文档有未保存的编辑，已暂停自动同步以保护你的修改。',
              );
            }
            const updateInput: SaveDocumentInput = {
              id: currentDoc.id,
              relativePath: currentDoc.relativePath,
              title: currentDoc.title,
              category: currentDoc.category,
              mapType: currentDoc.mapType || '观看笔记',
              tags: currentDoc.tags,
              markdown: nextMarkdown,
              historySource: 'manual',
              kind: 'doc',
              origin: 'player',
              sourceRef: currentDoc.sourceRef,
            };
            currentDoc = await libraryApi.saveDocument({
              input: updateInput,
            });
            upsertSavedInLibrary(currentDoc);
            workbench.controller.syncSavedMarkdown(
              currentDoc.relativePath,
              nextMarkdown,
              statusLabel,
            );
            if (statusLabel) {
              setSaveMessage(statusLabel);
            }
          },
        };
      } catch {
        return null;
      }
    },
    [],
  );

  const createKnowledgeCategory = async (
    rawCategory: string,
  ): Promise<boolean> => {
    const clean = rawCategory.trim();
    if (!clean) return false;
    if (!librarySnapshotRef.current?.rootPath) {
      setLibraryError('请先选择文件库目录，再新建分类。');
      return false;
    }
    try {
      const snapshot = await libraryApi.createCategory({
        category: clean,
        kind: 'doc',
      });
      installLibrarySnapshot(snapshot);
      setLibraryError('');
      setSaveMessage(`已创建分类「${clean}」`);
      return true;
    } catch (error) {
      setLibraryError(errorMessage(error, '创建分类失败'));
      return false;
    }
  };

  const openWikilinkTarget = async (rawTarget: string) => {
    const cleanTarget = rawTarget.trim();
    if (!cleanTarget) return;
    const found = findWikilinkTarget(
      cleanTarget,
      librarySnapshotRef.current?.documents ?? [],
    );
    if (found?.kind === 'doc') {
      if (activeWorkspace === 'knowledge') {
        await openKnowledgeNote(found);
      } else {
        await openMap(found);
      }
      return;
    }
    if (found?.kind === 'mindmap') {
      await openMap(found);
      setActiveWorkspace('mindmap');
      return;
    }
    if (!librarySnapshotRef.current?.rootPath) {
      setLibraryError('请先选择文件库目录，再创建双链笔记。');
      return;
    }
    if (!leavePlantUmlSession()) return;
    if (draftRef.current.dirty && !(await saveDraft())) return;
    const currentCategory =
      workbench.controller.getState()?.category || categoryFilter || '未分类';
    await workbench.controller.createCustomDocument({
      kind: 'doc',
      category: currentCategory,
      title: cleanTarget,
      source: `# ${cleanTarget}\n\n`,
    });
  };

  // Opening a note as a mind map from the knowledge page shows the mind map on its own workspace.
  const openKnowledgeNoteAsMindmap = async () => {
    await openActiveDocumentAsMindmap();
  };

  const deleteLibraryTextDocument = async (file: TextDocument) => {
    try {
      // A save that is still running must not bring the file back once it is deleted.
      if (workbench.controller.getState()?.relativePath === file.relativePath)
        await workbench.controller.discard();
      await libraryApi.deleteTextDocument({ relativePath: file.relativePath });
      const snapshot = librarySnapshotRef.current;
      if (snapshot) {
        installLibrarySnapshot({
          ...snapshot,
          textDocuments: snapshot.textDocuments.filter(
            (candidate) => candidate.relativePath !== file.relativePath,
          ),
        });
      }
      setLibraryError('');
      setSaveMessage('图表文件已删除');
    } catch (error) {
      setLibraryError(errorMessage(error, '删除图表文件失败'));
    }
  };

  // The "新建" menu: a file of the chosen kind, from its template, in the current folder.
  const createFileOfKind = async (kind: NewFileKind) => {
    if (!librarySnapshotRef.current?.rootPath) {
      setLibraryError('请先选择文件库目录，再新建文件。');
      return;
    }
    if (!leavePlantUmlSession()) return;
    if (draftRef.current.dirty && !(await saveDraft())) return;
    const category = categoryFilter || '未分类';
    if (kind === 'plantuml') {
      if (!(await workbench.controller.leave())) return;
      try {
        const template = NEW_FILE_TEMPLATES.plantuml;
        const created = await libraryApi.createPlantUml({
          category,
          title: template.title,
          source: template.source,
        });
        const snapshot = librarySnapshotRef.current;
        if (snapshot) {
          installLibrarySnapshot({
            ...snapshot,
            plantumlFiles: [
              created,
              ...snapshot.plantumlFiles.filter(
                (candidate) => candidate.relativePath !== created.relativePath,
              ),
            ],
          });
        }
        await openLibraryPlantUml(created);
      } catch (error) {
        setLibraryError(errorMessage(error, '新建 PlantUML 图表失败'));
      }
      return;
    }
    if (await workbench.controller.createDocument(kind, category))
      setActiveWorkspace(kind === 'doc' ? 'knowledge' : 'mindmap');
  };

  const openActiveDocumentAsMindmap = async () => {
    const current = workbench.controller.getState();
    if (current?.kind !== 'doc') return false;
    if (!(await workbench.controller.leave())) return false;
    const opened = await openMap(
      { relativePath: current.relativePath, kind: 'doc' },
      { asMindmap: true },
    );
    if (opened) setActiveWorkspace('mindmap');
    return opened;
  };

  const convertActiveDocumentToMindmap = async () => {
    if (
      !window.confirm(
        '转为思维导图后，这份文档会按思维导图打开，内容不变。继续吗？',
      )
    )
      return;
    const converted = await workbench.controller.convertToMindmap();
    if (converted) {
      await openMap(converted);
      setActiveWorkspace('mindmap');
    }
  };

  const handleGalaxySelectNode = async (node: GalaxyNode) => {
    if (epubReader && (node.chapterHref || node.footnoteData?.cfi)) {
      setEpubChapterNavigation({
        id: ++epubChapterNavigationIdRef.current,
        progressKey: epubReader.progressKey,
        href: node.chapterHref,
        cfi: node.footnoteData?.cfi,
        annotationId: node.footnoteData?.annotationId,
        label:
          node.kind === 'footnote'
            ? node.parentChapter || node.label
            : node.label,
      });
    }

    const snapshot = librarySnapshotRef.current;
    if (!epubReader || !snapshot) return;

    const book = snapshot.books.find(
      (candidate) =>
        normalizeLibraryPath(candidate.relativePath) ===
        normalizeLibraryPath(epubReader.relativePath),
    );
    if (!book) return;

    try {
      if (node.kind === 'sun') {
        const target = resolveBookKnowledgeTarget(snapshot, book);
        if (target.document) {
          await openKnowledgeNote(target.document);
        } else {
          const starter = createBookKnowledgeStarter({ title: book.title });
          await workbench.controller.createCustomDocument({
            kind: 'doc',
            category: target.category,
            title: target.title,
            source: starter,
            tags: ['读书笔记', '电子书'],
            origin: 'ebook',
            sourceRef: { bookRelativePath: book.relativePath },
          });
        }
      } else if (node.kind === 'footnote') {
        const fnData = node.footnoteData;
        const explicitPath =
          fnData?.notePath ?? fnData?.syncedNotePath ?? node.notePath;
        const jumpKey = fnData?.footnoteKey ?? fnData?.syncedFootnoteKey;
        const explicitDoc = explicitPath
          ? snapshot.documents.find(
              (doc) =>
                doc.kind === 'doc' &&
                normalizeLibraryPath(doc.relativePath) ===
                  normalizeLibraryPath(explicitPath),
            )
          : undefined;

        if (explicitDoc) {
          await openKnowledgeNote(explicitDoc);
          if (jumpKey) {
            setDocFootnoteJump({
              relativePath: explicitDoc.relativePath,
              id: jumpKey,
              nonce: Date.now(),
            });
          }
        } else {
          const chapterHierarchy =
            node.hierarchy.length > 0 ? node.hierarchy.slice(0, -1) : [];
          const chapterLabel =
            node.parentChapter ||
            chapterHierarchy[chapterHierarchy.length - 1] ||
            '';

          if (chapterLabel && chapterLabel !== book.title) {
            const target = resolveBookChapterKnowledgeTarget(snapshot, book, {
              label: chapterLabel,
              href: node.chapterHref,
              hierarchy: chapterHierarchy,
              cfi: fnData?.cfi,
            });
            if (target.document) {
              await openKnowledgeNote(target.document);
            } else {
              const starter = createChapterKnowledgeStarter({
                bookTitle: book.title,
                chapterTitle: chapterLabel,
                parentChapter: chapterHierarchy[0],
                chapterHref: node.chapterHref,
                chapterIndex: node.chapterIndex,
                cfi: fnData?.cfi,
              });
              await workbench.controller.createCustomDocument({
                kind: 'doc',
                category: target.category,
                title: target.title,
                source: starter,
                tags: ['读书笔记', '电子书'],
                origin: 'ebook',
                sourceRef: {
                  bookRelativePath: book.relativePath,
                  chapterHref: node.chapterHref,
                  chapterCfi: fnData?.cfi,
                },
              });
            }
            if (jumpKey) {
              setDocFootnoteJump({
                relativePath: target.relativePath,
                id: jumpKey,
                nonce: Date.now(),
              });
            }
          } else {
            const target = resolveBookKnowledgeTarget(snapshot, book);
            if (target.document) {
              await openKnowledgeNote(target.document);
            } else {
              const starter = createBookKnowledgeStarter({ title: book.title });
              await workbench.controller.createCustomDocument({
                kind: 'doc',
                category: target.category,
                title: target.title,
                source: starter,
                tags: ['读书笔记', '电子书'],
                origin: 'ebook',
                sourceRef: { bookRelativePath: book.relativePath },
              });
            }
            if (jumpKey) {
              setDocFootnoteJump({
                relativePath: target.relativePath,
                id: jumpKey,
                nonce: Date.now(),
              });
            }
          }
        }
      } else {
        const target = resolveBookChapterKnowledgeTarget(snapshot, book, {
          label: node.label,
          href: node.chapterHref,
          hierarchy: node.hierarchy,
        });

        if (target.document) {
          await openKnowledgeNote(target.document);
        } else {
          const starter = createChapterKnowledgeStarter({
            bookTitle: book.title,
            chapterTitle: node.label,
            parentChapter: node.parentChapter,
            chapterHref: node.chapterHref,
            chapterIndex: node.chapterIndex,
          });
          await workbench.controller.createCustomDocument({
            kind: 'doc',
            category: target.category,
            title: target.title,
            source: starter,
            tags: ['读书笔记', '电子书'],
            origin: 'ebook',
            sourceRef: {
              bookRelativePath: book.relativePath,
              chapterHref: node.chapterHref,
            },
          });
        }
      }
      setGalaxyViewActive(false);
    } catch (err) {
      setLibraryError(errorMessage(err, '切换章节笔记失败。'));
    }
  };

  const handleWriteEpubFootnoteToNote = async (payload: {
    annotation: EpubAnnotation;
    chapterLabel: string;
    chapterHref: string;
    chapterHierarchy: string[];
  }) => {
    const selection = epubReader;
    const snapshot = librarySnapshotRef.current;
    if (!selection || !snapshot?.rootPath) {
      setLibraryError('请先打开文件库中的电子书，再写入章节笔记。');
      return;
    }
    const book = snapshot.books.find(
      (candidate) =>
        normalizeLibraryPath(candidate.relativePath) ===
        normalizeLibraryPath(selection.relativePath),
    );
    if (!book) {
      setLibraryError('当前 EPUB 已不在文件库中，请从书架重新打开。');
      return;
    }

    setBookKnowledgeBusy(true);
    setLibraryError('');
    try {
      const target = payload.chapterLabel
        ? resolveBookChapterKnowledgeTarget(snapshot, book, {
            label: payload.chapterLabel,
            href: payload.chapterHref,
            hierarchy: payload.chapterHierarchy,
            cfi: payload.annotation.cfi,
          })
        : resolveBookKnowledgeTarget(snapshot, book);

      if (target.document) {
        await openKnowledgeNote(target.document);
      } else {
        const starter = payload.chapterLabel
          ? createChapterKnowledgeStarter({
              bookTitle: book.title,
              creator: loadEpubBookMetadata(selection.progressKey)?.author,
              chapterTitle: payload.chapterLabel,
              parentChapter: payload.chapterHierarchy?.[0],
              chapterHref: payload.chapterHref,
              cfi: payload.annotation.cfi,
            })
          : createBookKnowledgeStarter({ title: book.title });
        await workbench.controller.createCustomDocument({
          kind: 'doc',
          category: target.category,
          title: target.title,
          source: starter,
          tags: ['读书笔记', '电子书'],
          origin: 'ebook',
          sourceRef: {
            bookRelativePath: book.relativePath,
            chapterHref: payload.chapterHref,
            chapterCfi: payload.annotation.cfi,
          },
        });
      }

      const currentDoc = workbench.controller.getState();
      if (!currentDoc || currentDoc.kind !== 'doc') {
        return;
      }
      if (
        target.document &&
        normalizeLibraryPath(currentDoc.relativePath) !==
          normalizeLibraryPath(target.document.relativePath)
      ) {
        return;
      }

      const appended = appendEpubFootnoteToMarkdown(currentDoc.source, {
        annotationId: payload.annotation.id,
        quote: payload.annotation.text,
        note: payload.annotation.note,
        aiAnalysis: payload.annotation.aiAnalysis,
        chapterLabel: payload.chapterLabel || payload.annotation.label,
      });

      workbench.controller.edit(appended.nextSource);
      await workbench.controller.save({ manual: true });
      const resolvedPath =
        workbench.controller.getState()?.relativePath ??
        currentDoc.relativePath ??
        target.relativePath;

      setBookNoteMarkdownCache((prev) => ({
        ...prev,
        [resolvedPath]: appended.nextSource,
      }));
      saveEpubKnowledgePath(snapshot.rootPath, book.relativePath, resolvedPath);
      setReaderKnowledgeOpen(true);
      setGalaxyViewActive(false);
      setActiveWorkspace('reader');
      setDocFootnoteJump({
        relativePath: resolvedPath,
        id: appended.footnoteId,
        nonce: Date.now(),
      });
      setSaveMessage(
        appended.isUpdate
          ? `已更新右侧笔记脚注 [^${appended.footnoteId}]`
          : `已写入右侧笔记脚注 [^${appended.footnoteId}]`,
      );
    } catch (error) {
      setLibraryError(errorMessage(error, '写入章节笔记脚注失败。'));
    } finally {
      setBookKnowledgeBusy(false);
    }
  };

  const toggleBookKnowledge = async () => {
    if (readerKnowledgeOpen) {
      setReaderKnowledgeOpen(false);
      return;
    }

    const selection = epubReader;
    const snapshot = librarySnapshotRef.current;
    if (!selection || !snapshot?.rootPath) {
      setLibraryError('请先打开文件库中的电子书，再关联知识库笔记。');
      return;
    }
    const book = snapshot.books.find(
      (candidate) =>
        normalizeLibraryPath(candidate.relativePath) ===
        normalizeLibraryPath(selection.relativePath),
    );
    if (!book) {
      setLibraryError('当前 EPUB 已不在文件库中，请从书架重新打开。');
      return;
    }

    setBookKnowledgeBusy(true);
    setLibraryError('');
    try {
      const chapterQuery = currentEpubChapter?.chapterLabel
        ? {
            label: currentEpubChapter.chapterLabel,
            href: currentEpubChapter.chapterHref,
            hierarchy: currentEpubChapter.chapterHierarchy,
            cfi: currentEpubChapter.cfi,
          }
        : null;

      const target = chapterQuery
        ? resolveBookChapterKnowledgeTarget(snapshot, book, chapterQuery)
        : resolveBookKnowledgeTarget(snapshot, book);

      if (target.document) {
        await openKnowledgeNote(target.document);
        saveEpubKnowledgePath(
          snapshot.rootPath,
          book.relativePath,
          target.document.relativePath,
        );
      } else {
        const starter = chapterQuery
          ? createChapterKnowledgeStarter({
              bookTitle: book.title,
              creator: loadEpubBookMetadata(selection.progressKey)?.author,
              chapterTitle: chapterQuery.label,
              parentChapter: chapterQuery.hierarchy?.[0],
              chapterHref: chapterQuery.href,
              cfi: chapterQuery.cfi,
            })
          : createBookKnowledgeStarter({
              title: book.title,
            });
        await workbench.controller.createCustomDocument({
          kind: 'doc',
          category: target.category,
          title: target.title,
          source: starter,
          tags: ['读书笔记', '电子书'],
          origin: 'ebook',
          sourceRef: {
            bookRelativePath: book.relativePath,
            chapterHref: chapterQuery?.href,
            chapterCfi: chapterQuery?.cfi,
          },
        });
        saveEpubKnowledgePath(
          snapshot.rootPath,
          book.relativePath,
          target.relativePath,
        );
      }
      setReaderKnowledgeOpen(true);
      setActiveWorkspace('reader');
    } catch (error) {
      setLibraryError(errorMessage(error, '打开知识库笔记失败。'));
    } finally {
      setBookKnowledgeBusy(false);
    }
  };

  const toggleBookMindmap = async () => {
    if (readerSplitOpen) {
      setReaderSplitOpen(false);
      return;
    }

    const selection = epubReader;
    const snapshot = librarySnapshotRef.current;
    if (!selection || !snapshot?.rootPath) {
      setLibraryError('请先打开文件库中的电子书，再生成书籍导图。');
      return;
    }
    const book = snapshot.books.find(
      (candidate) =>
        normalizeLibraryPath(candidate.relativePath) ===
        normalizeLibraryPath(selection.relativePath),
    );
    if (!book) {
      setLibraryError('当前 EPUB 已不在文件库中，请从书架重新打开。');
      return;
    }

    setBookMindmapBusy(true);
    setLibraryError('');
    try {
      const target = resolveBookMindmapTarget(snapshot, book);
      if (
        !target.document &&
        normalizeLibraryPath(draftRef.current.relativePath ?? '') ===
          normalizeLibraryPath(target.relativePath)
      ) {
        if (draftRef.current.dirty && !(await saveDraft())) return;
        saveEpubMindmapPath(
          snapshot.rootPath,
          book.relativePath,
          draftRef.current.relativePath ?? target.relativePath,
        );
        setMarkdownFullscreen(false);
        setReaderSplitOpen(true);
        setActiveWorkspace('reader');
        return;
      }
      if (target.document) {
        await openMap(target.document);
        if (
          normalizeLibraryPath(draftRef.current.relativePath ?? '') !==
          normalizeLibraryPath(target.document.relativePath)
        ) {
          return;
        }
        saveEpubMindmapPath(
          snapshot.rootPath,
          book.relativePath,
          target.document.relativePath,
        );
      } else {
        if (draftRef.current.dirty && !(await saveDraft())) return;
        const path = await libraryApi.openEpubBook({
          relativePath: book.relativePath,
        });
        const outline = await epubApi.importToc({ path });
        const title = target.title;
        const markdown = outline.markdown.trim() || `# ${title}\n`;
        const next = createDraft({
          id: null,
          relativePath: target.relativePath,
          title,
          category: 'books',
          mapType: '电子书导图',
          tags: 'EPUB, 书籍导图',
          markdown,
          dirty: true,
          revision: draftRef.current.revision + 1,
        });
        installDraft(next);
      }

      setMarkdownFullscreen(false);
      setReaderSplitOpen(true);
      setActiveWorkspace('reader');
      if (!target.document) {
        const saved = await saveDraft(true);
        if (saved) {
          saveEpubMindmapPath(
            snapshot.rootPath,
            book.relativePath,
            draftRef.current.relativePath ?? target.relativePath,
          );
        }
      }
    } catch (error) {
      setLibraryError(errorMessage(error, '生成书籍思维导图失败'));
      setSaveMessage('生成书籍导图失败');
    } finally {
      setBookMindmapBusy(false);
    }
  };

  const deleteLibraryEpubBook = async (book: EpubBookDocument) => {
    await libraryApi.deleteEpubBook({ relativePath: book.relativePath });
    const snapshot = librarySnapshotRef.current;
    if (snapshot) {
      installLibrarySnapshot({
        ...snapshot,
        books: snapshot.books.filter(
          (candidate) => candidate.relativePath !== book.relativePath,
        ),
      });
    }
    try {
      if (localStorage.getItem(LAST_READER_BOOK_KEY) === book.relativePath) {
        localStorage.removeItem(LAST_READER_BOOK_KEY);
      }
    } catch {
      // The EPUB file is already removed if browser storage is unavailable.
    }
  };

  const importEpubBook = async () => {
    if (!librarySnapshot?.rootPath) {
      setLibraryError('请先选择文件库位置，再导入电子书。');
      return;
    }

    try {
      const selected = await openDialog({
        multiple: false,
        title: '导入电子书到书架',
        filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      });
      if (typeof selected !== 'string') return;

      setLibraryBusy(true);
      setLibraryError('');
      setSaveMessage('正在保存 EPUB 到书架…');
      const imported = await libraryApi.importEpubBook({
        sourcePath: selected,
      });
      const snapshot = await libraryApi.status();
      installLibrarySnapshot(snapshot);
      const book =
        snapshot.books.find(
          (candidate) => candidate.relativePath === imported.relativePath,
        ) ?? imported;
      setSaveMessage('电子书已保存到书架');
      await openLibraryEpub(book);
    } catch (error) {
      setLibraryError(errorMessage(error, '导入 EPUB 电子书失败'));
      setSaveMessage('EPUB 导入失败');
    } finally {
      setLibraryBusy(false);
    }
  };

  const insertSvgTemplate = () => {
    const template = [
      '```svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="130" viewBox="0 0 220 130">',
      '  <rect x="8" y="8" width="204" height="114" rx="12" fill="#f3f6f7" stroke="#758a96" stroke-width="3"/>',
      '  <circle cx="110" cy="65" r="24" fill="#d76e49"/>',
      '</svg>',
      '```',
    ].join('\n');
    const markdown = draftRef.current.markdown.trimEnd();
    patchDraft({
      markdown: `${markdown ? `${markdown}\n\n` : ''}${template}\n`,
    });
    setSaveMessage('已插入 SVG 模板');
  };

  const importHtmlAsset = async () => {
    if (htmlImportBusy) return;
    if (!librarySnapshotRef.current?.rootPath) {
      setLibraryError('请先设置文件库，再导入 HTML 文件。');
      return;
    }
    setLibraryError('');
    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: '导入 HTML 组件',
        filters: [{ name: 'HTML 文件', extensions: ['html', 'htm'] }],
      });
      if (typeof selected !== 'string') return;
      if (!(await saveDraft(true))) return;
      const current = draftRef.current;
      if (!current.relativePath) {
        setLibraryError('请先保存当前思维导图，再导入 HTML 组件。');
        return;
      }

      setHtmlImportBusy(true);
      setSaveMessage('正在导入 HTML 资源…');
      const imported = await libraryApi.importHtmlAsset({
        documentRelativePath: current.relativePath,
        sourcePath: selected,
      });
      const card: HtmlCardDefinition = {
        ...imported,
        width: 420,
        height: 260,
      };
      const cardFence = `\`\`\`seamind-html-card\n${JSON.stringify(card, null, 2)}\n\`\`\``;
      const markdown = current.markdown.trimEnd();
      patchDraft({
        markdown: `${markdown ? `${markdown}\n\n` : ''}${cardFence}\n`,
      });
      setSaveMessage('HTML 组件已插入思维导图');
      setLibraryError('');
    } catch (error) {
      setLibraryError(errorMessage(error, '导入 HTML 组件失败'));
      setSaveMessage('HTML 导入失败');
    } finally {
      setHtmlImportBusy(false);
    }
  };

  const closeHtmlPreview = () => {
    setHtmlPreview(null);
    setHtmlPreviewSrc('');
    setHtmlPreviewError('');
  };

  const embedHtmlPreviewInCanvas = () => {
    if (!htmlPreview || !htmlPreviewSrc) return;
    setHtmlCanvasEmbed({ ...htmlPreview, src: htmlPreviewSrc });
    closeHtmlPreview();
  };

  const closeYouTubePreview = () => setYoutubePreview(null);
  useEffect(() => installYouTubeDebugHook(setYoutubePreview), []);

  const createCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!categoryDraft.trim()) return;
    try {
      const normalizedCategory = categoryDraft
        .trim()
        .replaceAll('\\', '/')
        .split('/')
        .map((part) => part.trim())
        .join('/');
      const snapshot = await libraryApi.createCategory({
        category: categoryDraft.trim(),
        kind: 'mindmap',
      });
      installLibrarySnapshot(snapshot);
      setCategoryFilter(normalizedCategory);
      setCategoryDraft('');
      setCategoryDialogOpen(false);
      setLibraryError('');
    } catch (error) {
      setLibraryError(errorMessage(error, '创建分类失败'));
    }
  };

  const renameLibraryFolder = async (relativePath: string, newName: string) => {
    try {
      const folder = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const containsDocuments = librarySnapshotRef.current?.documents.some(
        (document) =>
          document.kind === 'doc' &&
          (document.category === folder ||
            document.category.startsWith(`${folder}/`)),
      );
      if (
        containsDocuments &&
        !window.confirm(
          '这个文件夹也包含知识库文档。重命名会同时移动其中的文档和导图，继续吗？',
        )
      )
        return false;
      const activeSave = activeSaveRef.current;
      if (activeSave && !(await activeSave)) {
        throw new Error('当前导图保存失败，请处理保存错误后再重命名文件夹。');
      }

      const snapshot = await libraryApi.renameFolder({
        relativePath,
        newName,
      });
      installLibrarySnapshot(snapshot);

      const oldFolderPath = relativePath
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
      const normalizedName = newName.trim().replace(/\.+$/, '').trimEnd();
      const parent = oldFolderPath.includes('/')
        ? oldFolderPath.slice(0, oldFolderPath.lastIndexOf('/'))
        : '';
      const newFolderPath = parent
        ? `${parent}/${normalizedName}`
        : normalizedName;
      const remapFolderPath = (path: string | null) => {
        if (!path) return path;
        const normalizedPath = path.replace(/\\/g, '/');
        if (normalizedPath === oldFolderPath) return newFolderPath;
        if (normalizedPath.startsWith(`${oldFolderPath}/`)) {
          return `${newFolderPath}${normalizedPath.slice(oldFolderPath.length)}`;
        }
        return path;
      };

      setCategoryFilter((current) => remapFolderPath(current) ?? '');
      workbench.controller.remapPaths(remapFolderPath);
      const currentDraft = draftRef.current;
      const nextRelativePath = remapFolderPath(currentDraft.relativePath);
      if (nextRelativePath !== currentDraft.relativePath) {
        const nextDraft = {
          ...currentDraft,
          relativePath: nextRelativePath,
          category:
            remapFolderPath(currentDraft.category) ?? currentDraft.category,
        };
        draftRef.current = nextDraft;
        setEditorDraft(nextDraft);
      }

      const currentPlantUml = plantUmlSessionRef.current;
      const currentPlantUmlPath = currentPlantUml?.request.cacheKey?.startsWith(
        'file:',
      )
        ? currentPlantUml.request.cacheKey.slice('file:'.length)
        : null;
      const nextPlantUmlPath = remapFolderPath(currentPlantUmlPath);
      if (
        currentPlantUml &&
        currentPlantUmlPath &&
        nextPlantUmlPath &&
        nextPlantUmlPath !== currentPlantUmlPath
      ) {
        const nextRequest: PlantUmlEditorRequest = {
          ...currentPlantUml.request,
          cacheKey: `file:${nextPlantUmlPath}`,
          onSave: async (nextSource) => {
            const saved = await libraryApi.savePlantUml({
              relativePath: nextPlantUmlPath,
              source: nextSource,
            });
            const currentLibrary = librarySnapshotRef.current;
            if (currentLibrary) {
              installLibrarySnapshot({
                ...currentLibrary,
                plantumlFiles: [
                  saved,
                  ...currentLibrary.plantumlFiles.filter(
                    (candidate) =>
                      candidate.relativePath !== saved.relativePath,
                  ),
                ],
              });
            }
            setLibraryError('');
            setSaveMessage('PUML 文件已保存');
          },
        };
        const nextPlantUml = { ...currentPlantUml, request: nextRequest };
        plantUmlSessionRef.current = nextPlantUml;
        setPlantUmlSession(nextPlantUml);
      }
      setLibraryError('');
      return true;
    } catch (error) {
      const message = errorMessage(error, '重命名文件夹失败');
      setLibraryError(message);
      throw new Error(message);
    }
  };

  const deleteMap = async (
    document: MapDocument,
    options: { skipConfirm?: boolean } = {},
  ) => {
    if (
      !options.skipConfirm &&
      !window.confirm(
        `确定删除“${document.title}”吗？此操作会删除文件库中的 Markdown 文件。`,
      )
    )
      return;
    if (
      draftRef.current.relativePath === document.relativePath &&
      draftRef.current.dirty
    ) {
      if (!(await saveDraft())) return;
    }
    try {
      if (
        workbench.controller.getState()?.relativePath === document.relativePath
      )
        await workbench.controller.discard();
      await libraryApi.deleteDocument({ relativePath: document.relativePath });
      if (draftRef.current.relativePath === document.relativePath) {
        installDraft(
          createDraft({
            title: '新建思维导图',
            category: categoryFilter || '未分类',
            markdown: '# 新建思维导图\n\n## 主题\n',
          }),
        );
      }
      await loadLibrary(false);
      setSaveMessage('已删除');
    } catch (error) {
      setLibraryError(errorMessage(error, '删除失败'));
    }
  };

  const handleGenerate = async () => {
    if (isGenerating || !prompt.trim()) return;
    setGenerationError('');
    setIsGenerating(true);
    try {
      const generatedMarkdown = await agentApi.generateMindmap({
        baseUrl: providerSettings.baseUrl,
        model: providerSettings.model,
        prompt: prompt.trim(),
      });
      ensureAiMathRenderable(generatedMarkdown, 'AI 生成结果');
      const activeDraft = draftRef.current;
      if (activeDraft.relativePath) {
        if (activeDraft.dirty && !(await saveDraft())) {
          setGenerationError(
            '当前思维导图的修改未能保存，AI 结果尚未应用。请先处理保存问题后重试。',
          );
          return;
        }
        const currentDraft = draftRef.current;
        installDraft(
          createDraft({
            title: markdownTitle(generatedMarkdown),
            category: currentDraft.category,
            mapType: currentDraft.mapType,
            markdown: generatedMarkdown,
            dirty: true,
            revision: currentDraft.revision + 1,
          }),
        );
        setSaveMessage('AI 思维导图已生成，正在保存为新文件…');
      } else {
        patchDraft({
          markdown: generatedMarkdown,
          title: markdownTitle(generatedMarkdown),
        });
      }
      setGenerationDialogOpen(false);
    } catch (error) {
      setGenerationError(
        errorMessage(error, '生成失败，请检查模型设置后重试。'),
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const loadProviderModels = async () => {
    setProviderModelsLoading(true);
    setProviderModels([]);
    setProviderModelsError('');
    try {
      const models = await agentApi.listProviderModels({
        baseUrl: providerSettings.baseUrl,
      });
      setProviderModels(models);
    } catch (error) {
      setProviderModels([]);
      setProviderModelsError(
        errorMessage(error, '无法获取模型列表；可以手动填写模型 ID。'),
      );
    } finally {
      setProviderModelsLoading(false);
    }
  };

  const toggleModelPicker = () => {
    if (modelPickerOpen) {
      setModelPickerOpen(false);
      return;
    }
    setProviderModelQuery('');
    setManualProviderModel(providerSettings.model);
    setModelPickerOpen(true);
    void loadProviderModels();
  };

  const chooseProviderModel = (model: string) => {
    const selected = model.trim();
    if (!selected) return;
    setProviderSettings((current) => ({ ...current, model: selected }));
    setManualProviderModel(selected);
    setModelPickerOpen(false);
  };

  const openSettings = () => {
    setSettingsMessage('');
    setSettingsOpen(true);
    void agentApi
      .hasApiKey()
      .then(setApiKeySaved)
      .catch((error) =>
        setSettingsMessage(errorMessage(error, '无法读取密钥状态。')),
      );
  };

  const saveApiKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!apiKeyDraft.trim()) return;
    setSettingsMessage('正在安全保存…');
    try {
      await agentApi.saveApiKey({ apiKey: apiKeyDraft.trim() });
      setApiKeyDraft('');
      setApiKeySaved(true);
      setSettingsMessage('密钥已保存到 Windows 凭据管理器。');
    } catch (error) {
      setSettingsMessage(errorMessage(error, '保存密钥失败。'));
    }
  };

  const removeApiKey = async () => {
    setSettingsMessage('');
    try {
      await agentApi.deleteApiKey();
      setApiKeySaved(false);
      setSettingsMessage('已删除保存的 API 密钥。');
    } catch (error) {
      setSettingsMessage(errorMessage(error, '删除密钥失败。'));
    }
  };

  useEffect(() => {
    localStorage.setItem(settingsStorageKey, JSON.stringify(providerSettings));
  }, [providerSettings]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !modelPickerRef.current?.contains(event.target)
      ) {
        setModelPickerOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModelPickerOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [modelPickerOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Keep the selected theme for this session when storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(mindmapStyleStorageKey, mindmapStyle);
    } catch {
      // Keep the selected map style for this session when storage is unavailable.
    }
  }, [mindmapStyle]);

  useEffect(() => {
    if (!nodeSpacing || typeof nodeSpacing !== 'object') {
      const migrated = readNodeSpacing();
      setNodeSpacing(migrated);
      try {
        localStorage.setItem(nodeSpacingStorageKey, JSON.stringify(migrated));
      } catch {
        // Keep the selected node spacing for this session.
      }
      return;
    }
    try {
      localStorage.setItem(nodeSpacingStorageKey, JSON.stringify(nodeSpacing));
    } catch {
      // Keep the selected node spacing for this session.
    }
  }, [nodeSpacing]);

  useEffect(() => {
    try {
      localStorage.setItem(aiCollapsedStorageKey, String(aiCollapsed));
    } catch {
      // Keep the state for this session when storage is unavailable.
    }
  }, [aiCollapsed]);

  useEffect(() => {
    if (!mindmapStyleMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !mindmapStylePickerRef.current?.contains(event.target)
      ) {
        setMindmapStyleMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMindmapStyleMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [mindmapStyleMenuOpen]);

  useEffect(() => {
    void agentApi
      .hasApiKey()
      .then(setApiKeySaved)
      .catch(() => setApiKeySaved(false));
    void loadLibrary(true);
  }, []);

  useEffect(() => {
    libraryQueryRef.current = libraryQuery;
    categoryFilterRef.current = categoryFilter;
  }, [libraryQuery, categoryFilter]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<LibrarySnapshot>('library-changed', (event) => {
      installLibrarySnapshot(event.payload);
    })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch((error) =>
        setLibraryError(errorMessage(error, '无法监控文件库变化')),
      );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter') {
          setEpubDropActive(payload.paths.some(isEpubPath));
        } else if (payload.type === 'leave') {
          setEpubDropActive(false);
        } else if (payload.type === 'drop') {
          setEpubDropActive(false);
          epubDropHandlerRef.current(payload.paths);
        }
      })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch((error) =>
        setLibraryError(errorMessage(error, '无法启用文件拖放导入')),
      );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!editorDraft.dirty || !librarySnapshot?.rootPath || pendingEpubImport)
      return;
    const timer = window.setTimeout(() => {
      void saveDraft();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    editorDraft.dirty,
    editorDraft.revision,
    librarySnapshot?.rootPath,
    pendingEpubImport,
  ]);

  useEffect(() => {
    if (!librarySnapshot?.rootPath) return;
    const sequence = ++searchRequestRef.current;
    const timer = window.setTimeout(() => {
      void libraryApi
        .search({
          query: libraryQuery,
          category: categoryFilter || null,
          kind: 'mindmap',
        })
        .then((documents) => {
          if (sequence === searchRequestRef.current)
            setMindmapDocuments(documents);
        })
        .catch((error) =>
          setLibraryError(errorMessage(error, '搜索文件库失败')),
        );
    }, 160);
    return () => {
      window.clearTimeout(timer);
      searchRequestRef.current += 1;
    };
  }, [librarySnapshot, libraryQuery, categoryFilter]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = svgRef.current;
    const map = Markmap.create(svgRef.current, {
      // Explicit fitting is handled by the initial-document and toolbar paths.
      autoFit: false,
      duration: 220,
      direction:
        mindmapStyles.find((s) => s.id === mindmapStyle)?.direction || 'both',
      linkShape: 'orthogonal',
      linkRadius: 0,
      linkAnchor: (node: MapColorNode) =>
        mapNodeLinkAnchor(mindmapStyle, node.state.depth),
      lineWidth: (node: MapColorNode) => mapNodeLineWidth(node.state.depth),
      color: (node: MapColorNode) =>
        mapNodeColor(
          mindmapStyle,
          node.state.depth,
          node.state.path || '',
          theme,
        ),
      maxWidth: 380,
      spacingHorizontal: defaultNodeSpacing.horizontal,
      spacingVertical: defaultNodeSpacing.vertical,
      fitRatio: 0.9,
      pan: true,
      zoom: true,
    });
    markmapRef.current = map;

    const handleCanvasDoubleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          '.seamind-code-panel, button, input, textarea, .cm-editor',
        )
      )
        return;
      const nodeGroup = target.closest<SVGGElement>('g.markmap-node');
      if (!nodeGroup) return;
      const sourcePath = nodeGroup.getAttribute('data-path');
      const source = sourcePath
        ? markdownNodeSourcesRef.current.get(sourcePath)
        : undefined;
      const editor = nodeGroup.querySelector<HTMLElement>(
        'foreignObject > div > div',
      );
      if (
        !source ||
        source.kind === 'block' ||
        !editor ||
        markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown
      )
        return;
      if (svg.querySelector('[contenteditable="true"]')) return;

      event.preventDefault();
      event.stopPropagation();
      const originalText = editor.innerText || editor.textContent || '';
      let finished = false;
      editor.contentEditable = 'true';
      editor.setAttribute('role', 'textbox');
      editor.setAttribute(
        'aria-label',
        '\u6309 Enter \u6362\u884c\uff0c\u6309 Ctrl+Enter \u6dfb\u52a0\u540c\u7ea7\uff0c\u6309 Tab \u6dfb\u52a0\u5b50\u8282\u70b9',
      );
      editor.setAttribute('spellcheck', 'false');
      editor.classList.add('is-canvas-editing');

      const finish = (action?: 'cancel' | 'sibling' | 'child') => {
        if (finished) return;
        finished = true;
        editor.removeEventListener('keydown', handleKeyDown);
        editor.removeEventListener('blur', handleBlur);
        const nextText =
          action === 'cancel'
            ? originalText
            : editor.innerText || editor.textContent || '';
        editor.contentEditable = 'false';
        editor.removeAttribute('role');
        editor.removeAttribute('aria-label');
        editor.removeAttribute('spellcheck');
        editor.classList.remove('is-canvas-editing');

        if (action === 'cancel') {
          editor.textContent = originalText;
          return;
        }
        const activeDraft = draftRef.current;
        const titleLineIndex = markdownTitleLineIndex(activeDraft.markdown);
        const command = applyMarkdownNodeCommand(
          activeDraft.markdown,
          source,
          action === 'child'
            ? 'add_child'
            : action === 'sibling'
              ? 'add_sibling'
              : 'rename',
          nextText,
        );
        if (command.markdown !== activeDraft.markdown) {
          applyMarkdownFromCanvas(command.markdown, {
            lineIndex: command.lineIndex,
            focus: true,
            ...(!action && source.lineIndex === titleLineIndex
              ? { title: markdownTitle(command.markdown) }
              : {}),
          });
        }
      };

      const handleKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.isComposing) return;
        if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          finish('cancel');
        } else if (
          keyEvent.key === 'Enter' &&
          (keyEvent.ctrlKey || keyEvent.metaKey)
        ) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          finish('sibling');
        } else if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          if (!editor.contains(range.startContainer)) return;
          range.deleteContents();
          const lineBreak = document.createElement('br');
          range.insertNode(lineBreak);
          range.setStartAfter(lineBreak);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        } else if (keyEvent.key === 'Tab') {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          finish('child');
        }
      };
      const handleBlur = () => finish();
      editor.addEventListener('keydown', handleKeyDown);
      editor.addEventListener('blur', handleBlur);
      editor.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    };

    const handleHtmlCardClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const exitButton = target.closest<HTMLElement>(
        '[data-seamind-html-exit="true"]',
      );
      if (exitButton) {
        event.preventDefault();
        event.stopPropagation();
        setHtmlCanvasEmbed(null);
        return;
      }
      const cardElement = target.closest<HTMLElement>(
        'button[data-seamind-html-card="true"]',
      );
      if (!cardElement) return;
      event.preventDefault();
      event.stopPropagation();
      const card = parseHtmlCardDefinition({
        assetId: cardElement.dataset.seamindAssetId,
        entryPath: cardElement.dataset.seamindEntryPath,
        title: cardElement.dataset.seamindTitle,
        width: cardElement.dataset.seamindWidth,
        height: cardElement.dataset.seamindHeight,
      });
      const documentRelativePath = draftRef.current.relativePath;
      if (!card || !documentRelativePath) {
        setLibraryError('卡片信息无效，请重新导入 HTML 文件。');
        return;
      }
      setHtmlPreviewError('');
      setHtmlPreviewSrc('');
      setHtmlPreview({ ...card, documentRelativePath });
    };

    const handleMapNodeClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          'button, input, textarea, select, .cm-editor, [contenteditable="true"]',
        )
      )
        return;
      if (markdownNodeSourcesMarkdownRef.current !== draftRef.current.markdown)
        return;
      const nodeGroup = target.closest<SVGGElement>('g.markmap-node');
      const path = nodeGroup?.getAttribute('data-path');
      if (!nodeGroup || !path) return;
      if (target.closest('.markmap-node-add-sibling')) return;
      setCanvasNodeContextMenu(null);
      setActiveMapPath(path);
      const source = markdownNodeSourcesRef.current.get(path);
      if (source) {
        const selectSource = () =>
          markdownEditorRef.current?.selectLines(
            source.lineIndex,
            source.endLineIndex,
            true,
          );
        if (markdownPaneModeRef.current === 'preview') {
          setMarkdownPaneMode('edit');
          window.requestAnimationFrame(selectSource);
        } else {
          selectSource();
        }
      }
      const reader = epubReaderRef.current;
      if (readerSplitActiveRef.current && reader) {
        const label =
          source?.label ||
          normalizeMindmapText(
            nodeGroup.querySelector('foreignObject')?.textContent || '',
          );
        if (label || source?.epubHref) {
          setEpubChapterNavigation({
            id: ++epubChapterNavigationIdRef.current,
            progressKey: reader.progressKey,
            href: source?.epubHref,
            label,
          });
        }
      }
    };

    const handleMapNodeContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const nodeGroup = target.closest<SVGGElement>('g.markmap-node');
      const path = nodeGroup?.getAttribute('data-path');
      if (!nodeGroup || !path || path.split('.').length < 2) return;
      event.preventDefault();
      setActiveMapPath(path);
      const menuWidth = 228;
      const menuHeight = 42;
      setCanvasNodeContextMenu({
        path,
        left: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
        top: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
      });
    };

    const handleYouTubeCardClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest<HTMLButtonElement>(
        'button[data-seamind-youtube-card="true"]',
      );
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      const id = card.dataset.seamindYoutubeId || '';
      const startSeconds = Number(card.dataset.seamindYoutubeStart || '0');
      if (!buildYouTubeEmbedUrl(id, startSeconds)) return;
      setYoutubePreview({
        id,
        title: card.dataset.seamindYoutubeTitle || 'YouTube 视频',
        startSeconds: Number.isSafeInteger(startSeconds) ? startSeconds : 0,
      });
    };

    const handleYouTubeThumbnailError = (event: Event) => {
      const image = event.target;
      if (
        !(image instanceof HTMLImageElement) ||
        image.dataset.seamindYoutubeThumbnail !== 'true'
      )
        return;
      const videoId = image.dataset.seamindYoutubeId || '';
      const currentQuality = Number(image.dataset.seamindYoutubeQuality || '0');
      const fallback = nextYouTubeThumbnail(videoId, currentQuality);
      if (fallback) {
        image.dataset.seamindYoutubeQuality = String(fallback.quality);
        image.src = fallback.src;
        return;
      }
      const placeholder = document.createElement('div');
      placeholder.className = 'seamind-youtube-thumbnail-fallback';
      placeholder.textContent = '封面暂不可用';
      image.replaceWith(placeholder);
    };

    svg.addEventListener('click', handleMapNodeClick, true);
    svg.addEventListener('contextmenu', handleMapNodeContextMenu, true);
    svg.addEventListener('click', handleHtmlCardClick, true);
    svg.addEventListener('click', handleYouTubeCardClick, true);
    svg.addEventListener('error', handleYouTubeThumbnailError, true);
    svg.addEventListener('dblclick', handleCanvasDoubleClick, true);
    return () => {
      svg.removeEventListener('click', handleMapNodeClick, true);
      svg.removeEventListener('contextmenu', handleMapNodeContextMenu, true);
      svg.removeEventListener('click', handleHtmlCardClick, true);
      svg.removeEventListener('click', handleYouTubeCardClick, true);
      svg.removeEventListener('error', handleYouTubeThumbnailError, true);
      svg.removeEventListener('dblclick', handleCanvasDoubleClick, true);
      map.destroy();
      markmapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = markmapRef.current as StylableMarkmap | null;
    if (!map) return;
    void map
      .setData(undefined, {
        direction:
          mindmapStyles.find((s) => s.id === mindmapStyle)?.direction || 'both',
        linkShape: 'orthogonal',
        linkRadius: 0,
        color: (node) =>
          mapNodeColor(
            mindmapStyle,
            node.state.depth,
            node.state.path || '',
            theme,
          ),
        lineWidth: (node) => mapNodeLineWidth(node.state.depth),
        linkAnchor: (node) => mapNodeLinkAnchor(mindmapStyle, node.state.depth),
      })
      .then(() => setSourceMapVersion((version) => version + 1));
  }, [mindmapStyle, theme]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg
      .querySelectorAll<SVGGElement>('g.markmap-node[data-path]')
      .forEach((nodeGroup) => {
        if (nodeGroup.getAttribute('data-path') === activeMapPath) {
          nodeGroup.setAttribute('data-active', 'true');
        } else {
          nodeGroup.removeAttribute('data-active');
        }
      });
  }, [activeMapPath, sourceMapVersion]);

  useEffect(() => {
    if (!htmlPreview) return;
    let active = true;
    setHtmlPreviewSrc('');
    setHtmlPreviewError('');
    void libraryApi
      .resolveHtmlAsset({
        documentRelativePath: htmlPreview.documentRelativePath,
        assetId: htmlPreview.assetId,
        entryPath: htmlPreview.entryPath,
      })
      .then((path) => {
        if (active) setHtmlPreviewSrc(convertFileSrc(path));
      })
      .catch((error) => {
        if (active)
          setHtmlPreviewError(errorMessage(error, '无法打开 HTML 组件。'));
      });
    return () => {
      active = false;
    };
  }, [htmlPreview]);

  useEffect(() => {
    if (
      htmlCanvasEmbed &&
      htmlCanvasEmbed.documentRelativePath !== editorDraft.relativePath
    ) {
      setHtmlCanvasEmbed(null);
    }
  }, [editorDraft.relativePath, htmlCanvasEmbed]);

  useEffect(() => {
    if (!htmlPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeHtmlPreview();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [htmlPreview]);

  useEffect(() => {
    if (activeWorkspace !== 'mindmap' && !readerSplitActive) return;
    let visibilityRecoveryTimer = 0;
    const timer = window.setTimeout(async () => {
      const map = markmapRef.current;
      const svg = svgRef.current;
      if (!map || !svg) return;
      codeBlocksAbortRef.current?.abort();
      codeBlocksCleanupRef.current?.();
      codeBlocksCleanupRef.current = null;
      const codeBlocksAbort = new AbortController();
      codeBlocksAbortRef.current = codeBlocksAbort;
      const { root } = transformer.transform(
        normalizeKatexDelimiters(markdownForMindmap(editorDraft.markdown)),
        htmlCardParserOptions,
      );
      const embedding =
        htmlCanvasEmbed?.documentRelativePath === editorDraft.relativePath
          ? htmlCanvasEmbed
          : undefined;
      const embeddingApplied = { value: false };
      const safeRoot = prepareHtmlCardNodes(
        prepareYouTubeCards(sanitizeNode(root)),
        embedding,
        embeddingApplied,
      );
      const displayRoot = addFallbackMindmapTitle(
        safeRoot,
        editorDraft.markdown,
        editorDraft.title,
      );
      const nextMarkdownNodeSources = buildMarkdownNodeSourceMap(
        editorDraft.markdown,
        safeRoot,
      );
      const rootWithNoteCards = addMarkdownNodeNoteCards(
        displayRoot,
        nextMarkdownNodeSources,
        editorDraft.markdown,
        transformer.md,
      );
      const prepared = prepareMindmapTree(
        rootWithNoteCards,
        nextMarkdownNodeSources,
      );
      fullMindmapRootRef.current = prepared.root;
      setMindmapNavigationTree(prepared.navigation);
      let visibleRoot = prepared.root;
      if (focusedMapPath) {
        const branch = findPureNodeBySourcePath(prepared.root, focusedMapPath);
        if (branch) visibleRoot = branch;
        else setFocusedMapPath(null);
      }
      await map.setData(clonePureNode(visibleRoot));
      if (codeBlocksAbort.signal.aborted) return;
      markdownNodeSourcesMarkdownRef.current = editorDraft.markdown;
      markdownNodeSourcesRef.current = nextMarkdownNodeSources;
      const selection = markdownEditorRef.current?.getSelection();
      const pendingCenterPath = pendingMindmapCenterPathRef.current;
      if (pendingCenterPath) {
        pendingMindmapCenterPathRef.current = null;
        setActiveMapPath(pendingCenterPath);
        window.requestAnimationFrame(() => {
          const nodeGroup = [
            ...svg.querySelectorAll<SVGGElement>('g.markmap-node[data-path]'),
          ].find(
            (item) => item.getAttribute('data-path') === pendingCenterPath,
          );
          const datum = (
            nodeGroup as (SVGGElement & { __data__?: unknown }) | undefined
          )?.__data__;
          if (datum) void (map as CenterableMarkmap).centerNode(datum);
        });
      } else if (selection && !focusedMapPath)
        setActiveMapPath(
          findSourcePathForLine(
            selection.lineIndex,
            markdownNodeSourcesRef.current,
          ),
        );
      setSourceMapVersion((version) => version + 1);
      const cleanupCodeBlocks = await hydrateCodeBlocks(
        svg,
        theme,
        codeBlocksAbort.signal,
        {
          onCodeChange: (language, previous, next, sourceRange) =>
            codeBlockEditHandlerRef.current(
              language,
              previous,
              next,
              sourceRange,
            ),
          onOpenPlantUmlEditor: (source, language, onSave) =>
            openPlantUmlWorkspace({ source, language, onSave }),
          onMathVisualizationChange: (language, previous, next, nodePath) =>
            handleMathVisualizationChange(language, previous, next, nodePath),
          onTerminalCommand: (language, source, onResult) => {
            const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            terminalCommandResultsRef.current.set(id, onResult);
            setTerminalCommandConfirmation({ id, language, source });
          },
          onRunInTerminal: handleRunCodeInTerminal,
        },
      );
      if (codeBlocksAbort.signal.aborted) cleanupCodeBlocks();
      else codeBlocksCleanupRef.current = cleanupCodeBlocks;
      if (embedding && !embeddingApplied.value) setHtmlCanvasEmbed(null);
      if (pendingInitialFitRef.current) {
        // Let the debounced ResizeObserver measure hydrated node content first.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
        if (!codeBlocksAbort.signal.aborted && pendingInitialFitRef.current) {
          pendingInitialFitRef.current = false;
          await map.fit();
        }
      }
      visibilityRecoveryTimer = window.setTimeout(() => {
        if (codeBlocksAbort.signal.aborted) return;
        const viewport = svg.getBoundingClientRect();
        if (viewport.width < 10 || viewport.height < 10) return;
        const nodes = [...svg.querySelectorAll<SVGGElement>('g.markmap-node')];
        const hasVisibleNode = nodes.some((node) => {
          const bounds = node.getBoundingClientRect();
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.right > viewport.left &&
            bounds.left < viewport.right &&
            bounds.bottom > viewport.top &&
            bounds.top < viewport.bottom
          );
        });
        if (!nodes.length) {
          void map.setData(clonePureNode(visibleRoot)).then(() => map.fit());
        } else if (!hasVisibleNode) {
          void map.fit();
        }
      }, 260);
    }, 180);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(visibilityRecoveryTimer);
      codeBlocksAbortRef.current?.abort();
      codeBlocksCleanupRef.current?.();
      codeBlocksAbortRef.current = null;
      codeBlocksCleanupRef.current = null;
    };
  }, [
    activeWorkspace,
    editorDraft.markdown,
    editorDraft.relativePath,
    focusedMapPath,
    htmlCanvasEmbed,
    readerSplitActive,
    theme,
    transformer,
  ]);

  useEffect(() => {
    const map = markmapRef.current;
    if (!map) return;

    const spacingHorizontal = activeNodeSpacing.horizontal;
    const spacingVertical = activeNodeSpacing.vertical;
    if (
      map.options.spacingHorizontal === spacingHorizontal &&
      map.options.spacingVertical === spacingVertical
    )
      return;

    const timer = window.setTimeout(() => {
      if (markmapRef.current !== map) return;
      const previousAutoFit = map.options.autoFit;
      const previousDuration = map.options.duration;
      void map
        .setData(undefined, {
          autoFit: false,
          duration: 0,
          spacingHorizontal,
          spacingVertical,
        })
        .catch((error) => {
          console.error('Failed to update mindmap spacing', error);
        })
        .finally(() => {
          if (markmapRef.current === map)
            map.setOptions({
              autoFit: previousAutoFit,
              duration: previousDuration,
            });
        });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [nodeSpacing]);

  const handleZoom = (factor: number) => {
    void markmapRef.current?.rescale(factor);
  };

  const centerMapNodePath = (path: string) => {
    const svg = svgRef.current;
    const map = markmapRef.current;
    if (!svg || !map) return;
    const nodeGroup = [
      ...svg.querySelectorAll<SVGGElement>('g.markmap-node[data-path]'),
    ].find((item) => item.getAttribute('data-path') === path);
    const datum = (
      nodeGroup as (SVGGElement & { __data__?: unknown }) | undefined
    )?.__data__;
    if (datum) void (map as CenterableMarkmap).centerNode(datum);
  };

  const requestEpubChapterNavigation = (path: string) => {
    if (!readerSplitActive || !epubReader) return;
    const source = markdownNodeSourcesRef.current.get(path);
    const navigationPath = findNavigationPath(mindmapNavigationTree, path);
    const navigationNode = navigationPath[navigationPath.length - 1];
    const label = source?.label || navigationNode?.label || '';
    if (!source?.epubHref && !label) return;
    setEpubChapterNavigation({
      id: ++epubChapterNavigationIdRef.current,
      progressKey: epubReader.progressKey,
      href: source?.epubHref,
      label,
    });
  };

  const selectMindmapNode = (path: string) => {
    const focusPath = focusedMapPath;
    const visibleInFocusedBranch =
      !focusPath || path === focusPath || path.startsWith(`${focusPath}.`);
    if (!visibleInFocusedBranch) {
      pendingMindmapCenterPathRef.current = path;
      setFocusedMapPath(null);
    } else {
      centerMapNodePath(path);
    }
    setCanvasNodeContextMenu(null);
    setActiveMapPath(path);
    const source = markdownNodeSourcesRef.current.get(path);
    if (source) {
      const selectSource = () =>
        markdownEditorRef.current?.selectLines(
          source.lineIndex,
          source.endLineIndex,
          true,
        );
      if (markdownPaneModeRef.current === 'preview') {
        setMarkdownPaneMode('edit');
        window.requestAnimationFrame(selectSource);
      } else {
        selectSource();
      }
    }
    requestEpubChapterNavigation(path);
  };

  const focusMapBranch = (path: string) => {
    setCanvasNodeContextMenu(null);
    setActiveMapPath(path);
    pendingInitialFitRef.current = true;
    setFocusedMapPath(path);
    const source = markdownNodeSourcesRef.current.get(path);
    if (source) {
      const selectSource = () =>
        markdownEditorRef.current?.selectLines(
          source.lineIndex,
          source.endLineIndex,
          true,
        );
      if (markdownPaneModeRef.current === 'preview') {
        setMarkdownPaneMode('edit');
        window.requestAnimationFrame(selectSource);
      } else {
        selectSource();
      }
    }
  };

  const restoreFullMindmap = () => {
    if (focusedMapPath) pendingMindmapCenterPathRef.current = focusedMapPath;
    pendingInitialFitRef.current = true;
    setFocusedMapPath(null);
    setCanvasNodeContextMenu(null);
  };

  const onReaderSplitPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    splitLayoutDragRef.current = window.innerWidth > 1100 ? 'wide' : 'narrow';
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onReaderSplitPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const mode = splitLayoutDragRef.current;
    const bounds = appShellRef.current?.getBoundingClientRect();
    if (!mode || !bounds) return;
    if (mode === 'wide') {
      const availableWidth = Math.max(
        1,
        bounds.width - (terminalRightActive ? terminalSideWidth + 16 : 8),
      );
      const ratio = Math.min(
        0.65,
        Math.max(0.32, (event.clientX - bounds.left) / availableWidth),
      );
      setReaderSplitLayout((current) => ({ ...current, wideRatio: ratio }));
      return;
    }
    const available = Math.max(1, bounds.height - 52 - 29 - 8);
    const ratio = Math.min(
      0.65,
      Math.max(0.25, (event.clientY - bounds.top - 52) / available),
    );
    setReaderSplitLayout((current) => ({ ...current, narrowRatio: ratio }));
  };

  const onReaderSplitPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    splitLayoutDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onReaderSplitKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const isWide = window.innerWidth > 1100;
    const key = event.key;
    const allowedArrows = isWide
      ? ['ArrowLeft', 'ArrowRight']
      : ['ArrowUp', 'ArrowDown'];
    if (key !== 'Home' && !allowedArrows.includes(key)) return;
    event.preventDefault();
    if (key === 'Home') {
      setReaderSplitLayout(DEFAULT_READER_SPLIT_LAYOUT);
      return;
    }
    const increase = isWide ? key === 'ArrowRight' : key === 'ArrowDown';
    const delta = increase ? 0.02 : -0.02;
    setReaderSplitLayout((current) =>
      isWide
        ? {
            ...current,
            wideRatio: Math.min(
              0.65,
              Math.max(0.32, current.wideRatio + delta),
            ),
          }
        : {
            ...current,
            narrowRatio: Math.min(
              0.65,
              Math.max(0.25, current.narrowRatio + delta),
            ),
          },
    );
  };

  const readerSplitStyle = {
    '--reader-split-wide-ratio': String(readerSplitLayout.wideRatio),
    '--reader-split-narrow-size': `${readerSplitLayout.narrowRatio * 100}%`,
  } as CSSProperties;

  useEffect(() => {
    markmapRef.current?.setViewAnchorPath(activeMapPath || undefined);
  }, [activeMapPath]);

  const selectedNodeSource = activeMapPath
    ? markdownNodeSourcesRef.current.get(activeMapPath)
    : undefined;
  const sourceMapIsCurrent =
    markdownNodeSourcesMarkdownRef.current === editorDraft.markdown;
  const canAddSelectedNode = Boolean(
    sourceMapIsCurrent &&
    selectedNodeSource &&
    selectedNodeSource.kind !== 'block',
  );
  const canDeleteSelectedNode = Boolean(
    sourceMapIsCurrent && selectedNodeSource,
  );
  const canEditSelectedNodeNote = Boolean(
    sourceMapIsCurrent && selectedNodeSource,
  );
  const selectedAiTarget =
    sourceMapIsCurrent &&
    activeMapPath &&
    selectedNodeSource &&
    selectedNodeSource.kind !== 'block'
      ? {
          nodeId: selectedNodeSource.id || null,
          nodePath: activeMapPath,
          label: selectedNodeSource.label,
        }
      : null;
  const isHtmlInteractiveCanvas =
    htmlCanvasEmbed?.documentRelativePath === editorDraft.relativePath;
  const activeBookMindmapTarget =
    epubReader && librarySnapshot?.rootPath
      ? resolveBookMindmapTarget(librarySnapshot, {
          relativePath: epubReader.relativePath,
          title: epubReader.title,
        })
      : null;
  const activeBookKnowledgeTarget =
    epubReader && librarySnapshot?.rootPath
      ? resolveBookKnowledgeTarget(librarySnapshot, {
          relativePath: epubReader.relativePath,
          title: epubReader.title,
        })
      : null;
  const clampTerminalHeight = (height: number) =>
    Math.round(Math.max(160, Math.min(window.innerHeight * 0.72, height)));
  const onTerminalResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    terminalResizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: terminalHeight,
    };
  };
  const onTerminalResizePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const drag = terminalResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setTerminalHeight(
      clampTerminalHeight(drag.startHeight + drag.startY - event.clientY),
    );
  };
  const onTerminalResizePointerUp = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (terminalResizeRef.current?.pointerId !== event.pointerId) return;
    terminalResizeRef.current = null;
    const height = clampTerminalHeight(terminalHeight);
    setTerminalHeight(height);
    try {
      localStorage.setItem(TERMINAL_HEIGHT_KEY, String(height));
    } catch {
      // Keep the resized height in memory for this session.
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onTerminalResizeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const change =
      event.key === 'ArrowUp' ? 24 : event.key === 'ArrowDown' ? -24 : 0;
    if (event.key === 'Home') {
      event.preventDefault();
      setTerminalHeight(280);
      try {
        localStorage.setItem(TERMINAL_HEIGHT_KEY, '280');
      } catch {
        // Keep the default height in memory for this session.
      }
    } else if (change !== 0) {
      event.preventDefault();
      const height = clampTerminalHeight(terminalHeight + change);
      setTerminalHeight(height);
      try {
        localStorage.setItem(TERMINAL_HEIGHT_KEY, String(height));
      } catch {
        // Keep the resized height in memory for this session.
      }
    }
  };
  const setTerminalDockAndStore = (dock: 'bottom' | 'right') => {
    setTerminalDock(dock);
    try {
      localStorage.setItem('seamind:terminal-dock:v1', dock);
    } catch {
      /* Keep the preference in memory. */
    }
  };
  const clampTerminalWidth = (width: number) => {
    const viewportMax = window.innerWidth * 0.62;
    const splitMax = readerSplitActive
      ? Math.min(viewportMax, window.innerWidth - 900)
      : viewportMax;
    return Math.round(Math.max(320, Math.min(splitMax, width)));
  };
  const onTerminalWidthPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    terminalWidthDragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: terminalSideWidth,
    };
  };
  const onTerminalWidthPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const drag = terminalWidthDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setTerminalWidth(clampTerminalWidth(drag.width + drag.x - event.clientX));
  };
  const onTerminalWidthPointerUp = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (terminalWidthDragRef.current?.pointerId !== event.pointerId) return;
    terminalWidthDragRef.current = null;
    try {
      localStorage.setItem('seamind:terminal-width:v1', String(terminalWidth));
    } catch {
      /* Keep the width in memory. */
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onTerminalWidthKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const delta =
      event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
    if (event.key !== 'Home' && !delta) return;
    event.preventDefault();
    const width = clampTerminalWidth(
      event.key === 'Home' ? 440 : terminalWidth + delta,
    );
    setTerminalWidth(width);
    try {
      localStorage.setItem('seamind:terminal-width:v1', String(width));
    } catch {
      /* Keep the width in memory. */
    }
  };
  const focusedMindmapPath = focusedMapPath
    ? findNavigationPath(mindmapNavigationTree, focusedMapPath)
    : [];

  const isDocumentMapPreview =
    previewDocumentPath !== null &&
    previewDocumentPath === editorDraft.relativePath;

  return (
    <main
      ref={appShellRef}
      className={`app-shell${activeWorkspace === 'terminal' ? ' is-terminal-workspace' : ''}${readerSplitActive ? ' is-reader-split' : ''}${readerKnowledgeActive ? ' is-reader-knowledge' : ''}${readerKnowledgeActive && galaxyViewActive ? ' is-reader-knowledge-wide' : ''}${isTerminalDrawerOpen ? ' is-terminal-open' : ''}${terminalRightActive ? ' is-terminal-right' : ''}${activeWorkspace === 'knowledge' || activeWorkspace === 'mindmap' ? ' is-knowledge-surface' : ''}`}
      data-theme={theme}
      data-map-style={mindmapStyle}
      style={
        {
          ...readerSplitStyle,
          '--terminal-height': `${terminalHeight}px`,
          '--terminal-width': `${terminalWidth}px`,
          '--terminal-side-width': `${terminalSideWidth}px`,
          '--knowledge-sidebar-column': `${activeWorkspace === 'mindmap' ? (libraryCollapsed ? 42 : knowledgeSidebarWidth) : knowledgeSidebarCollapsed ? 42 : knowledgeSidebarWidth}px`,
        } as CSSProperties
      }
    >
      <InstallerComponentSetup />
      {agentBridgeError ? (
        <p className="agent-bridge-error" role="alert">
          {agentBridgeError}
        </p>
      ) : null}
      <header className="topbar">
        <nav className="workspace-switcher" aria-label="工作区">
          <button
            type="button"
            className={activeWorkspace === 'reader' ? 'is-active' : ''}
            aria-pressed={activeWorkspace === 'reader'}
            onClick={() => setActiveWorkspace('reader')}
          >
            电子书
          </button>
          <button
            type="button"
            className={activeWorkspace === 'exams' ? 'is-active' : ''}
            aria-pressed={activeWorkspace === 'exams'}
            onClick={() => {
              setExamBookFilter('');
              setActiveWorkspace('exams');
            }}
          >
            试卷
            {dueExamCount > 0 && (
              <span
                className="workspace-due-count"
                aria-label={`${dueExamCount} 份试卷待复习`}
              >
                {dueExamCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className={activeWorkspace === 'player' ? 'is-active' : ''}
            aria-pressed={activeWorkspace === 'player'}
            onClick={() => setActiveWorkspace('player')}
          >
            播放器
          </button>
          <button
            type="button"
            className={
              activeWorkspace === 'knowledge' || activeWorkspace === 'mindmap'
                ? 'is-active'
                : ''
            }
            aria-pressed={
              activeWorkspace === 'knowledge' || activeWorkspace === 'mindmap'
            }
            onClick={() => setActiveWorkspace(lastKnowledgePageRef.current)}
          >
            知识库
          </button>
          <button
            type="button"
            className={activeWorkspace === 'terminal' ? 'is-active' : ''}
            aria-pressed={activeWorkspace === 'terminal'}
            onClick={() => setActiveWorkspace('terminal')}
          >
            终端
          </button>
          <button
            type="button"
            className={activeWorkspace === 'tasks' ? 'is-active' : ''}
            aria-pressed={activeWorkspace === 'tasks'}
            onClick={() => setActiveWorkspace('tasks')}
            title={
              pendingHabitCount > 0
                ? `今日还有 ${pendingHabitCount} 个习惯未打卡`
                : undefined
            }
          >
            任务
            {pendingHabitCount > 0 && (
              <span
                className="workspace-due-count"
                aria-label={`今日还有 ${pendingHabitCount} 个习惯未打卡`}
              >
                {formatBadgeCount(pendingHabitCount)}
              </span>
            )}
          </button>
          <button
            type="button"
            className={activeWorkspace === 'literature' ? 'is-active' : ''}
            aria-pressed={activeWorkspace === 'literature'}
            onClick={() => setActiveWorkspace('literature')}
          >
            论文
          </button>
          <button
            type="button"
            className={activeWorkspace === 'feed' ? 'is-active' : ''}
            aria-pressed={activeWorkspace === 'feed'}
            onClick={() => setActiveWorkspace('feed')}
          >
            订阅
          </button>
        </nav>
        <div className="topbar-media-slot">
          <TopbarMiniPlayer
            onJumpToSource={(kind) => {
              if (kind === 'video') {
                setPlayerOpened(true);
                setActiveWorkspace('player');
                return;
              }
              setFeedOpened(true);
              if (activePodcastArticle) {
                feedFocusRequestIdRef.current += 1;
                setFeedFocusArticleRequest({
                  id: feedFocusRequestIdRef.current,
                  article: activePodcastArticle,
                });
              }
              setActiveWorkspace('feed');
            }}
          />
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="theme-toggle-button"
            data-active-theme={theme}
            title={THEME_OPTIONS[theme]?.title ?? '切换主题'}
            aria-label={THEME_OPTIONS[theme]?.title ?? '切换主题'}
            onClick={() =>
              setTheme((current) => THEME_OPTIONS[current]?.next ?? 'dark')
            }
          >
            <Icon name={THEME_OPTIONS[theme]?.icon ?? 'moon'} />
          </button>
          {activeWorkspace === 'mindmap' && !plantUmlSession && (
            <button
              type="button"
              className="save-document-button"
              onClick={() => {
                if (activeDocument)
                  void workbench.controller.save({ manual: true });
                else void saveDraft(true);
              }}
              disabled={saveMessage === '正在保存…' || isDocumentMapPreview}
            >
              保存
            </button>
          )}
          <div className="terminal-topbar-group">
            <button
              type="button"
              className={`terminal-toggle-button${terminalOpen ? ' is-active' : ''}`}
              aria-expanded={terminalOpen}
              aria-controls="seamind-terminal-panel"
              title="打开或收起侧边/底部 CLI 终端抽屉"
              onClick={() => {
                if (
                  !terminalOpen &&
                  activeWorkspace === 'player' &&
                  viewportWidth >= 1400
                ) {
                  setTerminalDockAndStore('right');
                }
                setTerminalOpen((open) => !open);
              }}
            >
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                aria-hidden="true"
              >
                <rect x="1.5" y="2.5" width="13" height="11" />
                <line x1="10.2" y1="2.5" x2="10.2" y2="13.5" />
              </svg>
              <span>终端</span>
            </button>
            <button
              type="button"
              className="terminal-popout-topbar-button"
              aria-label="多开独立终端窗口"
              title="新开一个独立桌面终端窗口（可多开用于运行 CLI 模型与对照学习）"
              onClick={() => {
                void openStandaloneTerminalWindow({
                  cwd: librarySnapshot?.rootPath ?? '',
                  shell: 'powershell',
                  theme,
                });
              }}
            >
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.35"
                aria-hidden="true"
              >
                <rect x="2" y="5" width="8.5" height="8.5" />
                <polyline points="8.5 2 14 2 14 7.5" />
                <line x1="7" y1="9" x2="13.8" y2="2.2" />
              </svg>
            </button>
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={openSettings}
          >
            模型设置
          </button>
        </div>
      </header>

      {(activeWorkspace === 'knowledge' || activeWorkspace === 'mindmap') && (
        <nav
          className={`knowledge-workspace-tabs${(activeWorkspace === 'mindmap' ? libraryCollapsed : knowledgeSidebarCollapsed) ? ' is-sidebar-collapsed' : ''}`}
          aria-label="知识库页面"
        >
          <span className="knowledge-workspace-tabs-label" title="知识库">
            <svg
              className="knowledge-workspace-tabs-icon"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.35"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 3.2a1.5 1.5 0 0 1 1.5-1.4h7.8v10.8H4.5A1.5 1.5 0 0 0 3 14.1V3.2Z" />
              <path d="M3 12.6A1.5 1.5 0 0 1 4.5 11.2h7.8M5.6 5.2h4.2" />
            </svg>
            <span className="knowledge-workspace-tabs-label-text">知识库</span>
          </span>
          <div
            className="knowledge-page-tabs"
            role="group"
            aria-label="内容类型"
          >
            <button
              type="button"
              aria-pressed={activeWorkspace === 'knowledge'}
              className={activeWorkspace === 'knowledge' ? 'is-active' : ''}
              onClick={() => void showKnowledgeDocuments()}
            >
              文档{' '}
              <small>
                {catalogDocuments.filter((item) => item.kind === 'doc').length}
              </small>
            </button>
            <button
              type="button"
              aria-pressed={activeWorkspace === 'mindmap'}
              className={activeWorkspace === 'mindmap' ? 'is-active' : ''}
              onClick={() => setActiveWorkspace('mindmap')}
            >
              导图{' '}
              <small>
                {
                  catalogDocuments.filter((item) => item.kind === 'mindmap')
                    .length
                }
              </small>
            </button>
          </div>
        </nav>
      )}

      <section
        className={`workspace${sourceCollapsed ? ' is-source-collapsed' : ''}${libraryCollapsed ? ' is-library-collapsed' : ''}${aiCollapsed ? ' is-ai-collapsed' : ''}${markdownFullscreen ? ' is-markdown-fullscreen' : ''}${activeDocument?.kind === 'mermaid' ? ' is-document-open' : ''}${activeWorkspace === 'mindmap' ? ' is-knowledge-map' : ''}${activeWorkspace !== 'mindmap' && !readerSplitActive ? ' is-workspace-hidden' : ''}`}
        aria-label="Markdown 思维导图编辑器"
        aria-hidden={activeWorkspace !== 'mindmap' && !readerSplitActive}
      >
        <LibraryPanel
          snapshot={librarySnapshot}
          documents={mindmapDocuments}
          currentMarkdown={editorDraft.markdown}
          selectedPath={
            activeDocument?.kind === 'mermaid' || openPlantUmlPath
              ? null
              : editorDraft.relativePath
          }
          selectedPlantUmlPath={openPlantUmlPath}
          selectedTextPath={
            activeDocument?.kind === 'mermaid'
              ? activeDocument.relativePath
              : null
          }
          collapsed={libraryCollapsed}
          shortcutActive={
            activeWorkspace === 'mindmap' &&
            !readerSplitActive &&
            !htmlPreview &&
            !plantUmlSession
          }
          categoryFilter={categoryFilter}
          query={libraryQuery}
          busy={libraryBusy}
          showBooks={false}
          showDocumentCreation={false}
          summarizeEpubOnImport={summarizeEpubOnImport}
          onSearch={setLibraryQuery}
          onChooseRoot={() => void chooseLibraryRoot()}
          onRefresh={() => void loadLibrary(false)}
          onCreateDocument={createNewDocument}
          onCreateWithAi={() => {
            setPrompt('');
            setGenerationError('');
            setGenerationDialogOpen(true);
          }}
          onImportEpub={() => void importEpub()}
          onToggleEpubSummary={setSummarizeEpubOnImport}
          onCreateCategory={() => {
            setCategoryDraft('');
            setLibraryError('');
            setCategoryDialogOpen(true);
          }}
          onRenameFolder={renameLibraryFolder}
          onSelectCategory={setCategoryFilter}
          onOpenDocument={(document) => void openMap(document)}
          onDeleteDocument={(document) => void deleteMap(document)}
          onOpenBook={(book) => void openLibraryEpub(book)}
          onOpenPlantUmlFile={(file) => void openLibraryPlantUml(file)}
          onDeletePlantUmlFile={(file) => void deleteLibraryPlantUmlFile(file)}
          onOpenTextDocument={(file) => void openLibraryTextDocument(file)}
          onDeleteTextDocument={(file) => void deleteLibraryTextDocument(file)}
          onCreateOfKind={(kind) => void createFileOfKind(kind)}
          onToggleCollapse={() =>
            setLibraryCollapsed((collapsed) => !collapsed)
          }
          onNavigateToLine={(lineIndex) => {
            const selectLine = () =>
              markdownEditorRef.current?.selectLine(lineIndex, true);
            if (markdownPaneModeRef.current === 'preview') {
              setMarkdownPaneMode('edit');
              window.requestAnimationFrame(selectLine);
            } else {
              selectLine();
            }
          }}
        />

        {activeWorkspace === 'mindmap' &&
          activeDocument?.kind !== 'mermaid' && (
            <div className="knowledge-file-header" aria-label="当前导图文件">
              <span className="knowledge-file-kind">
                {isStandalonePlantUml
                  ? 'PUML'
                  : isDocumentMapPreview
                    ? 'DOC'
                    : 'MAP'}
              </span>
              <input
                className="knowledge-file-title"
                value={
                  isStandalonePlantUml
                    ? (plantUmlSession?.request.documentTitle ?? 'PlantUML')
                    : editorDraft.title
                }
                onChange={(event) => patchDraft({ title: event.target.value })}
                disabled={isStandalonePlantUml || isDocumentMapPreview}
                aria-label="当前导图标题"
                maxLength={120}
              />
              <span
                className="knowledge-file-path"
                title={
                  isStandalonePlantUml
                    ? (openPlantUmlPath ?? '')
                    : (editorDraft.relativePath ?? '')
                }
              >
                {isStandalonePlantUml
                  ? (openPlantUmlPath ?? '独立图表')
                  : (editorDraft.relativePath ?? '未保存草稿')}
              </span>
              <span className="knowledge-file-save-state" role="status">
                {saveMessage}
              </span>
            </div>
          )}

        {activeDocument?.kind === 'mermaid' &&
          activeWorkspace !== 'knowledge' &&
          activeWorkspace !== 'reader' && (
            <DocumentWorkbench
              document={activeDocument}
              dirty={workbench.dirty}
              statusText={saveMessage}
              theme={theme}
              documents={catalogDocuments}
              categories={librarySnapshot?.documentCategories ?? []}
              renderMarkdownPreview={renderDocumentPreview}
              onSourceChange={(source) => workbench.controller.edit(source)}
              onSave={() => void workbench.controller.save({ manual: true })}
              onRename={(title) => workbench.controller.rename(title)}
              onChangeCategory={(category) =>
                workbench.controller.setCategory(category)
              }
              onChangeTags={(tags) => workbench.controller.setTags(tags)}
              onOpenWikilink={(target) => void openWikilinkTarget(target)}
              onOpenYouTubeLink={openYouTubeVideoInPlayer}
              onRunInTerminal={handleRunCodeInTerminal}
              onOpenAsMindmap={() => void openActiveDocumentAsMindmap()}
              onConvertToMindmap={() => void convertActiveDocumentToMindmap()}
            />
          )}

        <section
          className={`editor-pane${sourceCollapsed ? ' is-collapsed' : ''}${isStandalonePlantUml ? ' is-plantuml-file' : ''}`}
        >
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">01 / SOURCE</span>
              <h1>{isStandalonePlantUml ? 'PUML' : 'Markdown'}</h1>
              {isStandalonePlantUml && (
                <span className="plantuml-source-format">.puml</span>
              )}
            </div>
            {!sourceCollapsed && (
              <div className="source-header-actions">
                <div
                  className="markdown-mode-switch"
                  role="group"
                  aria-label="Markdown 查看模式"
                >
                  <button
                    type="button"
                    className={markdownPaneMode === 'edit' ? 'is-active' : ''}
                    aria-pressed={markdownPaneMode === 'edit'}
                    onClick={() => setMarkdownPaneMode('edit')}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className={
                      markdownPaneMode === 'preview' ? 'is-active' : ''
                    }
                    aria-pressed={markdownPaneMode === 'preview'}
                    onClick={() => setMarkdownPaneMode('preview')}
                  >
                    预览
                  </button>
                </div>
                <button
                  type="button"
                  className="source-history-button"
                  title="查看并恢复历史版本"
                  aria-label="查看历史版本"
                  disabled={
                    !editorDraft.id ||
                    !editorDraft.relativePath ||
                    isDocumentMapPreview
                  }
                  onClick={() => void openDocumentHistory()}
                >
                  历史
                </button>
                <span className="format-badge">.md</span>
                <div className="source-insert-tools" aria-label="插入节点">
                  <button
                    type="button"
                    aria-label="插入 SVG 模板"
                    title="在 Markdown 末尾插入 SVG 模板"
                    disabled={isDocumentMapPreview}
                    onClick={insertSvgTemplate}
                  >
                    SVG
                  </button>
                  <button
                    type="button"
                    aria-label="导入 HTML 文件"
                    title="导入 HTML 文件并插入本地交互卡片"
                    disabled={htmlImportBusy || isDocumentMapPreview}
                    onClick={() => void importHtmlAsset()}
                  >
                    {htmlImportBusy ? '…' : 'HTML'}
                  </button>
                </div>
                <button
                  type="button"
                  className="markdown-fullscreen-button"
                  aria-label={
                    markdownFullscreen ? '退出 Markdown 全屏' : 'Markdown 全屏'
                  }
                  title={
                    markdownFullscreen ? '退出全屏（Esc）' : 'Markdown 全屏'
                  }
                  aria-pressed={markdownFullscreen}
                  onClick={() =>
                    setMarkdownFullscreen((fullscreen) => !fullscreen)
                  }
                >
                  {markdownFullscreen ? '退出' : '全屏'}
                </button>
              </div>
            )}
            <button
              type="button"
              className="pane-collapse-button"
              title={
                sourceCollapsed
                  ? '展开 Markdown 源文本栏'
                  : '收起 Markdown 源文本栏'
              }
              aria-label={
                sourceCollapsed
                  ? '展开 Markdown 源文本栏'
                  : '收起 Markdown 源文本栏'
              }
              aria-expanded={!sourceCollapsed}
              aria-controls="markdown-pane-content"
              onClick={() => setSourceCollapsed((collapsed) => !collapsed)}
            >
              <Icon name={sourceCollapsed ? 'expand' : 'collapse'} />
            </button>
          </div>
          <div className="document-metadata" hidden={isStandalonePlantUml}>
            {isDocumentMapPreview && (
              <div className="document-map-preview-notice" role="status">
                文档导图预览 · 只读
                <button
                  type="button"
                  onClick={() =>
                    void openMap({
                      relativePath: editorDraft.relativePath!,
                      kind: 'doc',
                    })
                  }
                >
                  返回文档
                </button>
              </div>
            )}
            <label className="metadata-title-field">
              标题
              <input
                value={editorDraft.title}
                disabled={isDocumentMapPreview}
                onChange={(event) => patchDraft({ title: event.target.value })}
                aria-label="思维导图标题"
                maxLength={120}
              />
            </label>
            <div className="metadata-grid">
              <label>
                分类文件夹
                <input
                  list="library-category-options"
                  value={editorDraft.category}
                  disabled={isDocumentMapPreview}
                  onChange={(event) =>
                    patchDraft({ category: event.target.value })
                  }
                  placeholder="例如：学习/AI"
                  aria-label="思维导图分类文件夹"
                />
                <datalist id="library-category-options">
                  {librarySnapshot?.mindmapCategories.map((category) => (
                    <option value={category} key={category} />
                  ))}
                </datalist>
              </label>
              <label>
                类型
                <input
                  value={editorDraft.mapType}
                  disabled={isDocumentMapPreview}
                  onChange={(event) =>
                    patchDraft({ mapType: event.target.value })
                  }
                  placeholder="例如：读书笔记"
                  aria-label="思维导图类型"
                  maxLength={40}
                />
              </label>
            </div>
            <label className="metadata-tags-field">
              标签
              <input
                value={editorDraft.tags}
                disabled={isDocumentMapPreview}
                onChange={(event) => patchDraft({ tags: event.target.value })}
                placeholder="用逗号分隔，例如：AI, 入门"
                aria-label="思维导图标签"
              />
            </label>
          </div>
          {isStandalonePlantUml && (
            <div className="plantuml-source-editor-pane">
              <label htmlFor="plantuml-source-editor">PUML 源码</label>
              <textarea
                id="plantuml-source-editor"
                value={plantUmlSession?.source ?? ''}
                onChange={(event) => {
                  const source = event.target.value;
                  setPlantUmlSession((current) =>
                    current ? { ...current, source } : current,
                  );
                }}
                spellCheck={false}
                aria-label="PUML 源码编辑器"
              />
            </div>
          )}
          <div
            id="markdown-pane-content"
            className="markdown-pane-content"
            hidden={isStandalonePlantUml}
          >
            <label
              className="editor-label"
              htmlFor="markdown-editor"
              hidden={markdownPaneMode !== 'edit'}
            >
              编辑源文本
            </label>
            <div
              className="markdown-editor-frame"
              hidden={markdownPaneMode !== 'edit'}
            >
              <MarkdownEditor
                key={markdownEditorSession}
                ref={markdownEditorRef}
                id="markdown-editor"
                value={editorDraft.markdown}
                readOnly={isDocumentMapPreview}
                onChange={handleMarkdownEditorChange}
                onSelectionChange={handleMarkdownSelectionChange}
              />
            </div>
            {markdownPaneMode === 'preview' && (
              <MarkdownPreview
                html={markdownPreviewHtml}
                source={markdownPreviewSource}
                theme={theme}
                onCodeChange={(language, previous, next, sourceRange) =>
                  codeBlockEditHandlerRef.current(
                    language,
                    previous,
                    next,
                    sourceRange,
                  )
                }
                onOpenPlantUmlEditor={(source, language, onSave) =>
                  openPlantUmlWorkspace({ source, language, onSave })
                }
                onRunInTerminal={handleRunCodeInTerminal}
              />
            )}
          </div>
          <div className="editor-footer">
            {isStandalonePlantUml ? (
              <>
                <span>PUML 源码</span>
                <span>{plantUmlSession?.source.length ?? 0} 字符</span>
              </>
            ) : (
              <>
                <span>{saveMessage}</span>
                <span>{editorDraft.markdown.length} 字符</span>
              </>
            )}
          </div>
        </section>

        <section className="preview-pane">
          <div className="pane-heading preview-heading">
            <div className="preview-title">
              <span className="pane-kicker">02 / CANVAS</span>
              <h1>
                {plantUmlSession
                  ? (plantUmlSession.request.documentTitle ?? 'PlantUML')
                  : '思维导图'}
              </h1>
            </div>
            {!plantUmlSession && (
              <div
                className="canvas-tools"
                role="toolbar"
                aria-label="画布工具"
              >
                <div className="canvas-tool-actions">
                  {isHtmlInteractiveCanvas && (
                    <button
                      type="button"
                      className="html-canvas-mode-button"
                      onClick={() => setHtmlCanvasEmbed(null)}
                    >
                      退出 HTML 交互
                    </button>
                  )}
                  <button
                    type="button"
                    className="canvas-node-action"
                    title="添加子节点"
                    aria-label="添加子节点"
                    disabled={!canAddSelectedNode}
                    onClick={() => applySelectedNodeOperation('child')}
                  >
                    子级＋
                  </button>
                  <button
                    type="button"
                    className="canvas-node-action"
                    title="添加同级节点"
                    aria-label="添加同级节点"
                    disabled={!canAddSelectedNode}
                    onClick={() => applySelectedNodeOperation('sibling')}
                  >
                    同级＋
                  </button>
                  <button
                    type="button"
                    className="canvas-node-action"
                    title="删除所选节点及其子节点，可用撤销恢复"
                    aria-label="删除所选节点"
                    disabled={!canDeleteSelectedNode}
                    onClick={() => applySelectedNodeOperation('delete')}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className="canvas-node-action"
                    title="编辑所选节点的 Markdown 备注"
                    aria-label="编辑节点备注"
                    disabled={!canEditSelectedNodeNote}
                    onClick={openSelectedNodeNote}
                  >
                    备注
                  </button>
                  <button
                    type="button"
                    className="canvas-node-action"
                    title="粘贴 YouTube 链接或 iframe，并添加为所选节点的子节点"
                    aria-label="为所选节点嵌入 YouTube 视频"
                    disabled={!canAddSelectedNode}
                    onClick={openVideoEmbedDialog}
                  >
                    视频
                  </button>
                  <span className="tool-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="canvas-node-action"
                    title="撤销"
                    aria-label="撤销"
                    onClick={() => markdownEditorRef.current?.undo()}
                  >
                    撤销
                  </button>
                  <button
                    type="button"
                    className="canvas-node-action"
                    title="重做"
                    aria-label="重做"
                    onClick={() => markdownEditorRef.current?.redo()}
                  >
                    重做
                  </button>
                </div>
                <div className="canvas-tool-view">
                  <details className="canvas-help">
                    <summary
                      title="查看画布操作说明"
                      aria-label={
                        isHtmlInteractiveCanvas
                          ? '查看 HTML 交互模式说明'
                          : '查看画布操作说明'
                      }
                    >
                      <span
                        className={`hint-dot${isHtmlInteractiveCanvas ? ' is-active' : ''}`}
                        aria-hidden="true"
                      />
                      {isHtmlInteractiveCanvas ? 'HTML 交互' : '帮助'}
                    </summary>
                    <div
                      className="canvas-help-popover"
                      role="group"
                      aria-label="画布操作说明"
                    >
                      <p>
                        <strong>画布</strong>拖动平移 · 滚轮缩放 · 实时预览
                      </p>
                      <p>
                        <strong>节点</strong>
                        双击编辑 · Enter 换行 · Ctrl+Enter 添加同级 · Tab
                        添加子级
                      </p>
                      <p>
                        <strong>自动换行</strong>约 20
                        个汉字；短文本按内容宽度显示
                      </p>
                      <p>
                        <strong>内容</strong>支持
                        Markdown、数学公式、Mermaid、ECharts 和 Python 代码围栏
                      </p>
                      {isHtmlInteractiveCanvas && (
                        <p className="canvas-help-active">
                          <strong>HTML 交互</strong>
                          组件区域接收鼠标操作；点击节点顶部或工具栏中的退出按钮可恢复画布操作。
                        </p>
                      )}
                    </div>
                  </details>
                  <div
                    className="canvas-spacing-control"
                    role="group"
                    aria-label="节点水平和垂直间距"
                    title="分别调整水平和垂直间距；默认值为 56 和 14"
                  >
                    <label className="canvas-spacing-axis" title="水平节点间距">
                      <span>横</span>
                      <input
                        type="range"
                        min={28}
                        max={112}
                        step={4}
                        value={activeNodeSpacing.horizontal}
                        aria-label="水平节点距离"
                        aria-valuetext={`${activeNodeSpacing.horizontal}`}
                        onChange={(event) =>
                          setNodeSpacing({
                            ...activeNodeSpacing,
                            horizontal: Number(event.target.value),
                          })
                        }
                      />
                      <output>{activeNodeSpacing.horizontal}</output>
                    </label>
                    <label className="canvas-spacing-axis" title="垂直节点间距">
                      <span>竖</span>
                      <input
                        type="range"
                        min={7}
                        max={28}
                        step={1}
                        value={activeNodeSpacing.vertical}
                        aria-label="垂直节点距离"
                        aria-valuetext={`${activeNodeSpacing.vertical}`}
                        onChange={(event) =>
                          setNodeSpacing({
                            ...activeNodeSpacing,
                            vertical: Number(event.target.value),
                          })
                        }
                      />
                      <output>{activeNodeSpacing.vertical}</output>
                    </label>
                  </div>
                  <span className="tool-divider" aria-hidden="true" />
                  <button
                    type="button"
                    title="缩小"
                    aria-label="缩小"
                    onClick={() => handleZoom(0.82)}
                  >
                    <Icon name="minus" />
                  </button>
                  <button
                    type="button"
                    title="放大"
                    aria-label="放大"
                    onClick={() => handleZoom(1.22)}
                  >
                    <Icon name="plus" />
                  </button>
                  <span className="tool-divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="fit-button"
                    title="适应画布"
                    aria-label="适应画布"
                    onClick={() => {
                      pendingInitialFitRef.current = false;
                      void markmapRef.current?.fit();
                    }}
                  >
                    <Icon name="fit" />
                    <span>适应画布</span>
                  </button>
                  <div className="map-style-picker" ref={mindmapStylePickerRef}>
                    <button
                      type="button"
                      className="map-style-trigger"
                      aria-haspopup="menu"
                      aria-expanded={mindmapStyleMenuOpen}
                      aria-label={`思维导图样式：${mindmapStyles.find((style) => style.id === mindmapStyle)?.label}，点击切换`}
                      onClick={() => setMindmapStyleMenuOpen((open) => !open)}
                    >
                      <span
                        className={`map-style-trigger-swatch is-${mindmapStyle}`}
                        aria-hidden="true"
                      >
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>样式</span>
                      <span className="map-style-current">
                        {
                          mindmapStyles.find(
                            (style) => style.id === mindmapStyle,
                          )?.label
                        }
                      </span>
                      <span className="map-style-caret" aria-hidden="true">
                        ⌄
                      </span>
                    </button>
                    {mindmapStyleMenuOpen && (
                      <div
                        className="map-style-menu"
                        role="menu"
                        aria-label="选择思维导图样式"
                      >
                        {mindmapStyles.map((style) => (
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={mindmapStyle === style.id}
                            className={`map-style-option${mindmapStyle === style.id ? ' is-selected' : ''}`}
                            key={style.id}
                            onClick={() => {
                              setMindmapStyle(style.id);
                              setMindmapStyleMenuOpen(false);
                            }}
                          >
                            <span
                              className={`map-style-preview is-${style.id}`}
                              aria-hidden="true"
                            >
                              <i />
                              <i />
                              <i />
                            </span>
                            <span className="map-style-option-copy">
                              <span className="map-style-title-row">
                                <strong>{style.label}</strong>
                                <span className="map-style-badge">
                                  {style.badge}
                                </span>
                              </span>
                              <span className="map-style-summary">
                                {style.summary}
                              </span>
                              <span className="map-style-best-for">
                                <em>适用：</em>
                                {style.bestFor}
                              </span>
                            </span>
                            <span
                              className="map-style-check"
                              aria-hidden="true"
                            >
                              {mindmapStyle === style.id ? '✓' : ''}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          {focusedMapPath && !plantUmlSession && (
            <div className="mindmap-focus-banner" aria-label="当前分支路径">
              <div className="mindmap-focus-breadcrumb">
                {focusedMindmapPath.map((node, index) => (
                  <span key={node.path}>
                    {index > 0 && <i aria-hidden="true">/</i>}
                    {node.label || '（无标题）'}
                  </span>
                ))}
              </div>
              <button type="button" onClick={restoreFullMindmap}>
                返回完整图
              </button>
            </div>
          )}
          <div className="canvas-wrap">
            <svg
              ref={svgRef}
              className="mindmap-canvas"
              aria-label="Markdown 思维导图预览"
              style={{ display: plantUmlSession ? 'none' : 'block' }}
            />
            {!plantUmlSession && (
              <MindmapMiniTree
                root={mindmapNavigationTree}
                selectedPath={activeMapPath}
                onSelect={selectMindmapNode}
              />
            )}
            {!plantUmlSession && canvasNodeContextMenu && (
              <div
                className="canvas-node-context-menu"
                role="menu"
                aria-label="节点操作"
                style={{
                  left: canvasNodeContextMenu.left,
                  top: canvasNodeContextMenu.top,
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => focusMapBranch(canvasNodeContextMenu.path)}
                >
                  以此节点聚焦
                </button>
              </div>
            )}
            {plantUmlSession ? (
              <PlantUmlWorkspace
                request={plantUmlSession.request}
                source={plantUmlSession.source}
                theme={theme}
                onSourceChange={(source) => {
                  const current = plantUmlSessionRef.current;
                  if (!current) return;
                  const nextSession = { ...current, source };
                  plantUmlSessionRef.current = nextSession;
                  setPlantUmlSession(nextSession);
                }}
                onSourceSaved={(savedSource) => {
                  const current = plantUmlSessionRef.current;
                  if (!current) return;
                  const nextSession = {
                    ...current,
                    source: savedSource,
                    savedSource,
                    request: { ...current.request, source: savedSource },
                  };
                  plantUmlSessionRef.current = nextSession;
                  setPlantUmlSession(nextSession);
                }}
                onClose={() => {
                  plantUmlSessionRef.current = null;
                  setPlantUmlSession(null);
                }}
              />
            ) : (
              <div className="canvas-corner">
                MARKMAP <span>0.18</span>
              </div>
            )}
          </div>
        </section>

        <aside
          id="ai-sidebar"
          className={`ai-sidebar${aiCollapsed ? ' is-collapsed' : ''}`}
          aria-label="LLM 面板"
        >
          <div className="pane-heading">
            <div>
              <span className="pane-kicker">03 / CO-PILOT</span>
              <h1>LLM</h1>
            </div>
            {!aiCollapsed && (
              <div className="ai-model-picker" ref={modelPickerRef}>
                <button
                  type="button"
                  className="ai-model-badge ai-model-picker-trigger"
                  aria-haspopup="dialog"
                  aria-expanded={modelPickerOpen}
                  aria-label={'选择 API 模型，当前为 ' + providerSettings.model}
                  title="选择当前 API 提供的模型"
                  onClick={toggleModelPicker}
                >
                  <span className="model-dot" />
                  <span>API · {providerLabel(providerSettings.baseUrl)}</span>
                  <strong>{providerSettings.model || '未配置'}</strong>
                  <span className="ai-model-chevron" aria-hidden="true">
                    ⌄
                  </span>
                </button>
                {modelPickerOpen && (
                  <div
                    className="ai-model-menu"
                    role="dialog"
                    aria-label="选择 API 模型"
                  >
                    <div className="ai-model-menu-heading">
                      <strong>选择 API 模型</strong>
                      <button
                        type="button"
                        className="ai-model-refresh"
                        disabled={providerModelsLoading}
                        onClick={() => void loadProviderModels()}
                      >
                        {providerModelsLoading ? '读取中…' : '刷新列表'}
                      </button>
                    </div>
                    <small className="ai-model-menu-endpoint">
                      {providerSettings.baseUrl}
                    </small>
                    <input
                      className="ai-model-search"
                      type="search"
                      value={providerModelQuery}
                      onChange={(event) =>
                        setProviderModelQuery(event.target.value)
                      }
                      placeholder="筛选模型"
                      aria-label="筛选模型"
                    />
                    {providerModelsLoading && (
                      <div className="ai-model-menu-status">
                        正在读取 API 模型…
                      </div>
                    )}
                    {!providerModelsLoading && providerModelsError && (
                      <div className="ai-model-menu-error" role="status">
                        {providerModelsError}
                      </div>
                    )}
                    {!providerModelsLoading &&
                      providerModels.length === 0 &&
                      !providerModelsError && (
                        <div className="ai-model-menu-status">
                          API 尚未返回模型列表，可在下方手动输入。
                        </div>
                      )}
                    <div
                      className="ai-model-options"
                      role="listbox"
                      aria-label="API 可用模型"
                    >
                      {providerModels
                        .filter((model) =>
                          model
                            .toLowerCase()
                            .includes(providerModelQuery.trim().toLowerCase()),
                        )
                        .map((model) => (
                          <button
                            key={model}
                            type="button"
                            role="option"
                            aria-selected={providerSettings.model === model}
                            className={
                              providerSettings.model === model
                                ? 'is-selected'
                                : ''
                            }
                            onClick={() => chooseProviderModel(model)}
                          >
                            {model}
                          </button>
                        ))}
                    </div>
                    {!providerModelsLoading &&
                      providerModels.length > 0 &&
                      !providerModels.some((model) =>
                        model
                          .toLowerCase()
                          .includes(providerModelQuery.trim().toLowerCase()),
                      ) && (
                        <div className="ai-model-menu-status">
                          没有匹配的模型。
                        </div>
                      )}
                    <form
                      className="ai-model-manual"
                      onSubmit={(event) => {
                        event.preventDefault();
                        chooseProviderModel(manualProviderModel);
                      }}
                    >
                      <label htmlFor="manual-api-model">手动输入模型 ID</label>
                      <div>
                        <input
                          id="manual-api-model"
                          value={manualProviderModel}
                          onChange={(event) =>
                            setManualProviderModel(event.target.value)
                          }
                          maxLength={200}
                          placeholder="例如 deepseek-chat"
                        />
                        <button
                          type="submit"
                          disabled={!manualProviderModel.trim()}
                        >
                          使用
                        </button>
                      </div>
                    </form>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              className="pane-collapse-button"
              title={aiCollapsed ? '展开 LLM 栏' : '收起 LLM 栏'}
              aria-label={aiCollapsed ? '展开 LLM 栏' : '收起 LLM 栏'}
              aria-expanded={!aiCollapsed}
              aria-controls="ai-sidebar"
              onClick={() => setAiCollapsed((collapsed) => !collapsed)}
            >
              <Icon name={aiCollapsed ? 'expand' : 'collapse'} />
            </button>
          </div>
          <div className="ai-content">
            <div
              className="ai-mode-switch"
              role="tablist"
              aria-label="LLM 分析模式"
            >
              <button
                type="button"
                role="tab"
                aria-selected={aiMode === 'drilldown'}
                className={aiMode === 'drilldown' ? 'is-active' : ''}
                onClick={() => setAiMode('drilldown')}
              >
                节点下探
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={aiMode === 'visualization'}
                className={aiMode === 'visualization' ? 'is-active' : ''}
                onClick={() => setAiMode('visualization')}
              >
                可视化分析
              </button>
            </div>
            <div
              className="ai-mode-content ai-agent-mode"
              hidden={aiMode !== 'drilldown'}
            >
              <AgentPanel
                mode="drilldown"
                provider={providerSettings}
                providerLabel={providerLabel(providerSettings.baseUrl)}
                capabilities={agentCapabilities}
                target={selectedAiTarget}
                mapBrief={mindmapTurnBrief}
                mapMarkdown={editorDraft.markdown}
                currentRevision={editorDraft.revision}
                onApplyProposal={applyAgentProposal}
                onUndoProposal={undoAgentProposal}
              />
            </div>
            <div
              className="ai-mode-content ai-agent-mode"
              hidden={aiMode !== 'visualization'}
            >
              <AgentPanel
                mode="visualization"
                provider={providerSettings}
                providerLabel={providerLabel(providerSettings.baseUrl)}
                capabilities={agentCapabilities}
                target={selectedAiTarget}
                mapBrief={mindmapTurnBrief}
                mapMarkdown={editorDraft.markdown}
                currentRevision={editorDraft.revision}
                onApplyProposal={applyAgentProposal}
                onUndoProposal={undoAgentProposal}
              />
            </div>
          </div>
        </aside>
      </section>

      <section
        className={`ebook-workspace-stage${activeWorkspace !== 'reader' ? ' is-workspace-hidden' : ''}`}
        aria-label="电子书工作区"
        aria-hidden={activeWorkspace !== 'reader'}
      >
        {readerOpened && (
          <Suspense
            fallback={<div className="ebook-loading">正在载入电子书…</div>}
          >
            {epubReader ? (
              <EpubReader
                key={epubReader.progressKey}
                selection={epubReader}
                theme={theme}
                provider={providerSettings}
                embedded
                knowledgeOpen={readerKnowledgeActive}
                knowledgeExists={Boolean(activeBookKnowledgeTarget?.document)}
                knowledgeBusy={bookKnowledgeBusy}
                mindmapOpen={readerSplitActive}
                mindmapExists={Boolean(activeBookMindmapTarget?.document)}
                mindmapBusy={bookMindmapBusy}
                chapterNavigationRequest={epubChapterNavigation}
                onOpenTask={openLinkedTask}
                onCreateTask={(chapter) => {
                  const book = librarySnapshot?.books.find(
                    (item) => item.relativePath === epubReader.relativePath,
                  );
                  if (book) createBookTask(book, chapter);
                  else setLibraryError('找不到当前电子书，请刷新文件库。');
                }}
                onToggleKnowledge={() => void toggleBookKnowledge()}
                onToggleMindmap={() => void toggleBookMindmap()}
                onWakeAi={() => {
                  setTerminalDockAndStore('right');
                  setTerminalOpen(true);
                }}
                onAgentBridgeChange={(bridge) => {
                  readerAgentBridgeRef.current = bridge;
                }}
                onChapterChange={(info) => {
                  setCurrentEpubChapter(info);
                }}
                onAnnotationsChange={(annotations) => {
                  setEpubAnnotations(annotations);
                }}
                onWriteFootnoteToNote={(payload) => {
                  void handleWriteEpubFootnoteToNote(payload);
                }}
                onClose={() => {
                  setReaderKnowledgeOpen(false);
                  setReaderSplitOpen(false);
                  setEpubChapterNavigation(null);
                  setEpubReader(null);
                }}
              />
            ) : (
              <EbookWorkspace
                active={activeWorkspace === 'reader'}
                snapshot={librarySnapshot}
                busy={libraryBusy}
                onImport={() => void importEpubBook()}
                onRefresh={() => void loadLibrary(false)}
                onChooseRoot={() => void chooseLibraryRoot()}
                onOpenBook={(book) => void openLibraryEpub(book)}
                onCreateTask={(book) => createBookTask(book)}
                onDeleteBook={deleteLibraryEpubBook}
                onOpenExams={(bookKey) => {
                  setExamBookFilter(bookKey);
                  setActiveWorkspace('exams');
                }}
              />
            )}
          </Suspense>
        )}
      </section>

      <section
        className={`exam-workspace-stage${activeWorkspace !== 'exams' ? ' is-workspace-hidden' : ''}`}
        aria-label="试卷工作区"
        aria-hidden={activeWorkspace !== 'exams'}
      >
        <ExamCenterWorkspace
          active={activeWorkspace === 'exams'}
          provider={providerSettings}
          books={librarySnapshot?.books ?? []}
          libraryRoot={librarySnapshot?.rootPath ?? ''}
          bookFilter={examBookFilter}
          onBookFilterChange={setExamBookFilter}
          onOpenShelf={() => setActiveWorkspace('reader')}
          onOpenBook={(book) => void openLibraryEpub(book)}
          onDueCountChange={setDueExamCount}
        />
      </section>

      <section
        className={`player-workspace-stage${
          activeWorkspace !== 'player'
            ? isVideoStageOffscreen
              ? ' is-workspace-hidden-offscreen'
              : ' is-workspace-hidden'
            : ''
        }`}
        aria-label="播放器工作区"
        aria-hidden={activeWorkspace !== 'player'}
      >
        {playerOpened && (
          <Suspense
            fallback={<div className="player-loading">正在载入播放器…</div>}
          >
            <PlayerWorkspace
              active={activeWorkspace === 'player'}
              provider={providerSettings}
              capabilities={agentCapabilities}
              openLearningPathRequest={playerOpenLearningPathRequest}
              openTaskVideoRequest={playerOpenTaskVideoRequest}
              onOpenTaskVideoRequestHandled={(id) =>
                setPlayerOpenTaskVideoRequest((request) =>
                  request?.id === id ? null : request,
                )
              }
              onCreateVideoTask={(item, startSeconds) =>
                createResourceTask({
                  kind: 'youtube',
                  resourceId: item.videoId,
                  title: item.title,
                  startSeconds: Math.floor(startSeconds),
                })
              }
              onOpenTask={openLinkedTask}
              onOpenLearningPathRequestHandled={(id) =>
                setPlayerOpenLearningPathRequest((request) =>
                  request?.id === id ? null : request,
                )
              }
              openFavoritesRequestId={playerOpenFavoritesRequestId}
              onOpenFavoritesRequestHandled={(id) =>
                setPlayerOpenFavoritesRequestId((current) =>
                  current === id ? null : current,
                )
              }
              onSendTerminalCommand={(text, execute = false) => {
                setTerminalOpen(true);
                if (text) {
                  setPendingTerminalRawInput({
                    id: `raw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    text,
                    execute,
                  });
                }
              }}
              onExportMarkdownToMindmap={(title, md) => {
                void (async () => {
                  if (!leavePlantUmlSession()) return;
                  if (!(await workbench.controller.leave())) return;
                  if (draftRef.current.dirty && !(await saveDraft())) return;
                  const revision = draftRef.current.revision + 1;
                  const category = categoryFilter || '未分类';
                  installDraft(
                    createDraft({
                      title: title.trim() || '学习路径',
                      category,
                      mapType: '学习路径',
                      tags: '学习路径, 视频',
                      markdown: md,
                      dirty: true,
                      revision,
                    }),
                  );
                  setSaveMessage('已从学习路径导出为思维导图草稿');
                  setActiveWorkspace('mindmap');
                })();
              }}
              onExportTranscriptToKnowledge={exportTranscriptToKnowledge}
              onSaveVideoNoteToKnowledge={saveVideoNoteToKnowledge}
              onFindVideoKnowledgeDocument={findVideoKnowledgeDocument}
            />
          </Suspense>
        )}
      </section>

      {activeWorkspace === 'knowledge' && (
        <section
          className="knowledge-workspace-stage"
          aria-label="知识库工作区"
        >
          <KnowledgeWorkspace
            rootPath={librarySnapshot?.rootPath ?? null}
            documents={catalogDocuments}
            categories={librarySnapshot?.documentCategories ?? []}
            activeDocument={
              activeDocument?.kind === 'doc' ? activeDocument : null
            }
            errorMessage={libraryError}
            busy={libraryBusy}
            onChooseRoot={() => void chooseLibraryRoot()}
            onRefresh={() => void loadLibrary(false)}
            onCreateCategory={(category) => createKnowledgeCategory(category)}
            onOpenNote={(note) => void openKnowledgeNote(note)}
            onCloseNote={() => workbench.controller.leave()}
            onCreateNote={(folder, template) =>
              void createKnowledgeNote(folder, template)
            }
            onDeleteNote={(note) => void deleteMap(note, { skipConfirm: true })}
            onSidebarLayoutChange={onKnowledgeSidebarLayoutChange}
            workbench={{
              dirty: workbench.dirty,
              statusText: saveMessage,
              theme,
              renderMarkdownPreview: renderDocumentPreview,
              onSourceChange: (source) => workbench.controller.edit(source),
              onSave: () => void workbench.controller.save({ manual: true }),
              onRename: (title) => workbench.controller.rename(title),
              onChangeCategory: (category) =>
                workbench.controller.setCategory(category),
              onChangeTags: (tags) => workbench.controller.setTags(tags),
              onOpenWikilink: (target) => void openWikilinkTarget(target),
              onOpenYouTubeLink: openYouTubeVideoInPlayer,
              onRunInTerminal: handleRunCodeInTerminal,
              onOpenAsMindmap: () => void openKnowledgeNoteAsMindmap(),
              onConvertToMindmap: () => void convertActiveDocumentToMindmap(),
            }}
          />
        </section>
      )}

      <section
        className={`terminal-workspace-stage${activeWorkspace !== 'terminal' ? ' is-workspace-hidden' : ''}`}
        aria-label="终端与系统实验工作区"
        aria-hidden={activeWorkspace !== 'terminal'}
      >
        {terminalWorkspaceOpened && (
          <Suspense
            fallback={
              <div className="terminal-workspace-loading">
                正在载入终端实验室…
              </div>
            }
          >
            <TerminalWorkspace
              active={activeWorkspace === 'terminal'}
              cwd={librarySnapshot?.rootPath ?? ''}
              theme={theme}
              books={librarySnapshot?.books ?? []}
              onOpenBook={(book) => void openLibraryEpub(book)}
              bridge={{
                provider: providerSettings,
                capabilities: agentCapabilities,
                books: librarySnapshot?.books ?? [],
                documents: librarySnapshot?.documents ?? [],
                activeDocument: activeDocument
                  ? {
                      title: activeDocument.title,
                      relativePath: activeDocument.relativePath ?? null,
                      kind: activeDocument.kind,
                    }
                  : null,
                activeMindmapTitle: editorDraft.title,
                onNavigateWorkspace: (ws) => setActiveWorkspace(ws),
                onOpenBook: (book) => void openLibraryEpub(book),
                onOpenYouTubeVideo: (videoId, startSeconds, title) =>
                  openYouTubeVideoInPlayer(videoId, startSeconds ?? 0, title),
                onSaveMarkdownNote: async ({ title, category, source }) => {
                  try {
                    await libraryApi.createTextDocument({
                      kind: 'doc',
                      category: category || '代码实验',
                      title,
                      source,
                    });
                    await loadLibrary(false);
                    setSaveMessage(`已将「${title}」保存到知识库`);
                    return true;
                  } catch {
                    return false;
                  }
                },
              }}
            />
          </Suspense>
        )}
      </section>

      {activeWorkspace === 'tasks' && (
        <section
          className="task-workspace-stage"
          aria-label="任务工作区"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            height: '100%',
            overflow: 'hidden',
            display: 'flex',
          }}
        >
          <Suspense
            fallback={<div className="player-loading">正在载入任务工作台…</div>}
          >
            <TaskWorkspace
              library={librarySnapshot}
              active={activeWorkspace === 'tasks'}
              pendingHabitCount={pendingHabitCount}
              createRequest={taskCreateRequest}
              openTaskId={taskOpenId}
              onOpenTaskHandled={() => setTaskOpenId(null)}
              onCreateRequestHandled={(id) =>
                setTaskCreateRequest((request) =>
                  request?.id === id ? null : request,
                )
              }
              onOpenResource={openTaskResource}
            />
          </Suspense>
        </section>
      )}

      {activeWorkspace === 'literature' && (
        <section
          className="literature-workspace-stage"
          aria-label="论文工作区"
          style={{
            flex: 1,
            height: '100%',
            overflow: 'hidden',
            display: 'flex',
          }}
        >
          <Suspense
            fallback={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  width: '100%',
                  color: '#94a3b8',
                }}
              >
                正在载入论文工作台…
              </div>
            }
          >
            <LiteratureWorkspace
              onOpenMindmap={(md, title) => {
                void (async () => {
                  if (!leavePlantUmlSession()) return;
                  if (!(await workbench.controller.leave())) return;
                  if (draftRef.current.dirty && !(await saveDraft())) return;
                  const revision = draftRef.current.revision + 1;
                  const category = categoryFilter || '未分类';
                  installDraft(
                    createDraft({
                      title: title.trim() || '文献思维导图',
                      category,
                      mapType: '文献导图',
                      tags: '论文, 导图',
                      markdown: md,
                      dirty: true,
                      revision,
                    }),
                  );
                  setSaveMessage('已从文献解构为思维导图草稿');
                  setActiveWorkspace('mindmap');
                })();
              }}
            />
          </Suspense>
        </section>
      )}

      <section
        className={`feed-workspace-stage${activeWorkspace !== 'feed' ? ' is-workspace-hidden' : ''}`}
        aria-label="博客与 RSS 订阅工作区"
        aria-hidden={activeWorkspace !== 'feed'}
      >
        {feedOpened && (
          <Suspense
            fallback={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  color: 'var(--muted)',
                  fontSize: '14px',
                }}
              >
                正在载入订阅工作区…
              </div>
            }
          >
            <FeedWorkspace
              active={activeWorkspace === 'feed'}
              provider={providerSettings}
              externalRevision={feedExternalRevision}
              focusArticleRequest={feedFocusArticleRequest}
              onFocusArticleRequestHandled={(id) =>
                setFeedFocusArticleRequest((current) =>
                  current?.id === id ? null : current,
                )
              }
              onSelectedArticleChange={(id, title) => {
                feedSelectedArticleIdRef.current = id;
                setTerminalFeedArticleTitle(title);
              }}
              onAnalyzeArticle={(id) => {
                feedSelectedArticleIdRef.current = id;
                setTerminalDock('right');
                setTerminalOpen(true);
              }}
              onOpenMindmap={(md, title) => {
                void (async () => {
                  if (!leavePlantUmlSession()) return;
                  if (!(await workbench.controller.leave())) return;
                  if (draftRef.current.dirty && !(await saveDraft())) return;
                  const revision = draftRef.current.revision + 1;
                  const category = categoryFilter || '未分类';
                  installDraft(
                    createDraft({
                      title: title.trim() || '博客导图',
                      category,
                      mapType: '博客导图',
                      tags: 'RSS, 博客, 导图',
                      markdown: md,
                      dirty: true,
                      revision,
                    }),
                  );
                  setSaveMessage('已从博客文章生成思维导图草稿');
                  setActiveWorkspace('mindmap');
                })();
              }}
            />
          </Suspense>
        )}
      </section>

      {isTerminalDrawerOpen && (
        <section
          className={`seamind-terminal-drawer${terminalRightActive ? ' is-right' : ''}`}
          aria-label="全局终端抽屉"
        >
          <div
            className="terminal-drawer-resize-handle"
            role="separator"
            aria-label={terminalRightActive ? '调整终端宽度' : '调整终端高度'}
            aria-orientation={terminalRightActive ? 'vertical' : 'horizontal'}
            aria-valuemin={terminalRightActive ? 320 : 160}
            aria-valuemax={
              terminalRightActive
                ? Math.round(window.innerWidth * 0.62)
                : Math.round(window.innerHeight * 0.72)
            }
            aria-valuenow={terminalRightActive ? terminalWidth : terminalHeight}
            aria-controls="seamind-terminal-panel"
            tabIndex={0}
            onPointerDown={
              terminalRightActive
                ? onTerminalWidthPointerDown
                : onTerminalResizePointerDown
            }
            onPointerMove={
              terminalRightActive
                ? onTerminalWidthPointerMove
                : onTerminalResizePointerMove
            }
            onPointerUp={
              terminalRightActive
                ? onTerminalWidthPointerUp
                : onTerminalResizePointerUp
            }
            onPointerCancel={
              terminalRightActive
                ? onTerminalWidthPointerUp
                : onTerminalResizePointerUp
            }
            onKeyDown={
              terminalRightActive
                ? onTerminalWidthKeyDown
                : onTerminalResizeKeyDown
            }
            title={
              terminalRightActive
                ? '拖动调整宽度；方向键微调；Home 恢复默认宽度'
                : '拖动调整高度；方向键微调；Home 恢复默认高度'
            }
          />
          <div id="seamind-terminal-panel" className="terminal-global-panel">
            <Suspense
              fallback={
                <div className="seamind-terminal-loading">正在加载终端…</div>
              }
            >
              {terminalOpen && runnerTerminalOpen ? (
                <div className="terminal-split-container">
                  <div
                    className="terminal-split-pane terminal-split-pane-top"
                    style={{ height: `${terminalSplitRatio * 100}%` }}
                  >
                    <TerminalPanel
                      key={`ai-terminal-${librarySnapshot?.rootPath ?? 'default'}`}
                      title="AI · 终端"
                      noteText={
                        activeWorkspace === 'feed'
                          ? `当前文章：${terminalFeedArticleTitle || '请在左侧选择文章'}。启动 AI CLI 后，可调用 rss_get_current_article 读取订阅源正文并分析，也可调用 rss_add_subscription 添加订阅。`
                          : undefined
                      }
                      cwd={librarySnapshot?.rootPath ?? ''}
                      theme={theme}
                      dock={terminalRightActive ? 'right' : 'bottom'}
                      canDockRight={canDockTerminalRight}
                      onToggleDock={() =>
                        setTerminalDockAndStore(
                          terminalRightActive ? 'bottom' : 'right',
                        )
                      }
                      pendingCommand={pendingTerminalCommand}
                      pendingRawInput={pendingTerminalRawInput}
                      onCommandSubmitted={(id) =>
                        setPendingTerminalCommand((current) =>
                          current?.id === id ? null : current,
                        )
                      }
                      onRawInputSent={(id) =>
                        setPendingTerminalRawInput((current) =>
                          current?.id === id ? null : current,
                        )
                      }
                      onCommandOutput={(id, output) => {
                        const callback =
                          terminalCommandResultsRef.current.get(id);
                        if (!callback) return;
                        terminalCommandResultsRef.current.delete(id);
                        callback(output);
                      }}
                      onClose={() => {
                        const request = pendingTerminalCommand;
                        if (request) {
                          const callback =
                            terminalCommandResultsRef.current.get(request.id);
                          terminalCommandResultsRef.current.delete(request.id);
                          callback?.('终端已关闭，命令未执行。');
                        }
                        setPendingTerminalCommand(null);
                        setTerminalOpen(false);
                      }}
                    />
                  </div>
                  <div
                    className="terminal-split-horizontal-divider"
                    role="separator"
                    aria-orientation="horizontal"
                    onPointerDown={onSplitDividerPointerDown}
                    title="上下拖动调整 AI 终端与代码运行终端的高度比例"
                  >
                    <div className="terminal-split-divider-handle" />
                  </div>
                  <div
                    className="terminal-split-pane terminal-split-pane-bottom"
                    style={{ height: `${(1 - terminalSplitRatio) * 100}%` }}
                  >
                    <TerminalPanel
                      key={`runner-terminal-${librarySnapshot?.rootPath ?? 'default'}`}
                      title="代码运行 · C/C++"
                      badge="C RUNNER"
                      hideCliButtons
                      hideDockButton
                      noteText="已就绪 C/C++ 运行环境。支持实时交互、scanf 输入与单步执行。"
                      cwd={librarySnapshot?.rootPath ?? ''}
                      theme={theme}
                      dock={terminalRightActive ? 'right' : 'bottom'}
                      canDockRight={canDockTerminalRight}
                      onToggleDock={() => {}}
                      pendingCommand={pendingRunnerCommand}
                      pendingRawInput={pendingRunnerRawInput}
                      onCommandSubmitted={(id) =>
                        setPendingRunnerCommand((current) =>
                          current?.id === id ? null : current,
                        )
                      }
                      onRawInputSent={(id) =>
                        setPendingRunnerRawInput((current) =>
                          current?.id === id ? null : current,
                        )
                      }
                      onCommandOutput={() => {}}
                      onClose={() => {
                        setPendingRunnerCommand(null);
                        setPendingRunnerRawInput(null);
                        setRunnerTerminalOpen(false);
                      }}
                    />
                  </div>
                </div>
              ) : terminalOpen ? (
                <TerminalPanel
                  key={
                    librarySnapshot?.rootPath ?? 'default-terminal-directory'
                  }
                  noteText={
                    activeWorkspace === 'feed'
                      ? `当前文章：${terminalFeedArticleTitle || '请在左侧选择文章'}。启动 AI CLI 后，可调用 rss_get_current_article 读取订阅源正文并分析，也可调用 rss_add_subscription 添加订阅。`
                      : undefined
                  }
                  cwd={librarySnapshot?.rootPath ?? ''}
                  theme={theme}
                  dock={terminalRightActive ? 'right' : 'bottom'}
                  canDockRight={canDockTerminalRight}
                  onToggleDock={() =>
                    setTerminalDockAndStore(
                      terminalRightActive ? 'bottom' : 'right',
                    )
                  }
                  pendingCommand={pendingTerminalCommand}
                  pendingRawInput={pendingTerminalRawInput}
                  onCommandSubmitted={(id) =>
                    setPendingTerminalCommand((current) =>
                      current?.id === id ? null : current,
                    )
                  }
                  onRawInputSent={(id) =>
                    setPendingTerminalRawInput((current) =>
                      current?.id === id ? null : current,
                    )
                  }
                  onCommandOutput={(id, output) => {
                    const callback = terminalCommandResultsRef.current.get(id);
                    if (!callback) return;
                    terminalCommandResultsRef.current.delete(id);
                    callback(output);
                  }}
                  onClose={() => {
                    const request = pendingTerminalCommand;
                    if (request) {
                      const callback = terminalCommandResultsRef.current.get(
                        request.id,
                      );
                      terminalCommandResultsRef.current.delete(request.id);
                      callback?.('终端已关闭，命令未执行。');
                    }
                    setPendingTerminalCommand(null);
                    setTerminalOpen(false);
                  }}
                />
              ) : runnerTerminalOpen ? (
                <TerminalPanel
                  key={`runner-terminal-${librarySnapshot?.rootPath ?? 'default'}`}
                  title="代码运行 · C/C++"
                  badge="C RUNNER"
                  hideCliButtons
                  hideDockButton
                  noteText="已就绪 C/C++ 运行环境。支持实时交互、scanf 输入与单步执行。"
                  cwd={librarySnapshot?.rootPath ?? ''}
                  theme={theme}
                  dock={terminalRightActive ? 'right' : 'bottom'}
                  canDockRight={canDockTerminalRight}
                  onToggleDock={() =>
                    setTerminalDockAndStore(
                      terminalRightActive ? 'bottom' : 'right',
                    )
                  }
                  pendingCommand={pendingRunnerCommand}
                  pendingRawInput={pendingRunnerRawInput}
                  onCommandSubmitted={(id) =>
                    setPendingRunnerCommand((current) =>
                      current?.id === id ? null : current,
                    )
                  }
                  onRawInputSent={(id) =>
                    setPendingRunnerRawInput((current) =>
                      current?.id === id ? null : current,
                    )
                  }
                  onCommandOutput={() => {}}
                  onClose={() => {
                    setPendingRunnerCommand(null);
                    setPendingRunnerRawInput(null);
                    setRunnerTerminalOpen(false);
                  }}
                />
              ) : null}
            </Suspense>
          </div>
        </section>
      )}

      {readerKnowledgeActive && (
        <div
          className="reader-split-divider reader-knowledge-divider"
          role="separator"
          aria-label="电子书与知识库笔记分界"
        />
      )}

      {readerKnowledgeActive && (
        <section
          className="reader-knowledge-dock"
          aria-label="电子书知识库笔记"
        >
          {epubReader && (
            <div className="reader-chapter-dock-bar">
              <div className="reader-chapter-breadcrumbs">
                <button
                  type="button"
                  className="reader-chapter-crumb-book"
                  onClick={() => setGalaxyViewActive((v) => !v)}
                  title="点击切换全书拓扑星系图"
                >
                  《{epubReader.title}》
                </button>
                {currentEpubChapter?.chapterHierarchy &&
                  currentEpubChapter.chapterHierarchy.length > 0 &&
                  currentEpubChapter.chapterHierarchy.map((crumb, idx) => (
                    <span key={idx} className="reader-chapter-crumb-item">
                      <span className="reader-chapter-crumb-sep">/</span>
                      <span className="reader-chapter-crumb-label">
                        {crumb}
                      </span>
                    </span>
                  ))}
              </div>
              <div className="reader-chapter-actions">
                <button
                  type="button"
                  className={`reader-chapter-btn ${galaxyViewActive ? 'is-active' : ''}`}
                  onClick={() => setGalaxyViewActive((v) => !v)}
                  title="切换拓扑星系图与章节笔记"
                >
                  {galaxyViewActive ? '返回笔记' : '拓扑星系图'}
                </button>
              </div>
            </div>
          )}

          {galaxyViewActive &&
          epubReader &&
          librarySnapshot &&
          bookGalaxyGraph ? (
            <BookGalaxyGraphView
              graph={bookGalaxyGraph}
              currentChapterHref={currentEpubChapter?.chapterHref}
              theme={theme}
              onSelectNode={(node) => {
                void handleGalaxySelectNode(node);
              }}
              onSwitchToEditor={() => setGalaxyViewActive(false)}
            />
          ) : activeDocument ? (
            <DocumentWorkbench
              document={activeDocument}
              dirty={workbench.dirty}
              statusText={saveMessage}
              theme={theme}
              documents={catalogDocuments}
              categories={librarySnapshot?.documentCategories ?? []}
              scrollToFootnoteRequest={
                docFootnoteJump &&
                activeDocument.relativePath &&
                normalizeLibraryPath(docFootnoteJump.relativePath) ===
                  normalizeLibraryPath(activeDocument.relativePath)
                  ? { id: docFootnoteJump.id, nonce: docFootnoteJump.nonce }
                  : null
              }
              renderMarkdownPreview={renderDocumentPreview}
              onSourceChange={(source) => workbench.controller.edit(source)}
              onSave={() => void workbench.controller.save({ manual: true })}
              onRename={(title) => workbench.controller.rename(title)}
              onChangeCategory={(category) =>
                workbench.controller.setCategory(category)
              }
              onChangeTags={(tags) => workbench.controller.setTags(tags)}
              onOpenWikilink={(target) => void openWikilinkTarget(target)}
              onOpenYouTubeLink={openYouTubeVideoInPlayer}
              onRunInTerminal={handleRunCodeInTerminal}
              onOpenAsMindmap={() => void openActiveDocumentAsMindmap()}
              onConvertToMindmap={() => void convertActiveDocumentToMindmap()}
            />
          ) : (
            <div className="reader-knowledge-empty">正在打开知识库笔记…</div>
          )}
        </section>
      )}

      {readerSplitActive && (
        <div
          className="reader-split-divider reader-mindmap-divider"
          role="separator"
          aria-label="调整电子书与思维导图的分栏比例"
          aria-orientation={
            window.innerWidth > 1100 ? 'vertical' : 'horizontal'
          }
          aria-valuemin={Math.round(
            (window.innerWidth > 1100 ? 0.32 : 0.25) * 100,
          )}
          aria-valuemax={65}
          aria-valuenow={Math.round(
            (window.innerWidth > 1100
              ? readerSplitLayout.wideRatio
              : readerSplitLayout.narrowRatio) * 100,
          )}
          tabIndex={0}
          title="拖动调整分栏；双击恢复默认比例；方向键微调，Home 恢复默认"
          onPointerDown={onReaderSplitPointerDown}
          onPointerMove={onReaderSplitPointerMove}
          onPointerUp={onReaderSplitPointerUp}
          onPointerCancel={onReaderSplitPointerUp}
          onKeyDown={onReaderSplitKeyDown}
          onDoubleClick={() =>
            setReaderSplitLayout(DEFAULT_READER_SPLIT_LAYOUT)
          }
        />
      )}

      <footer className="statusbar">
        <span>
          <i className="status-indicator" />
          阶段 4 · 本地文件库
        </span>
        {recoverableDraft && (
          <button
            type="button"
            className="status-recover-draft"
            title={recoverableDraft.draft.title}
            onClick={() => void restoreRecoverableDraft()}
          >
            恢复草稿：{recoverableDraft.draft.title}
          </button>
        )}
        <span
          className="status-library-path"
          title={librarySnapshot?.rootPath ?? ''}
        >
          {librarySnapshot?.rootPath ?? '文件库目录尚未设置'}
        </span>
      </footer>

      {epubDropActive && (
        <div className="epub-drop-overlay" role="status" aria-live="polite">
          <div>
            <strong>导入 EPUB 目录</strong>
            <span>松开鼠标，解析目录并生成 Markdown 草稿</span>
          </div>
        </div>
      )}

      {libraryError && (
        <div className="library-error" role="alert">
          <span>{libraryError}</span>
          <button
            type="button"
            onClick={() => setLibraryError('')}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      )}

      {historyOpen && (
        <div
          className="settings-backdrop history-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !historyBusy)
              closeDocumentHistory();
          }}
        >
          <section
            className="settings-dialog history-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-history-title"
          >
            <div className="settings-heading history-heading">
              <div>
                <span className="pane-kicker">DOCUMENT HISTORY</span>
                <h2 id="document-history-title">版本回溯</h2>
                <p>{editorDraft.title}</p>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭版本历史"
                disabled={historyBusy}
                onClick={closeDocumentHistory}
              >
                ×
              </button>
            </div>
            <div className="history-layout">
              <div className="history-version-list" aria-label="历史版本列表">
                {historyVersions.length === 0 && !historyLoading && (
                  <div className="history-empty">
                    暂无历史版本。文件打开后会建立初始快照。
                  </div>
                )}
                {historyVersions.map((version) => (
                  <button
                    type="button"
                    key={version.versionId}
                    className={`history-version-item${historyPreview?.versionId === version.versionId ? ' is-selected' : ''}`}
                    aria-pressed={
                      historyPreview?.versionId === version.versionId
                    }
                    onClick={() => void loadHistoryVersion(version.versionId)}
                  >
                    <strong>{formatHistoryTimestamp(version.createdAt)}</strong>
                    <span>
                      {historySourceLabel(version.source)} ·{' '}
                      {formatHistoryBytes(version.markdownBytes)}
                    </span>
                    <small>{version.title}</small>
                  </button>
                ))}
              </div>
              <div className="history-preview-column">
                <div className="history-preview-heading">
                  <strong>
                    {historyPreview
                      ? `${historyPreview.title} · ${historySourceLabel(historyPreview.source)}`
                      : '版本内容预览'}
                  </strong>
                  {historyPreview && (
                    <span>
                      {formatHistoryTimestamp(historyPreview.createdAt)}
                    </span>
                  )}
                </div>
                {historyLoading ? (
                  <div className="history-preview-message" role="status">
                    正在读取版本…
                  </div>
                ) : historyPreview ? (
                  <div className="history-markdown-preview">
                    <MarkdownPreview
                      html={historyPreviewHtml}
                      source={historyPreview.markdown}
                      theme={theme}
                    />
                  </div>
                ) : (
                  <div className="history-preview-message">
                    选择左侧版本查看当时保存的 Markdown。
                  </div>
                )}
              </div>
            </div>
            {historyError && (
              <div className="history-error" role="alert">
                {historyError}
              </div>
            )}
            <div className="settings-footer history-footer">
              <span>恢复会保留当前版本，并新增一条恢复记录。</span>
              <button
                type="button"
                className="text-button"
                disabled={historyBusy}
                onClick={closeDocumentHistory}
              >
                关闭
              </button>
              <button
                type="button"
                className="done-button"
                disabled={!historyPreview || historyBusy || historyLoading}
                onClick={() => void restoreHistoryVersion()}
              >
                {historyBusy ? '正在恢复…' : '恢复到此版本'}
              </button>
            </div>
          </section>
        </div>
      )}

      {htmlPreview && (
        <div
          className="html-preview-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeHtmlPreview();
          }}
        >
          <section
            className="html-preview-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="html-preview-title"
          >
            <div className="html-preview-heading">
              <div>
                <span className="pane-kicker">LOCAL HTML COMPONENT</span>
                <h2 id="html-preview-title">{htmlPreview.title}</h2>
              </div>
              <div className="html-preview-actions">
                <button
                  type="button"
                  className="html-preview-embed-button"
                  disabled={!htmlPreviewSrc || Boolean(htmlPreviewError)}
                  onClick={embedHtmlPreviewInCanvas}
                >
                  在画布中交互
                </button>
                <button
                  type="button"
                  className="dialog-close"
                  aria-label="关闭 HTML 预览"
                  onClick={closeHtmlPreview}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="html-preview-meta">
              本地资源 · {htmlPreview.width} × {htmlPreview.height} 卡片
            </div>
            <div
              className="html-preview-content"
              aria-busy={!htmlPreviewSrc && !htmlPreviewError}
            >
              {htmlPreviewError ? (
                <div className="html-preview-message" role="alert">
                  {htmlPreviewError}
                </div>
              ) : htmlPreviewSrc ? (
                <iframe
                  className="html-preview-frame"
                  title={`${htmlPreview.title}交互预览`}
                  src={htmlPreviewSrc}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="html-preview-message" role="status">
                  正在打开本地 HTML 组件…
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {youtubePreview && (
        <YouTubePlayerDialog
          selection={youtubePreview}
          onClose={closeYouTubePreview}
        />
      )}

      {generationDialogOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isGenerating)
              setGenerationDialogOpen(false);
          }}
        >
          <form
            className="settings-dialog ai-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-create-title"
            onSubmit={(event) => {
              event.preventDefault();
              void handleGenerate();
            }}
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">AI · NEW MAP</span>
                <h2 id="ai-create-title">AI 新建思维导图</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭 AI 新建窗口"
                disabled={isGenerating}
                onClick={() => setGenerationDialogOpen(false)}
              >
                ×
              </button>
            </div>
            <label className="settings-field" htmlFor="ai-prompt">
              构想主题或内容梗概
              <textarea
                id="ai-prompt"
                className="ai-prompt-textarea"
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setGenerationError('');
                }}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === 'Enter'
                  ) {
                    event.preventDefault();
                    void handleGenerate();
                  }
                }}
                rows={5}
                maxLength={4000}
                autoFocus
                placeholder="例如：梳理大语言模型的预训练、指令微调、对齐与推理优化全流程…"
              />
            </label>
            <div className="ai-suggestions">
              <span className="suggestions-title">快速灵感主题</span>
              <div className="suggestion-tags">
                {promptSuggestions.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion}
                    onClick={() => {
                      setPrompt(suggestion);
                      setGenerationError('');
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
            {generationError && (
              <p className="generation-error" role="alert">
                {generationError}
              </p>
            )}
            <div className="settings-footer">
              <span>生成结果将创建为新的思维导图文件</span>
              <button
                type="button"
                className="text-button"
                disabled={isGenerating}
                onClick={() => setGenerationDialogOpen(false)}
              >
                取消
              </button>
              <button
                className="done-button"
                type="submit"
                disabled={isGenerating || !prompt.trim()}
              >
                {isGenerating ? '正在生成…' : '生成并保存'}
              </button>
            </div>
          </form>
        </div>
      )}

      {categoryDialogOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setCategoryDialogOpen(false);
          }}
        >
          <form
            className="settings-dialog category-dialog"
            onSubmit={(event) => void createCategory(event)}
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">FOLDER</span>
                <h2>新建分类文件夹</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭"
                onClick={() => setCategoryDialogOpen(false)}
              >
                ×
              </button>
            </div>
            <label className="settings-field">
              分类名称
              <input
                autoFocus
                value={categoryDraft}
                onChange={(event) => setCategoryDraft(event.target.value)}
                placeholder="例如：学习/人工智能"
              />
            </label>
            <p className="settings-note">
              使用斜杠可以一次创建多级分类，例如“工作/产品规划”。
            </p>
            <div className="settings-footer">
              <span>分类会对应文件库中的文件夹</span>
              <button
                type="submit"
                className="done-button"
                disabled={!categoryDraft.trim()}
              >
                创建
              </button>
            </div>
          </form>
        </div>
      )}

      {settingsOpen && (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">PROVIDER</span>
                <h2 id="settings-title">模型连接设置</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭设置"
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </div>
            <label className="settings-field">
              兼容接口地址
              <input
                value={providerSettings.baseUrl}
                onChange={(event) =>
                  setProviderSettings({
                    ...providerSettings,
                    baseUrl: event.target.value,
                  })
                }
                placeholder="https://api.openai.com/v1"
              />
            </label>
            <label className="settings-field">
              模型名称
              <input
                value={providerSettings.model}
                onChange={(event) =>
                  setProviderSettings({
                    ...providerSettings,
                    model: event.target.value,
                  })
                }
                placeholder="gpt-4o-mini"
              />
            </label>
            <div className="secret-status">
              <span className={apiKeySaved ? 'key-dot is-saved' : 'key-dot'} />
              {apiKeySaved ? 'API 密钥已安全保存' : '尚未保存 API 密钥'}
            </div>
            <form
              className="key-form"
              onSubmit={(event) => {
                void saveApiKey(event);
              }}
            >
              <label className="settings-field">
                API 密钥
                <input
                  type="password"
                  autoComplete="new-password"
                  value={apiKeyDraft}
                  onChange={(event) => setApiKeyDraft(event.target.value)}
                  placeholder={
                    apiKeySaved ? '输入新密钥以替换' : '粘贴 API 密钥'
                  }
                />
              </label>
              <div className="settings-actions">
                {apiKeySaved && (
                  <button
                    type="button"
                    className="text-button danger-text"
                    onClick={() => void removeApiKey()}
                  >
                    删除已保存密钥
                  </button>
                )}
                <button
                  type="submit"
                  className="save-key-button"
                  disabled={!apiKeyDraft.trim()}
                >
                  保存密钥
                </button>
              </div>
            </form>
            <p className="settings-note">
              密钥只交给桌面端 Rust 后端，并存入 Windows
              凭据管理器；接口地址和模型名保存在本机浏览器存储中。
            </p>
            {settingsMessage && (
              <p className="settings-message" role="status">
                {settingsMessage}
              </p>
            )}
            <UpdateManager />
            <div className="settings-footer">
              <span>支持 OpenAI Chat Completions 兼容接口</span>
              <button
                type="button"
                className="done-button"
                onClick={() => setSettingsOpen(false)}
              >
                完成
              </button>
            </div>
          </section>
        </div>
      )}
      {videoEmbedDialog && (
        <div
          className="settings-backdrop video-embed-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setVideoEmbedDialog(null);
          }}
        >
          <section
            className="settings-dialog video-embed-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="video-embed-title"
            aria-describedby="video-embed-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setVideoEmbedDialog(null);
              }
            }}
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">VIDEO · YOUTUBE</span>
                <h2 id="video-embed-title">嵌入视频到节点</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭视频嵌入窗口"
                onClick={() => setVideoEmbedDialog(null)}
              >
                ×
              </button>
            </div>
            <p id="video-embed-description" className="video-embed-description">
              目标节点：{videoEmbedDialog.nodeLabel}。粘贴 YouTube 链接或完整
              iframe，确认后会在目标节点下添加可播放的视频节点。
            </p>
            <form onSubmit={insertVideoEmbedChild}>
              <label className="video-embed-field" htmlFor="video-embed-input">
                视频链接或 iframe
                <textarea
                  id="video-embed-input"
                  value={videoEmbedDialog.input}
                  maxLength={5000}
                  onChange={(event) =>
                    setVideoEmbedDialog((dialog) =>
                      dialog
                        ? { ...dialog, input: event.target.value, error: '' }
                        : dialog,
                    )
                  }
                  placeholder="https://www.youtube.com/watch?v=…\n或粘贴 YouTube iframe 代码"
                  autoFocus
                />
              </label>
              <label
                className="video-embed-field"
                htmlFor="video-embed-node-label"
              >
                节点标题（可选）
                <input
                  id="video-embed-node-label"
                  value={videoEmbedDialog.title}
                  maxLength={120}
                  onChange={(event) =>
                    setVideoEmbedDialog((dialog) =>
                      dialog
                        ? { ...dialog, title: event.target.value, error: '' }
                        : dialog,
                    )
                  }
                  placeholder="默认显示 YouTube 视频"
                />
              </label>
              {videoEmbedDialog.error && (
                <p className="video-embed-error" role="alert">
                  {videoEmbedDialog.error}
                </p>
              )}
              <div className="node-note-actions video-embed-actions">
                <span>支持 YouTube 视频链接与 embed iframe</span>
                <button
                  type="button"
                  className="agent-reject-button"
                  onClick={() => setVideoEmbedDialog(null)}
                >
                  取消
                </button>
                <button type="submit" className="agent-apply-button">
                  添加视频节点
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {nodeNoteDialog && (
        <div className="settings-backdrop node-note-backdrop">
          <section
            className="settings-dialog node-note-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="node-note-title"
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">NODE NOTE · MARKDOWN</span>
                <h2 id="node-note-title">{nodeNoteDialog.label} · 备注</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="关闭节点备注"
                onClick={() => setNodeNoteDialog(null)}
              >
                ×
              </button>
            </div>
            <label
              className="node-note-editor-label"
              htmlFor="node-note-editor"
            >
              支持 Markdown、代码块和数学公式；备注会保存在导图的 YAML
              frontmatter 中。
            </label>
            <textarea
              id="node-note-editor"
              className="node-note-editor"
              value={nodeNoteDialog.markdown}
              maxLength={MAX_MARKDOWN_NODE_NOTE_CHARS}
              onChange={(event) =>
                setNodeNoteDialog((dialog) =>
                  dialog
                    ? { ...dialog, markdown: event.target.value, error: '' }
                    : dialog,
                )
              }
              placeholder={'补充节点说明…\n\n例如：$E = mc^2$'}
              autoFocus
            />
            <div className="node-note-preview-wrap">
              <div className="node-note-preview-heading">预览</div>
              {nodeNotePreviewHtml ? (
                <div
                  className="node-note-preview markdown-body"
                  dangerouslySetInnerHTML={{ __html: nodeNotePreviewHtml }}
                />
              ) : (
                <div className="node-note-preview-empty">备注为空</div>
              )}
            </div>
            {nodeNoteDialog.error && (
              <p className="node-note-error" role="alert">
                {nodeNoteDialog.error}
              </p>
            )}
            <div className="node-note-actions">
              <span>
                {nodeNoteDialog.markdown.length} /{' '}
                {MAX_MARKDOWN_NODE_NOTE_CHARS.toLocaleString()}
              </span>
              <button
                type="button"
                className="agent-reject-button"
                onClick={() => setNodeNoteDialog(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="agent-apply-button"
                onClick={saveSelectedNodeNote}
              >
                保存备注
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingCliProposal?.kind === 'mindmap' && (
        <div className="settings-backdrop agent-cli-approval-backdrop">
          <section
            className="settings-dialog agent-cli-approval-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-cli-approval-title"
          >
            <div className="agent-cli-approval-kicker">CLI · SEAMIND MCP</div>
            <h2 id="agent-cli-approval-title">确认导图修改</h2>
            <p>
              {pendingCliProposal.proposal.operation === 'rename'
                ? `将「${pendingCliProposal.proposal.previousLabel}」改为「${pendingCliProposal.proposal.nextLabel}」`
                : pendingCliProposal.proposal.operation === 'add_child'
                  ? `在「${pendingCliProposal.proposal.previousLabel}」下添加「${pendingCliProposal.proposal.nextLabel}」`
                  : pendingCliProposal.proposal.operation === 'add_sibling'
                    ? `在「${pendingCliProposal.proposal.previousLabel}」旁添加「${pendingCliProposal.proposal.nextLabel}」`
                    : pendingCliProposal.proposal.operation === 'add_branch'
                      ? `在「${pendingCliProposal.proposal.previousLabel}」下插入${pendingCliProposal.proposal.analysisMode === 'visualization' ? '可视化' : '下探'}分支「${pendingCliProposal.proposal.nextLabel}」`
                      : pendingCliProposal.proposal.operation === 'delete'
                        ? `删除「${pendingCliProposal.proposal.previousLabel}」及其子节点`
                        : `更新「${pendingCliProposal.proposal.previousLabel}」的备注`}
            </p>
            {pendingCliProposal.proposal.htmlAssets?.length ? (
              <p className="agent-cli-approval-rationale">
                确认后保存 {pendingCliProposal.proposal.htmlAssets.length}{' '}
                个隔离 HTML 组件。
              </p>
            ) : null}
            {pendingCliProposal.proposal.rationale && (
              <p className="agent-cli-approval-rationale">
                {pendingCliProposal.proposal.rationale}
              </p>
            )}
            <details>
              <summary>查看修改内容</summary>
              <pre>
                {pendingCliProposal.proposal.operation === 'add_branch'
                  ? pendingCliProposal.proposal.branchMarkdown || '(分支为空)'
                  : pendingCliProposal.proposal.operation === 'set_note'
                    ? `− ${pendingCliProposal.proposal.previousNote || '(空备注)'}\n+ ${pendingCliProposal.proposal.nextNote || '(空备注)'}`
                    : pendingCliProposal.proposal.operation === 'delete'
                      ? `− ${pendingCliProposal.proposal.previousLabel}（及其子节点）`
                      : `− ${pendingCliProposal.proposal.previousLabel}\n+ ${pendingCliProposal.proposal.nextLabel}`}
              </pre>
            </details>
            <p className="agent-cli-approval-note">
              确认后会更新当前编辑器草稿，并按现有设置自动保存。导图若已变化，提案将无法应用。
            </p>
            <div className="agent-cli-approval-actions">
              <button
                type="button"
                className="agent-cli-reject-button"
                onClick={() => void resolvePendingCliProposal(false)}
              >
                拒绝
              </button>
              <button
                type="button"
                className="agent-cli-apply-button"
                onClick={() => void resolvePendingCliProposal(true)}
              >
                应用并自动保存
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingCliProposal?.kind === 'learning-path' && (
        <LearningPathProposalDialog
          proposal={pendingCliProposal.proposal}
          sourceLabel="cli"
          busy={pendingCliBusy}
          error={pendingCliError}
          onCancel={() => void resolvePendingCliProposal(false)}
          onConfirm={() => void resolvePendingCliProposal(true)}
        />
      )}
      {pendingCliProposal?.kind === 'reader' && (
        <ReaderActionProposalDialog
          proposal={pendingCliProposal.proposal}
          busy={pendingCliBusy}
          error={pendingCliError}
          onCancel={() => void resolvePendingCliProposal(false)}
          onConfirm={() => void resolvePendingCliProposal(true)}
        />
      )}
      {pendingCliProposal?.kind === 'favorites' && (
        <FavoritesProposalDialog
          proposal={pendingCliProposal.proposal}
          sourceLabel="cli"
          busy={pendingCliBusy}
          error={pendingCliError}
          onCancel={() => void resolvePendingCliProposal(false)}
          onConfirm={() => void resolvePendingCliProposal(true)}
        />
      )}
      {terminalCommandConfirmation && (
        <div
          className="settings-backdrop terminal-command-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              const callback = terminalCommandResultsRef.current.get(
                terminalCommandConfirmation.id,
              );
              terminalCommandResultsRef.current.delete(
                terminalCommandConfirmation.id,
              );
              callback?.('已取消执行。');
              setTerminalCommandConfirmation(null);
            }
          }}
        >
          <section
            className="settings-dialog terminal-command-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="terminal-command-title"
          >
            <div className="settings-heading">
              <div>
                <span className="pane-kicker">LOCAL TERMINAL</span>
                <h2 id="terminal-command-title">运行本机命令？</h2>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="取消运行"
                onClick={() => {
                  const callback = terminalCommandResultsRef.current.get(
                    terminalCommandConfirmation.id,
                  );
                  terminalCommandResultsRef.current.delete(
                    terminalCommandConfirmation.id,
                  );
                  callback?.('已取消执行。');
                  setTerminalCommandConfirmation(null);
                }}
              >
                ×
              </button>
            </div>
            <p className="terminal-command-warning">
              这段 {terminalCommandConfirmation.language} 代码将在{' '}
              {librarySnapshot?.rootPath || '当前工作目录'} 中，以当前 Windows
              用户权限执行。请先检查完整命令。
            </p>
            <pre className="terminal-command-preview">
              <code>{terminalCommandConfirmation.source}</code>
            </pre>
            <div className="settings-footer">
              <button
                type="button"
                className="done-button"
                onClick={() => {
                  const callback = terminalCommandResultsRef.current.get(
                    terminalCommandConfirmation.id,
                  );
                  terminalCommandResultsRef.current.delete(
                    terminalCommandConfirmation.id,
                  );
                  callback?.('已取消执行。');
                  setTerminalCommandConfirmation(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="save-key-button"
                onClick={() => {
                  setPendingTerminalCommand(terminalCommandConfirmation);
                  setTerminalOpen(true);
                  setTerminalCommandConfirmation(null);
                }}
              >
                确认并运行
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
