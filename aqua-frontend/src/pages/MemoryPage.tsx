import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, MessageSquarePlus, Pencil, Pin, PinOff, RefreshCcw, Trash2 } from 'lucide-react';
import {
  correctClaimValue,
  forgetAllMemory,
  forgetClaim,
  forgetMemoryFact,
  keepSensitiveFact,
  listCurrentClaims,
  listMemory,
  memoryTimeline,
  pinMemoryFact,
  type CurrentClaim,
} from '@/api/memory';
import { factHeading, factValueItems, isInternalText } from '@/lib/displayGuard';
import { normalizeError } from '@/api/client';
import { SectionHeader } from '@/components/ui/section-header';
import { Panel } from '@/components/ui/panel';
import { ReviewPanel } from '@/components/memory/ReviewPanel';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useUiStore } from '@/stores/uiStore';
import { humanizeKey, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { MemoryChange, MemoryFact } from '@/types';

/* What AQUA remembers about you — a destination, not a settings tab.
   Memory was reachable only through Settings → Memory, scoped to the current
   conversation, rendered as key/value rows with a delete button each. This is
   the same data read from the endpoint it is actually stored against, written
   as sentences. */

const OTHER_GROUP = 'Other things you’ve said';

/** Group order on the page, by humanised category label. Unlisted → after these, before the catch-all. */
const GROUP_ORDER = [
  'identity', 'work', 'education', 'goals', 'projects', 'location', 'family', 'pets',
  'preferences', 'programming', 'technology', 'lifestyle', 'food', 'entertainment', 'travel',
];

function FactRow({
  fact,
  onPin,
  onForget,
  groupLabel,
}: {
  fact: MemoryFact;
  onPin: (key: string, pinned: boolean) => void;
  onForget: (key: string) => void;
  groupLabel?: string;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const evidence = fact.sourceMessage || fact.sourceText || '';
  const learned = fact.createdAt ?? fact.ts;
  const revised = (fact.revision ?? 1) > 1;
  // Only worth a line when it is a different moment from when it was learned.
  const confirmed = fact.lastConfirmedAt && learned && fact.lastConfirmedAt - learned > 60 * 60 * 1000 ? fact.lastConfirmedAt : null;
  // A custom_ key is the extractor's slug of the value — never a heading; a
  // collection is a list of distinct items, never one joined string.
  const label = factHeading(fact);
  const items = factValueItems(fact);
  const name = label ?? items[0] ?? 'this';
  // "Goals" under the "Goals" group said the same word twice.
  const heading = label && label.toLowerCase() !== groupLabel?.toLowerCase() ? label : null;

  return (
    <div className="group/item row-touch border-b border-border/50 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {heading && (
            <p className="text-micro font-medium uppercase tracking-[0.14em] text-foreground-secondary">{heading}</p>
          )}
          {items.length > 1 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">
              {items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p className={cn('text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]', heading && 'mt-1')}>{items[0]}</p>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-foreground-secondary/70">
            {learned && <span>Learned {timeAgo(learned)}</span>}
            {confirmed && <span>You last said this {timeAgo(confirmed)}</span>}
            {revised && <span>Revised {(fact.revision ?? 1) - 1}&times;</span>}
            {!!fact.retrievalCount && <span>Used {fact.retrievalCount}&times;</span>}
            {evidence && (
              <button
                onClick={() => setShowEvidence((v) => !v)}
                aria-expanded={showEvidence}
                className="tap flex items-center gap-1 rounded text-foreground-secondary/70 underline-offset-2 hover:text-foreground hover:underline"
              >
                <ChevronDown className={cn('h-3 w-3 transition-transform', showEvidence && 'rotate-180')} />
                Why AQUA thinks this
              </button>
            )}
          </div>

          {showEvidence && evidence && (
            <p className="mt-2 border-l-2 border-border pl-3 text-caption italic leading-relaxed text-foreground-secondary [overflow-wrap:anywhere]">
              &ldquo;{evidence}&rdquo;
            </p>
          )}
        </div>

        <div className="affordance flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => onPin(fact.key, !fact.pinned)}
            className="tap touch-lg flex h-8 w-8 items-center justify-center rounded-md text-foreground-secondary transition-colors hover:bg-surface-secondary hover:text-foreground"
            aria-label={fact.pinned ? `Unpin ${name}` : `Pin ${name}`}
            title={fact.pinned ? 'Unpin' : 'Pin so this is never forgotten automatically'}
          >
            {fact.pinned ? <Pin className="h-3.5 w-3.5 fill-current text-primary/70" /> : <PinOff className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => onForget(fact.key)}
            className="tap touch-lg flex h-8 w-8 items-center justify-center rounded-md text-foreground-secondary transition-colors hover:bg-danger/10 hover:text-danger"
            aria-label={`Forget ${name}`}
            title="Forget this"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* One thing Aqua currently holds — from the canonical World Model, which is what
   answers when the database is available. Shows where it was learned, and lets
   the person correct the value or delete it everywhere. */
function sourceLabel(c: CurrentClaim): string {
  if (c.sourceKind === 'user_correction') return 'You corrected this';
  if (c.sourceKind === 'document') return c.sourceName ? `From ${c.sourceName}` : 'From a document you uploaded';
  return 'From a conversation';
}

function ClaimRow({
  claim,
  onCorrect,
  onForget,
}: {
  claim: CurrentClaim;
  onCorrect: (id: string, value: string) => Promise<boolean>;
  onForget: (id: string) => void;
}) {
  const [showQuote, setShowQuote] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const quote = claim.quote && claim.quote.trim() !== claim.statement.trim() ? claim.quote : null;

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    const ok = await onCorrect(claim.claimId, value.trim());
    setSaving(false);
    if (ok) { setEditing(false); setValue(''); }
  }

  return (
    <div className="group/item row-touch border-b border-border/50 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">{claim.statement}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-foreground-secondary/70">
            <span>{sourceLabel(claim)}</span>
            {claim.assertedAt && <span>{timeAgo(new Date(claim.assertedAt).getTime())}</span>}
            {claim.disputed && <span className="text-warning">Conflicts with something else you said</span>}
            {claim.scheduledFrom && <span>Starts {new Date(claim.scheduledFrom).toLocaleDateString()}</span>}
            {quote && (
              <button
                onClick={() => setShowQuote((v) => !v)}
                aria-expanded={showQuote}
                className="tap flex items-center gap-1 rounded text-foreground-secondary/70 underline-offset-2 hover:text-foreground hover:underline"
              >
                <ChevronDown className={cn('h-3 w-3 transition-transform', showQuote && 'rotate-180')} />
                Where Aqua learned this
              </button>
            )}
          </div>
          {showQuote && quote && (
            <p className="mt-2 border-l-2 border-border pl-3 text-caption italic leading-relaxed text-foreground-secondary [overflow-wrap:anywhere]">
              &ldquo;{quote}&rdquo;
            </p>
          )}
          {editing && (
            <form
              className="mt-2 flex flex-wrap items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); void save(); }}
            >
              <input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="What's correct now?"
                aria-label={`Correct value for: ${claim.statement}`}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
              />
              <Button type="submit" size="sm" disabled={saving || !value.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(false); setValue(''); }}>
                Cancel
              </Button>
            </form>
          )}
        </div>

        <div className="affordance flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => { setValue(editing ? '' : (claim.value ?? '')); setEditing((v) => !v); }}
            className="tap touch-lg flex h-8 w-8 items-center justify-center rounded-md text-foreground-secondary transition-colors hover:bg-surface-secondary hover:text-foreground"
            aria-label={`Correct: ${claim.statement}`}
            title="Correct this"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onForget(claim.claimId)}
            className="tap touch-lg flex h-8 w-8 items-center justify-center rounded-md text-foreground-secondary transition-colors hover:bg-danger/10 hover:text-danger"
            aria-label={`Delete: ${claim.statement}`}
            title="Delete this everywhere"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MemoryPage() {
  const navigate = useNavigate();
  const toast = useUiStore((s) => s.toast);
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [changes, setChanges] = useState<MemoryChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [claims, setClaims] = useState<CurrentClaim[]>([]);
  const [hidden, setHidden] = useState<MemoryFact[]>([]);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'fact' | 'claim' | 'hidden'; id: string; label: string } | null>(null);

  const loadClaims = useCallback(async () => {
    // What answers now. Without a World Model (or if it is briefly down) the
    // section is simply absent — the facts below still load.
    try {
      const res = await listCurrentClaims();
      setClaims(res.configured ? res.claims : []);
    } catch {
      setClaims([]);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res] = await Promise.all([listMemory(), loadClaims()]);
      setFacts(res.facts.filter((f) => !f.sensitivity));
      setHidden([...(res.hiddenSensitive ?? []), ...res.facts.filter((f) => f.sensitivity)]);
      // The change feed is a bonus, not the page — a failure here must not
      // take down the facts the user actually came for. A row with nothing
      // human to say ("event", a raw key, an internal operation) is dropped.
      memoryTimeline(30, 8)
        .then((t) => setChanges(t.changes.filter((c) => !isInternalText(c.label))))
        .catch(() => setChanges([]));
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setLoading(false);
    }
  }, [loadClaims]);

  async function handleCorrectClaim(id: string, value: string): Promise<boolean> {
    try {
      await correctClaimValue(id, value);
      toast('success', 'Corrected', 'Aqua will use the new value from now on.');
      await loadClaims();
      return true;
    } catch (err) {
      toast('error', 'Could not correct that', normalizeError(err).message);
      return false;
    }
  }

  /* Deletes (2026-10-28): every one is confirmed first, and a row leaves the
     page only once the server says it is gone. The message on failure is the
     server's own sentence ("Memory is temporarily unavailable — nothing was
     changed"), not a guess that the connection dropped. */
  async function handleForgetClaim(id: string) {
    try {
      await forgetClaim(id);
      setClaims((c) => c.filter((x) => x.claimId !== id));
      toast('success', 'Deleted', 'Aqua will no longer use this anywhere.');
    } catch (err) {
      toast('error', 'Could not delete that', normalizeError(err).message);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, MemoryFact[]>();
    for (const f of facts) {
      // "custom" is the extractor's fallback bucket, not a topic a person has.
      const label = f.category && f.category !== 'custom' ? humanizeKey(f.category) : OTHER_GROUP;
      const bucket = map.get(label) ?? [];
      bucket.push(f);
      map.set(label, bucket);
    }
    // Pinned first within a group, then whatever importance order the server
    // already sorted by — it knows which facts it keeps needing.
    for (const list of map.values()) {
      list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
    }
    // Who you are first, then what you're doing, then what you like; the
    // catch-all last. Size used to decide, so "Other things you've said"
    // could lead the page.
    const rank = (label: string) => {
      if (label === OTHER_GROUP) return GROUP_ORDER.length + 1;
      const i = GROUP_ORDER.indexOf(label.toLowerCase());
      return i === -1 ? GROUP_ORDER.length : i;
    };
    return [...map.entries()].sort((a, b) => (rank(a[0]) - rank(b[0])) || (b[1].length - a[1].length));
  }, [facts]);

  const lastLearned = useMemo(
    () => facts.reduce((max, f) => Math.max(max, f.updatedAt ?? f.createdAt ?? f.ts ?? 0), 0),
    [facts],
  );

  async function handlePin(key: string, pinned: boolean) {
    const prev = facts;
    setFacts((f) => f.map((x) => (x.key === key ? { ...x, pinned } : x)));
    try {
      await pinMemoryFact(key, pinned);
    } catch {
      setFacts(prev);
      toast('error', pinned ? 'Could not pin that' : 'Could not unpin that');
    }
  }

  async function handleForget(key: string) {
    try {
      await forgetMemoryFact(key);
      setFacts((f) => f.filter((x) => x.key !== key));
      toast('success', 'Forgotten', 'AQUA no longer remembers that.');
    } catch (err) {
      toast('error', 'Could not forget that', normalizeError(err).message);
    }
  }

  async function handleForgetHidden(key: string) {
    try {
      await forgetMemoryFact(key);
      setHidden((h) => h.filter((x) => x.key !== key));
      toast('success', 'Deleted', 'AQUA no longer has this anywhere.');
    } catch (err) {
      toast('error', 'Could not delete that', normalizeError(err).message);
    }
  }

  function confirmDelete() {
    const p = pendingDelete;
    if (!p) return;
    if (p.kind === 'claim') void handleForgetClaim(p.id);
    else if (p.kind === 'hidden') void handleForgetHidden(p.id);
    else void handleForget(p.id);
  }

  async function handleKeepHidden(key: string) {
    try {
      const res = await keepSensitiveFact(key);
      setHidden((h) => h.map((x) => (x.key === key ? { ...x, ...(res.fact ?? {}), sensitivityReviewedAt: Date.now() } : x)));
      toast('success', 'Kept', 'It stays saved and stays out of your chats.');
    } catch (err) {
      toast('error', 'Could not save that', normalizeError(err).message);
    }
  }

  // Clears the World Model too (memory/forget.js forgetAllFacts). The page used
  // to empty only the notes list, so "What Aqua knows now" kept showing claims
  // the server had just deleted. Now the page re-reads what is actually left.
  async function handleForgetAll() {
    try {
      await forgetAllMemory();
      toast('success', 'Memory cleared', 'AQUA starts fresh from your next message.');
    } catch (err) {
      toast('error', 'Could not clear memory', normalizeError(err).message);
    }
    await load();
  }

  if (loading) return <CenterNote>Reading what AQUA remembers&hellip;</CenterNote>;

  if (error) {
    return (
      <CenterNote>
        <p className="text-foreground">Memory couldn&rsquo;t load.</p>
        <p className="mt-1 text-sm text-foreground-secondary">{error}</p>
        <button
          onClick={() => void load()}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-secondary"
        >
          <RefreshCcw className="h-4 w-4" /> Try again
        </button>
      </CenterNote>
    );
  }

  if (facts.length === 0 && claims.length === 0 && hidden.length === 0) {
    return (
      <CenterNote>
        <div className="mx-auto mb-6 max-w-md text-left"><ReviewPanel onChanged={() => void load()} /></div>
        <p className="text-lg font-semibold text-foreground">AQUA doesn&rsquo;t know anything about you yet.</p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-foreground-secondary">
          Nothing here is filled in from a form. AQUA picks things up as you work &mdash; what you&rsquo;re building, how
          you like answers, what you keep coming back to &mdash; and everything it learns shows up here for you to
          correct or remove.
        </p>
        <button
          onClick={() => navigate('/')}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          <MessageSquarePlus className="h-4 w-4" /> Start a conversation
        </button>
      </CenterNote>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-10 md:px-8 md:py-14">
        <SectionHeader
          eyebrow="Yours"
          title="What AQUA remembers"
          aside={
            <span className="shrink-0 text-micro tabular-nums text-foreground-secondary">
              {facts.length + claims.length} {facts.length + claims.length === 1 ? 'thing' : 'things'}
              {lastLearned ? ` \u00b7 last ${timeAgo(lastLearned)}` : ''}
            </span>
          }
        />

        <ReviewPanel onChanged={() => void load()} />

        {claims.length > 0 && (
          <section className="mb-10" aria-labelledby="knows-now">
            <h2 id="knows-now" className="mb-1 text-base font-semibold tracking-tight text-foreground">
              What Aqua knows now
            </h2>
            <p className="mb-2 text-body leading-relaxed text-foreground-secondary">
              This is what Aqua answers from. Each item shows where it learned it. Correct anything that&rsquo;s out of
              date, or delete it &mdash; the change applies to every conversation.
            </p>
            <div>
              {claims.map((c) => (
                <ClaimRow key={c.claimId} claim={c} onCorrect={handleCorrectClaim} onForget={(id) => setPendingDelete({ kind: 'claim', id, label: c.statement })} />
              ))}
            </div>
          </section>
        )}

        {changes.length > 0 && (
          <Panel className="mb-10">
            <p className="mb-3 text-micro font-medium uppercase tracking-[0.16em] text-foreground-secondary">
              Recently learned
            </p>
            <ul className="space-y-2">
              {changes.map((c, i) => (
                <li key={`${c.at}-${i}`} className="flex items-baseline gap-3 text-body leading-relaxed">
                  <span className="shrink-0 text-micro tabular-nums text-foreground-secondary/60">{timeAgo(c.at)}</span>
                  <span className="min-w-0 text-foreground-secondary [overflow-wrap:anywhere]">{c.label}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {claims.length > 0 && facts.length > 0 && (
          <div className="mb-4">
            <h2 className="text-base font-semibold tracking-tight text-foreground">Other notes Aqua keeps</h2>
            <p className="mt-1 text-body leading-relaxed text-foreground-secondary">
              Simpler notes from earlier conversations. Aqua only uses one of these when nothing above covers the same
              thing.
            </p>
          </div>
        )}

        {grouped.map(([category, list]) => (
          <section key={category} className="mb-10">
            <h2 className="mb-1 text-base font-semibold tracking-tight text-foreground">{category}</h2>
            <div>
              {list.map((f) => (
                <FactRow key={f.key} fact={f} groupLabel={category} onPin={handlePin} onForget={(key) => setPendingDelete({ kind: 'fact', id: key, label: factHeading(f) ?? factValueItems(f)[0] ?? 'this' })} />
              ))}
            </div>
          </section>
        ))}

        {hidden.length > 0 && (
          <HiddenSensitiveSection
            facts={hidden}
            onDelete={(key) => {
              const f = hidden.find((x) => x.key === key);
              setPendingDelete({ kind: 'hidden', id: key, label: (f && factValueItems(f).join(', ')) || 'this' });
            }}
            onKeep={handleKeepHidden}
          />
        )}

        <div className="mt-12 border-t border-border pt-6">
          <p className="text-body leading-relaxed text-foreground-secondary">
            Everything above is yours. Pin what should never fade, remove anything that&rsquo;s wrong, or clear the lot
            and let AQUA start over.
          </p>
          <Button variant="ghost" size="sm" className="mt-3 text-danger" onClick={() => setConfirmClear(true)}>
            <Trash2 className="h-3.5 w-3.5" /> Forget everything
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Forget everything?"
        description="AQUA will lose all of it and start building its picture of you again from your next message. This can’t be undone."
        confirmLabel="Forget everything"
        destructive
        onConfirm={() => void handleForgetAll()}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        title="Delete this?"
        description={pendingDelete ? `“${pendingDelete.label}” — Aqua stops using it in every conversation. This can’t be undone.` : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}

/* Health and mood details AQUA picked up before it stopped keeping them by
   default. Never used in chat (unless the person turns that on in Settings);
   collapsed, because nobody should open their Memory page to their symptoms. */
export function HiddenSensitiveSection({
  facts,
  onDelete,
  onKeep,
}: {
  facts: MemoryFact[];
  onDelete: (key: string) => void;
  onKeep: (key: string) => void;
}) {
  return (
    <details className="mb-10 rounded-lg border border-border/70 px-4 py-3" data-testid="hidden-sensitive">
      <summary className="cursor-pointer text-sm font-semibold text-foreground">
        Hidden from AQUA &mdash; sensitive ({facts.length})
      </summary>
      <p className="mt-2 text-caption leading-relaxed text-foreground-secondary">
        Health and mood details. AQUA does not use these in your chats. Delete them, or keep them saved.
      </p>
      <ul className="mt-2">
        {facts.map((f) => {
          const items = factValueItems(f);
          const text = items.join(', ') || 'Untitled';
          return (
            <li key={f.key} className="flex items-center gap-3 border-b border-border/50 py-2 last:border-b-0">
              <span className="min-w-0 flex-1 text-sm text-foreground [overflow-wrap:anywhere]">{text}</span>
              {f.sensitivityReviewedAt ? (
                <span className="text-micro text-foreground-secondary">Kept</span>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => onKeep(f.key)} aria-label={`Keep: ${text}`}>
                  Keep
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => onDelete(f.key)} aria-label={`Delete: ${text}`}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function CenterNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8 text-center text-sm text-foreground-secondary">
      <div>{children}</div>
    </div>
  );
}
