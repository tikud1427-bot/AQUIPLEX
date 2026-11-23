import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Brain, BrainCircuit, ChevronDown, ChevronRight, FolderGit2, Mail, PanelLeftClose, PanelLeftOpen,
  Search, Settings, SquarePen, X,
} from 'lucide-react';
import { AccountMenu } from './AccountMenu';
import { ConversationItem } from './ConversationItem';
import { SidebarSkeleton } from './SidebarSkeleton';
import { LoadFailed, NoConversations, NoSearchMatch } from './SidebarEmptyStates';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip } from '@/components/ui/tooltip';
import { AquaLogo } from '@/components/common/AquaLogo';
import { useConversationStore } from '@/stores/conversationStore';
import { useChatStore } from '@/stores/chatStore';
import { useUiStore } from '@/stores/uiStore';
import { modKey } from '@/hooks/useKeyboardShortcuts';
import { DATE_BUCKETS, dateBucket, type DateBucket } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { UiConversation } from '@/types';

interface Props {
  collapsed: boolean;
  isMobileOverlay?: boolean;
  onNavigate?: () => void;
}

export const searchInputId = 'aqua-sidebar-search';

/* The user's world — the second tier of the sidebar.
   The first tier is the conversation, which is the product. The second is
   everything the conversation draws on. These live in the footer rather than
   the scroll area so a hundred threads can never bury them, and below the
   list rather than above it because the brief puts conversations first. */
const WORLD = [
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
  { to: '/memory', label: 'Memory', icon: Brain },
  { to: '/mind', label: 'Understanding', icon: BrainCircuit },
  { to: '/email', label: 'Email', icon: Mail },   // Gmail Phase 5: the user's own email knowledge (model-free)
];

const navRow = (isActive: boolean) =>
  cn(
    'tap row-touch flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
    isActive
      ? 'bg-surface-secondary font-medium text-foreground'
      : 'text-foreground-secondary hover:bg-surface-secondary hover:text-foreground',
  );

