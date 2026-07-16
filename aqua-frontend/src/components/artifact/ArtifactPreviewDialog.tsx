import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getArtifact, previewArtifactFile } from '@/api/artifacts';
import { cn } from '@/lib/utils';
import type { ArtifactFileMeta, ArtifactVersionInfo } from '@/types';

/**
 * Artifact preview (P4) — bounded text preview straight from
 * GET /artifacts/:id/preview. Multi-file artifacts get a file rail; binary
 * files report themselves un-previewable (download is one click away in the
 * panel row). Content is fetched per selected file and cached for the
 * dialog's lifetime.
 */

interface Props {
  artifactId: string | null;
  title?: string;
  onClose: () => void;
}

export function ArtifactPreviewDialog({ artifactId, title, onClose }: Props) {
  const [files, setFiles] = useState<ArtifactFileMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, { text: string; truncated: boolean } | { unpreviewable: true }>>({});
  const [loading, setLoading] = useState(false);
  // P6 — version picker: every stored version is previewable, not just the latest.
  const [versions, setVersions] = useState<number[]>([]);
  const [version, setVersion] = useState<number | null>(null);

  // Load manifest (file list) when the dialog opens.
  useEffect(() => {
    if (!artifactId) return;
    setFiles([]); setSelected(null); setCache({}); setVersions([]); setVersion(null);
    void getArtifact(artifactId)
      .then((res) => {
        setFiles(res.artifact.files);
        setSelected(res.artifact.files[0]?.path ?? null);
        const vs = (res.artifact.versions ?? []).map((v: ArtifactVersionInfo) => v.v);
        setVersions(vs.length ? vs : [res.artifact.version]);
        setVersion(res.artifact.version);
      })
      .catch(() => onClose());
  }, [artifactId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load preview for the selected file.
  const cacheKey = selected && version != null ? `v${version}:${selected}` : null;

  useEffect(() => {
    if (!artifactId || !selected || !cacheKey || cache[cacheKey]) return;
    setLoading(true);
    void previewArtifactFile(artifactId, selected, version ?? undefined)
      .then((res) => {
        setCache((c) => ({
          ...c,
          [cacheKey]: res.previewable
            ? { text: res.text ?? '', truncated: !!res.truncated }
            : { unpreviewable: true },
        }));
      })
      .catch(() => setCache((c) => ({ ...c, [cacheKey]: { unpreviewable: true } })))
      .finally(() => setLoading(false));
  }, [artifactId, selected, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = cacheKey ? cache[cacheKey] : undefined;

  return (
    <Dialog open={!!artifactId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80dvh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{title ?? 'Artifact preview'}</DialogTitle>
        </DialogHeader>

        {versions.length > 1 && (
          <div className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
            <span className="mr-1 text-[11px] text-foreground-secondary">Version</span>
            {versions.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVersion(v)}
                className={cn(
                  'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
                  version === v
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground-secondary hover:bg-surface-secondary hover:text-foreground',
                )}
              >
                v{v}
              </button>
            ))}
          </div>
        )}

        {files.length > 1 && (
          <div className="flex flex-wrap gap-1 border-b border-border pb-2">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelected(f.path)}
                className={cn(
                  'max-w-full truncate rounded-md px-2 py-1 font-mono text-[11px] transition-colors',
                  selected === f.path
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground-secondary hover:bg-surface-secondary hover:text-foreground',
                )}
              >
                {f.path}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface-secondary/40">
          {loading && !current ? (
            <div className="flex items-center gap-2 p-4 text-[12px] text-foreground-secondary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading preview…
            </div>
          ) : current && 'unpreviewable' in current ? (
            <div className="p-4 text-[12px] text-foreground-secondary">
              This file type can't be previewed as text — use Download to open it in its native app.
            </div>
          ) : current ? (
            <>
              <pre className="whitespace-pre-wrap break-words p-3.5 font-mono text-[11.5px] leading-relaxed text-foreground">
                {current.text}
              </pre>
              {current.truncated && (
                <div className="border-t border-border px-3.5 py-2 text-[11px] text-foreground-secondary">
                  Preview truncated — the download contains the full file.
                </div>
              )}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
