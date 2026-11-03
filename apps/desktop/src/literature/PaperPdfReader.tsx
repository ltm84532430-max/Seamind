import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { literatureApi } from './literature-api';
import type {
  PaperAnnotation,
  PaperAnnotationInput,
  PaperAnnotationRect,
  PaperItem,
} from './types';
import { PaperPdfPage } from './PaperPdfPage';
import './paper-pdf-reader.css';

GlobalWorkerOptions.workerSrc = workerUrl;

interface PaperPdfReaderProps {
  paper: PaperItem;
  onClose: () => void;
  onReadStarted: (paperId: string) => void;
}

interface SelectionDraft {
  pageNumber: number;
  selectedText: string;
  rects: PaperAnnotationRect[];
  contextBefore: string;
  contextAfter: string;
}

type ReaderMode = 'auto' | 'single' | 'spread' | 'scroll';
type ResolvedReaderMode = Exclude<ReaderMode, 'auto'>;
type ZoomMode = 'fitPage' | 'fitWidth' | 'manual';
type SidebarTab = 'outline' | 'search' | 'annotations' | 'bookmarks';

interface ReaderPreferences {
  mode: ReaderMode;
  zoomMode: ZoomMode;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
}

interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
}

interface PdfOutlineEntry {
  title: string;
  pageNumber: number;
  depth: number;
}

interface PaperBookmark {
  id: string;
  pageNumber: number;
  label: string;
  createdAt: number;
}

interface PaperSearchResult {
  pageNumber: number;
  excerpt: string;
  matchCount: number;
}

