/**
 * AQUA — artifact storage audit and object-store migration plan (scalability Phase 4A)
 *
 * Reads an artifact ROOT (a copy of AQUA_ARTIFACTS_DIR / <data dir>/.aqua-artifacts)
 * and reports what an operator must know before artifacts move to a shared
 * object store (Google Cloud Storage, not activated):
 *
 *   inventory     artifacts, versions, files, bytes, owners, formats
 *   integrity     index entries without a manifest or directory; manifests
 *                 whose listed files are missing or whose bytes no longer
 *                 match the recorded sha256/size; directories no index
 *                 entry knows (orphans); stray temp files
 *   references    artifacts whose conversation no longer exists (--history),
 *                 owned by a deleted account (--deleted), or not owned by a user
 *   plan          one object per (artifact, version, file) with its object key
 *                 (the SAME key scheme as core/storage/objectStore.js:
 *                 artifacts/<id>/<versionDir>/<path>), size, sha256 and owner —
 *                 what an upload would write and what a verification would check
 *
 * Read-only: it never writes to the root. Reports carry ids and hashes of
 * owners, never file content.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const hashId = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/** The index file (store envelope or bare map) → Map(id → lite entry). */
function readIndex(root) {
  const doc = readJson(path.join(root, '.index.json'));
  if (!doc) return new Map();
  const data = doc.__aqua && 'data' in doc ? doc.data : doc;
  return new Map(Object.entries(data ?? {}));
}

const versionDirOf = (manifest, v) => manifest.versions?.find(x => x.v === v)?.dir ?? `v${v}`;

/**
 * @param {string} root
 * @param {{ conversationIds?: Set<string>, deletedOwners?: Set<string>, verifyBytes?: boolean }} opts
 */
