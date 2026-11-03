import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { PaperAnnotation, PaperAnnotationRect } from './types';

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
}) => {
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
      </div>
      <div className="textLayer" ref={textLayerRef} />
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
