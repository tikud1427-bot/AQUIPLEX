/**
 * AQUA Project Memory
 *
 * Separate persistence for project workspaces.
 * Never shares storage with personal long-term memory (.aqua-memory.json).
 * Store file: .aqua-projects.json
 */
import fs   from 'fs';
import path from 'path';

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

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = {};
      for (const [id, ws] of store.entries()) data[id] = ws;
      fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[PROJECT] Could not save projects to disk:', err.message);
    }
  }, 500);
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
