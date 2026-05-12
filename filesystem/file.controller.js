"use strict";

/**
 * aqua.file_control.js — AQUA Control Layer: File Control System
 *
 * Manages project file state (in-memory + disk).
 * Core contract:
 *   updateFile(projectId, name, content) → upsert (create or update)
 *   getProjectState(projectId)           → current projectState
 *   snapshotProject(projectId)           → deep copy for rollback
 *   restoreSnapshot(projectId, snap)     → atomic rollback
 *
 * NEVER touches files outside the target project directory.
 * NEVER generates content — only stores what the engine gives it.
 */

const fs   = require("fs").promises;
const path = require("path");

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PROJECTS_ROOT = process.env.PROJECTS_DIR
  || path.join(process.cwd(), "projects");

// In-process project state cache: projectId → { files: { name: content } }
const _stateCache = new Map();

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function _sanitizeProjectId(projectId) {
  const id = String(projectId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) throw new Error("Invalid projectId");
  return id;
}

function _sanitizeName(name) {
  // Prevent path traversal — allow subdirs like routes/api.js
  const normalized = path.normalize(name).replace(/^(\.\.[/\\])+/, "");
  if (!normalized || normalized.startsWith("/")) {
    throw new Error(`Invalid file name: "${name}"`);
  }
  return normalized;
}

function _projectDir(projectId) {
  return path.join(PROJECTS_ROOT, _sanitizeProjectId(projectId));
}

// ─── STATE MANAGEMENT ────────────────────────────────────────────────────────

/**
 * getProjectState(projectId)
 * Returns current in-memory state, loading from disk if cache is cold.
 * @returns {Promise<{ files: Object<string,string> }>}
 */
async function getProjectState(projectId) {
  const id = _sanitizeProjectId(projectId);

  if (_stateCache.has(id)) return _stateCache.get(id);

  // Cold start: load from disk
  const dir = _projectDir(id);
  const state = { files: {} };

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && !entry.name.startsWith("_")) {
        try {
          const content = await fs.readFile(path.join(dir, entry.name), "utf8");
          state.files[entry.name] = content;
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* project dir doesn't exist yet — fresh project */ }

  _stateCache.set(id, state);
  return state;
}

// ─── CORE API ────────────────────────────────────────────────────────────────

/**
 * updateFile(projectId, name, content)
 *
 * Upserts a single file:
 *   - Updates in-memory state immediately
 *   - Writes to disk atomically (write to .tmp → rename)
 *   - Creates subdirectories as needed
 *   - NEVER touches files not explicitly named
 *
 * @returns {Promise<{ name: string, action: "created"|"updated" }>}
 */
async function updateFile(projectId, name, content) {
  const id        = _sanitizeProjectId(projectId);
  const safeName  = _sanitizeName(name);
  const state     = await getProjectState(id);
  const action    = state.files[safeName] !== undefined ? "updated" : "created";

  // Update in-memory state first
  state.files[safeName] = content;

  // Persist to disk
  const dir     = _projectDir(id);
  const filePath = path.join(dir, safeName);
  const tmpPath  = filePath + ".aqua_tmp";

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath); // Atomic on POSIX

  return { name: safeName, action };
}

/**
 * readFile(projectId, name)
 * @returns {Promise<string>} file content
 * @throws if file not found in state or on disk
 */
async function readFile(projectId, name) {
  const id       = _sanitizeProjectId(projectId);
  const safeName = _sanitizeName(name);
  const state    = await getProjectState(id);

  if (state.files[safeName] !== undefined) return state.files[safeName];

  // Fallback: read directly from disk
  const filePath = path.join(_projectDir(id), safeName);
  const content  = await fs.readFile(filePath, "utf8");
  state.files[safeName] = content; // Warm cache
  return content;
}

/**
 * snapshotProject(projectId)
 * Returns a deep-copied snapshot of current file state for rollback.
 * @returns {Promise<Object<string,string>>}
 */
async function snapshotProject(projectId) {
  const state = await getProjectState(_sanitizeProjectId(projectId));
  return { ...state.files }; // Shallow copy is fine — strings are immutable
}

/**
 * restoreSnapshot(projectId, snapshot)
 * Atomically restores all files to snapshot state.
 * Files not in snapshot that were created during the failed operation
 * are left in place (cannot safely delete without knowing intent).
 *
 * @param {string} projectId
 * @param {Object<string,string>} snapshot - result of snapshotProject()
 * @returns {Promise<{ restored: string[], failed: string[] }>}
 */
async function restoreSnapshot(projectId, snapshot) {
  const id = _sanitizeProjectId(projectId);
  const restored = [];
  const failed   = [];

  for (const [name, content] of Object.entries(snapshot)) {
    try {
      await updateFile(id, name, content);
      restored.push(name);
    } catch (e) {
      console.error(`[FileControl] Rollback failed for ${name}: ${e.message}`);
      failed.push(name);
    }
  }

  // Update in-memory state to match snapshot exactly
  const state = await getProjectState(id);
  state.files = { ...snapshot };

  return { restored, failed };
}

/**
 * writeProjectFiles(projectId, files)
 *
 * Bulk write for initial project generation.
 * Replaces entire project state with the new file set.
 * Each file is written atomically via updateFile().
 *
 * @param {string} projectId
 * @param {Array<{name: string, content: string}>} files
 * @returns {Promise<{ written: string[], errors: string[] }>}
 */
async function writeProjectFiles(projectId, files) {
  const id      = _sanitizeProjectId(projectId);
  const written = [];
  const errors  = [];

  // Clear cache to treat this as a full replace
  _stateCache.delete(id);

  for (const { name, content } of files) {
    try {
      await updateFile(id, name, content);
      written.push(name);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  return { written, errors };
}

/**
 * invalidateCache(projectId)
 * Forces next getProjectState() to reload from disk.
 */
function invalidateCache(projectId) {
  _stateCache.delete(_sanitizeProjectId(projectId));
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  updateFile,
  readFile,
  getProjectState,
  snapshotProject,
  restoreSnapshot,
  writeProjectFiles,
  invalidateCache,
};
