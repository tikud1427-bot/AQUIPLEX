import { SHORTCUTS } from '@/hooks/useKeyboardShortcuts';

export function ShortcutsTab() {
  return (
    <div className="space-y-1">
      {SHORTCUTS.map((s) => (
        <div key={s.id} className="flex items-center justify-between rounded-lg px-2 py-2.5">
          <span className="text-sm text-foreground">{s.label}</span>
          <div className="flex items-center gap-1">
            {s.keys.map((k) => (
              <kbd
                key={k}
                className="rounded-md border border-border bg-surface-secondary px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground-secondary"
              >
                {k}
              </kbd>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
