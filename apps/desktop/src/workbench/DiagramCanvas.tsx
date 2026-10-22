import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import {
  fitViewport,
  inlineSvgVariables,
  panBy,
  zoomAt,
} from './diagram-viewport';
import type { Viewport } from './diagram-viewport';

/** The variables a Pele diagram colours itself with, copied into an exported file. */
const THEME_VARIABLES = [
  '--pele-bg',
  '--pele-fg',
  '--pele-muted',
  '--pele-line',
  '--pele-surface',
  '--pele-surface-alt',
  '--pele-border',
  '--pele-accent',
  '--pele-radius',
  '--pele-font',
] as const;

const ZOOM_STEP = 1.2;

export interface DiagramCanvasProps {
  /** Sanitized SVG markup of the diagram, or null while there is none. */
  svg: string | null;
  /** The diagram's own size, in pixels at 100%. */
  width: number;
  height: number;
  /**
   * A new key fits the diagram to the frame again. Edits of the same file keep the zoom and
   * position the reader chose.
   */
  fitKey: string;
  /** The name an exported file gets, without its extension. */
  fileName: string;
  busy?: boolean;
  emptyMessage?: string;
  /** Laid over the canvas, e.g. the error of the last render. */
  overlay?: ReactNode;
}

/** Puts text on the clipboard; the textarea route needs no permission inside a click handler. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through: the page may not be focused, or may not be allowed the async clipboard.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'diagram';
}

/** A pan and zoom surface for one SVG diagram, with copy and export. */
export default function DiagramCanvas({
  svg,
  width,
  height,
  fitKey,
  fileName,
  busy = false,
  emptyMessage = '暂无图表',
  overlay,
}: DiagramCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  const latest = useRef({ svg, width, height, fitKey });
  latest.current = { svg, width, height, fitKey };
  const fittedKeyRef = useRef<string | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const noticeTimerRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState('');
  // A new object makes React set the markup again, which would parse the SVG on every pan step.
  const markup = useMemo(() => ({ __html: svg ?? '' }), [svg]);

  const commit = useCallback((next: Viewport) => {
    viewRef.current = next;
    setView(next);
  }, []);

  /** Fits the diagram to the frame. False while the frame has no size yet. */
  const fit = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return false;
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const current = latest.current;
    commit(
      fitViewport(
        { width: current.width, height: current.height },
        { width: rect.width, height: rect.height },
      ),
    );
    return true;
  }, [commit]);

  const zoomBy = useCallback(
    (factor: number) => {
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect) return;
      commit(
        zoomAt(viewRef.current, factor, {
          x: rect.width / 2,
          y: rect.height / 2,
        }),
      );
    },
    [commit],
  );

  useLayoutEffect(() => {
    if (!svg || fittedKeyRef.current === fitKey) return;
    if (fit()) fittedKeyRef.current = fitKey;
  }, [svg, fitKey, fit]);

  // The frame can have no size when a diagram arrives (a hidden pane), and it changes size when
  // the window or the full-screen mode does; an unfitted diagram is fitted as soon as it can be.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const observer = new ResizeObserver(() => {
      const current = latest.current;
      if (current.svg && fittedKeyRef.current !== current.fitKey && fit())
        fittedKeyRef.current = current.fitKey;
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [fit]);

  // Registered by hand because React attaches wheel listeners as passive ones, which cannot stop
  // the page behind the canvas from scrolling.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      commit(
        zoomAt(viewRef.current, Math.exp(-event.deltaY * 0.0015), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }),
      );
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => frame.removeEventListener('wheel', onWheel);
  }, [commit]);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      fittedKeyRef.current = null;
      setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), []);

  const flash = (message: string) => {
    window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 2400);
  };

  const exportMarkup = () => {
    if (!svg) return '';
    const variables: Record<string, string> = {};
    if (frameRef.current) {
      const style = getComputedStyle(frameRef.current);
      for (const name of THEME_VARIABLES)
        variables[name] = style.getPropertyValue(name);
    }
    return inlineSvgVariables(svg, variables);
  };

  const copySvg = async () => {
    flash(
      (await writeClipboard(exportMarkup()))
        ? '已复制 SVG'
        : '复制失败，请改用“导出 SVG”',
    );
  };

  const exportSvg = () => {
    const markup = `<?xml version="1.0" encoding="UTF-8"?>\n${exportMarkup()}\n`;
    const url = URL.createObjectURL(
      new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeFileName(fileName)}.svg`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    flash(`已导出 ${link.download}`);
  };

  const toggleFullscreen = () => {
    fittedKeyRef.current = null;
    setFullscreen((value) => !value);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    commit(
      panBy(viewRef.current, event.clientX - drag.x, event.clientY - drag.y),
    );
    drag.x = event.clientX;
    drag.y = event.clientY;
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP);
    else if (event.key === '-' || event.key === '_') zoomBy(1 / ZOOM_STEP);
    else if (event.key === '0') fit();
    else return;
    event.preventDefault();
  };

  const resetZoom = () => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    commit(
      zoomAt(viewRef.current, 1 / viewRef.current.scale, {
        x: rect.width / 2,
        y: rect.height / 2,
      }),
    );
  };

  return (
    <div
      className={`diagram-canvas seamind-pele-panel${fullscreen ? ' is-fullscreen' : ''}`}
    >
      <div
        className="diagram-canvas-toolbar"
        role="toolbar"
        aria-label="图表工具"
      >
        <button
          type="button"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          aria-label="缩小"
          title="缩小"
        >
          −
        </button>
        <button
          type="button"
          className="diagram-canvas-zoom"
          onClick={resetZoom}
          title="恢复 100%"
        >
          {Math.round(view.scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoomBy(ZOOM_STEP)}
          aria-label="放大"
          title="放大"
        >
          ＋
        </button>
        <span className="diagram-canvas-divider" aria-hidden="true" />
        <button
          type="button"
          onClick={() => fit()}
          title="适应窗口（双击画布或按 0）"
        >
          适配
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-pressed={fullscreen}
          title={fullscreen ? '退出全屏（Esc）' : '全屏查看'}
        >
          {fullscreen ? '退出全屏' : '全屏'}
        </button>
        <span className="diagram-canvas-spacer" />
        {notice && (
          <span className="diagram-canvas-notice" role="status">
            {notice}
          </span>
        )}
        <button type="button" onClick={() => void copySvg()} disabled={!svg}>
          复制 SVG
        </button>
        <button type="button" onClick={exportSvg} disabled={!svg}>
          导出 SVG
        </button>
      </div>
      <div
        ref={frameRef}
        className={`diagram-canvas-frame${dragging ? ' is-dragging' : ''}`}
        tabIndex={0}
        aria-label="图表画布：拖动平移，滚轮缩放，双击适配"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => fit()}
        onKeyDown={onKeyDown}
      >
        {svg ? (
          <div
            className="diagram-canvas-stage"
            style={{
              width,
              height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
            dangerouslySetInnerHTML={markup}
          />
        ) : (
          <div className="diagram-canvas-empty">
            {busy ? '正在渲染…' : emptyMessage}
          </div>
        )}
        {busy && svg && <span className="diagram-canvas-busy">渲染中…</span>}
        {overlay && (
          <div
            className="diagram-canvas-overlay"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {overlay}
          </div>
        )}
      </div>
    </div>
  );
}
