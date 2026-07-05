import { motion, useReducedMotion } from 'framer-motion';
import type { CompactBelief } from '@/api/mind';
import { Card, ConfidenceBadge } from './primitives';
import { beliefTitle } from './IdentitySection';

/* ── Knowledge — growing proficiency bars ───────────────────────────────── */

export function KnowledgeSection({ beliefs, onSelect }: { beliefs: CompactBelief[]; onSelect: (b: CompactBelief) => void }) {
  const reduce = useReducedMotion();
  const rows = beliefs
    .filter((b) => b.status !== 'archived')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);

  if (!rows.length) {
    return <p className="text-sm text-foreground-secondary">Skills register here as they show up in real work.</p>;
  }

  return (
    <Card className="p-5">
      <div className="space-y-3.5">
        {rows.map((b, i) => (
          <button
            key={b.key}
            onClick={() => onSelect(b)}
            className="group block w-full rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            aria-label={`${beliefTitle(b)} — ${Math.round(b.confidence * 100)} percent. See why.`}
          >
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="text-sm text-foreground group-hover:text-primary">{beliefTitle(b)}</span>
              <span className="font-mono text-[11px] tabular-nums text-foreground-secondary">
                {Math.round(b.confidence * 100)}% · {b.evidenceCount} obs
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-secondary">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${Math.round(b.confidence * 100)}%` }}
                transition={{ duration: reduce ? 0 : 0.8, delay: reduce ? 0 : i * 0.05, ease: [0.16, 1, 0.3, 1] }}
              />
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

/* ── Communication style — inferred position sliders (read-only) ────────── */

interface Axis { left: string; right: string; label: string; position: number | null; confidence: number; belief?: CompactBelief }

function axisFrom(beliefs: CompactBelief[], key: string, map: Record<string, number>, left: string, right: string, label: string): Axis {
  const b = beliefs.find((x) => x.key === key && x.status !== 'archived');
  if (!b) return { left, right, label, position: null, confidence: 0 };
  const pos = map[String(b.value)] ?? 0.5;
  return { left, right, label, position: pos, confidence: b.confidence, belief: b };
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
    <Card className="space-y-5 p-5">
      {axes.map((a) => (
        <button
          key={a.label}
          onClick={() => a.belief && onSelect(a.belief)}
          className="block w-full rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm text-foreground">{a.label}</span>
            <ConfidenceBadge value={a.confidence} />
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
          <div className="mt-1 flex justify-between text-[11px] text-foreground-secondary">
            <span>{a.left}</span><span>{a.right}</span>
          </div>
        </button>
      ))}
    </Card>
  );
}
