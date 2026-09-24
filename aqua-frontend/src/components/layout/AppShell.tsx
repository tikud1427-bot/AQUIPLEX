import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { Header } from './Header';
import { MobileSidebarDrawer } from './MobileSidebarDrawer';
import { ToastViewport } from '@/components/feedback/ToastViewport';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { ArtifactsPanel } from '@/components/artifact/ArtifactsPanel';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUiStore } from '@/stores/uiStore';
import { useChatStore } from '@/stores/chatStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { searchInputId } from '@/components/sidebar/Sidebar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const setMobileSidebarOpen = useUiStore((s) => s.setMobileSidebarOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setProjectUploadOpen = useUiStore((s) => s.setProjectUploadOpen);
  const toast = useUiStore((s) => s.toast);
  const newConversation = useChatStore((s) => s.newConversation);
  const stopGenerating = useChatStore((s) => s.stopGenerating);
  const loadSession = useSessionStore((s) => s.load);

  /* Resolve the signed-in identity once, here, rather than inside the account
     control: the sidebar is rendered twice (rail + mobile drawer) and two
     mounts must not mean two lookups. The store starts at 'loading', so the
     control shows a placeholder until this answers. */
  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  /* Surface a failed native OAuth handoff (GET /auth/native/complete →
     /aqua?auth_error=invalid_code — see index.js) as a plain retry prompt
     instead of the silent no-op this previously was. The error code is
     deliberately generic server-side (never reveals missing vs expired vs
     already-used vs wrong — see nativeOAuth.service.js), so every value maps
     to the same message here; there's nothing more specific it would be
     honest to say. Stripped from the URL immediately so refreshing /aqua
     doesn't re-show it. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('auth_error')) return;
    params.delete('auth_error');
    const rest = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
    toast('error', "Sign-in didn't finish", 'Please try Continue with Google again.');
  }, [toast]);

  const handlers = {
    onNewChat: useCallback(() => {
      newConversation();
      navigate('/');
    }, [newConversation, navigate]),
    // ⌘K used to call focus() on an element that isn't rendered whenever the
    // sidebar was collapsed or the mobile drawer was shut — a dead shortcut
    // in exactly the state where finding a conversation is hardest. Reveal
    // the search field first, then focus it once it has mounted.
    onFocusSearch: useCallback(() => {
      const focusSearch = () => {
        const el = document.getElementById(searchInputId) as HTMLInputElement | null;
        if (!el) return false;
        el.focus();
        el.select();
        return true;
      };
      if (focusSearch()) return;
      if (isMobile) setMobileSidebarOpen(true);
      else setSidebarCollapsed(false);
      // Two frames: one for the state commit, one for the paint that mounts it.
      requestAnimationFrame(() => requestAnimationFrame(focusSearch));
    }, [isMobile, setMobileSidebarOpen, setSidebarCollapsed]),
    onToggleSidebar: toggleSidebar,
    onUploadProject: useCallback(() => setProjectUploadOpen(true), [setProjectUploadOpen]),
    onOpenSettings: useCallback(() => setSettingsOpen(true), [setSettingsOpen]),
    onStopGenerating: stopGenerating,
  };

  useKeyboardShortcuts(handlers);

  return (
    <TooltipProvider>
      <div className="flex h-dvh w-full overflow-hidden bg-background">
        {/* Keyboard users otherwise tab the whole sidebar — search field,
            every conversation row and its menu — before reaching the thread
            or the composer. First stop on the page, invisible until focused. */}
        <a
          href="#aqua-main"
          className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:z-[200] focus-visible:rounded-lg focus-visible:border focus-visible:border-border focus-visible:bg-surface focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:font-medium focus-visible:text-foreground focus-visible:shadow-lg"
        >
          Skip to conversation
        </a>

        <div className="hidden md:block">
          <Sidebar collapsed={sidebarCollapsed} />
        </div>
        <MobileSidebarDrawer />

        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <main id="aqua-main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col focus:outline-none">
            {children}
          </main>
        </div>
      </div>

      <SettingsDialog />
      <ArtifactsPanel />
      <ToastViewport />
    </TooltipProvider>
  );
}
