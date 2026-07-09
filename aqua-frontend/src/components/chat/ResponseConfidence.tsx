import { CheckCircle2, Circle, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { MessageDiagnostics, UiMessage } from '@/types';

type ConfidenceLevel = 'High' | 'Medium' | 'Low';

const LEVEL_VARIANT: Record<ConfidenceLevel, 'success' | 'warning' | 'default'> = {
  High: 'success',
  Medium: 'warning',
  Low: 'default',
};

/**
 * Compact grounding indicator for repository-aware answers (spec §9).
 *
 * Only renders when `workspace.contextInjected` is true — for ordinary
 * conversation (no project loaded) there's nothing to be confident about,
 * and the spec itself scopes this to "repository-aware responses" only.
 *
 * Deliberately NOT wired to `diagnostics.confidence` — that field is the
 * task-type classifier's confidence (see DiagnosticsPanel), a different
 * thing with a different meaning. Relabeling it here would misrepresent
 * what the number is. Level is instead derived from two real, disclosed
 * signals: how many source files actually grounded the answer, and whether
 * the pipeline's own verification pass ran and passed.
 */
export function ResponseConfidence({
  workspace,
  verification,
}: {
  workspace?: UiMessage['workspace'];
  verification?: MessageDiagnostics['verification'];
}) {
  if (!workspace?.contextInjected) return null;

  const fileCount = workspace.filesReferenced?.length ?? 0;
  const verified = !!(verification?.ran && verification?.passed);

  const level: ConfidenceLevel =
    fileCount >= 3 || (fileCount >= 1 && verified) ? 'High' : fileCount >= 1 ? 'Medium' : 'Low';

  const signals: { label: string; met: boolean }[] = [
    {
      label: fileCount > 0
        ? `${fileCount} source file${fileCount === 1 ? '' : 's'} referenced`
        : 'No specific files referenced',
      met: fileCount > 0,
    },
    {
      label: verified ? 'Cross-checked against codebase' : 'Not independently verified',
      met: verified,
    },
  ];

  return (
    <div className="mt-2 inline-flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 bg-surface-secondary/40 px-2.5 py-1.5 text-[11px]">
      <span className="flex items-center gap-1.5 font-medium text-foreground-secondary">
        <ShieldCheck className="h-3 w-3" />
        Confidence
        <Badge variant={LEVEL_VARIANT[level]}>{level}</Badge>
      </span>
      {signals.map((s) => (
        <span key={s.label} className="flex items-center gap-1 text-foreground-secondary/80">
          {s.met ? (
            <CheckCircle2 className="h-3 w-3 text-success" />
          ) : (
            <Circle className="h-3 w-3 text-foreground-secondary/30" />
          )}
          {s.label}
        </span>
      ))}
    </div>
  );
}
