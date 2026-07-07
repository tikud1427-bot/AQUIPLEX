import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { BrainCircuit, PanelLeftClose, PanelLeftOpen, Search, Settings, SquarePen, X } from 'lucide-react';
import { ConversationItem } from './ConversationItem';
import { SidebarSkeleton } from './SidebarSkeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip } from '@/components/ui/tooltip';
import { useConversationStore } from '@/stores/conversationStore';
import { useChatStore } from '@/stores/chatStore';
import { useUiStore } from '@/stores/uiStore';
import { modKey } from '@/hooks/useKeyboardShortcuts';
import { cn } from '@/lib/utils';

interface Props {
  collapsed: boolean;
  isMobileOverlay?: boolean;
  onNavigate?: () => void;
}

export const searchInputId = 'aqua-sidebar-search';

export function Sidebar({ collapsed, isMobileOverlay, onNavigate }: Props) {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);

  const items = useConversationStore((s) => s.items);
  const loading = useConversationStore((s) => s.loading);
  const searchQuery = useConversationStore((s) => s.searchQuery);
  const setSearchQuery = useConversationStore((s) => s.setSearchQuery);
  const fetchConversations = useConversationStore((s) => s.fetchConversations);

  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const newConversation = useChatStore((s) => s.newConversation);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = q ? items.filter((c) => c.title.toLowerCase().includes(q)) : items;
    return [...list].sort((a, b) => b.createdAt - a.createdAt);
  }, [items, searchQuery]);

  const pinned = filtered.filter((c) => c.pinned);
  const unpinned = filtered.filter((c) => !c.pinned);

  function handleNewChat() {
    newConversation();
    navigate('/');
    onNavigate?.();
  }

  if (collapsed && !isMobileOverlay) {
    return (
      <div className="flex h-full w-[60px] flex-col items-center gap-1 border-r border-border bg-surface py-3">
        <Tooltip label="Expand sidebar" side="right">
          <button onClick={toggleSidebar} className="rounded-lg p-2.5 text-foreground-secondary hover:bg-surface-secondary hover:text-foreground">
            <PanelLeftOpen className="h-4.5 w-4.5" />
          </button>
        </Tooltip>
        <Tooltip label="New chat" side="right">
          <button onClick={handleNewChat} className="rounded-lg p-2.5 text-foreground-secondary hover:bg-surface-secondary hover:text-foreground">
            <SquarePen className="h-4.5 w-4.5" />
          </button>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip label="Aqua’s mind" side="right">
          <button onClick={() => { navigate('/mind'); onNavigate?.(); }} className="rounded-lg p-2.5 text-foreground-secondary hover:bg-surface-secondary hover:text-foreground">
            <BrainCircuit className="h-4.5 w-4.5" />
          </button>
        </Tooltip>
        <Tooltip label="Settings" side="right">
          <button onClick={() => setSettingsOpen(true)} className="rounded-lg p-2.5 text-foreground-secondary hover:bg-surface-secondary hover:text-foreground">
            <Settings className="h-4.5 w-4.5" />
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full w-[280px] flex-col bg-surface', !isMobileOverlay && 'border-r border-border')}>
      <div className="flex items-center gap-2 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent">
          <span className="text-[10px] font-bold text-white">AQ</span>
        </div>
        <span className="text-sm font-semibold text-foreground">AQUA</span>
        <div className="flex-1" />
        {isMobileOverlay ? (
          <button onClick={() => setMobileSidebarOpen(false)} className="tap flex h-9 w-9 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground" aria-label="Close menu">
            <X className="h-4.5 w-4.5" />
          </button>
        ) : (
          <Tooltip label={`Collapse sidebar (${modKey}B)`}>
            <button onClick={toggleSidebar} className="tap flex h-8 w-8 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground" aria-label="Collapse sidebar">
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="px-3">
        <button
          onClick={handleNewChat}
          className="tap mb-2 flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-secondary active:bg-surface-secondary"
        >
          <SquarePen className="h-3.5 w-3.5" /> New chat
        </button>

        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-secondary/60" />
          <input
            id={searchInputId}
            ref={searchRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations…"
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-sm text-foreground placeholder:text-foreground-secondary/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 px-2">
        {loading && items.length === 0 ? (
          <SidebarSkeleton />
        ) : filtered.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-xs text-foreground-secondary/60">
            {searchQuery ? 'No conversations match your search.' : 'No conversations yet.'}
          </p>
        ) : (
          <>
            {pinned.length > 0 && (
              <div className="mb-3">
                <p className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground-secondary/60">Pinned</p>
                <div className="space-y-0.5">
                  {pinned.map((c) => (
                    <ConversationItem key={c.id} conversation={c} onNavigate={onNavigate} />
                  ))}
                </div>
              </div>
            )}
            {unpinned.length > 0 && (
              <div className="space-y-0.5 pb-2">
                {pinned.length > 0 && (
                  <p className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground-secondary/60">Recent</p>
                )}
                {unpinned.map((c) => (
                  <ConversationItem key={c.id} conversation={c} onNavigate={onNavigate} />
                ))}
              </div>
            )}
          </>
        )}
      </ScrollArea>

      <div className="border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button
          onClick={() => { navigate('/mind'); onNavigate?.(); }}
          className="tap flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm text-foreground-secondary transition-colors hover:bg-surface-secondary hover:text-foreground"
        >
          <BrainCircuit className="h-4 w-4" />
          Aqua’s mind
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="tap flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm text-foreground-secondary transition-colors hover:bg-surface-secondary hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
          Settings
        </button>
      </div>
    </div>
  );
}
