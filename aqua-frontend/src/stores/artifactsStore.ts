import { create } from 'zustand';
import { listArtifacts, renameArtifact, deleteArtifact, regenerateArtifact } from '@/api/artifacts';
import { useChatStore } from './chatStore';
import { useUiStore } from './uiStore';
import type { ArtifactListEntry, ArtifactManifest } from '@/types';

/**
 * Artifacts panel (P4) — the durable, linkage-free home for everything the
 * Artifact Engine has produced. Chat cards attach by a ts heuristic and can
 * miss after odd histories; this panel lists straight from the store index,
 * so nothing generated is ever unreachable.
 *
 * Scope:
 *   'conversation' — artifacts of the active chat (default when one is open)
 *   'all'          — everything the signed-in owner has
 *
 * Rename/delete are optimistic with rollback-by-reload on failure — the
 * pattern conversationStore uses, sized down.
 */

export type ArtifactScope = 'conversation' | 'all';

interface ArtifactsPanelState {
  open: boolean;
  scope: ArtifactScope;
  items: ArtifactListEntry[];
  loading: boolean;
  loadedOnce: boolean;

  setOpen: (open: boolean) => void;
  setScope: (scope: ArtifactScope) => void;
  load: () => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Live insert when a streaming turn stores an artifact (chatStore onArtifact). */
  upsertFromManifest: (m: ArtifactManifest) => void;
  /** P6 — regenerate an artifact from its stored plan; appends a version. */
  regenerate: (id: string) => Promise<void>;
  /** ids currently regenerating (row spinner + action lock). */
  busy: string[];
}

export const useArtifactsStore = create<ArtifactsPanelState>((set, get) => ({
  open: false,
  scope: 'conversation',
  items: [],
  loading: false,
  loadedOnce: false,
  busy: [],

  setOpen: (open) => {
    set({ open });
    if (open) {
      // Sensible default scope every time it opens: current chat if one is
      // active, otherwise everything.
      const hasConversation = !!useChatStore.getState().conversationId;
      set({ scope: hasConversation ? 'conversation' : 'all' });
      void get().load();
    }
  },

  setScope: (scope) => {
    set({ scope });
    void get().load();
  },

  load: async () => {
    const { scope } = get();
    const conversationId = useChatStore.getState().conversationId;
    if (scope === 'conversation' && !conversationId) {
      set({ items: [], loading: false, loadedOnce: true });
      return;
    }
    set({ loading: true });
    try {
      const res = await listArtifacts(scope === 'conversation' ? { conversationId: conversationId! } : {});
      // Ignore stale responses if scope flipped mid-flight.
      if (get().scope === scope) set({ items: res.artifacts, loading: false, loadedOnce: true });
    } catch {
      set({ loading: false, loadedOnce: true });
      useUiStore.getState().toast('error', 'Could not load artifacts');
    }
  },

  rename: async (id, title) => {
    const prev = get().items;
    set({ items: prev.map(a => a.id === id ? { ...a, title } : a) });
    try {
      await renameArtifact(id, title);
    } catch {
      set({ items: prev });
      useUiStore.getState().toast('error', 'Rename failed');
    }
  },

  remove: async (id) => {
    const prev = get().items;
    set({ items: prev.filter(a => a.id !== id) });
    try {
      await deleteArtifact(id);
      useUiStore.getState().toast('success', 'Artifact deleted');
    } catch {
      set({ items: prev });
      useUiStore.getState().toast('error', 'Delete failed');
    }
  },

  regenerate: async (id) => {
    if (get().busy.includes(id)) return;
    set({ busy: [...get().busy, id] });
    try {
      const res = await regenerateArtifact(id);
      set({ items: get().items.map(a => a.id === id ? {
        ...a,
        version: res.artifact.version,
        totalBytes: res.artifact.totalBytes,
        fileCount: res.artifact.files.length,
        updatedAt: Date.now(),
      } : a) });
      useUiStore.getState().toast('success', `Regenerated — now v${res.artifact.version}`);
    } catch {
      useUiStore.getState().toast('error', 'Regenerate failed — the artifact is unchanged');
    } finally {
      set({ busy: get().busy.filter(b => b !== id) });
    }
  },

  upsertFromManifest: (m) => {
    const { open, scope, items } = get();
    if (!open) return; // panel closed → next open reloads anyway
    if (scope === 'conversation' && m.conversationId !== useChatStore.getState().conversationId) return;
    const entry: ArtifactListEntry = {
      id: m.id, ownerId: null, conversationId: m.conversationId,
      workspaceId: m.workspaceId, format: m.format, title: m.title,
      version: m.version, fileCount: m.files.length, totalBytes: m.totalBytes,
      packaging: m.packaging, createdAt: m.createdAt, updatedAt: m.createdAt,
      downloadUrl: m.downloadUrl,
    };
    set({ items: [entry, ...items.filter(a => a.id !== m.id)] });
  },
}));
