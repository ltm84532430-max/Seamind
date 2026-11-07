import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { createElementScrollMinimap } from '../workbench/markdown-minimap';
import './exam-scroll-minimap.css';

interface Props {
  scrollRef: RefObject<HTMLElement | null>;
  label: string;
}

export function ExamScrollMinimap({ scrollRef, label }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const host = hostRef.current;
    if (!scrollElement || !host) return;
    const minimap = createElementScrollMinimap(scrollElement, host);
    const scrollbar = host.querySelector('[role="scrollbar"]');
    scrollbar?.setAttribute('aria-label', label);
    return () => minimap.destroy();
  }, [label, scrollRef]);

  return <div ref={hostRef} className="exam-scroll-minimap-host" />;
}
