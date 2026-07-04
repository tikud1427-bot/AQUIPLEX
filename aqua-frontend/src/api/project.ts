import { apiClient } from './client';
import type { CreateWorkspaceResponse, UploadFilesResponse, WorkspaceSummary, WorkspaceOverviewResponse } from '@/types';

export async function getWorkspaceOverview(id: string) {
  const { data } = await apiClient.get<WorkspaceOverviewResponse>(
    `/project/workspace/${encodeURIComponent(id)}/overview`,
  );
  return data;
}

export async function createWorkspace(name: string, description?: string) {
  const { data } = await apiClient.post<CreateWorkspaceResponse>('/project/workspace', { name, description });
  return data;
}

/** Raw source files — { path, content } pairs, content as plain text. */
export async function uploadWorkspaceFiles(
  workspaceId: string,
  files: Array<{ path: string; content: string }>,
  onProgress?: (pct: number) => void,
) {
  const { data } = await apiClient.post<UploadFilesResponse>(
    `/project/workspace/${encodeURIComponent(workspaceId)}/files`,
    { files },
    {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    },
  );
  return data;
}

/** Base64-encoded .zip — for a single archive upload (e.g. a whole project folder). */
export async function uploadWorkspaceZip(
  workspaceId: string,
  zipBase64: string,
  onProgress?: (pct: number) => void,
) {
  const { data } = await apiClient.post<UploadFilesResponse>(
    `/project/workspace/${encodeURIComponent(workspaceId)}/files`,
    { zip: zipBase64 },
    {
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    },
  );
  return data;
}

export async function getWorkspace(id: string) {
  const { data } = await apiClient.get(`/project/workspace/${encodeURIComponent(id)}`);
  return data;
}

export async function listWorkspaces() {
  const { data } = await apiClient.get<{ success: true; count: number; workspaces: WorkspaceSummary[] }>(
    '/project/workspaces',
  );
  return data;
}

export async function deleteWorkspace(id: string) {
  const { data } = await apiClient.delete<{ success: true; deleted: string }>(
    `/project/workspace/${encodeURIComponent(id)}`,
  );
  return data;
}
