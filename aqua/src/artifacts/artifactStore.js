/**
 * AQUA Artifact Store (P1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Persistence for generated artifacts — the 7th JSON-backed store, built on
 * the SAME primitives as the other six (core/atomicStore.js: atomicWriteFile
 * + createDebouncedWriter), plus a binary tree on disk because buffers do
 * not belong in a debounced JSON snapshot.
 *
 * Layout:
 *   <ROOT>/                              default ./.aqua-artifacts
 *     .index.json                        lite index (this store's JSON file)
 *     <artifactId>/
 *       manifest.json                    full manifest incl. embedded spec
 *       v1/ v2/ …                        immutable version dirs (checkpoint
 *                                        philosophy — P5 editing appends
 *                                        versions, never mutates one)
 *
 * Plan §6 named the index `.aqua-artifacts.json` at cwd; it lives INSIDE the
 * root as `.index.json` instead so one env override (AQUA_ARTIFACTS_DIR)
 * relocates the whole store — tests point it at a temp dir and the real
 * filesystem is never touched. Same containment reasoning checkpoints use.
 *
 * Ownership: every artifact carries the SAME ownerId chat.js already
 * resolved for the turn (memory/ownerResolver.js — `user:<id>` or
 * `conv:<id>`). Routes assert against it exactly like conversations.js.
 *
 * Quota: MAX_OWNER_BYTES enforced at create — oldest artifacts for that
 * owner are evicted (with a warn) until the new one fits, mirroring the
 * attachment-cap / checkpoint-cap eviction philosophy: a request over quota
 * should never hard-fail, and eviction is always LOGGED, never silent.
 */
import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { atomicWriteFile, createDebouncedWriter } from '../core/atomicStore.js';
import { sanitizeRelativePath, resolveInsideRoot, QUOTAS } from './security.js';

const ROOT       = path.resolve(process.env.AQUA_ARTIFACTS_DIR ?? path.join(process.cwd(), '.aqua-artifacts'));
const INDEX_FILE = path.join(ROOT, '.index.json');

/** artifactId → lite entry (no spec, no file buffers) */
const index = new Map();

// P6 hardening knobs
const MAX_VERSIONS   = 20;       // per artifact: v1 (original) + newest window survive pruning
const MODEL_JSON_CAP = 400_000;  // manifests must stay debounce-writer-sized; larger models aren't editable anyway

/** Per-artifact write serialization — two concurrent edits must produce
 *  v2 AND v3, never a torn race on the same version number. */
const versionLocks = new Map(); // id → tail Promise

function withVersionLock(id, fn) {
  const tail = versionLocks.get(id) ?? Promise.resolve();
  const run  = tail.then(fn, fn);
  const settled = run.catch(() => {});
  versionLocks.set(id, settled);
  settled.then(() => { if (versionLocks.get(id) === settled) versionLocks.delete(id); });
  return run;
}

/** Enforce MODEL_JSON_CAP — oversized models are dropped with a warn (the
 *  artifact still works; only model-editing needs it, and editEngine gives
 *  a clear MODEL_TOO_LARGE error in that case). */
function persistableModel(model, id) {
  if (model == null) return null;
  try {
    if (JSON.stringify(model).length > MODEL_JSON_CAP) {
      console.warn(`[ARTIFACT] model for id=${id} exceeds ${MODEL_JSON_CAP} chars — not persisted (model-edits unavailable for this artifact)`);
      return null;
    }
    return model;
  } catch {
    console.warn(`[ARTIFACT] model for id=${id} is not serializable — not persisted`);
    return null;
  }
}

// ── Persistence (index) ───────────────────────────────────────────────────────

function loadIndexFromDisk() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return;
    const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    for (const [id, entry] of Object.entries(data)) index.set(id, entry);
    console.log(`[ARTIFACT] Loaded ${index.size} artifacts from disk`);
  } catch (err) {
    console.warn('[ARTIFACT] Could not load artifact index:', err.message);
  }
}

