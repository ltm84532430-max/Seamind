import { useEffect, useRef } from 'react';
import { hydrateCodeBlocks } from './code-blocks';

interface MarkdownPreviewProps {
  html: string;
  theme: 'light' | 'dark';
}

export default function MarkdownPreview({ html, theme }: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const controller = new AbortController();
    let disposed = false;
    let cleanup = () => {};
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
    };
  }, [html, theme]);

  return (
    <article
      ref={rootRef}
      className="markdown-rendered-preview"
      aria-label="Markdown 渲染视图"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
