/**
 * AQUA Checkpoint Engine (Phase 4a — recovery)
 * ─────────────────────────────────────────────────────────────────────────────
 * Workspace-level time-travel: snapshot the full set of file records for a
 * workspace, and restore the entire workspace (index + summaries + dependency
 * and call graphs) back to that snapshot. This is the "recovery" layer for
 * autonomous / multi-step editing — where per-proposal revert (editEngine's
 * revertProposal) is not enough because several edits may have been applied and
 * you want to roll the whole workspace back to a known-good point.
 *
 * How it works — the key property proven by editEngine.applyProposal /
 * revertProposal: a workspace's entire derived state (byPath index, symbol/
 * call/dependency graphs, summaries) is reconstructable from a flat list of
 * file records via buildIndex(). So:
 *   createCheckpoint  = capture the current file records (path + content + meta).
 *   restoreCheckpoint = buildIndex(snapshot) + the same enrich/graph rebuild the
 *                       apply path runs, then refresh persisted metadata.
 *
 * Scope / lifetime: checkpoints live in memory, bounded per workspace, for the
 * process lifetime — exactly like the index they snapshot (which is itself
 * rebuilt on upload and cleared on restart). They are a session safety-net, not
 * durable history; persisting full content copies would bloat disk with no
 * durability benefit the source snapshot doesn't already provide.
 */
import {
  getIndex, buildIndex, syncSummaries, getIndexStats,
} from './projectIndex.js';
import { getWorkspace, updateWorkspace } from './workspaceManager.js';
import { enrichWithSummaries }  from './projectSummarizer.js';
import { buildDependencyGraph } from './dependencyGraph.js';
import { buildCallGraph }       from './callGraph.js';
import { v4 as uuidv4 }         from 'uuid';

const MAX_CHECKPOINTS_PER_WS = 20;   // oldest evicted beyond this

// workspaceId → Map<checkpointId, { id, label, createdAt, files: FileRecord[] }>
const checkpoints = new Map();

function bucket(workspaceId) {
  let m = checkpoints.get(workspaceId);
  if (!m) { m = new Map(); checkpoints.set(workspaceId, m); }
  return m;
}

/** Capture the current file records for a workspace (path + content + meta). */
function snapshotFiles(workspaceId) {
  const index = getIndex(workspaceId);
  if (!index?.byPath) return null;
  const files = [];
  for (const [path, e] of index.byPath.entries()) {
    files.push({ path, content: e.content, lang: e.lang, size: e.size, truncated: e.truncated ?? false, summary: e.summary ?? null });
  }
  return files;
}

/**
 * Create a checkpoint of the workspace's current state.
 * @param {string} workspaceId
 * @param {{ label?: string }} [opts]
 * @returns {{ ok: boolean, checkpoint?: object, error?: string }}
 */
export function createCheckpoint(workspaceId, { label = '' } = {}) {
  if (!getWorkspace(workspaceId)) return { ok: false, error: 'Workspace not found' };
  const files = snapshotFiles(workspaceId);
  if (!files) return { ok: false, error: 'Workspace has no index to checkpoint (upload files first)' };

  const cp = { id: uuidv4(), label: label || `checkpoint ${new Date().toISOString()}`, createdAt: Date.now(), files, fileCount: files.length };
  const m = bucket(workspaceId);
  m.set(cp.id, cp);

  // Evict oldest beyond the cap.
  if (m.size > MAX_CHECKPOINTS_PER_WS) {
    const oldest = [...m.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    m.delete(oldest.id);
  }

  console.log(`[CHECKPOINT] created id=${cp.id} files=${cp.fileCount} workspace=${workspaceId}`);
  return { ok: true, checkpoint: describe(cp) };
}

/**
 * Restore a workspace to a checkpoint — rebuilds index, summaries, and graphs
 * through the same pipeline the apply path uses, then refreshes persisted
 * workspace metadata.
 * @param {string} workspaceId
 * @param {string} checkpointId
 * @returns {{ ok: boolean, restored?: object, indexStats?: object, error?: string }}
 */
export function restoreCheckpoint(workspaceId, checkpointId) {
  const cp = checkpoints.get(workspaceId)?.get(checkpointId);
  if (!cp) return { ok: false, error: 'Checkpoint not found' };
  if (!getWorkspace(workspaceId)) return { ok: false, error: 'Workspace not found' };

  // Same reconstruction sequence as editEngine.applyProposal (proven path).
  buildIndex(workspaceId, cp.files);
  const parsedEntries = [...getIndex(workspaceId).byPath.values()];
  const enriched = enrichWithSummaries(parsedEntries);
  const liveIndex = getIndex(workspaceId);
  for (const f of enriched) {
    const entry = liveIndex.byPath.get(f.path);
    if (entry) entry.summary = f.summary;
  }
  syncSummaries(workspaceId, enriched);
  buildDependencyGraph(workspaceId, enriched);
  buildCallGraph(workspaceId, enriched);

  // Refresh persisted metadata (same policy as apply: metadata only, no raw content).
  const fileMetadata = enriched.map(f => ({ path: f.path, lang: f.lang, size: f.size, summary: f.summary, parsedAt: Date.now() }));
  const languages = {};
  for (const f of enriched) languages[f.lang] = (languages[f.lang] ?? 0) + 1;
  updateWorkspace(workspaceId, { files: fileMetadata, stats: { files: enriched.length, languages }, restoredCheckpointAt: Date.now() });

  console.log(`[CHECKPOINT] restored id=${checkpointId} files=${cp.fileCount} workspace=${workspaceId}`);
  return { ok: true, restored: describe(cp), indexStats: getIndexStats(workspaceId) };
}

/** List checkpoints for a workspace (metadata only, newest first). */
export function listCheckpoints(workspaceId) {
  const m = checkpoints.get(workspaceId);
  if (!m) return [];
  return [...m.values()].sort((a, b) => b.createdAt - a.createdAt).map(describe);
}

export function deleteCheckpoint(workspaceId, checkpointId) {
  const m = checkpoints.get(workspaceId);
  if (!m?.has(checkpointId)) return { ok: false, error: 'Checkpoint not found' };
  m.delete(checkpointId);
  return { ok: true, deleted: checkpointId };
}

export function clearCheckpoints(workspaceId) {
  checkpoints.delete(workspaceId);
}

function describe(cp) {
  return { id: cp.id, label: cp.label, createdAt: cp.createdAt, fileCount: cp.fileCount };
}

/** Test-only: wipe all checkpoints. */
export function __clearAllForTests() { checkpoints.clear(); }
