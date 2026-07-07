import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { MoreHorizontal, Pin, PinOff, Pencil, Trash2, MessageSquare } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { useConversationStore } from '@/stores/conversationStore';
import { useUiStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';
import type { UiConversation } from '@/types';

export function ConversationItem({ conversation, onNavigate }: { conversation: UiConversation; onNavigate?: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const togglePin = useConversationStore((s) => s.togglePin);
  const rename = useConversationStore((s) => s.rename);
  const removeConversation = useConversationStore((s) => s.removeConversation);
  const toast = useUiStore((s) => s.toast);

  function commitRename() {
    const trimmed = draft.trim();
    if (trimmed) rename(conversation.id, trimmed);
    setRenaming(false);
  }

  async function handleDelete() {
    try {
      await removeConversation(conversation.id);
    } catch {
      toast('error', 'Could not delete conversation', 'Check your connection and try again.');
    }
  }

  if (renaming) {
    return (
      <div className="px-1 py-0.5">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') { setDraft(conversation.title); setRenaming(false); }
          }}
          className="h-9 text-sm"
        />
      </div>
    );
  }

  return (
    <>
      <NavLink
        to={`/c/${conversation.id}`}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'group/item relative flex items-center gap-2 rounded-lg py-2 pl-2.5 pr-1.5 text-sm transition-colors',
            isActive
              ? 'bg-surface-secondary font-medium text-foreground'
              : 'text-foreground-secondary hover:bg-surface-secondary/60 hover:text-foreground',
          )
        }
      >
        {({ isActive }) => (
          <>
            {isActive && (
              <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" aria-hidden="true" />
            )}
            <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-50" />
            <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
            {conversation.pinned && (
              <Pin className="h-3 w-3 shrink-0 fill-current text-primary/70" />
            )}

            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  onClick={(e) => e.preventDefault()}
                  className={cn(
                    'tap hover-reveal -my-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-foreground-secondary transition-colors hover:bg-surface hover:text-foreground',
                    menuOpen && 'bg-surface text-foreground',
                  )}
                  aria-label={`Options for ${conversation.title}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom">
                <DropdownMenuItem onSelect={() => togglePin(conversation.id)}>
                  {conversation.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                  {conversation.pinned ? 'Unpin' : 'Pin'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { setDraft(conversation.title); setRenaming(true); }}>
                  <Pencil className="h-3.5 w-3.5" /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => setConfirmOpen(true)}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </NavLink>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete conversation?"
        description={`“${conversation.title}” will be permanently deleted. This can’t be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </>
  );
}