const ANNOTATION_COLORS = ['#f4d35e', '#8bd3dd', '#b8a1e3', '#f4978e'];
const MIN_SCALE = 0.35;
const MAX_SCALE = 3;
const DEFAULT_PREFERENCES: ReaderPreferences = {
  mode: 'auto',
  zoomMode: 'fitPage',
  sidebarOpen: true,
  sidebarTab: 'annotations',
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const preferenceKey = (paperId: string, sha256: string) =>
  `seamind:paper-reader:v1:${encodeURIComponent(paperId)}:${sha256}`;

const bookmarkKey = (paperId: string, sha256: string) =>
  `seamind:paper-bookmarks:v1:${encodeURIComponent(paperId)}:${sha256}`;

function readPreferences(paperId: string, sha256: string): ReaderPreferences {
  try {
    const stored = JSON.parse(
      localStorage.getItem(preferenceKey(paperId, sha256)) || 'null',
    );
    if (!stored || typeof stored !== 'object') return DEFAULT_PREFERENCES;
    return {
      mode: ['auto', 'single', 'spread', 'scroll'].includes(stored.mode)
        ? stored.mode
        : DEFAULT_PREFERENCES.mode,
      zoomMode: ['fitPage', 'fitWidth', 'manual'].includes(stored.zoomMode)
        ? stored.zoomMode
        : DEFAULT_PREFERENCES.zoomMode,
      sidebarOpen:
        typeof stored.sidebarOpen === 'boolean'
          ? stored.sidebarOpen
          : DEFAULT_PREFERENCES.sidebarOpen,
      sidebarTab: ['outline', 'search', 'annotations', 'bookmarks'].includes(
        stored.sidebarTab,
      )
        ? stored.sidebarTab
        : DEFAULT_PREFERENCES.sidebarTab,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function readBookmarks(paperId: string, sha256: string): PaperBookmark[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(bookmarkKey(paperId, sha256)) || '[]',
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is PaperBookmark =>
        entry &&
        typeof entry.id === 'string' &&
        Number.isInteger(entry.pageNumber) &&
        typeof entry.label === 'string',
    );
  } catch {
    return [];
  }
}

function resolvedMode(
  mode: ReaderMode,
  width: number,
  height: number,
): ResolvedReaderMode {
  if (mode === 'scroll') return 'scroll';
  if (mode === 'single') return 'single';
  if (mode === 'spread') return width < 720 ? 'single' : 'spread';
  return width >= 1080 && height >= 470 ? 'spread' : 'single';
}

function pagesForMode(
  pageNumber: number,
  pageCount: number,
  mode: ResolvedReaderMode,
): number[] {
  if (mode !== 'spread') return [pageNumber];
  const first = pageNumber % 2 === 0 ? pageNumber - 1 : pageNumber;
  return first + 1 <= pageCount ? [first, first + 1] : [first];
}

function spreadStart(pageNumber: number): number {
  return pageNumber % 2 === 0 ? pageNumber - 1 : pageNumber;
}

async function fitScaleFor(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  pageCount: number,
  mode: ResolvedReaderMode,
  width: number,
  height: number,
  fit: Exclude<ZoomMode, 'manual'>,
) {
  const pages = pagesForMode(pageNumber, pageCount, mode);
  const viewports = await Promise.all(
    pages.map(async (number) =>
      (await pdf.getPage(number)).getViewport({ scale: 1 }),
    ),
  );
  const pageWidth =
    viewports.reduce((total, viewport) => total + viewport.width, 0) +
    (pages.length > 1 ? 18 : 0);
  const pageHeight = Math.max(...viewports.map((viewport) => viewport.height));
  const availableWidth = Math.max(180, width - 56);
  const availableHeight = Math.max(160, height - 52);
  const scale =
    fit === 'fitWidth'
      ? availableWidth / pageWidth
      : Math.min(availableWidth / pageWidth, availableHeight / pageHeight);
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

async function readPdfOutline(
  pdf: PDFDocumentProxy,
): Promise<PdfOutlineEntry[]> {
  const nodes = (await pdf.getOutline()) as PdfOutlineNode[];
  const entries: PdfOutlineEntry[] = [];

  const visit = async (items: PdfOutlineNode[], depth: number) => {
    for (const item of items) {
      let destination: unknown[] | null = null;
      if (typeof item.dest === 'string') {
        destination = await pdf.getDestination(item.dest);
      } else if (Array.isArray(item.dest)) {
        destination = item.dest;
      }
      const reference = destination?.[0];
      if (reference) {
        try {
          const pageIndex = await pdf.getPageIndex(reference as never);
          entries.push({
            title: item.title || `第 ${pageIndex + 1} 页`,
            pageNumber: pageIndex + 1,
            depth,
          });
        } catch {
          // Ignore destinations that refer to missing or malformed pages.
        }
      }
      if (item.items?.length) await visit(item.items, depth + 1);
    }
  };

  if (nodes?.length) await visit(nodes, 0);
  return entries;
}

export const PaperPdfReader: React.FC<PaperPdfReaderProps> = ({
  paper,
  onClose,
  onReadStarted,
}) => {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [pdfSha256, setPdfSha256] = useState('');
  const [basePageSize, setBasePageSize] = useState({ width: 612, height: 792 });
  const [annotations, setAnnotations] = useState<PaperAnnotation[]>([]);
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(
    null,
  );
  const [selectionColor, setSelectionColor] = useState(ANNOTATION_COLORS[0]);
  const [selectionComment, setSelectionComment] = useState('');
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(
    null,
  );
  const [editingComment, setEditingComment] = useState('');
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ReaderMode>('auto');
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fitPage');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('annotations');
  const [outline, setOutline] = useState<PdfOutlineEntry[]>([]);
  const [bookmarks, setBookmarks] = useState<PaperBookmark[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PaperSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchProgress, setSearchProgress] = useState(0);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [pageInput, setPageInput] = useState('1');
  const effectiveMode = resolvedMode(
    mode,
    stageSize.width || window.innerWidth,
    stageSize.height || window.innerHeight,
  );
  const stageRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const preferencesReadyRef = useRef(false);
  const searchRequestRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const pageNumberRef = useRef(pageNumber);
  pageNumberRef.current = pageNumber;
  const previousEffectiveModeRef = useRef(effectiveMode);

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, PaperAnnotation[]>();
    for (const annotation of annotations) {
      const values = map.get(annotation.pageNumber) ?? [];
      values.push(annotation);
      map.set(annotation.pageNumber, values);
    }
    return map;
  }, [annotations]);

  const staleAnnotationIds = useMemo(
    () =>
      new Set(
        annotations
          .filter(
            (annotation) =>
              !annotation.pdfSha256 ||
              annotation.pdfSha256 !== pdfSha256 ||
              annotation.rects.length === 0,
          )
          .map((annotation) => annotation.id),
      ),
    [annotations, pdfSha256],
  );

  const visiblePages = useMemo(() => {
    if (effectiveMode === 'scroll') {
      return Array.from({ length: pageCount }, (_, index) => index + 1);
    }
    return pagesForMode(pageNumber, pageCount, effectiveMode);
  }, [effectiveMode, pageCount, pageNumber]);

  const displayPageLabel =
    effectiveMode === 'spread' && pageNumber + 1 <= pageCount
      ? `${pageNumber}–${Math.min(pageNumber + 1, pageCount)}`
      : String(pageNumber);
  const lastNavigationPage =
    effectiveMode === 'spread' ? spreadStart(pageCount) : pageCount;
  const fitTargetPage = effectiveMode === 'scroll' ? 1 : pageNumber;

  const persistProgress = useCallback(
    (nextPage: number, nextScale: number) => {
      void literatureApi
        .saveReadingProgress(
          paper.id,
          clamp(nextPage, 1, Math.max(1, pageCount)),
          clamp(nextScale, MIN_SCALE, MAX_SCALE),
        )
        .catch((progressError) =>
          console.error('保存论文阅读进度失败:', progressError),
        );
    },
    [pageCount, paper.id],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () =>
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    shellRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    preferencesReadyRef.current = false;
    setLoading(true);
    setError(null);
    setPdf(null);
    setOutline([]);

    const load = async () => {
      try {
        const [opened, savedAnnotations, progress] = await Promise.all([
          literatureApi.openPdf(paper.id),
          literatureApi.listAnnotations(paper.id),
          literatureApi.getReadingProgress(paper.id),
        ]);
        if (cancelled) return;
        const preferences = readPreferences(paper.id, opened.sha256);
        setPdfSha256(opened.sha256);
        setAnnotations(savedAnnotations);
        setBookmarks(readBookmarks(paper.id, opened.sha256));
        setMode(preferences.mode);
        setZoomMode(preferences.zoomMode);
        const openingWidth = stageRef.current?.clientWidth || window.innerWidth;
        setSidebarOpen(preferences.sidebarOpen && openingWidth > 640);
        setSidebarTab(preferences.sidebarTab);

        const task = getDocument({ url: convertFileSrc(opened.path) });
        loadingTask = task;
        const loadedPdf = await task.promise;
        if (cancelled) {
          await task.destroy();
          return;
        }
        const safePage = clamp(
          progress?.pageNumber ?? 1,
          1,
          loadedPdf.numPages,
        );
        const firstPage = await loadedPdf.getPage(1);
        const firstViewport = firstPage.getViewport({ scale: 1 });
        setBasePageSize({
          width: firstViewport.width,
          height: firstViewport.height,
        });
        const width = stageRef.current?.clientWidth || window.innerWidth;
        const height = stageRef.current?.clientHeight || window.innerHeight;
        const layout = resolvedMode(preferences.mode, width, height);
        const restoredPage =
          layout === 'spread' ? spreadStart(safePage) : safePage;
        const restoredScale =
          preferences.zoomMode === 'manual' && progress
            ? clamp(progress.scale, MIN_SCALE, MAX_SCALE)
            : await fitScaleFor(
                loadedPdf,
                restoredPage,
                loadedPdf.numPages,
                layout,
                width,
                height,
                preferences.zoomMode === 'fitWidth' ? 'fitWidth' : 'fitPage',
              );
        if (cancelled) return;
        setPageCount(loadedPdf.numPages);
        setPageNumber(restoredPage);
        setPageInput(String(restoredPage));
        setScale(restoredScale);
        setPdf(loadedPdf);
        preferencesReadyRef.current = true;
        void readPdfOutline(loadedPdf)
          .then((items) => {
            if (!cancelled) setOutline(items);
          })
          .catch(() => {
            if (!cancelled) setOutline([]);
          });

        try {
          await literatureApi.updateReadStatus(paper.id, 'reading');
          if (!cancelled) onReadStarted(paper.id);
        } catch (statusError) {
          console.error('更新论文阅读状态失败:', statusError);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [onReadStarted, paper.id]);

  useEffect(() => {
    if (!pdfSha256 || !preferencesReadyRef.current) return;
    try {
      localStorage.setItem(
        preferenceKey(paper.id, pdfSha256),
        JSON.stringify({ mode, zoomMode, sidebarOpen, sidebarTab }),
      );
    } catch {
      // Reading remains available if local preferences cannot be saved.
    }
  }, [mode, paper.id, pdfSha256, sidebarOpen, sidebarTab, zoomMode]);

  useEffect(() => {
    if (!pdfSha256 || !preferencesReadyRef.current) return;
    try {
      localStorage.setItem(
        bookmarkKey(paper.id, pdfSha256),
        JSON.stringify(bookmarks),
      );
    } catch {
      // Bookmarks remain available for this session if storage is unavailable.
    }
  }, [bookmarks, paper.id, pdfSha256]);

  useEffect(() => {
    if (!pdf || loading || zoomMode === 'manual') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fitScaleFor(
        pdf,
        fitTargetPage,
        pageCount,
        effectiveMode,
        stageSize.width || window.innerWidth,
        stageSize.height || window.innerHeight,
        zoomMode,
      ).then((nextScale) => {
        if (cancelled) return;
        setScale((current) =>
          Math.abs(current - nextScale) < 0.01 ? current : nextScale,
        );
        persistProgress(pageNumberRef.current, nextScale);
      });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    effectiveMode,
    loading,
    pageCount,
    fitTargetPage,
    pdf,
    persistProgress,
    stageSize.height,
    stageSize.width,
    zoomMode,
  ]);

  useEffect(() => setPageInput(String(pageNumber)), [pageNumber]);

  useEffect(() => {
    if (effectiveMode !== 'spread') return;
    setPageNumber((current) => spreadStart(current));
  }, [effectiveMode]);

  useEffect(() => {
    if (
      previousEffectiveModeRef.current !== effectiveMode &&
      pdf &&
      zoomMode === 'manual'
    ) {
      setZoomMode('fitPage');
    }
    previousEffectiveModeRef.current = effectiveMode;
  }, [effectiveMode, pdf, zoomMode]);

  const goToPage = useCallback(
    (requestedPage: number) => {
      const safePage = clamp(
        Math.round(requestedPage),
        1,
        Math.max(1, pageCount),
      );
      const targetPage =
        effectiveMode === 'spread' ? spreadStart(safePage) : safePage;
      setPageNumber(targetPage);
      setSelectionDraft(null);
      persistProgress(targetPage, scale);

      if (effectiveMode === 'scroll') {
        window.requestAnimationFrame(() => {
          const stage = stageRef.current;
          const target = stage?.querySelector<HTMLElement>(
            `[data-paper-page-number="${safePage}"]`,
          );
          if (!stage || !target) return;
          const top =
            stage.scrollTop +
            target.getBoundingClientRect().top -
            stage.getBoundingClientRect().top -
            16;
          stage.scrollTo({ top, behavior: 'smooth' });
        });
      }
    },
    [effectiveMode, pageCount, persistProgress, scale],
  );

  const previousPage = useCallback(() => {
    if (effectiveMode === 'spread') {
      goToPage(pageNumber <= 2 ? 1 : pageNumber - 2);
    } else {
      goToPage(pageNumber - 1);
    }
  }, [effectiveMode, goToPage, pageNumber]);

  const nextPage = useCallback(() => {
    if (effectiveMode === 'spread') {
      goToPage(pageNumber + 2);
    } else {
      goToPage(pageNumber + 1);
    }
  }, [effectiveMode, goToPage, pageNumber]);

  const changeScale = (nextScale: number) => {
    const safeScale = clamp(
      Math.round(nextScale * 100) / 100,
      MIN_SCALE,
      MAX_SCALE,
    );
    setZoomMode('manual');
    setScale(safeScale);
    persistProgress(pageNumber, safeScale);
  };

  const chooseFit = (fit: Exclude<ZoomMode, 'manual'>) => {
    setZoomMode(fit);
    if (!pdf) return;
    void fitScaleFor(
      pdf,
      pageNumber,
      pageCount,
      effectiveMode,
      stageSize.width || window.innerWidth,
      stageSize.height || window.innerHeight,
      fit,
    ).then((nextScale) => {
      setScale(nextScale);
      persistProgress(pageNumber, nextScale);
    });
  };

  const captureSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0)
      return;
    const range = selection.getRangeAt(0);
    const commonNode = range.commonAncestorContainer;
    const commonElement =
      commonNode instanceof Element ? commonNode : commonNode.parentElement;
    const pageElement = commonElement?.closest<HTMLElement>(
      '[data-paper-page-number]',
    );
    const layer = pageElement?.querySelector<HTMLElement>('.textLayer');
    if (
      !pageElement ||
      !layer ||
      !commonElement ||
      !layer.contains(commonElement)
    )
      return;
    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    const pageBounds = pageElement.getBoundingClientRect();
    if (pageBounds.width <= 0 || pageBounds.height <= 0) return;
    const rects = Array.from(range.getClientRects())
      .map((rect) => {
        const left = clamp(
          (rect.left - pageBounds.left) / pageBounds.width,
          0,
          1,
        );
        const top = clamp(
          (rect.top - pageBounds.top) / pageBounds.height,
          0,
          1,
        );
        const right = clamp(
          (rect.right - pageBounds.left) / pageBounds.width,
          0,
          1,
        );
        const bottom = clamp(
          (rect.bottom - pageBounds.top) / pageBounds.height,
          0,
          1,
        );
        return { x: left, y: top, width: right - left, height: bottom - top };
      })
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (!rects.length) return;

    const pageText = layer.innerText || '';
    const textIndex = pageText.indexOf(selectedText);
    setSelectionDraft({
      pageNumber: Number(pageElement.dataset.paperPageNumber),
      selectedText,
      rects,
      contextBefore:
        textIndex >= 0
          ? pageText.slice(Math.max(0, textIndex - 80), textIndex)
          : '',
      contextAfter:
        textIndex >= 0
          ? pageText.slice(
              textIndex + selectedText.length,
              textIndex + selectedText.length + 80,
            )
          : '',
    });
    setSidebarTab('annotations');
    setSidebarOpen(true);
  };

  const saveSelection = async () => {
    if (!selectionDraft) return;
    setSaving(true);
    try {
      const saved = await literatureApi.saveAnnotation({
        paperId: paper.id,
        pageNumber: selectionDraft.pageNumber,
        selectedText: selectionDraft.selectedText,
        comment: selectionComment.trim() || null,
        color: selectionColor,
        rects: selectionDraft.rects,
        contextBefore: selectionDraft.contextBefore,
        contextAfter: selectionDraft.contextAfter,
      });
      setAnnotations((current) => [...current, saved]);
      setActiveAnnotationId(saved.id);
      setSelectionDraft(null);
      setSelectionComment('');
      window.getSelection()?.removeAllRanges();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  const startEditing = (annotation: PaperAnnotation) => {
    setEditingAnnotationId(annotation.id);
    setEditingComment(annotation.comment || '');
  };

  const saveEditedComment = async (annotation: PaperAnnotation) => {
    setSaving(true);
    try {
      const input: PaperAnnotationInput = {
        id: annotation.id,
        paperId: paper.id,
        pageNumber: annotation.pageNumber,
        selectedText: annotation.selectedText,
        comment: editingComment.trim() || null,
        color: annotation.color,
        rects: annotation.rects,
        contextBefore: annotation.contextBefore,
        contextAfter: annotation.contextAfter,
      };
      const saved = await literatureApi.saveAnnotation(input);
      setAnnotations((current) =>
        current.map((entry) => (entry.id === saved.id ? saved : entry)),
      );
      setEditingAnnotationId(null);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  const deleteAnnotation = async (annotationId: string) => {
    if (!window.confirm('删除这条页内批注？')) return;
    try {
      await literatureApi.deleteAnnotation(paper.id, annotationId);
      setAnnotations((current) =>
        current.filter((entry) => entry.id !== annotationId),
      );
      if (activeAnnotationId === annotationId) setActiveAnnotationId(null);
      if (editingAnnotationId === annotationId) setEditingAnnotationId(null);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : String(deleteError),
      );
    }
  };

  const toggleBookmark = () => {
    const existing = bookmarks.find(
      (bookmark) => bookmark.pageNumber === pageNumber,
    );
    if (existing) {
      setBookmarks((current) =>
        current.filter((bookmark) => bookmark.id !== existing.id),
      );
      return;
    }
    setBookmarks((current) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        pageNumber,
        label: `第 ${pageNumber} 页`,
        createdAt: Date.now(),
      },
      ...current,
    ]);
  };

  const runSearch = async () => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!pdf || !query || searchBusy) return;
    const requestId = ++searchRequestRef.current;
    setSearchBusy(true);
    setSearchError('');
    setSearchResults([]);
    setSearchProgress(0);
    try {
      const results: PaperSearchResult[] = [];
      for (let page = 1; page <= pageCount; page += 1) {
        if (requestId !== searchRequestRef.current) return;
        const text = (await (await pdf.getPage(page)).getTextContent()).items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ');
        const normalized = text.toLocaleLowerCase();
        const firstMatch = normalized.indexOf(query);
        if (firstMatch >= 0) {
          let matchCount = 0;
          let index = firstMatch;
          while (index >= 0 && matchCount < 999) {
            matchCount += 1;
            index = normalized.indexOf(query, index + query.length);
          }
          results.push({
            pageNumber: page,
            excerpt: text
              .slice(
                Math.max(0, firstMatch - 65),
                firstMatch + query.length + 100,
              )
              .replace(/\s+/g, ' ')
              .trim(),
            matchCount,
          });
        }
        if (page % 6 === 0 || page === pageCount) {
          setSearchProgress(Math.round((page / pageCount) * 100));
          setSearchResults([...results]);
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }
      if (!results.length)
        setSearchError('没有找到匹配内容。扫描版 PDF 可能不含可搜索文字。');
    } catch (searchCause) {
      setSearchError(
        searchCause instanceof Error
          ? searchCause.message
          : String(searchCause),
      );
    } finally {
      if (requestId === searchRequestRef.current) setSearchBusy(false);
    }
  };

  const handleStageScroll = useCallback(() => {
    if (effectiveMode !== 'scroll' || scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const stage = stageRef.current;
      if (!stage) return;
      const pages = Array.from(
        stage.querySelectorAll<HTMLElement>('[data-paper-page-number]'),
      );
      const center = stage.getBoundingClientRect().top + stage.clientHeight / 2;
      let nearestPage = pageNumber;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (const page of pages) {
        const rect = page.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - center);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestPage = Number(page.dataset.paperPageNumber) || nearestPage;
        }
      }
      if (nearestPage === pageNumber) return;
      setPageNumber(nearestPage);
      if (progressTimerRef.current !== null)
        window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = window.setTimeout(() => {
        persistProgress(nearestPage, scale);
        progressTimerRef.current = null;
      }, 260);
    });
  }, [effectiveMode, pageNumber, persistProgress, scale]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null)
        window.cancelAnimationFrame(scrollFrameRef.current);
      if (progressTimerRef.current !== null)
        window.clearTimeout(progressTimerRef.current);
      searchRequestRef.current += 1;
    },
    [],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    const target = event.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable
    )
      return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      nextPage();
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      previousPage();
    } else if (
      (event.ctrlKey || event.metaKey) &&
      ['+', '='].includes(event.key)
    ) {
      event.preventDefault();
      changeScale(scale + 0.1);
    } else if ((event.ctrlKey || event.metaKey) && event.key === '-') {
      event.preventDefault();
      changeScale(scale - 0.1);
    }
  };

  const onPageInputCommit = () => {
    const requested = Number(pageInput);
    if (!Number.isFinite(requested)) {
      setPageInput(String(pageNumber));
      return;
    }
    goToPage(requested);
  };

  const currentBookmark = bookmarks.some(
    (bookmark) => bookmark.pageNumber === pageNumber,
  );

  return (
    <div
      className="paper-reader-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="论文 PDF 阅读器"
      onKeyDown={handleKeyDown}
    >
      <div className="paper-reader-shell" ref={shellRef} tabIndex={-1}>
        <header className="paper-reader-header">
          <div className="paper-reader-heading">
            <span className="paper-reader-kicker">
              论文原文 · {displayPageLabel} / {pageCount || '—'}
            </span>
            <strong title={paper.title}>{paper.title}</strong>
          </div>
          <div className="paper-reader-header-actions">
            <button
              type="button"
              className="paper-reader-side-toggle"
              aria-pressed={sidebarOpen}
              onClick={() => setSidebarOpen((open) => !open)}
              title={sidebarOpen ? '收起侧栏' : '打开侧栏'}
            >
              {sidebarOpen ? '收起侧栏' : '显示侧栏'}
            </button>
            <button
              type="button"
              className="paper-reader-close"
              onClick={onClose}
            >
              返回文献
            </button>
          </div>
        </header>

        <div
          className="paper-reader-toolbar"
          role="toolbar"
          aria-label="PDF 阅读设置"
        >
          <div className="paper-reader-pages">
            <label htmlFor="paper-reader-page-input">页码</label>
            <input
              id="paper-reader-page-input"
              aria-label="跳转到页码"
              type="number"
              min={1}
              max={pageCount || 1}
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={onPageInputCommit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  onPageInputCommit();
                  (event.target as HTMLInputElement).blur();
                }
              }}
              disabled={loading || !pageCount}
            />
            <span>/ {pageCount || '—'}</span>
          </div>

          <label className="paper-reader-mode">
            <span>页面</span>
            <select
              aria-label="页面显示方式"
              value={mode}
              onChange={(event) => setMode(event.target.value as ReaderMode)}
              disabled={loading}
            >
              <option value="auto">自动</option>
              <option value="single">单页</option>
              <option value="spread">双页</option>
              <option value="scroll">连续阅读</option>
            </select>
          </label>
          {mode === 'spread' && effectiveMode !== 'spread' && (
            <span className="paper-reader-mode-notice" role="status">
              当前阅读区较窄，暂按单页显示；收起目录可展开双页
            </span>
          )}

          <div className="paper-reader-zoom" aria-label="页面缩放">
            <button
              type="button"
              onClick={() => changeScale(scale - 0.1)}
              disabled={loading}
              aria-label="缩小"
            >
              −
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button
              type="button"
              onClick={() => changeScale(scale + 0.1)}
              disabled={loading}
              aria-label="放大"
            >
              +
            </button>
            <button
              type="button"
              className={zoomMode === 'fitWidth' ? 'is-selected' : ''}
              onClick={() => chooseFit('fitWidth')}
              disabled={loading}
              title="让页面宽度适配阅读区"
            >
              适合宽度
            </button>
            <button
              type="button"
              className={zoomMode === 'fitPage' ? 'is-selected' : ''}
              onClick={() => chooseFit('fitPage')}
              disabled={loading}
              title="让整页适配当前窗口"
            >
              适合页面
            </button>
          </div>

          <button
            type="button"
            className={`paper-reader-bookmark-toggle${currentBookmark ? ' is-selected' : ''}`}
            onClick={toggleBookmark}
            disabled={loading}
            aria-pressed={currentBookmark}
          >
            {currentBookmark ? '已加书签' : '添加书签'}
          </button>
          <span className="paper-reader-hint">
            ← → 翻页 · 选中文字可高亮或写批注
          </span>
        </div>

        <div
          className={`paper-reader-body${sidebarOpen ? '' : ' is-sidebar-closed'}`}
        >
          <main
            className={`paper-reader-stage is-${effectiveMode}`}
            ref={stageRef}
            onScroll={handleStageScroll}
          >
            {loading && (
              <div className="paper-reader-message" role="status">
                正在打开并绘制 PDF…
              </div>
            )}
            {error && (
              <div className="paper-reader-error" role="alert">
                {error}
              </div>
            )}
            {!loading && !error && pdf && (
              <div
                className={`paper-reader-page-scroller is-${effectiveMode}`}
                onMouseUp={captureSelection}
              >
                {visiblePages.map((number) => (
                  <PaperPdfPage
                    key={number}
                    pdf={pdf}
                    pageNumber={number}
                    scale={scale}
                    pdfSha256={pdfSha256}
                    annotations={annotationsByPage.get(number) ?? []}
                    activeAnnotationId={activeAnnotationId}
                    lazy={effectiveMode === 'scroll'}
                    shouldRender={
                      effectiveMode !== 'scroll' ||
                      Math.abs(number - pageNumber) <= 3
                    }
                    baseSize={basePageSize}
                  />
                ))}
              </div>
            )}
          </main>

          {sidebarOpen && (
            <aside className="paper-reader-notes" aria-label="论文导航与批注">
              <div
                className="paper-reader-sidebar-tabs"
                role="tablist"
                aria-label="阅读侧栏"
              >
                {(
                  [
                    ['outline', '目录'],
                    ['search', '搜索'],
                    ['annotations', `批注 ${annotations.length}`],
                    ['bookmarks', `书签 ${bookmarks.length}`],
                  ] as Array<[SidebarTab, string]>
                ).map(([tab, label]) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sidebarTab === tab}
                    className={sidebarTab === tab ? 'is-active' : ''}
                    key={tab}
                    onClick={() => setSidebarTab(tab)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {sidebarTab === 'outline' && (
                <div className="paper-reader-sidebar-content">
                  <div className="paper-reader-sidebar-title">文档目录</div>
                  {outline.length ? (
                    <nav
                      className="paper-reader-outline"
                      aria-label="PDF 文档目录"
                    >
                      {outline.map((entry, index) => (
                        <button
                          type="button"
                          key={`${entry.pageNumber}-${index}`}
                          style={{
                            paddingInlineStart: `${12 + entry.depth * 14}px`,
                          }}
                          onClick={() => goToPage(entry.pageNumber)}
                        >
                          <span>{entry.title}</span>
                          <small>{entry.pageNumber}</small>
                        </button>
                      ))}
                    </nav>
                  ) : (
                    <p className="paper-reader-empty">
                      这份 PDF 没有内置目录，可以用“搜索”查找章节或术语。
                    </p>
                  )}
                </div>
              )}

              {sidebarTab === 'search' && (
                <div className="paper-reader-sidebar-content">
                  <div className="paper-reader-sidebar-title">查找原文</div>
                  <form
                    className="paper-reader-search-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runSearch();
                    }}
                  >
                    <input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="输入关键词或术语"
                      aria-label="PDF 全文搜索"
                    />
                    <button
                      type="submit"
                      disabled={loading || searchBusy || !searchQuery.trim()}
                    >
                      {searchBusy ? `${searchProgress}%` : '搜索'}
                    </button>
                  </form>
                  {searchError && (
                    <p className="paper-reader-search-status">{searchError}</p>
                  )}
                  <div className="paper-reader-search-results">
                    {searchResults.map((result) => (
                      <button
                        type="button"
                        key={result.pageNumber}
                        onClick={() => goToPage(result.pageNumber)}
                      >
                        <span>
                          第 {result.pageNumber} 页 · {result.matchCount} 处
                        </span>
                        <small>{result.excerpt}</small>
                      </button>
                    ))}
                  </div>
                  {searchBusy && (
                    <p className="paper-reader-search-status">正在逐页查找…</p>
                  )}
                </div>
              )}

              {sidebarTab === 'bookmarks' && (
                <div className="paper-reader-sidebar-content">
                  <div className="paper-reader-sidebar-title">书签</div>
                  <button
                    type="button"
                    className="paper-reader-add-bookmark"
                    onClick={toggleBookmark}
                  >
                    {currentBookmark
                      ? '移除当前页书签'
                      : `收藏第 ${pageNumber} 页`}
                  </button>
                  {bookmarks.length ? (
                    <div className="paper-reader-bookmark-list">
                      {bookmarks.map((bookmark) => (
                        <div
                          className="paper-reader-bookmark-row"
                          key={bookmark.id}
                        >
                          <button
                            type="button"
                            onClick={() => goToPage(bookmark.pageNumber)}
                          >
                            <strong>{bookmark.label}</strong>
                            <small>第 {bookmark.pageNumber} 页</small>
                          </button>
                          <button
                            type="button"
                            className="paper-reader-bookmark-remove"
                            aria-label={`删除${bookmark.label}`}
                            onClick={() =>
                              setBookmarks((current) =>
                                current.filter(
                                  (entry) => entry.id !== bookmark.id,
                                ),
                              )
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="paper-reader-empty">
                      遇到值得回看的页面时，点工具栏的“添加书签”。
                    </p>
                  )}
                </div>
              )}

              {sidebarTab === 'annotations' && (
                <div className="paper-reader-sidebar-content paper-reader-annotation-content">
                  <div className="paper-reader-sidebar-title">
                    页内批注 <span>{annotations.length}</span>
                  </div>
                  {selectionDraft && (
                    <section className="paper-reader-selection">
                      <div className="paper-reader-selection-title">
                        第 {selectionDraft.pageNumber} 页 · 新建高亮
                      </div>
                      <blockquote>{selectionDraft.selectedText}</blockquote>
                      <div
                        className="paper-reader-color-row"
                        aria-label="高亮颜色"
                      >
                        {ANNOTATION_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className={
                              selectionColor === color ? 'is-selected' : ''
                            }
                            style={{ backgroundColor: color }}
                            onClick={() => setSelectionColor(color)}
                            aria-label={`选择颜色 ${color}`}
                          />
                        ))}
                      </div>
                      <textarea
                        value={selectionComment}
                        onChange={(event) =>
                          setSelectionComment(event.target.value)
                        }
                        placeholder="写一条简短笔记（可选）"
                        rows={3}
                      />
                      <div className="paper-reader-selection-actions">
                        <button
                          type="button"
                          onClick={() => setSelectionDraft(null)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="is-primary"
                          onClick={() => void saveSelection()}
                          disabled={saving}
                        >
                          {saving ? '保存中…' : '保存高亮'}
                        </button>
                      </div>
                    </section>
                  )}
                  <div className="paper-reader-annotation-list">
                    {annotations.length === 0 && !selectionDraft && (
                      <div className="paper-reader-empty">
                        选中原文后，可在这里保存高亮和笔记。
                      </div>
                    )}
                    {annotations.map((annotation) => {
                      const stale = staleAnnotationIds.has(annotation.id);
                      return (
                        <article
                          key={annotation.id}
                          className={`paper-reader-annotation ${activeAnnotationId === annotation.id ? 'is-active' : ''} ${stale ? 'is-stale' : ''}`}
                        >
                          <button
                            type="button"
                            className="paper-reader-annotation-jump"
                            disabled={stale}
                            onClick={() => {
                              setActiveAnnotationId(annotation.id);
                              goToPage(annotation.pageNumber);
                            }}
                          >
                            <span className="paper-reader-annotation-meta">
                              <span>第 {annotation.pageNumber} 页</span>
                              <i
                                style={{
                                  backgroundColor:
                                    annotation.color || ANNOTATION_COLORS[0],
                                }}
                              />
                            </span>
                            <blockquote>{annotation.selectedText}</blockquote>
                          </button>
                          {stale ? (
                            <p className="paper-reader-stale-message">
                              {!annotation.pdfSha256 ||
                              annotation.rects.length === 0
                                ? '这条旧批注缺少可验证的位置数据，请检查原文后重新标注。'
                                : 'PDF 文件版本已变化，此批注的位置未显示。请检查原文后重新标注。'}
                            </p>
                          ) : editingAnnotationId === annotation.id ? (
                            <div className="paper-reader-edit-note">
                              <textarea
                                value={editingComment}
                                onChange={(event) =>
                                  setEditingComment(event.target.value)
                                }
                                rows={3}
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  void saveEditedComment(annotation)
                                }
                                disabled={saving}
                              >
                                保存批注
                              </button>
                            </div>
                          ) : (
                            <p className="paper-reader-annotation-comment">
                              {annotation.comment || '仅高亮'}
                            </p>
                          )}
                          <div className="paper-reader-annotation-actions">
                            {!stale &&
                              editingAnnotationId !== annotation.id && (
                                <button
                                  type="button"
                                  onClick={() => startEditing(annotation)}
                                >
                                  编辑
                                </button>
                              )}
                            <button
                              type="button"
                              onClick={() =>
                                void deleteAnnotation(annotation.id)
                              }
                            >
                              删除
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>

        <footer className="paper-reader-footer" aria-label="阅读进度与翻页控制">
          <button
            type="button"
            onClick={previousPage}
            disabled={loading || pageNumber <= 1}
            title="上一页（←）"
          >
            上一页
          </button>
          <span className="paper-reader-location">
            第 {displayPageLabel} 页 / 共 {pageCount || '—'} 页
          </span>
          <input
            type="range"
            min={1}
            max={Math.max(1, pageCount)}
            step={1}
            value={pageNumber}
            aria-label="阅读进度"
            disabled={loading || pageCount < 2}
            onChange={(event) => goToPage(Number(event.target.value))}
          />
          <span className="paper-reader-percent">
            {pageCount ? `${Math.round((pageNumber / pageCount) * 100)}%` : '—'}
          </span>
          <button
            type="button"
            onClick={nextPage}
            disabled={loading || pageNumber >= lastNavigationPage}
            title="下一页（→）"
          >
            下一页
          </button>
        </footer>
      </div>
    </div>
  );
};

export default PaperPdfReader;
