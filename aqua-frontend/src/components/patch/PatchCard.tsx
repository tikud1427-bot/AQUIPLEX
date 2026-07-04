import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, Copy,
  FileCode2, FileDiff, FilePlus2, FileX2, GitBranch, Link2, Loader2,
  ShieldAlert, ShieldCheck, Undo2, X, XCircle,
} from 'lucide-react';
import { DiffView } from './DiffView';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { applyPatch, rejectPatch, revertPatch } from '@/api/edits';
import { useChatStore } from '@/stores/chatStore';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { cn } from '@/lib/utils';
import type { ApplyConflict, PatchFileDiff, PatchProposal } from '@/types';

/**
 * Day 4 — patch preview + review workflow.
 *
 * Renders under the assistant's explanation:
 *   header      summary · files-changed / +added / −removed chips · status badge
 *   verify bar  static verification result (pass / warnings with detail)
 *   files       per-file collapsible diff sections with change-type icon,
 *               per-file stats, per-file explanation
 *   related     "may need follow-up" file chips from the dependency graph
 *   footer      Apply / Reject (proposed) · Applied✓ + Revert (applied) ·
 *               conflict panel with per-file reasons on 409
 *
 * Nothing is ever applied without the user pressing Apply — the backend
 * enforces the same invariant (atomic, hash-conflict-checked).
 */

function changeIcon(t: PatchFileDiff['changeType']) {
  if (t === 'create') return <FilePlus2 className="h-3.5 w-3.5 text-success" />;
  if (t === 'delete') return <FileX2 className="h-3.5 w-3.5 text-danger" />;
  return <FileCode2 className="h-3.5 w-3.5 text-primary" />;
}

function StatChip({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="flex items-center gap-1 font-mono text-[11px]">
      <span className="text-success">+{added}</span>
      <span className="text-danger">−{removed}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: PatchProposal['status'] }) {
  const styles: Record<string, string> = {
    proposed: 'bg-primary/10 text-primary border-primary/25',
    applied:  'bg-success/10 text-success border-success/25',
    rejected: 'bg-surface-secondary text-foreground-secondary border-border',
    reverted: 'bg-warning/10 text-warning border-warning/25',
  };
  const labels: Record<string, string> = {
    proposed: 'Awaiting review', applied: 'Applied', rejected: 'Rejected', reverted: 'Reverted',
  };
  return (
    <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', styles[status] ?? styles.proposed)}>
      {labels[status] ?? status}
    </span>
  );
}

