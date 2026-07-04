import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { CheckCircle2, FolderArchive, Loader2, UploadCloud, XCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUploadStore } from '@/stores/uploadStore';
import { shouldIgnoreClientSide, readAsBase64, readAsText } from '@/utils/projectFiles';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectUploadDialog({ open, onOpenChange }: Props) {
  const [projectName, setProjectName] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const { status, progress, fileCount, error, uploadProject, uploadProjectZip, reset } = useUploadStore();

  const onDrop = useCallback((accepted: File[]) => {
    setLocalError(null);
    setPendingFiles(accepted);
    if (!projectName && accepted.length > 0) {
      const first = accepted[0];
      const guess = first.webkitRelativePath?.split('/')[0] || first.name.replace(/\.zip$/i, '');
      setProjectName(guess);
    }
  }, [projectName]);

  // NOTE: no `accept` filter here on purpose. The previous config
  // ({ 'application/zip': ['.zip'], 'text/plain': [] }) silently rejected
  // almost every real source file on a folder drop — browsers report .js
  // as text/javascript, .json as application/json, .ts as video/mp2t —
  // so a dropped repo shrank to its .txt files with zero feedback. All
  // filtering happens in handleUpload via shouldIgnoreClientSide(), which
  // mirrors the backend's actual rules, and the backend re-filters anyway.
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    disabled: status === 'creating' || status === 'uploading',
    multiple: true,
  });

  // Backend accepts JSON bodies up to 50 MB; base64 inflates ~4/3, so a raw
  // .zip over ~35 MB is guaranteed to bounce with a 413. Fail fast locally
  // with a clearer message instead.
  const MAX_ZIP_BYTES = 35_000_000;
  // Reading a multi-hundred-MB stray file (a .sqlite, a dataset) as text
  // freezes the tab; the backend truncates at 100 KB anyway. Skip early.
  const MAX_LOOSE_FILE_BYTES = 2_000_000;

  async function handleUpload() {
    if (pendingFiles.length === 0) return;
    const name = projectName.trim() || 'Untitled project';
    setLocalError(null);

    try {
      // A single .zip goes through the zip endpoint; anything else is treated
      // as a loose batch of source files and read as text (matching what the
      // backend's ingester actually accepts — see utils/projectFiles.ts).
      if (pendingFiles.length === 1 && pendingFiles[0].name.toLowerCase().endsWith('.zip')) {
        if (pendingFiles[0].size > MAX_ZIP_BYTES) {
          setLocalError('Archive is over 35 MB — remove build artifacts (node_modules, dist) and re-zip.');
          return;
        }
        const base64 = await readAsBase64(pendingFiles[0]);
        await uploadProjectZip(name, base64);
        return;
      }

      const files = [];
      let skipped = 0;
      for (const f of pendingFiles) {
        const relPath = f.webkitRelativePath || f.name;
        if (shouldIgnoreClientSide(relPath) || f.size > MAX_LOOSE_FILE_BYTES) {
          skipped++;
          continue;
        }
        try {
          const content = await readAsText(f);
          files.push({ path: relPath, content });
        } catch {
          skipped++; // unreadable as text (likely binary) — backend would drop it anyway
        }
      }

      if (files.length === 0) {
        setLocalError(
          skipped > 0
            ? 'All selected files were binaries, assets, or too large — nothing to index. Try a .zip of the source tree.'
            : 'No files selected.',
        );
        return;
      }

      await uploadProject(name, files);
    } catch (err) {
      // File reads can reject (permissions, file moved after selection);
      // previously this escaped the click handler as an unhandled rejection
      // and the dialog silently did nothing.
      setLocalError(err instanceof Error ? err.message : 'Could not read the selected files.');
    }
  }

  function handleClose(next: boolean) {
    if (!next) {
      reset();
      setPendingFiles([]);
      setProjectName('');
      setLocalError(null);
    }
    onOpenChange(next);
  }

  const busy = status === 'creating' || status === 'uploading';
  const done = status === 'ready';

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload project</DialogTitle>
          <DialogDescription>
            Give AQUA a codebase to reference — drop a .zip or a folder of source files. Binary files and assets
            (images, PDFs, fonts) are skipped automatically; only text and source code get indexed.
          </DialogDescription>
        </DialogHeader>

        {!done ? (
          <div className="space-y-4">
            <Input
              placeholder="Project name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              disabled={busy}
            />

            <div
              {...getRootProps()}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors',
                isDragActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
                busy && 'pointer-events-none opacity-60',
              )}
            >
              <input {...getInputProps()} />
              {busy ? (
                <Loader2 className="h-7 w-7 animate-spin text-primary" />
              ) : (
                <UploadCloud className="h-7 w-7 text-foreground-secondary" />
              )}
              <p className="text-sm font-medium text-foreground">
                {busy
                  ? status === 'creating'
                    ? 'Creating workspace…'
                    : `Uploading… ${progress}%`
                  : pendingFiles.length > 0
                    ? `${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'} selected`
                    : 'Drop a .zip or files here, or click to browse'}
              </p>
              {!busy && pendingFiles.length === 0 && (
                <p className="text-xs text-foreground-secondary/70">.zip archives work best for whole projects</p>
              )}
            </div>

            {(error || localError) && (
              <div className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger">
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {localError ?? error}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
              <CheckCircle2 className="h-6 w-6 text-success" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">{projectName} indexed</p>
              <p className="text-xs text-foreground-secondary">
                {fileCount} file{fileCount === 1 ? '' : 's'} analyzed — the workspace overview is ready behind this
                dialog, with suggested questions to get you started.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {done ? (
            <Button onClick={() => handleClose(false)}>View overview</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => handleClose(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={handleUpload} disabled={busy || pendingFiles.length === 0}>
                <FolderArchive className="h-3.5 w-3.5" />
                {busy ? 'Uploading…' : 'Upload'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
