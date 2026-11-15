import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { hydrateCodeBlocks } from './code-blocks';
import type { CodeBlockHandlers } from './code-blocks';
import { createMarkdownPreviewMinimap } from './markdown-minimap';
import { computeFootnotePopoverGeometry } from './markdown-footnotes';
import {
  clampLightboxZoom,
  classifyPreviewLinkHref,
  isPreviewImageHref,
} from './markdown-preview-links';
import { parseYouTubeEmbedInput } from '../player/youtube';
import { resolveDocumentMedia } from '../knowledge/document-media';
import { mediaIdFromSource } from '../knowledge/knowledge-paste';
import type { Theme } from '../app/app-storage';

type ActiveImagePreview = {
  src: string;
  alt: string;
  externalHref?: string;
};

type ActiveFootnoteCard = {
  id: string;
  index: string;
  bodyHtml: string;
  fallbackText: string;
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  pinned: boolean;
};

export interface PreviewFootnoteJumpRequest {
  id: string;
  nonce: number;
}

interface MarkdownPreviewProps {
  html: string;
  source: string;
  theme: Theme;
  hideMinimap?: boolean;
  mediaDocumentPath?: string;
  scrollToFootnoteRequest?: PreviewFootnoteJumpRequest | null;
  onCodeChange?: CodeBlockHandlers['onCodeChange'];
  onOpenPlantUmlEditor?: CodeBlockHandlers['onOpenPlantUmlEditor'];
  onOpenWikilink?: (target: string) => void;
  onOpenYouTubeLink?: (videoId: string, startSeconds: number) => void;
  onRunInTerminal?: CodeBlockHandlers['onRunInTerminal'];
  onEditFootnote?: (footnoteId: string) => void;
}

