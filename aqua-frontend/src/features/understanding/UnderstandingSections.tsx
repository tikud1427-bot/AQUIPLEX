import { useEffect, useState } from 'react';
import { SectionHeader } from '@/components/ui/section-header';
import { normalizeError } from '@/api/client';
import { useUiStore } from '@/stores/uiStore';
import {
  fetchUnderstanding, correctItem, fetchChanges,
  type UnderstandingModel, type UnderstandingChange,
} from '@/api/understanding';

/* ────────────────────────────────────────────────────────────────────────────
   The three sections the Understanding page was missing.

   All three come from data the read model ALREADY returns — projects from the
   graph, sources from belief provenance, unknowns from the coverage model.
   Nothing new is tracked to render them.

   Every item carries the ref it was given, and "Not quite" sends that ref
   straight back. The person clicking it never learns whether they are editing
   a belief, a goal or a graph node — which is the difference between
   correcting an assistant and administering a database.
   ──────────────────────────────────────────────────────────────────────────── */

export function UnderstandingSections() {
  const [model, setModel] = useState<UnderstandingModel | null>(null);
  const [changes, setChanges] = useState<UnderstandingChange[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useUiStore((s) => s.toast);

  const load = () => { fetchUnderstanding().then(setModel).catch(() => setModel(null)); };
  useEffect(load, []);

  // Loaded separately, and failing separately. The revision feed is the newest
  // surface here and the only one reading a different endpoint; if it 404s on
  // an older server, or the flags that produce revisions are off, the rest of
  // the page must be unaffected. An empty list renders nothing at all.
  useEffect(() => { fetchChanges().then(setChanges).catch(() => setChanges([])); }, []);

  if (!model) return null;

  // The row goes only after the server confirms; a failure says so instead of
  // vanishing into an unhandled rejection.
  const dismiss = async (ref: string, label: string) => {
    setBusy(ref);
    try {
      await correctItem(ref, { action: 'remove' });
      toast('success', 'Removed', `Aqua no longer lists “${label}” as yours.`);
      load();
    } catch (err) {
      toast('error', 'Could not remove that', normalizeError(err).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {model.projects.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionHeader eyebrow="What you're building" title="Projects" />
          <ul className="flex flex-col gap-1.5">
            {model.projects.map((p) => (
              <li key={p.ref} className="group flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-[length:var(--text-body)] text-[var(--text)] [overflow-wrap:anywhere]">{p.label}</span>
                <NotQuite onClick={() => dismiss(p.ref, p.label)} busy={busy === p.ref} label="Not mine" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {model.sources.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionHeader eyebrow="Where this came from" title="How I learned it" />
          {/* Answers "why do you think that?" without anyone having to ask.
              Provenance is the difference between a system that remembers and
              one you can hold to account. */}
          <ul className="flex flex-col gap-1">
            {model.sources.map((s) => (
              <li key={s.kind} className="flex items-baseline justify-between gap-3">
                <span className="text-[length:var(--text-body)] text-[var(--text)]">{s.label}</span>
                <span className="text-[length:var(--text-micro)] tabular-nums text-[var(--text-secondary)]">
                  {s.count}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {changes.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionHeader eyebrow="Where I've been wrong" title="What changed" />
          {/* The other sections say what AQUA knows. This one says what it
              changed its mind about — which is the part a bigger context
              window cannot do, and the part that makes the rest believable.

              Read-only on purpose: a revision is a record of something that
              happened, not a claim to correct. The belief it revised is
              correctable in the sections above. */}
          <ul className="flex flex-col gap-2">
            {changes.map((c) => (
              <li key={c.at} className="flex items-baseline justify-between gap-3">
                <span className="text-[length:var(--text-body)] text-[var(--text)]">
                  {c.summary ?? 'Something shifted'}
                  {(c.obsoleted > 0 || c.revised > 0) && (
                    /* Only shown when AQUA actually superseded something it
                       previously held. "3 entities changed" is bookkeeping;
                       "this replaced what I had" is the admission worth
                       reading. */
                    <span className="ml-2 text-[length:var(--text-micro)] text-[var(--text-secondary)]">
                      replaced what I had before
                    </span>
                  )}
                </span>
                <time
                  dateTime={new Date(c.at).toISOString()}
                  className="shrink-0 text-[length:var(--text-micro)] tabular-nums text-[var(--text-secondary)]"
                >
                  {relativeDay(c.at)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}

      {model.unknowns.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionHeader eyebrow="Still learning" title="What I don't know yet" />
          {/* Phrased as invitations, not deficits. A list of the user's
              omissions on the screen meant to build trust reads as a scorecard
              they are failing. */}
          <p className="text-[length:var(--text-caption)] text-[var(--text-secondary)]">
            Nothing to fill in — these come up naturally as we work.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {model.unknowns.slice(0, 6).map((u) => (
              <li
                key={u.id}
                className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[length:var(--text-micro)] text-[var(--text-secondary)]"
              >
                {u.prompt}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** "today" / "yesterday" / "3 days ago". A wall-clock timestamp on a trust
 *  screen reads like a log line; what matters is how recently AQUA moved. */
function relativeDay(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function NotQuite({ onClick, busy, label = 'Not quite' }: { onClick: () => void; busy: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      // hover-reveal (globals.css): hover-only where a pointer can hover;
      // always visible on touch, where opacity-0 made it unreachable.
      className="hover-reveal shrink-0 rounded px-1.5 py-0.5 text-[length:var(--text-micro)] text-[var(--text-secondary)] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] disabled:opacity-40"
    >
      {busy ? '…' : label}
    </button>
  );
}
