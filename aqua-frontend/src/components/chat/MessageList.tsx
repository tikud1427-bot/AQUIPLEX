import { AnimatePresence } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { useChatStore } from '@/stores/chatStore';
import { Skeleton } from '@/components/ui/skeleton';

function HistorySkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <div className="flex justify-end">
        <Skeleton className="h-10 w-48 rounded-xl" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-4 w-full max-w-sm" />
          <Skeleton className="h-4 w-2/3 max-w-xs" />
        </div>
      </div>
    </div>
  );
}

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const loadingHistory = useChatStore((s) => s.loadingHistory);
  const { containerRef, pinned, scrollToBottom, handleScroll } = useAutoScroll<HTMLDivElement>([
    messages.length,
    messages[messages.length - 1]?.content,
  ]);

  if (loadingHistory) return <HistorySkeleton />;

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* scroll-behavior kept 'auto': instant scrollTop follow during streaming;
          smooth easing only for the explicit Jump-to-latest button.
          overflow-anchor off — the hook owns anchoring; browser anchoring on
          top of it causes visible jumps when message heights change. */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto [overflow-anchor:none]"
      >
        <div className="mx-auto w-full max-w-3xl py-4">
          <AnimatePresence initial={false}>
            {messages.map((m, i) => (
              <MessageBubble key={m.id} message={m} isLast={i === messages.length - 1} />
            ))}
          </AnimatePresence>
          <div className="h-4" />
        </div>
      </div>

      {!pinned && (
        <button
          onClick={() => scrollToBottom()}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-md transition-transform hover:scale-105"
        >
          <ArrowDown className="h-3 w-3" /> Jump to latest
        </button>
      )}
    </div>
  );
}
