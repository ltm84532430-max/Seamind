import React, { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { literatureApi } from './literature-api';
import './paper-pdf-preview.css';

GlobalWorkerOptions.workerSrc = workerUrl;

interface PaperPdfPreviewProps {
  paperId: string;
  revision: string;
  onOpenReader: () => void;
}

export const PaperPdfPreview: React.FC<PaperPdfPreviewProps> = ({
  paperId,
  revision,
  onOpenReader,
}) => {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setPdf(null);
    setStatus('loading');
    setRendered(false);
    setError('');

    const loadPdf = async () => {
      try {
        const opened = await literatureApi.openPdf(paperId);
        if (cancelled) return;
        loadingTask = getDocument({ url: convertFileSrc(opened.path) });
        const loadedPdf = await loadingTask.promise;
        if (cancelled) return;
        setPdf(loadedPdf);
        setStatus('ready');
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus('error');
      }
    };

    void loadPdf();
    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [paperId, revision]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const updateWidth = () => setWidth(frame.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdf || !canvas || width <= 0) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setRendered(false);

    const renderFirstPage = async () => {
      try {
        const page = await pdf.getPage(1);
        const naturalViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(
          1,
          Math.max(0.1, (width - 24) / naturalViewport.width),
        );
        const viewport = page.getViewport({ scale });
        if (cancelled) return;

        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
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
        await renderTask.promise;
        if (!cancelled) setRendered(true);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus('error');
      }
    };

    void renderFirstPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, width]);

  return (
    <section className="lit-pdf-preview" aria-label="论文 PDF 首页预览">
      <div className="lit-pdf-preview-heading">
        <strong>PDF 第 1 页</strong>
        <span>点击页面打开完整阅读器</span>
      </div>
      {status === 'error' ? (
        <div className="lit-pdf-preview-status" role="status" title={error}>
          首页预览暂时无法显示
        </div>
      ) : (
        <div className="lit-pdf-preview-frame" ref={frameRef}>
          <button
            type="button"
            className="lit-pdf-preview-page"
            onClick={onOpenReader}
            aria-label="在完整阅读器中打开 PDF"
            disabled={!rendered}
          >
            <canvas ref={canvasRef} aria-hidden="true" />
          </button>
          {!rendered && (
            <div className="lit-pdf-preview-status" role="status">
              {status === 'loading' ? '正在加载 PDF…' : '正在绘制首页…'}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default PaperPdfPreview;
