import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

/* Shared primitives for the Mind dashboard. Instrument register:
   small-caps eyebrows, tabular numerals, quiet color. */

export function SectionHeader({ eyebrow, title, aside }: { eyebrow: string; title: string; aside?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-foreground-secondary">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      </div>
      {aside}
    </div>
  );
}

export function timeAgo(ts?: number | null): string {
  if (!ts) return '';
  const m = (Date.now() - ts) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function confidenceTone(c: number) {
  if (c >= 0.75) return 'text-success';
  if (c >= 0.5) return 'text-foreground';
  return 'text-foreground-secondary';
}

export function ConfidenceBadge({ value, className }: { value: number; className?: string }) {
  return (
    <span
      className={cn(
        'rounded-full border border-border bg-surface-secondary px-2 py-0.5 font-mono text-[11px] tabular-nums',
        confidenceTone(value),
        className,
      )}
    >
      {Math.round(value * 100)}%
    </span>
  );
}

/** Animated integer count-up. Respects reduced motion. */
export function CountUp({ value, duration = 900, className }: { value: number; duration?: number; className?: string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const fromRef = useRef(0);

  useEffect(() => {
    if (reduce) { setShown(value); return; }
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(from + (value - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduce]);

  return <span className={cn('tabular-nums', className)}>{shown}</span>;
}

/** Staleness → opacity: fresh 1.0, fades toward 0.35 over maxAgeMs. */
export function staleOpacity(lastSeenAt: number, maxAgeMs = 5 * 24 * 3600 * 1000): number {
  const age = Date.now() - lastSeenAt;
  const p = Math.min(1, Math.max(0, age / maxAgeMs));
  return 1 - p * 0.65;
}

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)]', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
