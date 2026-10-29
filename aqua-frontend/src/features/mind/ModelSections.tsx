import { motion, useReducedMotion } from 'framer-motion';
import type { CompactBelief } from '@/api/mind';
import { ProvenanceBadge } from '@/components/ui/provenance-badge';
import { Panel } from '@/components/ui/panel';
import { SectionHeader } from '@/components/ui/section-header';
import { beliefTitle, visibleBeliefs } from './IdentitySection';

/* ── Knowledge — growing proficiency bars ───────────────────────────────── */

/** Below this many real observations the panel is noise, not knowledge — hidden. */
export const KNOWLEDGE_MIN_ROWS = 3;

export function knowledgeRows(beliefs: CompactBelief[]): CompactBelief[] {
  // Ordered by what the bars draw — observations — not by uncalibrated confidence.
  return visibleBeliefs(beliefs)
    .sort((a, b) => b.evidenceCount - a.evidenceCount || b.updatedAt - a.updatedAt)
    .slice(0, 8);
}

/** The Knowledge panel with its header — absent below KNOWLEDGE_MIN_ROWS real observations. */
export function KnowledgePanel({ beliefs, onSelect }: { beliefs: CompactBelief[]; onSelect: (b: CompactBelief) => void }) {
  if (knowledgeRows(beliefs).length < KNOWLEDGE_MIN_ROWS) return null;
  return (
    <section data-testid="knowledge-panel">
      <SectionHeader eyebrow="What you know" title="Knowledge" />
      <KnowledgeSection beliefs={beliefs} onSelect={onSelect} />
    </section>
  );
}

export function KnowledgeSection({ beliefs, onSelect }: { beliefs: CompactBelief[]; onSelect: (b: CompactBelief) => void }) {
  const reduce = useReducedMotion();
  const rows = knowledgeRows(beliefs);
  // Bars compare evidence between rows. Belief confidence is not calibrated,
  // so it is not printed or drawn as a percentage.
  const maxEvidence = Math.max(1, ...rows.map((b) => b.evidenceCount));

  if (!rows.length) {
    return <p className="text-sm text-foreground-secondary">Skills register here as they show up in real work.</p>;
  }

  return (
    <Panel className="p-5">
      <div className="space-y-3.5">
        {rows.map((b, i) => (
          <button
            key={b.key}
            onClick={() => onSelect(b)}
            className="group block w-full rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            aria-label={`${beliefTitle(b)} — seen ${b.evidenceCount} time${b.evidenceCount === 1 ? '' : 's'}. See why.`}
          >
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="text-sm text-foreground group-hover:text-primary">{beliefTitle(b)}</span>
              <span className="font-mono text-micro tabular-nums text-foreground-secondary">
                seen {b.evidenceCount}×
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-secondary">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${Math.round((b.evidenceCount / maxEvidence) * 100)}%` }}
                transition={{ duration: reduce ? 0 : 0.8, delay: reduce ? 0 : i * 0.05, ease: [0.16, 1, 0.3, 1] }}
              />
            </div>
          </button>
        ))}
      </div>
    </Panel>
  );
}

/* ── Communication style — inferred position sliders (read-only) ────────── */

interface Axis { left: string; right: string; label: string; position: number | null; belief?: CompactBelief }

function axisFrom(beliefs: CompactBelief[], key: string, map: Record<string, number>, left: string, right: string, label: string): Axis {
  const b = beliefs.find((x) => x.key === key && x.status !== 'archived');
  // A value the axis has no position for is not drawn at the midpoint as if known.
  const pos = b ? map[String(b.value)] : undefined;
  if (!b || pos === undefined) return { left, right, label, position: null };
  return { left, right, label, position: pos, belief: b };
}

export function CommunicationSection({ beliefs, decision, onSelect }: {
  beliefs: CompactBelief[]; decision: CompactBelief[]; onSelect: (b: CompactBelief) => void;
}) {
  const reduce = useReducedMotion();
  const axes: Axis[] = [
    axisFrom(beliefs, 'response_length', { brief: 0.12, detailed: 0.88 }, 'Concise', 'In depth', 'Preferred response length'),
    axisFrom(beliefs, 'message_style',   { terse: 0.15, detailed: 0.85 }, 'Terse', 'Expansive', 'How they write'),
    axisFrom(decision, 'risk_tolerance', { cautious: 0.15, bold: 0.85 }, 'Careful', 'Bold', 'Decision style'),
  ].filter((a) => a.position !== null);

  if (!axes.length) {
    return <p className="text-sm text-foreground-secondary">Aqua calibrates tone and depth as it learns how you like answers.</p>;
  }

  return (
    <Panel className="space-y-5 p-5">
      {axes.map((a) => (
        <button
          key={a.label}
          onClick={() => a.belief && onSelect(a.belief)}
          className="block w-full rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-sm text-foreground">{a.label}</span>
            {/* What the slider's position rests on — stated or inferred, and how
                often seen. Not a percentage beside a slider. */}
            <ProvenanceBadge source={a.belief?.source} evidenceCount={a.belief?.evidenceCount} />
          </div>
          <div className="relative h-1.5 rounded-full bg-surface-secondary">
            <motion.span
              className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow"
              initial={reduce ? false : { left: '50%' }}
              animate={{ left: `${(a.position ?? 0.5) * 100}%` }}
              style={{ x: '-50%' }}
              transition={{ type: 'spring', stiffness: 220, damping: 24 }}
            />
          </div>
          <div className="mt-1 flex justify-between text-micro text-foreground-secondary">
            <span>{a.left}</span><span>{a.right}</span>
          </div>
        </button>
      ))}
    </Panel>
  );
}
