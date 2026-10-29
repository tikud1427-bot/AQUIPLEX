import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ToastAction, ToastItem, ToastVariant } from '@/types';

interface UiState {
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  settingsOpen: boolean;
  projectUploadOpen: boolean;
  toasts: ToastItem[];
  /** Text the composer should take on next render (home-screen threads). Consumed once. */
  composerSeed: { text: string; nonce: number } | null;
  seedComposer: (text: string) => void;
  clearComposerSeed: () => void;

  toggleSidebar: () => void;
  /** Explicit set — the ⌘K handler has to OPEN the sidebar, never flip it. */
  setSidebarCollapsed: (collapsed: boolean) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setProjectUploadOpen: (open: boolean) => void;

  toast: (variant: ToastVariant, title: string, description?: string, action?: ToastAction) => string;
  dismissToast: (id: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      mobileSidebarOpen: false,
      settingsOpen: false,
      projectUploadOpen: false,
      toasts: [],
      composerSeed: null,
      seedComposer: (text) => set({ composerSeed: { text, nonce: Date.now() } }),
      clearComposerSeed: () => set({ composerSeed: null }),

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setProjectUploadOpen: (open) => set({ projectUploadOpen: open }),

      // `action` is optional and additive — every existing caller is
      // unchanged. It exists so a reversible action can offer its own undo
      // rather than leaving the user to hunt for where the thing went.
      toast: (variant, title, description, action) => {
        const id = crypto.randomUUID();
        set({ toasts: [...get().toasts, { id, variant, title, description, action, durationMs: 4500 }] });
        return id;
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
    }),
    {
      name: 'aqua-ui',
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed }),
    },
  ),
);