export default function MarkdownPreview({
  html,
  source,
  theme,
  hideMinimap = false,
  mediaDocumentPath,
  scrollToFootnoteRequest,
  onCodeChange,
  onOpenPlantUmlEditor,
  onOpenWikilink,
  onOpenYouTubeLink,
  onRunInTerminal,
  onEditFootnote,
}: MarkdownPreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const minimapHostRef = useRef<HTMLDivElement>(null);
  const flashTimerRef = useRef<number | null>(null);
  const [activeFootnote, setActiveFootnote] =
    useState<ActiveFootnoteCard | null>(null);
  const [activeImage, setActiveImage] = useState<ActiveImagePreview | null>(
    null,
  );
  const [imageZoom, setImageZoom] = useState(1);
  const [fittedWidth, setFittedWidth] = useState<number | null>(null);
  const lightboxImageRef = useRef<HTMLImageElement>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const activeAnchorRef = useRef<HTMLElement | null>(null);
  // React sets the markup again whenever it gets a new object, even for the same string, and that
  // would wipe the diagrams the effect below has put into the page.
  const markup = useMemo(() => {
    if (!mediaDocumentPath || !html.includes('seamind-media:'))
      return { __html: html };
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    parsed.querySelectorAll('img[src]').forEach((image) => {
      const mediaId = mediaIdFromSource(image.getAttribute('src') ?? '');
      if (!mediaId) return;
      image.setAttribute('data-seamind-media-id', mediaId);
      image.removeAttribute('src');
    });
    return { __html: parsed.body.innerHTML };
  }, [html, mediaDocumentPath]);

  useEffect(() => {
    if (!mediaDocumentPath || !rootRef.current) return;
    let cancelled = false;
    const images = Array.from(
      rootRef.current.querySelectorAll<HTMLImageElement>(
        'img[data-seamind-media-id]',
      ),
    );
    for (const image of images) {
      const mediaId = image.dataset.seamindMediaId;
      if (!mediaId) continue;
      const showFailure = (detail: string) => {
        if (cancelled || !image.isConnected) return;
        const fallback = document.createElement('span');
        fallback.className = 'seamind-media-failed';
        fallback.textContent = `图片不可用：${image.alt || mediaId.slice(0, 8)}`;
        fallback.title = detail;
        image.replaceWith(fallback);
      };
      image.addEventListener(
        'error',
        () => showFailure('本地图片无法解码或读取。'),
        { once: true },
      );
      void resolveDocumentMedia(mediaDocumentPath, mediaId)
        .then((url) => {
          if (!cancelled && image.isConnected) image.src = url;
        })
        .catch((error) => {
          showFailure(error instanceof Error ? error.message : String(error));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [markup, mediaDocumentPath]);

  const handlersRef = useRef({
    onCodeChange,
    onOpenPlantUmlEditor,
    onRunInTerminal,
  });
  handlersRef.current = {
    onCodeChange,
    onOpenPlantUmlEditor,
    onRunInTerminal,
  };

  useEffect(() => {
    const root = rootRef.current;
    const minimapHost = minimapHostRef.current;
    if (!root) return;
    const controller = new AbortController();
    let disposed = false;
    let cleanup = () => {};
    const minimap =
      !hideMinimap && minimapHost
        ? createMarkdownPreviewMinimap(source, root, minimapHost)
        : null;
    void hydrateCodeBlocks(
      root,
      theme,
      controller.signal,
      {
        onCodeChange: (...args) => handlersRef.current.onCodeChange?.(...args),
        onOpenPlantUmlEditor: (...args) =>
          handlersRef.current.onOpenPlantUmlEditor?.(...args),
        onRunInTerminal: (...args) =>
          handlersRef.current.onRunInTerminal?.(...args),
      },
      { mode: 'markdown-preview' },
    ).then((release) => {
      if (disposed) release();
      else cleanup = release;
    });
    return () => {
      disposed = true;
      controller.abort();
      cleanup();
      minimap?.destroy();
    };
  }, [markup, source, theme, hideMinimap]);

  const scrollAndFlashElement = useCallback((el: Element | null) => {
    const scroller = rootRef.current;
    if (!scroller || !(el instanceof HTMLElement)) return;

    scroller
      .querySelectorAll('.is-footnote-flash')
      .forEach((node) => node.classList.remove('is-footnote-flash'));

    const scrollerRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const targetTop = Math.max(
      0,
      elRect.top - scrollerRect.top + scroller.scrollTop - 36,
    );
    scroller.scrollTo({ top: targetTop, behavior: 'smooth' });
    el.classList.add('is-footnote-flash');

    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      el.classList.remove('is-footnote-flash');
      flashTimerRef.current = null;
    }, 1800);
  }, []);

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const closeActiveFootnote = useCallback(() => {
    cancelHoverClose();
    activeAnchorRef.current = null;
    setActiveFootnote(null);
  }, [cancelHoverClose]);

  const closeImagePreview = useCallback(() => {
    setActiveImage(null);
    setImageZoom(1);
    setFittedWidth(null);
  }, []);

  const openImagePreview = useCallback(
    (src: string, alt: string, externalHref?: string) => {
      setActiveImage({ src, alt, externalHref });
      setImageZoom(1);
      setFittedWidth(null);
    },
    [],
  );

  const resetImageZoom = useCallback(() => {
    setImageZoom(1);
    setFittedWidth(null);
  }, []);

  const stepImageZoom = useCallback(
    (delta: number) => {
      if (fittedWidth === null) {
        const renderedWidth =
          lightboxImageRef.current?.getBoundingClientRect().width;
        if (renderedWidth && imageZoom > 0) {
          setFittedWidth(Math.max(40, Math.round(renderedWidth / imageZoom)));
        }
      }
      setImageZoom((prev) => clampLightboxZoom(prev + delta));
    },
    [fittedWidth, imageZoom],
  );

  const scheduleHoverClose = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      setActiveFootnote((prev) => {
        if (prev?.pinned) return prev;
        activeAnchorRef.current = null;
        return null;
      });
    }, 160);
  }, [cancelHoverClose]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
      if (hoverCloseTimerRef.current !== null) {
        window.clearTimeout(hoverCloseTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    closeActiveFootnote();
  }, [html, closeActiveFootnote]);

  useEffect(() => {
    closeImagePreview();
  }, [mediaDocumentPath, closeImagePreview]);

  useEffect(() => {
    if (!activeImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeImagePreview();
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        stepImageZoom(0.25);
      } else if (event.key === '-') {
        event.preventDefault();
        stepImageZoom(-0.25);
      } else if (event.key === '0') {
        event.preventDefault();
        resetImageZoom();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [activeImage, closeImagePreview, resetImageZoom, stepImageZoom]);

  useEffect(() => {
    if (!activeFootnote?.pinned) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeActiveFootnote();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest('.seamind-fn-hover-card') ||
        target.closest('.seamind-image-lightbox') ||
        target.closest('a[data-footnote-id], a[data-footnote-preview]')
      ) {
        return;
      }
      closeActiveFootnote();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [activeFootnote?.pinned, closeActiveFootnote]);

  useEffect(() => {
    const anchor = activeAnchorRef.current;
    if (!activeFootnote || !anchor || !anchor.isConnected) return;
    anchor.classList.add('is-footnote-active');
    return () => {
      anchor.classList.remove('is-footnote-active');
    };
  }, [activeFootnote, html]);

  useEffect(() => {
    if (!scrollToFootnoteRequest?.id || !rootRef.current) return;
    const escapedId = CSS.escape(scrollToFootnoteRequest.id);
    const frame = window.requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector(
        `[data-footnote-def-id="${escapedId}"]`,
      );
      if (target) scrollAndFlashElement(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollToFootnoteRequest, html, scrollAndFlashElement]);

  const resolveFootnoteCardPayload = useCallback(
    (refLink: HTMLElement, pinned: boolean): ActiveFootnoteCard | null => {
      const frame = frameRef.current;
      const root = rootRef.current;
      if (!frame || !root) return null;

      const id = refLink.getAttribute('data-footnote-id')?.trim() || '';
      const index = refLink.getAttribute('data-footnote-index')?.trim() || '';
      const fallbackText =
        refLink.getAttribute('data-footnote-preview')?.trim() || '';
      const defBody = id
        ? root.querySelector<HTMLElement>(
            `[data-footnote-def-id="${CSS.escape(id)}"] .seamind-fn-body`,
          )
        : null;
      const bodyHtml = defBody?.innerHTML?.trim() || '';
      if (!bodyHtml && !fallbackText) return null;

      const geometry = computeFootnotePopoverGeometry(
        frame.getBoundingClientRect(),
        root.getBoundingClientRect(),
        refLink.getBoundingClientRect(),
      );

      return {
        id,
        index,
        bodyHtml,
        fallbackText,
        ...geometry,
        pinned,
      };
    },
    [],
  );

  const handleMouseOver = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (activeFootnote?.pinned) return;

    const refLink = target.closest<HTMLElement>(
      'a[data-footnote-id], a[data-footnote-preview]',
    );
    if (!refLink) {
      if (activeFootnote && !target.closest('.seamind-fn-hover-card')) {
        scheduleHoverClose();
      }
      return;
    }

    cancelHoverClose();
    const payload = resolveFootnoteCardPayload(refLink, false);
    if (!payload) return;

    activeAnchorRef.current = refLink;
    setActiveFootnote((prev) => {
      if (prev?.pinned) return prev;
      if (
        prev &&
        prev.id === payload.id &&
        prev.top === payload.top &&
        prev.bottom === payload.bottom &&
        prev.left === payload.left
      ) {
        return prev;
      }
      return payload;
    });
  };

  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const footnoteRef = target.closest<HTMLElement>(
      'a[data-footnote-id], a[data-footnote-preview]',
    );
    if (footnoteRef && rootRef.current) {
      event.preventDefault();
      cancelHoverClose();
      const id = footnoteRef.getAttribute('data-footnote-id')?.trim() || '';
      if (
        activeFootnote?.pinned &&
        (activeAnchorRef.current === footnoteRef ||
          (!activeAnchorRef.current && activeFootnote.id === id))
      ) {
        closeActiveFootnote();
        return;
      }
      const payload = resolveFootnoteCardPayload(footnoteRef, true);
      if (payload) {
        activeAnchorRef.current = footnoteRef;
        setActiveFootnote(payload);
        return;
      }
      if (id) {
        const defEl = rootRef.current.querySelector(
          `[data-footnote-def-id="${CSS.escape(id)}"]`,
        );
        scrollAndFlashElement(defEl);
      }
      return;
    }

    const footnoteBackref = target.closest<HTMLElement>(
      'a[data-footnote-backref]',
    );
    if (footnoteBackref && rootRef.current) {
      event.preventDefault();
      const targetId = footnoteBackref.getAttribute('data-footnote-ref-target');
      if (targetId) {
        const refEl =
          rootRef.current
            .querySelector(`#${CSS.escape(targetId)}`)
            ?.closest('.seamind-fn-ref') ??
          rootRef.current.querySelector(`#${CSS.escape(targetId)}`);
        scrollAndFlashElement(refEl);
      }
      return;
    }

    if (onOpenWikilink) {
      const wikilink = target.closest('[data-wikilink]');
      if (wikilink) {
        event.preventDefault();
        const noteTarget = wikilink.getAttribute('data-wikilink')?.trim();
        if (noteTarget) {
          onOpenWikilink(noteTarget);
        }
        return;
      }
    }

    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    const rawHref = anchor?.getAttribute('href')?.trim() ?? '';

    if (onOpenYouTubeLink && rawHref) {
      const youtube = parseYouTubeEmbedInput(rawHref);
      if (youtube) {
        event.preventDefault();
        onOpenYouTubeLink(youtube.id, youtube.startSeconds);
        return;
      }
    }

    const clickedImage = target.closest<HTMLImageElement>('img');
    if (clickedImage && !clickedImage.closest('.katex')) {
      event.preventDefault();
      event.stopPropagation();
      const src =
        clickedImage.currentSrc ||
        clickedImage.getAttribute('src')?.trim() ||
        '';
      if (src) {
        openImagePreview(
          src,
          clickedImage.getAttribute('alt')?.trim() || '图片预览',
          rawHref && /^https?:\/\//i.test(rawHref) ? rawHref : undefined,
        );
      }
      return;
    }

    if (anchor && rawHref) {
      event.preventDefault();
      const action = classifyPreviewLinkHref(rawHref);
      if (action.kind === 'hash') {
        if (action.id && rootRef.current) {
          const escapedId = CSS.escape(action.id);
          const targetEl =
            rootRef.current.querySelector(`#${escapedId}`) ??
            rootRef.current.querySelector(`[name="${escapedId}"]`);
          if (targetEl) scrollAndFlashElement(targetEl);
        }
        return;
      }
      if (action.kind === 'image') {
        openImagePreview(
          action.url,
          anchor.textContent?.trim() || '图片预览',
          action.url,
        );
        return;
      }
      if (action.kind === 'external') {
        window.open(action.url, '_blank', 'noopener,noreferrer');
      }
    }
  };

  const jumpToActiveFootnoteDef = () => {
    if (!activeFootnote?.id || !rootRef.current) return;
    const defEl = rootRef.current.querySelector(
      `[data-footnote-def-id="${CSS.escape(activeFootnote.id)}"]`,
    );
    closeActiveFootnote();
    scrollAndFlashElement(defEl);
  };

  const lightboxNode =
    activeImage && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="seamind-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`图片预览：${activeImage.alt}`}
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                closeImagePreview();
              }
            }}
          >
            <div className="seamind-image-lightbox-toolbar">
              <span
                className="seamind-image-lightbox-title"
                title={activeImage.alt}
              >
                {activeImage.alt}
              </span>
              <div className="seamind-image-lightbox-controls">
                <button
                  type="button"
                  onClick={() => stepImageZoom(-0.25)}
                  aria-label="缩小图片"
                  title="缩小 (-)"
                >
                  −
                </button>
                <button
                  type="button"
                  className="seamind-image-lightbox-zoom-reset"
                  onClick={resetImageZoom}
                  title="恢复适应窗口 (0)"
                >
                  {Math.round(imageZoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => stepImageZoom(0.25)}
                  aria-label="放大图片"
                  title="放大 (+)"
                >
                  +
                </button>
                {activeImage.externalHref &&
                  !isPreviewImageHref(activeImage.externalHref) && (
                    <button
                      type="button"
                      onClick={() =>
                        window.open(
                          activeImage.externalHref,
                          '_blank',
                          'noopener,noreferrer',
                        )
                      }
                      title="在新窗口打开来源网页"
                    >
                      来源链接
                    </button>
                  )}
                <button
                  type="button"
                  className="seamind-image-lightbox-exit"
                  onClick={closeImagePreview}
                  aria-label="退出图片预览"
                  title="退出预览 (Esc)"
                  autoFocus
                >
                  × 退出预览
                </button>
              </div>
            </div>
            <div
              className="seamind-image-lightbox-stage"
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  closeImagePreview();
                }
              }}
            >
              <img
                ref={lightboxImageRef}
                className={`seamind-image-lightbox-img${imageZoom !== 1 ? ' is-zoomed' : ''}`}
                src={activeImage.src}
                alt={activeImage.alt}
                onWheel={(event) => {
                  if (event.ctrlKey || event.metaKey) {
                    event.preventDefault();
                    stepImageZoom(event.deltaY < 0 ? 0.25 : -0.25);
                  }
                }}
                onDoubleClick={() => {
                  if (imageZoom === 1) stepImageZoom(0.5);
                  else resetImageZoom();
                }}
                style={
                  imageZoom !== 1 && fittedWidth
                    ? {
                        width: `${Math.round(fittedWidth * imageZoom)}px`,
                        height: 'auto',
                        maxWidth: 'none',
                        maxHeight: 'none',
                      }
                    : undefined
                }
              />
            </div>
          </div>,
          (rootRef.current?.closest('.app-shell') as HTMLElement | null) ??
            document.body,
        )
      : null;

  return (
    <div
      ref={frameRef}
      className={`markdown-preview-frame${hideMinimap ? ' is-minimap-hidden' : ''}`}
      onMouseLeave={() => {
        if (!activeFootnote?.pinned) {
          scheduleHoverClose();
        }
      }}
    >
      <article
        ref={rootRef}
        className="markdown-rendered-preview"
        aria-label="Markdown 渲染视图"
        onMouseOver={handleMouseOver}
        onClick={handleClick}
        dangerouslySetInnerHTML={markup}
      />
      {activeFootnote && (
        <aside
          className={`seamind-fn-hover-card${activeFootnote.pinned ? ' is-pinned' : ''}`}
          style={{
            left: activeFootnote.left,
            width: activeFootnote.width,
            ...(activeFootnote.top !== undefined
              ? { top: activeFootnote.top }
              : { bottom: activeFootnote.bottom }),
            maxHeight: activeFootnote.maxHeight,
          }}
          role="dialog"
          aria-label={`脚注 ${activeFootnote.index || '?'}`}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={() => {
            if (!activeFootnote.pinned) {
              scheduleHoverClose();
            }
          }}
          onMouseDown={() => {
            cancelHoverClose();
            setActiveFootnote((prev) =>
              prev && !prev.pinned ? { ...prev, pinned: true } : prev,
            );
          }}
        >
          <div className="seamind-fn-hover-head">
            <span className="seamind-fn-hover-title">
              脚注 [{activeFootnote.index || '?'}]
            </span>
            <div className="seamind-fn-hover-actions">
              {activeFootnote.id && onEditFootnote && (
                <button
                  type="button"
                  className="seamind-fn-hover-action"
                  onClick={() => {
                    const targetId = activeFootnote.id;
                    closeActiveFootnote();
                    onEditFootnote(targetId);
                  }}
                  title="在独立编辑框中修改此脚注内容"
                >
                  编辑
                </button>
              )}
              {activeFootnote.id && (
                <button
                  type="button"
                  className="seamind-fn-hover-action"
                  onClick={jumpToActiveFootnoteDef}
                  title="跳转到文末脚注定义"
                >
                  跳至文末
                </button>
              )}
              <button
                type="button"
                className="seamind-fn-hover-close"
                onClick={closeActiveFootnote}
                aria-label="关闭脚注"
                title="关闭"
              >
                ×
              </button>
            </div>
          </div>
          <div className="seamind-fn-hover-scroll" onClick={handleClick}>
            {activeFootnote.bodyHtml ? (
              <div
                className="seamind-fn-hover-body seamind-fn-body"
                dangerouslySetInnerHTML={{ __html: activeFootnote.bodyHtml }}
              />
            ) : (
              <p className="seamind-fn-hover-body seamind-fn-hover-body-text">
                {activeFootnote.fallbackText}
              </p>
            )}
          </div>
        </aside>
      )}
      {!hideMinimap && (
        <div ref={minimapHostRef} className="markdown-preview-minimap-host" />
      )}
      {lightboxNode}
    </div>
  );
}
