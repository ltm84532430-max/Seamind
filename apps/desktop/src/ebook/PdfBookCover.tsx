import { useEffect, useRef, useState } from 'react';
import type { PdfBookDocument } from '../library/library';
import { loadPdfBookCover } from './pdf-book-cover';

export default function PdfBookCover({
  rootPath,
  book,
  colorIndex,
}: {
  rootPath: string;
  book: PdfBookDocument;
  colorIndex: number;
}) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [cover, setCover] = useState('');

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let cancelled = false;
    let requested = false;
    setCover('');
    const load = () => {
      if (requested) return;
      requested = true;
      void loadPdfBookCover(rootPath, book).then((dataUrl) => {
        if (!cancelled && dataUrl) setCover(dataUrl);
      });
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [rootPath, book.relativePath, book.fileSize, book.updatedAt]);

  return (
    <span
      ref={elementRef}
      className={`ebook-book-cover ebook-pdf-book-cover cover-${colorIndex % 6}`}
      aria-hidden="true"
    >
      {cover ? (
        <img src={cover} alt="" />
      ) : (
        <>
          <span className="ebook-book-cover-rule" />
          <strong>{book.title}</strong>
          <small>PDF</small>
        </>
      )}
    </span>
  );
}
