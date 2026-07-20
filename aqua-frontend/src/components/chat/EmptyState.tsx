import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  FolderSearch, Blocks, SearchCode, Bug, ShieldAlert, Globe,
  FileText, ListChecks, Gauge, Clock,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { AquaLogo } from '@/components/common/AquaLogo';

/** Engineering-focused entry points — replaces the old generic "chat with an
 *  AI" suggestions. Prompts work whether or not a repo is loaded yet; if one
 *  isn't, AQUA's answer naturally points the user at the upload button. */
const SUGGESTIONS = [
  {
    icon: FolderSearch,
    label: 'Analyze this repository',
    prompt: 'Analyze this repository and give me a high-level overview of its architecture, main modules, and how they fit together.',
  },
  {
    icon: Blocks,
    label: 'Explain system architecture',
    prompt: 'Explain the overall system architecture of this project, including how the frontend, backend, and data layers interact.',
  },
  {
    icon: SearchCode,
    label: 'Review my code',
    prompt: 'Review the code in this project and point out any code quality issues, anti-patterns, or areas that need refactoring.',
  },
  {
    icon: Bug,
    label: 'Find bugs',
    prompt: "Look for potential bugs or edge cases that aren't handled correctly in this codebase.",
  },
  {
    icon: ShieldAlert,
    label: 'Detect security issues',
    prompt: 'Scan this project for common security issues — things like injection risks, unsafe auth handling, or exposed secrets.',
  },
  {
    icon: Globe,
    label: 'Explain this API',
    prompt: "Explain the API endpoints exposed by this project — what each one does and how they're structured.",
  },
  {
    icon: FileText,
    label: 'Generate technical documentation',
    prompt: 'Generate technical documentation for this project, covering setup, architecture, and key modules.',
  },
  {
    icon: ListChecks,
    label: 'Create implementation plan',
    prompt: 'Help me create an implementation plan for a new feature — walk me through the steps before I start coding.',
  },
  {
    icon: Gauge,
    label: 'Optimize performance',
    prompt: 'Look for performance bottlenecks in this codebase and suggest concrete optimizations.',
  },
];

export function EmptyState() {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const navigate = useNavigate();
  const conversations = useConversationStore((s) => s.items);

  const recent = useMemo(
    () => [...conversations].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3),
    [conversations],
  );

  return (
    // flex-1 (not h-full) + overflow-y-auto: 9 suggestion cards run taller
    // than the old 4-item grid on short/mobile viewports, so this can no
    // longer assume it always fits — scrolls instead of clipping.
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-3xl"
      >
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center">
            <AquaLogo size={48} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Your Engineering Intelligence Workspace
          </h1>
          <p className="mt-1.5 text-sm text-foreground-secondary">
            Upload a repository or ask AQUA anything about your software project.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SUGGESTIONS.map((s, i) => (
            <motion.button
              key={s.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.04 }}
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