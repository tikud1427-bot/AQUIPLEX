import { useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Check, Sparkles, TrendingUp, Target, RefreshCcw } from 'lucide-react';
import type { MindModel, TimelineEvent } from '@/api/mind';
import type { Learning } from '@/stores/mindStore';
import { DIMENSIONS } from '@/stores/mindStore';
import { Card, timeAgo } from './primitives';

/* ── Learning feed — "watch new knowledge appear" ───────────────────────── */

const LEARNING_ICON: Record<Learning['kind'], React.ReactNode> = {
  new:          <Sparkles className="h-3.5 w-3.5 text-primary" />,
  strengthened: <TrendingUp className="h-3.5 w-3.5 text-success" />,
  shifted:      <RefreshCcw className="h-3.5 w-3.5 text-warning" />,
  goal:         <Target className="h-3.5 w-3.5 text-primary" />,
  promoted:     <Check className="h-3.5 w-3.5 text-success" />,
};

export function LearningFeed({ learnings, reflections }: { learnings: Learning[]; reflections: MindModel['reflections'] }) {
  const reduce = useReducedMotion();

  // Session diffs first; if the session is fresh, seed from the latest reflection
  const seeded: Learning[] = learnings.length ? learnings : (reflections.at(-1)?.learned ?? []).map((l, i) => ({
    id: `seed${i}`, ts: reflections.at(-1)!.ts, kind: 'promoted' as const,
    text: `Established: ${l.key.split(':').slice(1).join(':').replace(/_/g, ' ')}`,
  }));

  if (!seeded.length) {
    return <p className="text-sm text-foreground-secondary">Keep chatting — new understanding lands here the moment it forms.</p>;
  }

  return (
    <Card className="p-5">
      <ul className="space-y-2.5" aria-live="polite">
        <AnimatePresence initial={false}>
          {seeded.slice(0, 8).map((l) => (
            <motion.li
              key={l.id}
              initial={reduce ? false : { opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26 }}
              className="flex items-start gap-2.5"
            >
              <span className="mt-0.5">{LEARNING_ICON[l.kind]}</span>
              <span className="text-sm text-foreground">{l.text}</span>
              <span className="ml-auto shrink-0 text-[11px] text-foreground-secondary">{timeAgo(l.ts)}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </Card>
  );
}

/* ── Timeline — a story, not logs ───────────────────────────────────────── */

const KIND_LABEL: Record<string, string> = {
  goal_created: 'Started working toward', goal_completed: 'Completed',
  episode_opened: 'Began', episode_closed: 'Wrapped up',
  belief_established: 'Understanding settled:', reflection: 'Reflected',
};

function humanize(e: TimelineEvent): string {
  const verb = KIND_LABEL[e.kind] ?? e.kind.replace(/_/g, ' ');
  const subject = e.subject.replace(/^[a-z]+:/, '').replace(/_/g, ' ');
  return `${verb} ${subject}`;
}

export function MindTimeline({ timeline }: { timeline: TimelineEvent[] }) {
  const reduce = useReducedMotion();
  const events = useMemo(
    () => [...timeline].filter((e) => e.importance >= 5).sort((a, b) => b.ts - a.ts).slice(0, 8),
    [timeline],
  );
  if (!events.length) return <p className="text-sm text-foreground-secondary">Milestones will trace your journey here.</p>;

  return (
    <div className="relative pl-5">
      <div className="absolute bottom-1 left-[5px] top-1 w-px bg-border" aria-hidden />
      <ol className="space-y-4">
        <li className="relative">
          <span className="absolute -left-5 top-1 h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-primary/15" aria-hidden />
          <div className="text-sm font-medium text-foreground">Now</div>
          <div className="text-xs text-foreground-secondary">Model live and evolving</div>
        </li>
        {events.map((e, i) => (
          <motion.li
            key={e.id}
            className="relative"
            initial={reduce ? false : { opacity: 0, x: -6 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ delay: reduce ? 0 : i * 0.04 }}
          >
            <span className="absolute -left-5 top-1.5 h-2 w-2 rounded-full border border-border bg-surface" aria-hidden />
            <div className="text-sm text-foreground">{humanize(e)}</div>
            <div className="text-xs text-foreground-secondary">{timeAgo(e.ts)}</div>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}

/* ── Evolution heatmap — understanding over time ────────────────────────── */

const HEAT_WEEKS = 12;
const DIM_SHORT = ['Identity', 'Personality', 'Comms', 'Prefs', 'Knowledge', 'Behavior', 'Decision'];

export function EvolutionHeatmap({ model }: { model: MindModel }) {
  const reduce = useReducedMotion();

  const grid = useMemo(() => {
    const now = Date.now();
    const week = 7 * 24 * 3600 * 1000;
    const cells: number[][] = DIMENSIONS.map(() => Array(HEAT_WEEKS).fill(0));

    // Activity sources: timeline events + reflection deltas + belief updates.
    const bump = (dimIdx: number, ts: number, amt: number) => {
      const w = Math.floor((now - ts) / week);
      if (w >= 0 && w < HEAT_WEEKS && dimIdx >= 0) cells[dimIdx][HEAT_WEEKS - 1 - w] += amt;
    };
    const dimIndex = (key: string) => DIMENSIONS.findIndex((d) => key.startsWith(`${d}:`));

    for (const e of model.timeline) {
      if (e.kind === 'belief_established') bump(dimIndex(e.subject), e.ts, 3);
      if (e.kind === 'goal_created' || e.kind === 'goal_completed') bump(0, e.ts, 2);
    }
    for (const r of model.reflections) {
      for (const w of r.weakened) bump(dimIndex(w.key), r.ts, 1);
      for (const p of r.promoted) bump(dimIndex(p), r.ts, 2);
    }
    for (const d of DIMENSIONS) {
      for (const b of model[d] ?? []) bump(DIMENSIONS.indexOf(d), b.updatedAt, 1 + b.confidence);
    }
    const max = Math.max(1, ...cells.flat());
    return { cells, max };
  }, [model]);

  const hasSignal = grid.cells.flat().some((v) => v > 0);
  if (!hasSignal) return <p className="text-sm text-foreground-secondary">Evolution shows up after a little history accrues.</p>;

  return (
    <Card className="overflow-x-auto p-5">
      <div className="min-w-[420px]">
        <div className="grid gap-1" style={{ gridTemplateColumns: `72px repeat(${HEAT_WEEKS}, 1fr)` }}>
          {grid.cells.map((row, ri) => (
            <div key={ri} className="contents">
              <div className="pr-2 text-right text-[11px] leading-4 text-foreground-secondary">{DIM_SHORT[ri]}</div>
              {row.map((v, ci) => (
                <motion.div
                  key={ci}
                  className="aspect-square rounded-[3px] bg-primary"
                  initial={reduce ? false : { opacity: 0 }}
                  whileInView={{ opacity: v === 0 ? 0.06 : 0.15 + 0.85 * (v / grid.max) }}
                  viewport={{ once: true }}
                  transition={{ delay: reduce ? 0 : (ri * HEAT_WEEKS + ci) * 0.004 }}
                  title={v ? `${DIM_SHORT[ri]} · ${v.toFixed(1)} activity` : undefined}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-foreground-secondary">
          <span>{HEAT_WEEKS} weeks ago</span><span>This week</span>
        </div>
      </div>
    </Card>
  );
}
