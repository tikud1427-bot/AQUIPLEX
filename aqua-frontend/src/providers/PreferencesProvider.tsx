import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const fontSize = useSettingsStore((s) => s.fontSize);
  const compactMode = useSettingsStore((s) => s.compactMode);

  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize;
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.dataset.compact = compactMode ? 'true' : 'false';
  }, [compactMode]);

  return children;
}
