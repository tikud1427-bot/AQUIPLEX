import { useCallback, useEffect, useState } from 'react';
import { fetchReview, splitGoal, confirmBelief, deleteBelief, type ReviewCandidate } from '@/api/mind';
import { confirmMemoryFact, forgetMemoryFact, splitMemoryItem } from '@/api/memory';
import { normalizeError } from '@/api/client';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Panel } from '@/components/ui/panel';

/**
 * "Worth a second look" — records saved before Aqua's 2026-10-28 fixes that
 * today's rules would have saved differently (server: mind/legacyReview.js):
 * one goal holding several, or a goal saved as your job. Nothing changes
 * until you choose; every choice reports the server's real result.
 *
 * Absent when there is nothing to review, and when the review cannot be read
 * (it is a convenience, never a blocker for the page).
 */
type Pending = { candidate: ReviewCandidate } | null;

export function ReviewPanel({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<ReviewCandidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingRemove, setPendingRemove] = useState<Pending>(null);

  const load = useCallback(async () => {
    try {
      setItems(await fetchReview());
    } catch {
      setItems([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(c: ReviewCandidate, run: () => Promise<{ success: boolean }>) {
    setBusy(c.id);
    setErrors((e) => ({ ...e, [c.id]: '' }));
    try {
      const res = await run();
      if (!res?.success) throw new Error('not applied');
      setItems((xs) => xs.filter((x) => x.id !== c.id));
      onChanged?.();
    } catch (err) {
      setErrors((e) => ({ ...e, [c.id]: normalizeError(err).message }));
    } finally {
      setBusy(null);
    }
  }

  if (!items.length) return null;

  return (
    <Panel className="mb-10" data-testid="review-panel">
      <p className="mb-1 text-micro font-medium uppercase tracking-[0.16em] text-foreground-secondary">Worth a second look</p>
      <p className="mb-3 text-body leading-relaxed text-foreground-secondary">
        Saved before Aqua got better at telling these apart. Nothing changes unless you choose.
      </p>
      <ul className="space-y-4">
        {items.map((c) => {
          const disabled = busy === c.id;
          const btn = 'tap rounded-md border border-border px-2.5 py-1 text-caption text-foreground hover:bg-surface-secondary disabled:opacity-50';
          return (
            <li key={c.id} className="text-body leading-relaxed [overflow-wrap:anywhere]">
              {(c.kind === 'merged_goal' || c.kind === 'merged_goal_item') && (
                <>
                  <p className="text-foreground">
                    Saved as one goal: “{c.kind === 'merged_goal' ? c.title : c.item}”. It looks like {c.parts.length} separate goals:
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-foreground-secondary">
                    {c.parts.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button className={btn} disabled={disabled} onClick={() => void act(c, () => (c.kind === 'merged_goal'
                      ? splitGoal(c.goalId, { parts: c.parts })
                      : splitMemoryItem(c.key, { item: c.item, parts: c.parts })))}>
                      Split into {c.parts.length}
                    </button>
                    <button className={btn} disabled={disabled} onClick={() => void act(c, () => (c.kind === 'merged_goal'
                      ? splitGoal(c.goalId, { keep: true })
                      : splitMemoryItem(c.key, { item: c.item, keep: true })))}>
                      It's one goal
                    </button>
                  </div>
                </>
              )}
              {(c.kind === 'fact_fails_schema' || c.kind === 'role_is_aspiration') && (
                <>
                  <p className="text-foreground">
                    Saved as your {c.kind === 'fact_fails_schema' ? (c.label ?? 'profile').toLowerCase() : c.key.replace(/_/g, ' ')}: “{c.value}”.
                    {(c.kind === 'role_is_aspiration' || c.aspiration) ? ' That reads like something you’re aiming for, not what you do now.' : ' That doesn’t look like a valid value.'}
                  </p>
                  {c.kind === 'fact_fails_schema' && c.learnedFrom && (
                    <p className="mt-1 border-l-2 border-border pl-3 text-caption italic text-foreground-secondary">“{c.learnedFrom}”</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button className={btn} disabled={disabled} onClick={() => setPendingRemove({ candidate: c })}>Remove it</button>
                    <button className={btn} disabled={disabled} onClick={() => void act(c, () => (c.kind === 'fact_fails_schema'
                      ? confirmMemoryFact(c.key)
                      : confirmBelief(c.dimension, c.key)))}>
                      It's right
                    </button>
                  </div>
                </>
              )}
              {errors[c.id] && <p role="alert" className="mt-1 text-caption text-danger">{errors[c.id]}</p>}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => { if (!o) setPendingRemove(null); }}
        title="Remove this?"
        description="Aqua stops using it in every conversation. This can’t be undone."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          const c = pendingRemove?.candidate;
          setPendingRemove(null);
          if (c?.kind === 'fact_fails_schema') void act(c, () => forgetMemoryFact(c.key));
          else if (c?.kind === 'role_is_aspiration') void act(c, () => deleteBelief(c.dimension, c.key));
        }}
      />
    </Panel>
  );
}
