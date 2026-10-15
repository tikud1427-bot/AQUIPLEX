import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageList } from '@/components/chat/MessageList';
import { Composer } from '@/components/chat/Composer';
import { useChatStore } from '@/stores/chatStore';
import { useMindStore } from '@/stores/mindStore';
import { completeIntro, type WorldModelCard as CardData } from '@/api/understanding';
import { dismissIntroForSession } from '@/hooks/useUnderstandingGate';
import { WorldModelCard } from '@/features/understanding/WorldModelCard';

/* ────────────────────────────────────────────────────────────────────────────
   Getting to Know You.

   Never "onboarding". No stepper, no progress bar, no "question 3 of 7" — a
   counter turns a conversation back into a form, which is the one thing the
   brief rules out.

   It reuses MessageList and Composer COMPLETELY UNCHANGED, on the real chat
   store. Two reasons, and the second matters more:

     • Someone who finishes this has already learned the product's main
       surface. A bespoke intro UI teaches nothing transferable.
     • Every turn here is a genuine conversation turn — stored, ingested,
       reflected on, correctable. That is what makes "no manual profile
       editing" true by construction rather than by policy.

   The only difference from ordinary chat is `introMode` on the store, which
   adds `mode: 'understanding'` to the request. Absent it, byte-identical.
   ──────────────────────────────────────────────────────────────────────────── */

const MIN_EXCHANGES_BEFORE_OFFER = 3;

export default function IntroPage() {
  const navigate = useNavigate();
  const setIntroMode = useChatStore((s) => s.setIntroMode);
  const newConversation = useChatStore((s) => s.newConversation);
  const messages = useChatStore((s) => s.messages);
  const generating = useChatStore((s) => s.generating);
  const conversationId = useChatStore((s) => s.conversationId);
  const mind = useMindStore((s) => s.model);

  const [card, setCard] = useState<CardData | null>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    newConversation();
    setIntroMode(true);
    // Cleared on unmount so a normal chat opened afterwards can never inherit
    // interview mode — the failure would be silent and would skip verification
    // on real questions.
    return () => setIntroMode(false);
  }, [newConversation, setIntroMode]);

  const finish = useCallback(async () => {
    setFinishing(true);
    try {
      setCard(await completeIntro(conversationId));
    } catch {
      // The card is the payoff, but it is not worth trapping someone here.
      // A failed completion may also mean a missing marker, so the gate is
      // silenced for this tab as well — otherwise "leaving" bounces back in.
      dismissIntroForSession();
      navigate('/');
    } finally {
      setFinishing(false);
    }
  }, [conversationId, navigate]);

  const leave = useCallback(() => {
    // Skipping is never punished and never stored as a refusal. It still marks
    // the intro so the offer does not reappear and read as "you failed".
    completeIntro(conversationId).catch(() => {});
    // …but the server marker lands on a CONVERSATION, and skipping before the
    // first message means there is no conversation to mark. Without this line
    // the gate on "/" would answer "yes" again and send them straight back —
    // "Skip for now" would be a button that does nothing. Local, per-tab, never
    // sent anywhere: someone who said nothing has told us nothing to store,
    // including that they left.
    dismissIntroForSession();
    navigate('/');
  }, [conversationId, navigate]);

  if (card) {
    return (
      <WorldModelCard
        card={card}
        mind={mind}
        onConfirm={() => navigate('/')}
        onCorrect={(_ref, text) => {
          setCard(null);
          void useChatStore.getState().sendMessage(`Actually — "${text}" isn't right.`);
        }}
      />
    );
  }

  const exchanges = messages.filter((m) => m.role === 'user').length;
  const canFinish = exchanges >= MIN_EXCHANGES_BEFORE_OFFER && !generating && !finishing;

  return (
    <div className="flex h-full flex-col">
      {messages.length === 0 ? <Opening /> : <MessageList />}

      <Composer />

      <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pb-4">
        {/* Available from the first turn, never buried. Trust-first means never
            trapping someone in a conversation they did not ask for. */}
        <button
          type="button"
          onClick={leave}
          className="rounded px-1 py-0.5 text-[length:var(--text-caption)] text-[var(--text-secondary)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
        >
          Skip for now
        </button>

        {/* Appears only once there is something worth showing. No counter and no
            progress bar — the user decides when they have said enough. */}
        {canFinish && (
          <button
            type="button"
            onClick={finish}
            className="rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-[length:var(--text-caption)] text-[var(--text)] transition hover:bg-[var(--surface-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
          >
            Show me what you understand
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The opener. Written, not generated — it is the first thing anyone reads, and
 * it should not depend on a model round-trip or vary between users.
 */
function Opening() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-6">
      <h1 className="text-[1.375rem] font-medium tracking-tight text-[var(--text)]">
        Hi — I'm Aqua.
      </h1>
      <p className="text-[length:var(--text-lead)] leading-relaxed text-[var(--text-secondary)]">
        I work a bit differently from most assistants. Instead of starting every
        conversation from scratch, I spend a few minutes understanding your world,
        so I'm actually useful later.
      </p>
      <p className="text-[length:var(--text-lead)] leading-relaxed text-[var(--text)]">
        So — what are you working on at the moment?
      </p>
      <p className="text-[length:var(--text-body)] leading-relaxed text-[var(--text-secondary)]">
        {/* Says what to bring and what Aqua cannot see. A new user otherwise
            guesses — and an assistant that "remembers your work" invites the
            assumption that it reads your email or repos. It does not. */}
        The most useful things to tell me: what the project is, who it's for, where it
        stands, and what you've already decided. You can attach a document too — a
        deck, a spec, notes. I only know what you tell me or upload here; I don't read
        your email, chat tools or code hosts.
      </p>
      <p className="text-[length:var(--text-caption)] text-[var(--text-secondary)]">
        {/* States the cost honestly and up front. "Takes about two minutes" is a
            promise the pipeline now keeps: interview turns skip the
            verification pass that cost seconds per answer. */}
        Takes about two minutes. You can stop any time.
      </p>
    </div>
  );
}
