import { useEffect, useRef } from 'react';
import { hydrateCodeBlocks } from './code-blocks';
import { createMarkdownPreviewMinimap } from './markdown-minimap';

interface MarkdownPreviewProps {
  html: string;
  source: string;
  theme: 'light' | 'dark';
}

export default function MarkdownPreview({
  html,
  source,
  theme,
}: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLElement>(null);
  const minimapHostRef = useRef<HTMLDivElement>(null);

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
      {},
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
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div ref={minimapHostRef} className="markdown-preview-minimap-host" />
    </div>
  );
}
