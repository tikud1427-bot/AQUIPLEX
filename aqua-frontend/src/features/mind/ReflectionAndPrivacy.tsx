import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { BrainCircuit, Download, Trash2, Lock, Hourglass, Eye } from 'lucide-react';
import type { MindModel } from '@/api/mind';
import { exportMindUrl, eraseMind } from '@/api/mind';
import { useMindStore, DIMENSIONS } from '@/stores/mindStore';
import { Card } from './primitives';

/* ── Reflection — watch Aqua think (plays when a reflection lands) ───────── */

const STEPS = ['Reviewing what changed…', 'Updating beliefs…', 'Adjusting confidence…', 'Archiving what went stale…', 'Refreshing predictions…'];

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
            <span className="text-sm font-medium text-foreground">Aqua is reflecting</span>
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
  const [confirming, setConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);

  const beliefs = DIMENSIONS.flatMap((d) => model[d] ?? []);
  const permanent = beliefs.filter((b) => !b.temporary && b.status !== 'archived').length;
  const temporary = beliefs.filter((b) => b.temporary).length;
  const pinned = beliefs.filter((b) => b.locked).length;

  const erase = async () => {
    setErasing(true);
    try { await eraseMind(); clear(); } finally { setErasing(false); setConfirming(false); }
  };

  return (
    <Card className="p-5">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat icon={<Eye className="h-3.5 w-3.5" />} label="Remembered" value={beliefs.length + model.goals.length} />
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
    </Card>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-foreground-secondary">{icon}{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}
