import { memo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, RotateCcw } from 'lucide-react';
import { forgetClaim, forgetMemoryFact, correctClaimValue } from '@/api/memory';
import { normalizeError } from '@/api/client';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import type { ChatSuccessResponse } from '@/types';

/**
 * "Context used" — what Aqua knew about the user that was put in front of the
 * model for this answer (server: routes/chat.js `contextUsedItems`). Collapsed
 * by default and absent when nothing about the user was used, so ordinary
 * answers carry nothing extra.
 *
 * Every row can be forgotten (confirmed first; removed only when the server
 * says it worked). A World Model fact can also be corrected in place. After a
 * change the answer it shaped is stale, so the last answer offers Regenerate.
 */
type Item = NonNullable<ChatSuccessResponse['contextUsed']>['items'][number];
type RowState = { status: 'idle' | 'busy' | 'forgotten' | 'corrected' | 'error'; message?: string; text?: string };

export const ContextUsed = memo(function ContextUsed({
  contextUsed,
  onRegenerate,
}: {
  contextUsed?: ChatSuccessResponse['contextUsed'];
  onRegenerate?: () => void;
}) {
  const items = contextUsed?.items ?? [];
  // A reopened answer: items used then and since forgotten (removed) or not
  // readable now (unavailable) are counted, never shown.
  const removed = contextUsed?.removed ?? 0;
  const unavailable = contextUsed?.unavailable ?? 0;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingForget, setPendingForget] = useState<Item | null>(null);
  if (!items.length && !removed && !unavailable) return null;

  const keyOf = (i: Item) => (i.kind === 'claim' ? `c:${i.id}` : `f:${i.key}`);
  const setRow = (i: Item, s: RowState) => setRows((r) => ({ ...r, [keyOf(i)]: s }));
  const changed = Object.values(rows).some((r) => r.status === 'forgotten' || r.status === 'corrected');

  async function forget(i: Item) {
    setRow(i, { status: 'busy' });
    try {
      const res = i.kind === 'claim' ? await forgetClaim(i.id!) : await forgetMemoryFact(i.key!);
      if (!res?.success) throw new Error('not forgotten');
      setRow(i, { status: 'forgotten' });
    } catch (err) {
      setRow(i, { status: 'error', message: normalizeError(err).message });
    }
  }

  async function correct(i: Item) {
    const value = draft.trim();
    if (!value || i.kind !== 'claim') return;
    setRow(i, { status: 'busy' });
    try {
      const res = await correctClaimValue(i.id!, value);
      if (!res?.success) throw new Error('not corrected');
      setRow(i, { status: 'corrected', text: res.statement || value });
      setEditing(null);
    } catch (err) {
      setRow(i, { status: 'error', message: normalizeError(err).message });
    }
  }

  return (
    <div className="mt-2 text-micro text-foreground-secondary/80" data-testid="context-used">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="tap inline-flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-surface-secondary/60 hover:text-foreground"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} aria-hidden="true" />
        Context used · {items.length + removed + unavailable}
      </button>

      {open && (
        <div className="mt-1 rounded-lg border border-border/70 bg-surface-secondary/40 p-2">
          <p className="mb-1.5 text-foreground-secondary/70">What Aqua knew about you and gave the model for this answer.</p>
          <ul className="space-y-1">
            {items.map((i) => {
              const row = rows[keyOf(i)] ?? { status: 'idle' };
              const gone = row.status === 'forgotten';
              return (
                <li key={keyOf(i)} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className={cn('min-w-0 flex-1 text-caption text-foreground [overflow-wrap:anywhere]', gone && 'line-through opacity-60')}>
                    {i.label && <span className="text-foreground-secondary">{i.label}: </span>}
                    {row.status === 'corrected' ? row.text : i.text}
                    {i.disputed && <span className="ml-1 text-foreground-secondary">(you disputed this)</span>}
                    {i.changed && <span className="ml-1 text-foreground-secondary">(since changed)</span>}
                  </span>
                  {gone && <span>Forgotten</span>}
                  {row.status === 'corrected' && <span>Corrected</span>}
                  {row.status === 'error' && <span role="alert" className="text-danger">{row.message}</span>}
                  {!gone && !i.changed && row.status !== 'corrected' && editing !== keyOf(i) && (
                    <span className="flex shrink-0 gap-1">
                      {i.kind === 'claim' && (
                        <button
                          className="tap rounded px-1 underline-offset-2 hover:underline disabled:opacity-50"
                          disabled={row.status === 'busy'}
                          onClick={() => { setEditing(keyOf(i)); setDraft(i.kind === 'claim' ? (i.value ?? '') : ''); }}
                        >
                          Correct
                        </button>
                      )}
                      <button
                        className="tap rounded px-1 underline-offset-2 hover:underline disabled:opacity-50"
                        disabled={row.status === 'busy'}
                        onClick={() => setPendingForget(i)}
                      >
                        Forget
                      </button>
                    </span>
                  )}
                  {editing === keyOf(i) && (
                    <form
                      className="flex w-full gap-1"
                      onSubmit={(e) => { e.preventDefault(); void correct(i); }}
                    >
                      <input
                        autoFocus
                        aria-label="What is actually true"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="What's actually true?"
                        className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-caption text-foreground"
                      />
                      <button type="submit" disabled={!draft.trim() || row.status === 'busy'} className="tap rounded-md bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50">
                        Save
                      </button>
                      <button type="button" onClick={() => setEditing(null)} className="tap rounded-md px-2 py-1 hover:bg-surface-secondary">
                        Cancel
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
          {(removed > 0 || unavailable > 0) && (
            <p className="mt-1.5 text-foreground-secondary/70">
              {removed > 0 && `${removed} more ${removed === 1 ? 'was' : 'were'} used, and ${removed === 1 ? 'has' : 'have'} since been removed.`}
              {removed > 0 && unavailable > 0 && ' '}
              {unavailable > 0 && `${unavailable} couldn’t be checked right now.`}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {changed && onRegenerate && (
              <button onClick={onRegenerate} className="tap inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-foreground hover:bg-surface-secondary">
                <RotateCcw className="h-3 w-3" aria-hidden="true" /> Regenerate with the change
              </button>
            )}
            <Link to="/memory" className="tap underline-offset-2 hover:underline">Everything Aqua remembers</Link>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingForget !== null}
        onOpenChange={(o) => { if (!o) setPendingForget(null); }}
        title="Forget this?"
        description={pendingForget ? `“${pendingForget.text}” — Aqua stops using it in every conversation. This can’t be undone.` : undefined}
        confirmLabel="Forget"
        destructive
        onConfirm={() => { const i = pendingForget; setPendingForget(null); if (i) void forget(i); }}
      />
    </div>
  );
});
