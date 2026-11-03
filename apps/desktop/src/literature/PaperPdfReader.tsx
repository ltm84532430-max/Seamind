import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { GlobalWorkerOptions, TextLayer, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { literatureApi } from './literature-api';
import type {
  PaperAnnotation,
  PaperAnnotationInput,
  PaperAnnotationRect,
  PaperItem,
} from './types';
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

const ANNOTATION_COLORS = ['#f4d35e', '#8bd3dd', '#b8a1e3', '#f4978e'];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const PaperPdfReader: React.FC<PaperPdfReaderProps> = ({
  paper,
  onClose,
  onReadStarted,
}) => {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.15);
  const [pdfSha256, setPdfSha256] = useState('');
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
  const [pageHasText, setPageHasText] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [opened, savedAnnotations, progress] = await Promise.all([
          literatureApi.openPdf(paper.id),
          literatureApi.listAnnotations(paper.id),
          literatureApi.getReadingProgress(paper.id),
        ]);
        if (cancelled) return;
        setPdfSha256(opened.sha256);
        setAnnotations(savedAnnotations);
        const task = getDocument({ url: convertFileSrc(opened.path) });
        loadingTask = task;
        const loadedPdf = await task.promise;
        if (cancelled) {
          await task.destroy();
          return;
        }
        setPdf(loadedPdf);
        setPageCount(loadedPdf.numPages);
        setPageNumber(clamp(progress?.pageNumber ?? 1, 1, loadedPdf.numPages));
        setScale(clamp(progress?.scale ?? 1.15, 0.65, 2.5));
        try {
          await literatureApi.updateReadStatus(paper.id, 'reading');
          onReadStarted(paper.id);
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

  const pageAnnotations = useMemo(
    () =>
      annotations.filter(
        (annotation) =>
          annotation.pageNumber === pageNumber &&
          annotation.pdfSha256 === pdfSha256 &&
          annotation.rects.length > 0,
      ),
    [annotations, pageNumber, pdfSha256],
  );

  useEffect(() => {
    if (
      !pdf ||
      !canvasRef.current ||
      !textLayerRef.current ||
      !pageRef.current
    ) {
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;

    const renderPage = async () => {
      setError(null);
      try {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const textLayerContainer = textLayerRef.current;
        const pageContainer = pageRef.current;
        if (!canvas || !textLayerContainer || !pageContainer || cancelled)
          return;

        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        pageContainer.style.width = `${viewport.width}px`;
        pageContainer.style.height = `${viewport.height}px`;
        pageContainer.style.setProperty('--total-scale-factor', String(scale));
        textLayerContainer.replaceChildren();
        textLayerContainer.style.width = `${viewport.width}px`;
        textLayerContainer.style.height = `${viewport.height}px`;

        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建 PDF 页面画布。');
        renderTask = page.render({
          canvas,
          viewport,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
        });
        const textContent = await page.getTextContent();
        if (cancelled) return;
        setPageHasText(
          textContent.items.some((item) => 'str' in item && item.str.trim()),
        );
        textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerContainer,
          viewport,
        });
        await Promise.all([renderTask.promise, textLayer.render()]);
      } catch (renderError) {
        if (!cancelled) {
          setError(
            renderError instanceof Error
              ? renderError.message
              : String(renderError),
          );
        }
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pdf, pageNumber, scale]);

  const persistProgress = useCallback(
    (nextPage: number, nextScale: number) => {
      void literatureApi
        .saveReadingProgress(paper.id, nextPage, nextScale)
        .catch((progressError) =>
          console.error('保存论文阅读进度失败:', progressError),
        );
    },
    [paper.id],
  );

  const goToPage = (nextPage: number) => {
    const safePage = clamp(Math.round(nextPage), 1, Math.max(1, pageCount));
    setPageNumber(safePage);
    setSelectionDraft(null);
    persistProgress(safePage, scale);
  };

  const changeScale = (nextScale: number) => {
    const safeScale = clamp(Math.round(nextScale * 100) / 100, 0.65, 2.5);
    setScale(safeScale);
    persistProgress(pageNumber, safeScale);
  };

  const fitWidth = async () => {
    if (!pdf || !stageRef.current) return;
    try {
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(320, stageRef.current.clientWidth - 52);
      changeScale(clamp(availableWidth / baseViewport.width, 0.65, 2.5));
    } catch (fitError) {
      console.error('计算 PDF 页面宽度失败:', fitError);
    }
  };

  const captureSelection = () => {
    const selection = window.getSelection();
    const layer = textLayerRef.current;
    const pageElement = pageRef.current;
    if (!selection || selection.isCollapsed || !layer || !pageElement) return;
    const selectedText = selection.toString().trim();
    const range = selection.getRangeAt(0);
    const commonNode = range.commonAncestorContainer;
    const commonElement =
      commonNode instanceof Element ? commonNode : commonNode.parentElement;
    if (!selectedText || !commonElement || !layer.contains(commonElement))
      return;

    const pageBounds = pageElement.getBoundingClientRect();
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
        return {
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        };
      })
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return;

    const pageText = layer.innerText || '';
    const textIndex = pageText.indexOf(selectedText);
    setSelectionDraft({
      pageNumber,
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

  return (
    <div
      className="paper-reader-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="论文 PDF 阅读器"
    >
      <div className="paper-reader-shell">
        <header className="paper-reader-header">
          <div className="paper-reader-heading">
            <span className="paper-reader-kicker">论文原文</span>
            <strong title={paper.title}>{paper.title}</strong>
          </div>
          <button
            type="button"
            className="paper-reader-close"
            onClick={onClose}
          >
            返回文献
          </button>
        </header>

        <div className="paper-reader-toolbar">
          <div className="paper-reader-pages">
            <button
              type="button"
              onClick={() => goToPage(pageNumber - 1)}
              disabled={loading || pageNumber <= 1}
              aria-label="上一页"
            >
              ‹
            </button>
            <input
              aria-label="页码"
              type="number"
              min={1}
              max={pageCount || 1}
              value={pageNumber}
              onChange={(event) => goToPage(Number(event.target.value) || 1)}
              disabled={loading || !pageCount}
            />
            <span>/ {pageCount || '—'}</span>
            <button
              type="button"
              onClick={() => goToPage(pageNumber + 1)}
              disabled={loading || pageNumber >= pageCount}
              aria-label="下一页"
            >
              ›
            </button>
          </div>
          <div className="paper-reader-zoom">
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
              className="paper-reader-fit"
              onClick={() => void fitWidth()}
              disabled={loading}
            >
              适合宽度
            </button>
          </div>
          <span className="paper-reader-hint">选中文字后可添加高亮和批注</span>
        </div>

        <div className="paper-reader-body">
          <main className="paper-reader-stage" ref={stageRef}>
            {loading && (
              <div className="paper-reader-message">正在打开 PDF…</div>
            )}
            {error && <div className="paper-reader-error">{error}</div>}
            {!loading && !error && pdf && (
              <div
                className="paper-reader-page-scroller"
                onMouseUp={captureSelection}
              >
                <div
                  className="paper-pdf-page"
                  key={`${pageNumber}-${scale}`}
                  ref={pageRef}
                >
                  <canvas
                    ref={canvasRef}
                    aria-label={`PDF 第 ${pageNumber} 页`}
                  />
                  <div
                    className="paper-pdf-annotation-layer"
                    aria-hidden="true"
                  >
                    {pageAnnotations.map((annotation) =>
                      annotation.rects.map((rect, index) => (
                        <span
                          key={`${annotation.id}-${index}`}
                          className={`paper-pdf-highlight ${activeAnnotationId === annotation.id ? 'is-active' : ''}`}
                          style={{
                            left: `${rect.x * 100}%`,
                            top: `${rect.y * 100}%`,
                            width: `${rect.width * 100}%`,
                            height: `${rect.height * 100}%`,
                            backgroundColor:
                              annotation.color || ANNOTATION_COLORS[0],
                          }}
                        />
                      )),
                    )}
                  </div>
                  <div className="textLayer" ref={textLayerRef} />
                </div>
                {!pageHasText && (
                  <div className="paper-reader-scan-note">
                    此页没有可选文字，可能是扫描版 PDF；当前无法对其文字做高亮。
                  </div>
                )}
              </div>
            )}
          </main>

          <aside className="paper-reader-notes">
            <div className="paper-reader-notes-head">
              <strong>页内批注</strong>
              <span>{annotations.length}</span>
            </div>
            {selectionDraft && (
              <section className="paper-reader-selection">
                <div className="paper-reader-selection-title">
                  第 {selectionDraft.pageNumber} 页 · 新建高亮
                </div>
                <blockquote>{selectionDraft.selectedText}</blockquote>
                <div className="paper-reader-color-row" aria-label="高亮颜色">
                  {ANNOTATION_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={selectionColor === color ? 'is-selected' : ''}
                      style={{ backgroundColor: color }}
                      onClick={() => setSelectionColor(color)}
                      aria-label={`选择颜色 ${color}`}
                    />
                  ))}
                </div>
                <textarea
                  value={selectionComment}
                  onChange={(event) => setSelectionComment(event.target.value)}
                  placeholder="添加批注（可选）"
                  rows={3}
                />
                <div className="paper-reader-selection-actions">
                  <button type="button" onClick={() => setSelectionDraft(null)}>
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
                  选择原文中的文字，创建第一条批注。
                </div>
              )}
              {annotations.map((annotation) => {
                const stale = staleAnnotationIds.has(annotation.id);
                return (
                  <article
                    key={annotation.id}
                    className={`paper-reader-annotation ${activeAnnotationId === annotation.id ? 'is-active' : ''} ${stale ? 'is-stale' : ''}`}
                    onClick={() => {
                      if (!stale) {
                        setActiveAnnotationId(annotation.id);
                        goToPage(annotation.pageNumber);
                      }
                    }}
                  >
                    <div className="paper-reader-annotation-meta">
                      <span>第 {annotation.pageNumber} 页</span>
                      <span
                        className="paper-reader-annotation-color"
                        style={{
                          backgroundColor:
                            annotation.color || ANNOTATION_COLORS[0],
                        }}
                      />
                    </div>
                    <blockquote>{annotation.selectedText}</blockquote>
                    {stale ? (
                      <p className="paper-reader-stale-message">
                        {!annotation.pdfSha256 || annotation.rects.length === 0
                          ? '这条旧批注缺少可验证的位置数据，请检查原文后重新标注。'
                          : 'PDF 文件版本已变化，此批注的位置未显示。请检查原文后重新标注。'}
                      </p>
                    ) : editingAnnotationId === annotation.id ? (
                      <div
                        className="paper-reader-edit-note"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <textarea
                          value={editingComment}
                          onChange={(event) =>
                            setEditingComment(event.target.value)
                          }
                          rows={3}
                        />
                        <button
                          type="button"
                          onClick={() => void saveEditedComment(annotation)}
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
                    <div
                      className="paper-reader-annotation-actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {!stale && editingAnnotationId !== annotation.id && (
                        <button
                          type="button"
                          onClick={() => startEditing(annotation)}
                        >
                          编辑
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void deleteAnnotation(annotation.id)}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};

export default PaperPdfReader;
