import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X, Lock, LockOpen, Hourglass, Trash2, Check } from 'lucide-react';
import type { CompactBelief, BeliefExplanation } from '@/api/mind';
import { explainBelief, correctBelief, setBeliefLock, setBeliefTemporary, deleteBelief } from '@/api/mind';
import { useMindStore } from '@/stores/mindStore';
import { ConfidenceBadge, timeAgo } from './primitives';
import { beliefTitle, beliefValueText } from './IdentitySection';

/* Explainability (why Aqua believes this) + corrections (change it) in one
   panel. Every mutation is optimistic through the store, so confidence
   visibly changes the instant you act. */

export function BeliefDrawer({ belief, onClose }: { belief: CompactBelief | null; onClose: () => void }) {
  const reduce = useReducedMotion();
  const applyBelief = useMindStore((s) => s.applyBelief);
  const removeBelief = useMindStore((s) => s.removeBelief);

  const [explanation, setExplanation] = useState<BeliefExplanation | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setExplanation(null);
    setSaved(false);
    if (!belief) return;
    setDraft(beliefValueText(belief) ?? '');
    explainBelief(belief.dimension, belief.key).then(setExplanation).catch(() => setExplanation(null));
  }, [belief]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<CompactBelief | void>, close = false) => {
    if (!belief || busy) return;
    setBusy(true);
    try {
      const updated = await fn();
      if (updated) { applyBelief(updated); setSaved(true); setTimeout(() => setSaved(false), 1400); }
      if (close) onClose();
    } finally {
      setBusy(false);
    }
  };

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
              <div>
                <div className="text-[11px] uppercase tracking-[0.16em] text-foreground-secondary">{belief.dimension}</div>
                <h3 className="mt-1 text-lg font-semibold text-foreground">{beliefTitle(belief)}</h3>
                <div className="mt-1.5 flex items-center gap-2">
                  <ConfidenceBadge value={belief.confidence} />
                  <span className="text-xs text-foreground-secondary">Updated {timeAgo(belief.updatedAt)}</span>
                </div>
              </div>
              <button onClick={onClose} className="rounded-lg p-2 text-foreground-secondary hover:bg-surface-secondary" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
              {/* Why */}
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-foreground-secondary">Why Aqua believes this</div>
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
                  <p className="text-sm text-foreground-secondary">Tracing evidence…</p>
                )}
              </section>

              {/* Correct */}
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-foreground-secondary">Correct it</div>
                <p className="mb-2 text-xs text-foreground-secondary">Your word outranks inference. Aqua learns from the correction.</p>
                <div className="flex gap-2">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="What’s actually true?"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  />
                  <button
                    disabled={busy || !draft.trim()}
                    onClick={() => run(() => correctBelief(belief.dimension, belief.key, draft.trim()))}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {saved ? <Check className="h-4 w-4" /> : null}{saved ? 'Saved' : 'Save'}
                  </button>
                </div>
              </section>

              {/* Control */}
              <section>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-foreground-secondary">Control</div>
                <div className="grid grid-cols-1 gap-2">
                  <button
                    disabled={busy}
                    onClick={() => run(() => setBeliefLock(belief.dimension, belief.key, !belief.locked))}
                    className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-secondary"
                  >
                    {belief.locked ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                    {belief.locked ? 'Unpin — allow it to evolve again' : 'Pin — never changed by inference'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(() => setBeliefTemporary(belief.dimension, belief.key, !belief.temporary))}
                    className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-secondary"
                  >
                    <Hourglass className="h-4 w-4" />
                    {belief.temporary ? 'Keep — allow it to become permanent' : 'Mark temporary — never made permanent'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(async () => { await deleteBelief(belief.dimension, belief.key); removeBelief(belief.dimension, belief.key); }, true)}
                    className="flex items-center gap-2 rounded-lg border border-danger/40 px-3 py-2 text-sm text-danger hover:bg-danger/10"
                  >
                    <Trash2 className="h-4 w-4" />
                    Forget this entirely
                  </button>
                </div>
              </section>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
