import { Menu, Package, PanelLeftOpen } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useUiStore } from '@/stores/uiStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { useArtifactsStore } from '@/stores/artifactsStore';

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
      <button
        onClick={() => openArtifacts(true)}
        className="tap ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-foreground-secondary hover:bg-surface-secondary hover:text-foreground"
        aria-label="Open artifacts"
        title="Artifacts"
      >
        <Package className="h-4 w-4" />
      </button>
    </header>
  );
}
