import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { hydrateCodeBlocks } from './code-blocks';
import type { CodeBlockHandlers } from './code-blocks';
import { createMarkdownPreviewMinimap } from './markdown-minimap';
import { parseYouTubeEmbedInput } from '../player/youtube';
import { resolveDocumentMedia } from '../knowledge/document-media';
import { mediaIdFromSource } from '../knowledge/knowledge-paste';
import type { Theme } from '../app/app-storage';

interface MarkdownPreviewProps {
  html: string;
  source: string;
  theme: Theme;
  hideMinimap?: boolean;
  mediaDocumentPath?: string;
  onCodeChange?: CodeBlockHandlers['onCodeChange'];
  onOpenPlantUmlEditor?: CodeBlockHandlers['onOpenPlantUmlEditor'];
  onOpenWikilink?: (target: string) => void;
  onOpenYouTubeLink?: (videoId: string, startSeconds: number) => void;
  onRunInTerminal?: CodeBlockHandlers['onRunInTerminal'];
}

export default function MarkdownPreview({
  html,
  source,
  theme,
  hideMinimap = false,
  mediaDocumentPath,
  onCodeChange,
  onOpenPlantUmlEditor,
  onOpenWikilink,
  onOpenYouTubeLink,
  onRunInTerminal,
}: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLElement>(null);
  const minimapHostRef = useRef<HTMLDivElement>(null);
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
      { onCodeChange, onOpenPlantUmlEditor, onRunInTerminal },
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
  }, [
    html,
    source,
    theme,
    hideMinimap,
    onCodeChange,
    onOpenPlantUmlEditor,
    onRunInTerminal,
  ]);

  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
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
    if (onOpenYouTubeLink) {
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      const rawHref = anchor?.getAttribute('href')?.trim();
      if (rawHref) {
        const youtube = parseYouTubeEmbedInput(rawHref);
        if (youtube) {
          event.preventDefault();
          onOpenYouTubeLink(youtube.id, youtube.startSeconds);
        }
      }
    }
  };

  return (
    <div
      className={`markdown-preview-frame${hideMinimap ? ' is-minimap-hidden' : ''}`}
    >
      <article
        ref={rootRef}
        className="markdown-rendered-preview"
        aria-label="Markdown 渲染视图"
        onClick={handleClick}
        dangerouslySetInnerHTML={markup}
      />
      {!hideMinimap && (
        <div ref={minimapHostRef} className="markdown-preview-minimap-host" />
      )}
    </div>
  );
}
