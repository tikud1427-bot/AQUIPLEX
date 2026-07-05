import { motion, useReducedMotion } from 'framer-motion';
import { Lock } from 'lucide-react';
import type { CompactBelief } from '@/api/mind';
import { Card, ConfidenceBadge, timeAgo } from './primitives';

const IDENTITY_BLURB: Record<string, string> = {
  founder: 'Talks about the company, users and fundraising like an owner.',
  engineer: 'Lives in code, debugging and implementation detail.',
  systems_thinker: 'Reaches for architecture and module boundaries first.',
  builder: 'Ships things — workspaces, prototypes, releases.',
  long_term_planner: 'Plans in roadmaps and milestones, not just next steps.',
  researcher: 'Digs for evidence before deciding.',
  creative: 'Explores ideas laterally before converging.',
  minimalist: 'Consistently strips things back to the essential.',
  profession: 'Stated role, confirmed by how they actually work.',
  organization: 'The company at the center of their work.',
};

export function beliefTitle(b: CompactBelief): string {
  const base = b.key.replace('tech:', '').replace(/_/g, ' ');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function beliefValueText(b: CompactBelief): string | null {
  if (b.value === true || b.value === 'true') return null;
  if (b.value == null) return null;
  return typeof b.value === 'object' ? JSON.stringify(b.value) : String(b.value);
}

export function BeliefCard({ belief, onSelect }: { belief: CompactBelief; onSelect: (b: CompactBelief) => void }) {
  const reduce = useReducedMotion();
  const value = beliefValueText(belief);
  const blurb = IDENTITY_BLURB[belief.key] ?? `Inferred from ${belief.evidenceCount} observation${belief.evidenceCount === 1 ? '' : 's'}.`;

  return (
    <motion.button
      layout={!reduce}
      onClick={() => onSelect(belief)}
      className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded-xl"
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      aria-label={`${beliefTitle(belief)} — ${Math.round(belief.confidence * 100)} percent confidence. See why.`}
    >
      <Card className="h-full transition-colors hover:border-primary/40">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">
            {beliefTitle(belief)}
            {belief.locked && <Lock className="ml-1.5 inline h-3 w-3 text-foreground-secondary" aria-label="Pinned" />}
          </div>
          {/* Key micro-moment: confidence animates when it changes */}
          <motion.div
            key={Math.round(belief.confidence * 100)}
            initial={reduce ? false : { scale: 1.25, opacity: 0.4 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          >
            <ConfidenceBadge value={belief.confidence} />
          </motion.div>
        </div>
        {value && <div className="mt-1 truncate text-sm text-foreground-secondary">{value}</div>}
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-foreground-secondary">{blurb}</p>
        <div className="mt-3 text-[11px] text-foreground-secondary/80">Updated {timeAgo(belief.updatedAt)}</div>
      </Card>
    </motion.button>
  );
}

export function IdentitySection({ beliefs, onSelect }: { beliefs: CompactBelief[]; onSelect: (b: CompactBelief) => void }) {
  const visible = beliefs.filter((b) => b.status !== 'archived').slice(0, 8);
  if (!visible.length) {
    return <p className="text-sm text-foreground-secondary">Identity forms as you talk — nothing inferred yet.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {visible.map((b) => <BeliefCard key={b.key} belief={b} onSelect={onSelect} />)}
    </div>
  );
}
