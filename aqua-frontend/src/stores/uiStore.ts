import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ToastItem, ToastVariant } from '@/types';

interface UiState {
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  settingsOpen: boolean;
  toasts: ToastItem[];

  toggleSidebar: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;

  toast: (variant: ToastVariant, title: string, description?: string) => string;
  dismissToast: (id: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      mobileSidebarOpen: false,
      settingsOpen: false,
      toasts: [],

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),

      toast: (variant, title, description) => {
        const id = crypto.randomUUID();
        set({ toasts: [...get().toasts, { id, variant, title, description, durationMs: 4500 }] });
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
