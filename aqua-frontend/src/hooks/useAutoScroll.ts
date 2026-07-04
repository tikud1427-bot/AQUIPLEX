import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Keeps a scroll container pinned to the bottom while new content streams
 * in, but stops auto-scrolling the moment the user scrolls up to read
 * earlier messages — and resumes once they scroll back to the bottom.
 *
 * Streaming-tuned:
 *  - Scroll writes are rAF-coalesced: token bursts trigger at most one
 *    scrollTop mutation per frame instead of one per delta.
 *  - Pinned follow uses instant positioning (scrollTop assignment), never
 *    `behavior:'smooth'` — queued smooth scrolls fight each other during a
 *    fast stream and produce the classic rubber-band jitter.
 *  - Pinned-state reads are also rAF-throttled so the scroll listener
 *    can't become a re-render firehose.
 */
export function useAutoScroll<T extends HTMLElement>(deps: unknown[]) {
  const containerRef = useRef<T | null>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  const scrollRaf = useRef<number | null>(null);
  const readRaf = useRef<number | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = containerRef.current;
    if (!el) return;
    if (behavior === 'smooth') {
      el.scrollTo({ top: el.scrollHeight, behavior });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    pinnedRef.current = true;
    setPinned(true);
  }, []);

  const handleScroll = useCallback(() => {
    if (readRaf.current !== null) return;
    readRaf.current = requestAnimationFrame(() => {
      readRaf.current = null;
      const el = containerRef.current;
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nowPinned = distanceFromBottom < 80;
      if (nowPinned !== pinnedRef.current) {
        pinnedRef.current = nowPinned;
        setPinned(nowPinned);
      }
    });
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    if (scrollRaf.current !== null) return; // already following this frame
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = null;
      const el = containerRef.current;
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(
    () => () => {
      if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
      if (readRaf.current !== null) cancelAnimationFrame(readRaf.current);
    },
    [],
  );

  return { containerRef, pinned, scrollToBottom, handleScroll };
}
