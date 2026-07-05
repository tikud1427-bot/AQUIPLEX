import { motion, useReducedMotion, AnimatePresence } from 'framer-motion';
import { CircleDot, OctagonPause, CheckCircle2, Clock3, HelpCircle, Lightbulb, ShieldAlert } from 'lucide-react';
import type { Goal, MindModel, Prediction } from '@/api/mind';
import { Card, ConfidenceBadge, staleOpacity, timeAgo } from './primitives';

/* ── Goals ──────────────────────────────────────────────────────────────── */

const GOAL_STATUS_META: Record<Goal['status'], { label: string; icon: React.ReactNode; tone: string }> = {
  active:    { label: 'Active',    icon: <CircleDot className="h-3.5 w-3.5" />,     tone: 'text-primary' },
  blocked:   { label: 'Blocked',   icon: <OctagonPause className="h-3.5 w-3.5" />,  tone: 'text-warning' },
  completed: { label: 'Completed', icon: <CheckCircle2 className="h-3.5 w-3.5" />,  tone: 'text-success' },
  stale:     { label: 'Quiet',     icon: <Clock3 className="h-3.5 w-3.5" />,        tone: 'text-foreground-secondary' },
  abandoned: { label: 'Dropped',   icon: <Clock3 className="h-3.5 w-3.5" />,        tone: 'text-foreground-secondary' },
};

export function GoalsSection({ goals }: { goals: Goal[] }) {
  const reduce = useReducedMotion();
  const shown = [...goals]
    .sort((a, b) => Number(b.status === 'active' || b.status === 'blocked') - Number(a.status === 'active' || a.status === 'blocked')
      || b.lastMentionedAt - a.lastMentionedAt)
    .slice(0, 6);

  if (!shown.length) {
    return <p className="text-sm text-foreground-secondary">Mention what you’re working toward and it appears here.</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {shown.map((g) => {
        const meta = GOAL_STATUS_META[g.status];
        return (
          <Card key={g.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{g.title}</div>
                <div className={`mt-1 inline-flex items-center gap-1.5 text-xs ${meta.tone}`}>
                  {meta.icon}{meta.label}
                  <span className="text-foreground-secondary">· priority {g.priority}</span>
                  {g.deadline && <span className="text-foreground-secondary">· due {new Date(g.deadline).toLocaleDateString()}</span>}
                </div>
              </div>
              <ConfidenceBadge value={g.confidence} />
            </div>

            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-secondary" role="progressbar"
                 aria-valuenow={Math.round(g.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <motion.div
                className={`h-full rounded-full ${g.status === 'completed' ? 'bg-success' : 'bg-primary'}`}
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${Math.max(3, Math.round(g.progress * 100))}%` }}
                transition={{ duration: reduce ? 0 : 0.7, ease: [0.16, 1, 0.3, 1] }}
              />
            </div>

            {(g.blockers.length > 0 || g.dependencies.length > 0) && (
              <div className="mt-2.5 space-y-1 text-xs text-foreground-secondary">
                {g.blockers.slice(0, 2).map((b) => (
                  <div key={b} className="flex items-center gap-1.5"><ShieldAlert className="h-3 w-3 text-warning" />{b}</div>
                ))}
                {g.dependencies.slice(0, 2).map((d) => (
                  <div key={d} className="flex items-center gap-1.5">Depends on {d}</div>
                ))}
              </div>
            )}
            <div className="mt-2.5 text-[11px] text-foreground-secondary/80">Last mentioned {timeAgo(g.lastMentionedAt)}</div>
          </Card>
        );
      })}
    </div>
  );
}

/* ── Working memory — items fade as they go stale ───────────────────────── */

function WorkingList({ icon, title, items }: { icon: React.ReactNode; title: string; items: { text: string; at: number }[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-foreground-secondary">
        {icon}{title}
      </div>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.text} className="text-sm text-foreground" style={{ opacity: staleOpacity(it.at) }}>
            {it.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WorkingMemorySection({ model }: { model: MindModel }) {
  const w = model.working;
  const focus = (w.focusRanked ?? []).filter((f) => !f.topic.startsWith('workspace:')).slice(0, 6);
  const maxW = Math.max(1, ...focus.map((f) => f.weight));
  const empty = !focus.length && !w.blockers.length && !w.deadlines.length && !w.recentDiscoveries.length && !w.openQuestions.length;

  if (empty) return <p className="text-sm text-foreground-secondary">Aqua’s attention is clear right now.</p>;

  return (
    <Card className="p-5">
      {focus.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-foreground-secondary">Current focus</div>
          <div className="flex flex-wrap gap-2">
            {focus.map((f) => (
              <span
                key={f.topic}
                className="rounded-full border border-border bg-surface-secondary px-3 py-1 text-sm text-foreground"
                style={{ opacity: 0.45 + 0.55 * (f.weight / maxW) }}
              >
                {f.topic}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <WorkingList icon={<ShieldAlert className="h-3 w-3" />} title="Blockers"
          items={w.blockers.map((b) => ({ text: b.text, at: b.lastSeenAt }))} />
        <WorkingList icon={<Clock3 className="h-3 w-3" />} title="Deadlines"
          items={w.deadlines.map((d) => ({ text: d.label, at: d.addedAt ?? Date.now() }))} />
        <WorkingList icon={<Lightbulb className="h-3 w-3" />} title="Recent discoveries"
          items={w.recentDiscoveries.map((d) => ({ text: d.text, at: d.lastSeenAt }))} />
        <WorkingList icon={<HelpCircle className="h-3 w-3" />} title="Open questions"
          items={w.openQuestions.map((q) => ({ text: q.text, at: q.lastSeenAt }))} />
      </div>
    </Card>
  );
}

/* ── Predictions — forecasts, not memory ────────────────────────────────── */

export function PredictionsSection({ predictions }: { predictions: Prediction[] }) {
  const reduce = useReducedMotion();
  if (!predictions.length) {
    return <p className="text-sm text-foreground-secondary">Forecasts appear once Aqua sees where you’re heading.</p>;
  }
  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {predictions.map((p, i) => (
          <motion.div
            key={p.label}
            initial={reduce ? false : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ delay: reduce ? 0 : i * 0.05 }}
          >
            <Card className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm text-foreground">{p.label}</div>
                <div className="mt-0.5 text-[11px] text-foreground-secondary">{p.basis}</div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="hidden h-1 w-24 overflow-hidden rounded-full bg-surface-secondary sm:block">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(p.probability * 100)}%` }} />
                </div>
                <span className="font-mono text-sm tabular-nums text-foreground">{Math.round(p.probability * 100)}%</span>
              </div>
            </Card>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
