import { apiClient, API_BASE_URL } from './client';
import type { ArtifactListEntry, ArtifactManifest } from '@/types';

/**
 * Universal Artifact Engine (P1) — REST client for /api/aqua/artifacts.
 * Download/file links are plain hrefs (browser-native download semantics),
 * so the URL helpers return ABSOLUTE paths prefixed with API_BASE_URL —
 * manifests carry API-relative `downloadUrl`s.
 */

export interface GetArtifactResponse {
  success: true;
  artifact: ArtifactManifest & { spec?: unknown; summary?: string };
}

export async function listArtifacts(params: { conversationId?: string; workspaceId?: string } = {}) {
  const { data } = await apiClient.get<{ success: true; artifacts: ArtifactListEntry[] }>('/artifacts', { params });
  return data;
}

export async function getArtifact(id: string) {
  const { data } = await apiClient.get<GetArtifactResponse>(`/artifacts/${encodeURIComponent(id)}`);
  return data;
}

export async function renameArtifact(id: string, title: string) {
  const { data } = await apiClient.patch<{ success: true; artifact: ArtifactManifest }>(
    `/artifacts/${encodeURIComponent(id)}`,
    { title },
  );
  return data;
}

export async function deleteArtifact(id: string) {
  const { data } = await apiClient.delete<{ success: true }>(`/artifacts/${encodeURIComponent(id)}`);
  return data;
}

export interface ArtifactPreviewResponse {
  success: true;
  previewable: boolean;
  path?: string;
  version?: number;
  mime?: string;
  text?: string;
  truncated?: boolean;
}

/** Bounded text preview of one file (text mimes only — binaries report previewable:false). */
export async function previewArtifactFile(id: string, path: string, version?: number) {
  const { data } = await apiClient.get<ArtifactPreviewResponse>(
    `/artifacts/${encodeURIComponent(id)}/preview`,
    { params: version ? { path, version } : { path } },
  );
  return data;
}

/** P5/P6 — apply an edit instruction; appends a new version. */
export async function editArtifact(id: string, instruction: string) {
  const { data } = await apiClient.post<{ success: true; artifact: ArtifactManifest; changed: string[]; summary: string }>(
    `/artifacts/${encodeURIComponent(id)}/edit`,
    { instruction },
  );
  return data;
}

/** P5/P6 — regenerate the whole artifact, or one file of a text/project artifact. */
export async function regenerateArtifact(id: string, path?: string) {
  const { data } = await apiClient.post<{ success: true; artifact: ArtifactManifest; changed: string[] }>(
    `/artifacts/${encodeURIComponent(id)}/regenerate`,
    path ? { path } : {},
  );
  return data;
}

/** Whole-artifact download (single file raw, multi-file zip). */
export function artifactDownloadUrl(id: string, version?: number) {
  const v = version ? `?version=${version}` : '';
  return `${API_BASE_URL}/artifacts/${encodeURIComponent(id)}/download${v}`;
}

/** One file out of a multi-file artifact. */
export function artifactFileUrl(id: string, path: string, version?: number) {
  const v = version ? `&version=${version}` : '';
  return `${API_BASE_URL}/artifacts/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${v}`;
}
