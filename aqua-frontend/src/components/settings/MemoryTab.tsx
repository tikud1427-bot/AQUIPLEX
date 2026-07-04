import { useEffect, useState } from 'react';
import { Brain, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { listFacts, deleteFact, clearFacts } from '@/api/memory';
import { normalizeError } from '@/api/client';
import { useChatStore } from '@/stores/chatStore';
import { useUiStore } from '@/stores/uiStore';
import type { MemoryFact } from '@/types';

export function MemoryTab() {
  const conversationId = useChatStore((s) => s.conversationId);
  const toast = useUiStore((s) => s.toast);
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) {
      setFacts([]);
      return;
    }
    setLoading(true);
    setError(null);
    listFacts(conversationId)
      .then((res) => setFacts(res.facts))
      .catch((err) => setError(normalizeError(err).message))
      .finally(() => setLoading(false));
  }, [conversationId]);

  async function handleDelete(key: string) {
    if (!conversationId) return;
    const prev = facts;
    setFacts((f) => f.filter((x) => x.key !== key));
    try {
      await deleteFact(conversationId, key);
    } catch {
      setFacts(prev);
      toast('error', 'Could not delete that fact');
    }
  }

  async function handleClearAll() {
    if (!conversationId) return;
    const prev = facts;
    setFacts([]);
    try {
      await clearFacts(conversationId);
      toast('success', 'Memory cleared for this conversation');
    } catch {
      setFacts(prev);
      toast('error', 'Could not clear memory');
    }
  }

  if (!conversationId) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <Brain className="h-8 w-8 text-foreground-secondary/40" />
        <p className="text-sm text-foreground-secondary">Start a conversation to see what AQUA remembers.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-foreground-secondary" />
      </div>
    );
  }

  if (error) {
    return <p className="py-6 text-center text-sm text-danger">{error}</p>;
  }

  if (facts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <Brain className="h-8 w-8 text-foreground-secondary/40" />
        <p className="text-sm text-foreground-secondary">Nothing remembered yet in this conversation.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-foreground-secondary">{facts.length} fact{facts.length === 1 ? '' : 's'} for this conversation</p>
        <Button size="sm" variant="ghost" onClick={handleClearAll} className="text-danger hover:bg-danger/10">
          <Trash2 className="h-3.5 w-3.5" /> Clear all
        </Button>
      </div>
      <div className="max-h-72 space-y-1.5 overflow-y-auto">
        {facts.map((f) => (
          <div key={f.key} className="flex items-start justify-between gap-2 rounded-lg border border-border bg-surface-secondary/40 px-3 py-2">
            <div className="min-w-0">
              <p className="font-mono text-[11px] text-foreground-secondary">{f.key}</p>
              <p className="text-sm text-foreground">{f.value}</p>
            </div>
            <button
              onClick={() => handleDelete(f.key)}
              className="shrink-0 rounded p-1 text-foreground-secondary/50 hover:bg-surface hover:text-danger"
              aria-label={`Forget ${f.key}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
