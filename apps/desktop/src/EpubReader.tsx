import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  loadEpubBookMetadata,
  loadEpubReadingActivity,
  loadEpubAnnotations,
  loadEpubBookmarks,
  recordEpubChapterProgress,
  recordEpubReadingProgress,
  saveEpubReadingWordEstimate,
  saveEpubAnnotations,
  saveEpubBookmarks,
  saveEpubBookMetadata,
} from './ebook-storage';
import type {
  EpubAnnotation,
  EpubAnnotationStyle,
  EpubBookmark,
} from './ebook-storage';
import type {
  EpubExam,
  EpubExamDifficulty,
  EpubExamGenerationResult,
} from './epub-exams';
import { extractEpubSectionText } from './epub-exams';
// @ts-expect-error Foliate ships as an untyped JavaScript submodule.
import { Overlayer } from '../../../packages/foliate-js/overlayer.js';

export interface EpubReaderSelection {
  source: File | string;
  progressKey: string;
  relativePath: string;
  title: string;
}

export interface EpubChapterNavigationRequest {
  id: number;
  progressKey: string;
  href?: string;
  label: string;
}

type FoliateTocItem = {
  href: string;
  label: string | Record<string, string>;
  subitems?: FoliateTocItem[];
  id?: number;
};

type FoliateMetadata = {
  title?: string | Record<string, string>;
  creator?:
    | string
    | Record<string, string>
    | Array<string | Record<string, string>>;
};

type FoliateLocation = {
  cfi?: string;
  fraction?: number;
  location?: { current?: number; total?: number };
  section?: { current?: number; total?: number };
  tocItem?: {
    href?: string;
    label?: string | Record<string, string>;
    id?: number;
  };
};

type ReaderPalette = 'light' | 'sepia' | 'dark';
type ReaderFlow = 'paginated' | 'scrolled';

type ReaderSettings = {
  fontSize: number;
  lineHeight: number;
  palette: ReaderPalette;
  flow: ReaderFlow;
};

type FoliateRendererElement = HTMLElement & {
  setStyles?: (styles: string) => void;
};

type FoliateViewElement = HTMLElement & {
  open(book: File | string): Promise<void>;
  goTo(destination: string): Promise<unknown>;
  goToFraction(fraction: number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  getCFI?: (index: number, range?: Range) => string;
  addAnnotation?: (annotation: {
    value: string;
    color: string;
    style?: EpubAnnotationStyle;
    note?: string;
  }) => Promise<void>;
  deleteAnnotation?: (annotation: { value: string }) => Promise<void>;
  showAnnotation?: (annotation: { value: string }) => Promise<void>;
  close(): void;
  renderer?: FoliateRendererElement;
  isFixedLayout?: boolean;
  search?: (options: { query: string }) => AsyncIterable<unknown>;
  clearSearch?: () => void;
  book?: {
    metadata?: FoliateMetadata;
    toc?: FoliateTocItem[];
    sections?: Array<{
      loadText?: () => Promise<string | null | undefined>;
    }>;
    getCover?: () => Promise<Blob | null>;
  };
};

type FoliateSearchResult = {
  progress?: number;
  label?: string;
  cfi?: string;
  excerpt?: string;
  subitems?: Array<{ cfi: string; excerpt?: string }>;
};

type ReaderSearchResult = {
  cfi: string;
  label: string;
  excerpt: string;
};

type ReaderSelection = {
  cfi: string;
  sectionIndex: number;
  text: string;
  context: string;
  label: string;
  fraction: number;
  left: number;
  top: number;
  anchorLeft: number;
  anchorTop: number;
};

type AiAnalysisPreview = {
  cfi: string;
  text: string;
  left: number;
  top: number;
};

type AiFootnoteAnchor = {
  annotationId: string;
  cfi: string;
  sectionIndex: number;
  left: number;
  top: number;
  width: number;
};

export interface EpubReaderProviderSettings {
  baseUrl: string;
  model: string;
}

const MAX_EPUB_AI_CONTEXT_CHARS = 6_000;
const MAX_EPUB_AI_ANALYSIS_CHARS = 800;
const EPUB_CONTEXT_BLOCK_SELECTOR =
  'p, li, blockquote, pre, h1, h2, h3, h4, h5, h6';

function normalizedBlockText(element: Element) {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function extractSelectionContext(
  doc: Document,
  range: Range,
  selectionText: string,
  chapterLabel: string,
) {
  const contextLimit = Math.max(
    0,
    MAX_EPUB_AI_CONTEXT_CHARS - selectionText.length - chapterLabel.length,
  );
  if (!contextLimit || !doc.body) return '';

  const blocks = Array.from(
    doc.body.querySelectorAll(EPUB_CONTEXT_BLOCK_SELECTOR),
  ).filter((element) => {
    if (!element.matches('li, blockquote')) return true;
    return !element.querySelector('p, pre, h1, h2, h3, h4, h5, h6, blockquote');
  });
  const closestBlock = (node: Node) => {
    const element =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    return element?.closest(EPUB_CONTEXT_BLOCK_SELECTOR) ?? null;
  };
  const startBlock = closestBlock(range.startContainer);
  const endBlock = closestBlock(range.endContainer);
  const indexFor = (block: Element | null, node: Node) =>
    blocks.findIndex(
      (candidate) => candidate === block || candidate.contains(node),
    );
  const startIndex = indexFor(startBlock, range.startContainer);
  const endIndex = indexFor(endBlock, range.endContainer);

  let context = '';
  if (startIndex >= 0 && endIndex >= 0) {
    const first = Math.max(0, startIndex - 1);
    const last = Math.min(
      blocks.length - 1,
      Math.max(startIndex, endIndex) + 1,
    );
    let beforeSelection = '';
    let afterSelection = '';
    try {
      const beforeRange = doc.createRange();
      beforeRange.selectNodeContents(blocks[startIndex]);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      beforeSelection = beforeRange.toString().replace(/\s+/g, ' ').trim();

      const afterRange = doc.createRange();
      afterRange.selectNodeContents(blocks[Math.max(startIndex, endIndex)]);
      afterRange.setStart(range.endContainer, range.endOffset);
      afterSelection = afterRange.toString().replace(/\s+/g, ' ').trim();
    } catch {
      beforeSelection = '';
      afterSelection = '';
    }
    const textBudget = Math.max(0, contextLimit - 3);
    const previousBudget = Math.floor(textBudget * 0.2);
    const beforeBudget = Math.floor(textBudget * 0.3);
    const afterBudget = Math.floor(textBudget * 0.3);
    const nextBudget = textBudget - previousBudget - beforeBudget - afterBudget;
    const previous =
      first < startIndex
        ? normalizedBlockText(blocks[first]).slice(-previousBudget)
        : '';
    const next =
      last > Math.max(startIndex, endIndex)
        ? normalizedBlockText(blocks[last]).slice(0, nextBudget)
        : '';
    context = [
      previous,
      beforeSelection.slice(-beforeBudget),
      afterSelection.slice(0, afterBudget),
      next,
    ]
      .filter(Boolean)
      .join('\n');
  } else {
    const common = range.commonAncestorContainer;
    const scope =
      common.nodeType === Node.ELEMENT_NODE
        ? (common as Element)
        : common.parentElement;
    if (
      scope?.contains(range.startContainer) &&
      scope.contains(range.endContainer)
    ) {
      try {
        const beforeRange = doc.createRange();
        beforeRange.selectNodeContents(scope);
        beforeRange.setEnd(range.startContainer, range.startOffset);
        const afterRange = doc.createRange();
        afterRange.selectNodeContents(scope);
        afterRange.setStart(range.endContainer, range.endOffset);
        const before = beforeRange.toString().replace(/\s+/g, ' ').trim();
        const after = afterRange.toString().replace(/\s+/g, ' ').trim();
        context = [
          before.slice(-Math.floor(contextLimit / 2)),
          after.slice(0, Math.ceil(contextLimit / 2)),
        ]
          .filter(Boolean)
          .join('\n');
      } catch {
        context = '';
      }
    }
  }
  return context.slice(0, contextLimit);
}

const DEFAULT_ANNOTATION_COLOR = '#f2d675';
const ANNOTATION_COLORS = [
  { value: '#ed7771', label: '红色' },
  { value: DEFAULT_ANNOTATION_COLOR, label: '黄色' },
  { value: '#55c68a', label: '绿色' },
  { value: '#55a9e8', label: '蓝色' },
  { value: '#a78bfa', label: '紫色' },
] as const;

const ANNOTATION_STYLES: {
  value: EpubAnnotationStyle;
  label: string;
  symbol: string;
}[] = [
  { value: 'highlight', label: '高亮', symbol: '▰' },
  { value: 'underline', label: '下划线', symbol: 'A̲' },
  { value: 'squiggly', label: '波浪线', symbol: '〰' },
];

const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.6,
  palette: 'light',
  flow: 'paginated',
};

const READER_PALETTES: Record<
  ReaderPalette,
  { background: string; foreground: string; link: string }
> = {
  light: { background: '#ffffff', foreground: '#263238', link: '#a9472f' },
  sepia: { background: '#f3ead8', foreground: '#43382a', link: '#9d4f32' },
  dark: { background: '#1e2529', foreground: '#d8e0e3', link: '#e9a18b' },
};

function displayLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map(displayLabel).filter(Boolean).join('、');
  if (value && typeof value === 'object') {
    const labels = Object.values(value).filter(
      (label): label is string => typeof label === 'string',
    );
    return labels[0] ?? '';
  }
  return '';
}

function flattenTocItems(items: FoliateTocItem[]): FoliateTocItem[] {
  return items.flatMap((item) => [
    item,
    ...flattenTocItems(item.subitems ?? []),
  ]);
}

