import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FontSize, ThemeMode } from '@/types';

interface SettingsState {
  theme: ThemeMode;
  fontSize: FontSize;
  compactMode: boolean;
  /** Off by default. Reveals per-response technical details (routing, timing,
   *  capabilities) for debugging. Never exposed to end users unless enabled. */
  developerMode: boolean;
  setTheme: (theme: ThemeMode) => void;
  setFontSize: (size: FontSize) => void;
  setCompactMode: (compact: boolean) => void;
  setDeveloperMode: (on: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      fontSize: 'md',
      compactMode: false,
      developerMode: false,
      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setCompactMode: (compactMode) => set({ compactMode }),
      setDeveloperMode: (developerMode) => set({ developerMode }),
    }),
    {
      // Keep in sync with the bootstrap script in index.html, which reads
      // this exact key to set the theme class before first paint.
      name: 'aqua-settings',
    },
  ),
);
