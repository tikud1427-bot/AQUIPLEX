import { FolderGit2, ChevronRight } from 'lucide-react';
import { useUploadStore } from '@/stores/uploadStore';
import { Badge } from '@/components/ui/badge';

/**
 * Compact "Current project" strip. The full WorkspaceDashboard already
 * covers repository overview in depth but only shows pre-chat; this is the
 * lightweight, always-visible companion that stays on screen once the
 * conversation starts, per spec §3. Reuses the same overview object — no
 * new fetch, no new backend surface, no data that isn't already real.
 */
export function ProjectContextBar() {
  const overview = useUploadStore((s) => s.overview);
  const setShowDashboard = useUploadStore((s) => s.setShowDashboard);

  if (!overview) return null;

  const stack = [...(overview.frameworks ?? []), ...(overview.runtime ?? []).slice(0, 2)].slice(0, 4);

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2">
      <button
        onClick={() => setShowDashboard(true)}
        className="group flex w-full items-center gap-2 overflow-hidden rounded-lg border border-border/70 bg-surface-secondary/50 px-3 py-1.5 text-left transition-colors hover:border-primary/30 hover:bg-surface-secondary"
      >
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="truncate text-[12.5px] font-medium text-foreground">{overview.name}</span>

        {stack.length > 0 && (
          <span className="hidden shrink-0 items-center gap-1 sm:flex">
            {stack.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </span>
        )}

        <span className="ml-auto shrink-0 text-[11px] text-foreground-secondary/70">
          {(overview.stats?.fileCount ?? 0).toLocaleString()} files
        </span>
        <Badge variant="success" className="shrink-0">Indexed</Badge>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground-secondary/50 opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </div>
  );
}
