import { useLayoutEffect, useRef, useState } from 'react';

export interface MarqueeTextProps {
  text: string;
  className?: string;
}

/**
 * 文本正常情况下省略截断；当内容实际超出容器宽度时标记 `is-overflowing`，
 * 配合 CSS 在鼠标悬停或键盘聚焦时在框内平滑滚动播放完整标题。
 */
export default function MarqueeText({
  text,
  className = '',
}: MarqueeTextProps) {
  const outerRef = useRef<HTMLSpanElement | null>(null);
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const [overflowPx, setOverflowPx] = useState(0);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      const shift = Math.ceil(inner.scrollWidth - outer.clientWidth);
      setOverflowPx(shift > 2 ? shift : 0);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [text]);

  const durationSecs =
    overflowPx > 0
      ? Math.max(3.2, overflowPx / 34 + 1.8).toFixed(2)
      : undefined;

  return (
    <span
      ref={outerRef}
      className={`player-marquee${overflowPx > 0 ? ' is-overflowing' : ''}${className ? ` ${className}` : ''}`}
      title={text}
      style={
        overflowPx > 0
          ? ({
              '--marquee-shift': `-${overflowPx}px`,
              '--marquee-duration': `${durationSecs}s`,
            } as React.CSSProperties)
          : undefined
      }
    >
      <span ref={innerRef} className="player-marquee-track">
        {text}
      </span>
    </span>
  );
}
