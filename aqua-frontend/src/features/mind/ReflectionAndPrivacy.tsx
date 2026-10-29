import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { BrainCircuit, Download, Trash2, Lock, Hourglass, Eye } from 'lucide-react';
import type { MindModel } from '@/api/mind';
import { exportMindUrl, eraseMind } from '@/api/mind';
import { useMindStore, DIMENSIONS, learnedCount } from '@/stores/mindStore';
import { useUiStore } from '@/stores/uiStore';
import { normalizeError } from '@/api/client';
import { isDisplayableBelief } from '@/lib/displayGuard';
import { Panel } from '@/components/ui/panel';

/* ── Reflection — watch Aqua think (plays when a reflection lands) ───────── */

// Plays when the page sees a reflection that already ran, so it is narrated in
// the past tense, and only with what reflection does (reflectionEngine.js).
const STEPS = ['Reviewed what changed', 'Updated what it understands', 'Set aside what went stale'];

export function ReflectionOverlay() {
  const reduce = useReducedMotion();
  const playing = useMindStore((s) => s.reflectionPlaying);
  const dismiss = useMindStore((s) => s.dismissReflection);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!playing) return;
    setStep(0);
    if (reduce) { const t = setTimeout(dismiss, 1600); return () => clearTimeout(t); }
    const iv = setInterval(() => setStep((s) => s + 1), 850);
    const done = setTimeout(dismiss, 850 * STEPS.length + 700);
    return () => { clearInterval(iv); clearTimeout(done); };
  }, [playing, dismiss, reduce]);

  return (
    <AnimatePresence>
      {playing && (
        <motion.div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4"
          initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
        >
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2.5 shadow-lg">
            <motion.span
              animate={reduce ? undefined : { rotate: 360 }}
              transition={reduce ? undefined : { duration: 3, repeat: Infinity, ease: 'linear' }}
              className="text-primary"
            >
              <BrainCircuit className="h-4 w-4" />
            </motion.span>
            <span className="text-sm font-medium text-foreground">Aqua reflected</span>
            <span className="hidden text-sm text-foreground-secondary sm:inline">
              <AnimatePresence mode="wait">
                <motion.span
                  key={Math.min(step, STEPS.length - 1)}
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2 }}
                >
                  {STEPS[Math.min(step, STEPS.length - 1)]}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Privacy — complete control ─────────────────────────────────────────── */

export function PrivacyPanel({ model }: { model: MindModel }) {
  const clear = useMindStore((s) => s.clear);
  const toast = useUiStore((s) => s.toast);
  const [confirming, setConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);

  // Counted by the page's own visibility rule, so "Remembered" matches the hero
  // count and the cards above instead of including rows nobody can see.
  const beliefs = DIMENSIONS.flatMap((d) => model[d] ?? []).filter(isDisplayableBelief);
  const permanent = beliefs.filter((b) => !b.temporary).length;
  const temporary = beliefs.filter((b) => b.temporary).length;
  const pinned = beliefs.filter((b) => b.locked).length;

  // The page empties only after the server says it erased. A failure used to
  // be an unhandled rejection: the buttons reset and nothing said it failed.
  const erase = async () => {
    setErasing(true);
    try {
      const res = await eraseMind();
      if (res?.success === false) throw new Error('Aqua could not delete the model. Nothing was changed.');
      clear();
      toast('success', 'Model deleted', 'Aqua starts building its understanding again from your next conversation.');
    } catch (err) {
      toast('error', 'Could not delete the model', normalizeError(err).message);
    } finally {
      setErasing(false);
      setConfirming(false);
    }
  };

  return (
    <Panel className="p-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat icon={<Eye className="h-3.5 w-3.5" />} label="Remembered" value={learnedCount(model)} />
        <Stat icon={<BrainCircuit className="h-3.5 w-3.5" />} label="Permanent" value={permanent} />
        <Stat icon={<Hourglass className="h-3.5 w-3.5" />} label="Temporary" value={temporary} />
        <Stat icon={<Lock className="h-3.5 w-3.5" />} label="Pinned by you" value={pinned} />
      </div>

      <p className="mt-4 text-xs leading-relaxed text-foreground-secondary">
        This model belongs to you. Everything is private to your account, every belief explains its evidence,
        and you can pin, mark temporary, correct or delete any of it — or all of it.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <a
          href={exportMindUrl()}
          download
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-secondary"
        >
          <Download className="h-4 w-4" /> Export everything
        </a>
        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-danger/40 px-3 py-2 text-sm text-danger hover:bg-danger/10"
          >
            <Trash2 className="h-4 w-4" /> Delete the entire model
          </button>
        ) : (
          <span className="inline-flex items-center gap-2">
            <button
              onClick={erase}
              disabled={erasing}
              className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {erasing ? 'Deleting…' : 'Yes, delete everything'}
            </button>
            <button onClick={() => setConfirming(false)} className="rounded-lg border border-border px-3 py-2 text-sm text-foreground">
              Keep it
            </button>
          </span>
        )}
      </div>
    </Panel>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-micro uppercase tracking-[0.14em] text-foreground-secondary">{icon}{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}
