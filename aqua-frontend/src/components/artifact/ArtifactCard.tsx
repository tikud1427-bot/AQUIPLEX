import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Archive, ChevronDown, ChevronRight, Download, FileCode2, FileJson,
  FileSpreadsheet, FileText, FileType2, GitBranch, Globe, Loader2, Table2,
  TerminalSquare,
} from 'lucide-react';
import { artifactDownloadUrl, artifactFileUrl } from '@/api/artifacts';
import { cn } from '@/lib/utils';
import type {
  ArtifactManifest, StreamArtifactPlanEvent, StreamArtifactProgressEvent,
} from '@/types';

/**
 * Artifact Engine P1 — the download card under an assistant turn.
 *
 * Three states, in stream order:
 *   plan      SSE `artifact_plan` — outline chip ("Building · 3 files · md")
 *   progress  SSE `artifact_progress` — per-file build ticks (2/3 · notes.md)
 *   final     SSE `artifact` / done payload / rehydration — title, size,
 *             Download button, expandable per-file list with per-file links
 *
 * Same visual language as PatchCard (rounded-xl bordered surface, chevron
 * expander, uppercase status chip) so edit turns and artifact turns read as
 * siblings in the transcript.
 */

const FORMAT_ICON: Record<string, typeof FileText> = {
  md: FileText, txt: FileText, pdf: FileType2, docx: FileType2,
  html: Globe, css: FileCode2, js: FileCode2, ts: FileCode2, py: FileCode2,
  json: FileJson, xml: FileCode2, yaml: FileCode2, openapi: FileCode2,
  postman: FileJson, csv: Table2, xlsx: FileSpreadsheet,
  svg: FileType2, mermaid: GitBranch, sql: FileCode2,
  sh: TerminalSquare, bat: TerminalSquare, dockerfile: FileCode2,
  k8s: FileCode2, terraform: FileCode2, project: Archive, pptx: FileType2,
};

function formatIcon(format: string) {
  const Icon = FORMAT_ICON[format] ?? FileText;
  return <Icon className="h-4 w-4 text-primary" />;
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface ArtifactCardProps {
  artifact?: ArtifactManifest;
  plan?: StreamArtifactPlanEvent;
  progress?: StreamArtifactProgressEvent;
  streaming: boolean;
}

export const ArtifactCard = memo(function ArtifactCard({
  artifact, plan, progress, streaming,
}: ArtifactCardProps) {
  const [expanded, setExpanded] = useState(false);

  // ── Building state — plan/progress before the manifest lands ──────────────
  if (!artifact) {
    if (!streaming || (!plan && !progress)) return null;
    const total = progress?.total ?? plan?.files.length ?? 0;
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="my-3 overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
      >
        <div className="flex items-center gap-2.5 px-3.5 py-2.5">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-foreground">
              {plan?.title ?? 'Building artifact…'}
            </div>
            <div className="truncate text-[11px] text-foreground-secondary">
              {progress?.index != null && total
                ? <>File {progress.index}/{total}{progress.path ? <> · <span className="font-mono">{progress.path}</span></> : null}</>
                : plan
                  ? <>{plan.files.length} file{plan.files.length > 1 ? 's' : ''} · {plan.format}</>
                  : 'Planning…'}
            </div>
          </div>
          {plan && (
            <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {plan.format}
            </span>
          )}
        </div>
      </motion.div>
    );
  }

  // ── Final state — stored artifact with download links ─────────────────────
  const multi = artifact.files.length > 1;
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="my-3 overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          {formatIcon(artifact.format)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">{artifact.title}</div>
          <div className="text-[11px] text-foreground-secondary">
            {artifact.files.length} file{multi ? 's' : ''} · {fmtBytes(artifact.totalBytes)}
            {artifact.packaging !== 'raw' ? ` · downloads as .${artifact.packaging}` : ''}
          </div>
        </div>
        {artifact.version > 1 && (
          <span className="rounded-full border border-border bg-surface-secondary px-1.5 py-0.5 text-[10px] font-semibold text-foreground-secondary">
            v{artifact.version}
          </span>
        )}
        <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
          {artifact.format}
        </span>
        <a
          href={artifactDownloadUrl(artifact.id)}
          download
          className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-secondary px-2.5 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <Download className="h-3.5 w-3.5" /> Download
        </a>
      </div>

      {multi && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="flex w-full items-center gap-1.5 px-3.5 py-2 text-[11px] font-medium text-foreground-secondary transition-colors hover:text-foreground"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {expanded ? 'Hide files' : 'Show files'}
          </button>
          {expanded && (
            <ul className="space-y-0.5 px-3.5 pb-2.5">
              {artifact.files.map((f) => (
                <li key={f.path} className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-surface-secondary">
                  <span className={cn('truncate font-mono text-[11px] text-foreground-secondary')}>{f.path}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-[10px] text-foreground-secondary/70">{fmtBytes(f.size)}</span>
                    <a
                      href={artifactFileUrl(artifact.id, f.path)}
                      download
                      className="text-foreground-secondary transition-colors hover:text-primary"
                      aria-label={`Download ${f.path}`}
                    >
                      <Download className="h-3 w-3" />
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </motion.div>
  );
});
