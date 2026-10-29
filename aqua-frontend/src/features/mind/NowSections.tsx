import { CircleDot, OctagonPause, CheckCircle2, Clock3, HelpCircle, Lightbulb, ShieldAlert } from 'lucide-react';
import type { Goal, MindModel } from '@/api/mind';
import { Panel } from '@/components/ui/panel';
import { staleOpacity, timeAgo } from '@/lib/format';
import { isInternalTopic } from '@/lib/displayGuard';

/* ── Goals ──────────────────────────────────────────────────────────────── */

/** aqua/src/mind/mindSchema.js createGoal — the value every goal starts with. */
const DEFAULT_GOAL_PRIORITY = 5;

const GOAL_STATUS_META: Partial<Record<string, { label: string; icon: React.ReactNode; tone: string }>> = {
  active:    { label: 'Active',    icon: <CircleDot className="h-3.5 w-3.5" />,     tone: 'text-primary' },
  blocked:   { label: 'Blocked',   icon: <OctagonPause className="h-3.5 w-3.5" />,  tone: 'text-warning' },
  completed: { label: 'Completed', icon: <CheckCircle2 className="h-3.5 w-3.5" />,  tone: 'text-success' },
  stale:     { label: 'Quiet',     icon: <Clock3 className="h-3.5 w-3.5" />,        tone: 'text-foreground-secondary' },
  abandoned: { label: 'Dropped',   icon: <Clock3 className="h-3.5 w-3.5" />,        tone: 'text-foreground-secondary' },
};

export function GoalsSection({ goals }: { goals: Goal[] }) {
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
          <Panel key={g.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="line-clamp-2 text-sm font-semibold text-foreground [overflow-wrap:anywhere]" title={g.title}>{g.title}</div>
                {/* Status is shown only when the page knows it. Priority only
                    when someone set it: every goal is created at 5 (mindSchema
                    createGoal), so "priority 5" said nothing about the goal. */}
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                  {meta && <span className={`inline-flex items-center gap-1.5 ${meta.tone}`}>{meta.icon}{meta.label}</span>}
                  {g.priority !== DEFAULT_GOAL_PRIORITY && <span className="text-foreground-secondary">· priority {g.priority}</span>}
                  {g.deadline && <span className="text-foreground-secondary">· due {new Date(g.deadline).toLocaleDateString()}</span>}
                </div>
              </div>
              {/* A count, not a percentage: goal "progress" is a +0.2-per-phrase
                  heuristic and goal confidence is a constant, so neither is shown. */}
              <span className="shrink-0 text-xs tabular-nums text-foreground-secondary">
                mentioned {g.mentions}×
              </span>
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
            <div className="mt-2.5 text-micro text-foreground-secondary/80">Last mentioned {timeAgo(g.lastMentionedAt)}</div>
          </Panel>
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
      <div className="mb-1.5 flex items-center gap-1.5 text-micro font-medium uppercase tracking-[0.14em] text-foreground-secondary">
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
  // Routing ids ("simple_qa", "personal_info") are the engine's, not the person's focus.
  const focus = (w.focusRanked ?? []).filter((f) => !isInternalTopic(f.topic)).slice(0, 6);
  const maxW = Math.max(1, ...focus.map((f) => f.weight));
  const empty = !focus.length && !w.blockers.length && !w.deadlines.length && !w.recentDiscoveries.length && !w.openQuestions.length;

  if (empty) return <p className="text-sm text-foreground-secondary">Aqua’s attention is clear right now.</p>;

  return (
    <Panel className="p-5">
      {focus.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-micro font-medium uppercase tracking-[0.14em] text-foreground-secondary">Current focus</div>
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
    </Panel>
  );
}

/* Predictions are not on the page (2026-10-28). Each was a template with a
   fixed score: "Likely to continue debugging this issue" (0.7), "Next
   questions likely about: …" (0.6). The ones grounded in something real —
   a deadline, a blocker, an active goal — repeat what Goals and Aqua's
   attention already show, and the rest claim to know what the person will do
   next with nothing measured behind it. GET /mind still returns them. */
