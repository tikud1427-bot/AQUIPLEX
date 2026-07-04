import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Code2, Lightbulb, MessageSquareText, Sparkles, Clock } from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';

const SUGGESTIONS = [
  { icon: Sparkles, label: 'Explain a concept', prompt: 'Explain how React\u2019s reconciliation algorithm works, with an example.' },
  { icon: Code2, label: 'Debug something', prompt: 'Help me debug a race condition in an async function.' },
  { icon: Lightbulb, label: 'Brainstorm ideas', prompt: 'Brainstorm five feature ideas for a habit-tracking app.' },
  { icon: MessageSquareText, label: 'Just chat', prompt: 'What\u2019s something interesting you\u2019ve learned recently?' },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up?';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function EmptyState() {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const navigate = useNavigate();
  const conversations = useConversationStore((s) => s.items);

  const recent = useMemo(
    () => [...conversations].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3),
    [conversations],
  );

  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-2xl"
      >
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-accent shadow-lg shadow-primary/20">
            <span className="text-lg font-bold text-white">AQ</span>
          </div>
          <h1 className="text-2xl font-semibold text-foreground">{greeting()}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">What are we building today?</p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((s, i) => (
            <motion.button
              key={s.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.05 }}
              onClick={() => sendMessage(s.prompt)}
              className="group flex items-start gap-3 rounded-xl border border-border bg-surface p-3.5 text-left transition-all hover:border-primary/30 hover:shadow-sm"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-foreground-secondary transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                <s.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{s.label}</p>
                <p className="mt-0.5 truncate text-xs text-foreground-secondary">{s.prompt}</p>
              </div>
            </motion.button>
          ))}
        </div>

        {recent.length > 0 && (
          <div className="mt-8">
            <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-foreground-secondary">
              <Clock className="h-3 w-3" /> Recent
            </p>
            <div className="space-y-1">
              {recent.map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate(`/c/${c.id}`)}
                  className="w-full truncate rounded-lg px-3 py-2 text-left text-sm text-foreground-secondary transition-colors hover:bg-surface-secondary hover:text-foreground"
                >
                  {c.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
