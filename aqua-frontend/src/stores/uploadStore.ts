import { create } from 'zustand';
import { createWorkspace, uploadWorkspaceFiles, uploadWorkspaceZip, getWorkspaceOverview } from '@/api/project';
import { normalizeError } from '@/api/client';
import { useChatStore } from './chatStore';
import type { WorkspaceOverview } from '@/types';

export type WorkspaceUploadStatus = 'idle' | 'creating' | 'uploading' | 'indexing' | 'ready' | 'error';

interface UploadState {
  status: WorkspaceUploadStatus;
  progress: number;
  workspaceId: string | null;
  projectName: string | null;
  fileCount: number;
  error: string | null;

  /** Workspace intelligence — generated server-side at index time. */
  overview: WorkspaceOverview | null;
  overviewLoading: boolean;
  /** Dashboard visibility — true right after an upload; user can dismiss. */
  showDashboard: boolean;

  uploadProject: (name: string, files: Array<{ path: string; content: string }>) => Promise<void>;
  uploadProjectZip: (name: string, zipBase64: string) => Promise<void>;
  fetchOverview: (workspaceId: string) => Promise<void>;
  setShowDashboard: (show: boolean) => void;
  reset: () => void;
}

export const useUploadStore = create<UploadState>((set, get) => ({
  status: 'idle',
  progress: 0,
  workspaceId: null,
  projectName: null,
  fileCount: 0,
  error: null,
  overview: null,
  overviewLoading: false,
  showDashboard: false,

  uploadProject: async (name, files) => {
    set({ status: 'creating', progress: 0, error: null, projectName: name, overview: null, showDashboard: false });
    try {
      const ws = await createWorkspace(name);
      set({ status: 'uploading', workspaceId: ws.workspace.id });

      const result = await uploadWorkspaceFiles(ws.workspace.id, files, (pct) => set({ progress: pct }));

      // Overview arrives with the upload response — no extra round trip.
      set({
        status: 'ready', fileCount: result.filesIngested, progress: 100,
        overview: result.overview ?? null, showDashboard: !!result.overview,
      });
      // Attach this workspace to the active conversation so the next chat
      // turn gets relevant file context injected server-side.
      useChatStore.getState().setWorkspaceId(ws.workspace.id);
    } catch (err) {
      set({ status: 'error', error: normalizeError(err).message });
    }
  },

  uploadProjectZip: async (name, zipBase64) => {
    set({ status: 'creating', progress: 0, error: null, projectName: name, overview: null, showDashboard: false });
    try {
      const ws = await createWorkspace(name);
      set({ status: 'uploading', workspaceId: ws.workspace.id });

      const result = await uploadWorkspaceZip(ws.workspace.id, zipBase64, (pct) => set({ progress: pct }));

      set({
        status: 'ready', fileCount: result.filesIngested, progress: 100,
        overview: result.overview ?? null, showDashboard: !!result.overview,
      });
      useChatStore.getState().setWorkspaceId(ws.workspace.id);
    } catch (err) {
      set({ status: 'error', error: normalizeError(err).message });
    }
  },

  /** Lazy-load the cached overview (e.g. when re-opening a workspace). */
  fetchOverview: async (workspaceId) => {
    if (get().overviewLoading) return;
    set({ overviewLoading: true });
    try {
      const res = await getWorkspaceOverview(workspaceId);
      set({ overview: res.overview ?? null, showDashboard: !!res.overview, overviewLoading: false });
    } catch {
      // Non-fatal: dashboard just won't render. Chat still works.
      set({ overviewLoading: false });
    }
  },

  setShowDashboard: (show) => set({ showDashboard: show }),

  reset: () => set({
    status: 'idle', progress: 0, workspaceId: null, projectName: null,
    fileCount: 0, error: null,
    // Deliberately keep overview + showDashboard: reset() fires when the
    // upload dialog closes, which is exactly the moment the dashboard
    // should be visible behind it.
  }),
}));
