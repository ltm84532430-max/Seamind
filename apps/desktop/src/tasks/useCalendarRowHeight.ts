import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

/** Measure single-row pixel height of a calendar grid element so cells can fill available vertical space. */
export function useCalendarRowHeight(
  gridRef: RefObject<HTMLElement | null>,
  rowCount: number,
  enabled: boolean,
): number | null {
  const [rowHeight, setRowHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setRowHeight(null);
      return;
    }
    const element = gridRef.current;
    if (!element) return;

    const measure = () => {
      const height = element.clientHeight;
      if (height <= 0 || rowCount <= 0) return;
      const next = (height - Math.max(0, rowCount - 1)) / rowCount;
      setRowHeight((prev) =>
        prev != null && Math.abs(prev - next) < 1 ? prev : next,
      );
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [gridRef, rowCount, enabled]);

  return rowHeight;
}
