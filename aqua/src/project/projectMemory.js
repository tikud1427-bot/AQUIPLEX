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
import { bindKeyedStore } from '../core/storage/keyedBinding.js';
import { registerOwnerResolver } from '../core/storage/ownerBinding.js';

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
function scheduleSave(id = null) {
  if (id) binding.markDirty(id);
  if (!binding.writesWholeJson()) return;
  _writer.schedule(() => {
    const data = {};
    for (const [id, ws] of store.entries()) data[id] = ws;
    return JSON.stringify(data, null, 2);
  });
}

// ── Per-owner persistence (scalability Phase 2c) ─────────────────────────────
// WRITER: the server only (project routes, unified upload). One row per
// WORKSPACE, owned by workspace.ownerId — a user's request loads their
// workspaces. A workspace with no ownerId (legacy) cannot be placed under a
// user: it stays on 'ws:<id>' and is reported by the migration (backfill first).
// MERGE: three-way per top-level field (files, structure, summary, …: each is
// rewritten whole by an ingest; a double change keeps ours, counted).
// DELETION: deleteWorkspaceData → row tombstone.
export const workspaceOwner = (id, ws = store.get(id)) => (ws?.ownerId ? String(ws.ownerId) : `ws:${id}`);
const binding = bindKeyedStore({
  storeKey: '.aqua-projects.json', file: PROJECTS_FILE, label: 'projects', section: 'ws', envelope: false,
  mergeSchema: {},
  ownerOf: (id, ws) => workspaceOwner(id, ws),
  encode: id => (store.has(id) ? store.get(id) : undefined),
  decode: ws => ws,
  install: (id, ws) => { if (ws) store.set(id, ws); else store.delete(id); },
  evict: id => store.delete(id),
  changedAt: ws => Number(ws?.indexedAt ?? ws?.createdAt) || 0,
  reloadJson: () => loadFromDisk(),
});
export function projectsPartitionBinding() { return binding; }
// "ws:<id>" keys elsewhere (vector namespaces, the project index) belong to the workspace's owner.
registerOwnerResolver('ws:', id => (store.has(id) ? workspaceOwner(id) : null));

if (binding.loadsJsonAtBoot()) loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

export function saveWorkspace(id, workspace) {
  store.set(id, workspace);
  scheduleSave(id);
}

export function loadWorkspace(id) {
  return store.get(id) ?? null;
}

export function deleteWorkspaceData(id) {
  binding.markDeleted(id);
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
