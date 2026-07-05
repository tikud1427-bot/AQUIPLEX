import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { MindModel, Dimension } from '@/api/mind';
import { DIMENSIONS, dimensionConfidence, understandingScore } from '@/stores/mindStore';
import { CountUp } from './primitives';

/* ────────────────────────────────────────────────────────────────────────
   The signature element: an evidence ring.

   Not a stock donut. Seven arcs — one per cognitive dimension — assemble
   the circle. Arc length = share of beliefs in that dimension; arc opacity
   = average confidence there. As AQUA learns, segments appear and deepen:
   the viewer literally watches understanding assemble. A slow breathing
   scale keeps it alive without noise.
   ──────────────────────────────────────────────────────────────────────── */

const DIM_LABEL: Record<Dimension, string> = {
  identity: 'Identity', personality: 'Personality', communication: 'Communication',
  preferences: 'Preferences', knowledge: 'Knowledge', behavior: 'Behavior', decision: 'Decision',
};

const R = 118;
const STROKE = 10;
const C = 2 * Math.PI * R;
const GAP = 0.018; // arc gap as fraction of circumference

export function UnderstandingRing({ model }: { model: MindModel }) {
  const reduce = useReducedMotion();
  const score = understandingScore(model);

  const segments = useMemo(() => {
    const dims = DIMENSIONS.map((d) => ({ d, ...dimensionConfidence(model, d) }))
      .filter((x) => x.count > 0);
    const total = dims.reduce((s, x) => s + x.count, 0) || 1;
    let offset = 0;
    return dims.map((x) => {
      const frac = Math.max(0.04, x.count / total) ; // every present dimension visible
      const seg = { d: x.d, avg: x.avg, count: x.count, start: offset, frac };
      offset += frac;
      return seg;
    });
  }, [model]);

  const norm = segments.reduce((s, x) => s + x.frac, 0) || 1;

  return (
    <div className="flex flex-col items-center gap-8 md:flex-row md:gap-12">
      <motion.div
        className="relative"
        animate={reduce ? undefined : { scale: [1, 1.012, 1] }}
        transition={reduce ? undefined : { duration: 6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <svg width={2 * (R + STROKE)} height={2 * (R + STROKE)} viewBox={`0 0 ${2 * (R + STROKE)} ${2 * (R + STROKE)}`} role="img"
             aria-label={`Overall understanding ${score} percent`}>
          <g transform={`translate(${R + STROKE}, ${R + STROKE}) rotate(-90)`}>
            {/* Track */}
            <circle r={R} fill="none" stroke="var(--border)" strokeWidth={STROKE} opacity={0.5} />
            {/* Evidence segments */}
            {segments.map((s, i) => {
              const startFrac = s.start / norm;
              const lenFrac = Math.max(0, s.frac / norm - GAP);
              return (
                <motion.circle
                  key={s.d}
                  r={R}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={STROKE}
                  strokeLinecap="round"
                  strokeDasharray={`${lenFrac * C} ${C}`}
                  strokeDashoffset={-startFrac * C}
                  initial={reduce ? false : { opacity: 0, strokeDasharray: `0 ${C}` }}
                  animate={{ opacity: 0.25 + s.avg * 0.75, strokeDasharray: `${lenFrac * C} ${C}` }}
                  transition={{ duration: reduce ? 0 : 0.9, delay: reduce ? 0 : 0.15 + i * 0.08, ease: [0.16, 1, 0.3, 1] }}
                >
                  <title>{`${DIM_LABEL[s.d]} — ${s.count} belief${s.count === 1 ? '' : 's'}, avg ${Math.round(s.avg * 100)}% confidence`}</title>
                </motion.circle>
              );
            })}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="font-semibold tracking-tight text-foreground" style={{ fontSize: 56, lineHeight: 1 }}>
            <CountUp value={score} />
            <span className="ml-0.5 align-top text-xl text-foreground-secondary">%</span>
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-foreground-secondary">understanding</div>
        </div>
      </motion.div>

      <div className="max-w-sm text-center md:text-left">
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-foreground-secondary">Aqua’s understanding</div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          A living model of you
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground-secondary">
          Built from <span className="font-medium tabular-nums text-foreground">{model.turnCount}</span> observed turns.
          Each arc is one dimension of the model; its depth is Aqua’s confidence there.
          This model evolves automatically with every conversation.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 md:justify-start">
          {segments.map((s) => (
            <span key={s.d} className="inline-flex items-center gap-1.5 text-xs text-foreground-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" style={{ opacity: 0.25 + s.avg * 0.75 }} />
              {DIM_LABEL[s.d]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