export function Sidebar({ collapsed, isMobileOverlay, onNavigate }: Props) {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [showArchived, setShowArchived] = useState(false);

  const items = useConversationStore((s) => s.items);
  const loading = useConversationStore((s) => s.loading);
  const loadError = useConversationStore((s) => s.error);
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
    // Latest activity first. Sorting by creation time buried every thread the
    // moment it was a day old, no matter how recently it was used — and it
    // discarded the ordering the server already returns.
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [items, searchQuery]);

  // Archived rows were already flowing through the store and the API but were
  // never filtered out, so anything archived stayed in the main list.
  const active = filtered.filter((c) => !c.archived);
  const archived = filtered.filter((c) => c.archived);
  const pinned = active.filter((c) => c.pinned);
  const unpinned = active.filter((c) => !c.pinned);

  /* Recent, grouped by day. A flat list of a hundred threads is a wall: it
     gives no sense of when anything happened, so scanning it means reading
     every title. Buckets with nothing in them are never rendered. */
  const byDay = useMemo(() => {
    const map = new Map<DateBucket, UiConversation[]>();
    for (const c of unpinned) {
      const b = dateBucket(c.updatedAt);
      const list = map.get(b) ?? [];
      list.push(c);
      map.set(b, list);
    }
    return DATE_BUCKETS.filter((b) => map.has(b)).map((b) => [b, map.get(b)!] as const);
  }, [unpinned]);

  // Searching is a deliberate hunt — never make someone expand a drawer to
  // discover the thing they just searched for.
  const archivedOpen = showArchived || (!!searchQuery.trim() && archived.length > 0);

  function handleNewChat() {
    newConversation();
    navigate('/');
    onNavigate?.();
  }

  if (collapsed && !isMobileOverlay) {
    return (
      <nav aria-label="AQUA" className="flex h-full w-[60px] flex-col items-center gap-1 border-r border-border bg-surface py-3">
        <Tooltip label="Expand sidebar" side="right">
          <button onClick={toggleSidebar} className="tap flex h-11 w-11 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground">
            <PanelLeftOpen className="h-4.5 w-4.5" />
          </button>
        </Tooltip>
        <Tooltip label="New chat" side="right">
          <button onClick={handleNewChat} className="tap flex h-11 w-11 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground">
            <SquarePen className="h-4.5 w-4.5" />
          </button>
        </Tooltip>
        <div className="flex-1" />
        {WORLD.map(({ to, label, icon: Icon }) => (
          <Tooltip key={to} label={label} side="right">
            <NavLink
              to={to}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'tap flex h-11 w-11 items-center justify-center rounded-lg transition-colors',
                  isActive
                    ? 'bg-surface-secondary text-foreground'
                    : 'text-foreground-secondary hover:bg-surface-secondary hover:text-foreground',
                )
              }
            >
              <Icon className="h-4.5 w-4.5" />
            </NavLink>
          </Tooltip>
        ))}
        <Tooltip label="Settings" side="right">
          <button onClick={() => setSettingsOpen(true)} className="tap flex h-11 w-11 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground">
            <Settings className="h-4.5 w-4.5" />
          </button>
        </Tooltip>
        <AccountMenu collapsed />
      </nav>
    );
  }

  return (
    /* 280px of a 768px tablet is 36% of the screen given to a list. The rail
       narrows through the tablet band and only reaches full width once there
       is room for it — the conversation is the product, not the index. */
    <nav
      aria-label="AQUA"
      className={cn(
        'flex h-full w-[248px] flex-col bg-surface lg:w-[280px]',
        isMobileOverlay && 'w-[min(20rem,86vw)]',
        !isMobileOverlay && 'border-r border-border',
      )}
    >
      <div className="flex items-center gap-2 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <AquaLogo size={28} />
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
          className="tap row-touch mb-2 flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-secondary active:bg-surface-secondary"
        >
          <SquarePen className="h-3.5 w-3.5" /> New chat
        </button>

        <div className="relative mb-2" role="search">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-secondary/60" aria-hidden="true" />
          <input
            id={searchInputId}
            ref={searchRef}
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            /* A placeholder is not a label: it disappears the moment there is
               a value, and some screen readers never announce it at all. */
            aria-label="Search conversations"
            placeholder="Search conversations…"
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-sm text-foreground placeholder:text-foreground-secondary/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          />
        </div>
      </div>

      <ScrollArea className="flex-1 px-2">
        {loading && items.length === 0 ? (
          <SidebarSkeleton />
        ) : loadError && items.length === 0 ? (
          <LoadFailed message={loadError} onRetry={() => void fetchConversations()} />
        ) : filtered.length === 0 ? (
          searchQuery ? (
            <NoSearchMatch query={searchQuery.trim()} onClear={() => setSearchQuery('')} />
          ) : (
            <NoConversations />
          )
        ) : (
          <>
            {pinned.length > 0 && (
              <div className="mb-3">
                <GroupLabel>Pinned</GroupLabel>
                <ul className="space-y-0.5">
                  {pinned.map((c) => (
                    <ConversationItem key={c.id} conversation={c} onNavigate={onNavigate} />
                  ))}
                </ul>
              </div>
            )}

            {byDay.map(([bucket, list]) => (
              <div key={bucket} className="mb-3">
                <GroupLabel>{bucket}</GroupLabel>
                <ul className="space-y-0.5">
                  {list.map((c) => (
                    <ConversationItem key={c.id} conversation={c} onNavigate={onNavigate} />
                  ))}
                </ul>
              </div>
            ))}

            {active.length === 0 && archived.length > 0 && !searchQuery && (
              <p className="px-3 py-6 text-center text-caption leading-relaxed text-foreground-secondary/70">
                Everything here is archived. Start a new chat, or reopen one below.
              </p>
            )}

            {archived.length > 0 && (
              <div className="mt-1 border-t border-border/60 pb-2 pt-2">
                <button
                  onClick={() => setShowArchived((v) => !v)}
                  aria-expanded={archivedOpen}
                  className="tap flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-micro font-medium uppercase tracking-wide text-foreground-secondary/60 transition-colors hover:bg-surface-secondary/60 hover:text-foreground-secondary"
                >
                  {archivedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Archived
                  <span className="ml-auto tabular-nums normal-case tracking-normal">{archived.length}</span>
                </button>
                {archivedOpen && (
                  <ul className="mt-0.5 space-y-0.5 opacity-75 transition-opacity hover:opacity-100">
                    {archived.map((c) => (
                      <ConversationItem key={c.id} conversation={c} onNavigate={onNavigate} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </ScrollArea>

      <div className="border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <p className="px-2.5 pb-1 pt-1 text-micro font-medium uppercase tracking-[0.14em] text-foreground-secondary/60">
          Your world
        </p>
        {WORLD.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} onClick={onNavigate} className={({ isActive }) => navRow(isActive)}>
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}

        <div className="mt-1 border-t border-border/60 pt-1">
          <button onClick={() => setSettingsOpen(true)} className={navRow(false)}>
            <Settings className="h-4 w-4 shrink-0" />
            Settings
          </button>
        </div>

        {/* Who you are, and the way out. Last block on purpose: it is the one
            control a trapped user goes looking for, and the bottom-left corner
            is where every product they already use keeps it. Settings stays
            exactly where it was — the two have different jobs. */}
        <div className="mt-1 border-t border-border/60 pt-1">
          <AccountMenu />
        </div>
      </div>
    </nav>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2.5 py-1.5 text-micro font-medium uppercase tracking-wide text-foreground-secondary/60">
      {children}
    </p>
  );
}
