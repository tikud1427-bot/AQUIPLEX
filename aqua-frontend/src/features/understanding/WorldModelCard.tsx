import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { WorldModelCard as CardData } from '@/api/understanding';
import { UnderstandingRing } from '@/features/mind/UnderstandingRing';
import type { MindModel } from '@/api/mind';

/* ────────────────────────────────────────────────────────────────────────────
   "Here's what I understand so far."

   The moment the whole brief is written around. Three decisions carry it:

   1. IT ASSEMBLES, IT DOES NOT APPEAR. Sections resolve one at a time. This is
      the only place motion is spent, and it is honest motion — composing this
      really does take a moment. A card that arrives fully formed reads as a
      template being filled in, which is precisely the feeling to avoid.

   2. THE RING IS THE SIGNATURE, AND IT IS ALREADY OURS. UnderstandingRing —
      seven arcs, one per cognitive dimension, opacity by evidence — is the
      most distinctive object in the product. Introducing a second visual
      language here would make the most important screen the least familiar
      one. It counts up LAST, after the sections it summarises.

   3. NO CONFIDENCE LABEL. Sections used to carry "fairly sure" / "still
      learning" — words for an average of uncalibrated belief confidences, so
      a claim of certainty nothing had measured (removed 2026-10-28). The
      lines themselves, each correctable, are the content.

   Everything else stays quiet: existing tokens, existing type scale, no new
   palette. Spend the boldness in one place.
   ──────────────────────────────────────────────────────────────────────────── */

const STAGGER_MS = 320;

export function WorldModelCard({
  card, mind, onConfirm, onCorrect,
}: {
  card: CardData;
  mind: MindModel | null;
  onConfirm: () => void;
  onCorrect: (ref: string, text: string) => void;
}) {
  const reduce = useReducedMotion();
  const [revealed, setRevealed] = useState(reduce ? card.sections.length : 0);
  const [ringIn, setRingIn] = useState(!!reduce);

  useEffect(() => {
    if (reduce) { setRevealed(card.sections.length); setRingIn(true); return; }
    const timers: number[] = [];
    card.sections.forEach((_, i) => {
      timers.push(window.setTimeout(() => setRevealed(i + 1), i * STAGGER_MS));
    });
    timers.push(window.setTimeout(() => setRingIn(true), card.sections.length * STAGGER_MS));
    return () => timers.forEach(clearTimeout);
  }, [card.sections, reduce]);

  const done = revealed >= card.sections.length && ringIn;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-[1.375rem] font-medium tracking-tight text-[var(--text)]">
          {card.headline}
        </h1>
        <p className="text-[length:var(--text-caption)] text-[var(--text-secondary)]">
          {/* Says plainly that this is a draft. A card that presents itself as
              finished invites the reader to find the one wrong line; a card that
              admits it is partial invites them to fix it. */}
          Tell me where I've got it wrong — it's quicker than starting over.
        </p>
      </header>

      {card.sections.length === 0 ? (
        <EmptyCard />
      ) : (
        <div className="flex flex-col gap-6">
          {card.sections.slice(0, revealed).map((section, i) => (
            <motion.section
              key={section.id}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col gap-2 border-t border-[var(--border)] pt-4 first:border-t-0 first:pt-0"
            >
              <h2 className="text-[length:var(--text-micro)] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                {section.label}
              </h2>

              <ul className="flex flex-col gap-1.5">
                {section.items.map((item) => (
                  <li key={item.ref} className="group flex items-baseline justify-between gap-3">
                    <span className="min-w-0 text-[length:var(--text-lead)] leading-snug text-[var(--text)] [overflow-wrap:anywhere]">
                      {item.text}
                    </span>
                    {/* Correction sits on every line, not behind a settings
                        screen. The card is where someone first thinks "no,
                        that's not right", and that thought should be one click
                        from being fixed. */}
                    <button
                      type="button"
                      onClick={() => onCorrect(item.ref, item.text)}
                      // hover-reveal: hidden until hover only where a pointer can
                      // hover. opacity-0 alone left it invisible on every phone.
                      className="hover-reveal shrink-0 rounded px-1.5 py-0.5 text-[length:var(--text-micro)] text-[var(--text-secondary)] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                    >
                      Not quite
                    </button>
                  </li>
                ))}
              </ul>
              {i === card.sections.length - 1 && null}
            </motion.section>
          ))}
        </div>
      )}

      {ringIn && mind && (
        <motion.div
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="flex flex-col items-center gap-3 border-t border-[var(--border)] pt-8"
        >
          <UnderstandingRing model={mind} />
          <p className="text-[length:var(--text-caption)] text-[var(--text-secondary)]">
            {card.isThin
              /* An honest line for a thin card. Not an apology, and not a
                 pretence that three lines are a finished portrait. */
              ? 'A start. This fills in as we work together — nothing else to do now.'
              : 'This keeps growing as we work together.'}
          </p>
        </motion.div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={!done}
          className="rounded-[var(--radius)] bg-[var(--primary)] px-4 py-2 text-[length:var(--text-body)] font-medium text-[var(--primary-foreground)] transition disabled:opacity-40"
        >
          {/* Says what happens next, not "Continue" or "Get started". */}
          Start working
        </button>
      </div>
    </div>
  );
}

function EmptyCard() {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-secondary)] px-5 py-6">
      <p className="text-[length:var(--text-lead)] text-[var(--text)]">
        Not much yet — we barely got started.
      </p>
      <p className="text-[length:var(--text-caption)] text-[var(--text-secondary)]">
        {/* An empty state is an invitation, not a failure notice. Nothing was
            lost and nothing needs redoing. */}
        That's fine. I'll pick things up as we work, and you can see what I
        understand any time from Understanding.
      </p>
    </div>
  );
}