const _writer = createDebouncedWriter(INDEX_FILE);
function scheduleSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [id, e] of index.entries()) data[id] = e;
    return JSON.stringify(data, null, 2);
  });
}

loadIndexFromDisk();

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Persist a validated, exported artifact. Files are written to v1, the full
 * manifest (spec embedded — P5 editing needs it) to manifest.json, and a
 * lite entry to the index.
 *
 * @param {{
 *   ownerId: string|null, conversationId: string, workspaceId?: string|null,
 *   requestId: string, format: string, title: string, spec: object,
 *   packaging: 'raw'|'zip',
 *   files: Array<{ path: string, buffer: Buffer, mime: string }>,
 *   summary?: string,
 * }} input
 * @returns {Promise<object>} full manifest
 */
export async function createArtifact(input) {
  const {
    ownerId = null, conversationId, workspaceId = null, requestId,
    format, title, spec, packaging, files, summary = '', model = null,
  } = input;

  const id      = uuidv4();
  const now     = Date.now();
  const version = 1;
  const verDir  = path.join(ROOT, id, `v${version}`);
  await ensureDir(verDir);

  const fileMetas = [];
  let totalBytes  = 0;
  const hashInput = crypto.createHash('sha256');

  try {
    for (const f of files) {
      const rel = sanitizeRelativePath(f.path);
      const abs = resolveInsideRoot(verDir, rel);
      await ensureDir(path.dirname(abs));
      await fs.promises.writeFile(abs, f.buffer, { mode: 0o644 });

      const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
      hashInput.update(`${rel}:${sha256}\n`);
      totalBytes += f.buffer.length;
      fileMetas.push({ path: rel, size: f.buffer.length, mime: f.mime, sha256 });
    }
  } catch (err) {
    // Never leave a half-written artifact on disk.
    await fs.promises.rm(path.join(ROOT, id), { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const manifest = {
    id, ownerId, conversationId, workspaceId, requestId,
    format, title, version,
    versions: [{ v: version, createdAt: now, reason: 'initial', bytes: totalBytes, files: fileMetas }],
    files: fileMetas,
    totalBytes,
    packaging,
    spec,
    // P5 — binary formats persist their content model so "change slide 5"
    // edits the MODEL and re-renders, never reverse-engineers a binary.
    // Text/'files' formats reconstruct the model from the stored files.
    // P6 — oversized/unserializable models are dropped with a warn.
    ...(persistableModel(model, id) != null ? { model: persistableModel(model, id) } : {}),
    summary,
    createdAt: now,
    updatedAt: now,
    hash: hashInput.digest('hex'),
  };

  await atomicWriteFile(path.join(ROOT, id, 'manifest.json'), JSON.stringify(manifest, null, 2));

  index.set(id, liteEntry(manifest));
  scheduleSave();

  await enforceOwnerQuota(ownerId, id);

  console.log(`[ARTIFACT] Created id=${id} format=${format} files=${fileMetas.length} bytes=${totalBytes} owner=${ownerId ?? 'none'}`);
  return manifest;
}

function liteEntry(m) {
  return {
    id: m.id, ownerId: m.ownerId, conversationId: m.conversationId,
    workspaceId: m.workspaceId, format: m.format, title: m.title,
    version: m.version, fileCount: m.files.length, totalBytes: m.totalBytes,
    diskBytes: (m.versions ?? []).reduce((s, v) => s + (v.bytes ?? 0), 0) || m.totalBytes,
    packaging: m.packaging, createdAt: m.createdAt, updatedAt: m.updatedAt,
  };
}

async function enforceOwnerQuota(ownerId, justCreatedId) {
  if (!ownerId) return;
  const mine = [...index.values()]
    .filter(e => e.ownerId === ownerId)
    .sort((a, b) => a.createdAt - b.createdAt); // oldest first
  let total = mine.reduce((s, e) => s + (e.diskBytes ?? e.totalBytes), 0);
  for (const e of mine) {
    if (total <= QUOTAS.MAX_OWNER_BYTES) break;
    if (e.id === justCreatedId) break; // never evict what we just made
    console.warn(`[ARTIFACT] Owner quota exceeded owner=${ownerId} — evicting oldest id=${e.id} (${e.diskBytes ?? e.totalBytes} bytes)`);
    total -= e.diskBytes ?? e.totalBytes;
    await deleteArtifact(e.id);
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/** Lite index entry (sync — for routes' ownership checks). */
export function getArtifactLite(id) {
  return index.get(id) ?? null;
}

/** Full manifest from disk (spec included). */
export async function getArtifact(id) {
  if (!index.has(id)) return null;
  try {
    const raw = await fs.promises.readFile(path.join(ROOT, id, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[ARTIFACT] manifest read failed id=${id}: ${err.message}`);
    return null;
  }
}

/** @returns lite entries, newest first */
export function listArtifacts({ ownerId = null, conversationId = null, workspaceId = null } = {}) {
  return [...index.values()]
    .filter(e =>
      (ownerId        == null || e.ownerId        === ownerId) &&
      (conversationId == null || e.conversationId === conversationId) &&
      (workspaceId    == null || e.workspaceId    === workspaceId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Absolute on-disk path for one file of one version — the ONLY way routes
 * may turn a manifest entry into a filesystem path. Guards: version exists,
 * file is listed in the manifest, resolution stays inside the version dir.
 */
export function getFileAbsolutePath(manifest, relPath, version = manifest.version) {
  const rel = sanitizeRelativePath(relPath);
  if (!manifest.versions.some(v => v.v === version)) {
    throw new Error(`Unknown version v${version} for artifact ${manifest.id}`);
  }
  const listed = manifest.files.some(f => f.path === rel);
  if (!listed) {
    throw new Error(`File "${rel}" is not part of artifact ${manifest.id}`);
  }
  const verDir = path.join(ROOT, manifest.id, `v${version}`);
  return resolveInsideRoot(verDir, rel);
}

// ── Mutate ────────────────────────────────────────────────────────────────────

/**
 * P5 — append an immutable new version (the checkpoint philosophy: v1..vN
 * all remain fully downloadable). Writes the COMPLETE file set to
 * v{N+1}/ — untouched files arrive as copies from the caller, so every
 * version dir stands alone with no cross-version references.
 *
 * The edit pipeline keeps the file SET stable across versions in P5
 * (content changes only); structural edits (add/remove files) are the
 * tracked P6 extension.
 *
 * @param {string} id
 * @param {{
 *   files: Array<{ path: string, buffer: Buffer, mime: string }>,
 *   reason: string,
 *   model?: object|null,   updated content model (binary formats)
 * }} input
 * @returns {Promise<object|null>} updated full manifest
 */
export async function appendVersion(id, { files, reason, model = null }) {
  return withVersionLock(id, () => appendVersionUnlocked(id, { files, reason, model }));
}

async function appendVersionUnlocked(id, { files, reason, model = null }) {
  if (!index.has(id)) return null;
  const manifest = await getArtifact(id);
  if (!manifest) return null;

  const now  = Date.now();
  const newV = manifest.version + 1;
  const verDir = path.join(ROOT, id, `v${newV}`);
  await ensureDir(verDir);

  const fileMetas = [];
  let totalBytes  = 0;
  const hashInput = crypto.createHash('sha256');

  try {
    for (const f of files) {
      const rel = sanitizeRelativePath(f.path);
      const abs = resolveInsideRoot(verDir, rel);
      await ensureDir(path.dirname(abs));
      await fs.promises.writeFile(abs, f.buffer, { mode: 0o644 });
      const sha256 = crypto.createHash('sha256').update(f.buffer).digest('hex');
      hashInput.update(`${rel}:${sha256}\n`);
      totalBytes += f.buffer.length;
      fileMetas.push({ path: rel, size: f.buffer.length, mime: f.mime, sha256 });
    }
  } catch (err) {
    await fs.promises.rm(verDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // Lazy retrofit: pre-P5 manifests carry no per-version file metas — pin
  // the current metas onto the entry for the version they describe.
  const currentEntry = manifest.versions.find(v => v.v === manifest.version);
  if (currentEntry && !currentEntry.files) currentEntry.files = manifest.files;

  manifest.versions.push({ v: newV, createdAt: now, reason: String(reason ?? '').slice(0, 200), bytes: totalBytes, files: fileMetas });
  manifest.version    = newV;
  manifest.files      = fileMetas;
  manifest.totalBytes = totalBytes;
  manifest.updatedAt  = now;
  manifest.hash       = hashInput.digest('hex');
  if (model != null) {
    const ok = persistableModel(model, id);
    if (ok != null) manifest.model = ok;
  }

  // P6 — version-cap pruning: v1 (the original) + the newest window survive;
  // middle versions beyond MAX_VERSIONS are deleted from disk and the
  // manifest. Pruned versions 404 on ?version=N via the versions[] check.
  if (manifest.versions.length > MAX_VERSIONS) {
    const keepCount = MAX_VERSIONS - 1; // newest window (v1 held separately)
    const [first, ...rest] = manifest.versions;
    const pruned = rest.slice(0, rest.length - keepCount);
    manifest.versions = [first, ...rest.slice(rest.length - keepCount)];
    for (const p of pruned) {
      await fs.promises.rm(path.join(ROOT, id, `v${p.v}`), { recursive: true, force: true }).catch(() => {});
      console.warn(`[ARTIFACT] Pruned v${p.v} of id=${id} (version cap ${MAX_VERSIONS})`);
    }
  }

  await atomicWriteFile(path.join(ROOT, id, 'manifest.json'), JSON.stringify(manifest, null, 2));
  index.set(id, liteEntry(manifest));
  scheduleSave();
  await enforceOwnerQuota(manifest.ownerId, id);

  console.log(`[ARTIFACT] Appended v${newV} id=${id} files=${fileMetas.length} bytes=${totalBytes} reason="${manifest.versions.at(-1).reason}"`);
  return manifest;
}

/**
 * File metas for one version — routes serve OLD versions with the sizes and
 * mimes that version actually had. Pre-P5 version entries without metas
 * fall back to the latest set (paths are stable across versions).
 */
export function getVersionFileMetas(manifest, version = manifest.version) {
  if (version === manifest.version) return manifest.files;
  const entry = manifest.versions.find(v => v.v === version);
  return entry?.files ?? manifest.files;
}

export async function renameArtifact(id, title) {
  const lite = index.get(id);
  if (!lite) return null;
  const manifest = await getArtifact(id);
  if (!manifest) return null;

  manifest.title     = String(title).slice(0, 200);
  manifest.updatedAt = Date.now();
  await atomicWriteFile(path.join(ROOT, id, 'manifest.json'), JSON.stringify(manifest, null, 2));

  index.set(id, liteEntry(manifest));
  scheduleSave();
  return manifest;
}

export async function deleteArtifact(id) {
  if (!index.has(id)) return false;
  index.delete(id);
  scheduleSave();
  await fs.promises.rm(path.join(ROOT, id), { recursive: true, force: true }).catch((err) => {
    console.warn(`[ARTIFACT] delete: dir removal failed id=${id}: ${err.message}`);
  });
  console.log(`[ARTIFACT] Deleted id=${id}`);
  return true;
}

// ── Stats / tests ─────────────────────────────────────────────────────────────

export function getArtifactStats() {
  let bytes = 0;
  for (const e of index.values()) bytes += e.totalBytes;
  return { artifacts: index.size, totalBytes: bytes, root: ROOT };
}

/** Test hooks — same convention every other store exposes. */
export function _resetForTests() {
  index.clear();
  _writer.cancel();
}
export function _flushIndexForTests() {
  _writer.flush();
}
