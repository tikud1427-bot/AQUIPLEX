import { useEffect } from 'react';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';

export interface ShortcutDef {
  id: string;
  keys: string[];
  label: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'new-chat', keys: [modKey, 'Shift', 'O'], label: 'New chat' },
  { id: 'focus-search', keys: [modKey, 'K'], label: 'Search conversations' },
  { id: 'toggle-sidebar', keys: [modKey, 'B'], label: 'Toggle sidebar' },
  { id: 'open-settings', keys: [modKey, ','], label: 'Open settings' },
  { id: 'stop-generating', keys: ['Esc'], label: 'Stop generating' },
];

interface Handlers {
  onNewChat: () => void;
  onFocusSearch: () => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onStopGenerating: () => void;
}

export function useKeyboardShortcuts(handlers: Handlers) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const inField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handlers.onNewChat();
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.onFocusSearch();
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        handlers.onToggleSidebar();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        handlers.onOpenSettings();
      } else if (e.key === 'Escape' && !inField) {
        handlers.onStopGenerating();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
