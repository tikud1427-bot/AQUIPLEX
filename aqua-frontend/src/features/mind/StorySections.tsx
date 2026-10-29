import { useMemo } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Check, Sparkles, TrendingUp, Target, RefreshCcw } from 'lucide-react';
import type { MindModel, TimelineEvent } from '@/api/mind';
import type { Learning } from '@/stores/mindStore';
import { DIMENSIONS, establishedBelief } from '@/stores/mindStore';
import { Panel } from '@/components/ui/panel';
import { timeAgo } from '@/lib/format';
import { isInternalText, stripInternalPrefix } from '@/lib/displayGuard';

/* ── Learning feed — "watch new knowledge appear" ───────────────────────── */

const LEARNING_ICON: Record<Learning['kind'], React.ReactNode> = {
  new:          <Sparkles className="h-3.5 w-3.5 text-primary" />,
  strengthened: <TrendingUp className="h-3.5 w-3.5 text-success" />,
  shifted:      <RefreshCcw className="h-3.5 w-3.5 text-warning" />,
  goal:         <Target className="h-3.5 w-3.5 text-primary" />,
  promoted:     <Check className="h-3.5 w-3.5 text-success" />,
};

export function LearningFeed({ learnings, model }: { learnings: Learning[]; model: MindModel }) {
  const reduce = useReducedMotion();

  // Session diffs first; if the session is fresh, seed from the latest
  // reflection — naming only beliefs the page shows ("domain:alpha" or a
  // custom_ slug sliced out of the key used to land here unguarded).
  const last = model.reflections.at(-1);
  const seeded: Learning[] = learnings.length ? learnings : (last?.learned ?? []).flatMap((l, i) => {
    const b = establishedBelief(model, l.key);
    const name = b ? (b.label && !isInternalText(b.label) ? b.label : stripInternalPrefix(b.key)) : null;
    return name ? [{ id: `seed${i}`, ts: last!.ts, kind: 'promoted' as const, text: `Established: ${name.toLowerCase()}` }] : [];
  });

  if (!seeded.length) {
    return <p className="text-sm text-foreground-secondary">Keep chatting — new understanding lands here the moment it forms.</p>;
  }

  return (
    <Panel className="p-5">
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
              <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{l.text}</span>
              <span className="ml-auto shrink-0 text-micro text-foreground-secondary">{timeAgo(l.ts)}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </Panel>
  );
}

/* ── Timeline — a story, not logs ───────────────────────────────────────── */

const KIND_LABEL: Record<string, string> = {
  goal_created: 'Started working toward', goal_completed: 'Completed',
  episode_opened: 'Began', episode_closed: 'Wrapped up',
  belief_established: 'Understanding settled:', reflection: 'Reflected',
};

/** A timeline row as a sentence, or null — an unknown kind or an internal subject is not shown. */
export function humanizeTimelineEvent(e: TimelineEvent): string | null {
  const verb = KIND_LABEL[e.kind];
  const raw = String(e.subject ?? '');
  if (!verb || !raw.trim() || isInternalText(raw)) return null;
  const subject = raw.replace(/^[a-z]+:/, '').replace(/_/g, ' ').replace(/^working on\s+/i, '');
  return `${verb} ${subject}`;
}

export function MindTimeline({ timeline }: { timeline: TimelineEvent[] }) {
  const reduce = useReducedMotion();
  const events = useMemo(
    () => [...timeline]
      .filter((e) => e.importance >= 5 && humanizeTimelineEvent(e))
      .sort((a, b) => b.ts - a.ts).slice(0, 8),
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
            <div className="text-sm text-foreground">{humanizeTimelineEvent(e)}</div>
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

    // A cell counts changes — each event, reflection outcome or belief update
    // is one. (It used to add weighted points plus belief confidence, and the
    // tooltip printed the sum as "2.7 activity".)
    const bump = (dimIdx: number, ts: number) => {
      const w = Math.floor((now - ts) / week);
      if (w >= 0 && w < HEAT_WEEKS && dimIdx >= 0) cells[dimIdx][HEAT_WEEKS - 1 - w] += 1;
    };
    const dimIndex = (key: string) => DIMENSIONS.findIndex((d) => key.startsWith(`${d}:`));

    for (const e of model.timeline) {
      if (e.kind === 'belief_established') bump(dimIndex(e.subject), e.ts);
      if (e.kind === 'goal_created' || e.kind === 'goal_completed') bump(0, e.ts);
    }
    for (const r of model.reflections) {
      for (const w of r.weakened) bump(dimIndex(w.key), r.ts);
      for (const p of r.promoted) bump(dimIndex(p), r.ts);
    }
    for (const d of DIMENSIONS) {
      for (const b of model[d] ?? []) bump(DIMENSIONS.indexOf(d), b.updatedAt);
    }
    const max = Math.max(1, ...cells.flat());
    return { cells, max };
  }, [model]);

  const hasSignal = grid.cells.flat().some((v) => v > 0);
  if (!hasSignal) return <p className="text-sm text-foreground-secondary">Evolution shows up after a little history accrues.</p>;

  return (
    <Panel className="p-5">
      {/* No min-width: at 1024 a 420px floor in a ~400px column scrolled
          "This week" — the newest data — out of view. Cells shrink instead. */}
      <div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `72px repeat(${HEAT_WEEKS}, 1fr)` }}>
          {grid.cells.map((row, ri) => (
            <div key={ri} className="contents">
              <div className="pr-2 text-right text-micro leading-4 text-foreground-secondary">{DIM_SHORT[ri]}</div>
              {row.map((v, ci) => (
                <motion.div
                  key={ci}
                  className="aspect-square rounded-[3px] bg-primary"
                  initial={reduce ? false : { opacity: 0 }}
                  whileInView={{ opacity: v === 0 ? 0.06 : 0.15 + 0.85 * (v / grid.max) }}
                  viewport={{ once: true }}
                  transition={{ delay: reduce ? 0 : (ri * HEAT_WEEKS + ci) * 0.004 }}
                  title={v ? `${DIM_SHORT[ri]} · ${v} change${v === 1 ? '' : 's'}` : undefined}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-micro text-foreground-secondary">
          <span>{HEAT_WEEKS} weeks ago</span><span>This week</span>
        </div>
      </div>
    </Panel>
  );
}
