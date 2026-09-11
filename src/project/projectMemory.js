/**
 * AQUA Project Memory
 *
 * Separate persistence for project workspaces.
 * Workspace INDEX data (file trees, summaries, dependency graphs) — bulky,
 * rebuildable. The OWNER-facing memory of a workspace (that it exists, its
 * summary, the works_on edge) lives in the unified Mind store via
 * memory/engine.js rememberWorkspace(). This file is a cache tier, not a
 * second user-memory store.
 * Store file: .aqua-projects.json
 */
import { createDebouncedWriter, loadJsonFile } from '../core/atomicStore.js';
import { migrateLegacyFile } from '../core/dataDir.js';

// P0 — canonical data dir (survives redeploys) + one-time legacy migration.
const PROJECTS_FILE = migrateLegacyFile('.aqua-projects.json');

// workspaceId → workspace object (metadata + serialisable index data)
const store = new Map();

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk() {
  // Corrupt-safe: bad parse preserves the file aside + tries .bak, never wipes.
  const data = loadJsonFile(PROJECTS_FILE, { label: 'projects' });
  if (!data || typeof data !== 'object') return;
  let count = 0;
  for (const [id, ws] of Object.entries(data)) {
    store.set(id, ws);
    count++;
  }
  console.log(`[PROJECT] Loaded ${count} workspaces from ${PROJECTS_FILE}`);
}

// Phase 3b — atomic + async persistence via the shared primitive.
const _writer = createDebouncedWriter(PROJECTS_FILE);
function scheduleSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [id, ws] of store.entries()) data[id] = ws;
    return JSON.stringify(data, null, 2);
  });
}

loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

export function saveWorkspace(id, workspace) {
  store.set(id, workspace);
  scheduleSave();
}

export function loadWorkspace(id) {
  return store.get(id) ?? null;
}

export function deleteWorkspaceData(id) {
  const deleted = store.delete(id);
  if (deleted) scheduleSave();
  return deleted;
}

export function getAllWorkspaceIds() {
  return [...store.keys()];
}

export function getProjectStats() {
  let totalFiles = 0;
  for (const ws of store.values()) totalFiles += ws.files?.length ?? 0;
  return { workspaces: store.size, totalFiles };
}
