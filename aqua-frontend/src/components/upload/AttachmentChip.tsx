import { CheckCircle2, FileArchive, FileAudio, FileCode, FileImage, FileText, FileVideo, Loader2, X, XCircle } from 'lucide-react';
import type { PendingAttachment } from '@/stores/attachmentStore';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const KIND_ICON = {
  repository: FileArchive,
  document:   FileText,
  image:      FileImage,
  audio:      FileAudio,
  video:      FileVideo,
  source:     FileCode,
  unknown:    FileText,
} as const;

/**
 * Day 5 — universal attachment chip. Shows kind icon (or an image
 * thumbnail), staged status (Uploading… / Extracting… / Analyzing… /
 * Ready / Failed), and a remove affordance that also detaches the
 * content server-side.
 */
export function AttachmentChip({ attachment, onRemove }: { attachment: PendingAttachment; onRemove: () => void }) {
  const Icon = KIND_ICON[attachment.kind] ?? FileText;
  const busy = attachment.stage === 'uploading' || attachment.stage === 'processing';
  const failed = attachment.stage === 'error';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border py-1.5 pl-2 pr-1.5 text-xs transition-colors',
        failed ? 'border-danger/30 bg-danger/5' : 'border-border bg-surface-secondary',
      )}
      title={failed ? attachment.error : attachment.name}
    >
      {attachment.previewUrl ? (
        <img src={attachment.previewUrl} alt="" className="h-6 w-6 shrink-0 rounded object-cover" />
      ) : (
        <Icon className="h-3.5 w-3.5 shrink-0 text-foreground-secondary" />
      )}

      <div className="flex min-w-0 flex-col">
        <span className="max-w-[150px] truncate font-medium text-foreground">{attachment.name}</span>
        <span className={cn('flex items-center gap-1 text-[10px]', failed ? 'text-danger' : 'text-foreground-secondary/70')}>
          {busy && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {attachment.stage === 'ready' && <CheckCircle2 className="h-2.5 w-2.5 text-success" />}
          {failed && <XCircle className="h-2.5 w-2.5" />}
          {busy ? attachment.stageLabel : failed ? (attachment.error?.slice(0, 40) ?? 'Failed') : `${formatBytes(attachment.sizeBytes)}${attachment.pages ? ` · ${attachment.pages}p` : ''}`}
        </span>
      </div>

      <button
        onClick={onRemove}
        disabled={busy}
        className="rounded p-0.5 text-foreground-secondary/60 hover:bg-surface hover:text-danger disabled:opacity-40"
        aria-label={`Remove ${attachment.name}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
