import { useState, type UIEvent } from 'react';

/** Fixed-height windowing: renders rows [start, end) inside a `total`-px tall scroller. No dependency needed for one row height. */
export function useVirtual(count: number, rowH: number, viewport: number, overscan = 6) {
  const [top, setTop] = useState(0);
  const start = Math.max(0, Math.floor(top / rowH) - overscan);
  const end = Math.min(count, Math.ceil((top + viewport) / rowH) + overscan);
  return { start, end, total: count * rowH, onScroll: (e: UIEvent<HTMLElement>) => setTop(e.currentTarget.scrollTop) };
}