export function auditArtifactRoot(root, { conversationIds = null, deletedOwners = null, verifyBytes = true } = {}) {
  const index = readIndex(root);
  const r = {
    root: path.basename(root),
    artifacts: { indexed: index.size, withManifest: 0, versions: 0, files: 0, bytes: 0, maxArtifactBytes: 0 },
    owners: { users: 0, anonymous: 0, none: 0 },
    formats: {}, packaging: {},
    versionLayout: { classic: 0, uniqueDir: 0 },
    integrity: { indexWithoutManifest: [], manifestUnreadable: [], missingFiles: 0, sizeMismatch: 0, hashMismatch: 0,
      orphanDirectories: [], strayTempFiles: 0, missingVersionDirs: 0, sample: [] },
    references: { conversationGone: 0, ownerDeleted: 0, noOwner: 0, sample: [] },
    plan: [],
  };
  const owners = new Set();
  for (const [id, lite] of index) {
    const manifest = readJson(path.join(root, id, 'manifest.json'));
    if (!manifest) {
      (fs.existsSync(path.join(root, id)) ? r.integrity.manifestUnreadable : r.integrity.indexWithoutManifest).push(id);
      continue;
    }
    r.artifacts.withManifest++;
    const ownerId = manifest.ownerId ?? lite.ownerId ?? null;
    if (!ownerId) { r.owners.none++; r.references.noOwner++; }
    else owners.add(ownerId);
    r.formats[manifest.format ?? 'unknown'] = (r.formats[manifest.format ?? 'unknown'] ?? 0) + 1;
    r.packaging[manifest.packaging ?? 'raw'] = (r.packaging[manifest.packaging ?? 'raw'] ?? 0) + 1;
    if (conversationIds && manifest.conversationId && !conversationIds.has(manifest.conversationId)) {
      r.references.conversationGone++;
      if (r.references.sample.length < 20) r.references.sample.push({ artifact: id, problem: 'conversation-gone' });
    }
    if (deletedOwners?.has(ownerId)) r.references.ownerDeleted++;
    let artifactBytes = 0;
    for (const ver of manifest.versions ?? []) {
      r.artifacts.versions++;
      const dir = versionDirOf(manifest, ver.v);
      if (ver.dir) r.versionLayout.uniqueDir++; else r.versionLayout.classic++;
      const vdir = path.join(root, id, dir);
      if (!fs.existsSync(vdir)) { r.integrity.missingVersionDirs++; if (r.integrity.sample.length < 20) r.integrity.sample.push({ artifact: id, version: ver.v, problem: 'version-dir-missing' }); continue; }
      // Exactly artifactStore.getVersionFileMetas: the current version lists
      // manifest.files; an older one its own `files`, else manifest.files.
      const files = (ver.v === manifest.version ? manifest.files : (ver.files ?? manifest.files)) ?? [];
      for (const f of files) {
        r.artifacts.files++;
        const abs = path.join(vdir, f.path);
        if (!abs.startsWith(vdir) || !fs.existsSync(abs)) {
          r.integrity.missingFiles++;
          if (r.integrity.sample.length < 20) r.integrity.sample.push({ artifact: id, version: ver.v, problem: 'file-missing' });
          continue;
        }
        const st = fs.statSync(abs);
        let digest = f.sha256 ?? null;
        if (f.size != null && st.size !== f.size) { r.integrity.sizeMismatch++; if (r.integrity.sample.length < 20) r.integrity.sample.push({ artifact: id, version: ver.v, problem: 'size-mismatch' }); }
        if (verifyBytes) {
          digest = sha(fs.readFileSync(abs));
          if (f.sha256 && digest !== f.sha256) { r.integrity.hashMismatch++; if (r.integrity.sample.length < 20) r.integrity.sample.push({ artifact: id, version: ver.v, problem: 'hash-mismatch' }); }
        }
        r.artifacts.bytes += st.size; artifactBytes += st.size;
        r.plan.push({ key: `artifacts/${id}/${dir}/${f.path}`, size: st.size, sha256: digest, owner: ownerId ? hashId(ownerId) : null,
          contentType: f.mime ?? 'application/octet-stream' });
      }
    }
    r.artifacts.maxArtifactBytes = Math.max(r.artifacts.maxArtifactBytes, artifactBytes);
  }
  // Directories (and temp files) the index does not know.
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const p = path.join(root, name);
    if (name.startsWith('.')) { if (/\.tmp/.test(name)) r.integrity.strayTempFiles++; continue; }
    if (fs.statSync(p).isDirectory() && !index.has(name)) r.integrity.orphanDirectories.push(name);
  }
  const walkTmp = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walkTmp(p); else if (/\.tmp\.\d+\./.test(n)) r.integrity.strayTempFiles++; } };
  for (const id of index.keys()) if (fs.existsSync(path.join(root, id))) walkTmp(path.join(root, id));
  r.owners.users = [...owners].filter(o => o.startsWith('user:')).length;
  r.owners.anonymous = [...owners].filter(o => !o.startsWith('user:')).length;
  r.clean = !r.integrity.indexWithoutManifest.length && !r.integrity.manifestUnreadable.length && !r.integrity.missingFiles
    && !r.integrity.sizeMismatch && !r.integrity.hashMismatch && !r.integrity.missingVersionDirs;
  return r;
}

/**
 * After an upload: every planned object is present in the target with the
 * planned size and sha256. `target` is any object store with get(key) →
 * Buffer|null (core/storage/objectStore.js contract).
 */
export async function verifyObjectPlan(plan, target, { ownerOf = null } = {}) {
  const r = { objects: plan.length, present: 0, missing: 0, mismatched: 0, sample: [] };
  for (const o of plan) {
    const buf = await target.get(o.key, ownerOf ? { ownerId: ownerOf(o) } : {});
    if (!buf) { r.missing++; if (r.sample.length < 20) r.sample.push({ key: o.key, problem: 'missing' }); continue; }
    if (buf.length !== o.size || sha(buf) !== o.sha256) { r.mismatched++; if (r.sample.length < 20) r.sample.push({ key: o.key, problem: 'mismatch' }); continue; }
    r.present++;
  }
  r.clean = r.missing === 0 && r.mismatched === 0;
  return r;
}
