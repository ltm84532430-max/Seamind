import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { PaperAnnotation, PaperAnnotationRect } from './types';

import type { PaperParagraphBlock } from './paper-pdf-layout';

export type PaperTranslationDisplayMode =
  | 'off'
  | 'sidebar'
  | 'overlay'
  | 'bilingual';

interface PaperPdfPageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  pdfSha256: string;
  annotations: PaperAnnotation[];
  activeAnnotationId: string | null;
  lazy: boolean;
  shouldRender: boolean;
  baseSize: { width: number; height: number };
  paragraphBlocks?: PaperParagraphBlock[];
  pageTranslations?: Record<number, string>;
  translationDisplayMode?: PaperTranslationDisplayMode;
  activeTranslatedBlockId?: number | null;
  onSelectTranslatedBlock?: (pageNumber: number, blockId: number) => void;
}

const DEFAULT_HIGHLIGHT = '#f4d35e';

export const PaperPdfPage: React.FC<PaperPdfPageProps> = ({
  pdf,
  pageNumber,
  scale,
  pdfSha256,
  annotations,
  activeAnnotationId,
  lazy,
  shouldRender,
  baseSize,
  paragraphBlocks = [],
  pageTranslations,
  translationDisplayMode = 'off',
  activeTranslatedBlockId = null,
  onSelectTranslatedBlock,
}) => {
  const [peekingBlockIds, setPeekingBlockIds] = useState<
    Record<number, boolean>
  >({});
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [renderStatus, setRenderStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >(lazy ? 'idle' : 'loading');
  const [renderError, setRenderError] = useState('');
  const [hasText, setHasText] = useState(true);
  const [retry, setRetry] = useState(0);
  const [pageBaseSize, setPageBaseSize] = useState(baseSize);

  const visibleAnnotations = useMemo(
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
    const canvas = canvasRef.current;
    const textLayerContainer = textLayerRef.current;
    const pageContainer = wrapperRef.current;
    if (!canvas || !textLayerContainer || !pageContainer || !shouldRender) {
      if (lazy) setRenderStatus('idle');
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    setRenderStatus('loading');
    setRenderError('');

    const renderPage = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        const naturalViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale });
        if (cancelled) return;

        setPageBaseSize({
          width: naturalViewport.width,
          height: naturalViewport.height,
        });
        pageContainer.style.setProperty('--total-scale-factor', String(scale));
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
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
        setHasText(
          textContent.items.some(
            (item) => 'str' in item && item.str.trim().length > 0,
          ),
        );
        textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerContainer,
          viewport,
        });
        await Promise.all([renderTask.promise, textLayer.render()]);
        if (!cancelled) setRenderStatus('ready');
      } catch (cause) {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setRenderError(message);
        setRenderStatus('error');
      }
    };

    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      if (lazy && canvas) {
        canvas.width = 0;
        canvas.height = 0;
        textLayerContainer.replaceChildren();
      }
    };
  }, [lazy, pageNumber, pdf, retry, scale, shouldRender]);

  const width = Math.max(1, pageBaseSize.width * scale);
  const height = Math.max(1, pageBaseSize.height * scale);

  return (
    <div
      className={`paper-pdf-page${renderStatus === 'loading' ? ' is-rendering' : ''}`}
      ref={wrapperRef}
      data-paper-page-number={pageNumber}
      aria-label={`PDF 第 ${pageNumber} 页`}
      style={{ width, height }}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="paper-pdf-annotation-layer" aria-hidden="true">
        {visibleAnnotations.flatMap((annotation) =>
          annotation.rects.map((rect: PaperAnnotationRect, index) => (
            <span
              key={`${annotation.id}-${index}`}
              className={`paper-pdf-highlight ${activeAnnotationId === annotation.id ? 'is-active' : ''}`}
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
                backgroundColor: annotation.color || DEFAULT_HIGHLIGHT,
              }}
            />
          )),
        )}
        {translationDisplayMode !== 'off' &&
          activeTranslatedBlockId !== null &&
          paragraphBlocks
            .filter((block) => block.id === activeTranslatedBlockId)
            .flatMap((block) =>
              block.rects.map((rect, index) => (
                <span
                  key={`trans-focus-${block.id}-${index}`}
                  className="paper-pdf-trans-focus"
                  style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.width * 100}%`,
                    height: `${rect.height * 100}%`,
                  }}
                />
              )),
            )}
      </div>
      <div className="textLayer" ref={textLayerRef} />
      {translationDisplayMode !== 'off' &&
        pageTranslations &&
        paragraphBlocks.length > 0 && (
          <div
            className={`paper-pdf-translation-layer is-${translationDisplayMode}`}
            aria-label={`第 ${pageNumber} 页双语译文层`}
          >
            {paragraphBlocks.map((block) => {
              const translation = pageTranslations[block.id];
              if (!translation) return null;
              const isActive = activeTranslatedBlockId === block.id;
              const isPeeking = Boolean(peekingBlockIds[block.id]);

              if (translationDisplayMode === 'overlay') {
                return (
                  <div
                    key={`overlay-${block.id}`}
                    className={`paper-pdf-overlay-block ${isActive ? 'is-active' : ''} ${isPeeking ? 'is-peeking' : ''} ${block.isHeading ? 'is-heading' : ''}`}
                    style={{
                      left: `${block.bbox.x * 100}%`,
                      top: `${block.bbox.y * 100}%`,
                      width: `${Math.max(8, block.bbox.width * 100)}%`,
                      minHeight: `${Math.max(1.5, block.bbox.height * 100)}%`,
                      fontSize: `${Math.max(10, Math.round((block.isHeading ? 12 : 10.2) * scale))}px`,
                    }}
                    onClick={() =>
                      onSelectTranslatedBlock?.(pageNumber, block.id)
                    }
                  >
                    {!isPeeking && (
                      <div className="paper-pdf-overlay-text">
                        {translation}
                      </div>
                    )}
                    <button
                      type="button"
                      className="paper-pdf-peek-btn"
                      title={isPeeking ? '恢复中文译文' : '查看英文原文'}
                      onClick={(event) => {
                        event.stopPropagation();
                        setPeekingBlockIds((prev) => ({
                          ...prev,
                          [block.id]: !prev[block.id],
                        }));
                      }}
                    >
                      {isPeeking ? '译' : '原'}
                    </button>
                  </div>
                );
              }

              return (
                <React.Fragment key={`marker-${block.id}`}>
                  <button
                    type="button"
                    className={`paper-pdf-para-marker ${isActive ? 'is-active' : ''}`}
                    style={{
                      left: `${Math.max(0.3, (block.bbox.x - 0.015) * 100)}%`,
                      top: `${block.bbox.y * 100}%`,
                      height: `${Math.max(1.4, block.bbox.height * 100)}%`,
                    }}
                    title="点击查看或定位该段译文"
                    onClick={() =>
                      onSelectTranslatedBlock?.(pageNumber, block.id)
                    }
                  />
                  {translationDisplayMode === 'bilingual' && isActive && (
                    <div
                      className="paper-pdf-bilingual-popover"
                      style={{
                        left: `${Math.min(54, Math.max(3, block.bbox.x * 100))}%`,
                        top: `${Math.min(78, (block.bbox.y + block.bbox.height) * 100 + 0.8)}%`,
                        width: `${Math.max(38, Math.min(84, block.bbox.width * 100))}%`,
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="paper-pdf-bilingual-popover-head">
                        <span>段 {block.id + 1} 译文</span>
                        <button
                          type="button"
                          onClick={() =>
                            onSelectTranslatedBlock?.(pageNumber, -1)
                          }
                        >
                          ×
                        </button>
                      </div>
                      <p>{translation}</p>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        )}
      {renderStatus === 'loading' && (
        <div className="paper-pdf-page-status" role="status">
          正在绘制第 {pageNumber} 页…
        </div>
      )}
      {renderStatus === 'error' && (
        <div className="paper-pdf-page-error" role="alert">
          <strong>第 {pageNumber} 页暂时无法显示</strong>
          <span title={renderError}>{renderError}</span>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试
          </button>
        </div>
      )}
      {renderStatus === 'ready' && !hasText && (
        <div className="paper-pdf-scan-note">
          此页没有可选文字，可能是扫描版 PDF；目前只能阅读，不能直接选词批注。
        </div>
      )}
    </div>
  );
};
