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
import fs   from 'fs';
import path from 'path';
import { createDebouncedWriter } from '../core/atomicStore.js';

const PROJECTS_FILE = path.join(process.cwd(), '.aqua-projects.json');

// workspaceId → workspace object (metadata + serialisable index data)
const store = new Map();

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk() {
  try {
    if (!fs.existsSync(PROJECTS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    let count = 0;
    for (const [id, ws] of Object.entries(data)) {
      store.set(id, ws);
      count++;
    }
    console.log(`[PROJECT] Loaded ${count} workspaces from disk`);
  } catch (err) {
    console.warn('[PROJECT] Could not load projects from disk:', err.message);
  }
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
