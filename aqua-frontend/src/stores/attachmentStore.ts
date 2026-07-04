/**
 * Universal upload state — Day 5.
 *
 * Drives the premium upload experience in the composer: per-file staged
 * status (Uploading… → Extracting/Analyzing… → Ready), image thumbnails,
 * repository routing, and explicit per-file failures. Everything flows
 * through ONE endpoint (POST /upload); the server decides how each file is
 * processed. Repository results additionally attach a workspace to the
 * active chat and surface the workspace dashboard — exactly what the old
 * Project Upload dialog did, now with zero manual steps.
 */
import { create } from 'zustand';
import { uploadUnified, deleteConversationAttachment, type ServerAttachment, type UploadWorkspaceResult } from '@/api/upload';
import { classifyFile, readAsBase64, MAX_BYTES_BY_KIND, type UploadKind } from '@/utils/uploadKinds';
import { normalizeError } from '@/api/client';
import { useChatStore } from './chatStore';
import { useUploadStore } from './uploadStore';
import { useUiStore } from './uiStore';
import type { WorkspaceOverview } from '@/types';

export type AttachmentStage = 'uploading' | 'processing' | 'ready' | 'error';

export interface PendingAttachment {
  localId: string;
  name: string;
  kind: UploadKind;
  sizeBytes: number;
  stage: AttachmentStage;
  stageLabel: string;
  error?: string;
  /** Server-side attachment id once ready (documents/images/media/source). */
  serverId?: string;
  /** Object URL for image thumbnails — revoked on remove. */
  previewUrl?: string;
  format?: string;
  pages?: number | null;
}

interface AttachmentState {
  items: PendingAttachment[];
  uploading: boolean;
  /** Overall byte-level upload progress (axios), 0–100. */
  progress: number;

  addFiles: (files: File[]) => Promise<void>;
  remove: (localId: string) => Promise<void>;
  clearForNewConversation: () => void;
}

const STAGE_LABEL: Record<UploadKind, string> = {
  repository: 'Extracting & indexing…',
  document:   'Extracting…',
  image:      'Analyzing…',
  audio:      'Transcribing…',
  video:      'Analyzing…',
  source:     'Reading…',
  unknown:    'Processing…',
};

function makeLocalId() {
  return crypto.randomUUID();
}

export const useAttachmentStore = create<AttachmentState>((set, get) => ({
  items: [],
  uploading: false,
  progress: 0,

  addFiles: async (files) => {
    if (!files.length || get().uploading) return;
    const toast = useUiStore.getState().toast;

    // ── Client-side validation: fail fast with clear reasons ──
    const accepted: Array<{ file: File; kind: UploadKind; localId: string }> = [];
    for (const file of files) {
      const kind = classifyFile(file.name);
      if (kind === 'unknown') {
        toast('warning', `Skipped ${file.name}`, 'Unsupported format. AQUA accepts repositories (zip/tar/tar.gz), documents, images, audio, video, and source files.');
        continue;
      }
      if (file.size > MAX_BYTES_BY_KIND[kind]) {
        toast('warning', `${file.name} is too large`, `${kind === 'repository' ? 'Archives' : 'Files of this type'} are limited to ${Math.round(MAX_BYTES_BY_KIND[kind] / 1e6)} MB.`);
        continue;
      }
      accepted.push({ file, kind, localId: makeLocalId() });
    }
    if (!accepted.length) return;

    // ── Stage 1: Uploading… (with image thumbnails immediately) ──
    const pending: PendingAttachment[] = accepted.map(({ file, kind, localId }) => ({
      localId,
      name: file.name,
      kind,
      sizeBytes: file.size,
      stage: 'uploading',
      stageLabel: 'Uploading…',
      previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
    }));
    set((s) => ({ items: [...s.items, ...pending], uploading: true, progress: 0 }));

    try {
      const encoded = await Promise.all(
        accepted.map(async ({ file }) => ({ name: file.name, content: await readAsBase64(file) })),
      );

      // ── Stage 2: server-side processing labels per kind ──
      const flip = (stage: AttachmentStage, label?: string) =>
        set((s) => ({
          items: s.items.map((it) =>
            accepted.some((a) => a.localId === it.localId)
              ? { ...it, stage, stageLabel: label ?? STAGE_LABEL[it.kind] }
              : it,
          ),
        }));

      const res = await uploadUnified(encoded, {
        conversationId: useChatStore.getState().conversationId,
        onProgress: (pct) => {
          set({ progress: pct });
          if (pct >= 100) flip('processing');
        },
      });

      // The upload may have created the conversation — adopt its id so the
      // next chat turn (and further uploads) land in the same conversation.
      if (res.conversationId && !useChatStore.getState().conversationId) {
        useChatStore.setState({ conversationId: res.conversationId });
      }

      // ── Stage 3: reconcile per-file results ──
      set((s) => ({
        items: s.items.map((it) => {
          const match = accepted.find((a) => a.localId === it.localId);
          if (!match) return it;
          const result = res.results.find((r) => r.name === it.name);
          if (!result) return { ...it, stage: 'error', stageLabel: 'Failed', error: 'No result returned for this file' };
          if (result.status === 'failed') return { ...it, stage: 'error', stageLabel: 'Failed', error: result.error };
          const attachment = res.attachments.find((a: ServerAttachment) => a.id === result.attachmentId);
          return {
            ...it,
            stage: 'ready',
            stageLabel: it.kind === 'repository' ? 'Workspace ready' : 'Ready',
            serverId: result.attachmentId,
            format: result.format ?? attachment?.format,
            pages: result.pages ?? attachment?.pages ?? null,
          };
        }),
        uploading: false,
      }));

      // ── Repository experience: attach workspace + show dashboard ──
      if (res.workspace) {
        adoptWorkspace(res.workspace);
        toast('success', `${res.workspace.name} indexed`, `${res.workspace.filesIngested} files — repository chat is ready.`);
      }

      const failures = res.results.filter((r) => r.status === 'failed');
      for (const f of failures) toast('error', `${f.name} failed`, f.error);
    } catch (err) {
      const message = normalizeError(err).message;
      set((s) => ({
        items: s.items.map((it) =>
          accepted.some((a) => a.localId === it.localId)
            ? { ...it, stage: 'error', stageLabel: 'Failed', error: message }
            : it,
        ),
        uploading: false,
      }));
      toast('error', 'Upload failed', message);
    }
  },

  remove: async (localId) => {
    const item = get().items.find((i) => i.localId === localId);
    if (!item) return;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    set((s) => ({ items: s.items.filter((i) => i.localId !== localId) }));
    // Detach server-side too so it stops being injected into chat turns.
    const conversationId = useChatStore.getState().conversationId;
    if (item.serverId && conversationId) {
      try { await deleteConversationAttachment(conversationId, item.serverId); } catch { /* non-fatal */ }
    }
  },

  clearForNewConversation: () => {
    for (const it of get().items) if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
    set({ items: [], uploading: false, progress: 0 });
  },
}));

/** Wire a workspace produced by unified upload into the existing chat + dashboard flow. */
function adoptWorkspace(ws: UploadWorkspaceResult) {
  useChatStore.getState().setWorkspaceId(ws.id);
  // Reuse the existing uploadStore surface so WorkspaceDashboard renders
  // exactly as it does for the legacy Project Upload dialog.
  useUploadStore.setState({
    status: 'ready',
    workspaceId: ws.id,
    projectName: ws.name,
    fileCount: ws.filesIngested,
    overview: (ws.overview as WorkspaceOverview) ?? null,
    showDashboard: !!ws.overview,
    error: null,
    progress: 100,
  });
}
