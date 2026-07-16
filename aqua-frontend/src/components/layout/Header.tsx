import { useEffect } from 'react';
import { Menu, Package, PanelLeftOpen, Wallet } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useUiStore } from '@/stores/uiStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useWalletStore } from '@/stores/walletStore';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { useArtifactsStore } from '@/stores/artifactsStore';

/**
 * P1 (freemium) — remaining-quota visibility. Users should never discover
 * their balance by hitting a wall mid-thought. Hides itself when billing is
 * unreachable (dev / logged out / older backend) and for unlimited accounts.
 * Amber under 3 messages' worth so the warning lands BEFORE the dead end.
 */
function CreditsChip() {
  const wallet = useWalletStore((s) => s.wallet);
  const refresh = useWalletStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('visibilitychange', onFocus);
    return () => window.removeEventListener('visibilitychange', onFocus);
  }, [refresh]);

  if (!wallet || wallet.unlimited) return null;
  const low = wallet.total < 15; // chat costs 5 — amber with ~2 messages left

  return (
    <a
      href="/wallet"
      className={
        'tap flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors ' +
        (low
          ? 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/15'
          : 'border-border text-foreground-secondary hover:bg-surface-secondary hover:text-foreground')
      }
      title={low ? 'Running low — top up to keep going' : 'Credits remaining'}
      aria-label={`${wallet.total} credits remaining`}
    >
      <Wallet className="h-3.5 w-3.5" />
      <span className="tabular-nums">{wallet.total}</span>
    </a>
  );
}

export function Header() {
  const isMobile = useIsMobile();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const { pathname } = useLocation();
  const openArtifacts = useArtifactsStore((s) => s.setOpen);
  const items = useConversationStore((s) => s.items);

  const activeId = pathname.startsWith('/c/') ? pathname.slice(3) : null;
  const activeTitle = activeId ? items.find((c) => c.id === activeId)?.title : null;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-[env(safe-area-inset-top)] md:h-14 md:px-4">
      {isMobile ? (
        <button
          onClick={() => setMobileSidebarOpen(true)}
          className="tap flex h-9 w-9 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground"
          aria-label="Open menu"
        >
          <Menu className="h-4.5 w-4.5" />
        </button>
      ) : (
        sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            className="tap flex h-8 w-8 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground"
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )
      )}
      {activeTitle ? (
        <span className="truncate text-sm font-medium text-foreground">{activeTitle}</span>
      ) : (
        <div className="flex min-w-0 items-baseline gap-1.5 leading-none">
          <span className="text-sm font-semibold tracking-tight text-foreground">AQUA</span>
          <span className="truncate text-[11px] font-medium text-foreground-secondary/70">
            AI Engineering Workspace
          </span>
        </div>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <CreditsChip />
        <button
          onClick={() => openArtifacts(true)}
          className="tap flex h-8 w-8 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground"
          aria-label="Open artifacts"
          title="Artifacts"
        >
          <Package className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
