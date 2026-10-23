import { useEffect, useState } from 'react';

/**
 * True once `active` has been true for `delayMs`: for telling the user that a lookup is slow and
 * still being tried, instead of leaving a spinner with no word on it.
 */
export function useSlowHint(active: boolean, delayMs = 8000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setSlow(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return slow;
}

export const SLOW_LOOKUP_TEXT = '连接 YouTube 比较慢，正在重试，请稍候…';
