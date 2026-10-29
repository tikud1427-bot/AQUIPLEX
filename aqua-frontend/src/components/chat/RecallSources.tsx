import { memo } from 'react';
import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import type { ChatSuccessResponse } from '@/types';

/**
 * "From your earlier conversations" — where an answer quoted the user's own
 * words from (server: memory/episodicRecall.js). One line, one link per
 * conversation, oldest first; renders nothing when nothing was recalled.
 * The quoted text itself is never sent — the user's conversations are already
 * theirs to open.
 */
type Recall = NonNullable<ChatSuccessResponse['recall']>;

const fmt = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const RecallSources = memo(function RecallSources({ recall, currentConversationId }: { recall?: Recall; currentConversationId?: string | null }) {
  const seen = new Set<string>();
  const items = (recall?.excerpts ?? []).filter((e) => {
    if (!e.conversationId || e.conversationId === currentConversationId || seen.has(e.conversationId)) return false;
    seen.add(e.conversationId);
    return true;
  }).slice(0, 4);
  if (!items.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro text-foreground-secondary/80" aria-label="From your earlier conversations">
      <History className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>From your earlier conversations:</span>
      {items.map((e) => {
        const date = fmt(e.date);
        const label = e.title?.trim() || 'a conversation';
        return (
          <Link
            key={e.conversationId}
            to={`/c/${e.conversationId}`}
            title={date ? `${label} — ${date}` : label}
            className="tap max-w-[220px] truncate rounded-md border border-border/70 bg-surface-secondary/60 px-1.5 py-0.5 transition-colors hover:border-border hover:bg-surface-secondary"
          >
            {label}{date ? ` · ${date}` : ''}
          </Link>
        );
      })}
    </div>
  );
});
