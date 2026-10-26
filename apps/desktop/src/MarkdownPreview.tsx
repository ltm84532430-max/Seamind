import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { hydrateCodeBlocks } from './code-blocks';
import type { CodeBlockHandlers } from './code-blocks';
import { createMarkdownPreviewMinimap } from './markdown-minimap';

interface MarkdownPreviewProps {
  html: string;
  source: string;
  theme: 'light' | 'dark';
  hideMinimap?: boolean;
  onCodeChange?: CodeBlockHandlers['onCodeChange'];
  onOpenPlantUmlEditor?: CodeBlockHandlers['onOpenPlantUmlEditor'];
  onOpenWikilink?: (target: string) => void;
}

export default function MarkdownPreview({
  html,
  source,
  theme,
  hideMinimap = false,
  onCodeChange,
  onOpenPlantUmlEditor,
  onOpenWikilink,
}: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLElement>(null);
  const minimapHostRef = useRef<HTMLDivElement>(null);
  // React sets the markup again whenever it gets a new object, even for the same string, and that
  // would wipe the diagrams the effect below has put into the page.
  const markup = useMemo(() => ({ __html: html }), [html]);

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
      { onCodeChange, onOpenPlantUmlEditor },
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
  }, [html, source, theme, hideMinimap, onCodeChange, onOpenPlantUmlEditor]);

  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!onOpenWikilink) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const wikilink = target.closest('[data-wikilink]');
    if (!wikilink) return;
    event.preventDefault();
    const noteTarget = wikilink.getAttribute('data-wikilink')?.trim();
    if (noteTarget) {
      onOpenWikilink(noteTarget);
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
