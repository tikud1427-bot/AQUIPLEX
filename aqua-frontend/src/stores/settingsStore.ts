import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { FontSize, ThemeMode } from '@/types';

interface SettingsState {
  theme: ThemeMode;
  fontSize: FontSize;
  compactMode: boolean;
  setTheme: (theme: ThemeMode) => void;
  setFontSize: (size: FontSize) => void;
  setCompactMode: (compact: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      fontSize: 'md',
      compactMode: false,
      setTheme: (theme) => set({ theme }),
      setFontSize: (fontSize) => set({ fontSize }),
      setCompactMode: (compactMode) => set({ compactMode }),
    }),
    {
      // Keep in sync with the bootstrap script in index.html, which reads
      // this exact key to set the theme class before first paint.
      name: 'aqua-settings',
    },
  ),
);
