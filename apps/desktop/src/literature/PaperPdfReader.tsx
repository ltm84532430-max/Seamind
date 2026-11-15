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
import { PaperPdfPage, type PaperTranslationDisplayMode } from './PaperPdfPage';
import {
  PaperSelectionPopover,
  type SelectionPopoverAnchor,
} from './PaperSelectionPopover';
import { PaperTranslationSidebar } from './PaperTranslationPanel';
import {
  ANNOTATION_COLORS,
  bookmarkKey,
  clamp,
  cleanPdfSelectionText,
  extractPageParagraphBlocks,
  fitScaleFor,
  isShortTermSelection,
  MAX_SCALE,
  MIN_SCALE,
  pagesForMode,
  preferenceKey,
  readBookmarks,
  readPdfOutline,
  readPreferences,
  resolvedMode,
  spreadStart,
  type PaperBookmark,
  type PaperParagraphBlock,
  type PaperSearchResult,
  type PdfOutlineEntry,
  type ReaderMode,
  type SidebarTab,
  type ZoomMode,
} from './paper-pdf-layout';
import {
  deletePaperPageTranslation,
  getPaperPageTranslation,
  type DualPdfResult,
  type PaperPageTranslationRecord,
  type PaperSelectionTranslation,
  type Pdf2ZhStatus,
} from './paper-translation-store';
import {
  checkPdf2ZhStatus,
  generateBilingualPaperPdf,
  translatePaperPage,
  translatePaperSelection,
} from './paper-translator';
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
  const [popoverAnchor, setPopoverAnchor] =
    useState<SelectionPopoverAnchor | null>(null);
  const [selectionTranslating, setSelectionTranslating] = useState(false);
  const [selectionTranslation, setSelectionTranslation] =
    useState<PaperSelectionTranslation | null>(null);
  const [selectionTransError, setSelectionTransError] = useState<string | null>(
    null,
  );
  const [copiedTransNotice, setCopiedTransNotice] = useState(false);
  const [translationDisplayMode, setTranslationDisplayMode] =
    useState<PaperTranslationDisplayMode>('off');
  const [blocksByPage, setBlocksByPage] = useState<
    Record<number, PaperParagraphBlock[]>
  >({});
  const [translationsByPage, setTranslationsByPage] = useState<
    Record<number, PaperPageTranslationRecord>
  >({});
  const [translatingPage, setTranslatingPage] = useState<number | null>(null);
  const [translationProgress, setTranslationProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [activeTranslatedBlock, setActiveTranslatedBlock] = useState<{
    pageNumber: number;
    blockId: number;
  } | null>(null);
  const [pdf2ZhStatus, setPdf2ZhStatus] = useState<Pdf2ZhStatus | null>(null);
  const [checkingPdf2Zh, setCheckingPdf2Zh] = useState(false);
  const [generatingDualPdf, setGeneratingDualPdf] = useState(false);
  const [dualPdfResult, setDualPdfResult] = useState<DualPdfResult | null>(
    null,
  );
  const [viewingDualPdf, setViewingDualPdf] = useState(false);
  const [dualPdfError, setDualPdfError] = useState<string | null>(null);
  const effectiveMode = resolvedMode(
    mode,
    stageSize.width || window.innerWidth,
    stageSize.height || window.innerHeight,
  );
  const stageRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const originalPdfPathRef = useRef('');
  const pdfTaskRef = useRef<ReturnType<typeof getDocument> | null>(null);
  const translationCancelRef = useRef(false);
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

  const translationMapsByPage = useMemo(() => {
    const result: Record<number, Record<number, string>> = {};
    for (const [pageKey, record] of Object.entries(translationsByPage)) {
      const lookup: Record<number, string> = {};
      for (const item of record.paragraphs) {
        lookup[item.id] = item.translation;
      }
      result[Number(pageKey)] = lookup;
    }
    return result;
  }, [translationsByPage]);

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
    setPopoverAnchor(null);
    setSelectionDraft(null);
    setSelectionTranslation(null);
    setSelectionTransError(null);
    setBlocksByPage({});
    setTranslationsByPage({});
    setActiveTranslatedBlock(null);
    setTranslationError(null);
    setDualPdfResult(null);
    setViewingDualPdf(false);
    setDualPdfError(null);
    originalPdfPathRef.current = '';

    const load = async () => {
      try {
        const [opened, savedAnnotations, progress] = await Promise.all([
          literatureApi.openPdf(paper.id),
          literatureApi.listAnnotations(paper.id),
          literatureApi.getReadingProgress(paper.id),
        ]);
        if (cancelled) return;
        originalPdfPathRef.current = opened.path;
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
        pdfTaskRef.current = task;
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
      if (pdfTaskRef.current && pdfTaskRef.current !== loadingTask) {
        void pdfTaskRef.current.destroy();
      }
      pdfTaskRef.current = null;
    };
  }, [onReadStarted, paper.id]);

  const ensurePageLayoutAndCache = useCallback(
    async (targetPage: number): Promise<PaperParagraphBlock[]> => {
      if (!pdf) return [];
      const cachedBlocks = blocksByPage[targetPage];
      let resolvedBlocks = cachedBlocks;
      if (!resolvedBlocks) {
        try {
          const pdfPage = await pdf.getPage(targetPage);
          resolvedBlocks = await extractPageParagraphBlocks(pdfPage);
          setBlocksByPage((prev) =>
            prev[targetPage]
              ? prev
              : { ...prev, [targetPage]: resolvedBlocks! },
          );
        } catch {
          resolvedBlocks = [];
        }
      }
      if (pdfSha256 && !translationsByPage[targetPage]) {
        try {
          const cachedTrans = await getPaperPageTranslation(
            pdfSha256,
            targetPage,
          );
          if (cachedTrans) {
            setTranslationsByPage((prev) =>
              prev[targetPage] ? prev : { ...prev, [targetPage]: cachedTrans },
            );
          }
        } catch (err) {
          setTranslationError(err instanceof Error ? err.message : String(err));
        }
      }
      return resolvedBlocks;
    },
    [blocksByPage, pdf, pdfSha256, translationsByPage],
  );

  useEffect(() => {
    if (!pdf || loading) return;
    if (translationDisplayMode === 'off' && sidebarTab !== 'translation')
      return;
    const priorityPages =
      effectiveMode === 'scroll'
        ? [pageNumber, pageNumber + 1, pageNumber - 1].filter(
            (n) => n >= 1 && n <= pageCount,
          )
        : visiblePages;
    for (const pg of priorityPages) {
      void ensurePageLayoutAndCache(pg);
    }
  }, [
    effectiveMode,
    ensurePageLayoutAndCache,
    loading,
    pageCount,
    pageNumber,
    pdf,
    sidebarTab,
    translationDisplayMode,
    visiblePages,
  ]);

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
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPopoverAnchor(null);
      return;
    }
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
    const rawSelectedText = selection.toString().trim();
    const selectedText = cleanPdfSelectionText(rawSelectedText);
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

    const stageBounds = stageRef.current?.getBoundingClientRect();
    const rangeBounds = range.getBoundingClientRect();
    if (stageBounds && stageBounds.width > 0 && stageBounds.height > 0) {
      setPopoverAnchor({
        centerX: rangeBounds.left + rangeBounds.width / 2 - stageBounds.left,
        top: rangeBounds.top - stageBounds.top,
        bottom: rangeBounds.bottom - stageBounds.top,
        stageWidth: stageBounds.width,
        stageHeight: stageBounds.height,
      });
    } else {
      setPopoverAnchor(null);
    }

    const pageText = layer.innerText || '';
    const textIndex = pageText.indexOf(rawSelectedText);
    setSelectionDraft({
      pageNumber: Number(pageElement.dataset.paperPageNumber),
      selectedText,
      rects,
      contextBefore:
        textIndex >= 0
          ? pageText.slice(Math.max(0, textIndex - 100), textIndex)
          : '',
      contextAfter:
        textIndex >= 0
          ? pageText.slice(
              textIndex + rawSelectedText.length,
              textIndex + rawSelectedText.length + 100,
            )
          : '',
    });
    setSelectionComment('');
    setSelectionTranslation(null);
    setSelectionTransError(null);
    setCopiedTransNotice(false);
  };

  const persistDraftAnnotation = async (
    draft: SelectionDraft,
    commentText: string,
  ) => {
    setSaving(true);
    try {
      const saved = await literatureApi.saveAnnotation({
        paperId: paper.id,
        pageNumber: draft.pageNumber,
        selectedText: draft.selectedText,
        comment: commentText.trim() || null,
        color: selectionColor,
        rects: draft.rects,
        contextBefore: draft.contextBefore,
        contextAfter: draft.contextAfter,
      });
      setAnnotations((current) => [...current, saved]);
      setActiveAnnotationId(saved.id);
      setSelectionDraft(null);
      setSelectionComment('');
      setPopoverAnchor(null);
      setSelectionTranslation(null);
      window.getSelection()?.removeAllRanges();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  const saveSelection = async () => {
    if (!selectionDraft) return;
    await persistDraftAnnotation(selectionDraft, selectionComment);
  };

  const formatSelectionTranslationNote = (
    item: PaperSelectionTranslation,
  ): string => {
    const parts = [`【译文】${item.translation}`];
    if (item.phoneticOrPos) {
      parts[0] = `【译文】(${item.phoneticOrPos}) ${item.translation}`;
    }
    if (item.termNote) {
      parts.push(`【术语】${item.termNote}`);
    }
    return parts.join('\n');
  };

  const handleTranslateSelection = async (
    preferredMode?: 'word' | 'passage',
    appendToNote = false,
  ) => {
    if (!selectionDraft) return;
    const modeToUse =
      preferredMode ??
      (isShortTermSelection(selectionDraft.selectedText) ? 'word' : 'passage');
    setSelectionTranslating(true);
    setSelectionTransError(null);
    setCopiedTransNotice(false);
    try {
      const result = await translatePaperSelection({
        pdfSha256,
        paperTitle: paper.title,
        text: selectionDraft.selectedText,
        mode: modeToUse,
        contextBefore: selectionDraft.contextBefore,
        contextAfter: selectionDraft.contextAfter,
      });
      setSelectionTranslation(result);
      if (appendToNote) {
        const note = formatSelectionTranslationNote(result);
        setSelectionComment((prev) =>
          prev.trim() ? `${prev.trim()}\n${note}` : note,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSelectionTransError(message);
      if (appendToNote) {
        setError(message);
      }
    } finally {
      setSelectionTranslating(false);
    }
  };

  const handlePopoverQuickHighlight = async (withTranslation = false) => {
    if (!selectionDraft) return;
    const note =
      withTranslation && selectionTranslation
        ? formatSelectionTranslationNote(selectionTranslation)
        : selectionComment;
    await persistDraftAnnotation(selectionDraft, note);
    setSidebarTab('annotations');
    setSidebarOpen(true);
  };

  const handlePopoverOpenNote = (withTranslation = false) => {
    if (withTranslation && selectionTranslation) {
      const formatted = formatSelectionTranslationNote(selectionTranslation);
      setSelectionComment((prev) =>
        prev.trim() ? `${prev.trim()}\n${formatted}` : formatted,
      );
    }
    setPopoverAnchor(null);
    setSidebarTab('annotations');
    setSidebarOpen(true);
  };

  const handleCopySelectionTranslation = async () => {
    if (!selectionTranslation?.translation) return;
    try {
      await navigator.clipboard.writeText(selectionTranslation.translation);
      setCopiedTransNotice(true);
      window.setTimeout(() => setCopiedTransNotice(false), 1800);
    } catch {
      // Ignore clipboard failures in restricted contexts
    }
  };

  const handleTranslatePage = async (targetPage: number, force = false) => {
    if (!pdf) return;
    translationCancelRef.current = false;
    setTranslationError(null);
    setTranslatingPage(targetPage);
    setTranslationProgress(null);
    try {
      const blocks = await ensurePageLayoutAndCache(targetPage);
      const record = await translatePaperPage({
        paperTitle: paper.title,
        pdfSha256,
        pageNumber: targetPage,
        blocks,
        force,
        onProgress: (done, total) => setTranslationProgress({ done, total }),
        isCancelled: () => translationCancelRef.current,
      });
      setTranslationsByPage((prev) => ({
        ...prev,
        [targetPage]: record,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('已取消')) {
        setTranslationError(msg);
      }
    } finally {
      setTranslatingPage(null);
      setTranslationProgress(null);
    }
  };

  const handleCancelPageTranslation = () => {
    translationCancelRef.current = true;
  };

  const handleClearPageTranslationCache = async (targetPage: number) => {
    if (!pdfSha256) return;
    try {
      await deletePaperPageTranslation(pdfSha256, targetPage);
      setTranslationsByPage((prev) => {
        const next = { ...prev };
        delete next[targetPage];
        return next;
      });
    } catch (err) {
      setTranslationError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectTranslatedBlock = (targetPage: number, blockId: number) => {
    if (blockId < 0) {
      setActiveTranslatedBlock(null);
      return;
    }
    setActiveTranslatedBlock({ pageNumber: targetPage, blockId });
    goToPage(targetPage);
    window.setTimeout(() => {
      const focusNode = stageRef.current?.querySelector<HTMLElement>(
        `[data-paper-page-number="${targetPage}"] .paper-pdf-trans-focus`,
      );
      focusNode?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 60);
  };

  const handleSaveBlockAsAnnotation = async (
    block: PaperParagraphBlock,
    translation: string,
  ) => {
    setSaving(true);
    try {
      const saved = await literatureApi.saveAnnotation({
        paperId: paper.id,
        pageNumber: block.pageNumber,
        selectedText: block.text,
        comment: `【双语译文】${translation}`,
        color: selectionColor,
        rects: block.rects.slice(0, 24),
        contextBefore: null,
        contextAfter: null,
      });
      setAnnotations((current) => [...current, saved]);
      setActiveAnnotationId(saved.id);
    } catch (err) {
      setTranslationError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleBilingualMode = () => {
    if (translationDisplayMode === 'off') {
      setTranslationDisplayMode('sidebar');
      setSidebarTab('translation');
      setSidebarOpen(true);
      if (!translationsByPage[pageNumber] && translatingPage === null) {
        void handleTranslatePage(pageNumber, false);
      }
    } else {
      setTranslationDisplayMode('off');
    }
  };

  const handleCheckPdf2Zh = async () => {
    setCheckingPdf2Zh(true);
    setDualPdfError(null);
    try {
      const status = await checkPdf2ZhStatus();
      setPdf2ZhStatus(status);
    } catch (err) {
      setDualPdfError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingPdf2Zh(false);
    }
  };

  const switchLoadedPdfPath = async (targetPath: string) => {
    const task = getDocument({ url: convertFileSrc(targetPath) });
    const previousTask = pdfTaskRef.current;
    pdfTaskRef.current = task;
    const loadedPdf = await task.promise;
    const firstPage = await loadedPdf.getPage(1);
    const vp = firstPage.getViewport({ scale: 1 });
    setBasePageSize({ width: vp.width, height: vp.height });
    setPageCount(loadedPdf.numPages);
    setPageNumber((curr) => clamp(curr, 1, loadedPdf.numPages));
    setPdf(loadedPdf);
    setBlocksByPage({});
    if (previousTask && previousTask !== task) {
      void previousTask.destroy();
    }
  };

  const handleGenerateDualPdf = async (force = false) => {
    setGeneratingDualPdf(true);
    setDualPdfError(null);
    try {
      const result = await generateBilingualPaperPdf(paper.id, { force });
      setDualPdfResult(result);
      await switchLoadedPdfPath(result.dualPdfPath);
      setViewingDualPdf(true);
    } catch (err) {
      setDualPdfError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingDualPdf(false);
    }
  };

  const handleToggleDualPdf = async () => {
    if (!dualPdfResult) return;
    setDualPdfError(null);
    try {
      const nextViewingDual = !viewingDualPdf;
      const targetPath = nextViewingDual
        ? dualPdfResult.dualPdfPath
        : originalPdfPathRef.current;
      if (!targetPath) return;
      await switchLoadedPdfPath(targetPath);
      setViewingDualPdf(nextViewingDual);
    } catch (err) {
      setDualPdfError(err instanceof Error ? err.message : String(err));
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

          <div className="paper-reader-translation-toolbar">
            <button
              type="button"
              className={translationDisplayMode !== 'off' ? 'is-selected' : ''}
              onClick={handleToggleBilingualMode}
              disabled={loading}
              aria-pressed={translationDisplayMode !== 'off'}
              title="开启/关闭论文双语对照翻译"
            >
              {translationDisplayMode !== 'off' ? '双语：开' : '双语对照'}
            </button>
            {translationDisplayMode !== 'off' && (
              <select
                aria-label="双语译文显示方式"
                value={translationDisplayMode}
                onChange={(event) =>
                  setTranslationDisplayMode(
                    event.target.value as PaperTranslationDisplayMode,
                  )
                }
              >
                <option value="sidebar">侧栏对照</option>
                <option value="overlay">页内覆盖</option>
                <option value="bilingual">页内浮卡</option>
              </select>
            )}
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                if (translatingPage !== null) {
                  handleCancelPageTranslation();
                } else {
                  if (translationDisplayMode === 'off') {
                    setTranslationDisplayMode('sidebar');
                  }
                  setSidebarTab('translation');
                  setSidebarOpen(true);
                  void handleTranslatePage(pageNumber, false);
                }
              }}
              title="使用 AI 翻译当前页全部段落"
            >
              {translatingPage !== null
                ? translationProgress
                  ? `停止 (${translationProgress.done}/${translationProgress.total})`
                  : '停止翻译'
                : '翻译本页'}
            </button>
          </div>

          <span className="paper-reader-hint">
            ← → 翻页 · 选中文字可翻译、高亮或批注
          </span>
        </div>

        <div
          className={`paper-reader-body${sidebarOpen ? '' : ' is-sidebar-closed'}`}
        >
          <div className="paper-reader-stage-shell">
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
                      paragraphBlocks={blocksByPage[number]}
                      pageTranslations={translationMapsByPage[number]}
                      translationDisplayMode={
                        viewingDualPdf ? 'off' : translationDisplayMode
                      }
                      activeTranslatedBlockId={
                        activeTranslatedBlock?.pageNumber === number
                          ? activeTranslatedBlock.blockId
                          : null
                      }
                      onSelectTranslatedBlock={(pg, blockId) => {
                        handleSelectTranslatedBlock(pg, blockId);
                        if (
                          blockId >= 0 &&
                          translationDisplayMode === 'sidebar'
                        ) {
                          setSidebarTab('translation');
                          setSidebarOpen(true);
                        }
                      }}
                    />
                  ))}
                </div>
              )}
            </main>

            {selectionDraft && popoverAnchor && (
              <PaperSelectionPopover
                selectedText={selectionDraft.selectedText}
                anchor={popoverAnchor}
                translating={selectionTranslating}
                translation={selectionTranslation}
                error={selectionTransError}
                savingHighlight={saving}
                copiedNotice={copiedTransNotice}
                onTranslate={(preferredMode) =>
                  void handleTranslateSelection(preferredMode)
                }
                onQuickHighlight={(withTranslation) =>
                  void handlePopoverQuickHighlight(withTranslation)
                }
                onOpenAnnotationNote={(withTranslation) =>
                  handlePopoverOpenNote(withTranslation)
                }
                onCopyTranslation={() => void handleCopySelectionTranslation()}
                onClose={() => setPopoverAnchor(null)}
              />
            )}
          </div>

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
                    ['translation', '译文'],
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

              {sidebarTab === 'translation' && (
                <div className="paper-reader-sidebar-content">
                  <div className="paper-reader-sidebar-title">
                    双语对照译文 <span>P.{pageNumber}</span>
                  </div>
                  <PaperTranslationSidebar
                    visiblePages={
                      effectiveMode === 'scroll' ? [pageNumber] : visiblePages
                    }
                    pageNumber={pageNumber}
                    displayMode={
                      translationDisplayMode === 'off'
                        ? 'sidebar'
                        : translationDisplayMode
                    }
                    onChangeDisplayMode={(nextMode) =>
                      setTranslationDisplayMode(nextMode)
                    }
                    blocksByPage={blocksByPage}
                    translationsByPage={translationsByPage}
                    translatingPage={translatingPage}
                    progress={translationProgress}
                    translationError={translationError}
                    activeBlock={activeTranslatedBlock}
                    onTranslatePage={(targetPage, force) => {
                      if (translationDisplayMode === 'off') {
                        setTranslationDisplayMode('sidebar');
                      }
                      void handleTranslatePage(targetPage, force);
                    }}
                    onCancelTranslate={handleCancelPageTranslation}
                    onClearPageCache={(targetPage) =>
                      void handleClearPageTranslationCache(targetPage)
                    }
                    onSelectBlock={handleSelectTranslatedBlock}
                    onSaveBlockAsAnnotation={(block, translatedText) =>
                      void handleSaveBlockAsAnnotation(block, translatedText)
                    }
                    pdf2ZhStatus={pdf2ZhStatus}
                    checkingPdf2Zh={checkingPdf2Zh}
                    generatingDualPdf={generatingDualPdf}
                    dualPdfResult={dualPdfResult}
                    viewingDualPdf={viewingDualPdf}
                    dualPdfError={dualPdfError}
                    onCheckPdf2Zh={() => void handleCheckPdf2Zh()}
                    onGenerateDualPdf={(force) =>
                      void handleGenerateDualPdf(force)
                    }
                    onToggleDualPdf={() => void handleToggleDualPdf()}
                  />
                </div>
              )}

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
                          disabled={selectionTranslating}
                          onClick={() =>
                            void handleTranslateSelection(undefined, true)
                          }
                        >
                          {selectionTranslating ? '翻译中…' : 'AI 译入笔记'}
                        </button>
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
