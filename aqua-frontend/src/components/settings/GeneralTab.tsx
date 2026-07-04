import { useState } from 'react';
import { Laptop, Loader2, Moon, Sun, Trash2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useChatStore } from '@/stores/chatStore';
import { useUiStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';
import type { ThemeMode, FontSize } from '@/types';

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: React.ElementType }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Laptop },
];

const FONT_OPTIONS: Array<{ value: FontSize; label: string }> = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Default' },
  { value: 'lg', label: 'Large' },
];

export function GeneralTab() {
  const { theme, setTheme, fontSize, setFontSize, compactMode, setCompactMode } = useSettingsStore();
  const conversationCount = useConversationStore((s) => s.items.length);
  const clearAll = useConversationStore((s) => s.clearAll);
  const newConversation = useChatStore((s) => s.newConversation);
  const toast = useUiStore((s) => s.toast);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function handleClearAll() {
    setClearing(true);
    const { succeeded, failed } = await clearAll();
    setClearing(false);
    setConfirming(false);
    newConversation();
    if (failed > 0) {
      toast('warning', `Cleared ${succeeded} conversation${succeeded === 1 ? '' : 's'}`, `${failed} could not be deleted — try again.`);
    } else {
      toast('success', `Cleared ${succeeded} conversation${succeeded === 1 ? '' : 's'}`);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-sm font-medium text-foreground">Theme</p>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTheme(opt.value)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs font-medium transition-colors',
                theme === opt.value ? 'border-primary bg-primary/5 text-primary' : 'border-border text-foreground-secondary hover:bg-surface-secondary',
              )}
            >
              <opt.icon className="h-4 w-4" />
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-foreground">Font size</p>
        <div className="grid grid-cols-3 gap-2">
          {FONT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFontSize(opt.value)}
              className={cn(
                'rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                fontSize === opt.value ? 'border-primary bg-primary/5 text-primary' : 'border-border text-foreground-secondary hover:bg-surface-secondary',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">Compact mode</p>
          <p className="text-xs text-foreground-secondary">Tighter spacing between messages</p>
        </div>
        <Switch checked={compactMode} onCheckedChange={setCompactMode} />
      </div>

      <Separator />

      <div>
        <p className="mb-2 text-sm font-medium text-danger">Danger zone</p>
        <div className="flex items-center justify-between rounded-lg border border-danger/20 bg-danger/5 p-3">
          <div>
            <p className="text-sm text-foreground">Clear all chats</p>
            <p className="text-xs text-foreground-secondary">
              Permanently deletes {conversationCount} conversation{conversationCount === 1 ? '' : 's'} from the server.
            </p>
          </div>
          {confirming ? (
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={clearing}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" onClick={handleClearAll} disabled={clearing}>
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Confirm
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setConfirming(true)} disabled={conversationCount === 0}>
              <Trash2 className="h-3.5 w-3.5" /> Clear all
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
