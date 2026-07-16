import { useCallback } from 'react';
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
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { searchInputId } from '@/components/sidebar/Sidebar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setProjectUploadOpen = useUiStore((s) => s.setProjectUploadOpen);
  const newConversation = useChatStore((s) => s.newConversation);
  const stopGenerating = useChatStore((s) => s.stopGenerating);

  const handlers = {
    onNewChat: useCallback(() => {
      newConversation();
      navigate('/');
    }, [newConversation, navigate]),
    onFocusSearch: useCallback(() => {
      document.getElementById(searchInputId)?.focus();
    }, []),
    onToggleSidebar: toggleSidebar,
    onUploadProject: useCallback(() => setProjectUploadOpen(true), [setProjectUploadOpen]),
    onOpenSettings: useCallback(() => setSettingsOpen(true), [setSettingsOpen]),
    onStopGenerating: stopGenerating,
  };

  useKeyboardShortcuts(handlers);

  return (
    <TooltipProvider>
      <div className="flex h-dvh w-full overflow-hidden bg-background">
        <div className="hidden md:block">
          <Sidebar collapsed={sidebarCollapsed} />
        </div>
        <MobileSidebarDrawer />

        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        </div>
      </div>

      <SettingsDialog />
      <ArtifactsPanel />
      <ToastViewport />
    </TooltipProvider>
  );
}
