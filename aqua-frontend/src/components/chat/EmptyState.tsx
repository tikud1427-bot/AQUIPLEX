import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, FolderGit2, MessageSquare, Plus } from 'lucide-react';
import { listWorkspaces } from '@/api/project';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useUiStore } from '@/stores/uiStore';
import { useUploadStore } from '@/stores/uploadStore';
import { useWelcomeStore } from '@/stores/welcomeStore';
import { AquaLogo } from '@/components/common/AquaLogo';
import { dateBucket } from '@/lib/format';
import type { WorkspaceSummary } from '@/types';

/* ──────────────────────────────────────────────────────────────────────────
   The opening.

   This used to be nine hardcoded prompt cards — the same nine for every
   person, every session, forever, all of them code chores. A product whose
   entire claim is that it understands your world cannot open with a menu.

   The line under the heading is chosen SERVER-SIDE (GET /brain/welcome,
   aqua/src/brain/welcome): the most relevant current thing in this person's
   world — a deadline at risk, a blocker just resolved, the goal they are
   working toward — read from the World Model with completed, corrected and
   disputed knowledge excluded, and phrased only from their own words. It
   used to be assembled here from the highest-priority legacy goal ("You're
   in the middle of …"), which is how one stale, raw goal title became the
   greeting on every visit. A new account gets an honest invitation; a
   failed read gets a neutral line. Nothing here invents a sentence.
   ────────────────────────────────────────────────────────────────────────── */

/** Shown only when the line could not be fetched — about the screen, not the person. */
const FALLBACK_RETURNING = 'Pick up a thread below, or start something new.';
const FALLBACK_NEW =
  'AQUA reads what you give it once, remembers what matters, and carries it into every conversation after.';

function projectName(ws: WorkspaceSummary): string {
  const name = (ws.meta as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name.trim() ? name : `Project ${ws.id.slice(0, 8)}`;
}

export function EmptyState() {
  const navigate = useNavigate();
  const conversations = useConversationStore((s) => s.items);
  const setProjectUploadOpen = useUiStore((s) => s.setProjectUploadOpen);
  const newConversation = useChatStore((s) => s.newConversation);
  const setWorkspaceId = useChatStore((s) => s.setWorkspaceId);
  const fetchOverview = useUploadStore((s) => s.fetchOverview);

  const welcome = useWelcomeStore((s) => s.welcome);
  const welcomeFailed = useWelcomeStore((s) => s.failed);
  const refreshWelcome = useWelcomeStore((s) => s.refresh);

  const [projects, setProjects] = useState<WorkspaceSummary[]>([]);

  const hasHistory = conversations.length > 0;

  // Re-read on open and on return to the window: the server recomputes from
  // the current world each time, and the store keeps the shown line unless
  // the server's line actually changed.
  useEffect(() => {
    void refreshWelcome({ history: hasHistory });
    const onFocus = () => void refreshWelcome({ history: hasHistory });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [hasHistory, refreshWelcome]);

  // Projects are enrichment, not content. If they never land, the block
  // simply isn't there.
  useEffect(() => {
    listWorkspaces()
      .then((res) => setProjects([...res.workspaces].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3)))
      .catch(() => setProjects([]));
  }, []);

  const recent = useMemo(
    () => [...conversations].filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3),
    [conversations],
  );

  function openProject(ws: WorkspaceSummary) {
    newConversation();
    setWorkspaceId(ws.id);
    void fetchOverview(ws.id);
  }

  const returning = hasHistory || !!welcome?.established;
  // Until the line arrives the paragraph stays empty but keeps its height,
  // so nothing below it moves when it lands.
  const line = welcome?.text ?? (welcomeFailed ? (returning ? FALLBACK_RETURNING : FALLBACK_NEW) : null);

  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-xl"
      >
        <div className="mb-9">
          <div className="mb-5 flex h-10 w-10 items-center justify-center">
            <AquaLogo size={40} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {returning ? 'Welcome back.' : 'What are you working on?'}
          </h1>
          <p
            data-testid="welcome-line"
            aria-busy={line === null}
            className="mt-2 min-h-[2.875rem] max-w-md text-sm leading-relaxed text-foreground-secondary"
          >
            {line}
          </p>
        </div>

        {recent.length > 0 && (
          <Group label="Pick up where you left off">
            {recent.map((c) => (
              <Row key={c.id} icon={MessageSquare} onClick={() => navigate(`/c/${c.id}`)} title={c.title} meta={dateBucket(c.updatedAt)} />
            ))}
          </Group>
        )}

        {projects.length > 0 && (
          <Group label={recent.length > 0 ? 'Or a project' : 'Your projects'}>
            {projects.map((ws) => (
              <Row
                key={ws.id}
                icon={FolderGit2}
                onClick={() => openProject(ws)}
                title={projectName(ws)}
                meta={`${ws.fileCount.toLocaleString()} ${ws.fileCount === 1 ? 'file' : 'files'}`}
              />
            ))}
          </Group>
        )}

        {recent.length === 0 && projects.length === 0 && (
          <button
            onClick={() => setProjectUploadOpen(true)}
            className="tap inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Add a project
          </button>
        )}
      </motion.div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <p className="mb-1 px-1 text-micro font-medium uppercase tracking-[0.14em] text-foreground-secondary/60">
        {label}
      </p>
      <div>{children}</div>
    </section>
  );
}

function Row({
  icon: Icon,
  title,
  meta,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group/item row-touch flex w-full items-center gap-3 rounded-lg px-1 py-2.5 text-left transition-colors hover:bg-surface-secondary/60"
    >
      <Icon className="h-4 w-4 shrink-0 text-foreground-secondary/50" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
      {meta && <span className="shrink-0 text-micro text-foreground-secondary/60">{meta}</span>}
      <ArrowRight className="affordance h-3.5 w-3.5 shrink-0 text-foreground-secondary/50" aria-hidden="true" />
    </button>
  );
}
