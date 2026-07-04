import { Menu, PanelLeftOpen } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useUiStore } from '@/stores/uiStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useIsMobile } from '@/hooks/useMediaQuery';

export function Header() {
  const isMobile = useIsMobile();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const { pathname } = useLocation();
  const items = useConversationStore((s) => s.items);

  const activeId = pathname.startsWith('/c/') ? pathname.slice(3) : null;
  const activeTitle = activeId ? items.find((c) => c.id === activeId)?.title : null;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:h-14 md:px-4">
      {isMobile ? (
        <button
          onClick={() => setMobileSidebarOpen(true)}
          className="rounded-lg p-2 text-foreground-secondary hover:bg-surface-secondary"
          aria-label="Open menu"
        >
          <Menu className="h-4.5 w-4.5" />
        </button>
      ) : (
        sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            className="rounded-lg p-1.5 text-foreground-secondary hover:bg-surface-secondary hover:text-foreground"
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )
      )}
      <span className="truncate text-sm font-medium text-foreground">{activeTitle ?? 'AQUA'}</span>
    </header>
  );
}
