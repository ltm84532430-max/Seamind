import { useEffect, useMemo, useRef } from 'react';
import { hydrateCodeBlocks } from './code-blocks';
import type { CodeBlockHandlers } from './code-blocks';
import { createMarkdownPreviewMinimap } from './markdown-minimap';

interface MarkdownPreviewProps {
  html: string;
  source: string;
  theme: 'light' | 'dark';
  onCodeChange?: CodeBlockHandlers['onCodeChange'];
  onOpenPlantUmlEditor?: CodeBlockHandlers['onOpenPlantUmlEditor'];
}

export default function MarkdownPreview({
  html,
  source,
  theme,
  onCodeChange,
  onOpenPlantUmlEditor,
}: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLElement>(null);
  const minimapHostRef = useRef<HTMLDivElement>(null);
  // React sets the markup again whenever it gets a new object, even for the same string, and that
  // would wipe the diagrams the effect below has put into the page.
  const markup = useMemo(() => ({ __html: html }), [html]);

  useEffect(() => {
    const root = rootRef.current;
    const minimapHost = minimapHostRef.current;
    if (!root || !minimapHost) return;
    const controller = new AbortController();
    let disposed = false;
    let cleanup = () => {};
    const minimap = createMarkdownPreviewMinimap(source, root, minimapHost);
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
      minimap.destroy();
    };
  }, [html, source, theme]);

  return (
    <div className="markdown-preview-frame">
      <article
        ref={rootRef}
        className="markdown-rendered-preview"
        aria-label="Markdown 渲染视图"
        dangerouslySetInnerHTML={markup}
      />
      <div ref={minimapHostRef} className="markdown-preview-minimap-host" />
    </div>
  );
}
