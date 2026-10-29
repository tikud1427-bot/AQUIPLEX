import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X, Lock, LockOpen, Hourglass, Trash2, Check } from 'lucide-react';
import type { CompactBelief, BeliefExplanation } from '@/api/mind';
import { explainBelief, correctBelief, setBeliefLock, setBeliefTemporary, deleteBelief } from '@/api/mind';
import { normalizeError } from '@/api/client';
import { useMindStore } from '@/stores/mindStore';
import { useUiStore } from '@/stores/uiStore';
import { ProvenanceBadge } from '@/components/ui/provenance-badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { timeAgo } from '@/lib/format';
import { dimensionLabel } from '@/lib/displayGuard';
import { beliefTitle, beliefValueText } from './IdentitySection';

/* Explainability (why Aqua believes this) + corrections (change it) in one
   panel. A change is shown only once the server has made it: a failed save
   says so in the drawer, and "Forget" asks first and closes only on success. */

export function BeliefDrawer({ belief, onClose }: { belief: CompactBelief | null; onClose: () => void }) {
  const reduce = useReducedMotion();
  const applyBelief = useMindStore((s) => s.applyBelief);
  const removeBelief = useMindStore((s) => s.removeBelief);
  const toast = useUiStore((s) => s.toast);

  const [explanation, setExplanation] = useState<BeliefExplanation | null>(null);
  const [explainFailed, setExplainFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);

  useEffect(() => {
    setExplanation(null);
    setExplainFailed(false);
    setSaved(false);
    setError(null);
    if (!belief) return;
    setDraft(beliefValueText(belief) ?? '');
    explainBelief(belief.dimension, belief.key)
      .then(setExplanation)
      .catch(() => { setExplanation(null); setExplainFailed(true); });
  }, [belief]);

  useEffect(() => {
    // The confirm dialog handles its own Escape; it must not also close the drawer.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !confirmForget && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmForget]);

  const run = async (fn: () => Promise<CompactBelief>) => {
    if (!belief || busy) return;
    setBusy(true);
    setError(null);
    try {
      applyBelief(await fn());
      setSaved(true);
      setTimeout(() => setSaved(false), 1400);
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!belief) return;
    setBusy(true);
    setError(null);
    try {
      const res = await deleteBelief(belief.dimension, belief.key);
      if (res?.success === false) throw new Error('Aqua could not forget this. Nothing was changed.');
      removeBelief(belief.dimension, belief.key);
      toast('success', 'Forgotten', `Aqua no longer holds “${beliefTitle(belief)}”.`);
      onClose();
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const dimension = belief ? dimensionLabel(belief.dimension) : null;

  return (
    <AnimatePresence>
      {belief && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/35"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={`Why Aqua believes ${beliefTitle(belief)}`}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-xl"
            initial={reduce ? { opacity: 0 } : { x: '100%' }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
          >
            <header className="flex items-start justify-between gap-3 border-b border-border p-5">
              <div className="min-w-0">
                {dimension && <div className="text-micro uppercase tracking-[0.16em] text-foreground-secondary">{dimension}</div>}
                <h3 className="mt-1 text-lg font-semibold text-foreground [overflow-wrap:anywhere]">{beliefTitle(belief)}</h3>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <ProvenanceBadge source={belief.source} evidenceCount={belief.evidenceCount} />
                  <span className="text-xs text-foreground-secondary">Updated {timeAgo(belief.updatedAt)}</span>
                </div>
              </div>
              <button onClick={onClose} className="rounded-lg p-2 text-foreground-secondary hover:bg-surface-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
              {/* Why */}
              <section>
                <div className="mb-2 text-micro font-medium uppercase tracking-[0.14em] text-foreground-secondary">Why Aqua believes this</div>
                {explanation ? (
                  <>
                    <p className="text-sm leading-relaxed text-foreground">{explanation.explanation}</p>
                    {explanation.recentEvidence.length > 0 && (
                      <ul className="mt-3 space-y-1.5">
                        {explanation.recentEvidence.slice().reverse().map((ev, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs text-foreground-secondary">
                            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${ev.support === false ? 'bg-warning' : 'bg-primary'}`} />
                            <span>{ev.correction ? 'You corrected this' : ev.signal} · {timeAgo(ev.ts)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-foreground-secondary">
                    {explainFailed ? 'The evidence couldn’t load right now. You can still correct or forget this.' : 'Tracing evidence…'}
                  </p>
                )}
              </section>

              {/* Correct */}
              <section>
                <div className="mb-2 text-micro font-medium uppercase tracking-[0.14em] text-foreground-secondary">Correct it</div>
                <p className="mb-2 text-xs text-foreground-secondary">Your word outranks inference. Aqua learns from the correction.</p>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void run(() => correctBelief(belief.dimension, belief.key, draft.trim())); }}
                >
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="What’s actually true?"
                    aria-label={`Correct ${beliefTitle(belief)}`}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  />
                  <button
                    type="submit"
                    disabled={busy || !draft.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2"
                  >
                    {saved ? <Check className="h-4 w-4" /> : null}{saved ? 'Saved' : 'Save'}
                  </button>
                </form>
              </section>

              {error && (
                <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>
              )}

              {/* Control */}
              <section>
                <div className="mb-2 text-micro font-medium uppercase tracking-[0.14em] text-foreground-secondary">Control</div>
                <div className="grid grid-cols-1 gap-2">
                  <button
                    disabled={busy}
                    onClick={() => run(() => setBeliefLock(belief.dimension, belief.key, !belief.locked))}
                    className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm text-foreground hover:bg-surface-secondary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    {belief.locked ? <LockOpen className="h-4 w-4 shrink-0" /> : <Lock className="h-4 w-4 shrink-0" />}
                    {belief.locked ? 'Unpin — allow it to evolve again' : 'Pin — never changed by inference'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(() => setBeliefTemporary(belief.dimension, belief.key, !belief.temporary))}
                    className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm text-foreground hover:bg-surface-secondary disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    <Hourglass className="h-4 w-4 shrink-0" />
                    {belief.temporary ? 'Keep — allow it to become permanent' : 'Mark temporary — never made permanent'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setConfirmForget(true)}
                    className="flex items-center gap-2 rounded-lg border border-danger/40 px-3 py-2 text-left text-sm text-danger hover:bg-danger/10 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/60"
                  >
                    <Trash2 className="h-4 w-4 shrink-0" />
                    Forget this entirely
                  </button>
                </div>
              </section>
            </div>
          </motion.aside>

          <ConfirmDialog
            open={confirmForget}
            onOpenChange={setConfirmForget}
            title={`Forget “${beliefTitle(belief)}”?`}
            description="Aqua stops using it and removes it from your model. This can’t be undone."
            confirmLabel="Forget it"
            destructive
            onConfirm={() => void forget()}
          />
        </>
      )}
    </AnimatePresence>
  );
}
