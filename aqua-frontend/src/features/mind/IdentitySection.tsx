import { motion, useReducedMotion } from 'framer-motion';
import { Lock } from 'lucide-react';
import type { CompactBelief } from '@/api/mind';
import { ProvenanceBadge } from '@/components/ui/provenance-badge';
import { Panel } from '@/components/ui/panel';
import { timeAgo } from '@/lib/format';
import { beliefBasis, isDisplayableBelief, isInternalText, stripInternalPrefix } from '@/lib/displayGuard';

/* The line under each card used to be a fixed sentence per key —
   "Profession: Stated role, confirmed by how they actually work." shown under
   a goal that had leaked into the profession slot, confirmed by nothing. It is
   now the server's account of the belief's real evidence, or nothing.
   The corner badge used to be a confidence percentage; it now says whether the
   person stated this or Aqua inferred it (lib/displayGuard.ts beliefBasis). */

export function beliefTitle(b: CompactBelief): string {
  return b.label && !isInternalText(b.label) ? b.label : stripInternalPrefix(b.key);
}

/** Beliefs a person may see (the server already filters; this is the guard). */
export function visibleBeliefs(beliefs: CompactBelief[]): CompactBelief[] {
  return beliefs.filter(isDisplayableBelief);
}

export function beliefValueText(b: CompactBelief): string | null {
  if (b.value === true || b.value === 'true') return null;
  if (b.value == null) return null;
  return typeof b.value === 'object' ? JSON.stringify(b.value) : String(b.value);
}

export function BeliefCard({ belief, onSelect }: { belief: CompactBelief; onSelect: (b: CompactBelief) => void }) {
  const reduce = useReducedMotion();
  const value = beliefValueText(belief);
  const blurb = belief.evidenceText ?? null;
  const basis = beliefBasis(belief);

  return (
    <motion.button
      layout={!reduce}
      onClick={() => onSelect(belief)}
      className="rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      aria-label={`${beliefTitle(belief)}${basis ? ` — ${basis.label.toLowerCase()}` : ''}. See why.`}
    >
      <Panel className="h-full transition-colors hover:border-primary/40">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
            {beliefTitle(belief)}
            {belief.locked && <Lock className="ml-1.5 inline h-3 w-3 text-foreground-secondary" aria-label="Pinned" />}
          </div>
          <ProvenanceBadge source={belief.source} />
        </div>
        {value && <div className="mt-1 line-clamp-2 text-sm text-foreground-secondary [overflow-wrap:anywhere]">{value}</div>}
        {blurb && <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-foreground-secondary">{blurb}</p>}
        <div className="mt-3 text-micro text-foreground-secondary/80">Updated {timeAgo(belief.updatedAt)}</div>
      </Panel>
    </motion.button>
  );
}

export function IdentitySection({ beliefs, onSelect }: { beliefs: CompactBelief[]; onSelect: (b: CompactBelief) => void }) {
  const visible = visibleBeliefs(beliefs).slice(0, 8);
  if (!visible.length) {
    return <p className="text-sm text-foreground-secondary">Identity forms as you talk — nothing inferred yet.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {visible.map((b) => <BeliefCard key={b.key} belief={b} onSelect={onSelect} />)}
    </div>
  );
}