function VerificationBar({ v }: { v: PatchProposal['verification'] }) {
  const [open, setOpen] = useState(false);
  if (!v?.ran) return null;
  return (
    <div className={cn('border-t border-border/60', v.passed ? 'bg-success/5' : 'bg-warning/10')}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]"
      >
        {v.passed
          ? <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
          : <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-warning" />}
        <span className={cn('font-medium', v.passed ? 'text-success' : 'text-warning')}>
          {v.passed
            ? `Verification passed — ${v.checks.length} static check${v.checks.length === 1 ? '' : 's'}`
            : `Verification found ${v.warnings.length} issue${v.warnings.length === 1 ? '' : 's'} — review before applying`}
        </span>
        <ChevronDown className={cn('ml-auto h-3.5 w-3.5 text-foreground-secondary transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="space-y-1 px-4 pb-2.5">
          {v.checks.map((c) => (
            <li key={c.id} className="flex items-start gap-1.5 text-[11px] text-foreground-secondary">
              {c.status === 'pass'
                ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                : <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-danger" />}
              <span>{c.label}{c.detail ? ` — ${c.detail}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileSection({ file }: { file: PatchFileDiff }) {
  const [open, setOpen] = useState(true);
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="border-t border-border/60">
      <div className="flex items-center gap-2 bg-surface-secondary/60 px-3 py-1.5">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground-secondary" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground-secondary" />}
          {changeIcon(file.changeType)}
          <code className="truncate font-mono text-[12px] font-medium text-foreground" title={file.path}>
            {file.path}
          </code>
          {file.changeType === 'create' && <span className="rounded bg-success/15 px-1.5 py-px text-[10px] font-medium text-success">new file</span>}
          {file.fuzzyMatched && (
            <Tooltip label="An edit anchor needed whitespace-tolerant matching — worth a second look">
              <span className="rounded bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning">fuzzy match</span>
            </Tooltip>
          )}
        </button>
        <StatChip added={file.stats.added} removed={file.stats.removed} />
        <Tooltip label={copied ? 'Copied' : 'Copy unified diff'}>
          <button
            onClick={() => copy(file.unified)}
            className="rounded p-1 text-foreground-secondary hover:bg-surface hover:text-foreground"
            aria-label="Copy unified diff"
          >
            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          </button>
        </Tooltip>
      </div>
      {open && (
        <>
          {file.explanation && (
            <p className="border-t border-border/40 bg-surface px-3 py-1.5 text-[12px] italic text-foreground-secondary">
              {file.explanation}
            </p>
          )}
          <div className="border-t border-border/40">
            <DiffView file={file} />
          </div>
        </>
      )}
    </div>
  );
}

export const PatchCard = memo(function PatchCard({ patch, messageId }: { patch: PatchProposal; messageId: string }) {
  const updateMessagePatch = useChatStore((s) => s.updateMessagePatch);
  const [busy, setBusy] = useState<null | 'apply' | 'reject' | 'revert'>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ApplyConflict[] | null>(null);

  const proposed = patch.status === 'proposed';
  const applied  = patch.status === 'applied';

  async function run(action: 'apply' | 'reject' | 'revert') {
    setBusy(action);
    setActionError(null);
    setConflicts(null);
    const fn = action === 'apply' ? applyPatch : action === 'reject' ? rejectPatch : revertPatch;
    const res = await fn(patch.workspaceId, patch.id);
    setBusy(null);
    if (res.success) {
      updateMessagePatch(messageId, {
        ...patch,
        status: action === 'apply' ? 'applied' : action === 'reject' ? 'rejected' : 'reverted',
      });
    } else {
      setActionError(res.error ?? 'Action failed.');
      if (res.conflicts?.length) setConflicts(res.conflicts);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="my-3 overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
    >
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
        <FileDiff className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground" title={patch.summary}>
          {patch.summary}
        </span>
        <span className="text-[11px] text-foreground-secondary">
          {patch.stats.filesChanged} file{patch.stats.filesChanged === 1 ? '' : 's'}
        </span>
        <StatChip added={patch.stats.added} removed={patch.stats.removed} />
        <StatusBadge status={patch.status} />
      </div>

      {/* ── Breaking changes / risks ── */}
      {(patch.breakingChanges?.length > 0 || patch.risks?.length > 0) && (
        <div className="border-t border-border/60 bg-warning/5 px-3 py-2">
          {patch.breakingChanges?.length > 0 && (
            <div className="flex items-start gap-1.5 text-[12px] text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span><strong>Breaking:</strong> {patch.breakingChanges.join(' · ')}</span>
            </div>
          )}
          {patch.risks?.length > 0 && (
            <div className={cn('flex items-start gap-1.5 text-[12px] text-foreground-secondary', patch.breakingChanges?.length > 0 && 'mt-1')}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground-secondary/70" />
              <span><strong>Risks:</strong> {patch.risks.join(' · ')}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Verification ── */}
      <VerificationBar v={patch.verification} />

      {/* ── Per-file diffs ── */}
      {patch.files.map((f) => <FileSection key={f.path} file={f} />)}

      {/* ── Skipped operations ── */}
      {patch.failedOperations?.length > 0 && (
        <div className="border-t border-border/60 bg-danger/5 px-3 py-2 text-[12px] text-foreground-secondary">
          <span className="font-medium text-danger">Skipped operations:</span>
          <ul className="mt-1 space-y-0.5">
            {patch.failedOperations.map((fo, i) => (
              <li key={i}>
                <code className="font-mono text-[11px]">{fo.file}</code> — {fo.error}
                {fo.suggestion ? <span className="text-foreground-secondary/80"> ({fo.suggestion})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Related files ── */}
      {patch.relatedFiles?.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2">
          <span className="flex items-center gap-1 text-[11px] font-medium text-foreground-secondary">
            <Link2 className="h-3 w-3" /> May need follow-up:
          </span>
          {patch.relatedFiles.map((rf) => (
            <Tooltip key={rf.path} label={rf.reason}>
              <code className="rounded bg-surface-secondary px-1.5 py-0.5 font-mono text-[10px] text-foreground-secondary">
                {rf.path.split('/').pop()}
              </code>
            </Tooltip>
          ))}
        </div>
      )}

      {/* ── Conflicts (apply failed 409) ── */}
      {conflicts && (
        <div className="border-t border-border/60 bg-danger/5 px-3 py-2 text-[12px]">
          <div className="flex items-center gap-1.5 font-medium text-danger">
            <GitBranch className="h-3.5 w-3.5" /> Patch no longer applies cleanly
          </div>
          <ul className="mt-1 space-y-0.5 text-foreground-secondary">
            {conflicts.map((c) => (
              <li key={c.file}><code className="font-mono text-[11px]">{c.file}</code> — {c.reason}</li>
            ))}
          </ul>
          <p className="mt-1 text-foreground-secondary/80">Ask again to regenerate the patch against the current workspace.</p>
        </div>
      )}
      {actionError && !conflicts && (
        <div className="border-t border-border/60 bg-danger/5 px-3 py-2 text-[12px] text-danger">{actionError}</div>
      )}

      {/* ── Footer: review workflow ── */}
      <div className="flex items-center gap-2 border-t border-border/60 bg-surface-secondary/40 px-3 py-2">
        {patch.provider && (
          <span className="text-[10px] text-foreground-secondary/60">
            via {patch.provider}{patch.latencyMs ? ` · ${(patch.latencyMs / 1000).toFixed(1)}s` : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {proposed && (
            <>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run('reject')}>
                {busy === 'reject' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />} Reject
              </Button>
              <Button size="sm" disabled={busy !== null} onClick={() => run('apply')}>
                {busy === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Apply changes
              </Button>
            </>
          )}
          {applied && (
            <>
              <span className="flex items-center gap-1 text-[12px] font-medium text-success">
                <CheckCircle2 className="h-3.5 w-3.5" /> Applied to workspace
              </span>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run('revert')}>
                {busy === 'revert' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Revert
              </Button>
            </>
          )}
          {patch.status === 'rejected' && <span className="text-[12px] text-foreground-secondary">Changes discarded — nothing was applied.</span>}
          {patch.status === 'reverted' && <span className="text-[12px] text-warning">Reverted — workspace restored.</span>}
        </div>
      </div>
    </motion.div>
  );
});
