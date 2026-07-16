import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive, Check, Download, Eye, FileText, Loader2, Package, Pencil,
  RefreshCw, Trash2, X,
} from 'lucide-react';
import { useArtifactsStore } from '@/stores/artifactsStore';
import { useChatStore } from '@/stores/chatStore';
import { artifactDownloadUrl } from '@/api/artifacts';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { ArtifactPreviewDialog } from './ArtifactPreviewDialog';
import { cn } from '@/lib/utils';
import type { ArtifactListEntry } from '@/types';

/**
 * Artifacts panel (P4) — right-side slide-over listing everything the
 * Artifact Engine has stored: the durable home that chat-card heuristics
 * can't miss. Scope toggles between the active chat and all artifacts;
 * every row carries preview / download / rename / delete.
 */

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function Row({ a, onPreview }: { a: ArtifactListEntry; onPreview: (a: ArtifactListEntry) => void }) {
  const rename = useArtifactsStore((s) => s.rename);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useArtifactsStore((s) => s.remove);
  const regenerate = useArtifactsStore((s) => s.regenerate);
  const busy = useArtifactsStore((s) => s.busy.includes(a.id));

  const commit = () => {
    const title = draft.trim();
    setEditing(false);
    if (title && title !== a.title) void rename(a.id, title);
    else setDraft(a.title);
  };

  return (
    <li className="group rounded-lg border border-border bg-surface px-2.5 py-2 transition-colors hover:border-primary/30">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
          {a.format === 'project' ? <Archive className="h-3.5 w-3.5 text-primary" /> : <FileText className="h-3.5 w-3.5 text-primary" />}
        </div>

        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1">
              <Input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(a.title); setEditing(false); } }}
                className="h-6 px-1.5 text-[12px]"
              />
              <button type="button" onClick={commit} className="tap text-success" aria-label="Save name">
                <Check className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => { setDraft(a.title); setEditing(false); }} className="tap text-foreground-secondary" aria-label="Cancel rename">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <>
              <div className="truncate text-[12.5px] font-medium text-foreground">{a.title}</div>
              <div className="text-[10.5px] text-foreground-secondary">
                {a.format}{a.version > 1 ? ` · v${a.version}` : ''} · {a.fileCount} file{a.fileCount > 1 ? 's' : ''} · {fmtBytes(a.totalBytes)} · {fmtDate(a.createdAt)}
              </div>
            </>
          )}
        </div>

        <div className={cn('flex shrink-0 items-center gap-0.5 text-foreground-secondary', 'opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100')}>
          <button type="button" onClick={() => onPreview(a)} className="tap rounded p-1 hover:bg-surface-secondary hover:text-foreground" aria-label="Preview">
            <Eye className="h-3.5 w-3.5" />
          </button>
          <a href={artifactDownloadUrl(a.id)} download className="tap rounded p-1 hover:bg-surface-secondary hover:text-foreground" aria-label="Download">
            <Download className="h-3.5 w-3.5" />
          </a>
          <button type="button" onClick={() => { setDraft(a.title); setEditing(true); }} className="tap rounded p-1 hover:bg-surface-secondary hover:text-foreground" aria-label="Rename">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void regenerate(a.id)}
            className="tap rounded p-1 hover:bg-surface-secondary hover:text-foreground disabled:opacity-50"
            aria-label="Regenerate"
            title="Regenerate from the original plan (keeps every earlier version)"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
          </button>
          <button type="button" onClick={() => setConfirmDelete(true)} className="tap rounded p-1 hover:bg-danger/10 hover:text-danger" aria-label="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${a.title}"?`}
        description="The artifact and every generated file in it are removed permanently."
        confirmLabel="Delete"
        destructive
        onConfirm={() => void remove(a.id)}
      />
    </li>
  );
}

export function ArtifactsPanel() {
  const { open, scope, items, loading, loadedOnce } = useArtifactsStore();
  const setOpen = useArtifactsStore((s) => s.setOpen);
  const setScope = useArtifactsStore((s) => s.setScope);
  const hasConversation = useChatStore((s) => !!s.conversationId);
  const [preview, setPreview] = useState<ArtifactListEntry | null>(null);

  const totalBytes = items.reduce((s, a) => s + a.totalBytes, 0);

  return (
    <>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="artifacts-backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
            />
            <motion.aside
              key="artifacts-panel"
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ type: 'tween', duration: 0.22, ease: 'easeOut' }}
              className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-border bg-background pt-[env(safe-area-inset-top)] shadow-xl"
              aria-label="Artifacts"
            >
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:h-14">
                <Package className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">Artifacts</span>
                {loadedOnce && <span className="text-[11px] text-foreground-secondary">{items.length} · {fmtBytes(totalBytes)}</span>}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="tap ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground"
                  aria-label="Close artifacts"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {hasConversation && (
                <div className="flex gap-1 border-b border-border p-2">
                  {(['conversation', 'all'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setScope(s)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                        scope === s ? 'bg-primary/10 text-primary' : 'text-foreground-secondary hover:bg-surface-secondary hover:text-foreground',
                      )}
                    >
                      {s === 'conversation' ? 'This chat' : 'All artifacts'}
                    </button>
                  ))}
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {loading && !items.length ? (
                  <div className="flex items-center gap-2 p-3 text-[12px] text-foreground-secondary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                  </div>
                ) : items.length ? (
                  <ul className="space-y-1.5">
                    {items.map((a) => <Row key={a.id} a={a} onPreview={setPreview} />)}
                  </ul>
                ) : loadedOnce ? (
                  <div className="p-4 text-center text-[12px] leading-relaxed text-foreground-secondary">
                    Nothing here yet. Ask AQUA to <em>create</em> something —
                    "write my notes as a markdown file", "generate an invoice",
                    "build me a node backend" — and it lands in this panel.
                  </div>
                ) : null}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <ArtifactPreviewDialog
        artifactId={preview?.id ?? null}
        title={preview?.title}
        onClose={() => setPreview(null)}
      />
    </>
  );
}
