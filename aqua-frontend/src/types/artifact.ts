/**
 * Universal Artifact Engine (P1) — frontend types.
 * Mirrors the backend's publicManifest() (aqua/src/artifacts/engine.js) and
 * the three artifact SSE events chat.js emits. `downloadUrl` is RELATIVE to
 * the API base — prefix with API_BASE_URL (api/artifacts.ts helpers do it).
 */

export interface ArtifactFileMeta {
  path: string;
  size: number;
  mime: string;
}

/** One entry in an artifact's version history (P5/P6). */
export interface ArtifactVersionInfo {
  v: number;
  createdAt: number;
  reason: string;
  bytes: number;
}

export interface ArtifactManifest {
  id: string;
  format: string;
  title: string;
  version: number;
  /** Version history, oldest first. Old versions stay downloadable via ?version=N. */
  versions: ArtifactVersionInfo[];
  files: ArtifactFileMeta[];
  totalBytes: number;
  packaging: 'raw' | 'zip' | 'tar' | 'tar.gz';
  conversationId: string;
  workspaceId: string | null;
  createdAt: number;
  /** Relative to the API base, e.g. `/artifacts/<id>/download`. */
  downloadUrl: string;
}

/** Lite index entry from GET /artifacts (no per-file list). */
export interface ArtifactListEntry {
  id: string;
  ownerId: string | null;
  conversationId: string;
  workspaceId: string | null;
  format: string;
  title: string;
  version: number;
  fileCount: number;
  totalBytes: number;
  packaging: 'raw' | 'zip' | 'tar' | 'tar.gz';
  createdAt: number;
  updatedAt: number;
  downloadUrl: string;
}

/** SSE `artifact_plan` — the validated spec outline, before content builds. */
export interface StreamArtifactPlanEvent {
  format: string;
  title: string;
  files: Array<{ path: string; role: string }>;
  packaging: 'auto' | 'raw' | 'zip' | 'tar' | 'tar.gz';
}

/** SSE `artifact_progress` — one build step finished (index/total are 1-based). */
export interface StreamArtifactProgressEvent {
  stage: 'building';
  path?: string;
  index?: number;
  total?: number;
}
