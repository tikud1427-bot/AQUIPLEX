import { beliefBasis, evidenceCountText } from '@/lib/displayGuard';
import { cn } from '@/lib/utils';

/**
 * Where a belief came from — "You said this" / "Inferred" — and how many
 * observations it rests on. Replaces the percentage badge (2026-10-28): belief
 * confidence is not calibrated, so the page states provenance instead of a
 * number. A stated fact and an inference look different on purpose.
 */
export function ProvenanceBadge({
  source,
  evidenceCount,
  className,
}: {
  source?: string;
  evidenceCount?: number;
  className?: string;
}) {
  const basis = beliefBasis({ source });
  const seen = evidenceCountText(evidenceCount);
  if (!basis && !seen) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-micro',
        basis?.stated
          ? 'border-primary/30 bg-primary/5 text-primary'
          : 'border-border bg-surface-secondary text-foreground-secondary',
        className,
      )}
    >
      {basis?.label}
      {basis && seen && <span aria-hidden>·</span>}
      {seen && <span className="tabular-nums">{seen}</span>}
    </span>
  );
}