function countReadableWords(source: string) {
  const cjk =
    source.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    )?.length ?? 0;
  const nonCjk =
    source
      .replace(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
        ' ',
      )
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return cjk + nonCjk;
}

async function estimateBookWordCount(
  sections: Array<{ loadText?: () => Promise<string | null | undefined> }>,
) {
  let total = 0;
  for (const [index, section] of sections.entries()) {
    if (!section.loadText) continue;
    try {
      const source = await section.loadText();
      if (source) {
        const document = new DOMParser().parseFromString(source, 'text/html');
        document
          .querySelectorAll('script,style,noscript')
          .forEach((node) => node.remove());
        total += countReadableWords(
          document.body?.textContent ||
            document.documentElement?.textContent ||
            '',
        );
      }
    } catch {
      // A malformed or image-only section does not prevent the rest of the book from being counted.
    }
    if (index > 0 && index % 8 === 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  return total;
}

function normalizeTocHref(href: string) {
  try {
    return decodeURIComponent(href.split('#')[0]).replaceAll('\\', '/');
  } catch {
    return href.split('#')[0].replaceAll('\\', '/');
  }
}

function normalizeTocLabel(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(
      /^\s*(?:(?:第\s*[0-9一二三四五六七八九十百零]+\s*(?:章|节|篇|部分))|(?:(?:chapter|chap\.?|part|section)\s+\d+(?:\.\d+)*))\s*[.、:：-]?\s*/iu,
      '',
    )
    .replace(/^\s*\d+(?:\.\d+)*\s*[.、:：-]?\s*/u, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function safeEpubDestination(value: string): string {
  const href = value.trim();
  if (
    !href ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href) ||
    // Backslashes and control characters never belong in an EPUB link target.
    // eslint-disable-next-line no-control-regex
    /[\\\u0000-\u001f]/u.test(href)
  )
    return '';
  return href;
}

function savedLocationKey(progressKey: string): string {
  return `seamind:epub-progress:v1:${encodeURIComponent(progressKey)}`;
}

function savedSettingsKey(progressKey: string): string {
  return `seamind:epub-settings:v1:${encodeURIComponent(progressKey)}`;
}

async function createCoverThumbnail(blob: Blob): Promise<string> {
  if (!blob.type.startsWith('image/')) return '';
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 240 / bitmap.width, 340 / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return '';
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const thumbnail = canvas.toDataURL('image/jpeg', 0.78);
    return thumbnail.length <= 220_000 ? thumbnail : '';
  } catch {
    return '';
  }
}

function loadReaderSettings(
  progressKey: string,
  appTheme: 'light' | 'dark',
): ReaderSettings {
  const defaults = {
    ...DEFAULT_READER_SETTINGS,
    palette: appTheme === 'dark' ? ('dark' as const) : ('light' as const),
  };
  try {
    const value = JSON.parse(
      localStorage.getItem(savedSettingsKey(progressKey)) ?? 'null',
    );
    if (!value || typeof value !== 'object') return defaults;
    const fontSize = Number(value.fontSize);
    const lineHeight = Number(value.lineHeight);
    return {
      fontSize: Number.isFinite(fontSize)
        ? Math.min(30, Math.max(14, Math.round(fontSize)))
        : defaults.fontSize,
      lineHeight: [1.4, 1.6, 1.8, 2].includes(lineHeight)
        ? lineHeight
        : defaults.lineHeight,
      palette: ['light', 'sepia', 'dark'].includes(value.palette)
        ? value.palette
        : defaults.palette,
      flow: value.flow === 'scrolled' ? 'scrolled' : 'paginated',
    };
  } catch {
    return defaults;
  }
}

function applyReaderSettings(
  view: FoliateViewElement | null,
  settings: ReaderSettings,
) {
  const renderer = view?.renderer;
  if (!renderer) return;
  renderer.setAttribute('flow', settings.flow);
  if (!renderer.setStyles || view?.isFixedLayout) return;

  const palette = READER_PALETTES[settings.palette];
  renderer.setStyles(`
    html {
      color-scheme: ${settings.palette === 'dark' ? 'dark' : 'light'} !important;
      --theme-bg-color: ${palette.background};
      font-size: ${settings.fontSize}px !important;
      background-color: ${palette.background} !important;
    }
    body {
      color: ${palette.foreground} !important;
      background-color: ${palette.background} !important;
      line-height: ${settings.lineHeight} !important;
    }
    a, a:visited { color: ${palette.link} !important; }
  `);
}

export default function EpubReader({
  selection,
  theme,
  provider,
  embedded = false,
  mindmapOpen,
  mindmapExists,
  mindmapBusy,
  chapterNavigationRequest,
  onToggleMindmap,
  onClose,
}: {
  selection: EpubReaderSelection;
  theme: 'light' | 'dark';
  provider: EpubReaderProviderSettings;
  embedded?: boolean;
  mindmapOpen: boolean;
  mindmapExists: boolean;
  mindmapBusy: boolean;
  chapterNavigationRequest: EpubChapterNavigationRequest | null;
  onToggleMindmap: () => void;
  onClose: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const [title, setTitle] = useState(selection.title);
  const [author, setAuthor] = useState('');
  const [toc, setToc] = useState<FoliateTocItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSection, setSidebarSection] = useState<'toc' | 'annotations'>(
    'toc',
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [navigationNotice, setNavigationNotice] = useState<{
    message: string;
    kind: 'success' | 'warning' | 'error';
  } | null>(null);
  const [fraction, setFraction] = useState(0);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [sectionHref, setSectionHref] = useState('');
  const [footerVisible, setFooterVisible] = useState(true);
  const [currentCfi, setCurrentCfi] = useState('');
  const [locationText, setLocationText] = useState('正在载入…');
  const [chapterTitle, setChapterTitle] = useState('');
  const [bookmarks, setBookmarks] = useState<EpubBookmark[]>(() =>
    loadEpubBookmarks(selection.progressKey),
  );
  const [annotations, setAnnotations] = useState<EpubAnnotation[]>(() =>
    loadEpubAnnotations(selection.progressKey),
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ReaderSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchProgress, setSearchProgress] = useState(0);
  const [searchError, setSearchError] = useState('');
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false);
  const [editingBookmarkCfi, setEditingBookmarkCfi] = useState('');
  const [editingBookmarkLabel, setEditingBookmarkLabel] = useState('');
  const [selectionDraft, setSelectionDraft] = useState<ReaderSelection | null>(
    null,
  );
  const [aiAnalysisBusy, setAiAnalysisBusy] = useState(false);
  const [aiAnalysisError, setAiAnalysisError] = useState('');
  const [examDialogOpen, setExamDialogOpen] = useState(false);
  const [examQuestionCount, setExamQuestionCount] = useState('10');
  const [examDifficulty, setExamDifficulty] =
    useState<EpubExamDifficulty>('medium');
  const [examGenerating, setExamGenerating] = useState(false);
  const [examError, setExamError] = useState('');
  const [unsavedExam, setUnsavedExam] = useState<EpubExam | null>(null);
  const [aiAnalysisPreview, setAiAnalysisPreview] =
    useState<AiAnalysisPreview | null>(null);
  const [activeAiFootnote, setActiveAiFootnote] =
    useState<AiFootnoteAnchor | null>(null);
  const [selectedAnnotationStyle, setSelectedAnnotationStyle] =
    useState<EpubAnnotationStyle>('highlight');
  const [selectedAnnotationColor, setSelectedAnnotationColor] =
    useState<string>(DEFAULT_ANNOTATION_COLOR);
  const [noteComposerOpen, setNoteComposerOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [editingAnnotationId, setEditingAnnotationId] = useState('');
  const [editingNoteDraft, setEditingNoteDraft] = useState('');
  const [activeAnnotationId, setActiveAnnotationId] = useState('');
  const [readerSettings, setReaderSettings] = useState(() =>
    loadReaderSettings(selection.progressKey, theme),
  );
  const readerSettingsRef = useRef(readerSettings);
  const bookmarksRef = useRef(bookmarks);
  const annotationsRef = useRef(annotations);
  const selectionDraftRef = useRef(selectionDraft);
  const selectionDocumentRef = useRef<Document | null>(null);
  const currentLocationRef = useRef({
    cfi: currentCfi,
    fraction,
    chapterTitle,
    locationText,
    sectionIndex,
    sectionHref,
  });
  const metadataRef = useRef({ title: selection.title, author: '' });
  const tocRef = useRef<FoliateTocItem[]>(toc);
  const activityBaselineRef = useRef(
    loadEpubBookMetadata(selection.progressKey)?.progress ?? 0,
  );
  const searchRequestRef = useRef(0);
  const aiAnalysisRequestRef = useRef(0);
  const handledChapterNavigationIdRef = useRef(0);
  const chapterNavigationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [isFixedLayout, setIsFixedLayout] = useState(false);

  bookmarksRef.current = bookmarks;
  annotationsRef.current = annotations;
  selectionDraftRef.current = selectionDraft;
  currentLocationRef.current = {
    cfi: currentCfi,
    fraction,
    chapterTitle,
    locationText,
    sectionIndex,
    sectionHref,
  };

  const readerPositionForRange = (range: Range) => {
    const main = stageRef.current?.parentElement;
    const rect = range.getBoundingClientRect();
    if (!main || (!rect.width && !rect.height)) return null;
    const mainRect = main.getBoundingClientRect();
    const doc = range.startContainer.ownerDocument;
    const frame = doc?.defaultView?.frameElement as HTMLElement | null;
    const frameRect = frame?.getBoundingClientRect();
    const innerWidth = doc?.defaultView?.innerWidth ?? frameRect?.width ?? 1;
    const innerHeight = doc?.defaultView?.innerHeight ?? frameRect?.height ?? 1;
    const scaleX = frameRect ? frameRect.width / innerWidth : 1;
    const scaleY = frameRect ? frameRect.height / innerHeight : 1;
    const left = frameRect
      ? frameRect.left + (rect.left + rect.width / 2) * scaleX
      : rect.left + rect.width / 2;
    const top = frameRect ? frameRect.top + rect.top * scaleY : rect.top;
    return {
      left: Math.max(8, Math.min(mainRect.width - 8, left - mainRect.left)),
      top: Math.max(8, Math.min(mainRect.height - 8, top - mainRect.top)),
    };
  };

  const notePositionForPoint = (left: number, top: number) => {
    const main = stageRef.current?.parentElement;
    if (!main) return { left, top, width: 320 };
    const width = main.clientWidth;
    const height = main.clientHeight;
    const cardWidth = Math.min(320, Math.max(0, Math.floor((width - 40) / 2)));
    const gap = 14;
    let x = left + gap;
    if (x + cardWidth > width - 8) x = left - cardWidth - gap;
    x = Math.max(8, Math.min(width - cardWidth - 8, x));
    const estimatedCardHeight = Math.min(320, Math.max(0, height * 0.48));
    let y = top + 10;
    if (y + estimatedCardHeight > height - 8) {
      y = top - estimatedCardHeight - 10;
    }
    y = Math.max(8, Math.min(height - estimatedCardHeight - 8, y));
    return { left: x, top: y, width: cardWidth };
  };

  useEffect(() => {
    try {
      localStorage.setItem(
        savedSettingsKey(selection.progressKey),
        JSON.stringify(readerSettings),
      );
    } catch {
      // The reader remains usable when browser storage is unavailable.
    }
    applyReaderSettings(viewRef.current, readerSettings);
  }, [readerSettings]);

  useEffect(() => {
    saveEpubBookmarks(selection.progressKey, bookmarks);
  }, [bookmarks, selection.progressKey]);

  useEffect(() => {
    saveEpubAnnotations(selection.progressKey, annotations);
  }, [annotations, selection.progressKey]);

  useEffect(() => {
    const main = stageRef.current?.parentElement;
    if (!main || !activeAiFootnote) return;
    let previousWidth = main.clientWidth;
    let previousHeight = main.clientHeight;
    const observer = new ResizeObserver(() => {
      if (
        main.clientWidth !== previousWidth ||
        main.clientHeight !== previousHeight
      ) {
        setActiveAiFootnote(null);
      }
      previousWidth = main.clientWidth;
      previousHeight = main.clientHeight;
    });
    observer.observe(main);
    return () => observer.disconnect();
  }, [activeAiFootnote]);

  useEffect(() => {
    if (!navigationNotice) return;
    const timer = window.setTimeout(() => setNavigationNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [navigationNotice]);

  useEffect(() => {
    const request = chapterNavigationRequest;
    if (
      !request ||
      loading ||
      request.progressKey !== selection.progressKey ||
      request.id <= handledChapterNavigationIdRef.current
    ) {
      return;
    }

    handledChapterNavigationIdRef.current = request.id;
    setNavigationNotice(null);

    let destination = request.href ? safeEpubDestination(request.href) : '';
    if (request.href && !destination) {
      setNavigationNotice({
        message: '章节链接无效，已保留当前阅读位置。',
        kind: 'warning',
      });
      return;
    }

    if (!destination) {
      const normalizedLabel = normalizeTocLabel(request.label);
      const matches = normalizedLabel
        ? flattenTocItems(tocRef.current).filter(
            (item) =>
              normalizeTocLabel(displayLabel(item.label)) === normalizedLabel,
          )
        : [];
      if (matches.length === 0) {
        setNavigationNotice({
          message: '目录中没有唯一匹配的章节，已保留当前阅读位置。',
          kind: 'warning',
        });
        return;
      }
      if (matches.length > 1) {
        setNavigationNotice({
          message: '目录中有多个同名章节，已保留当前阅读位置。',
          kind: 'warning',
        });
        return;
      }
      destination = safeEpubDestination(matches[0].href);
      if (!destination) {
        setNavigationNotice({
          message: '匹配的章节链接无效，已保留当前阅读位置。',
          kind: 'warning',
        });
        return;
      }
    }

    const view = viewRef.current;
    if (!view) return;
    chapterNavigationQueueRef.current = chapterNavigationQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (
          handledChapterNavigationIdRef.current !== request.id ||
          viewRef.current !== view
        ) {
          return;
        }
        const previousCfi = currentLocationRef.current.cfi;
        try {
          const resolved = await view.goTo(destination);
          if (!resolved)
            throw new Error('Chapter destination was not resolved.');
          if (
            handledChapterNavigationIdRef.current === request.id &&
            viewRef.current === view
          ) {
            setNavigationNotice({
              message: `已定位：${request.label || '对应章节'}`,
              kind: 'success',
            });
          }
        } catch {
          if (
            handledChapterNavigationIdRef.current !== request.id ||
            viewRef.current !== view
          ) {
            return;
          }
          if (previousCfi) {
            try {
              await view.goTo(previousCfi);
            } catch {
              // Keep Foliate's current location if restoration also fails.
            }
          }
          if (
            handledChapterNavigationIdRef.current === request.id &&
            viewRef.current === view
          ) {
            setNavigationNotice({
              message: '章节跳转失败，已保留当前阅读位置。',
              kind: 'error',
            });
          }
        }
      });
  }, [chapterNavigationRequest, loading, selection.progressKey, toc]);

  const searchBook = async (rawQuery: string) => {
    const query = rawQuery.trim();
    const view = viewRef.current;
    const requestId = ++searchRequestRef.current;
    setSearchError('');
    if (!query) {
      view?.clearSearch?.();
      setSearchResults([]);
      setSearchBusy(false);
      return;
    }
    if (!view?.search) {
      setSearchError('当前 EPUB 阅读引擎不支持全文查找。');
      return;
    }

    setSearchBusy(true);
    setSearchProgress(0);
    setSearchResults([]);
    const matches: ReaderSearchResult[] = [];
    try {
      for await (const value of view.search({ query })) {
        if (requestId !== searchRequestRef.current) return;
        if (value === 'done' || !value || typeof value !== 'object') continue;
        const result = value as FoliateSearchResult;
        if (typeof result.progress === 'number') {
          setSearchProgress(Math.round(result.progress * 100));
          continue;
        }
        if (result.subitems?.length) {
          for (const item of result.subitems) {
            if (matches.length < 200) {
              matches.push({
                cfi: item.cfi,
                label: result.label ?? '',
                excerpt: item.excerpt ?? '',
              });
            }
          }
        } else if (result.cfi && matches.length < 200) {
          matches.push({
            cfi: result.cfi,
            label: result.label ?? '',
            excerpt: result.excerpt ?? '',
          });
        }
      }
      if (requestId === searchRequestRef.current) {
        setSearchResults(matches.slice(0, 200));
        setSearchProgress(100);
      }
    } catch (cause) {
      if (requestId === searchRequestRef.current) {
        setSearchError(
          cause instanceof Error ? cause.message : '全文查找失败。',
        );
      }
    } finally {
      if (requestId === searchRequestRef.current) setSearchBusy(false);
    }
  };

  const updateBookmarks = (
    update: (previous: EpubBookmark[]) => EpubBookmark[],
  ) => {
    const next = update(bookmarksRef.current);
    bookmarksRef.current = next;
    setBookmarks(next);
  };

  const toggleBookmarkAt = (location = currentLocationRef.current) => {
    if (!location.cfi) return;
    if (
      bookmarksRef.current.some((bookmark) => bookmark.cfi === location.cfi)
    ) {
      updateBookmarks((previous) =>
        previous.filter((bookmark) => bookmark.cfi !== location.cfi),
      );
      return;
    }
    updateBookmarks((previous) =>
      [
        {
          cfi: location.cfi,
          label: location.chapterTitle || location.locationText,
          fraction: location.fraction,
          createdAt: Date.now(),
        },
        ...previous,
      ].slice(0, 200),
    );
  };

  const beginRenameBookmark = (bookmark: EpubBookmark) => {
    setEditingBookmarkCfi(bookmark.cfi);
    setEditingBookmarkLabel(bookmark.label);
  };

  const saveBookmarkLabel = (cfi: string) => {
    const label = editingBookmarkLabel.trim().slice(0, 80);
    if (!label) return;
    updateBookmarks((previous) =>
      previous.map((bookmark) =>
        bookmark.cfi === cfi ? { ...bookmark, label } : bookmark,
      ),
    );
    setEditingBookmarkCfi('');
  };

  const clearSelectionDraft = () => {
    aiAnalysisRequestRef.current += 1;
    setAiAnalysisBusy(false);
    setAiAnalysisError('');
    setAiAnalysisPreview(null);
    selectionDocumentRef.current?.getSelection()?.removeAllRanges();
    selectionDocumentRef.current = null;
    setSelectionDraft(null);
    setNoteComposerOpen(false);
    setNoteDraft('');
  };

  const updateAnnotations = (
    update: (previous: EpubAnnotation[]) => EpubAnnotation[],
  ) => {
    const next = update(annotationsRef.current);
    annotationsRef.current = next;
    setAnnotations(next);
  };

  const saveSelectedAnnotation = (
    style: EpubAnnotationStyle = selectedAnnotationStyle,
    note?: string,
    aiAnalysis?: string,
  ): EpubAnnotation | null => {
    const selected = selectionDraft;
    if (!selected) return null;
    const now = Date.now();
    const existing = annotationsRef.current.find(
      (annotation) => annotation.cfi === selected.cfi,
    );
    const annotation: EpubAnnotation = {
      id: existing?.id ?? `${now}-${Math.random().toString(36).slice(2, 8)}`,
      cfi: selected.cfi,
      sectionIndex: selected.sectionIndex,
      text: selected.text.slice(0, 2000),
      note: (note ?? existing?.note ?? '').trim().slice(0, 2000),
      ...((aiAnalysis ?? existing?.aiAnalysis)
        ? {
            aiAnalysis: (aiAnalysis ?? existing?.aiAnalysis ?? '')
              .trim()
              .slice(0, MAX_EPUB_AI_ANALYSIS_CHARS),
          }
        : {}),
      color:
        aiAnalysis !== undefined && existing
          ? existing.color
          : selectedAnnotationColor,
      style: aiAnalysis !== undefined && existing ? existing.style : style,
      label: selected.label,
      fraction: selected.fraction,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    updateAnnotations((previous) =>
      existing
        ? previous.map((item) => (item.id === existing.id ? annotation : item))
        : [annotation, ...previous].slice(0, 500),
    );
    void viewRef.current
      ?.addAnnotation?.({
        value: annotation.cfi,
        color: annotation.color,
        style: annotation.style,
        note: annotation.note,
      })
      .catch(() => undefined);
    clearSelectionDraft();
    return annotation;
  };

  const analyzeSelectedText = async () => {
    const selected = selectionDraft;
    if (!selected || aiAnalysisBusy) return;
    const requestId = ++aiAnalysisRequestRef.current;
    setAiAnalysisBusy(true);
    setAiAnalysisError('');
    setAiAnalysisPreview(null);
    try {
      const result = await invoke<string>('analyze_epub_highlight', {
        baseUrl: provider.baseUrl,
        model: provider.model,
        chapterLabel: selected.label.slice(0, 200),
        selectionText: selected.text,
        context: selected.context,
      });
      if (
        requestId !== aiAnalysisRequestRef.current ||
        selectionDraftRef.current?.cfi !== selected.cfi ||
        !selectionDocumentRef.current
      ) {
        return;
      }
      const text = Array.from(result.trim())
        .slice(0, MAX_EPUB_AI_ANALYSIS_CHARS)
        .join('');
      if (!text) throw new Error('AI 服务没有返回可用的分析内容。');
      setAiAnalysisPreview({
        cfi: selected.cfi,
        text,
        left: selected.anchorLeft,
        top: selected.anchorTop,
      });
    } catch (cause) {
      if (requestId === aiAnalysisRequestRef.current) {
        setAiAnalysisError(
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    } finally {
      if (requestId === aiAnalysisRequestRef.current) {
        setAiAnalysisBusy(false);
      }
    }
  };

  const createExamFromCurrentSection = async () => {
    if (examGenerating) return;
    const location = currentLocationRef.current;
    const section = viewRef.current?.book?.sections?.[location.sectionIndex];
    if (!section?.loadText) {
      setExamError('无法读取当前阅读段落，请翻到正文页面后重试。');
      return;
    }
    setExamGenerating(true);
    setExamError('');
    setUnsavedExam(null);
    try {
      const source = await section.loadText();
      if (!source) throw new Error('当前阅读段落没有可用于出题的正文。');
      const sectionText = extractEpubSectionText(source);
      const result = await invoke<EpubExamGenerationResult>(
        'generate_epub_exam',
        {
          bookKey: selection.relativePath,
          bookTitle: title,
          sourceFileFingerprint: selection.progressKey,
          sourceSectionIndex: location.sectionIndex,
          sourceSectionHref: location.sectionHref,
          sourceSectionLabel:
            location.chapterTitle || `第 ${location.sectionIndex + 1} 节`,
          sectionText,
          questionCount: Number(examQuestionCount),
          difficulty: examDifficulty,
          baseUrl: provider.baseUrl,
          model: provider.model,
        },
      );
      if (!result.saved) {
        setUnsavedExam(result.exam);
        setExamError(
          `试卷已生成，但保存失败：${result.saveError || '本地存储不可用。'} 可以重试保存，不会再次调用 AI。`,
        );
        return;
      }
      setExamDialogOpen(false);
      setNavigationNotice({
        message: '试卷已生成并保存，返回书架后可继续作答。',
        kind: 'success',
      });
    } catch (cause) {
      setExamError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExamGenerating(false);
    }
  };

  const retrySaveGeneratedExam = async () => {
    if (!unsavedExam || examGenerating) return;
    setExamGenerating(true);
    setExamError('');
    try {
      await invoke('save_epub_exam', { exam: unsavedExam });
      setUnsavedExam(null);
      setExamDialogOpen(false);
      setNavigationNotice({
        message: '试卷已保存，返回书架后可继续作答。',
        kind: 'success',
      });
    } catch (cause) {
      setExamError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExamGenerating(false);
    }
  };

  const saveAiAnalysisAsFootnote = () => {
    const preview = aiAnalysisPreview;
    const selected = selectionDraft;
    if (!preview || !selected || preview.cfi !== selected.cfi) return;
    const annotation = saveSelectedAnnotation(
      selectedAnnotationStyle,
      undefined,
      preview.text,
    );
    if (!annotation) return;
    const position = notePositionForPoint(
      selected.anchorLeft,
      selected.anchorTop,
    );
    setActiveAnnotationId(annotation.id);
    setActiveAiFootnote({
      annotationId: annotation.id,
      cfi: annotation.cfi,
      sectionIndex: annotation.sectionIndex,
      ...position,
    });
    setAiAnalysisPreview(null);
  };

  const beginEditAnnotation = (annotation: EpubAnnotation) => {
    setEditingAnnotationId(annotation.id);
    setEditingNoteDraft(annotation.note);
  };

  const saveEditedAnnotation = (annotation: EpubAnnotation) => {
    const updated = {
      ...annotation,
      note: editingNoteDraft.trim().slice(0, 2000),
      updatedAt: Date.now(),
    };
    updateAnnotations((previous) =>
      previous.map((item) => (item.id === annotation.id ? updated : item)),
    );
    setEditingAnnotationId('');
    void viewRef.current
      ?.addAnnotation?.({
        value: updated.cfi,
        color: updated.color,
        style: updated.style,
        note: updated.note,
      })
      .catch(() => undefined);
  };

  const removeAnnotation = (annotation: EpubAnnotation) => {
    updateAnnotations((previous) =>
      previous.filter((item) => item.id !== annotation.id),
    );
    void viewRef.current
      ?.deleteAnnotation?.({ value: annotation.cfi })
      .catch(() => undefined);
  };

  const removeBookmark = (cfi: string) => {
    updateBookmarks((previous) =>
      previous.filter((bookmark) => bookmark.cfi !== cfi),
    );
  };

  useEffect(() => {
    let cancelled = false;
    let view: FoliateViewElement | null = null;
    const pageDocuments = new WeakSet<Document>();
    const wheelListenerController = new AbortController();
    const documentListenerController = new AbortController();
    let wheelAccumulator = 0;
    let wheelGestureLocked = false;
    let wheelResetTimer: number | undefined;
    let restoringBookLocation = true;
    let deferredRelocation: FoliateLocation | null = null;
    let hasInitialActivityBaseline = false;
    const progressKey = savedLocationKey(selection.progressKey);

    const turnPage = (direction: number) => {
      const currentView = viewRef.current;
      if (!currentView) return;
      void (direction > 0 ? currentView.next() : currentView.prev()).catch(
        () => {
          // Ignore page-boundary errors; the reader remains on its current page.
        },
      );
    };

    const onReaderWheel = (event: WheelEvent) => {
      if (
        readerSettingsRef.current.flow !== 'paginated' ||
        event.ctrlKey ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      ) {
        return;
      }

      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? window.innerHeight
            : 1);
      if (!delta) return;

      // Mouse wheels produce a discrete, larger delta per notch. Trackpads
      // emit many small deltas, which we group into one page turn per gesture.
      if (event.deltaMode !== 0 || Math.abs(delta) >= 70) {
        wheelAccumulator = 0;
        turnPage(delta);
        return;
      }
      if (!wheelGestureLocked) {
        wheelAccumulator += delta;
        if (Math.abs(wheelAccumulator) >= 55) {
          turnPage(wheelAccumulator);
          wheelAccumulator = 0;
          wheelGestureLocked = true;
        }
      }

      if (wheelResetTimer !== undefined) {
        window.clearTimeout(wheelResetTimer);
      }
      wheelResetTimer = window.setTimeout(() => {
        wheelAccumulator = 0;
        wheelGestureLocked = false;
        wheelResetTimer = undefined;
      }, 260);
    };

    const updateDocumentSelection = (doc: Document, sectionIndex: number) => {
      const selected = doc.getSelection();
      if (!selected || selected.isCollapsed || selected.rangeCount === 0) {
        aiAnalysisRequestRef.current += 1;
        setAiAnalysisBusy(false);
        setAiAnalysisError('');
        setAiAnalysisPreview(null);
        setSelectionDraft(null);
        selectionDocumentRef.current = null;
        return;
      }
      const range = selected.getRangeAt(0);
      const text = selected.toString().trim();
      if (!text || text.length > 2000) return;
      let cfi = '';
      try {
        cfi = viewRef.current?.getCFI?.(sectionIndex, range) ?? '';
      } catch {
        return;
      }
      if (!cfi) return;

      const rangeRect = range.getBoundingClientRect();
      const mainRect = stageRef.current?.parentElement?.getBoundingClientRect();
      if (!mainRect) return;
      const anchor = readerPositionForRange(range);
      const frame = doc.defaultView?.frameElement as HTMLElement | null;
      const frameRect = frame?.getBoundingClientRect();
      const innerWidth = doc.defaultView?.innerWidth ?? frameRect?.width ?? 1;
      const innerHeight =
        doc.defaultView?.innerHeight ?? frameRect?.height ?? 1;
      const scaleX = frameRect ? frameRect.width / innerWidth : 1;
      const scaleY = frameRect ? frameRect.height / innerHeight : 1;
      const left = frameRect
        ? frameRect.left + (rangeRect.left + rangeRect.width / 2) * scaleX
        : rangeRect.left + rangeRect.width / 2;
      const top = frameRect
        ? frameRect.top + rangeRect.top * scaleY
        : rangeRect.top;

      selectionDocumentRef.current = doc;
      aiAnalysisRequestRef.current += 1;
      setAiAnalysisBusy(false);
      setAiAnalysisError('');
      setAiAnalysisPreview(null);
      setActiveAiFootnote(null);
      const label =
        currentLocationRef.current.chapterTitle ||
        currentLocationRef.current.locationText;
      setSelectionDraft({
        cfi,
        sectionIndex,
        text,
        context: extractSelectionContext(doc, range, text, label),
        label,
        fraction: currentLocationRef.current.fraction,
        left: Math.max(
          180,
          Math.min(mainRect.width - 180, left - mainRect.left),
        ),
        top: Math.max(50, top - mainRect.top - 8),
        anchorLeft: anchor?.left ?? left - mainRect.left,
        anchorTop: anchor?.top ?? top - mainRect.top,
      });
    };

    const onViewLoad = (event: Event) => {
      const detail = (event as CustomEvent<{ doc?: Document; index?: number }>)
        .detail;
      const doc = detail?.doc;
      const sectionIndex = detail?.index;
      if (!doc || pageDocuments.has(doc)) return;
      pageDocuments.add(doc);
      doc.addEventListener('wheel', onReaderWheel, {
        passive: false,
        signal: wheelListenerController.signal,
      });
      if (typeof sectionIndex !== 'number') return;
      const updateSelection = () => updateDocumentSelection(doc, sectionIndex);
      doc.addEventListener('selectionchange', updateSelection, {
        signal: documentListenerController.signal,
      });
      doc.addEventListener(
        'pointerup',
        () => window.setTimeout(updateSelection, 0),
        { signal: documentListenerController.signal },
      );
      doc.addEventListener('keyup', updateSelection, {
        signal: documentListenerController.signal,
      });
      doc.addEventListener(
        'keydown',
        (keyboardEvent) => {
          const target = keyboardEvent.target as HTMLElement | null;
          if (
            target?.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')
          ) {
            return;
          }
          if (
            (keyboardEvent.ctrlKey || keyboardEvent.metaKey) &&
            keyboardEvent.key.toLowerCase() === 'b'
          ) {
            keyboardEvent.preventDefault();
            toggleBookmarkAt(currentLocationRef.current);
          }
        },
        { signal: documentListenerController.signal },
      );
    };

    const onCreateOverlay = (event: Event) => {
      const detail = (event as CustomEvent<{ index?: number }>).detail;
      if (typeof detail?.index !== 'number' || !view?.addAnnotation) return;
      for (const annotation of annotationsRef.current) {
        if (annotation.sectionIndex !== detail.index) continue;
        void view
          .addAnnotation({
            value: annotation.cfi,
            color: annotation.color,
            style: annotation.style,
            note: annotation.note,
          })
          .catch(() => undefined);
      }
    };

    const onDrawAnnotation = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          draw: (
            drawFunction: typeof Overlayer.highlight,
            options?: { color: string },
          ) => void;
          annotation: { color?: string; style?: EpubAnnotationStyle };
        }>
      ).detail;
      if (!detail?.draw) return;
      const drawFunction =
        detail.annotation?.style === 'underline'
          ? Overlayer.underline
          : detail.annotation?.style === 'squiggly'
            ? Overlayer.squiggly
            : Overlayer.highlight;
      detail.draw(drawFunction, {
        color: detail.annotation?.color ?? DEFAULT_ANNOTATION_COLOR,
      });
    };

    const onShowAnnotation = (event: Event) => {
      const detail = (event as CustomEvent<{ value?: string; range?: Range }>)
        .detail;
      const value = detail?.value;
      const annotation = annotationsRef.current.find(
        (item) => item.cfi === value,
      );
      if (!annotation) return;
      setSidebarOpen(true);
      setSidebarSection('annotations');
      setActiveAnnotationId(annotation.id);
      const point = detail?.range ? readerPositionForRange(detail.range) : null;
      if (annotation.aiAnalysis && point) {
        setActiveAiFootnote({
          annotationId: annotation.id,
          cfi: annotation.cfi,
          sectionIndex: annotation.sectionIndex,
          ...notePositionForPoint(point.left, point.top),
        });
      } else {
        setActiveAiFootnote(null);
      }
    };

    const onRelocate = (event: Event) => {
      const detail = (event as CustomEvent<FoliateLocation>).detail;
      if (restoringBookLocation) {
        deferredRelocation = detail;
        return;
      }
      clearSelectionDraft();
      setActiveAiFootnote(null);
      const currentToc = viewRef.current?.book?.toc ?? tocRef.current;
      const flatToc = flattenTocItems(currentToc);
      const tocHref = detail.tocItem?.href ?? '';
      const hrefIndex = tocHref
        ? flatToc.findIndex(
            (item) => normalizeTocHref(item.href) === normalizeTocHref(tocHref),
          )
        : -1;
      const chapterIndex =
        (typeof detail.tocItem?.id === 'number'
          ? detail.tocItem.id
          : hrefIndex) >= 0
          ? typeof detail.tocItem?.id === 'number'
            ? detail.tocItem.id
            : hrefIndex
          : Math.max(0, detail.section?.current ?? 0);
      const chapterCount =
        flatToc.length ||
        detail.section?.total ||
        viewRef.current?.book?.sections?.length ||
        0;
      const label =
        displayLabel(detail.tocItem?.label) ||
        displayLabel(flatToc[chapterIndex]?.label) ||
        (chapterCount ? `第 ${chapterIndex + 1} 章` : '');
      const chapterHref = tocHref || flatToc[chapterIndex]?.href || '';
      setSectionIndex(Math.max(0, detail.section?.current ?? 0));
      setSectionHref(chapterHref);
      if (typeof detail.fraction === 'number') {
        setFraction(Math.min(1, Math.max(0, detail.fraction)));
        if (!hasInitialActivityBaseline) {
          const existingActivity = loadEpubReadingActivity(
            selection.progressKey,
          );
          if (!existingActivity) {
            activityBaselineRef.current = Math.max(
              activityBaselineRef.current,
              Math.min(1, Math.max(0, detail.fraction)),
            );
          }
          hasInitialActivityBaseline = true;
        }
        recordEpubReadingProgress(
          selection.progressKey,
          detail.fraction,
          activityBaselineRef.current,
        );
        recordEpubChapterProgress(
          selection.progressKey,
          chapterIndex,
          chapterCount,
          detail.fraction,
          chapterHref,
          label,
        );
      }
      if (detail.cfi) {
        setCurrentCfi(detail.cfi);
        try {
          localStorage.setItem(progressKey, detail.cfi);
        } catch {
          // The current page still works when browser storage is unavailable.
        }
      }
      const current = detail.location?.current;
      const total = detail.location?.total;
      if (
        typeof current === 'number' &&
        typeof total === 'number' &&
        total > 0
      ) {
        setLocationText(`位置 ${current} / ${total}`);
      } else if (typeof detail.fraction === 'number') {
        setLocationText(`${Math.round(detail.fraction * 100)}%`);
      }
      if (label) setChapterTitle(label);
      const metadataUpdate: {
        title: string;
        author: string;
        progress?: number;
        lastReadAt?: number;
        currentChapterHref?: string;
        currentChapterLabel?: string;
        currentChapterIndex?: number;
        chapterCount?: number;
      } = { ...metadataRef.current };
      if (typeof detail.fraction === 'number') {
        metadataUpdate.progress = Math.min(1, Math.max(0, detail.fraction));
        metadataUpdate.lastReadAt = Date.now();
      }
      if (chapterCount > 0) metadataUpdate.chapterCount = chapterCount;
      metadataUpdate.currentChapterIndex = chapterIndex;
      metadataUpdate.currentChapterHref = chapterHref;
      metadataUpdate.currentChapterLabel = label;
      saveEpubBookMetadata(selection.progressKey, metadataUpdate);
    };
    const blockExternalLink = (event: Event) => event.preventDefault();

    const openBook = async () => {
      setLoading(true);
      setError('');
      activityBaselineRef.current =
        loadEpubBookMetadata(selection.progressKey)?.progress ?? 0;
      const initialSettings = loadReaderSettings(selection.progressKey, theme);
      readerSettingsRef.current = initialSettings;
      setReaderSettings(initialSettings);
      setIsFixedLayout(false);
      try {
        // @ts-expect-error Foliate ships as an untyped JavaScript submodule.
        await import('../../../packages/foliate-js/view.js');
        if (cancelled || !stageRef.current) return;

        view = document.createElement('foliate-view') as FoliateViewElement;
        view.setAttribute('gap', '8%');
        view.setAttribute('max-inline-size', '760px');
        view.addEventListener('relocate', onRelocate);
        view.addEventListener('load', onViewLoad);
        view.addEventListener('create-overlay', onCreateOverlay);
        view.addEventListener('draw-annotation', onDrawAnnotation);
        view.addEventListener('show-annotation', onShowAnnotation);
        view.addEventListener('external-link', blockExternalLink);
        stageRef.current.replaceChildren(view);
        viewRef.current = view;

        await view.open(selection.source);
        setIsFixedLayout(Boolean(view.isFixedLayout));
        applyReaderSettings(view, readerSettingsRef.current);
        if (cancelled) {
          view.close();
          view.remove();
          return;
        }

        const metadata = view.book?.metadata;
        const bookTitle = displayLabel(metadata?.title) || selection.title;
        const bookAuthor = displayLabel(metadata?.creator);
        metadataRef.current = { title: bookTitle, author: bookAuthor };
        setTitle(bookTitle);
        setAuthor(bookAuthor);
        const loadedToc = view.book?.toc ?? [];
        tocRef.current = loadedToc;
        setToc(loadedToc);
        saveEpubBookMetadata(selection.progressKey, {
          title: bookTitle,
          author: bookAuthor,
          chapterCount:
            flattenTocItems(loadedToc).length ||
            view.book?.sections?.length ||
            0,
        });
        const book = view.book;
        const existingActivity = loadEpubReadingActivity(selection.progressKey);
        if (
          !existingActivity ||
          existingActivity.estimatedTotalWords === null
        ) {
          void estimateBookWordCount(book?.sections ?? []).then(
            (totalWords) => {
              if (!cancelled) {
                saveEpubReadingWordEstimate(
                  selection.progressKey,
                  totalWords,
                  activityBaselineRef.current,
                );
              }
            },
          );
        }
        if (book?.getCover) {
          void book
            .getCover()
            .then((cover) => (cover ? createCoverThumbnail(cover) : ''))
            .then((coverDataUrl) => {
              if (!cancelled && coverDataUrl) {
                saveEpubBookMetadata(selection.progressKey, { coverDataUrl });
              }
            })
            .catch(() => {
              // Books without an extractable cover keep the generated cover tile.
            });
        }

        let savedCfi = '';
        try {
          savedCfi = localStorage.getItem(progressKey) ?? '';
        } catch {
          savedCfi = '';
        }
        if (savedCfi) {
          try {
            await view.goTo(savedCfi);
          } catch {
            try {
              localStorage.removeItem(progressKey);
            } catch {
              // Ignore unavailable storage.
            }
          }
        }
        restoringBookLocation = false;
        if (deferredRelocation) {
          const initialLocation = deferredRelocation;
          deferredRelocation = null;
          onRelocate(new CustomEvent('relocate', { detail: initialLocation }));
        }
        if (!cancelled) setLoading(false);
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? `无法打开这本 EPUB：${cause.message}`
              : '无法打开这本 EPUB，请检查文件是否完整。',
          );
          setLoading(false);
        }
      }
    };

    void openBook();
    return () => {
      cancelled = true;
      if (view) {
        view.clearSearch?.();
        view.removeEventListener('relocate', onRelocate);
        view.removeEventListener('load', onViewLoad);
        view.removeEventListener('create-overlay', onCreateOverlay);
        view.removeEventListener('draw-annotation', onDrawAnnotation);
        view.removeEventListener('show-annotation', onShowAnnotation);
        view.removeEventListener('external-link', blockExternalLink);
        view.close();
        view.remove();
      }
      wheelListenerController.abort();
      documentListenerController.abort();
      if (wheelResetTimer !== undefined) {
        window.clearTimeout(wheelResetTimer);
      }
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [selection]);

  const updateReaderSettings = (next: Partial<ReaderSettings>) => {
    const updated = { ...readerSettingsRef.current, ...next };
    readerSettingsRef.current = updated;
    setReaderSettings(updated);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)
    ) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      toggleBookmarkAt();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      void viewRef.current?.prev();
    } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      void viewRef.current?.next();
    }
  };

  const navigateTo = (href: string) => {
    void viewRef.current?.goTo(href).catch((cause) => {
      setError(
        cause instanceof Error
          ? `无法跳转到该章节：${cause.message}`
          : '章节跳转失败。',
      );
    });
  };

  const visibleAiAnnotation = activeAiFootnote
    ? annotations.find(
        (annotation) => annotation.id === activeAiFootnote.annotationId,
      )
    : undefined;

  return (
    <div
      className={`epub-reader${embedded ? ' is-workspace' : ''}`}
      data-theme={theme}
      role={embedded ? 'region' : 'dialog'}
      aria-modal={embedded ? undefined : 'true'}
      aria-label={`EPUB 阅读器：${title}`}
      onKeyDown={handleKeyDown}
    >
      <header className="epub-reader-header">
        <div className="epub-reader-book-heading">
          <span className="epub-reader-kicker">LOCAL EPUB · READER</span>
          <strong title={title}>{title}</strong>
          {author && <span className="epub-reader-author">{author}</span>}
          {navigationNotice && (
            <span
              className={`epub-reader-navigation-notice is-${navigationNotice.kind}`}
              role={navigationNotice.kind === 'error' ? 'alert' : 'status'}
              title={navigationNotice.message}
            >
              {navigationNotice.message}
            </span>
          )}
        </div>
        <div className="epub-reader-header-actions">
          <button
            type="button"
            className={`epub-reader-tool epub-reader-mindmap-toggle${mindmapOpen ? ' is-active' : ''}`}
            aria-pressed={mindmapOpen}
            disabled={mindmapBusy}
            title="生成或打开本书的思维导图，并排编辑"
            onClick={onToggleMindmap}
          >
            {mindmapBusy
              ? '生成中…'
              : mindmapOpen
                ? '收起导图'
                : mindmapExists
                  ? '并排导图'
                  : '生成导图'}
          </button>
          <button
            type="button"
            className="epub-reader-tool epub-reader-exam-generate"
            onClick={() => {
              setExamQuestionCount('10');
              setExamDifficulty('medium');
              setExamError('');
              setExamDialogOpen(true);
            }}
            disabled={loading || examGenerating}
            title="根据当前阅读段落生成试卷"
          >
            {unsavedExam ? '重试保存试卷' : '生成试卷'}
          </button>
          <button
            type="button"
            className="epub-reader-tool epub-reader-sidebar-toggle"
            aria-pressed={sidebarOpen}
            aria-label={sidebarOpen ? '收起目录侧栏' : '显示目录侧栏'}
            title={sidebarOpen ? '收起目录侧栏' : '显示目录侧栏'}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            目录
          </button>
          <button
            type="button"
            className="epub-reader-close"
            onClick={onClose}
            aria-label="关闭阅读器"
            title="关闭阅读器（Esc）"
          >
            ×
          </button>
        </div>
      </header>

      <div
        className={`epub-reader-layout${sidebarOpen ? '' : ' is-sidebar-closed'}`}
      >
        {sidebarOpen && (
          <aside
            className="epub-reader-toc epub-reader-sidebar"
            aria-label="电子书侧栏"
          >
            <div
              className="epub-reader-sidebar-tools"
              role="toolbar"
              aria-label="阅读操作"
            >
              <details className="epub-reader-settings">
                <summary className="epub-reader-tool">阅读设置</summary>
                <div className="epub-reader-settings-panel">
                  <div className="epub-reader-setting-row">
                    <span>字号</span>
                    <div className="epub-reader-stepper">
                      <button
                        type="button"
                        aria-label="缩小字号"
                        disabled={
                          isFixedLayout || readerSettings.fontSize <= 14
                        }
                        onClick={() =>
                          updateReaderSettings({
                            fontSize: Math.max(14, readerSettings.fontSize - 1),
                          })
                        }
                      >
                        −
                      </button>
                      <output>{readerSettings.fontSize}px</output>
                      <button
                        type="button"
                        aria-label="增大字号"
                        disabled={
                          isFixedLayout || readerSettings.fontSize >= 30
                        }
                        onClick={() =>
                          updateReaderSettings({
                            fontSize: Math.min(30, readerSettings.fontSize + 1),
                          })
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <label className="epub-reader-setting-row">
                    <span>行距</span>
                    <select
                      value={readerSettings.lineHeight}
                      disabled={isFixedLayout}
                      onChange={(event) =>
                        updateReaderSettings({
                          lineHeight: Number(event.target.value),
                        })
                      }
                    >
                      <option value="1.4">紧凑</option>
                      <option value="1.6">标准</option>
                      <option value="1.8">宽松</option>
                      <option value="2">加宽</option>
                    </select>
                  </label>
                  <label className="epub-reader-setting-row">
                    <span>页面底色</span>
                    <select
                      value={readerSettings.palette}
                      disabled={isFixedLayout}
                      onChange={(event) =>
                        updateReaderSettings({
                          palette: event.target.value as ReaderPalette,
                        })
                      }
                    >
                      <option value="light">纸白</option>
                      <option value="sepia">羊皮纸</option>
                      <option value="dark">深色</option>
                    </select>
                  </label>
                  <label className="epub-reader-setting-row">
                    <span>翻页方式</span>
                    <select
                      value={readerSettings.flow}
                      onChange={(event) =>
                        updateReaderSettings({
                          flow: event.target.value as ReaderFlow,
                        })
                      }
                    >
                      <option value="paginated">分页</option>
                      <option value="scrolled">连续滚动</option>
                    </select>
                  </label>
                  {isFixedLayout && (
                    <p className="epub-reader-settings-hint">
                      这本书使用固定版式，字号、行距和底色由书籍页面决定。
                    </p>
                  )}
                  <button
                    type="button"
                    className="epub-reader-settings-reset"
                    onClick={() =>
                      updateReaderSettings({
                        ...DEFAULT_READER_SETTINGS,
                        palette: theme,
                      })
                    }
                  >
                    恢复默认
                  </button>
                </div>
              </details>
              <button
                type="button"
                className={`epub-reader-tool${searchOpen ? ' is-active' : ''}`}
                aria-expanded={searchOpen}
                onClick={() => setSearchOpen((open) => !open)}
              >
                查找
              </button>
              {searchOpen && (
                <div className="epub-reader-search-panel">
                  <form
                    className="epub-reader-search-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void searchBook(searchQuery);
                    }}
                  >
                    <label htmlFor="epub-reader-search-input">全文查找</label>
                    <div>
                      <input
                        id="epub-reader-search-input"
                        value={searchQuery}
                        maxLength={120}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="输入要查找的文字"
                      />
                      <button
                        type="submit"
                        disabled={searchBusy || !searchQuery.trim()}
                      >
                        查找
                      </button>
                    </div>
                  </form>
                  {searchBusy && (
                    <p className="epub-reader-search-status" role="status">
                      正在搜索全书… {searchProgress}%
                    </p>
                  )}
                  {searchError && (
                    <p className="epub-reader-search-error" role="alert">
                      {searchError}
                    </p>
                  )}
                  {!searchBusy &&
                    searchQuery.trim() &&
                    searchResults.length === 0 &&
                    !searchError && (
                      <p className="epub-reader-search-status">没有匹配内容</p>
                    )}
                  <div
                    className="epub-reader-search-results"
                    aria-label="查找结果"
                  >
                    {searchResults.map((result, index) => (
                      <button
                        type="button"
                        key={`${result.cfi}-${index}`}
                        onClick={() => {
                          void viewRef.current
                            ?.goTo(result.cfi)
                            .then(() => setSearchOpen(false))
                            .catch((cause) => {
                              setSearchError(
                                cause instanceof Error
                                  ? `无法跳转到查找结果：${cause.message}`
                                  : '无法跳转到查找结果。',
                              );
                            });
                        }}
                      >
                        {result.label && <strong>{result.label}</strong>}
                        <span>{result.excerpt || `匹配项 ${index + 1}`}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                type="button"
                className={`epub-reader-tool${bookmarkMenuOpen ? ' is-active' : ''}`}
                aria-expanded={bookmarkMenuOpen}
                onClick={() => setBookmarkMenuOpen((open) => !open)}
              >
                书签 {bookmarks.length}
              </button>
              {bookmarkMenuOpen && (
                <div className="epub-reader-bookmark-panel">
                  <button
                    type="button"
                    className={`epub-reader-bookmark-add${bookmarks.some((bookmark) => bookmark.cfi === currentCfi) ? ' is-saved' : ''}`}
                    disabled={!currentCfi}
                    aria-pressed={bookmarks.some(
                      (bookmark) => bookmark.cfi === currentCfi,
                    )}
                    title="Ctrl+B"
                    onClick={() => toggleBookmarkAt()}
                  >
                    {bookmarks.some((bookmark) => bookmark.cfi === currentCfi)
                      ? '移除当前位置书签'
                      : '添加当前位置 · Ctrl+B'}
                  </button>
                  {bookmarks.length ? (
                    <div className="epub-reader-bookmark-list">
                      {bookmarks.map((bookmark) => (
                        <div
                          className="epub-reader-bookmark-row"
                          key={bookmark.cfi}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              void viewRef.current?.goTo(bookmark.cfi)
                            }
                          >
                            <strong>{bookmark.label || '书签'}</strong>
                            <small>
                              {Math.round(bookmark.fraction * 100)}%
                            </small>
                          </button>
                          <button
                            type="button"
                            className="epub-reader-bookmark-rename"
                            aria-label={`重命名书签 ${bookmark.label || ''}`}
                            onClick={() => beginRenameBookmark(bookmark)}
                          >
                            改名
                          </button>
                          <button
                            type="button"
                            className="epub-reader-bookmark-remove"
                            aria-label={`删除书签 ${bookmark.label || ''}`}
                            onClick={() => removeBookmark(bookmark.cfi)}
                          >
                            ×
                          </button>
                          {editingBookmarkCfi === bookmark.cfi && (
                            <form
                              className="epub-reader-bookmark-editor"
                              onSubmit={(event) => {
                                event.preventDefault();
                                saveBookmarkLabel(bookmark.cfi);
                              }}
                            >
                              <input
                                autoFocus
                                aria-label="书签名称"
                                value={editingBookmarkLabel}
                                maxLength={80}
                                onChange={(event) =>
                                  setEditingBookmarkLabel(event.target.value)
                                }
                              />
                              <button
                                type="submit"
                                disabled={!editingBookmarkLabel.trim()}
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingBookmarkCfi('')}
                              >
                                取消
                              </button>
                            </form>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="epub-reader-search-status">暂时没有书签</p>
                  )}
                </div>
              )}
            </div>
            <div
              className="epub-reader-sidebar-tabs"
              role="tablist"
              aria-label="阅读器侧栏"
            >
              <button
                type="button"
                role="tab"
                id="epub-reader-toc-tab"
                aria-selected={sidebarSection === 'toc'}
                aria-controls="epub-reader-toc-panel"
                className={sidebarSection === 'toc' ? 'is-active' : ''}
                onClick={() => setSidebarSection('toc')}
              >
                目录
              </button>
              <button
                type="button"
                role="tab"
                id="epub-reader-annotations-tab"
                aria-selected={sidebarSection === 'annotations'}
                aria-controls="epub-reader-annotations-panel"
                className={sidebarSection === 'annotations' ? 'is-active' : ''}
                onClick={() => setSidebarSection('annotations')}
              >
                标注 <span>{annotations.length}</span>
              </button>
            </div>
            {sidebarSection === 'toc' ? (
              <div
                className="epub-reader-sidebar-content"
                id="epub-reader-toc-panel"
                role="tabpanel"
                aria-labelledby="epub-reader-toc-tab"
              >
                <div className="epub-reader-toc-heading">目录</div>
                {toc.length ? (
                  <nav>{renderToc(toc, navigateTo)}</nav>
                ) : (
                  <p className="epub-reader-toc-empty">这本书没有可用目录</p>
                )}
              </div>
            ) : (
              <div
                className="epub-reader-sidebar-content epub-reader-annotation-content"
                id="epub-reader-annotations-panel"
                role="tabpanel"
                aria-labelledby="epub-reader-annotations-tab"
              >
                <div className="epub-reader-annotation-heading">
                  <strong>标注与笔记</strong>
                  <span>选中文字后可选择样式与颜色</span>
                </div>
                {annotations.length ? (
                  <div className="epub-reader-annotation-list">
                    {annotations.map((annotation) => (
                      <article
                        className={`epub-reader-annotation-row${activeAnnotationId === annotation.id ? ' is-active' : ''}`}
                        key={annotation.id}
                      >
                        <button
                          type="button"
                          className="epub-reader-annotation-jump"
                          onClick={() => {
                            setActiveAnnotationId(annotation.id);
                            void viewRef.current
                              ?.showAnnotation?.({ value: annotation.cfi })
                              .catch(
                                () =>
                                  void viewRef.current?.goTo(annotation.cfi),
                              );
                          }}
                        >
                          <div className="epub-reader-annotation-meta">
                            <i
                              className="epub-reader-annotation-color"
                              style={{ backgroundColor: annotation.color }}
                              title={annotation.color}
                            />
                            <small>
                              {annotation.label || '标注'} ·{' '}
                              {ANNOTATION_STYLES.find(
                                (option) => option.value === annotation.style,
                              )?.label ?? '高亮'}{' '}
                              · {Math.round(annotation.fraction * 100)}%
                            </small>
                          </div>
                          <span>{annotation.text}</span>
                          {annotation.note && <em>{annotation.note}</em>}
                          {annotation.aiAnalysis && (
                            <div className="epub-reader-annotation-ai">
                              <strong>AI 脚注</strong>
                              <span>{annotation.aiAnalysis}</span>
                            </div>
                          )}
                        </button>
                        <div className="epub-reader-annotation-actions">
                          <button
                            type="button"
                            onClick={() => beginEditAnnotation(annotation)}
                          >
                            {editingAnnotationId === annotation.id
                              ? '编辑中'
                              : '编辑笔记'}
                          </button>
                          <button
                            type="button"
                            aria-label={`删除标注 ${annotation.text.slice(0, 24)}`}
                            onClick={() => removeAnnotation(annotation)}
                          >
                            删除
                          </button>
                        </div>
                        {editingAnnotationId === annotation.id && (
                          <form
                            className="epub-reader-annotation-editor"
                            onSubmit={(event) => {
                              event.preventDefault();
                              saveEditedAnnotation(annotation);
                            }}
                          >
                            <textarea
                              aria-label="编辑标注笔记"
                              value={editingNoteDraft}
                              maxLength={2000}
                              rows={3}
                              placeholder="为这段文字写一条笔记…"
                              onChange={(event) =>
                                setEditingNoteDraft(event.target.value)
                              }
                            />
                            <div>
                              <button type="submit">保存</button>
                              <button
                                type="button"
                                onClick={() => setEditingAnnotationId('')}
                              >
                                取消
                              </button>
                            </div>
                          </form>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="epub-reader-search-status">还没有标注</p>
                )}
              </div>
            )}
          </aside>
        )}

        <section className="epub-reader-main" aria-label="书籍内容">
          <div className="epub-reader-stage" ref={stageRef} />
          {selectionDraft && !loading && (
            <div
              className={`epub-reader-selection-toolbar${noteComposerOpen ? ' is-composing' : ''}`}
              style={{
                left: `${selectionDraft.left}px`,
                top: `${selectionDraft.top}px`,
              }}
              role="toolbar"
              aria-label="文字标注工具"
            >
              <span className="epub-reader-selection-quote">
                {selectionDraft.text.slice(0, 110)}
                {selectionDraft.text.length > 110 ? '…' : ''}
              </span>
              <div
                className="epub-reader-selection-styles"
                role="group"
                aria-label="标注样式"
              >
                {ANNOTATION_STYLES.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    className={
                      selectedAnnotationStyle === option.value
                        ? 'is-active'
                        : ''
                    }
                    aria-pressed={selectedAnnotationStyle === option.value}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setSelectedAnnotationStyle(option.value)}
                    title={option.label}
                  >
                    <span aria-hidden="true">{option.symbol}</span>
                    {option.label}
                  </button>
                ))}
              </div>
              <div
                className="epub-reader-selection-colors"
                role="group"
                aria-label="标注颜色"
              >
                <span>颜色</span>
                {ANNOTATION_COLORS.map((color) => (
                  <button
                    type="button"
                    key={color.value}
                    className={
                      selectedAnnotationColor === color.value ? 'is-active' : ''
                    }
                    style={{ backgroundColor: color.value }}
                    aria-label={`${color.label}标注颜色`}
                    aria-pressed={selectedAnnotationColor === color.value}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setSelectedAnnotationColor(color.value)}
                    title={color.label}
                  />
                ))}
              </div>
              <div className="epub-reader-selection-actions">
                <button
                  type="button"
                  className="epub-reader-selection-apply"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => saveSelectedAnnotation()}
                >
                  应用标注
                </button>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setNoteComposerOpen(true)}
                >
                  添加笔记
                </button>
                <button
                  type="button"
                  className="epub-reader-selection-ai"
                  disabled={aiAnalysisBusy}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void analyzeSelectedText()}
                  title="将选中文字和附近上下文发送至当前 AI 服务"
                  aria-label="AI 分析；将选中文字和附近段落发送至当前 AI 服务"
                >
                  {aiAnalysisBusy ? '分析中…' : 'AI 分析'}
                </button>
                <button
                  type="button"
                  className="epub-reader-selection-dismiss"
                  aria-label="关闭标注工具"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={clearSelectionDraft}
                >
                  ×
                </button>
              </div>
              <small className="epub-reader-ai-disclosure">
                AI 分析会发送选区与附近段落
              </small>
              {noteComposerOpen && (
                <form
                  className="epub-reader-selection-note"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveSelectedAnnotation(selectedAnnotationStyle, noteDraft);
                  }}
                >
                  <textarea
                    autoFocus
                    aria-label="标注笔记内容"
                    value={noteDraft}
                    maxLength={2000}
                    rows={3}
                    placeholder="写下与这段文字相关的想法…"
                    onChange={(event) => setNoteDraft(event.target.value)}
                  />
                  <div>
                    <button type="submit">保存笔记</button>
                    <button
                      type="button"
                      onClick={() => {
                        setNoteComposerOpen(false);
                        setNoteDraft('');
                      }}
                    >
                      取消
                    </button>
                  </div>
                </form>
              )}
              {aiAnalysisError && (
                <p className="epub-reader-ai-error" role="alert">
                  {aiAnalysisError}
                </p>
              )}
            </div>
          )}
          {aiAnalysisPreview &&
            selectionDraft?.cfi === aiAnalysisPreview.cfi && (
              <aside
                className="epub-reader-ai-footnote is-preview"
                style={notePositionForPoint(
                  aiAnalysisPreview.left,
                  aiAnalysisPreview.top,
                )}
                aria-label="AI 分析预览"
              >
                <div className="epub-reader-ai-footnote-heading">
                  <strong>AI 分析预览</strong>
                  <button
                    type="button"
                    aria-label="关闭 AI 分析预览"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setAiAnalysisPreview(null)}
                  >
                    ×
                  </button>
                </div>
                <p>{aiAnalysisPreview.text}</p>
                <small>选区与附近上下文将发送至当前 AI 服务。</small>
                <div className="epub-reader-ai-footnote-actions">
                  <button
                    type="button"
                    className="is-primary"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={saveAiAnalysisAsFootnote}
                  >
                    保存为脚注
                  </button>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setAiAnalysisPreview(null)}
                  >
                    取消
                  </button>
                </div>
              </aside>
            )}
          {visibleAiAnnotation?.aiAnalysis && activeAiFootnote && (
            <aside
              className="epub-reader-ai-footnote is-saved"
              style={{
                left: `${activeAiFootnote.left}px`,
                top: `${activeAiFootnote.top}px`,
                width: `${activeAiFootnote.width}px`,
              }}
              aria-label="AI 脚注"
            >
              <div className="epub-reader-ai-footnote-heading">
                <strong>AI 脚注</strong>
                <button
                  type="button"
                  aria-label="收起 AI 脚注"
                  onClick={() => setActiveAiFootnote(null)}
                >
                  ×
                </button>
              </div>
              <p>{visibleAiAnnotation.aiAnalysis}</p>
            </aside>
          )}
          {loading && (
            <div className="epub-reader-loading" role="status">
              {error ? '书籍未能载入' : '正在载入 EPUB…'}
            </div>
          )}
          {error && (
            <div className="epub-reader-error" role="alert">
              {error}
            </div>
          )}
          {chapterTitle && (
            <div className="epub-reader-chapter">{chapterTitle}</div>
          )}
        </section>
      </div>

      <footer
        className={`epub-reader-footer${footerVisible ? '' : ' is-hidden'}`}
        aria-label="阅读进度与翻页控制"
      >
        <button
          type="button"
          className="epub-reader-footer-toggle"
          aria-label={footerVisible ? '隐藏阅读控制栏' : '显示阅读控制栏'}
          aria-expanded={footerVisible}
          title={footerVisible ? '隐藏阅读控制栏' : '显示阅读控制栏'}
          onClick={() => setFooterVisible((visible) => !visible)}
        >
          <span aria-hidden="true">{footerVisible ? '⌄' : '⌃'}</span>
        </button>
        <button
          type="button"
          className="epub-reader-page-button"
          onClick={() => void viewRef.current?.prev()}
          disabled={fraction <= 0}
          title="上一页（←）"
        >
          上一页
        </button>
        <span className="epub-reader-location">{locationText}</span>
        <input
          className="epub-reader-progress"
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={fraction}
          aria-label="阅读进度"
          onChange={(event) =>
            void viewRef.current?.goToFraction(Number(event.target.value))
          }
        />
        <button
          type="button"
          className="epub-reader-page-button"
          onClick={() => void viewRef.current?.next()}
          disabled={fraction >= 1}
          title="下一页（→）"
        >
          下一页
        </button>
      </footer>
      {examDialogOpen && (
        <div
          className="epub-exam-generate-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !examGenerating) {
              setExamDialogOpen(false);
            }
          }}
        >
          <section
            className="epub-exam-generate-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="epub-exam-generate-title"
          >
            <header>
              <div>
                <span className="ebook-shelf-kicker">
                  GENERATE FROM CURRENT SECTION
                </span>
                <h2 id="epub-exam-generate-title">生成本段试卷</h2>
              </div>
              <button
                type="button"
                aria-label="关闭生成试卷窗口"
                onClick={() => setExamDialogOpen(false)}
                disabled={examGenerating}
              >
                ×
              </button>
            </header>
            <dl>
              <div>
                <dt>书籍</dt>
                <dd>{title}</dd>
              </div>
              <div>
                <dt>阅读段落</dt>
                <dd>{chapterTitle || `第 ${sectionIndex + 1} 节`}</dd>
              </div>
              <div>
                <dt>内容范围</dt>
                <dd>仅使用当前 spine section 的正文</dd>
              </div>
            </dl>
            <p className="epub-exam-generation-privacy">
              提交后，该段正文会发送给当前配置的 AI 服务生成题目、答案和解析。
            </p>
            <label>
              <span>题数</span>
              <select
                value={examQuestionCount}
                onChange={(event) => setExamQuestionCount(event.target.value)}
                disabled={examGenerating || Boolean(unsavedExam)}
              >
                <option value="5">5 题</option>
                <option value="10">10 题</option>
                <option value="15">15 题</option>
                <option value="20">20 题</option>
              </select>
            </label>
            <label>
              <span>难度</span>
              <select
                value={examDifficulty}
                onChange={(event) =>
                  setExamDifficulty(event.target.value as EpubExamDifficulty)
                }
                disabled={examGenerating || Boolean(unsavedExam)}
              >
                <option value="easy">简单</option>
                <option value="medium">中等</option>
                <option value="hard">困难</option>
              </select>
            </label>
            {examError && (
              <p className="epub-exam-generation-error" role="alert">
                {examError}
              </p>
            )}
            <footer>
              <button
                type="button"
                onClick={() => setExamDialogOpen(false)}
                disabled={examGenerating}
              >
                取消
              </button>
              {unsavedExam ? (
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => void retrySaveGeneratedExam()}
                  disabled={examGenerating}
                >
                  {examGenerating ? '正在保存…' : '重试保存'}
                </button>
              ) : (
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => void createExamFromCurrentSection()}
                  disabled={examGenerating}
                >
                  {examGenerating ? '正在生成…' : '生成并保存'}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function renderToc(
  items: FoliateTocItem[],
  onNavigate: (href: string) => void,
  depth = 0,
) {
  return (
    <ul className="epub-reader-toc-list">
      {items.map((item, index) => {
        const label = displayLabel(item.label) || '未命名章节';
        return (
          <li key={`${item.href}-${index}`}>
            <button
              type="button"
              className="epub-reader-toc-item"
              style={{ paddingInlineStart: `${10 + depth * 12}px` }}
              onClick={() => onNavigate(item.href)}
              title={label}
            >
              {label}
            </button>
            {!!item.subitems?.length &&
              renderToc(item.subitems, onNavigate, depth + 1)}
          </li>
        );
      })}
    </ul>
  );
}
