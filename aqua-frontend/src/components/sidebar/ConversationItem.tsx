import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { MoreHorizontal, Pin, PinOff, Pencil, Trash2, MessageSquare } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useConversationStore } from '@/stores/conversationStore';
import { useUiStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';
import type { UiConversation } from '@/types';

export function ConversationItem({ conversation, onNavigate }: { conversation: UiConversation; onNavigate?: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [menuOpen, setMenuOpen] = useState(false);
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
          className="h-8 text-xs"
        />
      </div>
    );
  }

  return (
    <NavLink
      to={`/c/${conversation.id}`}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'group/item flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors',
          isActive ? 'bg-surface-secondary text-foreground' : 'text-foreground-secondary hover:bg-surface-secondary/60 hover:text-foreground',
        )
      }
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-50" />
      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
      {conversation.pinned && <Pin className="h-3 w-3 shrink-0 fill-current text-primary/70" />}

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            onClick={(e) => e.preventDefault()}
            className={cn(
              'shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-surface group-hover/item:opacity-100',
              menuOpen && 'opacity-100 bg-surface',
            )}
            aria-label="Conversation options"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem onSelect={() => togglePin(conversation.id)}>
            {conversation.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            {conversation.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setDraft(conversation.title); setRenaming(true); }}>
            <Pencil className="h-3.5 w-3.5" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem destructive onSelect={handleDelete}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </NavLink>
  );
}
