/**
 * AQUA Workspace Manager
 *
 * Each uploaded project receives a unique workspace ID.
 * Tracks: files, directory structure, metadata, language, indexing status,
 *         summaries, and dependency graph.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  saveWorkspace, loadWorkspace,
  deleteWorkspaceData, getAllWorkspaceIds, getProjectStats,
} from './projectMemory.js';

// ── Public API ────────────────────────────────────────────────────────────────

export function createWorkspace(meta = {}) {
  const id = uuidv4();
  const workspace = {
    id,
    createdAt: Date.now(),
    meta,
    projectType:  null,
    files:        [],       // [{ path, lang, size, summary, parsedAt }]
    structure:    {},       // directory tree
    indexStatus:  'pending',
    summary:      null,     // project-level architecture summary
    stats:        { files: 0, languages: {} },
    indexedAt:    null,
  };
  saveWorkspace(id, workspace);
  console.log(`[PROJECT] Workspace created id=${id}`);
  return workspace;
}

export function getWorkspace(id) {
  return loadWorkspace(id);
}

export function updateWorkspace(id, updates) {
  const ws = loadWorkspace(id);
  if (!ws) return null;
  const updated = { ...ws, ...updates };
  saveWorkspace(id, updated);
  return updated;
}

export function deleteWorkspace(id) {
  const deleted = deleteWorkspaceData(id);
  if (deleted) console.log(`[PROJECT] Workspace deleted id=${id}`);
  return deleted;
}

export function listWorkspaces() {
  return getAllWorkspaceIds()
    .map(id => loadWorkspace(id))
    .filter(Boolean);
}

export { getProjectStats };
